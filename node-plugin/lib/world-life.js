/**
 * Her own Minecraft days, rendered into one short memory fragment.
 *
 * The bot lives a life on the ECS box (`/opt/whale-craft`) and none of it used
 * to reach the chat side, so she could not say a word about her own day. This
 * module turns the world's append-only feed into a sentence that reads like a
 * memory rather than a log: no field names, no `kind=`, and time in the spoken
 * forms (刚刚 / 今天 21:40 / 昨天).
 *
 * The file is written by another process, so nothing here may throw: a missing
 * file, a blank line, a broken JSON line or a half-written last line all mean
 * "that event is not there", and a feed with nothing usable renders as `''`.
 */

import { readFileSync } from 'node:fs'

/** Where the world side appends; `WORLD_LIFE_FILE` overrides it. */
export const WORLD_LIFE_FILE = '/opt/whale-craft/life-feed.jsonl'
export const WORLD_LIFE_ENV = 'WORLD_LIFE_FILE'

/** What one injection is allowed to cost: two days back, six facts, one line. */
export const WORLD_LIFE_LIMITS = Object.freeze({
	maxAgeHours: 48,
	maxEvents: 6,
	maxThoughts: 1,
	maxChars: 400,
})

/** The kinds the feed uses; an unknown kind is a newer writer we cannot phrase. */
export const WORLD_LIFE_KINDS = Object.freeze(['first', 'build', 'death', 'unstuck', 'explore', 'thought', 'companion'])

const LABEL = '她自己的世界（Minecraft）：'
const JUST_NOW_MS = 10 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** 「第一次做了…」的 text 已经自带这个开头时，别叠第二次。 */
const FIRST_SEEN = /^(第一次|首次|头一回|头一次)/
/** text 自己讲了死法，就不再补「死了一次，」。 */
const DEATH_SEEN = /死|挂|没了|摔|掉进/
/** 分隔符和句号由这里补，事件自带的句末标点先摘掉，免得「；。」连在一起。 */
const TRAILING_PUNCT = /[。．.，,；;！!？?~～\s]+$/u

/** The feed path for this process: `WORLD_LIFE_FILE`, else the live path. */
export function defaultWorldLifeFile() {
	const override = process.env[WORLD_LIFE_ENV]
	const file = typeof override === 'string' ? override.trim() : ''
	return file === '' ? WORLD_LIFE_FILE : file
}

/**
 * Every usable event of the feed, oldest first.
 *
 * Blank lines, unparseable lines (including the last one being written right
 * now) and events we cannot phrase are skipped one by one; a missing or
 * unreadable file is an empty feed.
 * @param file - the JSONL feed.
 * @param options.now - the moment the window is measured from (epoch ms).
 * @param options.maxAgeHours - how far back an event still counts.
 * @returns `{ ts, kind, text, notable }[]`, ascending by `ts`.
 */
export function readWorldLife(file, { now = Date.now(), maxAgeHours = WORLD_LIFE_LIMITS.maxAgeHours } = {}) {
	const nowMs = toMs(now)
	if (!Number.isFinite(nowMs)) return []
	const windowMs = (Number.isFinite(maxAgeHours) ? Math.max(0, maxAgeHours) : WORLD_LIFE_LIMITS.maxAgeHours) * 60 * 60 * 1000
	let raw
	try {
		raw = readFileSync(file, 'utf8')
	} catch {
		return []
	}
	const events = []
	for (const line of String(raw).split(/\r?\n/)) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		let parsed
		try {
			parsed = JSON.parse(trimmed)
		} catch {
			continue
		}
		if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
		if (!WORLD_LIFE_KINDS.includes(parsed.kind)) continue
		const text = typeof parsed.text === 'string' ? parsed.text.trim().replace(TRAILING_PUNCT, '') : ''
		if (text === '') continue
		if (typeof parsed.ts !== 'string') continue
		const ts = Date.parse(parsed.ts)
		if (!Number.isFinite(ts) || nowMs - ts > windowMs) continue
		events.push({ ts, kind: parsed.kind, text, notable: parsed.notable === true })
	}
	events.sort((left, right) => left.ts - right.ts)
	return events
}

