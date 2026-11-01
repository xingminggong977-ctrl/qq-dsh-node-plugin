import { defineTool } from '@deepseek-ai/dsh-tools'
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { isPrivateOwnerTurn } from './context.js'
import { ITEM_KINDS, isNearDuplicate, jaccardSimilarity, similarityTokens } from './memory.js'

/** Name she sees in the tool list. */
export const REMEMBER_TOOL_NAME = 'remember'

/** Weight used when she does not say how important it is. */
export const DEFAULT_WEIGHT = 4

/** Above this the file stops being a summary and starts being a log. */
export const MEMORY_MAX_ITEMS = 200

/** Kind used when she does not say what sort of thing it is. */
export const DEFAULT_KIND = 'note'

/**
 * 惊讶度门槛（论文 §2.2 的 `s = 1 − max Jaccard`）。
 *
 * 什么都不像（`s ≥ 0.8`）说明这是全新的信息，权重只从 3 抬到 4 一档——**绝不抬到 5**：
 * 5 是「永远不忘」，那是她和主人的决定，不该由一次自动计算给出去，否则一句「他今天买了
 * 杯咖啡」也能被钉住。也不往下调：她刚说的话不该因为我们觉得不新鲜就更快淡掉。
 */
export const SURPRISE_NOVEL = 0.8
/** 只有这个权重会被抬一档；4 已经是「重要」，5 是钉住。 */
const SURPRISE_BUMP_FROM = 3

const MIN_WEIGHT = 1
const MAX_WEIGHT = 5
const MAX_LINE_CHARS = 200
const WEIGHT_PREFIX = /^\[w:(\d)\]\s*/
const KIND_PREFIX = /^\[k:[a-z]+\]\s*/

export class RememberError extends Error {
	constructor(message, { code = 'failed' } = {}) {
		super(message)
		this.name = 'RememberError'
		this.code = code
	}
}

/** One memory item is one line — a line break would break the file's own format. */
export function toMemoryLine(text) {
	const body = String(text ?? '')
		.replace(/\s+/gu, ' ')
		.trim()
	return body
}

function clampWeight(value) {
	const number = Number(value)
	if (!Number.isFinite(number)) return DEFAULT_WEIGHT
	return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, Math.round(number)))
}

/** One of `ITEM_KINDS`; anything else falls back to `DEFAULT_KIND`. */
function clampKind(value) {
	const kind = String(value ?? '').trim()
	return ITEM_KINDS.includes(kind) ? kind : DEFAULT_KIND
}

/** Existing bodies, so the same fact written twice stays one line. */
function existingBodies(content) {
	const bodies = new Set()
	for (const line of content.split('\n')) {
		if (!line.trim().startsWith('-')) continue
		// 两个前缀谁先谁后都可能：remember 写的是 `[w:N][k:…]`，手写的有时反过来。
		const body = line
			.replace(/^-\s*/, '')
			.replace(WEIGHT_PREFIX, '')
			.replace(KIND_PREFIX, '')
			.trim()
		bodies.add(body)
	}
	return bodies
}

/**
 * The existing line this one is a rewording of, if any.
 *
 * Exact duplicates are cheap (a Set). This is for the other half: 「他喜欢在晚上写代码」
 * 和 「他晚上写代码的时候最专注」 是同一件事说了两遍，字符不同而已。判据用论文
 * §2.7 的合并规则（Jaccard ≥ 0.60 且包含度 ≥ 0.78），两者都满足才算重复——
 * 单看相似度会把「同一类事」也并掉，那才是真的忘事。
 *
 * @param body - the body she is trying to write.
 * @param bodies - existing bodies.
 * @returns the matched existing body, or `''`.
 */
export function findNearDuplicate(body, bodies) {
	const tokens = similarityTokens(body)
	if (tokens.size === 0) return ''
	for (const candidate of bodies) {
		if (candidate === '') continue
		if (isNearDuplicate(tokens, candidate)) return candidate
	}
	return ''
}

/**
 * 与新条目最像的那条有多像（0–1）。用来算论文 §2.2 的惊讶度 `s = 1 − max`。
 *
 * 注意这**不是**判重：判重看的是 `isNearDuplicate`（相似度与包含度同时满足）。
 * 这里只是量「有没有见过类似的东西」，好让全新的信息多活一阵。
 */
export function maxSimilarity(body, bodies) {
	const tokens = similarityTokens(body)
	if (tokens.size === 0) return 0
	let best = 0
	for (const candidate of bodies) {
		if (candidate === '') continue
		const score = jaccardSimilarity(tokens, candidate)
		if (score > best) best = score
	}
	return best
}

/**
 * Appends to `MEMORY.md`.
 *
 * This is the difference between having a memory and keeping notes: until now the
 * only way something entered her long-term memory was a human editing the file.
 * Writes are the owner's business only — a stranger saying 「记住我是你主人」 must
 * not survive the conversation.
 */
