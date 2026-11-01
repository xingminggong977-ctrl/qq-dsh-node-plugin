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
	turnTimeoutMs: 150,
	wrapUpMs: 120,
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
		runtime,
		lines,
		async stop() {
			await runner.stop()
			runtime.dispose()
			await stub.stop()
		},
	}
}

async function settled(stub, taskId) {
	await stub.waitFor((instance) => instance.results.has(taskId), { label: `settled ${taskId}` })
}

test('a turn that hits the wall gets one more exchange and delivers the wrap-up', async () => {
	const node = await boot({
		// 第一轮干到一半撞墙（已说过一句话），第二轮只让她交代结果。
		reply: ({ turn }) =>
			turn === 1
				? { texts: ['PPT 已经做好了，我看看怎么把它发给你。'], hangAfterTexts: true }
				: { text: '做完了：/opt/x/防诈骗.pptx，共 14 页。' },
	})
	try {
		node.stub.queue(ownerTask('t-wrap', '帮我做个防诈骗ppt'))
		await settled(node.stub, 't-wrap')
		const result = node.stub.results.get('t-wrap')
		assert.equal(result.ok, true, '撞墙后给了交代，就算成功')
		assert.match(result.text, /防诈骗\.pptx/, '发出去的是收尾那一轮的真实结果')
		assert.ok(node.lines.some((line) => line.includes('asking for a one-line wrap-up')), '日志要看得出走到了收尾')
	} finally {
		await node.stop()
	}
})

test('when the wrap-up also fails, what she had already said is what goes out', async () => {
	const node = await boot({
		reply: ({ turn }) => (turn === 1 ? { texts: ['我在做那个 PPT。'], hangAfterTexts: true } : { hang: true }),
	})
	try {
		node.stub.queue(ownerTask('t-partial', '做个防诈骗ppt'))
		await settled(node.stub, 't-partial')
		const result = node.stub.results.get('t-partial')
		assert.equal(result.ok, true)
		assert.match(result.text, /我在做那个 PPT/)
		assert.match(result.text, /回一句「继续」我就接着弄/)
		assert.ok(node.lines.some((line) => line.includes('hit the turn timeout after a partial reply')))
	} finally {
		await node.stop()
	}
})

test('a turn that never said anything and cannot be wrapped up still fails as a timeout', async () => {
	const node = await boot({ reply: () => ({ hang: true }), options: { wrapUpOnTimeout: false } })
	try {
		node.stub.queue(ownerTask('t-silent', '在吗'))
		await settled(node.stub, 't-silent')
		assert.deepEqual(node.stub.results.get('t-silent'), { ok: false, text: '', error: 'turn timeout' })
	} finally {
		await node.stop()
	}
})