/**
 * Render the world's recent life as one short Chinese fragment.
 *
 * The newest six facts (plus her last inner thought) survive; whole clauses are
 * dropped once the character budget is spent, never cut in half — half a memory
 * reads as a lie, a missing one reads as forgetting.
 * @param options.file - the JSONL feed; defaults to {@link defaultWorldLifeFile}.
 * @param options.now - the moment the window is measured from (epoch ms or Date).
 * @param options.maxAgeHours - how far back an event still counts.
 * @param options.maxEvents - how many ordinary events may appear.
 * @param options.maxChars - hard cap on the returned string's length.
 * @returns the fragment, or `''` when there is nothing worth saying.
 */
export function renderWorldLife({
	file = defaultWorldLifeFile(),
	now = Date.now(),
	maxAgeHours = WORLD_LIFE_LIMITS.maxAgeHours,
	maxEvents = WORLD_LIFE_LIMITS.maxEvents,
	maxChars = WORLD_LIFE_LIMITS.maxChars,
} = {}) {
	try {
		const nowMs = toMs(now)
		if (!Number.isFinite(nowMs)) return ''
		const cap = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : WORLD_LIFE_LIMITS.maxChars
		const events = readWorldLife(file, { now: nowMs, maxAgeHours })
		if (events.length === 0) return ''

		// 心里话只留最后一句：那是她此刻的样子，多说反而像转述日记。
		const thought = events.filter((event) => event.kind === 'thought').at(-1)
		const ordinary = pickEvents(events.filter((event) => event.kind !== 'thought'), maxEvents)
		const picked = thought === undefined ? ordinary : [...ordinary, thought]
		picked.sort((left, right) => right.ts - left.ts)

		const clauses = []
		let used = LABEL.length
		for (const event of picked) {
			const clause = clauseOf(event, nowMs)
			// 每条自带一个分隔符或句号，所以整条占 clause.length + 1。
			if (used + clause.length + 1 > cap) continue
			used += clause.length + 1
			clauses.push(clause)
		}
		if (clauses.length === 0) return ''
		return `${LABEL}${clauses.join('；')}。`
	} catch {
		return ''
	}
}

/** Keep the newest `limit` events, letting `notable` ones win a contended slot. */
function pickEvents(events, limit) {
	const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : WORLD_LIFE_LIMITS.maxEvents
	if (events.length <= cap) return events
	const notable = events.filter((event) => event.notable)
	if (notable.length >= cap) return notable.slice(-cap)
	return [...notable, ...events.filter((event) => !event.notable).slice(-(cap - notable.length))]
}

/** One event as a spoken clause: `今天 21:40 死了一次，身上的东西掉在原地`. */
function clauseOf(event, nowMs) {
	const when = whenWord(event.ts, nowMs)
	const body = bodyOf(event)
	// 「今天 21:40」后面空一格才不像连读，「刚刚」后面不用。
	return /\d$/.test(when) ? `${when} ${body}` : `${when}${body}`
}

/** The event's own words, framed by its kind where that adds meaning. */
function bodyOf(event) {
	const text = event.text
	switch (event.kind) {
		case 'first':
			return FIRST_SEEN.test(text) ? text : `第一次${text}`
		case 'death':
			return DEATH_SEEN.test(text) ? text : `死了一次，${text}`
		case 'thought':
			return `心里想：${text}`
		default:
			return text
	}
}

/** Spoken time: 刚刚 / 今天 21:40 / 昨天 08:15 / 前天 23:59. */
function whenWord(ts, nowMs) {
	const then = new Date(ts)
	const now = new Date(nowMs)
	if (nowMs - ts < JUST_NOW_MS) return '刚刚'
	const hhmm = `${pad2(then.getHours())}:${pad2(then.getMinutes())}`
	const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
	if (ts >= todayStart) return `今天 ${hhmm}`
	if (ts >= todayStart - DAY_MS) return `昨天 ${hhmm}`
	return `前天 ${hhmm}`
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
