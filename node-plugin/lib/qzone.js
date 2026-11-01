/**
 * `qzone_send` — one QQ 空间 post through NapCat's OneBot11 extension action.
 *
 * The plugin never holds a NapCat connection: every call opens a throwaway
 * WebSocket to `napcatUrl`, sends one `send_qzone_msg` action, matches the
 * reply by `echo`, and closes. No reconnect, no shared socket, no queue.
 *
 * NapCat's WS endpoint needs the access token as an HTTP header, so the client
 * is constructed with the two-argument undici form
 * `new WebSocket(url, { headers })` — the WHATWG third-argument form is
 * accepted but the headers are dropped, which would silently authenticate as
 * nobody. `test/qzone.test.js` pins that header end to end.
 */
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { isPrivateOwnerTurn } from './context.js'

/** Model-facing tool name. */
export const QZONE_TOOL_NAME = 'qzone_send'

/** Environment variable holding the NapCat access token; never a Config key. */
export const NAPCAT_TOKEN_ENV = 'NAPCAT_ACCESS_TOKEN'

/** Default NapCat OneBot11 WS endpoint. */
export const DEFAULT_NAPCAT_URL = 'ws://127.0.0.1:3001'

/** Whole-call budget: connect + handshake + reply. */
export const QZONE_TIMEOUT_MS = 10_000

/** Longest accepted body, in Unicode code points, after trimming. */
export const MAX_CONTENT_CHARS = 1000

/** `ugc_right` per visibility; 16/128 need `target_uins` and are out of scope. */
export const UGC_RIGHT = Object.freeze({ public: 1, self: 64 })

/** The only two visibilities the tool exposes. */
export const VISIBILITIES = Object.freeze(['public', 'self'])

/** A failure that already carries model-readable wording; nothing to unwrap. */
export class QzoneError extends Error {
	constructor(message, { code, cause } = {}) {
		super(message, cause === undefined ? undefined : { cause })
		this.name = 'QzoneError'
		this.code = code
	}
}

/** Trim the body and enforce 1..MAX_CONTENT_CHARS; returns the text to send. */
export function normalizeContent(value) {
	if (typeof value !== 'string') throw new QzoneError('说说正文必须是字符串', { code: 'content' })
	const content = value.trim()
	if (content === '') throw new QzoneError('说说正文不能为空', { code: 'content' })
	const chars = [...content].length
	if (chars > MAX_CONTENT_CHARS) throw new QzoneError(`说说正文最多 ${MAX_CONTENT_CHARS} 个字符，这条有 ${chars} 个`, { code: 'content' })
	return content
}

/** Map `public` / `self` (and an absent value, meaning `public`) to `ugc_right`. */
export function ugcRightOf(visibility) {
	const key = visibility === undefined || visibility === null || visibility === '' ? 'public' : String(visibility)
	const ugcRight = UGC_RIGHT[key]
	if (ugcRight === undefined) throw new QzoneError(`visibility 只能是 public 或 self，收到 ${JSON.stringify(visibility)}`, { code: 'visibility' })
	return ugcRight
}

/**
 * The exact OneBot11 frame this tool puts on the wire. Exported so a test can
 * assert the payload shape without a socket.
 */
export function buildQzoneRequest({ content, visibility, echo }) {
	return {
		action: 'send_qzone_msg',
		params: { content, ugc_right: ugcRightOf(visibility) },
		echo,
	}
}

/** Render a failed OneBot11 reply: status, retcode, then wording/message. */
function describeReply(reply) {
	const parts = [`retcode=${reply?.retcode ?? '?'}`]
	if (typeof reply?.wording === 'string' && reply.wording !== '') parts.push(`wording=${reply.wording}`)
	if (typeof reply?.message === 'string' && reply.message !== '') parts.push(`message=${reply.message}`)
	const status = typeof reply?.status === 'string' && reply.status !== '' ? `${reply.status} ` : ''
	return `${status}${parts.join(' ')}`
}

/** Decode one WS text frame into a JSON object; anything else is ignored. */
function parseFrame(data) {
	let text
	if (typeof data === 'string') text = data
	else if (data instanceof ArrayBuffer) text = Buffer.from(data).toString('utf8')
	else if (ArrayBuffer.isView(data)) text = Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8')
	else return undefined
	try {
		const parsed = JSON.parse(text)
		return parsed !== null && typeof parsed === 'object' ? parsed : undefined
	} catch {
		return undefined
	}
}

function socketErrorText(event) {
	const text = event?.error?.message ?? event?.message
	return typeof text === 'string' && text !== '' ? text : 'connection failed'
}

/**
 * Send one 说说 over a fresh short-lived WebSocket.
 *
 * @param options.url - NapCat WS endpoint, e.g. `ws://127.0.0.1:3001`.
 * @param options.token - NapCat access token, sent as `Authorization: Bearer`.
 * @param options.content - body, 1..1000 code points after trimming.
 * @param options.visibility - `public` (default) or `self`.
 * @param options.timeoutMs - whole-call budget; tests shorten it.
 * @param options.WebSocketImpl - injectable WebSocket class (default: the built-in).
 * @returns `{ tid, reply }`; `tid` is `''` when NapCat returned none.
 */
