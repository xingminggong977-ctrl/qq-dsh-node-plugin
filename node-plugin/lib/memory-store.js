/**
 * The disk side of the memory decay model: `memory/meta.json`, one record per
 * item key — `{ weight, reviews, lastTouchedAt }`.
 *
 * Nothing here throws. A missing file, a truncated JSON body or a read-only
 * directory degrades to "no records" plus one warn line: the plugin is live 24/7
 * and a corrupted side file must never take a prompt assembly down with it. The
 * write is atomic (`meta.json.tmp` + rename) so a torn write can never leave a
 * half-parsed `meta.json` behind.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ITEM_WEIGHT } from './memory.js'

/** Schema version of `memory/meta.json`. */
export const META_VERSION = 1
/** The memory side directory, under the persona directory. */
export const MEMORY_DIR = 'memory'
/** Records file name inside {@link MEMORY_DIR}. */
export const META_FILE = 'meta.json'
/** Records file name of the decayed/fell-out-of-scope items. */
export const ITEM_ARCHIVE_FILE = 'archive.md'
/** Diary archive directory inside {@link MEMORY_DIR}. */
export const DIARY_ARCHIVE_DIR = 'archive'

/** Fallback sink: the host installs no logger service, so stderr is the record. */
function defaultLog(level, message) {
	if (level === 'warn') console.warn(message)
	else console.info(message)
}

/** Warn once per distinct condition per process, so a 24/7 plugin cannot flood. */
const WARNED = new Set()

function warnOnce(log, key, message) {
	if (WARNED.has(key)) return
	WARNED.add(key)
	;(typeof log === 'function' ? log : defaultLog)('warn', message)
}

function describe(error) {
	return String(error?.code ?? error?.message ?? error)
}

/** The persona directory's `memory/` subdirectory. */
export function memoryDir(dir) {
	return join(String(dir ?? ''), MEMORY_DIR)
}

/** Absolute path of `memory/meta.json`. */
export function metaPath(dir) {
	return join(memoryDir(dir), META_FILE)
}

/** An empty record set; also what every failure path returns. */
export function emptyMeta() {
	return { version: META_VERSION, items: {} }
}

function isRecord(value) {
	return value !== null && typeof value === 'object' && Array.isArray(value) !== true
}

/**
 * Read `memory/meta.json`.
 * @param dir - the persona directory.
 * @param options.log - `(level, message) => void`; one warn per bad file.
 * @returns `{ version, items }`; empty on a missing or corrupt file.
 */
export function readMeta(dir, { log = defaultLog } = {}) {
	const file = metaPath(dir)
	let raw
	try {
		raw = readFileSync(file, 'utf8')
	} catch (error) {
		warnOnce(log, `meta:read:${file}`, `qq-node: memory: ${file} is missing or unreadable (${describe(error)}); every item starts unrecorded`)
		return emptyMeta()
	}
	try {
		const parsed = JSON.parse(raw)
		return { version: META_VERSION, items: isRecord(parsed) && isRecord(parsed.items) ? parsed.items : {} }
	} catch (error) {
		warnOnce(log, `meta:parse:${file}`, `qq-node: memory: ${file} is not valid JSON (${describe(error)}); every item starts unrecorded`)
		return emptyMeta()
	}
}

/** Keep only the documented fields, so a bad caller cannot write `NaN` to disk. */
function sanitize(meta) {
	const source = isRecord(meta) && isRecord(meta.items) ? meta.items : {}
	const items = {}
	for (const [key, value] of Object.entries(source)) {
		if (typeof key !== 'string' || key === '' || !isRecord(value)) continue
		items[key] = {
			weight: Number.isFinite(value.weight) ? value.weight : DEFAULT_ITEM_WEIGHT,
			reviews: Number.isFinite(value.reviews) && value.reviews > 0 ? Math.floor(value.reviews) : 0,
			lastTouchedAt: Number.isFinite(value.lastTouchedAt) ? value.lastTouchedAt : 0,
			// 只做统计，不参与衰减：见 `touchItems` 的 `mode` 说明。
			injections: Number.isFinite(value.injections) && value.injections > 0 ? Math.floor(value.injections) : 0,
			lastInjectedAt: Number.isFinite(value.lastInjectedAt) ? value.lastInjectedAt : 0,
		}
	}
	return { version: META_VERSION, items }
}

