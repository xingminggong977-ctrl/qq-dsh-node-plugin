/**
 * The forgetting curve behind `lib/memory.js` and `lib/memory-store.js`.
 *
 * The arithmetic must actually decay, or "forgetting" is decoration; and a live
 * agent must not empty its own memory in one pass, so what falls out is archived
 * rather than dropped.
 *
 * 2026-11-01 修正：注入不是复习。此前每次装配都给每条注入项 `reviews += 1`，量到的
 * 是 prompt 装了多少次，于是 35 条全部永不遗忘、`archive.md` 只有一行。现在注入只记
 * `injections`，`reviews` / `lastTouchedAt` 只由真正的确认（remember、夜班合并）推进；
 * 记忆按 kind 分档，identity / rule 永不丢。
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DEFAULT_ITEM_WEIGHT,
	DEFAULT_MEMORY_LIMITS,
	MAX_REVIEWS,
	itemKey,
	normalizeText,
	readWeight,
	renderMemory,
	scoreItem,
	selectItems,
	splitMemoryItems,
} from '../lib/memory.js'
import { ITEM_ARCHIVE_FILE, MEMORY_DIR, META_FILE, memoryDir, metaPath, readMeta, touchItems, writeMeta } from '../lib/memory-store.js'
import { QqPersona, trackQqSession, untrackQqSession } from '../lib/persona.js'

const MS_PER_DAY = 86_400_000
const roots = []

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'qq-memory-'))
	roots.push(dir)
	return dir
}

after(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true })
	for (let n = 1; n <= sessionSeq; n += 1) untrackQqSession(`qq-mem-${n}`)
})

/** A persona directory holding the given MEMORY.md text. */
function personaDir(memory, { mtime } = {}) {
	const dir = tempDir()
	writeFileSync(join(dir, 'PERSONA.md'), '你是小D。\n')
	writeFileSync(join(dir, 'MEMORY.md'), memory)
	if (mtime !== undefined) utimesSync(join(dir, 'MEMORY.md'), new Date(mtime), new Date(mtime))
	mkdirSync(memoryDir(dir), { recursive: true })
	return dir
}

/** A context whose agent is a tracked QQ session — snapshot returns undefined otherwise. */
let sessionSeq = 0
function contextFor() {
	const id = `qq-mem-${++sessionSeq}`
	trackQqSession(id, true)
	return { agent: { session: { id } } }
}

const SAMPLE = `# 关于主人

- [w:5] 他叫主人，大号 10001

## 正在做的事

- [w:3] 小D 跑在阿里云 4 核 8 G 上
- [w:1] 昨天的鱼视频弹幕有 3513 条
`

test('memory 1 — the curve starts at the weight and only ever decays', () => {
	const meta = { weight: 4, reviews: 0, lastTouchedAt: 0 }
	const at = (days) => scoreItem(meta, days * MS_PER_DAY)
	assert.equal(at(0), 4, 'no elapsed time keeps the full weight')
	assert.ok(at(1) < at(0), 'one day is already less')
	assert.ok(at(3) < at(1), 'and three days is less than one')
	// 0 reviews means a one-day stability, so a single day costs ~63% of the score.
	assert.ok(Math.abs(at(1) - 4 * Math.exp(-1)) < 1e-9)
})

test('memory 2 — each rehearsal buys a longer stability, up to MAX_REVIEWS', () => {
	const at = (days, reviews) => scoreItem({ weight: 3, reviews, lastTouchedAt: 0 }, days * MS_PER_DAY)
	assert.ok(at(4, 3) > at(4, 1), 'more reviews decay slower')
	assert.ok(at(4, 1) > at(4, 0), 'one review already helps')
	// 2 ** 5 = 32 days is the ceiling: 6 and 40 rehearsals must score the same.
	assert.equal(at(10, MAX_REVIEWS), at(10, MAX_REVIEWS + 35))
})

test('memory 3 — splitting keeps the preamble and copes with three heading levels', () => {
	const { preamble, items } = splitMemoryItems(SAMPLE)
	assert.equal(preamble, '# 关于主人')
	assert.equal(items.length, 3)
	assert.equal(items[0].text, '[w:5] 他叫主人，大号 10001')
	assert.equal(items[2].text, '[w:1] 昨天的鱼视频弹幕有 3513 条')
	for (const item of items) assert.match(item.key, /^[0-9a-f]{16}$/)
})

