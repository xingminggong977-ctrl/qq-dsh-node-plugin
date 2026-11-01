import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeStub } from './bridge-stub.js'
import { createFakeRuntime } from './fake-runtime.js'
import { QqBridgeClient } from '../lib/bridge.js'
import { GROUP_HISTORY_FOOTER, GROUP_HISTORY_HEADER, GROUP_HISTORY_LIMIT } from '../lib/groups.js'
import { NON_OWNER_DENIAL, QqSessionStore } from '../lib/session.js'
import { QqNodeRunner } from '../lib/runner.js'

const BASE_OPTIONS = {
	pollWaitSeconds: 1,
	pollLimit: 2,
	maxConcurrentTurns: 2,
	turnTimeoutMs: 5000,
	idleRecycleMs: 6 * 60 * 60 * 1000,
	provider: '',
	model: '',
	reasoningEffort: '',
	maxTokens: 0,
	cwd: process.cwd(),
	nonOwnerPreset: 'qq-chat-only',
}

/** Group chat defaults shared by these tests; `nickname`/`mentioned`/`needsReply` vary per case. */
const GROUP_ID = '9001'
const GROUP_B_ID = '9002'
/** History/interjection key: one per group, deliberately without the userId. */
const GROUP_KEY = `qq:group:${GROUP_ID}`
const GROUP_B_KEY = `qq:group:${GROUP_B_ID}`

function groupTask(taskId, text, extra = {}) {
	return {
		taskId,
		kind: 'group',
		groupId: GROUP_ID,
		userId: '1001',
		nickname: '张三',
		text,
		isOwner: false,
		...extra,
	}
}

/** Bring up one node against a fresh stub bridge and fake runtime. */
async function boot({ reply, options = {} } = {}) {
	const lines = []
	const log = (level, message) => lines.push(`${level}: ${message}`)
	const stub = await new BridgeStub().start()
	const runtime = createFakeRuntime({ reply })
	const resolved = { ...BASE_OPTIONS, ...options }
	const client = new QqBridgeClient({ baseUrl: stub.url, token: stub.token })
	const store = new QqSessionStore({ ctx: runtime.ctx, options: resolved, client, log })
	const runner = new QqNodeRunner({ ctx: runtime.ctx, client, store, options: resolved, log })
	runner.start()
	return {
		stub,
		runtime,
		runner,
		store,
		lines,
		async stop() {
			await runner.stop()
			runtime.dispose()
			await stub.stop()
		},
	}
}

/** Wait until one task has both its status and its result recorded. */
async function settled(stub, taskId) {
	await stub.waitFor((instance) => instance.results.has(taskId) && instance.statuses.some((entry) => entry.taskId === taskId), {
		label: `settled ${taskId}`,
	})
}

/** The text block the most recent turn received. */
function lastTurnText(runtime) {
	const agent = [...runtime.agents.values()].at(-1)
	return agent?.lastMessage?.content?.find((block) => block.type === 'text')?.text ?? ''
}

const INTERJECTION_ON = { enabled: true, minIntervalMs: 20_000, maxPerMinute: 6, maxPerGroupPerDay: 100 }

test('protocol v2 — a needsReply:false group message runs no turn and answers empty text', async () => {
	const node = await boot({ reply: () => ({ text: '不该出现' }) })
	try {
		node.stub.queue(groupTask('c-1', '群里随便聊聊', { mentioned: false, needsReply: false }))
		await settled(node.stub, 'c-1')
		assert.deepEqual(node.stub.results.get('c-1'), { ok: true, text: '', error: null })
		assert.equal(node.runtime.stats.turnsStarted, 0, 'context-only message starts no turn')
		assert.equal(node.runtime.agents.size, 0, 'no agent session is even created')
		assert.deepEqual(node.stub.statuses.filter((entry) => entry.taskId === 'c-1'), [{ taskId: 'c-1', state: 'accepted' }])
		const entries = node.runner.groups.entries(GROUP_KEY)
		assert.deepEqual(entries.map((entry) => entry.text), ['群里随便聊聊'], 'it still enters the history buffer')
		assert.equal(entries[0].mentioned, false)
		assert.equal(entries[0].nickname, '张三')
		console.log('[v2 1] result =', JSON.stringify(node.stub.results.get('c-1')), '| turns =', node.runtime.stats.turnsStarted)
	} finally {
		await node.stop()
	}
})