export async function sendQzonePost({ url = DEFAULT_NAPCAT_URL, token, content, visibility, timeoutMs = QZONE_TIMEOUT_MS, WebSocketImpl } = {}) {
	const SocketClass = WebSocketImpl ?? globalThis.WebSocket
	if (typeof SocketClass !== 'function') throw new QzoneError('这个 Node 没有内置 WebSocket 客户端，无法访问 NapCat', { code: 'unsupported' })
	const body = normalizeContent(content)
	const request = buildQzoneRequest({ content: body, visibility, echo: `qzone-${randomUUID()}` })
	return new Promise((resolve, reject) => {
		let settled = false
		let socket
		let timer

		const finish = (error, value) => {
			if (settled) return
			settled = true
			clearTimeout(timer)
			try {
				socket?.close()
			} catch {
				// A socket that failed to open may refuse close(); nothing left to release.
			}
			if (error === undefined) resolve(value)
			else reject(error)
		}

		timer = setTimeout(
			() => finish(new QzoneError(`${timeoutMs}ms 内没有等到 NapCat（${url}）的回包，已关闭连接`, { code: 'timeout' })),
			timeoutMs,
		)

		try {
			socket = new SocketClass(url, { headers: { Authorization: `Bearer ${token}` } })
		} catch (error) {
			finish(new QzoneError(`连不上 NapCat（${url}）：${error?.message ?? String(error)}`, { code: 'connect', cause: error }))
			return
		}

		socket.addEventListener('open', () => {
			try {
				socket.send(JSON.stringify(request))
			} catch (error) {
				finish(new QzoneError(`请求发出失败（${url}）：${error?.message ?? String(error)}`, { code: 'send', cause: error }))
			}
		})

		socket.addEventListener('message', (event) => {
			if (settled) return
			const reply = parseFrame(event?.data)
			if (reply === undefined) return
			// NapCat pushes events (group messages, notices, heartbeats) on this
			// same socket. Only a frame carrying a numeric `retcode` is an action
			// reply; reading an event as one would report a phantom send failure.
			if (typeof reply.retcode !== 'number') return
			// One call owns the connection, so an echo-less reply is still ours;
			// a mismatched echo means the frame belongs to somebody else.
			if (reply.echo !== undefined && reply.echo !== request.echo) return
			if (reply.retcode !== 0) {
				finish(new QzoneError(`QQ 空间发送失败：${describeReply(reply)}`, { code: 'retcode' }))
				return
			}
			const tid = typeof reply.data?.tid === 'string' ? reply.data.tid : ''
			finish(undefined, { tid, reply })
		})

		socket.addEventListener('error', (event) => {
			finish(new QzoneError(`连不上 NapCat（${url}）：${socketErrorText(event)}`, { code: 'connect' }))
		})

		socket.addEventListener('close', (event) => {
			finish(new QzoneError(`NapCat（${url}）在回包前关闭了连接：code=${event?.code ?? '?'}`, { code: 'closed' }))
		})
	})
}

const TOOL_DESCRIPTION = [
	'往 QQ 空间发一条说说（只有文字正文）。',
	`content 是正文，1-${MAX_CONTENT_CHARS} 个字符，首尾空白会被去掉；`,
	'visibility 只有 public（公开，默认）和 self（仅自己可见）两种。',
	'一次调用只发一条，不接受图片、也不接受指定可见名单。',
	'只有用户明确要求发空间时才调用：聊天里提到什么都不要顺手发出去。',
	'返回一行文本，含说说 tid。',
].join('')

/**
 * The `qzone_send` definition.
 *
 * @param options.url - NapCat WS endpoint from Config (`napcatUrl`).
 * @param options.token - already-read access token.
 * @param options.timeoutMs - whole-call budget; tests shorten it.
 * @param options.send - injectable transport (default {@link sendQzonePost}).
 * @param options.onSent - called after a successful post, for the audit trail; never fails the call.
 */
export function createQzoneTool({ url = DEFAULT_NAPCAT_URL, token, timeoutMs = QZONE_TIMEOUT_MS, send = sendQzonePost, onSent } = {}) {
	return defineTool({
		name: QZONE_TOOL_NAME,
		description: TOOL_DESCRIPTION,
		parameters: {
			content: { type: 'string', required: true, description: `说说正文，1-${MAX_CONTENT_CHARS} 个字符；首尾空白会被去掉，去完为空则报错` },
			visibility: { type: 'string', enum: [...VISIBILITIES], description: '可见性：public 公开（默认）/ self 仅自己可见' },
		},
		output: {
			schema: { type: 'string', description: '一行结果文本，含 tid 与可见性' },
			render(_args, value) {
				return [{ type: 'text', text: value }]
			},
		},
		timeoutMs: timeoutMs + 5_000,
		isConcurrencySafe: () => true,
		async execute(args) {
			// 说说一旦发出去就是对他好友列表的公开动作，撤不回来。群里有人在说话、
			// 或者这轮根本不是主人发起的，一律拒绝：这种话只能在一个人的私聊里说。
			if (!isPrivateOwnerTurn()) {
				throw new QzoneError('发说说只能在主人的私聊里进行；群里或别人面前我不会以主人的名义公开发言', { code: 'scope' })
			}
			const visibility = args.visibility ?? 'public'
			const result = await send({ url, token, content: args.content, visibility, timeoutMs })
			const tid = typeof result?.tid === 'string' && result.tid !== '' ? result.tid : '(NapCat 未返回 tid)'
			try {
				onSent?.({ content: args.content, visibility, tid })
			} catch {
				// The post already reached QQ 空间; a broken auditor must not report a failure.
			}
			return `已发出 QQ 空间说说：tid=${tid}，可见性=${visibility === 'self' ? '仅自己可见' : '公开'}`
		},
	})
}