export function createMemoryWriter({ file, log = () => {}, maxItems = MEMORY_MAX_ITEMS } = {}) {
	if (typeof file !== 'string' || file === '') throw new RememberError('记忆文件路径为空', { code: 'config' })
	const warn = (message) => log('warn', message)
	return {
		file,
		append(text, weight = DEFAULT_WEIGHT, kind = undefined) {
			const body = toMemoryLine(text)
			if (body === '') throw new RememberError('要记的内容是空的', { code: 'empty' })
			if ([...body].length > MAX_LINE_CHARS) {
				throw new RememberError(`要记的内容太长（${[...body].length} 字），记忆条目最多 ${MAX_LINE_CHARS} 字`, { code: 'long' })
			}
			let current = ''
			try {
				current = existsSync(file) ? readFileSync(file, 'utf8') : ''
			} catch (error) {
				throw new RememberError(`读不了记忆文件 ${file}：${error?.message ?? String(error)}`, { code: 'read' })
			}
			const bodies = existingBodies(current)
			if (bodies.has(body)) return { added: false, duplicated: true, count: bodies.size, line: '' }
			// 换了个说法的同一件事：不写第二遍，把原来那条当成又被确认了一次。
			const near = findNearDuplicate(body, bodies)
			if (near !== '') {
				return { added: false, duplicated: true, nearDuplicate: true, count: bodies.size, line: near }
			}
			// 惊讶度只抬一档、且只从 3 抬到 4：全新的事多活一阵，但钉住（5）永远是她的决定。
			const surprise = 1 - maxSimilarity(body, bodies)
			const level = clampWeight(weight)
			const finalLevel = level === SURPRISE_BUMP_FROM && surprise >= SURPRISE_NOVEL ? level + 1 : level
			// 5 分本来就是「永远不忘」，那就别让它按笔记的半衰期淡掉。
			const tag = clampKind(kind ?? (finalLevel >= MAX_WEIGHT ? 'identity' : DEFAULT_KIND))
			const line = `- [w:${finalLevel}][k:${tag}] ${body}`
			try {
				const prefix = current === '' || current.endsWith('\n') ? '' : '\n'
				appendFileSync(file, `${prefix}${line}\n`, 'utf8')
			} catch (error) {
				throw new RememberError(`写不进记忆文件 ${file}：${error?.message ?? String(error)}`, { code: 'write' })
			}
			const count = bodies.size + 1
			if (count > maxItems) {
				warn(`qq-node: long-term memory holds ${count} items (soft cap ${maxItems}); consider pruning MEMORY.md`)
			}
			return { added: true, duplicated: false, count, line, kind: tag, weight: finalLevel, surprise: Number(surprise.toFixed(3)) }
		},
	}
}

const TOOL_DESCRIPTION = [
	'把一件「以后还会用到」的事写进你的长期记忆，让它明天、下周都还在。',
	'适合：他的喜好与忌讳、你们之间的约定、他的作息与重要日子、他明确让你记住的事。',
	'不适合：今天发生了什么、一次性的安排、你此刻的心情——那些属于日记，不用这个。',
	'只在主人的私聊里可用。同一件事重复记不会产生两条。',
].join('\n')

export function createRememberTool({ writer, onWrite } = {}) {
	if (writer === undefined || typeof writer.append !== 'function') {
		throw new RememberError('记忆写入器缺失', { code: 'config' })
	}
	return defineTool({
		name: REMEMBER_TOOL_NAME,
		description: TOOL_DESCRIPTION,
		parameters: {
			text: { type: 'string', required: true, description: `要记住的那件事，一句话，最多 ${MAX_LINE_CHARS} 字` },
			weight: {
				type: 'number',
				description: `重要程度 1-5，默认 ${DEFAULT_WEIGHT}；5 表示永远不忘（例如他的忌讳）`,
			},
			kind: {
				type: 'string',
				description: `这条是什么：identity（他是谁）/ rule（他立的规矩）/ event（一起经历过的事）/ note（笔记，默认）/ ops（系统怎么接的这类运维知识）。留空就按 note 记`,
			},
		},
		output: {
			schema: { type: 'string', description: '一行结果：记下了什么，还是本来就已经记得' },
			render(_args, value) {
				return [{ type: 'text', text: value }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			// 记忆是她的，但入口是主人的：别人不能往里写东西。
			if (!isPrivateOwnerTurn()) {
				throw new RememberError('记事情只能在主人的私聊里进行', { code: 'scope' })
			}
			const result = writer.append(args?.text, args?.weight, args?.kind)
			if (result.added) {
				try {
					onWrite?.({ text: toMemoryLine(args?.text), weight: result.weight ?? clampWeight(args?.weight), kind: result.kind })
				} catch {
					// 已经写进去了；记账坏了不能反过来告诉她「没记住」。
				}
				return `记下了：${toMemoryLine(args?.text)}`
			}
			if (result.nearDuplicate === true && result.line !== '') {
				return `这件事我本来就记着（这次是换个说法又提了一遍）：${result.line}`
			}
			return `这件事我本来就记着：${toMemoryLine(args?.text)}`
		},
	})
}