test('protocol v2 — 25 context-only group messages leave the last 20 in the history', async () => {
	const node = await boot({ reply: () => ({ text: '我来了' }) })
	try {
		for (let index = 1; index <= 25; index += 1) {
			const label = `msg-${String(index).padStart(2, '0')}`
			node.stub.queue(groupTask(`h-${index}`, label, { mentioned: false, needsReply: false }))
		}
		await node.stub.waitFor((instance) => instance.results.size === 25, { label: '25 empty results', timeoutMs: 15_000 })
		assert.equal(node.runner.groups.size(GROUP_KEY), GROUP_HISTORY_LIMIT)
		assert.equal(node.runtime.stats.turnsStarted, 0, 'no context-only message ran a turn')

		node.stub.queue(groupTask('h-wake', '刚才聊什么呢', { mentioned: true, needsReply: true }))
		await settled(node.stub, 'h-wake')
		const text = lastTurnText(node.runtime)
		const lines = text.split('\n')
		assert.equal(lines[0], GROUP_HISTORY_HEADER)
		assert.equal(lines[1 + GROUP_HISTORY_LIMIT], GROUP_HISTORY_FOOTER)
		assert.equal(lines[2 + GROUP_HISTORY_LIMIT], '刚才聊什么呢', 'the current message follows the history block')
		const history = lines.slice(1, 1 + GROUP_HISTORY_LIMIT)
		assert.equal(history.length, GROUP_HISTORY_LIMIT, 'exactly 20 history lines')
		assert.ok(history[0].includes('msg-06'), `the oldest kept line is msg-06: ${history[0]}`)
		assert.ok(history.at(-1).includes('msg-25'))
		assert.ok(!text.includes('msg-01'), 'msg-01 was dropped')
		assert.ok(!text.includes('msg-05'), 'msg-05 was dropped')
		assert.equal(node.runtime.stats.turnsStarted, 1, 'only the mentioning message ran a turn')
		console.log('[v2 2] history lines =', history.length, '| oldest =', history[0], '| turns =', node.runtime.stats.turnsStarted)
	} finally {
		await node.stop()
	}
})

test('protocol v2 — a needsReply:true group message carries the earlier chatter into its turn', async () => {
	const node = await boot({ reply: () => ({ text: '算我一个' }) })
	try {
		node.stub.queue(groupTask('g-1', '今晚有人打游戏吗', { nickname: '李四', mentioned: false, needsReply: false }))
		await settled(node.stub, 'g-1')
		node.stub.queue(groupTask('g-2', '@bot 算我一个', { nickname: '张三', mentioned: true, needsReply: true }))
		await settled(node.stub, 'g-2')
		const text = lastTurnText(node.runtime)
		assert.ok(text.startsWith(GROUP_HISTORY_HEADER), `history block leads: ${JSON.stringify(text)}`)
		assert.ok(text.includes('[李四] 今晚有人打游戏吗'), 'the earlier non-@ message is part of the history')
		assert.ok(text.includes(GROUP_HISTORY_FOOTER), 'the history block is closed')
		assert.ok(text.endsWith('@bot 算我一个'), 'the current message follows the history')
		assert.equal(node.stub.results.get('g-2').text, '算我一个')
		assert.equal(node.runtime.stats.turnsStarted, 1, 'the context-only message still ran no turn')
		console.log('[v2 3] turn text =', JSON.stringify(text))
	} finally {
		await node.stop()
	}
})

test('protocol v2 — an old bridge that omits both new fields still runs the turn', async () => {
	const node = await boot({ reply: () => ({ text: '收到' }) })
	try {
		node.stub.queue({ taskId: 'old-1', kind: 'group', groupId: '9002', userId: '2002', nickname: '王五', text: '老 bridge 第一条' })
		await settled(node.stub, 'old-1')
		assert.deepEqual(node.stub.results.get('old-1'), { ok: true, text: '收到', error: null })
		assert.equal(node.runtime.stats.turnsStarted, 1, 'a task without needsReply runs the turn')
		assert.equal(lastTurnText(node.runtime), '老 bridge 第一条', 'the first message has no history yet')

		node.stub.queue({ taskId: 'old-2', kind: 'group', groupId: '9002', userId: '2002', nickname: '王五', text: '老 bridge 第二条' })
		await settled(node.stub, 'old-2')
		const text = lastTurnText(node.runtime)
		assert.ok(text.includes('@[王五] 老 bridge 第一条'), `mentioned defaults to true: ${JSON.stringify(text)}`)
		assert.ok(text.endsWith('老 bridge 第二条'))
		assert.deepEqual(node.stub.results.get('old-2'), { ok: true, text: '收到', error: null })
		assert.equal(node.runtime.stats.turnsStarted, 2)
		console.log('[v2 4] old-bridge turns =', node.runtime.stats.turnsStarted, '| second turn text =', JSON.stringify(text))
	} finally {
		await node.stop()
	}
})

