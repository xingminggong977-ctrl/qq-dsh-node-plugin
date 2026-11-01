/**
 * `pc_exec` / `pc_read` / `pc_write` 的接线测试。
 *
 * 全程只连本地假 bridge（`node:http` 起在 127.0.0.1:0），一个字节都不出去。
 * 这里要钉住四件事：
 * 1. 只有主人私聊的那一轮才注册；群里、别人面前一个都没有；
 * 2. 通道三态分开说 —— 没开机 / 刚断开 / 没回话 / 排队满了，各自说人话；
 * 3. `result.ok=false` 是电脑上那条命令失败，不是通道失败，exitCode 与 stderr 照实说；
 * 4. `pcEnabled` 默认关，关着时一个工具都不注册，启动日志写明原因。
 */
import { createServer } from 'node:http'
import test from 'node:test'
import assert from 'node:assert/strict'
import { assertSupportedJsonSchema } from '@deepseek-ai/dsh-tools'
import { runInTaskScope } from '../lib/context.js'
import { apply, registerPcTools, resolveOptions } from '../index.js'
import {
	DEFAULT_PC_BASE_URL,
	DEFAULT_PC_TIMEOUT_MS,
	MAX_PC_TIMEOUT_MS,
	MIN_PC_TIMEOUT_MS,
	PC_TOOL_NAMES,
	READ_MAX_BYTES,
	clampPcTimeoutMs,
	createPcToolGate,
	createPcTools,
} from '../lib/pc-tools.js'

const TEST_TOKEN = 'pc-test-token'
const OWNER_SCOPE = { group: false, isOwner: true }
const GROUP_SCOPE = { group: true, isOwner: true }
const NOTE_PATH = 'C:\\Users\\lenovo\\Documents\\note.md'

/** 主人私聊里跑一次（工具自己也查场景，所以每个 execute 都得包住）。 */
function asOwner(fn) {
	return runInTaskScope(OWNER_SCOPE, fn)
}

/** 100% 本地假 bridge：记下每次请求，再按用例给的回话应答。 */
async function startBridge(handler) {
	const requests = []
	const server = createServer(async (req, res) => {
		const chunks = []
		for await (const chunk of req) chunks.push(chunk)
		const text = Buffer.concat(chunks).toString('utf8')
		let body = null
		try {
			body = text === '' ? null : JSON.parse(text)
		} catch {
			body = null
		}
		const record = { method: req.method, url: req.url, authorization: req.headers.authorization, body }
		requests.push(record)
		let answer
		try {
			answer = await handler(record)
		} catch (error) {
			answer = { status: 500, body: { ok: false, error: String(error) } }
		}
		if (answer === undefined || answer === null) answer = { status: 500, body: { ok: false, error: 'no answer' } }
		res.writeHead(answer.status ?? 200, { 'content-type': 'application/json; charset=utf-8' })
		res.end(JSON.stringify(answer.body ?? null))
	})
	await new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(0, '127.0.0.1', resolve)
	})
	const { port } = server.address()
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((resolve) => server.close(() => resolve())),
	}
}

/** 依次取用回话；用完之后一直用最后一个。 */
function answers(list) {
	let index = 0
	return () => list[Math.min(index++, list.length - 1)]
}

/**
 * 只让 `/node/pc/enqueue` 用队列回话；`/node/pc/status` 单独给。
 *
 * 默认 503：这些用例要钉的是「enqueue 回包自己怎么说」，状态探测探不到就等于没探。
 */
function enqueueOnly(queue, statusAnswer = { status: 503, body: { ok: false, error: 'status 不可用' } }) {
	const take = answers(queue)
	return (record) => (record.method === 'POST' ? take(record) : statusAnswer)
}

/** `/node/pc/status` 的三态回包（契约 §3）。 */
function statusAnswer(state, lastPollSeconds, lastHeartbeatSeconds = lastPollSeconds) {
	return { status: 200, body: { ok: true, state, lastPollSeconds, lastHeartbeatSeconds } }
}

/** `state=done` 的回包（契约 §2 第二种形状的反面）。 */
function done(result, id = 'pc-1') {
	return { status: 200, body: { ok: true, id, state: 'done', result } }
}

