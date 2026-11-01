import test from 'node:test'
import assert from 'node:assert/strict'
import { BridgeStub } from './bridge-stub.js'
import { createFakeRuntime } from './fake-runtime.js'
import { QqBridgeClient } from '../lib/bridge.js'
import { QqSessionStore } from '../lib/session.js'
import { QqNodeRunner } from '../lib/runner.js'

const BASE_OPTIONS = {
	pollWaitSeconds: 1,
	pollLimit: 2,
	maxConcurrentTurns: 2,
	turnTimeoutMs: 5_000,
	wrapUpOnTimeout: false,
	earlyReplyMs: 40,
	idleRecycleMs: 6 * 60 * 60 * 1000,
	provider: '',
	model: '',
	reasoningEffort: '',
	maxTokens: 0,
	cwd: process.cwd(),
	nonOwnerPreset: 'qq-chat-only',
}

function ownerTask(taskId, text) {
	return { taskId, kind: 'private', userId: '10001', nickname: '主人', text, images: [], isOwner: true, needsReply: true }
}

async function boot({ reply, options = {} }) {
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
		lines,
		async stop() {
			await runner.stop()
			runtime.dispose()
			await stub.stop()
		},
	}
}

async function settled(stub, taskId) {
	// 默认 5 秒的等待窗口和 `turnTimeoutMs` 撞在一起会把「超时那条路」测成假失败。
	await stub.waitFor((instance) => instance.results.has(taskId), { timeoutMs: 15_000, label: `settled ${taskId}` })
}

test('the half-finished sentence goes out before the turn ends, and only the rest follows', async () => {
	// 第一句在 2 毫秒就到，第二句要再等 160 毫秒；早发的窗口在 40 毫秒。
	const node = await boot({
		reply: () => ({ texts: ['我先看了一眼那张截图。', '看完了，是个表格，第四行有问题。'], textDelayMs: 160 }),
	})
	try {
		node.stub.queue(ownerTask('t-early', '看看我发的这张图'))
		await settled(node.stub, 't-early')
		assert.deepEqual(
			node.stub.sentTexts.map((entry) => entry.text),
			['我先看了一眼那张截图。'],
			'先发出去的是她自己已经说出口的那一句',
		)
		const result = node.stub.results.get('t-early')
		assert.equal(result.ok, true)
		assert.equal(result.text, '看完了，是个表格，第四行有问题。', '结果里只剩还没说过的那部分，不重复第一句')
		assert.ok(node.lines.some((line) => line.includes('sent the first sentence early')), '日志要看得出走的是早发那条路')
	} finally {
		await node.stop()
	}
})

test('a turn that finishes before the window says everything at once', async () => {
	const node = await boot({ reply: () => ({ text: '好呀，我在。' }), options: { earlyReplyMs: 400 } })
	try {
		node.stub.queue(ownerTask('t-quick', '在吗'))
		await settled(node.stub, 't-quick')
		assert.deepEqual(node.stub.sentTexts, [], '短回合不该多发一条')
		assert.equal(node.stub.results.get('t-quick').text, '好呀，我在。')
	} finally {
		await node.stop()
	}
})

test('a turn that hangs after the early sentence does not repeat it on timeout', async () => {
	const node = await boot({
		reply: () => ({ texts: ['我在做那个 PPT。'], hangAfterTexts: true }),
		options: { turnTimeoutMs: 800 },
	})
	try {
		node.stub.queue(ownerTask('t-early-hang', '做个防诈骗ppt'))
		await settled(node.stub, 't-early-hang')
		assert.deepEqual(node.stub.sentTexts.map((entry) => entry.text), ['我在做那个 PPT。'])
		const result = node.stub.results.get('t-early-hang')
		assert.equal(result.ok, true, '她说过话，这一轮不算失败')
		assert.equal(result.text, '', '同一句不再补一遍')
		assert.ok(node.lines.some((line) => line.includes('stopped after the early reply')))
	} finally {
		await node.stop()
	}
})

test('only the owner private turn sends early: a group task never does', async () => {
	const node = await boot({
		reply: () => ({ texts: ['群里先应一声。'], textDelayMs: 160 }),
	})
	try {
		node.stub.queue({ ...ownerTask('t-group', '群里看看'), groupId: '555', kind: 'group', isOwner: true })
		await settled(node.stub, 't-group')
		assert.deepEqual(node.stub.sentTexts, [], '群聊不该收到半截回复')
		assert.equal(node.stub.results.get('t-group').text, '群里先应一声。')
	} finally {
		await node.stop()
	}
})

test('a finished sentence goes out as soon as it exists, not at the deadline', async () => {
	// 早发窗口 5 秒，但「说完了」的门槛只有 120 毫秒：第一句 60 毫秒就到、带句号。
	const node = await boot({
		reply: () => ({ texts: ['我先把手头这个跑完，你看要不要等。', '跑完了，结果是 42。'], textDelayMs: 400 }),
		options: { earlyReplyMs: 5_000, earlyReplyMinMs: 120, earlyTickMs: 50, turnTimeoutMs: 3_000 },
	})
	try {
		const startedAt = Date.now()
		node.stub.queue(ownerTask('t-sentence', '那个跑完了吗'))
		await settled(node.stub, 't-sentence')
		assert.deepEqual(
			node.stub.sentTexts.map((entry) => entry.text),
			['我先把手头这个跑完，你看要不要等。'],
			'说到一句完整的话就先发出去',
		)
		assert.ok(Date.now() - startedAt < 2_500, '不必等到 earlyReplyMs 才开口')
		assert.equal(node.stub.results.get('t-sentence').text, '跑完了，结果是 42。')
	} finally {
		await node.stop()
	}
})

test('half a sentence never goes out on its own', async () => {
	// 只有半句（没有句末标点、也不够长），而且这一轮后来卡住了：宁可不早发，也不能把半截话甩出去。
	const node = await boot({
		reply: () => ({ texts: ['我看看这个'], hangAfterTexts: true }),
		options: { earlyReplyMs: 5_000, earlyReplyMinMs: 100, earlyTickMs: 40, turnTimeoutMs: 900 },
	})
	try {
		node.stub.queue(ownerTask('t-half', '看下这个'))
		await settled(node.stub, 't-half')
		assert.deepEqual(node.stub.sentTexts, [], '没说完的半句不发')
		assert.ok(node.stub.results.get('t-half').text.startsWith('我看看这个'), '超时后仍然把她说过的这句带回去')
	} finally {
		await node.stop()
	}
})