test('protocol v2 — private chat is untouched: it always answers, even with needsReply:false', async () => {
	const node = await boot({ reply: () => ({ text: '私聊照旧' }) })
	try {
		node.stub.queue({ taskId: 'p-1', userId: '3003', text: '私聊一句', needsReply: false, mentioned: false })
		await settled(node.stub, 'p-1')
		assert.deepEqual(node.stub.results.get('p-1'), { ok: true, text: '私聊照旧', error: null })
		assert.equal(node.runtime.stats.turnsStarted, 1, 'private chat never becomes context-only')
		assert.equal(lastTurnText(node.runtime), '私聊一句', 'no history block in private chat')
		assert.equal(node.runner.groups.size('qq:private:-:3003'), 0, 'private chat is not buffered')
		console.log('[v2 8] private result =', JSON.stringify(node.stub.results.get('p-1')))
	} finally {
		await node.stop()
	}
})

test('protocol v2 — proactiveInterjection disabled runs no extra turn', async () => {
	const node = await boot({ reply: () => ({ text: '不该出现' }), options: { proactiveInterjection: { enabled: false } } })
	try {
		assert.equal(node.runner.interjection.enabled, false)
		node.stub.queue(groupTask('off-1', '甲', { mentioned: false, needsReply: false }))
		node.stub.queue(groupTask('off-2', '乙', { mentioned: false, needsReply: false }))
		node.stub.queue(groupTask('off-3', '丙', { mentioned: true, needsReply: true }))
		await settled(node.stub, 'off-3')
		await new Promise((resolve) => setTimeout(resolve, 300))
		assert.deepEqual(node.stub.results.get('off-1'), { ok: true, text: '', error: null })
		assert.deepEqual(node.stub.results.get('off-2'), { ok: true, text: '', error: null })
		assert.equal(node.runtime.stats.turnsStarted, 1, 'only the mentioning message ran a turn')
		console.log('[v2 5] turns =', node.runtime.stats.turnsStarted, '| results =', JSON.stringify([...node.stub.results.keys()]))
	} finally {
		await node.stop()
	}
})

test('protocol v2 — an enabled interjection may answer, and the interval blocks the next message', async () => {
	const node = await boot({ reply: () => ({ text: '我也在' }), options: { proactiveInterjection: { ...INTERJECTION_ON } } })
	try {
		node.stub.queue(groupTask('i-1', '有人吗', { nickname: '李四', mentioned: false, needsReply: false }))
		await settled(node.stub, 'i-1')
		assert.equal(node.runtime.stats.turnsStarted, 1, 'the interjection ran one turn')
		assert.equal(node.stub.results.get('i-1').text, '我也在')
		assert.ok(lastTurnText(node.runtime).endsWith('有人吗'))

		node.stub.queue(groupTask('i-2', '还是没人', { nickname: '李四', mentioned: false, needsReply: false }))
		await settled(node.stub, 'i-2')
		assert.deepEqual(node.stub.results.get('i-2'), { ok: true, text: '', error: null }, 'the interval refuses the second interjection')
		assert.equal(node.runtime.stats.turnsStarted, 1, 'no second turn within minIntervalMs')
		console.log('[v2 6] turns =', node.runtime.stats.turnsStarted, '| i-1 =', node.stub.results.get('i-1').text)
	} finally {
		await node.stop()
	}
})

