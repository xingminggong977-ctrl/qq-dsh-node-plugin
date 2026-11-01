import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldRotateSession } from '../lib/session.js'

test('session rotation — a short, recent conversation stays put', () => {
	const now = 1_000_000
	assert.equal(shouldRotateSession({ turns: 3, lastUsed: now - 60_000, now, maxTurns: 60, idleMs: 600_000 }), false)
})

test('session rotation — hitting the turn cap rotates even mid-conversation', () => {
	const now = 1_000_000
	assert.equal(shouldRotateSession({ turns: 60, lastUsed: now - 1_000, now, maxTurns: 60, idleMs: 600_000 }), true)
})

test('session rotation — a long silence rotates, because that is a topic break', () => {
	const now = 1_000_000
	assert.equal(shouldRotateSession({ turns: 2, lastUsed: now - 600_000, now, maxTurns: 60, idleMs: 600_000 }), true)
})

test('session rotation — never while a turn is in flight, or the replies cross over', () => {
	const now = 1_000_000
	assert.equal(shouldRotateSession({ turns: 999, lastUsed: now - 3_600_000, now, maxTurns: 60, idleMs: 600_000, busy: true }), false)
})

test('session rotation — zero disables the knob it belongs to', () => {
	const now = 1_000_000
	assert.equal(shouldRotateSession({ turns: 999, lastUsed: now - 86_400_000, now, maxTurns: 0, idleMs: 0 }), false)
	assert.equal(shouldRotateSession({ turns: 999, lastUsed: now - 86_400_000, now, maxTurns: 60, idleMs: 0 }), true)
	assert.equal(shouldRotateSession({ turns: 1, lastUsed: now - 86_400_000, now, maxTurns: 0, idleMs: 600_000 }), true)
})

test('session rotation — an entry that has never ended a turn is judged by its idle age only', () => {
	const now = 1_000_000
	assert.equal(shouldRotateSession({ lastUsed: now - 1_000, now, maxTurns: 60, idleMs: 600_000 }), false)
})
