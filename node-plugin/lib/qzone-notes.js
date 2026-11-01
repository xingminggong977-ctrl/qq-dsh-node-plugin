/**
 * Her own QQ-Zone posts, turned into one short fragment for the prompt.
 *
 * The cloud side appends a line to `qzone-log.md` every time she posts, and
 * NapCat in this version only exposes send/delete — there is no way to read the
 * list back. So this log is the only thing that lets her answer
 * 「你刚才说说讲了什么」； without it the honest answer would be "I don't
 * remember writing that", which is worse than not posting at all.
 *
 * The file is written by another machine, so nothing here may throw: a missing
 * file, a stray header line, a half-written last line, a broken JSON line or an
 * impossible date all mean "that post is not there", and a log with nothing
 * usable renders as `''`.
 */

import { readFileSync } from 'node:fs'
import { qqSessionOf } from './persona.js'

/** Where the cloud side appends the readable log; `QZONE_LOG_FILE` overrides it. */
export const QZONE_LOG_FILE = '/opt/whale-craft/qzone-log.md'
export const QZONE_LOG_ENV = 'QZONE_LOG_FILE'

/** What one injection is allowed to cost: three days back, five posts, one block. */
export const QZONE_NOTE_LIMITS = Object.freeze({
	maxAgeHours: 72,
	maxNotes: 5,
	maxNoteChars: 120,
	maxChars: 420,
})

const LABEL = '最近发过的说说（新的在前）：'
const JUST_NOW_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** `- 2026-10-29 16:05｜正文` — the readable log's one line per post. */
const MD_NOTE = /^[-*]\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})\s*[｜|]\s*(.+)$/u
/** 正文可能被写成一行的片段；换行会打断列表，所以先压成一行。 */
const BLANKS = /\s+/gu

/** The log path for this process: `QZONE_LOG_FILE`, else the live path. */
export function defaultQzoneLogFile() {
	const override = process.env[QZONE_LOG_ENV]
	const file = typeof override === 'string' ? override.trim() : ''
	return file === '' ? QZONE_LOG_FILE : file
}

/**
 * Every usable post of the log, newest first.
 *
 * Both shapes of the log are understood — the readable `- YYYY-MM-DD HH:MM｜…`
 * line and the JSONL line of `qzone-log.jsonl` — because the same content is
 * written twice and `QZONE_LOG_FILE` may be pointed at either. A line that
 * parses as neither is skipped on its own; a missing or unreadable file is an
 * empty log.
 * @param file - the log to read; defaults to {@link defaultQzoneLogFile}.
 * @param options.now - the moment the window is measured from (epoch ms).
 * @param options.maxAgeHours - how far back a post still counts.
 * @returns `{ ts, text }[]`, descending by `ts`.
 */
export function readQzoneNotes(file = defaultQzoneLogFile(), { now = Date.now(), maxAgeHours = QZONE_NOTE_LIMITS.maxAgeHours } = {}) {
	const nowMs = toMs(now)
	if (!Number.isFinite(nowMs)) return []
	const hours = Number.isFinite(maxAgeHours) ? Math.max(0, maxAgeHours) : QZONE_NOTE_LIMITS.maxAgeHours
	const windowMs = hours * 60 * 60 * 1000
	let raw
	try {
		raw = readFileSync(file, 'utf8')
	} catch {
		return []
	}
	const notes = []
	for (const line of String(raw).split(/\r?\n/)) {
		const note = parseLine(line.trim())
		if (note === undefined) continue
		// 未来时间也只当「刚刚」：云端时钟偶发跳一下，不该让一条旧事顶掉新的。
		if (note.ts - nowMs > JUST_NOW_MS) continue
		if (nowMs - note.ts > windowMs) continue
		notes.push(note)
	}
	notes.sort((left, right) => right.ts - left.ts)
	return notes
}

/**
 * Render her recent posts as one short markdown list.
 *
 * Newest first and capped three ways: the oldest whole line is dropped before a
 * surviving line is ever cut, because half a sentence of her own post reads as a
 * lie. A single post still over the budget is trimmed at the tail with `…` so
 * the block never grows past {@link QZONE_NOTE_LIMITS.maxChars}.
 * @param context - the assembly context; `context.agent` selects the session.
 * @param options.file - the log to read; defaults to {@link defaultQzoneLogFile}.
 * @param options.now - the moment the window is measured from (epoch ms or Date).
 * @param options.maxAgeHours - how far back a post still counts.
 * @param options.maxNotes - how many posts may appear.
 * @param options.maxNoteChars - per-post cap on the body.
 * @param options.maxChars - hard cap on the returned block.
 * @returns the block, or `''` for a non-QQ session or an empty log.
 */