test('protocol v2 — a silent interjection sends no QQ message', async () => {
	const reply = ({ message }) => {
		const text = message.content.find((block) => block.type === 'text')?.text ?? ''
		return { text: text.endsWith('请沉默') ? '[沉默]' : '' }
	}
	const node = await boot({ reply, options: { proactiveInterjection: { ...INTERJECTION_ON } } })
	try {
		node.stub.queue({ taskId: 's-1', kind: 'group', groupId: '9001', userId: '1', nickname: '张三', text: '请沉默', mentioned: false, needsReply: false })
		await settled(node.stub, 's-1')
		assert.equal(node.runtime.stats.turnsStarted, 1, 'the interjection ran')
		assert.deepEqual(node.stub.results.get('s-1'), { ok: true, text: '', error: null }, '[沉默] never reaches QQ')

		node.stub.queue({ taskId: 's-2', kind: 'group', groupId: '9003', userId: '2', nickname: '李四', text: '不说话', mentioned: false, needsReply: false })
		await settled(node.stub, 's-2')
		assert.equal(node.runtime.stats.turnsStarted, 2, 'the other group interjected too')
		assert.deepEqual(node.stub.results.get('s-2'), { ok: true, text: '', error: null }, 'an empty reply is silence, not a failure')
		console.log('[v2 7] turns =', node.runtime.stats.turnsStarted, '| results =', JSON.stringify([...node.stub.results.values()]))
	} finally {
		await node.stop()
	}
})

/** The text block one agent's turn received. */
function turnTextOf(agent) {
	return agent?.lastMessage?.content?.find((block) => block.type === 'text')?.text ?? ''
}

test('protocol v2 — 同群跨人共享前文：主人 说的话进入 群友A 的 turn', async () => {
	const node = await boot({ reply: () => ({ text: '收到' }) })
	try {
		node.stub.queue(groupTask('x-1', '今晚八点开黑，别迟到', { userId: '1001', nickname: '主人', mentioned: false, needsReply: false }))
		await settled(node.stub, 'x-1')
		node.stub.queue(groupTask('x-2', '@bot 开黑算我一个', { userId: '1002', nickname: '群友A', mentioned: true, needsReply: true }))
		await settled(node.stub, 'x-2')
		const text = lastTurnText(node.runtime)
		assert.ok(text.includes('[主人] 今晚八点开黑，别迟到'), `同群前文是整个群的，不是每人一段：${JSON.stringify(text)}`)
		assert.ok(text.startsWith(GROUP_HISTORY_HEADER), 'history block leads')
		assert.ok(text.endsWith('@bot 开黑算我一个'), 'the current message follows the history')
		assert.equal(node.runner.groups.size(GROUP_KEY), 2, '两个人在同一个群里共用一份缓冲')
		assert.equal(node.runtime.stats.turnsStarted, 1, 'context-only 的那条仍然不跑 turn')
		console.log('[v2 9] turn text =', JSON.stringify(text), '| buffer =', node.runner.groups.size(GROUP_KEY))
	} finally {
		await node.stop()
	}
})

test('protocol v2 — 不同群的前文互不串台', async () => {
	const node = await boot({ reply: () => ({ text: '收到' }) })
	try {
		node.stub.queue(groupTask('y-1', 'A 群：周末一起去爬山', { userId: '1001', nickname: '主人', mentioned: false, needsReply: false }))
		node.stub.queue(groupTask('y-2', 'B 群：周末一起打游戏', { groupId: GROUP_B_ID, userId: '2002', nickname: '李四', mentioned: false, needsReply: false }))
		await node.stub.waitFor((stub) => stub.results.has('y-1') && stub.results.has('y-2'), { label: 'two histories buffered' })

		node.stub.queue(groupTask('y-3', '@bot 爬山几点集合', { userId: '1002', nickname: '群友A', mentioned: true, needsReply: true }))
		await settled(node.stub, 'y-3')
		const text = lastTurnText(node.runtime)
		assert.ok(text.includes('[主人] A 群：周末一起去爬山'), `A 群的前文在：${JSON.stringify(text)}`)
		assert.ok(!text.includes('B 群：周末一起打游戏'), `B 群的话一条都不能漏进来：${JSON.stringify(text)}`)
		assert.ok(text.endsWith('@bot 爬山几点集合'))
		assert.equal(node.runner.groups.size(GROUP_KEY), 2, 'A 群只有 A 群的两条')
		assert.equal(node.runner.groups.size(GROUP_B_KEY), 1, 'B 群的缓冲没有被 A 群污染')
		console.log('[v2 10] A turn =', JSON.stringify(text), '| A buffer =', node.runner.groups.size(GROUP_KEY), '| B buffer =', node.runner.groups.size(GROUP_B_KEY))
	} finally {
		await node.stop()
	}
})

