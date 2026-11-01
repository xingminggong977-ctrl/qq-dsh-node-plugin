import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { QqPersona, trackQqSession } from '../lib/persona.js'

const roots = []
const contexts = []
let seq = 0

function contextFor() {
	const id = `qq-know-${++seq}`
	trackQqSession(id, true)
	contexts.push(id)
	return { agent: { session: { id } } }
}

function workspace({ persona = '# 人格\n', memory = '# 记忆\n\n- 一条\n', notes = {} } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'qq-know-'))
	roots.push(dir)
	if (persona !== null) writeFileSync(join(dir, 'PERSONA.md'), persona)
	if (memory !== null) writeFileSync(join(dir, 'MEMORY.md'), memory)
	if (Object.keys(notes).length > 0) {
		mkdirSync(join(dir, 'knowledge'), { recursive: true })
		for (const [name, body] of Object.entries(notes)) writeFileSync(join(dir, 'knowledge', name), body)
	}
	return dir
}

test('knowledge — her own notes are actually read back into the prompt', () => {
	const dir = workspace({
		notes: {
			'a-landlock.md': '# 沙箱只关了一半\n\nLandlock ABI 1 不管 TRUNCATE。\n',
		},
	})
	const snapshot = new QqPersona({ personaDir: dir, log: () => {} }).snapshot(contextFor())

	assert.match(snapshot.text, /## 我记下的笔记/)
	assert.match(snapshot.text, /Landlock ABI 1 不管 TRUNCATE/)
	// 笔记排在记忆之后：记忆是她说过的，笔记是学来的。
	assert.ok(snapshot.text.indexOf('## 长期记忆') < snapshot.text.indexOf('## 我记下的笔记'))
})

test('knowledge — a note bigger than the budget is skipped whole, never half', () => {
	const dir = workspace({
		notes: {
			'small.md': '# 小笔记\n\n短。\n',
			'huge.md': `# 大笔记\n\n${'很长的正文。'.repeat(800)}`,
		},
	})
	const snapshot = new QqPersona({ personaDir: dir, log: () => {} }).snapshot(contextFor())

	assert.match(snapshot.text, /短。/)
	assert.ok(!snapshot.text.includes('很长的正文。'), 'an oversized note must not be half-injected')
})

test('knowledge — a missing directory is silent and changes nothing', () => {
	const dir = workspace({ notes: {} })
	const person = new QqPersona({ personaDir: dir, log: () => {} })
	const snapshot = person.snapshot(contextFor())

	assert.ok(!snapshot.text.includes('## 我记下的笔记'))
	assert.match(snapshot.text, /## 长期记忆/)
})

test('knowledge — nothing tracked means nothing to report', () => {
	const dir = workspace({ notes: { 'a.md': '# 甲\n\n乙。\n' } })
	assert.equal(new QqPersona({ personaDir: dir, log: () => {} }).snapshot({}), undefined)
})

test('knowledge — temp dirs are cleaned up', () => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
	for (const id of contexts.splice(0)) trackQqSession(id, false)
	assert.equal(roots.length, 0)
})
