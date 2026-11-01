import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeStub, STUB_TOKEN } from './bridge-stub.js'
import { createFakeRuntime } from './fake-runtime.js'
import { QqBridgeClient } from '../lib/bridge.js'
import { NON_OWNER_DENIAL, NON_OWNER_RULES, QqSessionStore, sessionKeyOf } from '../lib/session.js'
import { QqNodeRunner } from '../lib/runner.js'
import { apply, resolveOptions } from '../index.js'

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

test('acceptance 1 — poll delivers a task, a session runs it, the reply is submitted', async () => {
	const node = await boot({ reply: () => ({ text: '你好，我是 QQ 侧的 DSH。' }) })
	try {
		node.stub.queue({ taskId: 't-1', userId: '1001', text: '你好' })
		await node.stub.waitFor((stub) => stub.results.has('t-1'), { label: 'result t-1' })
		const result = node.stub.results.get('t-1')
		assert.deepEqual(result, { ok: true, text: '你好，我是 QQ 侧的 DSH。', error: null })
		assert.deepEqual(node.stub.statuses.filter((entry) => entry.taskId === 't-1'), [
			{ taskId: 't-1', state: 'accepted' },
			{ taskId: 't-1', state: 'running' },
		])
		assert.equal(sessionKeyOf({ kind: 'private', groupId: null, userId: '1001' }), 'qq:private:-:1001')
		const [agent] = [...node.runtime.agents.values()]
		assert.match(String(agent.options.sessionId), /^qq-[0-9a-f-]{36}$/)
		assert.equal(agent.lastMessage.source.kind, 'user')
		// 陌生人会话的第一轮会多出一块「守则」，那是刻意的；这里只关心消息本身原样到达。
		assert.deepEqual(
			agent.lastMessage.content.filter((block) => block.text !== NON_OWNER_RULES),
			[{ type: 'text', text: '你好' }],
		)
		assert.equal(agent.lastMessage.content.at(-1).text, NON_OWNER_RULES)
		assert.match(node.stub.requestsTo('/node/poll')[0].query, /wait=1/, 'poll carries the configured wait')
		assert.equal(node.stub.requestsTo('/node/poll')[0].authorization, `Bearer ${STUB_TOKEN}`)
		console.log('[1] result =', JSON.stringify(result), '| statuses =', JSON.stringify(node.stub.statuses))
	} finally {
		await node.stop()
	}
})

test('acceptance 2 — same conversation serializes, distinct conversations reach the global cap of 2', async () => {
	const node = await boot({ reply: () => ({ text: 'ok', delayMs: 60 }) })
	try {
		node.stub.queue({ taskId: 's-1', userId: '2001', text: 'first' })
		node.stub.queue({ taskId: 's-2', userId: '2001', text: 'second' })
		await node.stub.waitFor((stub) => stub.results.size === 2, { label: 'two serialized results' })
		assert.deepEqual(node.runtime.stats.overlap, [], 'no two turns of one conversation overlap')
		assert.equal(node.runtime.agents.size, 1, 'one agent session serves the whole conversation')
		assert.equal(node.runtime.stats.peakActive, 1, 'serialized turns never run together')
		const [agent] = [...node.runtime.agents.values()]
		assert.equal(agent.turnCount, 2, 'both tasks ran on the same session')

		const wide = await boot({ reply: () => ({ text: 'ok', delayMs: 120 }) })
		try {
			wide.stub.queue({ taskId: 'p-1', userId: '3001' })
			wide.stub.queue({ taskId: 'p-2', userId: '3002' })
			wide.stub.queue({ taskId: 'p-3', userId: '3003' })
			await wide.stub.waitFor((stub) => stub.results.size === 3, { label: 'three parallel results' })
			assert.equal(wide.runtime.stats.peakActive, 2, 'global cap holds at maxConcurrentTurns = 2')
			assert.equal(wide.runtime.agents.size, 3, 'each conversation gets its own session')
		} finally {
			await wide.stop()
		}
		console.log('[2] serial peakActive = 1 | wide peakActive = 2 | sessions =', node.runtime.agents.size)
	} finally {
		await node.stop()
	}
})

