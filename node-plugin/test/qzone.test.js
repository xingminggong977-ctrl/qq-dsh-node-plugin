/**
 * `qzone_send`: the wire contract, the four failure modes, and the
 * token-gated registration.
 *
 * Nothing here touches a real NapCat: `test/qzone-ws-stub.js` speaks just
 * enough RFC 6455 to hand the built-in WebSocket client a 101 and a reply.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { runInTaskScope } from '../lib/context.js'
import { QzoneWsStub } from './qzone-ws-stub.js'
import {
	DEFAULT_NAPCAT_URL,
	MAX_CONTENT_CHARS,
	NAPCAT_TOKEN_ENV,
	QZONE_TIMEOUT_MS,
	VISIBILITIES,
	buildQzoneRequest,
	createQzoneTool as createRawQzoneTool,
	normalizeContent,
	ugcRightOf,
} from '../lib/qzone.js'
import { apply, resolveOptions } from '../index.js'

const TEST_TOKEN = 'stub-napcat-token'

/**
 * 说说只允许在「主人私聊」这一轮里发，所以测试默认替它铺好这个场景；
 * 想验拒绝路径的用例自己用 `createRawQzoneTool` 并显式给别的场景。
 */
const OWNER_SCOPE = { group: false, isOwner: true }
function createQzoneTool(options) {
	const tool = createRawQzoneTool(options)
	return { ...tool, execute: (args) => runInTaskScope(OWNER_SCOPE, () => tool.execute(args)) }
}

/** Collect one console method instead of printing into the test output. */
function captureConsole(method) {
	const lines = []
	const original = console[method]
	console[method] = (...args) => lines.push(args.join(' '))
	return {
		lines,
		restore() {
			console[method] = original
		},
	}
}

/** A plugin context that only offers a tools registry, which is all apply() needs here. */
function fakePluginContext() {
	const registered = []
	const ctx = {
		get(name) {
			if (name !== 'tools') return undefined
			return {
				register(tool) {
					registered.push(tool)
					return () => {
						const index = registered.indexOf(tool)
						if (index >= 0) registered.splice(index, 1)
					}
				},
			}
		},
		on() {
			return () => {}
		},
		effect(fn) {
			const dispose = fn()
			return typeof dispose === 'function' ? dispose : () => {}
		},
	}
	return { ctx, registered }
}

test('qzone 1 — one short-lived WS sends send_qzone_msg and the tid comes back', async () => {
	const stub = await new QzoneWsStub({ requireAuthorization: `Bearer ${TEST_TOKEN}` }).start()
	try {
		const tool = createQzoneTool({ url: stub.url, token: TEST_TOKEN, timeoutMs: 4000 })
		const publicText = await tool.execute({ content: '  晚上好，今天也在写代码。  ' })
		assert.equal(publicText, `已发出 QQ 空间说说：tid=${stub.tid}，可见性=公开`)

		const selfText = await tool.execute({ content: '只给自己看', visibility: 'self' })
		assert.match(selfText, /可见性=仅自己可见$/)

		// Payload shape, asserted on what actually reached the server.
		assert.equal(stub.requests.length, 2)
		const [first, second] = stub.requests
		assert.deepEqual(Object.keys(first).sort(), ['action', 'echo', 'params'], 'no extra top-level fields')
		assert.equal(first.action, 'send_qzone_msg')
		assert.deepEqual(first.params, { content: '晚上好，今天也在写代码。', ugc_right: 1 }, 'public=1 and the body is trimmed')
		assert.match(String(first.echo), /^qzone-[0-9a-f-]{36}$/)
		assert.deepEqual(second.params, { content: '只给自己看', ugc_right: 64 }, 'self=64')
		assert.notEqual(first.echo, second.echo, 'every call gets its own echo')

		// The token rode the upgrade request as a header, not the query string.
		assert.equal(stub.upgrades.length, 2)
		for (const upgrade of stub.upgrades) {
			assert.equal(upgrade.authorization, `Bearer ${TEST_TOKEN}`)
			assert.ok(!String(upgrade.url).includes(TEST_TOKEN), 'the token never appears in the URL')
		}

		// A reply whose echo names somebody else must be ignored, not accepted.
		await stub.waitFor((instance) => instance.closes === 2, { label: 'both sockets closed by the client' })
		console.log('[qzone 1] payload =', JSON.stringify(first), '| ugc_right(self) =', second.params.ugc_right)
	} finally {
		await stub.stop()
	}
})

test('qzone 2 — a non-zero retcode fails with the wording and the message', async () => {
	const stub = await new QzoneWsStub({
		reply: (request) => ({ status: 'failed', retcode: 1404, message: 'not logged in', wording: '账号未登录', echo: request.echo }),
	}).start()
	try {
		const tool = createQzoneTool({ url: stub.url, token: TEST_TOKEN, timeoutMs: 4000 })
		await assert.rejects(() => tool.execute({ content: '会失败的说说' }), (error) => {
			assert.equal(error.name, 'QzoneError')
			assert.match(error.message, /QQ 空间发送失败/)
			assert.match(error.message, /retcode=1404/)
			assert.match(error.message, /wording=账号未登录/)
			assert.match(error.message, /message=not logged in/)
			return true
		})
		await stub.waitFor((instance) => instance.closes === 1, { label: 'socket closed after the failure' })
		console.log('[qzone 2] error = 1404 with wording surfaced')
	} finally {
		await stub.stop()
	}
})

