import { defineTool } from '@deepseek-ai/dsh-tools'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { isPrivateOwnerTurn } from './context.js'
import { jaccardSimilarity } from './memory.js'

/** Name she sees in the tool list. */
export const RECALL_TOOL_NAME = 'recall'

/** How much of a lookup we hand back: enough to answer, not enough to flood. */
export const RECALL_MAX_CHARS = 1200
export const RECALL_MAX_HITS = 8
/** One file larger than this is skipped — a runaway diary is not a lookup target. */
export const RECALL_MAX_FILE_BYTES = 256 * 1024
/**
 * Two hits this similar are the same sentence found twice (a memory line and the
 * diary line it came from, say); only the higher-scoring one is worth showing.
 */
export const RECALL_SIMILAR_HIT = 0.8

const CJK = /[\u4e00-\u9fff]/
const WORD = /[a-z0-9]{2,}/g

/**
 * Split a query into things worth matching.
 *
 * Chinese has no spaces, so a whole sentence never matches anything; single
 * characters match everything. Bigrams are the compromise that actually works
 * for a few hundred lines of prose: 「生日」 hits 「我的生日是三月十四」,
 * 「下」 does not hit half the file.
 */
export function recallTokens(query) {
	const text = String(query ?? '').toLowerCase()
	const tokens = new Set()
	for (const word of text.match(WORD) ?? []) tokens.add(word)
	const cjk = [...text].filter((char) => CJK.test(char))
	for (let index = 0; index + 1 < cjk.length; index += 1) tokens.add(cjk[index] + cjk[index + 1])
	if (tokens.size === 0 && cjk.length === 1) tokens.add(cjk[0])
	return [...tokens]
}

/** Every line worth searching, tagged with where it came from. */
function collect(dir) {
	const lines = []
	const push = (label, file) => {
		let stat
		try {
			stat = statSync(file)
		} catch {
			return
		}
		if (!stat.isFile() || stat.size > RECALL_MAX_FILE_BYTES) return
		let text
		try {
			text = readFileSync(file, 'utf8')
		} catch {
			return
		}
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.trim()
			if (line === '' || line.startsWith('#') || line.startsWith('>')) continue
			lines.push({ source: label, text: line })
		}
	}

	push('记忆', join(dir, 'MEMORY.md'))
	push('档案', join(dir, 'memory', 'archive.md'))
	push('规矩', join(dir, 'CORRECTIONS.md'))
	for (const [folder, prefix] of [
		['diary', '日记'],
		['knowledge', '笔记'],
	]) {
		const target = join(dir, folder)
		if (!existsSync(target)) continue
		let names
		try {
			names = readdirSync(target)
		} catch {
			continue
		}
		for (const name of names) {
			if (!name.endsWith('.md')) continue
			push(`${prefix}/${name.replace(/\.md$/, '')}`, join(target, name))
		}
	}
	return lines
}

const TOOL_DESCRIPTION = [
	'在你自己的记忆、日记、笔记、规矩里查找具体内容。',
	'只要你觉得「这件事我应该记着」但当前上下文里没有，就先查一遍再回答；',
	'查完确实没有，才可以说没印象。不要在没查之前就说自己不记得。',
	'只在主人的私聊里可用。',
].join('\n')

/**
 * Look things up in her own notes.
 *
 * The gap this closes is specific: memory is injected only after decay and
 * budget filtering, so an item can be perfectly well kept and still absent
 * from the prompt — and then she answers 「没印象」 about something she has
 * written down. Reading the file is cheap; pretending to have forgotten is not.
 */
export function createRecallTool({ dir, log = () => {} } = {}) {
	let warned = false
	const warnOnce = (message) => {
		if (warned) return
		warned = true
		log('warn', `qq-node: recall: ${message}`)
	}

	return defineTool({
		name: RECALL_TOOL_NAME,
		description: TOOL_DESCRIPTION,
		parameters: {
			query: { type: 'string', required: true, description: '要查的关键词，比如「生日」「她喜欢的颜色」' },
		},
		output: {
			schema: { type: 'string', description: '命中的几行原文，每行前面标着它出自哪儿；查不到就说没有' },
			render(_args, value) {
				return [{ type: 'text', text: value }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			// 本子里全是他的私事：群里、外人面前一律不翻。
			if (!isPrivateOwnerTurn()) {
				return '这些是主人的私事，我只在和他单独说话时才会翻自己的本子。'
			}
			const tokens = recallTokens(args?.query)
			if (tokens.length === 0) return '给我一个关键词我才好找。'

			let lines
			try {
				lines = collect(dir)
			} catch (error) {
				warnOnce(`reading ${dir} failed: ${error?.message ?? String(error)}`)
				return '本子这会儿翻不开，等我一下再问。'
			}

			const scored = []
			const lowered = lines.map((line) => line.text.toLowerCase())
			// 稀有词更值钱：一个词在几十行里都出现（「的」「今天」这类），命中它说明不了什么；
			// 只在两三行里出现过的词，命中它才是那条被想起来的话。权重取 idf，来自论文 §2.5 的词法通道。
			const docFreq = new Map()
			for (const token of tokens) {
				let count = 0
				for (const text of lowered) if (text.includes(token)) count += 1
				docFreq.set(token, count)
			}
			const total = Math.max(1, lines.length)
			const weightOf = (token) => Math.log(1 + total / (1 + (docFreq.get(token) ?? 0)))
			const query = String(args?.query ?? '').toLowerCase().trim()
			for (const [index, line] of lowered.entries()) {
				let score = 0
				for (const token of tokens) if (line.includes(token)) score += weightOf(token)
				if (score <= 0) continue
				// 整句原样出现：这一行几乎肯定就是她要找的那条。
				if ([...query].length >= 2 && line.includes(query)) score += 2
				scored.push({ ...lines[index], score })
			}
			if (scored.length === 0) return '本子里没有相关的记录。'

			scored.sort((left, right) => right.score - left.score)
			const out = []
			const picked = []
			let used = 0
			for (const hit of scored) {
				if (out.length >= RECALL_MAX_HITS) break
				// 同一条话在多份文件里各出现一次时只给她一遍，别拿八行同样的字占满她的注意力。
				if (picked.some((other) => jaccardSimilarity(other, hit.text) >= RECALL_SIMILAR_HIT)) continue
				const entry = `[${hit.source}] ${hit.text}`
				if (used + entry.length > RECALL_MAX_CHARS) break
				out.push(entry)
				picked.push(hit.text)
				used += entry.length
			}
			if (out.length === 0) return '本子里没有相关的记录。'
			return out.join('\n')
		},
	})
}