test('memory 4 — render then split round-trips, multi-line items included', () => {
	const items = [
		{ key: itemKey('one line'), text: 'one line' },
		{ key: itemKey('first\nsecond'), text: 'first\nsecond' },
	]
	const { items: back } = splitMemoryItems(renderMemory({ preamble: '# 头', items }))
	assert.deepEqual(back.map((item) => item.text), ['one line', 'first\nsecond'])
	assert.deepEqual(back.map((item) => item.key), items.map((item) => item.key))
})

test('memory 5 — weight comes from the [w:N] prefix, defaulting to 3', () => {
	assert.equal(readWeight('[w:5] pinned'), 5)
	assert.equal(readWeight('[w:1] trivia'), 1)
	assert.equal(readWeight('no prefix at all'), DEFAULT_ITEM_WEIGHT)
	assert.equal(normalizeText('  a\r\n\r\n\r\nb  '), 'a\n\nb')
})

test('memory 6 — pinned items survive, the rest need to score, maxItems cuts the tail', () => {
	const items = splitMemoryItems(SAMPLE).items
	const now = 100 * MS_PER_DAY
	const fresh = now
	const keptIds = (options) =>
		selectItems(items, {}, { freshLastTouchedAt: fresh, ...options }, now).kept.map((item) => item.text)
	// Weight 5 is pinned: it is kept even when the clock has run far past it.
	const old = now - 4000 * MS_PER_DAY
	assert.ok(keptIds({ freshLastTouchedAt: old }).some((text) => text.startsWith('[w:5]')), 'pinned item survives')
	// Everything else in that scenario has decayed below the line.
	assert.equal(keptIds({ freshLastTouchedAt: old }).length, 1, 'only the pinned item is left')
	// Fresh items pass, and maxItems keeps the highest scorers.
	assert.equal(keptIds({}).length, 3)
	assert.deepEqual(keptIds({ maxItems: 1 }), ['[w:5] 他叫主人，大号 10001'])
	const cut = selectItems(items, {}, { maxItems: 1, freshLastTouchedAt: fresh }, now)
	assert.equal(cut.forgotten.length, 2, 'squeezed out counts as forgotten')
})

test('memory 7 — meta survives a corrupt file by degrading to empty, not by throwing', () => {
	const dir = tempDir()
	mkdirSync(memoryDir(dir), { recursive: true })
	writeFileSync(metaPath(dir), '{ this is not json')
	const warns = []
	const meta = readMeta(dir, { log: (_level, message) => warns.push(message) })
	assert.deepEqual(meta.items, {})
	assert.equal(warns.length, 1)
	assert.match(warns[0], /meta\.json/)
	// A missing file is not an error at all.
	assert.deepEqual(readMeta(tempDir()).items, {})
})

test('memory 8 — touchItems creates, then increments, and never lowers a weight', () => {
	const dir = tempDir()
	mkdirSync(memoryDir(dir), { recursive: true })
	touchItems(dir, ['k1', 'k2'], { nowMs: 1000, weight: 2 })
	let meta = readMeta(dir)
	assert.equal(meta.items.k1.reviews, 0)
	assert.equal(meta.items.k1.weight, 2)
	assert.equal(meta.items.k1.lastTouchedAt, 1000)
	touchItems(dir, 'k1', { nowMs: 2000, weight: 1 })
	meta = readMeta(dir)
	assert.equal(meta.items.k1.reviews, 1, 'a second touch is a rehearsal')
	assert.equal(meta.items.k1.lastTouchedAt, 2000)
	assert.equal(meta.items.k1.weight, 2, 'weight is raised, never lowered')
	// And the file on disk really is the meta that round-trips.
	writeMeta(dir, meta)
	assert.deepEqual(readMeta(dir), meta)
	assert.equal(join(dir, MEMORY_DIR, META_FILE), metaPath(dir))
})

