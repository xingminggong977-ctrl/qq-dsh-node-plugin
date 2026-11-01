/**
 * 「他立下的规矩」——从主人说的话里挑出**长期有效**的那些，攒成一小块提示词。
 *
 * 记忆会按艾宾浩斯衰减，但规矩不该衰减：一句「以后别在群里叫我宝贝」如果两周后
 * 淡出，她就又会叫。所以这些行独立成文件、永不遗忘，并且和记忆分开注入。
 *
 * 这里只做**收录**，不做理解：原文照抄、去掉引号与换行、限长。判断「什么是规矩」
 * 靠一组很窄的模式——宁可漏收，也不要把「我受不了今天好热」这种情绪话当成规定。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The file that holds the standing rules, inside the persona directory. */
export const CORRECTION_FILE = 'CORRECTIONS.md'

/** Heading used when the rules are injected into the prompt. */
export const CORRECTION_HEADING = '## 他给你立的规矩'

/** At most this many rules are kept; the oldest fall off the top. */
export const CORRECTION_MAX_LINES = 40

/** One rule is one line, and a line is never longer than this. */
export const CORRECTION_MAX_CHARS = 200

// 「从今往后」这一类的开头，本身就宣布了这是个长期要求。
const TIME_SHIFT = /^(以后|下次|往后|今后|从今|从现在起|再这样)/u
// 「记住……」本身就把一句话变成了要长期保存的要求，不需要人称。
const REMEMBER = /^(记住|记着|记一下|记得|你要记住)/u
// 只有对着她说的否定/叮嘱才算规矩，「我受不了热」不算。
const SECOND_PERSON = /(你|咱)/u
const DIRECTIVE = /(不要|别再|不许|不准|不能|别|记得|记住|记着|答应)/u
// 关于主人自己的稳定偏好，即使没有「你」也是长期事实。刻意不收「受不了/讨厌」：
// 「我受不了今天好热」是当时的情绪，不是要她记一辈子的规矩。
const PREFERENCE = /^我(很|特别|超|最)?(喜欢|不喜欢|习惯|爱)/u

/**
 * Does this line look like a standing instruction rather than conversation?
 * @param text - one inbound message.
 * @returns true when the line should be filed as a rule.
 */
export function isCorrection(text) {
	if (typeof text !== 'string') return false
	const line = text.trim()
	if (line === '' || [...line].length > CORRECTION_MAX_CHARS) return false
	if (PREFERENCE.test(line)) return true
	if (TIME_SHIFT.test(line)) return true
	if (REMEMBER.test(line)) return true
	return SECOND_PERSON.test(line) && DIRECTIVE.test(line)
}

/**
 * Make one rule out of a raw message: single line, no quotes, bounded length.
 * @param text - the raw inbound message.
 * @returns the storable line, or `''` when nothing usable is left.
 */
export function normalizeCorrection(text) {
	if (typeof text !== 'string') return ''
	const flat = text
		.replace(/[\r\n]+/gu, ' ')
		.replace(/[「」“”"'`]/gu, '')
		.replace(/\s+/gu, ' ')
		.trim()
	if (flat === '') return ''
	const chars = [...flat]
	return chars.length > CORRECTION_MAX_CHARS ? chars.slice(0, CORRECTION_MAX_CHARS).join('') : flat
}

/** The body of a stored line, without its `- [YYYY-MM-DD] ` prefix. */
export function correctionBody(line) {
	return String(line).replace(/^-\s*\[[^\]]*\]\s*/u, '').trim()
}

/**
 * Merge new rules into the stored ones: newest last, duplicate bodies dropped,
 * and the list bounded so the prompt cannot grow without limit.
 * @param existing - lines already on disk, in file order.
 * @param additions - new bodies, newest last.
 * @param stamp - `YYYY-MM-DD` to prefix new lines with.
 * @returns the lines to write, in file order.
 */
export function mergeCorrections(existing, additions, stamp = '') {
	const entries = []
	for (const line of existing) {
		const body = correctionBody(line)
		if (body !== '') entries.push({ line: String(line).trim(), body })
	}
	for (const raw of additions) {
		const body = normalizeCorrection(raw)
		if (body === '') continue
		entries.push({ line: stamp === '' ? `- ${body}` : `- [${stamp}] ${body}`, body })
	}
	const kept = []
	const seen = new Set()
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const key = entries[index].body.toLowerCase()
		if (seen.has(key)) continue
		seen.add(key)
		kept.push(entries[index].line)
	}
	kept.reverse()
	return kept.slice(-CORRECTION_MAX_LINES)
}

/**
 * A tiny append-only rule book. `add` never throws: losing a rule is annoying,
 * but a broken book must not break the reply it arrived with.
 * @param options.file - absolute path to `CORRECTIONS.md`.
 * @param options.now - clock, injectable for tests.
 * @param options.log - `(level, message)` sink.
 * @returns `{ file, add(text), read() }`.
 */
export function createCorrectionBook({ file, now = () => Date.now(), log = () => {} } = {}) {
	const stamp = () => new Date(now()).toISOString().slice(0, 10)
	const read = () => {
		try {
			return readFileSync(file, 'utf8')
		} catch (error) {
			if (error?.code !== 'ENOENT') log('warn', `qq-node: ${file} is unreadable (${error?.code ?? String(error)})`)
			return ''
		}
	}
	return {
		file,
		read,
		add(text) {
			const body = normalizeCorrection(text)
			if (body === '') return false
			try {
				const lines = mergeCorrections(read().split('\n'), [body], stamp())
				mkdirSync(dirname(file), { recursive: true })
				writeFileSync(`${file}.tmp`, `${lines.join('\n')}\n`, 'utf8')
				renameSync(`${file}.tmp`, file)
				return true
			} catch (error) {
				log('warn', `qq-node: could not record a rule (${error?.code ?? error?.message ?? String(error)})`)
				return false
			}
		},
	}
}