test('acceptance 3 — a turn past its timeout reports ok:false and "turn timeout"', async () => {
	// 收尾那一轮关掉：这条验的是「一句话都没留下」时的超时上报，
	// 带收尾的那条路在 turn-timeout.test.js 里单独验。
	const node = await boot({ reply: () => ({ hang: true }), options: { turnTimeoutMs: 150, wrapUpOnTimeout: false } })
	try {
		node.stub.queue({ taskId: 'x-1', userId: '4001', text: 'slow' })
		await node.stub.waitFor((stub) => stub.results.has('x-1'), { label: 'timeout result' })
		assert.deepEqual(node.stub.results.get('x-1'), { ok: false, text: '', error: 'turn timeout' })
		const [agent] = [...node.runtime.agents.values()]
		assert.equal(agent.pending, undefined, 'the timed-out turn was cancelled')
		console.log('[3] result =', JSON.stringify(node.stub.results.get('x-1')))
	} finally {
		await node.stop()
	}
})

test('acceptance 4 — a repeated taskId is executed once', async () => {
	const node = await boot({ reply: () => ({ text: 'once' }) })
	try {
		const task = { taskId: 'd-1', userId: '5001', text: 'only once' }
		node.stub.queue(task)
		node.stub.queue(task)
		await node.stub.waitFor((stub) => stub.results.has('d-1'), { label: 'deduped result' })
		await new Promise((resolve) => setTimeout(resolve, 250))
		assert.equal(node.runtime.stats.turnsStarted, 1, 'the duplicate taskId started no second turn')
		assert.equal(node.stub.results.size, 1)
		assert.equal(node.stub.results.get('d-1').text, 'once')
		console.log('[4] turnsStarted =', node.runtime.stats.turnsStarted, '| results =', node.stub.results.size)
	} finally {
		await node.stop()
	}
})

test('acceptance 5 — a non-owner session gets the tool guard and an empty allow set', async () => {
	const node = await boot({ reply: () => ({ text: 'chat only' }) })
	try {
		node.stub.queue({ taskId: 'o-1', userId: '6001', isOwner: true, text: 'owner' })
		node.stub.queue({ taskId: 'n-1', userId: '6002', isOwner: false, text: 'guest' })
		await node.stub.waitFor((stub) => stub.results.size === 2, { label: 'both results' })
		const owner = [...node.runtime.agents.values()].find((agent) => agent.options.meta.agentPreset === undefined)
		const guest = [...node.runtime.agents.values()].find((agent) => agent.options.meta.agentPreset !== undefined)
		assert.equal(guest.options.meta.agentPreset, 'qq-chat-only')
		assert.equal(owner.options.setup, undefined, 'an owner session installs no lockdown')
		const ownerTools = node.runtime.toolsFor(owner)
		const guestTools = node.runtime.toolsFor(guest)
		assert.deepEqual(ownerTools.guards, [], 'owner keeps the default tool surface')
		assert.deepEqual(ownerTools.restrictions, [])
		assert.equal(guestTools.guards.length, 1, 'non-owner registers exactly one guard')
		assert.deepEqual(guestTools.restrictions, [{ allow: [] }], 'non-owner inherits zero tools')
		assert.equal(guestTools.denyReason(), NON_OWNER_DENIAL, 'the guard denies a bash call')
		console.log('[5] non-owner restrictions =', JSON.stringify(guestTools.restrictions), '| denial =', guestTools.denyReason())
	} finally {
		await node.stop()
	}
})