test('memory 9 — injection is not rehearsal: two passes never move reviews, only injections', () => {
	// 2026-11-01 之前这里断言的是反面：每次装配都算一次复习，于是「复习次数」量的
	// 是 prompt 装了多少次。现在只有真正的确认才推进 `reviews` / `lastTouchedAt`。
	const dir = personaDir(SAMPLE, { mtime: Date.now() - 400 * MS_PER_DAY })
	const store = new QqPersona({ personaDir: dir, log: () => {} })
	const first = store.snapshot(contextFor())
	assert.match(first.memory.text, /他叫主人/, 'the pinned item is always there')
	// 一年没被确认过的两条（w3 / w1）该退场，但不能凭空消失。
	const archived = readFileSync(join(memoryDir(dir), ITEM_ARCHIVE_FILE), 'utf8')
	assert.match(archived, /弹幕/, 'a decayed item is archived, not silently dropped')
	assert.doesNotMatch(first.memory.text, /弹幕/)
	// 注入不建记录：`meta.json` 里不会凭空长出「复习过」的条目。
	assert.deepEqual(readMeta(dir).items, {}, 'injection never fabricates a rehearsal record')
	const second = store.snapshot(contextFor())
	assert.equal(second.memory.text, first.memory.text, 'the second pass injects the same memory')
})

test('memory 9b — a tagged item keeps its reviews across assemblies and only counts injections', () => {
	const dir = personaDir('# 关于主人\n\n- [w:3][k:note] 他喜欢在晚上写东西\n', { mtime: Date.now() - 40 * MS_PER_DAY })
	const key = itemKey('[w:3][k:note] 他喜欢在晚上写东西')
	writeMeta(dir, { version: 1, items: { [key]: { weight: 3, reviews: 1, lastTouchedAt: Date.now() - 40 * MS_PER_DAY } } })
	const store = new QqPersona({ personaDir: dir, log: () => {} })
	const first = store.snapshot(contextFor())
	assert.match(first.memory.text, /他喜欢在晚上写东西/, 'a 40-day-old note is still inside its 90-day base stability')
	store.snapshot(contextFor())
	const record = readMeta(dir).items[key]
	assert.equal(record.reviews, 1, 'assembling a prompt is not a repetition by him')
	assert.equal(record.injections, 2, 'injections are counted, and only counted')
	assert.ok(Date.now() - record.lastTouchedAt > 30 * MS_PER_DAY, 'lastTouchedAt stays where the last real confirmation put it')
})

test('memory 10 — memoryDecay: false is byte-for-byte the raw file', () => {
	const dir = personaDir(SAMPLE, { mtime: Date.now() - 400 * MS_PER_DAY })
	const store = new QqPersona({ personaDir: dir, memoryDecay: false, log: () => {} })
	const snapshot = store.snapshot(contextFor())
	assert.equal(snapshot.memory.text, SAMPLE)
	// And it must not have created any meta as a side effect.
	assert.deepEqual(readMeta(dir).items, {})
})

test('memory 11 — diary days past the window are archived by month, idempotently', () => {
	const dir = personaDir('# 关于主人\n\n- [w:5] 他叫主人\n')
	const diary = join(dir, 'diary')
	mkdirSync(diary, { recursive: true })
	// Nine days back, newest first on disk; only seven are injected.
	for (let back = 0; back < 9; back += 1) {
		const day = new Date(Date.UTC(2026, 9, 25 - back)).toISOString().slice(0, 10)
		writeFileSync(join(diary, `${day}.md`), `十月 ${day} 的事\n`)
	}
	const store = new QqPersona({ personaDir: dir, log: () => {} })
	store.snapshot(contextFor())
	const archive = join(memoryDir(dir), 'archive', '2026-10.md')
	const once = readFileSync(archive, 'utf8')
	assert.match(once, /## 2026-10-18/)
	assert.match(once, /## 2026-10-17/)
	assert.doesNotMatch(once, /## 2026-10-19/, 'a day still inside the window is not archived')
	// A second pass must not duplicate the blocks.
	store.snapshot(contextFor())
	assert.equal(readFileSync(archive, 'utf8'), once)
	// The diary files themselves are never removed; only seven days are injected.
	assert.equal(store.snapshot(contextFor()).days.length, 7)
})
