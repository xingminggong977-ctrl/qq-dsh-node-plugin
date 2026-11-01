import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_MAX_TEXT, auditFileName, createAuditLog } from '../lib/audit.js'

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'qq-audit-'))
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** Read every audit line from one directory, parsed. */
function readLines(dir) {
	const lines = []
	for (const name of readdirSync(dir).sort()) {
		for (const raw of readFileSync(join(dir, name), 'utf8').split('\n')) {
			if (raw.trim() !== '') lines.push(JSON.parse(raw))
		}
	}
	return lines
}

test('audit: an empty dir disables recording and writes nothing', () => {
	const { dir, cleanup } = tempDir()
	try {
		const audit = createAuditLog({ dir: '' })
		assert.equal(audit.disabled, true)
		assert.equal(audit.record({ kind: 'private_reply', target: '1', text: 'hi' }), false)
		assert.deepEqual(readdirSync(dir), [])
	} finally {
		cleanup()
	}
})

test('audit: one JSON line per record, with every accountability field', () => {
	const { dir, cleanup } = tempDir()
	try {
		const audit = createAuditLog({ dir, now: () => new Date('2026-10-25T03:04:05.678Z') })
		assert.equal(audit.record({ kind: 'group_reply', target: '123456', text: '看这个', taskId: 't-1' }), true)
		const lines = readLines(dir)
		assert.equal(lines.length, 1)
		assert.deepEqual(lines[0], {
			at: '2026-10-25T03:04:05.678Z',
			kind: 'group_reply',
			ok: true,
			target: '123456',
			chars: 3,
			text: '看这个',
			taskId: 't-1',
		})
	} finally {
		cleanup()
	}
})

test('audit: records append instead of overwriting, and the month picks the file', () => {
	const { dir, cleanup } = tempDir()
	try {
		let clock = new Date('2026-10-31T23:00:00.000Z')
		const audit = createAuditLog({ dir, now: () => clock })
		audit.record({ kind: 'qzone_post', target: 'qzone', text: '十月' })
		clock = new Date('2026-11-01T01:00:00.000Z')
		audit.record({ kind: 'qzone_post', target: 'qzone', text: '十一月' })
		assert.deepEqual(readdirSync(dir).sort(), ['audit-2026-10.jsonl', 'audit-2026-11.jsonl'])
		const lines = readLines(dir)
		assert.deepEqual(lines.map((line) => line.text), ['十月', '十一月'])
	} finally {
		cleanup()
	}
})

test('audit: a long reply is truncated and marked, chars keeps the real length', () => {
	const { dir, cleanup } = tempDir()
	try {
		const audit = createAuditLog({ dir })
		const text = 'x'.repeat(AUDIT_MAX_TEXT + 50)
		audit.record({ kind: 'private_reply', target: '1', text })
		const [line] = readLines(dir)
		assert.equal(line.chars, AUDIT_MAX_TEXT + 50)
		assert.equal(line.text.length, AUDIT_MAX_TEXT)
		assert.equal(line.truncated, true)
	} finally {
		cleanup()
	}
})

test('audit: an unknown kind is kept as unknown rather than dropped', () => {
	const { dir, cleanup } = tempDir()
	try {
		const audit = createAuditLog({ dir })
		audit.record({ kind: 'telepathy', target: '1', text: '?' })
		const [line] = readLines(dir)
		assert.equal(line.kind, 'unknown')
	} finally {
		cleanup()
	}
})

test('audit: ok:false is preserved and taskId is omitted when absent', () => {
	const { dir, cleanup } = tempDir()
	try {
		const audit = createAuditLog({ dir })
		audit.record({ kind: 'qzone_delete', target: 'qzone', text: 'tid-9', ok: false })
		const [line] = readLines(dir)
		assert.equal(line.ok, false)
		assert.equal('taskId' in line, false)
	} finally {
		cleanup()
	}
})

test('audit: a write failure warns once, returns false, and never throws', () => {
	const { dir, cleanup } = tempDir()
	try {
		const warns = []
		const audit = createAuditLog({
			dir,
			log: (_level, message) => warns.push(message),
			write: () => {
				throw new Error('ENOSPC: no space left on device')
			},
		})
		assert.equal(audit.record({ kind: 'private_reply', target: '1', text: 'a' }), false)
		assert.equal(audit.record({ kind: 'private_reply', target: '1', text: 'b' }), false)
		assert.equal(warns.length, 1, 'the second failure must not warn again')
		assert.match(warns[0], /ENOSPC/)
	} finally {
		cleanup()
	}
})

test('audit: a relative dir is created on first write', () => {
	const { dir, cleanup } = tempDir()
	try {
		const audit = createAuditLog({ dir: join(dir, 'nested', 'deeper') })
		assert.equal(audit.record({ kind: 'private_reply', target: '1', text: 'hi' }), true)
		assert.equal(readLines(join(dir, 'nested', 'deeper')).length, 1)
	} finally {
		cleanup()
	}
})

test('audit: file names are UTC based', () => {
	assert.equal(auditFileName(new Date('2026-01-01T00:00:00.000Z')), 'audit-2026-01.jsonl')
	assert.equal(auditFileName(new Date('2026-12-31T23:59:59.000Z')), 'audit-2026-12.jsonl')
})