test('acceptance 6 — the loop survives an unreachable bridge and resumes on reconnect', async () => {
	const staging = await new BridgeStub().start()
	const port = staging.port
	await staging.stop()
	const runtime = createFakeRuntime({ reply: () => ({ text: 'reconnected' }) })
	const lines = []
	const log = (level, message) => lines.push(`${level}: ${message}`)
	const client = new QqBridgeClient({ baseUrl: `http://127.0.0.1:${port}`, token: STUB_TOKEN })
	const store = new QqSessionStore({ ctx: runtime.ctx, options: BASE_OPTIONS, client, log })
	const runner = new QqNodeRunner({ ctx: runtime.ctx, client, store, options: BASE_OPTIONS, log })
	runner.start()
	let stub
	try {
		await new Promise((resolve) => setTimeout(resolve, 1500))
		assert.ok(
			lines.some((line) => line.startsWith('warn: qq-node: bridge GET /node/poll')),
			`the outage was logged: ${JSON.stringify(lines.slice(0, 3))}`,
		)
		stub = await new BridgeStub().start({ port })
		stub.queue({ taskId: 'r-1', userId: '7001', text: 'back?' })
		await stub.waitFor((instance) => instance.results.has('r-1'), { label: 'result after reconnect', timeoutMs: 15_000 })
		assert.equal(stub.results.get('r-1').text, 'reconnected')
		assert.ok(lines.some((line) => line.includes('bridge reachable again')), 'recovery is logged')
		console.log('[6] outage logged = true | recovered =', JSON.stringify(stub.results.get('r-1')))
	} finally {
		await runner.stop()
		runtime.dispose()
		await stub?.stop()
	}
})

test('acceptance 7 — the plugin wiring starts the runner through ctx.effect and stops it on dispose', async () => {
	const stub = await new BridgeStub().start()
	const runtime = createFakeRuntime({ reply: () => ({ text: 'wired' }) })
	const effects = []
	const ctx = { ...runtime.ctx, effect: (fn, label) => (effects.push(label), runtime.ctx.effect(fn, label)) }
	try {
		// auditDir off on purpose: without it the default lands next to persona/,
		// and this test would write into a real audit log. The sink itself is
		// covered by audit-wiring.test.js.
		apply(ctx, { bridgeUrl: stub.url, nodeToken: STUB_TOKEN, pollWaitSeconds: 1, auditDir: '' })
		assert.deepEqual(effects, ['qq-node.runner'])
		stub.queue({ taskId: 'w-1', userId: '8001', text: 'wired?' })
		await stub.waitFor((instance) => instance.results.has('w-1'), { label: 'wired result' })
		assert.equal(stub.results.get('w-1').text, 'wired')
		runtime.dispose()
		const before = stub.requestsTo('/node/poll').length
		await new Promise((resolve) => setTimeout(resolve, 1200))
		assert.equal(stub.requestsTo('/node/poll').length, before, 'dispose stopped the poll loop')
		console.log('[7] effects =', JSON.stringify(effects), '| result =', JSON.stringify(stub.results.get('w-1')))
	} finally {
		await stub.stop()
	}
})

test('acceptance 8 — a second message after the turn cap lands in a brand-new session', async () => {
	// 让她把 session id 原样回出来：这样「是不是真的换了会话」是证据，不是推测。
	const sessions = []
	const node = await boot({
		reply: (context) => {
			sessions.push(String(context.sessionId))
			return { text: String(context.sessionId) }
		},
		options: { sessionMaxTurns: 1, sessionRotateAfterIdleMs: 0 },
	})
	try {
		node.stub.queue({ taskId: 'rot-1', userId: '9001', text: 'first' })
		await node.stub.waitFor((instance) => instance.results.has('rot-1'), { label: 'first reply' })

		node.stub.queue({ taskId: 'rot-2', userId: '9001', text: 'second' })
		await node.stub.waitFor((instance) => instance.results.has('rot-2'), { label: 'second reply' })

		assert.equal(sessions.length, 2, `两轮都跑过了：${JSON.stringify(sessions)}`)
		assert.notEqual(sessions[1], sessions[0], '第二轮应该落在一个新会话里')
		assert.equal(node.stub.results.get('rot-2').text, sessions[1], '轮转之后她照样回得上话')

		const recycled = node.lines.filter((line) => line.includes('recycled session') && line.includes('after 1 turn(s)'))
		assert.equal(recycled.length, 1, `轮转没有被触发：${JSON.stringify(node.lines.slice(-6))}`)
		assert.equal(node.store.size, 1, '旧会话被换掉，只剩一个新会话')
		console.log('[8] sessions =', sessions.length, '| distinct =', sessions[0] !== sessions[1])
	} finally {
		await node.stop()
	}
})

