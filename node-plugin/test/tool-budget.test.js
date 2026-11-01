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
	turnTimeoutMs: 10_000,
	wrapUpMs: 120,
	toolCallBudget: 3,
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
	await stub.waitFor((instance) => instance.results.has(taskId), { timeoutMs: 15_000, label: `settled ${taskId}` })
}

test('a turn that keeps calling tools is wrapped up at the budget instead of running to the wall', async () => {
	// 第一轮：一直调工具（远超 3 次预算）；收尾那一轮只说话。
	const node = await boot({
		reply: ({ turn }) => (turn === 1 ? { toolCalls: 9, toolDelayMs: 20, text: '还在装依赖' } : { text: '装好了，PPT 在 /opt/ppt/防诈骗.pptx。' }),
	})
	try {
		node.stub.queue(ownerTask('t-budget', '做个防诈骗的ppt'))
		await settled(node.stub, 't-budget')
		const result = node.stub.results.get('t-budget')
		assert.equal(result.ok, true, '到预算不是失败，是「说到这一步了」')
		assert.match(result.text, /防诈骗\.pptx/, '收尾那一轮的结果要送到')
		assert.ok(node.lines.some((line) => line.includes('used up its tool budget')), '日志要看得出是工具预算停的')
		assert.ok(
			node.lines.some((line) => line.includes('the turn already made 3 tool calls')),
			'预算到点时按实际次数记账',
		)
	} finally {
		await node.stop()
	}
})

test('without the budget a tool-heavy turn just runs to its own end', async () => {
	const node = await boot({
		reply: () => ({ toolCalls: 9, toolDelayMs: 5, text: '弄完了。' }),
		options: { toolCallBudget: 0 },
	})
	try {
		node.stub.queue(ownerTask('t-nobudget', '随便跑跑'))
		await settled(node.stub, 't-nobudget')
		assert.equal(node.stub.results.get('t-nobudget').text, '弄完了。')
		assert.ok(!node.lines.some((line) => line.includes('tool budget')), '关掉之后不该有这条日志')
	} finally {
		await node.stop()
	}
})

test('a budget stop keeps what she already said when the wrap-up says nothing', async () => {
	const node = await boot({
		reply: ({ turn }) =>
			turn === 1
				? { preTexts: ['我先把依赖装上，再生成。'], toolCalls: 9, toolDelayMs: 20 }
				: { hang: true },
	})
	try {
		node.stub.queue(ownerTask('t-budget-partial', '做那个ppt'))
		await settled(node.stub, 't-budget-partial')
		const result = node.stub.results.get('t-budget-partial')
		assert.equal(result.ok, true)
		assert.match(result.text, /我先把依赖装上，再生成。/, '她说过的话不能因为到预算就丢掉')
		assert.match(result.text, /回一句「继续」/, '并且告诉她怎么让这事接着办')
		assert.ok(node.lines.some((line) => line.includes('used up its tool budget after a partial reply')))
	} finally {
		await node.stop()
	}
})
