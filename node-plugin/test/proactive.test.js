import test from 'node:test'
import assert from 'node:assert/strict'
import { QqNodeRunner, declinedProactive } from '../lib/runner.js'
import { QqSessionStore } from '../lib/session.js'
import { createFakeRuntime } from './fake-runtime.js'

/**
 * 主动那一轮喂给 agent 的 content 必须是**块数组**。
 *
 * 这不是风格问题：dsh 的 session-title 插件直接对 `event.data.content` 调
 * `.filter`，字符串会让它抛 TypeError，整轮变成 failed。曾经就是这么坏的——
 * 普通消息走 `#content`（块数组）一切正常，只有主动轮用字符串，于是唯独那一轮
 * 必挂，而且报错看起来完全与我无关。
 */
test('proactive content — the turn is fed blocks, not a bare string', async () => {
	const seen = []
	const runtime = createFakeRuntime({
		reply: ({ message }) => {
			seen.push(message)
			return { text: 'NONE' }
		},
	})
	const store = new QqSessionStore({
		ctx: runtime.ctx,
		options: { provider: '', model: '', reasoningEffort: '', maxTokens: 0, turnTimeoutMs: 5000, idleMs: 60000, cwd: process.cwd(), nonOwnerPreset: 'qq-chat-only' },
		client: { fetchBlob: async () => ({ bytes: new Uint8Array(), mediaType: 'image/png' }) },
		log: () => {},
	})
	store.attach()
	try {
		const result = await store.runTask(
			{ taskId: 'p-shape', userId: '10001', text: '', isOwner: true },
			{ allowEmpty: true, proactive: true },
		)
		assert.equal(result.ok, true)
		assert.equal(seen.length, 1)
		assert.ok(Array.isArray(seen[0].content), 'content must be an array of blocks')
		assert.equal(seen[0].content.length, 1)
		assert.equal(seen[0].content[0].type, 'text')
		assert.match(seen[0].content[0].text, /系统提示/)
		assert.match(seen[0].content[0].text, /NONE/)
	} finally {
		store.dispose()
	}
})

/** Poll-log client stub: hands out the queued tasks once, then idles. */
function stubClient(tasks) {
	const queue = [...tasks]
	return {
		submitted: [],
		async poll() {
			if (queue.length > 0) return queue.splice(0)
			await new Promise((resolve) => setTimeout(resolve, 10))
			return []
		},
		async markStatus() {},
		async submitResult(payload) {
			this.submitted.push(payload)
			return { ok: true }
		},
	}
}

function stubStore({ text = '我在想，你今天是不是又没吃早饭' } = {}) {
	const seen = []
	return {
		seen,
		attach: () => () => {},
		sweep: () => 0,
		dispose() {},
		async runTask(task, options) {
			seen.push({ task, options })
			return { ok: true, text }
		},
	}
}

const OPTIONS = Object.freeze({
	pollWaitSeconds: 1,
	pollLimit: 2,
	maxConcurrentTurns: 1,
	idleRecycleMs: 60_000,
	turnTimeoutMs: 5_000,
	proactiveInterjection: { enabled: false, minIntervalMs: 1, maxPerMinute: 1, maxPerGroupPerDay: 1 },
})

function recorder() {
	const records = []
	return {
		records,
		record(entry) {
			records.push(entry)
			return true
		},
	}
}

async function waitFor(predicate, budgetMs = 2_000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (predicate()) return true
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	return false
}

/** 桥接造出来的那种任务：没有来信正文，只有一个 proactive 标记。 */
const PROACTIVE_TASK = Object.freeze({
	taskId: 't-pro-1',
	kind: 'private',
	userId: '10001',
	nickname: '',
	text: '',
	images: [],
	receivedAt: Date.now(),
	isOwner: true,
	proactive: true,
})

test('proactive 1 — a proactive task runs as a proactive turn and its reply is audited as such', async () => {
	const client = stubClient([{ ...PROACTIVE_TASK }])
	const store = stubStore({ text: '刚看到楼下那只猫又来了' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => client.submitted.length >= 1), true, 'the turn never submitted')
		assert.equal(store.seen[0].options.proactive, true, 'the store must know this is not a user message')
		assert.equal(store.seen[0].options.allowEmpty, true, 'silence is allowed, otherwise an empty turn counts as a failure')
		assert.equal(client.submitted[0].text, '刚看到楼下那只猫又来了')
		assert.equal(audit.records.length, 1)
		assert.equal(audit.records[0].kind, 'proactive')
		assert.equal(audit.records[0].target, '10001')
	} finally {
		await runner.stop()
	}
})

test('proactive 2 — answering NONE sends nothing and writes no audit line', async () => {
	const client = stubClient([{ ...PROACTIVE_TASK, taskId: 't-pro-2' }])
	const store = stubStore({ text: 'NONE' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => client.submitted.length >= 1), true)
		assert.equal(client.submitted[0].text, '', 'nothing to say must not become a message')
		assert.equal(client.submitted[0].ok, true, 'declining is a success, not a failure')
		assert.equal(audit.records.length, 0)
	} finally {
		await runner.stop()
	}
})

test('proactive 3 — a decorated NONE is still treated as declining', async () => {
	for (const [index, text] of ['NONE.', 'none', 'NONE（今天没什么事）', '  NONE  '].entries()) {
		const client = stubClient([{ ...PROACTIVE_TASK, taskId: `t-pro-deco-${index}` }])
		const store = stubStore({ text })
		const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {} })
		runner.start()
		try {
			assert.equal(await waitFor(() => client.submitted.length >= 1), true, `no submit for ${JSON.stringify(text)}`)
			assert.equal(client.submitted[0].text, '', `${JSON.stringify(text)} should be silence`)
		} finally {
			await runner.stop()
		}
	}
})

test('proactive 4 — declinedProactive is strict about the word boundary', () => {
	assert.equal(declinedProactive('NONE'), true)
	assert.equal(declinedProactive('nOnE!'), true)
	assert.equal(declinedProactive('NONEtheless I am here'), false, 'a sentence that merely starts with NONE is not silence')
	assert.equal(declinedProactive('我今天没想说的'), false)
	assert.equal(declinedProactive(''), false, 'an empty turn is handled by allowEmpty, not by NONE')
})