test('acceptance 9 — private bursts within the window become one turn, and every taskId is settled', async () => {
	const messages = []
	const node = await boot({
		reply: (context) => {
			messages.push(context.message)
			return { text: '收到' }
		},
		// pollLimit 提到 5：默认的 2 会把三条拆成两次轮询，第三条可能在窗口关上之后才到，
		// 那样测的就不是攒批、而是轮询时序了。
		options: { batchWindowMs: 800, pollLimit: 5 },
	})
	try {
		node.stub.queue({ taskId: 'bat-1', userId: '9101', text: '在吗' })
		node.stub.queue({ taskId: 'bat-2', userId: '9101', text: '睡了吗' })
		node.stub.queue({ taskId: 'bat-3', userId: '9101', text: '跟你说个事' })
		await node.stub.waitFor((instance) => ['bat-1', 'bat-2', 'bat-3'].every((id) => instance.results.has(id)), { label: 'batched reply and both absorbed results' })

		assert.equal(messages.length, 1, `三轮都跑了就说明没攒批：${JSON.stringify(messages)}`)
		const said = JSON.stringify(messages[0])
		for (const line of ['在吗', '睡了吗', '跟你说个事']) assert.ok(said.includes(line), `合并后的这一轮应该带上「${line}」：${said}`)
		assert.equal(node.stub.results.get('bat-3').text, '收到', '正文随最后一条发出')
		// 被并掉的两条也要各有一个结果，否则 bridge 会一直等这两条。
		for (const taskId of ['bat-1', 'bat-2']) {
			assert.equal(node.stub.results.get(taskId)?.text, '', `${taskId} 应该被结成一个空结果`)
		}
		console.log('[9] turns =', messages.length, '| settled =', [...node.stub.results.keys()].filter((id) => id.startsWith('bat-')).join(','))
	} finally {
		await node.stop()
	}
})

test('acceptance 10 — group messages never batch, even inside the window', async () => {
	const messages = []
	const node = await boot({
		reply: (context) => {
			messages.push(context.message)
			return { text: '嗯' }
		},
		options: { batchWindowMs: 400 },
	})
	try {
		node.stub.queue({ taskId: 'grp-1', groupId: '5551', userId: '7101', nickname: '甲', text: '今天谁在', mentioned: true })
		node.stub.queue({ taskId: 'grp-2', groupId: '5551', userId: '7102', nickname: '乙', text: '我在', mentioned: true })
		await node.stub.waitFor((instance) => instance.results.has('grp-2'), { label: 'second group reply' })
		assert.equal(messages.length, 2, '群里两条消息应该是两轮')
		console.log('[10] group turns =', messages.length)
	} finally {
		await node.stop()
	}
})

test('protocol caps — options are clamped to the v1 limits', () => {
	const options = resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787/', pollWaitSeconds: 99, pollLimit: 99, nodeToken: 'x' })
	assert.equal(options.bridgeUrl, 'http://127.0.0.1:8787')
	assert.equal(options.pollWaitSeconds, 30)
	assert.equal(options.pollLimit, 5)
	assert.throws(() => resolveOptions({ bridgeUrl: 'ftp://nope' }), /http\(s\) URL/)
})