test('qzone 3 — a silent server hits the timeout budget instead of hanging', async () => {
	const stub = await new QzoneWsStub({ reply: () => undefined }).start()
	try {
		const tool = createQzoneTool({ url: stub.url, token: TEST_TOKEN, timeoutMs: 200 })
		const startedAt = Date.now()
		await assert.rejects(() => tool.execute({ content: '没人接话' }), (error) => {
			assert.equal(error.name, 'QzoneError')
			assert.equal(error.code, 'timeout')
			assert.match(error.message, /200ms 内没有等到 NapCat/)
			return true
		})
		const elapsed = Date.now() - startedAt
		assert.ok(elapsed >= 150, `waited for the budget, elapsed=${elapsed}`)
		assert.ok(elapsed < 3000, `did not wait for the production 10s budget, elapsed=${elapsed}`)
		await stub.waitFor((instance) => instance.closes === 1, { label: 'the timed-out socket was closed' })
		assert.equal(stub.requests.length, 1, 'the request was on the wire before the timeout')
		console.log('[qzone 3] timeout after', elapsed, 'ms')
	} finally {
		await stub.stop()
	}
})

test('qzone 4 — an echo from another call is skipped and the real reply still wins', async () => {
	const stub = await new QzoneWsStub({
		reply: (request) => [
			{ status: 'ok', retcode: 0, data: { tid: 'somebody-elses-tid' }, echo: 'qzone-foreign' },
			{ status: 'ok', retcode: 0, data: { tid: 'mine' }, echo: request.echo },
		],
	}).start()
	try {
		const tool = createQzoneTool({ url: stub.url, token: TEST_TOKEN, timeoutMs: 4000 })
		const text = await tool.execute({ content: '按 echo 匹配' })
		assert.match(text, /tid=mine，/)
		console.log('[qzone 4] result =', text)
	} finally {
		await stub.stop()
	}
})

test('qzone 5 — an empty NAPCAT_ACCESS_TOKEN skips registration and only warns', () => {
	const { ctx, registered } = fakePluginContext()
	const warning = captureConsole('warn')
	try {
		const saved = process.env[NAPCAT_TOKEN_ENV]
		delete process.env[NAPCAT_TOKEN_ENV]
		try {
			apply(ctx, { bridgeUrl: 'http://127.0.0.1:9' })
		} finally {
			if (saved !== undefined) process.env[NAPCAT_TOKEN_ENV] = saved
		}
		assert.equal(
			registered.filter((tool) => tool.name === 'qzone_send').length,
			0,
			'qzone_send must not be registered without a token',
		)
		const line = warning.lines.find((entry) => entry.includes(NAPCAT_TOKEN_ENV))
		assert.ok(line !== undefined, `a warn line names the variable: ${JSON.stringify(warning.lines)}`)
		assert.match(line, /^\[qq-node\].*qzone_send/)
		console.log('[qzone 5] warn =', line)
	} finally {
		warning.restore()
	}
})

test('qzone 6 — with a token the tool is registered with exactly content and visibility', async () => {
	const { ctx, registered } = fakePluginContext()
	const saved = process.env[NAPCAT_TOKEN_ENV]
	process.env[NAPCAT_TOKEN_ENV] = TEST_TOKEN
	try {
		apply(ctx, { bridgeUrl: 'http://127.0.0.1:9', napcatUrl: 'ws://127.0.0.1:3901' })
	} finally {
		if (saved === undefined) delete process.env[NAPCAT_TOKEN_ENV]
		else process.env[NAPCAT_TOKEN_ENV] = saved
	}
	const qzoneTools = registered.filter((entry) => entry.name === 'qzone_send')
	assert.equal(qzoneTools.length, 1)
	const [tool] = qzoneTools
	assert.equal(tool.name, 'qzone_send')
	assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['content', 'visibility'], 'exactly two parameters')
	assert.deepEqual(tool.parameters.required, ['content'])
	assert.deepEqual(tool.parameters.properties.visibility.enum, [...VISIBILITIES])
	assert.equal(tool.parameters.properties.content.type, 'string')
	assert.ok(!Object.hasOwn(tool.parameters.properties, 'ugc_right'), 'the raw integer is not exposed')

	// The registry validates a definition with this same helper before exposing it.
	assertSupportedJsonSchema(tool.parameters)
	assertSupportedJsonSchema(tool.output.schema)

	// Argument validation happens before anything touches a socket.
	const asOwner = (args) => runInTaskScope(OWNER_SCOPE, () => tool.execute(args))
	await assert.rejects(() => asOwner({ content: '   ' }), /正文不能为空/)
	await assert.rejects(() => asOwner({ content: 42 }), /content/)
	await assert.rejects(() => asOwner({ content: 'x', visibility: 'friends' }), /visibility/)
	await assert.rejects(() => asOwner({ content: 'x'.repeat(MAX_CONTENT_CHARS + 1) }), /最多 1000 个字符/)
	console.log('[qzone 6] parameters schema =', JSON.stringify(tool.parameters), '| registered =', registered.length)
})