test('protocol v2 — 两个群并发 @ 时各自只看到自己群的前文', async () => {
	const seen = []
	const reply = ({ message }) => {
		const text = message?.content?.find((block) => block.type === 'text')?.text ?? ''
		seen.push(text)
		return { text: text.includes('A 群并发提问') ? 'A 群的答复' : 'B 群的答复', delayMs: 80 }
	}
	const node = await boot({ reply })
	try {
		node.stub.queue(groupTask('c-A1', 'A 群并发前文', { userId: '1002', nickname: '群友A', mentioned: false, needsReply: false }))
		node.stub.queue(groupTask('c-B1', 'B 群并发前文', { groupId: GROUP_B_ID, userId: '2001', nickname: '群友B', mentioned: false, needsReply: false }))
		await node.stub.waitFor((stub) => stub.results.has('c-A1') && stub.results.has('c-B1'), { label: 'both histories buffered' })

		node.stub.queue(groupTask('c-A2', '@bot A 群并发提问', { userId: '1001', nickname: '主人', mentioned: true, needsReply: true }))
		node.stub.queue(groupTask('c-B2', '@bot B 群并发提问', { groupId: GROUP_B_ID, userId: '2002', nickname: '李四', mentioned: true, needsReply: true }))
		await node.stub.waitFor((stub) => stub.results.has('c-A2') && stub.results.has('c-B2'), { label: 'both concurrent results' })

		assert.equal(seen.length, 2, '正好两次 turn')
		assert.equal(node.runtime.stats.peakActive, 2, '两次 turn 真的同时在跑')
		const turnA = seen.find((text) => text.includes('A 群并发提问'))
		const turnB = seen.find((text) => text.includes('B 群并发提问'))
		assert.ok(turnA.includes('A 群并发前文'), `A 的 turn 带着 A 群前文：${JSON.stringify(turnA)}`)
		assert.ok(!turnA.includes('B 群并发前文'), `A 的 turn 里不能有 B 群的话：${JSON.stringify(turnA)}`)
		assert.ok(turnB.includes('B 群并发前文'), `B 的 turn 带着 B 群前文：${JSON.stringify(turnB)}`)
		assert.ok(!turnB.includes('A 群并发前文'), `B 的 turn 里不能有 A 群的话：${JSON.stringify(turnB)}`)
		assert.equal(node.stub.results.get('c-A2').text, 'A 群的答复', '回复按 taskId 各归各的群')
		assert.equal(node.stub.results.get('c-B2').text, 'B 群的答复', '回复按 taskId 各归各的群')
		assert.equal(node.runner.groups.size(GROUP_KEY), 2)
		assert.equal(node.runner.groups.size(GROUP_B_KEY), 2)
		console.log('[v2 11] peakActive =', node.runtime.stats.peakActive, '| A =', JSON.stringify(turnA), '| B =', JSON.stringify(turnB))
	} finally {
		await node.stop()
	}
})

test('protocol v2 — 前文按群共享，会话仍按用户分开：owner 有工具，guest 零工具', async () => {
	const node = await boot({ reply: () => ({ text: '好' }) })
	try {
		node.stub.queue(groupTask('z-1', '@bot owner 说话', { userId: '1001', nickname: '主人', isOwner: true, mentioned: true, needsReply: true }))
		await settled(node.stub, 'z-1')
		node.stub.queue(groupTask('z-2', '@bot guest 说话', { userId: '1002', nickname: '群友A', isOwner: false, mentioned: true, needsReply: true }))
		await settled(node.stub, 'z-2')

		assert.equal(node.runtime.agents.size, 2, '一个群里两个人 = 两个 agent 会话（会话绝不合并）')
		const [owner, guest] = [...node.runtime.agents.values()]
		assert.notEqual(String(owner.session.id), String(guest.session.id), '两个会话的 sessionId 不同')
		assert.equal(node.runtime.toolsFor(guest).denyReason(), NON_OWNER_DENIAL, 'guest 会话零工具')
		assert.deepEqual(node.runtime.toolsFor(guest).restrictions, [{ allow: [] }], 'guest 会话的 allow 集为空')
		assert.equal(node.runtime.toolsFor(owner).denyReason(), undefined, 'owner 会话没有被降权')
		const guestText = turnTextOf(guest)
		assert.ok(guestText.includes('[主人] @bot owner 说话'), `前文跨 owner/guest 共享：${JSON.stringify(guestText)}`)
		console.log('[v2 12] sessions =', [...node.runtime.agents.values()].map((agent) => String(agent.session.id)).join(','), '| guest tools denied =', node.runtime.toolsFor(guest).denyReason())
	} finally {
		await node.stop()
	}
})