export function renderQzoneNotes(context, {
	file = defaultQzoneLogFile(),
	now = Date.now(),
	maxAgeHours = QZONE_NOTE_LIMITS.maxAgeHours,
	maxNotes = QZONE_NOTE_LIMITS.maxNotes,
	maxNoteChars = QZONE_NOTE_LIMITS.maxNoteChars,
	maxChars = QZONE_NOTE_LIMITS.maxChars,
} = {}) {
	try {
		// 和 `worldLifeText` 同一处判定：非 QQ 会话一个字都不注入。
		if (qqSessionOf(context?.agent) === undefined) return ''
		const nowMs = toMs(now)
		if (!Number.isFinite(nowMs)) return ''
		const cap = whole(maxChars, QZONE_NOTE_LIMITS.maxChars)
		const perNote = whole(maxNoteChars, QZONE_NOTE_LIMITS.maxNoteChars)
		const notes = readQzoneNotes(file, { now: nowMs, maxAgeHours }).slice(0, whole(maxNotes, QZONE_NOTE_LIMITS.maxNotes))
		if (notes.length === 0 || perNote <= 0) return ''

		const kept = notes.map((note) => ({ when: whenWord(note.ts, nowMs), text: clip(note.text, perNote) }))
		while (kept.length > 1 && size(kept) > cap) kept.pop()
		if (size(kept) > cap) {
			// 只剩最新那条还超：留着它，把正文截到刚好放得下，比整段消失有用。
			const room = cap - `${LABEL}\n- ${kept[0].when}｜`.length
			if (room <= 0) return ''
			kept[0] = { when: kept[0].when, text: clip(kept[0].text, room) }
		}
		return `${LABEL}\n${body(kept)}`
	} catch {
		return ''
	}
}

/** One log line as a post, or `undefined` when the line is not one. */
function parseLine(line) {
	if (line === '' || line.startsWith('#')) return undefined
	const md = MD_NOTE.exec(line)
	if (md !== null) {
		const [, year, month, day, hour, minute, text] = md
		const ts = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute))
		// 云端偶尔写坏日期；`2 月 30 日` 会被滚成 3 月，那不算「解析成功」。
		if (ts.getMonth() !== Number(month) - 1 || ts.getDate() !== Number(day)) return undefined
		return noteOf(ts.getTime(), text)
	}
	// 同一份日志还有 JSONL 一版；指到那边时也得读得懂，坏行照样只丢自己。
	let parsed
	try {
		parsed = JSON.parse(line)
	} catch {
		return undefined
	}
	if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
	const ts = typeof parsed.ts === 'string' ? Date.parse(parsed.ts) : Number.NaN
	if (!Number.isFinite(ts)) return undefined
	return noteOf(ts, typeof parsed.text === 'string' ? parsed.text : '')
}

/** Keep a parsed line only when it has a real moment and some words. */
function noteOf(ts, text) {
	const body = String(text ?? '').replace(BLANKS, ' ').trim()
	if (!Number.isFinite(ts) || body === '') return undefined
	return { ts, text: body }
}

/** Spoken time: 刚刚 / 今天 16:05 / 昨天 21:40 / 前天 08:15 / 3 天前 23:59. */
function whenWord(ts, nowMs) {
	if (nowMs - ts < JUST_NOW_MS) return '刚刚'
	const then = new Date(ts)
	const now = new Date(nowMs)
	const hhmm = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	if (ts >= todayStart) return `今天 ${hhmm}`
	// 向上取整：昨天 23:59 是 1 天前，不该因为不到 24 小时就说成今天。
	const daysAgo = Math.ceil((todayStart - ts) / DAY_MS)
	if (daysAgo === 1) return `昨天 ${hhmm}`
	if (daysAgo === 2) return `前天 ${hhmm}`
	// 72 小时的窗口够得着三天前，所以按整天数说，不硬套「前天」。
	return `${daysAgo} 天前 ${hhmm}`
}

/** `一次注入最多 these many chars`; a stupid override falls back to the ceiling. */
function whole(value, fallback) {
	return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback
}

/** Cut `text` to at most `limit` characters, `…` included, on a code point boundary. */
function clip(text, limit) {
	const chars = [...String(text ?? '')]
	if (chars.length <= limit) return chars.join('')
	if (limit <= 0) return ''
	if (limit === 1) return '…'
	return `${chars.slice(0, limit - 1).join('')}…`
}

/** The list body; `kept` is newest first, one `- 今天 16:05｜正文` line per post. */
function body(kept) {
	return kept.map((note) => `- ${note.when}｜${note.text}`).join('\n')
}

/** Rendered length of the block, label and separator included. */
function size(kept) {
	return LABEL.length + 1 + body(kept).length
}

function pad2(value) {
	return String(value).padStart(2, '0')
}

/** `now` may arrive as epoch ms, a Date, or an ISO string; anything else is `NaN`. */
function toMs(now) {
	if (now instanceof Date) return now.getTime()
	if (typeof now === 'number') return now
	if (typeof now === 'string') return Date.parse(now)
	return Number.NaN
}