test('qzone 7 — napcatUrl is a ws(s) Config key and the payload helpers are pinned', () => {
	assert.equal(resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787' }).napcatUrl, DEFAULT_NAPCAT_URL)
	assert.equal(DEFAULT_NAPCAT_URL, 'ws://127.0.0.1:3001')
	assert.equal(QZONE_TIMEOUT_MS, 10_000)
	assert.equal(resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787', napcatUrl: 'ws://10.0.0.2:3001' }).napcatUrl, 'ws://10.0.0.2:3001')
	assert.throws(() => resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787', napcatUrl: 'http://10.0.0.2:3001' }), /napcatUrl must be a ws\(s\) URL/)
	assert.equal(normalizeContent('  正文 \n'), '正文')
	assert.equal(normalizeContent('a'.repeat(MAX_CONTENT_CHARS)).length, MAX_CONTENT_CHARS)
	assert.equal(ugcRightOf('public'), 1)
	assert.equal(ugcRightOf('self'), 64)
	assert.equal(ugcRightOf(undefined), 1, 'visibility defaults to public')
	assert.throws(() => ugcRightOf('friends'), /visibility/)
	assert.deepEqual(buildQzoneRequest({ content: '你好', visibility: 'self', echo: 'e-1' }), {
		action: 'send_qzone_msg',
		params: { content: '你好', ugc_right: 64 },
		echo: 'e-1',
	})
	console.log('[qzone 7] napcatUrl default =', DEFAULT_NAPCAT_URL, '| ugc_right =', JSON.stringify({ public: ugcRightOf('public'), self: ugcRightOf('self') }))
})

test('qzone 8 — an unreachable NapCat says so instead of hanging or crashing', async () => {
	// Bind and release a port so the refusal is certain rather than firewalled.
	const probe = await new QzoneWsStub({ reply: () => undefined }).start()
	const deadUrl = probe.url
	await probe.stop()
	const tool = createQzoneTool({ url: deadUrl, token: TEST_TOKEN, timeoutMs: 4000 })
	await assert.rejects(() => tool.execute({ content: '没人接' }), (error) => {
		assert.equal(error.name, 'QzoneError')
		assert.ok(error.code === 'connect' || error.code === 'closed', `expected a transport failure, got ${error.code}`)
		assert.match(error.message, /NapCat/)
		assert.match(error.message, new RegExp(deadUrl.replace(/[.]/g, '\\.')))
		assert.ok(!error.message.includes(TEST_TOKEN), 'the token never leaks into an error')
		return true
	})
	console.log('[qzone 8] unreachable =', deadUrl)
})

test('qzone 9 — a pushed event frame is not mistaken for a reply', async () => {
	// NapCat pushes events (group messages, notices) on the same socket it answers
	// actions on, and those frames carry neither `echo` nor `retcode`. A guard that
	// only checks the echo reads them as "status failed, retcode=?" and surfaces a
	// phantom send failure, so this case pins the `retcode`-shape check instead.
	const stub = await new QzoneWsStub({
		reply: (request) => [
			{ post_type: 'message', message_type: 'group', group_id: 123456, self_id: 10002, raw_message: '群里有人说话' },
			{ post_type: 'notice', notice_type: 'heartbeat', self_id: 10002 },
			{ status: 'ok', retcode: 0, data: { tid: 'after-the-noise' }, echo: request.echo },
		],
	}).start()
	try {
		const tool = createQzoneTool({ url: stub.url, token: TEST_TOKEN, timeoutMs: 4000 })
		const text = await tool.execute({ content: '群里有人说话，这条还是要发出去' })
		assert.match(text, /tid=after-the-noise，/)
		console.log('[qzone 9] result =', text)
	} finally {
		await stub.stop()
	}
})

test('qzone 10 — outside an owner private turn the tool refuses and never dials NapCat', async () => {
	const stub = new QzoneWsStub()
	await stub.start()
	const tool = createRawQzoneTool({ url: stub.url, token: TEST_TOKEN, timeoutMs: 4000 })
	try {
		for (const scope of [{ group: true, isOwner: true }, { group: false, isOwner: false }]) {
			await assert.rejects(
				() => runInTaskScope(scope, () => tool.execute({ content: '这条不该发出去' })),
				(error) => {
					assert.equal(error.code, 'scope')
					assert.match(error.message, /私聊/)
					return true
				},
			)
		}
		// 没有场景（例如被调度器直接调起来）也拒绝：默认关门，不是默认开门。
		await assert.rejects(() => tool.execute({ content: '没有场景' }), (error) => error.code === 'scope')
		assert.equal(stub.requests.length, 0, '一次连接都不该建立')
	} finally {
		await stub.stop()
	}
})
