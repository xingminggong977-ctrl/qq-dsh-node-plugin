/**
 * Group-chat side of protocol v2: the two new task fields (`mentioned`,
 * `needsReply`), the per-conversation ring buffer that becomes the "群聊前文"
 * block of a turn, and the throttle behind the optional interjection.
 */

/** Ring depth per conversation key: the last 20 group messages. */
export const GROUP_HISTORY_LIMIT = 20

/** Delimiters around the history block; the current message follows the footer. */
export const GROUP_HISTORY_HEADER = '--- 群聊前文 ---'
export const GROUP_HISTORY_FOOTER = '--- 以上是前文 ---'

/** The one reply text that means "say nothing"; it never reaches QQ. */
export const INTERJECTION_SILENCE = '[沉默]'

/** Config defaults of `proactiveInterjection`; `index.js` builds its schema from these. */
export const INTERJECTION_DEFAULTS = Object.freeze({
	enabled: false,
	minIntervalMs: 20_000,
	maxPerMinute: 6,
	maxPerGroupPerDay: 100,
})

const MINUTE_MS = 60_000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * `needsReply` / `mentioned` default to true: only an explicit `false` counts as
 * "no", so an old bridge that omits both fields can never silence a reply.
 */
export function needsReplyOf(task) {
	return task?.needsReply !== false
}

/** @see needsReplyOf */
export function mentionedOf(task) {
	return task?.mentioned !== false
}

/** Only group conversations keep history and may interject; private chat is untouched. */
export function isGroupTask(task) {
	return task?.kind === 'group'
}

/**
 * History and throttle key of a group task: **one key per group**, shared by
 * every member. A group conversation must not be sliced per speaker — otherwise
 * what 主人 said is invisible to 群友A's turn.
 *
 * This is deliberately not {@link sessionKeyOf}: the agent session stays per
 * user (owner and guest sessions must never merge), only the pre-context is
 * group-wide.
 */
export function groupKeyOf(task) {
	return `qq:group:${task?.groupId ?? '-'}`
}

function positiveOr(value, fallback) {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/**
 * Ring buffer of recent group messages, stripped to what a later turn needs:
 * who said it, what it said, and whether the bot was @-ed. Keyed by
 * {@link groupKeyOf}, so every member of one group reads one shared history.
 */
export class QqGroupBuffer {
	#limit
	#entries = new Map()

	constructor({ limit = GROUP_HISTORY_LIMIT } = {}) {
		this.#limit = positiveOr(limit, GROUP_HISTORY_LIMIT)
	}

	get limit() {
		return this.#limit
	}

	/** Append one message, dropping the oldest beyond the limit. */
	record(key, { nickname, text, mentioned, at } = {}) {
		const entries = this.#entries.get(key)
		const entry = {
			nickname: typeof nickname === 'string' && nickname !== '' ? nickname : '未知',
			text: typeof text === 'string' ? text : String(text ?? ''),
			mentioned: mentioned === true,
			at,
		}
		if (entries === undefined) {
			this.#entries.set(key, [entry])
			return entry
		}
		entries.push(entry)
		if (entries.length > this.#limit) entries.splice(0, entries.length - this.#limit)
		return entry
	}

	/** Snapshot of one conversation's buffer, oldest first. */
	entries(key) {
		return [...(this.#entries.get(key) ?? [])]
	}

	size(key) {
		return this.#entries.get(key)?.length ?? 0
	}

	/** The history block of one conversation; '' when nothing has been buffered yet. */
	format(key) {
		const entries = this.#entries.get(key)
		if (entries === undefined || entries.length === 0) return ''
		const lines = entries.map((entry) => `${entry.mentioned ? '@' : ''}[${entry.nickname}] ${entry.text}`)
		return [GROUP_HISTORY_HEADER, ...lines, GROUP_HISTORY_FOOTER].join('\n')
	}

	clear() {
		this.#entries.clear()
	}
}

/**
 * Rate limits of the interjection: one turn per group at most every
 * `minIntervalMs`, at most `maxPerMinute` interjections process-wide per rolling
 * minute, and at most `maxPerGroupPerDay` per group per rolling day.
 *
 * `key` is a {@link groupKeyOf} key, so both per-key limits count the whole
 * group and not one of its speakers; the per-minute limit stays global.
 *
 * A required reply never enters this gate; it only reports that she spoke, so
 * the per-group interval also counts real answers.
 */
export class InterjectionGate {
	#enabled
	#minIntervalMs
	#maxPerMinute
	#maxPerGroupPerDay
	#lastSpoke = new Map()
	#dayTimes = new Map()
	#minuteTimes = []

	constructor(config = {}) {
		const raw = config !== null && typeof config === 'object' ? config : {}
		this.#enabled = raw.enabled === true
		this.#minIntervalMs = positiveOr(raw.minIntervalMs, INTERJECTION_DEFAULTS.minIntervalMs)
		this.#maxPerMinute = positiveOr(raw.maxPerMinute, INTERJECTION_DEFAULTS.maxPerMinute)
		this.#maxPerGroupPerDay = positiveOr(raw.maxPerGroupPerDay, INTERJECTION_DEFAULTS.maxPerGroupPerDay)
	}

	get enabled() {
		return this.#enabled
	}

	/** The normalized limits this gate enforces (diagnostics). */
	get limits() {
		return {
			enabled: this.#enabled,
			minIntervalMs: this.#minIntervalMs,
			maxPerMinute: this.#maxPerMinute,
			maxPerGroupPerDay: this.#maxPerGroupPerDay,
		}
	}

	/** Whether one interjection would be allowed right now; records nothing. */
	allows(key, now = Date.now()) {
		if (!this.#enabled) return false
		const last = this.#lastSpoke.get(key)
		if (last !== undefined && now - last < this.#minIntervalMs) return false
		this.#prune(now)
		if (this.#minuteTimes.length >= this.#maxPerMinute) return false
		if ((this.#dayTimes.get(key)?.length ?? 0) >= this.#maxPerGroupPerDay) return false
		return true
	}

	/** Consume one interjection slot for `key`; false when a limit refuses it. */
	tryTake(key, now = Date.now()) {
		if (!this.allows(key, now)) return false
		this.#lastSpoke.set(key, now)
		this.#minuteTimes.push(now)
		const times = this.#dayTimes.get(key)
		if (times === undefined) this.#dayTimes.set(key, [now])
		else times.push(now)
		return true
	}

	/** Record that she spoke (a required reply): the per-group interval counts it. */
	noteSpoke(key, now = Date.now()) {
		this.#lastSpoke.set(key, now)
	}

	clear() {
		this.#lastSpoke.clear()
		this.#dayTimes.clear()
		this.#minuteTimes = []
	}

	#prune(now) {
		this.#minuteTimes = this.#minuteTimes.filter((at) => now - at < MINUTE_MS)
		for (const [key, times] of this.#dayTimes) {
			const live = times.filter((at) => now - at < DAY_MS)
			if (live.length === 0) this.#dayTimes.delete(key)
			else this.#dayTimes.set(key, live)
		}
	}
}
