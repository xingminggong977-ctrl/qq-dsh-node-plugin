/**
 * The item model behind "memory that gets forgotten": split MEMORY.md into
 * atomic items, score them with a forgetting curve, keep the ones that still
 * matter, render them back to markdown.
 *
 * Pure functions only — no `node:fs` here. The disk side (`memory/meta.json`)
 * lives in `memory-store.js`, and both are wired into `persona.js`.
 *
 * Item text is *normalized*: trailing whitespace per line is dropped, runs of
 * blank lines collapse to one, the block is trimmed and continuation lines lose
 * their indentation. That keeps `key` stable across a render → split round trip,
 * which is what makes the archive idempotent.
 */

import { createHash } from 'node:crypto'

/** Item caps for the decay model. Separate from LIMITS, which counts bytes. */
export const DEFAULT_MEMORY_LIMITS = Object.freeze({
	/** Items injected per assembly. */
	maxItems: 60,
	/** An item scoring below this is not injected; it goes to the archive. */
	forgetBelow: 0.6,
	/** An item whose weight reaches this is never forgotten. */
	pinnedWeight: 5,
})

/** Weight assumed for an item with neither recorded meta nor a `[w:N]` prefix. */
export const DEFAULT_ITEM_WEIGHT = 3

/**
 * How many rehearsals the curve counts. Without a cap, an item that is injected
 * every turn doubles its stability every turn and becomes immortal within a
 * minute; with `MAX_REVIEWS = 5` the longest stability is `2 ** 5 = 32` days, so
 * even a much-rehearsed item starts to fade once nobody touches it for a while.
 */
export const MAX_REVIEWS = 5