/** `ok=false` 的通道回包。 */
function channelFailure(state, extra = {}) {
	return { status: 200, body: { ok: false, id: 'pc-1', state, error: extra.error ?? '通道出了问题', ...extra } }
}

/** 一个只提供 agent 作用域 tools 服务的假 agent。 */
function fakeAgent(id = 'agent-1') {
	const registered = []
	const tools = {
		register(tool) {
			registered.push(tool)
			return () => {
				const index = registered.indexOf(tool)
				if (index >= 0) registered.splice(index, 1)
			}
		},
	}
	return { agent: { id, ctx: { get: (service) => (service === 'tools' ? tools : undefined) } }, registered }
}

/** 插件上下文：tools 注册表 + 事件监听收集，够 apply() 与 registerPcTools() 用。 */
function fakePluginContext() {
	const registered = []
	const listeners = new Map()
	const ctx = {
		get(service) {
			if (service !== 'tools') return undefined
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
		on(event, handler) {
			const list = listeners.get(event) ?? []
			list.push(handler)
			listeners.set(event, list)
			return () => {
				const current = listeners.get(event) ?? []
				const index = current.indexOf(handler)
				if (index >= 0) current.splice(index, 1)
			}
		},
		effect(fn) {
			const dispose = fn()
			return typeof dispose === 'function' ? dispose : () => {}
		},
	}
	return { ctx, registered, listeners }
}

/** 收集一种 console 方法，别把测试输出刷满。 */
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

test('pc 1 — 主人私聊那一轮注册三个工具，exec 的回包被如实转述', async () => {
	const bridge = await startBridge(() =>
		done({ id: 'c_1', ok: true, exitCode: 0, stdout: ' M lib/pc-tools.js\n?? test/pc-tools.test.js\n', stderr: '', truncated: false, bytes: 57, durationMs: 12 }),
	)
	try {
		const { agent, registered } = fakeAgent()
		const gate = createPcToolGate({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		assert.equal(asOwner(() => gate.admit(agent)), true)
		assert.deepEqual(registered.map((tool) => tool.name), [...PC_TOOL_NAMES])
		for (const tool of registered) {
			assertSupportedJsonSchema(tool.parameters)
			assertSupportedJsonSchema(tool.output.schema)
		}

		const exec = registered[0]
		const text = await asOwner(() => exec.execute({ command: 'git status' }))
		assert.match(text, /^电脑上跑完了（exitCode=0，耗时 12 毫秒）/)
		assert.match(text, /lib\/pc-tools\.js/)

		const record = bridge.requests[0]
		assert.equal(record.method, 'POST')
		assert.equal(record.url, '/node/pc/enqueue')
		assert.equal(record.authorization, `Bearer ${TEST_TOKEN}`)
		assert.deepEqual(record.body, { kind: 'exec', payload: { command: 'git status', timeoutMs: 3000 }, timeoutMs: 3000 })
		console.log('[pc 1] 注册:', registered.map((tool) => tool.name).join(','), '| envelope 与鉴权头都对')
	} finally {
		await bridge.close()
	}
})

test('pc 2 — pc_read 的 payload 是 {path,maxBytes}，正文原样回来', async () => {
	const bridge = await startBridge(() => done({ id: 'c_2', ok: true, bytes: 11, truncated: false, stdout: '# 晚上好\n' }))
	try {
		const tools = createPcTools({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		const text = await asOwner(() => tools[1].execute({ path: NOTE_PATH }))
		assert.match(text, /读到了，11 字节/)
		assert.match(text, /# 晚上好/)
		assert.deepEqual(bridge.requests[0].body, { kind: 'read', payload: { path: NOTE_PATH, maxBytes: READ_MAX_BYTES }, timeoutMs: 3000 })
		console.log('[pc 2] read payload:', JSON.stringify(bridge.requests[0].body.payload))
	} finally {
		await bridge.close()
	}
})

test('pc 3 — pc_write 的 payload 是 {path,content,append}，append 默认 false', async () => {
	const bridge = await startBridge(() => done({ id: 'c_3', ok: true, bytes: 5, stdout: '' }))
	try {
		const tools = createPcTools({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		const appended = await asOwner(() => tools[2].execute({ path: NOTE_PATH, content: '晚上好\n', append: true }))
		assert.match(appended, /^已追加写入 C:\\Users\\lenovo\\Documents\\note\.md（5 字节）/)
		assert.deepEqual(bridge.requests[0].body.payload, { path: NOTE_PATH, content: '晚上好\n', append: true })

		const overwritten = await asOwner(() => tools[2].execute({ path: NOTE_PATH, content: 'x' }))
		assert.match(overwritten, /^已覆盖写入/)
		assert.deepEqual(bridge.requests[1].body.payload, { path: NOTE_PATH, content: 'x', append: false })
		console.log('[pc 3] write payload:', JSON.stringify(bridge.requests[1].body.payload))
	} finally {
		await bridge.close()
	}
})

test('pc 4 — 群里 / 别人 / 没有场景：一个都不注册，已注册的当场撤掉', async () => {
	const bridge = await startBridge(() => done({ ok: true, exitCode: 0, stdout: 'ok' }))
	try {
		const gate = createPcToolGate({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		const { agent, registered } = fakeAgent()

		// 没有场景（调度器、别处直接调用）：按不是主人私聊处理
		assert.equal(gate.admit(agent), false)
		assert.equal(registered.length, 0)
		// 群里，就算发起人是主人：不注册
		assert.equal(runInTaskScope(GROUP_SCOPE, () => gate.admit(agent)), false)
		assert.equal(registered.length, 0)
		// 私聊但不是主人：不注册
		assert.equal(runInTaskScope({ group: false, isOwner: false }, () => gate.admit(agent)), false)
		assert.equal(registered.length, 0)
		// 主人私聊：三个都注册
		assert.equal(asOwner(() => gate.admit(agent)), true)
		assert.equal(registered.length, 3)
		const tools = [...registered]
		// 同一轮重复触发：不重复注册
		assert.equal(asOwner(() => gate.admit(agent)), true)
		assert.equal(registered.length, 3)
		// 换到群里的那一轮：当场撤干净
		assert.equal(runInTaskScope(GROUP_SCOPE, () => gate.admit(agent)), false)
		assert.equal(registered.length, 0)
		assert.equal(gate.size, 0)
		// 工具自己也把门：没场景直接调就被拒，连 bridge 都不碰
		await assert.rejects(() => tools[0].execute({ command: 'dir' }), /只在主人的私聊里执行/)
		assert.equal(bridge.requests.length, 0)
		console.log('[pc 4] 群/非主人/无场景一律空注册；门在注册与 execute 两层都在')
	} finally {
		await bridge.close()
	}
})

test('pc 5 — offline 分「没开机」与「刚断开」两套话术', async () => {
	const bridge = await startBridge(
		enqueueOnly([
			channelFailure('offline', { error: '电脑没开着，或 pc-agent 没在跑', lastSeenSeconds: 420 }),
			channelFailure('offline', { lastSeenSeconds: 45 }),
			channelFailure('offline', {}),
		]),
	)
	try {
		const tools = createPcTools({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				// 契约 §4 给的范文，一字不差
				assert.match(error.message, /^PC 没开机（最后心跳 7 分钟前），这条命令没发出去$/)
				assert.equal(error.code, 'offline')
				return true
			},
		)
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				assert.match(error.message, /^电脑刚断开（最后心跳 45 秒前），可能正在重连，这条命令没发出去，等十几秒再试$/)
				return true
			},
		)
		await assert.rejects(() => asOwner(() => tools[0].execute({ command: 'dir' })), /还没报到过/)
		console.log('[pc 5] 没开机 / 刚断开 / 从没报到过，三种都说清楚了')
	} finally {
		await bridge.close()
	}
})

test('pc 6 — timeout 说「电脑开着，但 30 秒没回话」', async () => {
	const bridge = await startBridge(() => channelFailure('timeout', { lastSeenSeconds: 8 }))
	try {
		// 用默认预算，好让文案里的秒数就是契约范文里的 30 秒
		const tools = createPcTools({ baseUrl: bridge.url, token: TEST_TOKEN })
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				assert.match(error.message, /^电脑开着，但 30 秒没回话，可能在忙/)
				assert.match(error.message, /不知道它跑没跑完/)
				assert.doesNotMatch(error.message, /没开机/)
				return true
			},
		)
		console.log('[pc 6] timeout 文案与「没发出去」区分开了')
	} finally {
		await bridge.close()
	}
})

test('pc 7 — busy 是通道问题：说「没排上」，不说「没开机」', async () => {
	const bridge = await startBridge(() => channelFailure('busy', { error: '在途命令已达上限 4' }))
	try {
		const tools = createPcTools({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				assert.equal(error.code, 'busy')
				assert.match(error.message, /没排上/)
				assert.match(error.message, /在途命令已满 4 条/)
				assert.doesNotMatch(error.message, /没开机/)
				assert.doesNotMatch(error.message, /没回话/)
				return true
			},
		)
		console.log('[pc 7] busy 文案:', '没排上，不冒充没开机')
	} finally {
		await bridge.close()
	}
})

test('pc 8 — result.ok=false 是命令自己失败：照实转述 exitCode 与 stderr 末几行', async () => {
	const longStderr = ['line1', 'line2', 'line3', 'line4', 'line5', 'line6', 'line7', 'line8', 'line9', 'line10'].join('\n')
	const bridge = await startBridge(
		answers([
			done({ ok: false, exitCode: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n', errorCode: 'internal', error: '命令退出了非零状态' }),
			done({ ok: false, exitCode: 1, stdout: '', stderr: longStderr, errorCode: 'internal', error: '命令退出了非零状态' }),
		]),
	)
	try {
		const tools = createPcTools({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		// 注意：这是 resolve，不是 reject —— 通道好得很，是那条命令失败了
		const text = await asOwner(() => tools[0].execute({ command: 'git status' }))
		assert.match(text, /^电脑上这条命令失败了（exitCode=128）/)
		assert.match(text, /fatal: not a git repository/)
		assert.match(text, /通道没坏/)
		assert.doesNotMatch(text, /没发出去/)
		assert.doesNotMatch(text, /没回话/)

		const truncated = await asOwner(() => tools[0].execute({ command: 'npm test' }))
		assert.match(truncated, /stderr 末尾/)
		assert.match(truncated, /line10/)
		assert.doesNotMatch(truncated, /line5/)
		console.log('[pc 8] exec 失败 = 正常结果 + exitCode + stderr 末五行')
	} finally {
		await bridge.close()
	}
})

test('pc 9 — 撞白名单时说明撞的是哪一堵墙', async () => {
	const bridge = await startBridge(
		answers([
			done({ ok: false, errorCode: 'not_allowlisted', error: '命令不在白名单里：rmdir' }),
			done({ ok: false, errorCode: 'path_denied', error: '路径不在允许的根目录下：C:\\Windows' }),
		]),
	)
	try {
		const tools = createPcTools({ baseUrl: bridge.url, token: TEST_TOKEN, timeoutMs: 3000 })
		const denied = await asOwner(() => tools[0].execute({ command: 'rmdir /s C:\\Windows' }))
		assert.match(denied, /这条命令不在白名单里/)
		assert.match(denied, /电脑原话：命令不在白名单里：rmdir/)

		const outside = await asOwner(() => tools[1].execute({ path: 'C:\\Windows\\win.ini' }))
		assert.match(outside, /这个路径不在允许的目录里/)
		assert.match(outside, /电脑原话：路径不在允许的根目录下/)
		console.log('[pc 9] not_allowlisted / path_denied 各自点名了')
	} finally {
		await bridge.close()
	}
})

test('pc 10 — 连不上 bridge / HTTP 非 2xx 不能说成「PC 没开机」', async () => {
	// 先起一个再关掉，得到一个肯定没人听的端口
	const gone = await startBridge(() => done({}))
	const deadUrl = gone.url
	await gone.close()
	const deadTools = createPcTools({ baseUrl: deadUrl, token: TEST_TOKEN, timeoutMs: 3000 })
	await assert.rejects(
		() => asOwner(() => deadTools[0].execute({ command: 'dir' })),
		(error) => {
			assert.match(error.message, /连不上 cloud bridge/)
			assert.doesNotMatch(error.message, /没开机/)
			return true
		},
	)

	const broken = await startBridge(() => ({ status: 502, body: { ok: false, error: 'bad gateway' } }))
	try {
		const tools = createPcTools({ baseUrl: broken.url, token: TEST_TOKEN, timeoutMs: 3000 })
		await assert.rejects(() => asOwner(() => tools[0].execute({ command: 'dir' })), /HTTP 502/)
		console.log('[pc 10] 云端那一段断了，说的是云端，不是电脑')
	} finally {
		await broken.close()
	}
})

test('pc 11 — pcEnabled 默认关：一个 pc 工具都不注册，启动日志说明原因', async () => {
	const savedToken = process.env.QQ_NODE_TOKEN
	process.env.QQ_NODE_TOKEN = ''
	const info = captureConsole('info')
	const warn = captureConsole('warn')
	try {
		const { ctx, registered, listeners } = fakePluginContext()
		apply(ctx, { bridgeUrl: 'http://127.0.0.1:9' })
		const pcTools = registered.filter((tool) => PC_TOOL_NAMES.includes(tool.name))
		assert.deepEqual(pcTools, [])
		assert.equal(listeners.has('agent/inbox/inserted'), false)
		assert.ok(
			info.lines.some((line) => line.startsWith('[qq-node]') && line.includes('pcEnabled is false')),
			`启动日志里没写关闭原因：${info.lines.join(' | ')}`,
		)

		// 开了但是没有 node token：够不到 bridge，宁可不注册
		const { ctx: ctx2, registered: registered2, listeners: listeners2 } = fakePluginContext()
		assert.equal(registerPcTools(ctx2, resolveOptions({ bridgeUrl: 'http://127.0.0.1:9', pcEnabled: true })), false)
		assert.deepEqual(registered2.filter((tool) => PC_TOOL_NAMES.includes(tool.name)), [])
		assert.equal(listeners2.size, 0)
		assert.ok(warn.lines.some((line) => line.includes('no node token')))
		console.log('[pc 11] 默认关 / 缺 token 关，两次都留了日志')
	} finally {
		info.restore()
		warn.restore()
		if (savedToken === undefined) delete process.env.QQ_NODE_TOKEN
		else process.env.QQ_NODE_TOKEN = savedToken
	}
})

test('pc 12 — 打开后按「这一轮是不是主人私聊」注册与撤销', async () => {
	const bridge = await startBridge(() => done({ ok: true, exitCode: 0, stdout: 'ok' }))
	try {
		const { ctx, listeners } = fakePluginContext()
		const options = resolveOptions({ bridgeUrl: 'http://127.0.0.1:9', nodeToken: TEST_TOKEN, pcEnabled: true, pcBaseUrl: bridge.url, pcTimeoutMs: 3000 })
		assert.equal(registerPcTools(ctx, options), true)
		const inserted = listeners.get('agent/inbox/inserted') ?? []
		const disposed = listeners.get('agent/disposed') ?? []
		assert.equal(inserted.length, 1)
		assert.equal(disposed.length, 1)

		const { agent, registered } = fakeAgent('qq-private')
		// 私聊那一轮：followup() 同步插收件箱，监听器就地完成注册
		asOwner(() => inserted[0]({ agent, message: {} }))
		assert.deepEqual(registered.map((tool) => tool.name), [...PC_TOOL_NAMES])
		// 群聊那一轮：同一份逻辑撤干净
		runInTaskScope(GROUP_SCOPE, () => inserted[0]({ agent, message: {} }))
		assert.equal(registered.length, 0)
		// 群聊轮重复触发不会崩
		runInTaskScope(GROUP_SCOPE, () => inserted[0]({ agent, message: {} }))
		assert.equal(registered.length, 0)
		// 回到私聊轮再注册一次，agent 走了就带走
		asOwner(() => inserted[0]({ agent, message: {} }))
		assert.equal(registered.length, 3)
		disposed[0]({ agent })
		assert.equal(registered.length, 0)
		console.log('[pc 12] 私聊 3 个 / 群聊 0 个 / agent 走了一个不留')
	} finally {
		await bridge.close()
	}
})

test('pc 13 — 配置默认值与夹取', () => {
	const defaults = resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787' })
	assert.equal(defaults.pcEnabled, false)
	assert.equal(defaults.pcBaseUrl, DEFAULT_PC_BASE_URL)
	assert.equal(defaults.pcTimeoutMs, DEFAULT_PC_TIMEOUT_MS)
	assert.equal(resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787', pcTimeoutMs: 5 }).pcTimeoutMs, MIN_PC_TIMEOUT_MS)
	assert.equal(resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787', pcTimeoutMs: 999_999 }).pcTimeoutMs, MAX_PC_TIMEOUT_MS)
	assert.equal(resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787', pcBaseUrl: 'http://127.0.0.1:9000/' }).pcBaseUrl, 'http://127.0.0.1:9000')
	assert.throws(() => resolveOptions({ bridgeUrl: 'http://127.0.0.1:8787', pcBaseUrl: 'ftp://x' }), /pcBaseUrl must be an http\(s\) URL/)
	assert.equal(clampPcTimeoutMs(undefined), DEFAULT_PC_TIMEOUT_MS)
	assert.equal(clampPcTimeoutMs(0), DEFAULT_PC_TIMEOUT_MS)
	assert.equal(clampPcTimeoutMs(45_000), 45_000)
	console.log('[pc 13] 默认关、夹取 1000..120000、pcBaseUrl 必须 http(s)')
})

test('pc 14 — offline 时主动查 /node/pc/status：刚断开、又连上、探不到', async () => {
	// ① enqueue 说离线且心跳 400 秒，但状态接口说 just_lost：状态更新更近，以它为准
	const justLost = await startBridge((record) =>
		record.method === 'POST'
			? channelFailure('offline', { lastSeenSeconds: 400 })
			: statusAnswer('just_lost', 45, 40),
	)
	try {
		const tools = createPcTools({ baseUrl: justLost.url, token: TEST_TOKEN, timeoutMs: 3000 })
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				assert.match(error.message, /^电脑刚断开（最后报到 45 秒前），可能正在重连，这条命令没发出去，等十几秒再试$/)
				assert.doesNotMatch(error.message, /没开机/)
				return true
			},
		)
		// 探的那一次是 GET /node/pc/status，也带了 bearer
		const probe = justLost.requests.at(-1)
		assert.equal(probe.method, 'GET')
		assert.equal(probe.url, '/node/pc/status')
		assert.equal(probe.authorization, `Bearer ${TEST_TOKEN}`)
		console.log('[pc 14a] 状态接口说 just_lost → 按「刚断开」说，不按回包的 400 秒说「没开机」')
	} finally {
		await justLost.close()
	}

	// ② 已经回来了：明说重发一次，别让她以为电脑关着
	const backOnline = await startBridge((record) =>
		record.method === 'POST' ? channelFailure('offline', { lastSeenSeconds: 400 }) : statusAnswer('online', 3),
	)
	try {
		const tools = createPcTools({ baseUrl: backOnline.url, token: TEST_TOKEN, timeoutMs: 3000 })
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				assert.match(error.message, /^电脑这会儿又连上了（3 秒前刚报到），刚才那条命令没发出去，重发一次就行$/)
				return true
			},
		)
		console.log('[pc 14b] 状态接口说 online → 说「重发一次就行」')
	} finally {
		await backOnline.close()
	}

	// ③ 状态接口挂了（500）：退回 enqueue 回包里的 lastSeenSeconds，不因为探不到而改口
	const noProbe = await startBridge(enqueueOnly([channelFailure('offline', { lastSeenSeconds: 45 })]))
	try {
		const tools = createPcTools({ baseUrl: noProbe.url, token: TEST_TOKEN, timeoutMs: 3000 })
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				assert.match(error.message, /^电脑刚断开（最后心跳 45 秒前），可能正在重连，这条命令没发出去，等十几秒再试$/)
				return true
			},
		)
		console.log('[pc 14c] 状态接口不可用 → 退回回包里的 lastSeenSeconds，话术不变')
	} finally {
		await noProbe.close()
	}

	// ④ 状态接口说 offline 且 900 秒没报到：以它为准说「没开机」
	const stale = await startBridge((record) =>
		record.method === 'POST' ? channelFailure('offline', { lastSeenSeconds: 45 }) : statusAnswer('offline', 900),
	)
	try {
		const tools = createPcTools({ baseUrl: stale.url, token: TEST_TOKEN, timeoutMs: 3000 })
		await assert.rejects(
			() => asOwner(() => tools[0].execute({ command: 'dir' })),
			(error) => {
				assert.match(error.message, /^PC 没开机（最后心跳 15 分钟前），这条命令没发出去$/)
				return true
			},
		)
		console.log('[pc 14d] 状态接口说 offline（900 秒）→ 说「没开机」，不因为回包只有 45 秒就说「刚断开」')
	} finally {
		await stale.close()
	}
})
