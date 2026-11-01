import test from 'node:test'
import assert from 'node:assert/strict'
import {
	GROUP_HISTORY_FOOTER,
	GROUP_HISTORY_HEADER,
	GROUP_HISTORY_LIMIT,
	INTERJECTION_DEFAULTS,
	InterjectionGate,
	QqGroupBuffer,
	isGroupTask,
	mentionedOf,
	needsReplyOf,
} from '../lib/groups.js'

const KEY = 'qq:group:9001:1001'

test('groups — the ring buffer keeps the last 20 messages and drops the oldest', () => {
	const buffer = new QqGroupBuffer()
	for (let index = 1; index <= 25; index += 1) {
		buffer.record(KEY, { nickname: '张三', text: `msg-${String(index).padStart(2, '0')}`, mentioned: false, at: index })
	}
	assert.equal(GROUP_HISTORY_LIMIT, 20)
	assert.equal(buffer.limit, GROUP_HISTORY_LIMIT)
	assert.equal(buffer.size(KEY), GROUP_HISTORY_LIMIT)
	const entries = buffer.entries(KEY)
	assert.equal(entries[0].text, 'msg-06', 'the oldest five messages were dropped')
	assert.equal(entries.at(-1).text, 'msg-25')
	assert.deepEqual(Object.keys(entries[0]).sort(), ['at', 'mentioned', 'nickname', 'text'])
	assert.equal(buffer.size('qq:group:9002:1'), 0, 'another conversation key keeps its own buffer')
	console.log('[groups] kept =', entries.length, '| oldest =', entries[0].text, '| newest =', entries.at(-1).text)
})

test('groups — the history block marks @ messages and is empty until something is buffered', () => {
	const buffer = new QqGroupBuffer()
	assert.equal(buffer.format(KEY), '', 'no history for an empty buffer')
	buffer.record(KEY, { nickname: '张三', text: '大家好', mentioned: true, at: 1 })
	buffer.record(KEY, { nickname: '李四', text: '今天吃什么', mentioned: false, at: 2 })
	const lines = buffer.format(KEY).split('\n')
	assert.equal(lines[0], GROUP_HISTORY_HEADER)
	assert.equal(lines.at(-1), GROUP_HISTORY_FOOTER)
	assert.deepEqual(lines.slice(1, -1), ['@[张三] 大家好', '[李四] 今天吃什么'])
	assert.equal(buffer.format('qq:private:-:1001'), '')
	console.log('[groups] block =', JSON.stringify(buffer.format(KEY)))
})

test('groups — a missing protocol v2 field defaults to "yes"', () => {
	assert.equal(needsReplyOf({ taskId: 'x' }), true, 'an old bridge omitting needsReply still gets a reply')
	assert.equal(needsReplyOf({ needsReply: undefined }), true)
	assert.equal(needsReplyOf({ needsReply: false }), false)
	assert.equal(mentionedOf({ taskId: 'x' }), true)
	assert.equal(mentionedOf({ mentioned: false }), false)
	assert.equal(mentionedOf({ mentioned: 'false' }), true, 'only a real boolean false counts as "no"')
	assert.equal(isGroupTask({ kind: 'group', groupId: '9001' }), true)
	assert.equal(isGroupTask({ kind: 'private', groupId: null }), false)
	assert.equal(isGroupTask({}), false)
})

test('groups — the interjection gate enforces the interval and both quotas', () => {
	const interval = new InterjectionGate({ enabled: true, minIntervalMs: 20_000, maxPerMinute: 6, maxPerGroupPerDay: 100 })
	assert.equal(interval.tryTake('g1', 1_000), true)
	assert.equal(interval.tryTake('g1', 20_999), false, 'minIntervalMs is not reached')
	assert.equal(interval.tryTake('g1', 21_000), true, 'the interval is the gap since she last spoke')
	interval.noteSpoke('g1', 30_000)
	assert.equal(interval.tryTake('g1', 49_999), false, 'a required reply restarts the same interval')

	const minute = new InterjectionGate({ enabled: true, minIntervalMs: 1, maxPerMinute: 2, maxPerGroupPerDay: 100 })
	assert.equal(minute.tryTake('a', 0), true)
	assert.equal(minute.tryTake('b', 1), true)
	assert.equal(minute.tryTake('c', 2), false, 'maxPerMinute = 2 is spent across all groups')
	assert.equal(minute.tryTake('c', 60_001), true, 'the minute window rolls over')

	const day = new InterjectionGate({ enabled: true, minIntervalMs: 1, maxPerMinute: 100, maxPerGroupPerDay: 2 })
	assert.equal(day.tryTake('g', 0), true)
	assert.equal(day.tryTake('g', 10), true)
	assert.equal(day.tryTake('g', 20), false, 'maxPerGroupPerDay = 2 is spent')
	assert.equal(day.tryTake('other', 20), true, 'the day quota is per group')

	const off = new InterjectionGate({ enabled: false })
	assert.equal(off.tryTake('g1', 0), false, 'a disabled gate never takes a slot')
	assert.equal(off.allows('g1', 0), false)
	assert.deepEqual(off.limits, { ...INTERJECTION_DEFAULTS })
	assert.equal(off.enabled, false)
	console.log('[groups] gate limits =', JSON.stringify(off.limits))
})