const MS_PER_DAY = 86_400_000
/** `#`, `##`, `###` … at up to three spaces of indent, as CommonMark allows. */
const HEADING = /^ {0,3}(#{1,6})[ \t]+(.*)$/
/** A list bullet; sub-bullets are recognised by their indent. */
const BULLET = /^([ \t]*)[-*+][ \t]+(.*)$/
/** Optional importance prefix on an item body, e.g. `[w:5]` (always keep this). */
const WEIGHT_PREFIX = /^\[w:([0-9]+(?:\.[0-9]+)?)\]/
/**
 * Optional kind prefix on an item body, e.g. `[k:event]`.
 *
 * Why a prefix and not a field in `memory/meta.json`: the kind is part of what the
 * item *is*, and meta records are derived (they get orphaned and pruned); the body
 * is the only copy that survives. The prefix also keeps the classification visible
 * in a diff of MEMORY.md.
 */
const KIND_PREFIX = /^\[k:([a-z]+)\]/

/**
 * Base stability per kind, in days, *multiplied* by the review curve. `identity`
 * and `rule` never decay; `event` (her life in the world) and `note` hold for
 * about half a year; `ops` (how the QQ bridge is wired — useful, not personal)
 * for a season.
 *
 * The numbers are stability, not the moment an item is dropped: retention is
 * `exp(-days / stability)`, so the first day an unpinned item could fall below
 * `forgetBelow: 0.6` is `0.51 × stability` — half a year here means the first
 * possible fade is ~92 days out, and only if nothing ever mentions it again.
 *
 * An item with no `[k:…]` prefix keeps the historical behaviour (`baseDays: 1`),
 * so old tests and untagged memories score exactly as before.
 */
export const KIND_BASE_DAYS = Object.freeze({
	identity: Infinity,
	rule: Infinity,
	event: 180,
	note: 180,
	ops: 120,
})

/** Kinds that are never dropped, whatever their score. */
export const PINNED_KINDS = Object.freeze(['identity', 'rule'])

/** Kinds `readKind` accepts. */
export const ITEM_KINDS = Object.freeze(['identity', 'rule', 'event', 'note', 'ops'])

/**
 * Canonical item body: stable under a render → split round trip.
 * @param value - any text.
 * @returns the trimmed block with each line stripped and blank runs collapsed.
 */
export function normalizeText(value) {
	return String(value ?? '')
		.replace(/\r\n?/g, '\n')
		.split('\n')
		.map((line) => line.replace(/[ \t]+$/, ''))
		.join('\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim()
}

/**
 * The stable identity of one item: 16 hex chars of the sha256 of its body.
 * @param text - the item body, normalized or not.
 */
export function itemKey(text) {
	return createHash('sha256').update(normalizeText(text)).digest('hex').slice(0, 16)
}

/**
 * Read the optional `[w:N]` importance prefix of an item body.
 *
 * The two prefixes may appear in either order (`[w:5][k:identity]` is what
 * `remember` writes, `[k:event][w:3]` is hand-written often enough), so each reader
 * drops the other one before matching.
 *
 * @param text - the item body.
 * @param fallback - weight when the prefix is absent or not a number.
 */
export function readWeight(text, fallback = DEFAULT_ITEM_WEIGHT) {
	const body = String(text ?? '')
		.trim()
		.replace(KIND_PREFIX, '')
		.trim()
	const match = WEIGHT_PREFIX.exec(body)
	if (match === null) return fallback
	const value = Number(match[1])
	return Number.isFinite(value) ? value : fallback
}

/**
 * Read the optional `[k:…]` kind prefix of an item body.
 * @param text - the item body.
 * @returns one of {@link ITEM_KINDS}, or `undefined` for an untagged item.
 */
export function readKind(text) {
	const body = String(text ?? '')
		.trim()
		.replace(WEIGHT_PREFIX, '')
		.trim()
	const match = KIND_PREFIX.exec(body)
	if (match === null) return undefined
	const kind = match[1]
	return ITEM_KINDS.includes(kind) ? kind : undefined
}

/**
 * Split a memory markdown file into its preamble and atomic items.
 *
 * The document title (the first `#` heading) and any prose before the first
 * bullet stay in `preamble`; every heading below it (any level) becomes the
 * `heading` path of the items that follow, joined with `" > "`; every bullet is
 * one item, with its indented continuation lines (and nested bullets) kept
 * inside it. Prose after the first bullet becomes an item of its own, so no
 * text is ever dropped on the floor.
 *
 * @param markdown - the file body.
 * @returns `{ preamble, items }` where each item is `{ key, heading, text }`.
 */
export function splitMemoryItems(markdown) {
	const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
	const preamble = []
	const items = []
	const stack = []
	let current = null
	let titleTaken = false
	let seenBullet = false
	let blankBefore = false

	const headingPath = () => stack.map((entry) => entry.text).join(' > ')
	const flush = () => {
		if (current === null) return
		const text = normalizeText(current.lines.join('\n'))
		if (text !== '') items.push({ key: itemKey(text), heading: current.heading, text })
		current = null
	}

	for (const raw of lines) {
		const line = raw.replace(/[ \t]+$/, '')
		if (line.trim() === '') {
			blankBefore = true
			continue
		}
		const heading = HEADING.exec(line)
		if (heading !== null) {
			flush()
			blankBefore = false
			const level = heading[1].length
			const text = heading[2].replace(/[ \t]+#+$/, '').trim()
			// The first `#` heading is the document title: it stays in the preamble
			// rather than becoming a heading path every item would inherit.
			if (!titleTaken && level === 1 && items.length === 0) {
				titleTaken = true
				preamble.push(line)
				continue
			}
			titleTaken = true
			while (stack.length > 0 && stack.at(-1).level >= level) stack.pop()
			stack.push({ level, text })
			continue
		}
		const bullet = BULLET.exec(line)
		const nested = bullet !== null && bullet[1] !== '' && current !== null
		if (bullet !== null && !nested) {
			flush()
			blankBefore = false
			seenBullet = true
			current = { heading: headingPath(), lines: [bullet[2]] }
			continue
		}
		if (!seenBullet) {
			// Title block and intro prose: preamble, verbatim.
			preamble.push(line)
			blankBefore = false
			continue
		}
		// A blank line ends an item unless the next line is indented with it.
		if (current !== null && !(blankBefore && !/^[ \t]/.test(line))) {
			current.lines.push(line.replace(/^[ \t]+/, ''))
			blankBefore = false
			continue
		}
		flush()
		blankBefore = false
		current = { heading: headingPath(), lines: [bullet === null ? line : bullet[2]] }
	}
	flush()
	return { preamble: normalizeText(preamble.join('\n')), items }
}

/**
 * The forgetting curve of one item.
 *
 * `stabilityDays = baseDays * (2 ** reviews)` (0 reviews and `baseDays: 1` → 1 day,
 * 1 review → 2, 2 → 4, …), so a reviewed item decays exponentially slower;
 * `retention = exp(-days / stability)` and the score is `weight * retention`.
 *
 * `baseDays` is the kind's base stability ({@link KIND_BASE_DAYS}); it defaults to
 * 1, which is exactly the pre-kind behaviour. `Infinity` short-circuits to "never
 * decays", and is only used by the pinned kinds.
 *
 * @param meta - `{ weight, reviews, lastTouchedAt }`; missing fields fall back to
 *   a weight of {@link DEFAULT_ITEM_WEIGHT}, 0 reviews and "touched just now".
 * @param nowMs - the clock, in ms since the epoch.
 * @param options.baseDays - multiplier of the review stability; defaults to 1.
 * @returns the score; 0 reviews and 0 elapsed days yields exactly the weight.
 */
export function scoreItem(meta, nowMs, options = {}) {
	const at = Number.isFinite(nowMs) ? nowMs : Date.now()
	const weight = Number.isFinite(meta?.weight) ? meta.weight : DEFAULT_ITEM_WEIGHT
	const baseDays = options?.baseDays === Infinity ? Infinity : Number.isFinite(options?.baseDays) && options.baseDays > 0 ? options.baseDays : 1
	if (baseDays === Infinity) return weight
	const reviews = Number.isFinite(meta?.reviews) && meta.reviews > 0 ? Math.min(Math.floor(meta.reviews), MAX_REVIEWS) : 0
	const stabilityDays = baseDays * 2 ** reviews
	const touched = Number.isFinite(meta?.lastTouchedAt) ? meta.lastTouchedAt : at
	const days = Math.max(0, (at - touched) / MS_PER_DAY)
	const retention = Math.exp(-days / stabilityDays)
	return weight * retention
}

/**
 * Decide what is still worth injecting.
 *
 * Pinned items (`weight >= pinnedWeight`, or a kind in {@link PINNED_KINDS}) are
 * always kept; the rest must score at least `forgetBelow`. Kept items are sorted
 * by score, highest first, and cut at `maxItems`; everything not kept — including
 * what the cut squeezed out — is reported as forgotten.
 *
 * @param items - `{ key, text }[]` from {@link splitMemoryItems}.
 * @param metaMap - the `items` object of `memory/meta.json`, keyed by item key.
 * @param options - `maxItems`, `forgetBelow`, `pinnedWeight`, and
 *   `freshLastTouchedAt` (the mtime of MEMORY.md) for items with no meta record.
 * @param nowMs - the clock.
 * @returns `{ kept, forgotten }`, both holding the original item objects.
 */
export function selectItems(items, metaMap, options, nowMs) {
	const settings = { ...DEFAULT_MEMORY_LIMITS, ...(options ?? {}) }
	const maxItems = Number.isFinite(settings.maxItems)
		? Math.max(0, Math.floor(settings.maxItems))
		: DEFAULT_MEMORY_LIMITS.maxItems
	const forgetBelow = Number.isFinite(settings.forgetBelow) ? settings.forgetBelow : DEFAULT_MEMORY_LIMITS.forgetBelow
	const pinnedWeight = Number.isFinite(settings.pinnedWeight) ? settings.pinnedWeight : DEFAULT_MEMORY_LIMITS.pinnedWeight
	const records = metaMap !== null && typeof metaMap === 'object' ? metaMap : {}
	const at = Number.isFinite(nowMs) ? nowMs : Date.now()
	const fresh = Number.isFinite(settings.freshLastTouchedAt) ? settings.freshLastTouchedAt : at

	const scored = (Array.isArray(items) ? items : []).map((item, index) => {
		const meta = records[item?.key]
		const weight = Number.isFinite(meta?.weight) ? meta.weight : readWeight(item?.text)
		// An item with no record yet is "new": weight from its `[w:N]` prefix, zero
		// reviews, and the MEMORY.md mtime as its last touch — a file nobody has
		// edited for a week starts out decayed instead of looking freshly written.
		const effective = meta === undefined || meta === null ? { weight, reviews: 0, lastTouchedAt: fresh } : { ...meta, weight }
		// 分档：身份和规矩永不丢，其余按各自的基础稳定期衰减；没打标的条目沿用旧行为。
		const kind = readKind(item?.text)
		const score = scoreItem(effective, at, { baseDays: kind === undefined ? 1 : KIND_BASE_DAYS[kind] })
		const pinned = weight >= pinnedWeight || (kind !== undefined && PINNED_KINDS.includes(kind))
		return { item, index, score, pinned }
	})

	const eligible = scored.filter((entry) => entry.pinned || entry.score >= forgetBelow)
	eligible.sort((left, right) => right.score - left.score || left.index - right.index)
	const keptEntries = eligible.slice(0, maxItems)
	const kept = new Set(keptEntries.map((entry) => entry.item))
	const forgotten = scored.filter((entry) => !kept.has(entry.item)).map((entry) => entry.item)
	return { kept: keptEntries.map((entry) => entry.item), forgotten }
}

/**
 * Render items back to markdown: the preamble verbatim, then one `- ` line per
 * item in the order given. A multi-line item keeps its own lines indented by two
 * spaces, so {@link splitMemoryItems} reads it back as the same single item.
 *
 * @param state - `{ preamble, items }`; `items` entries need only `.text`.
 * @returns the markdown body (no trailing newline).
 */
export function renderMemory(state) {
	const preamble = normalizeText(state?.preamble ?? '')
	const body = (Array.isArray(state?.items) ? state.items : [])
		.map((item) => normalizeText(item?.text ?? ''))
		.filter((text) => text !== '')
		.map((text) => `- ${text.replace(/\n/g, '\n  ')}`)
		.join('\n')
	if (preamble === '') return body
	if (body === '') return preamble
	return `${preamble}\n\n${body}`
}

/** Characters that carry no topic of their own: a bigram made of two of them is noise. */
const SIM_STOP_CHARS = new Set([
	...'的了着过是有在和与也都就才而极其这那你我他她它不没一个上下来去到会要能说好看着些么什怎样',
])

const LATIN_WORD = /[a-z0-9]{2,}/g
const CJK_CHAR = /[\u4e00-\u9fff]/

/**
 * The bag of things two texts can share: latin words and CJK bigrams.
 *
 * Chinese has no spaces, so single characters match everything and whole sentences
 * match nothing; bigrams are the unit that actually tells 「她在海边有座屋子」 from
 * 「她在水井边打水」. Bigrams made of two stop characters are dropped, and a text
 * with no bigram at all (a single character, or only punctuation) falls back to its
 * remaining single characters so it can still be compared.
 *
 * @param text - the text, or an already-built token set.
 * @returns a `Set` of tokens.
 */
export function similarityTokens(text) {
	if (text instanceof Set) return text
	const lowered = String(text ?? '').toLowerCase()
	const tokens = new Set()
	for (const word of lowered.match(LATIN_WORD) ?? []) tokens.add(word)
	const cjk = [...lowered].filter((char) => CJK_CHAR.test(char))
	for (let index = 0; index + 1 < cjk.length; index += 1) {
		if (SIM_STOP_CHARS.has(cjk[index]) && SIM_STOP_CHARS.has(cjk[index + 1])) continue
		tokens.add(cjk[index] + cjk[index + 1])
	}
	if (tokens.size === 0) for (const char of cjk) if (!SIM_STOP_CHARS.has(char)) tokens.add(char)
	return tokens
}

/**
 * Jaccard similarity of two texts: shared tokens over all tokens.
 * @param left - text or token set.
 * @param right - text or token set.
 * @returns a number in `[0, 1]`; 0 when either side has no tokens.
 */
export function jaccardSimilarity(left, right) {
	const a = similarityTokens(left)
	const b = similarityTokens(right)
	if (a.size === 0 || b.size === 0) return 0
	let shared = 0
	for (const token of a) if (b.has(token)) shared += 1
	return shared / (a.size + b.size - shared)
}

/**
 * Containment of the smaller text in the larger one: shared tokens over the
 * smaller side's tokens. This is what tells 「一句话被扩写成一段」 from
 * 「两段说的是同一件事」.
 *
 * @param left - text or token set.
 * @param right - text or token set.
 * @returns a number in `[0, 1]`; 0 when either side has no tokens.
 */
export function containment(left, right) {
	const a = similarityTokens(left)
	const b = similarityTokens(right)
	if (a.size === 0 || b.size === 0) return 0
	const [small, large] = a.size <= b.size ? [a, b] : [b, a]
	let shared = 0
	for (const token of small) if (large.has(token)) shared += 1
	return shared / small.size
}

/**
 * The two thresholds from the paper's §2.7 dedupe rule (「大肥鱼系统 v2.0」): a new
 * line merges into an existing one only when it is *both* largely the same text
 * (Jaccard) and almost entirely contained in it — either test alone merges things
 * that only share a topic.
 */
export const DUPLICATE_JACCARD = 0.6
export const DUPLICATE_CONTAINMENT = 0.78

/**
 * Whether two item bodies are the same memory written twice.
 * @param left - text or token set.
 * @param right - text or token set.
 * @returns `true` when both the Jaccard and the containment thresholds are met.
 */
export function isNearDuplicate(left, right) {
	return jaccardSimilarity(left, right) >= DUPLICATE_JACCARD && containment(left, right) >= DUPLICATE_CONTAINMENT
}