/**
 * Write `memory/meta.json` atomically.
 * @param dir - the persona directory.
 * @param meta - `{ version, items }`; sanitized before it is written.
 * @param options.log - one warn on failure, never a throw.
 * @returns whether the file was replaced.
 */
export function writeMeta(dir, meta, { log = defaultLog } = {}) {
	const file = metaPath(dir)
	const tmp = `${file}.tmp`
	try {
		mkdirSync(memoryDir(dir), { recursive: true })
		writeFileSync(tmp, `${JSON.stringify(sanitize(meta), null, 2)}\n`, 'utf8')
		// rename is atomic on one volume: a reader sees the old file or the new one.
		renameSync(tmp, file)
		return true
	} catch (error) {
		warnOnce(log, `meta:write:${file}`, `qq-node: memory: cannot write ${file} (${describe(error)}); this turn keeps working without records`)
		return false
	}
}

/**
 * Touch items, either as a real reinforcement or as a mere injection.
 *
 * `mode: 'reinforce'` (the default) is what "she mentioned it again" means: a known
 * key gains one review, a fresh touch time and the larger of the two weights; an
 * unknown key is created with zero reviews.
 *
 * `mode: 'inject'` only counts the injection. Before 2026-11-01 every assembly
 * touched every injected item, so `reviews` measured *prompt assemblies* instead of
 * *repetitions by the user*: `stabilityDays = 2 ** reviews` hit its `MAX_REVIEWS`
 * cap within minutes and all 35 items became immortal (`archive.md` had one line).
 * The whole category was built on a wrong premise — retrieval is not rehearsal.
 * An injection therefore never creates a record and never moves `lastTouchedAt`;
 * an item nobody has confirmed keeps falling back to MEMORY.md's mtime.
 *
 * @param dir - the persona directory.
 * @param keys - one key or an array of keys.
 * @param options.nowMs - the touch time.
 * @param options.weight - the weight to raise the record to (never lowered).
 * @param options.mode - `'reinforce'` (default) or `'inject'`.
 * @param options.log - one warn on failure.
 * @returns the meta that was kept on disk (the in-memory copy when the write failed).
 */
export function touchItems(dir, keys, { nowMs = Date.now(), weight, mode = 'reinforce', log = defaultLog } = {}) {
	const meta = readMeta(dir, { log })
	const at = Number.isFinite(nowMs) ? nowMs : Date.now()
	const raised = Number.isFinite(weight) ? Number(weight) : undefined
	const injecting = mode === 'inject'
	let changed = false
	for (const key of Array.isArray(keys) ? keys : [keys]) {
		if (typeof key !== 'string' || key === '') continue
		const existing = meta.items[key]
		if (isRecord(existing)) {
			if (injecting) {
				existing.injections = (Number.isFinite(existing.injections) && existing.injections > 0 ? Math.floor(existing.injections) : 0) + 1
				existing.lastInjectedAt = at
			} else {
				existing.reviews = (Number.isFinite(existing.reviews) && existing.reviews > 0 ? Math.floor(existing.reviews) : 0) + 1
				existing.lastTouchedAt = at
				if (raised !== undefined) existing.weight = Math.max(Number.isFinite(existing.weight) ? existing.weight : 0, raised)
			}
		} else if (!injecting) {
			meta.items[key] = { weight: raised ?? DEFAULT_ITEM_WEIGHT, reviews: 0, lastTouchedAt: at, injections: 0, lastInjectedAt: 0 }
		} else {
			// 注入不建记录：没有记录的条目继续以 MEMORY.md 的 mtime 作为「上次想起」。
			continue
		}
		changed = true
	}
	if (changed) writeMeta(dir, meta, { log })
	return meta
}
