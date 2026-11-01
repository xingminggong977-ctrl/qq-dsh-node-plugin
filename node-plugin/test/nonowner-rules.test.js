import test from 'node:test'
import assert from 'node:assert/strict'
import { QqSessionStore, NON_OWNER_RULES } from '../lib/session.js'
import { createFakeRuntime } from './fake-runtime.js'

/**
 * 对陌生人说话时，第一轮必须先看到「不能说我读过谁的日记」这条守则。
 *
 * 她曾经对一个同学说「读得到你的日记、记忆和聊天记录」。那是实话，但不该说——
 * 记忆是主人交给她的，不是可以拿去当谈资的。**能记住，不等于可以宣称自己记住了什么。**
 */
const OPTIONS = {
	provider: '',
	model: '',
	reasoningEffort: '',
	maxTokens: 0,
	turnTimeoutMs: 5000,
	idleMs: 60000,
	cwd: process.cwd(),
	nonOwnerPreset: 'qq-chat-only',
}

function harness({ reply = () => ({ text: '嗯' }) } = {}) {
	const seen = []
	const runtime = createFakeRuntime({
		reply: ({ message }) => {
			seen.push(message)
			return reply()
		},
	})
	const store = new QqSessionStore({
		ctx: runtime.ctx,
		options: OPTIONS,
		client: { fetchBlob: async () => ({ bytes: new Uint8Array(), mediaType: 'image/png' }) },
		log: () => {},
	})
	store.attach()
	return { seen, store }
}

function textsOf(message) {
	return (Array.isArray(message.content) ? message.content : [])
		.filter((block) => block.type === 'text')
		.map((block) => block.text)
}

test('non-owner rules — the first turn to a stranger carries the rules', async () => {
	const { seen, store } = harness()
	try {
		await store.runTask({ taskId: 's-1', userId: '664671782', text: '你好', isOwner: false }, {})
		assert.equal(seen.length, 1)
		const texts = textsOf(seen[0])
		assert.equal(texts.at(-1), NON_OWNER_RULES, 'rules ride at the end of the message the model reads')
		assert.match(texts.join('\n'), /你好/, 'the actual message must still be there')
	} finally {
		store.dispose()
	}
})

test('non-owner rules — said once, not repeated every turn', async () => {
	const { seen, store } = harness()
	try {
		await store.runTask({ taskId: 's-2', userId: '664671782', text: '在吗', isOwner: false }, {})
		await store.runTask({ taskId: 's-3', userId: '664671782', text: '再问一次', isOwner: false }, {})
		assert.equal(seen.length, 2)
		assert.equal(textsOf(seen[0]).at(-1), NON_OWNER_RULES)
		assert.ok(
			!textsOf(seen[1]).includes(NON_OWNER_RULES),
			'the rules stay in the transcript; re-sending them every turn only bloats it',
		)
	} finally {
		store.dispose()
	}
})

test('non-owner rules — never added to the owner\'s own conversation', async () => {
	const { seen, store } = harness()
	try {
		await store.runTask({ taskId: 's-4', userId: '10001', text: '今天怎么样', isOwner: true }, {})
		assert.equal(seen.length, 1)
		assert.ok(!textsOf(seen[0]).includes(NON_OWNER_RULES))
	} finally {
		store.dispose()
	}
})

test('non-owner rules — the wording forbids claiming access without denying memory', async () => {
	// 只有「不说」还不够：她要能被问「你还记得上次吗」时自然接住，而不是变成一台复读机。
	assert.match(NON_OWNER_RULES, /不能说/)
	assert.match(NON_OWNER_RULES, /日记|记忆|聊天记录/)
	assert.match(NON_OWNER_RULES, /私事/)
})
