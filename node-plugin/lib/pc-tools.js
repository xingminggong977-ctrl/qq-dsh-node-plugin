/**
 * `pc_exec` / `pc_read` / `pc_write` —— 她够得到主人那台电脑，但只够得到一小块。
 *
 * 三个工具都只做一件事：往 bridge 的 `POST /node/pc/enqueue` 投一条命令，等回包。
 * bridge 负责找到那台电脑、排队、超时；插件不持有任何 PC 连接，也不在本地跑命令。
 * 契约见 `../docs/pc-bridge-protocol.md`，本文件只实现 §4 的 node-plugin 侧。
 *
 * 两类失败必须分开说，「说错了」比「失败了」更糟：
 * - 通道失败（offline / timeout / busy / 连不上 bridge）：命令没送到，或者不知道跑没跑完，
 *   抛 `PcError`，文案已经是人话；
 * - 执行失败（`state=done` 但 `result.ok=false`）：电脑好好地跑完了，是那条命令自己失败，
 *   照实转述 exitCode 与 stderr 末几行，当作正常结果返回 —— 这不是「没发出去」。
 *
 * 三个工具只在主人的私聊里注册；群聊、别人面前一个都不注册，理由见 `createPcToolGate`。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { currentTaskScope, isPrivateOwnerTurn } from './context.js'

/** 三个工具的模型可见名字；顺序即注册顺序。 */
export const PC_TOOL_NAMES = Object.freeze(['pc_exec', 'pc_read', 'pc_write'])

/** bridge 基址默认值，与 `bridgeUrl` 同机同端口。 */
export const DEFAULT_PC_BASE_URL = 'http://127.0.0.1:8787'

/** 一条命令在 bridge 上等多久；契约允许 1000..120000。 */
export const DEFAULT_PC_TIMEOUT_MS = 30_000

/** 契约 §2 的 timeoutMs 下界。 */
export const MIN_PC_TIMEOUT_MS = 1_000

/** 契约 §2 的 timeoutMs 上界。 */
export const MAX_PC_TIMEOUT_MS = 120_000

/** 心跳还算新鲜的秒数；在此之内是「刚断开」，超过才是「没开机」（契约 §3）。 */
export const JUST_LOST_SECONDS = 120

/** `read` 单次最多取回的字节数（契约 §2）。 */
export const READ_MAX_BYTES = 65_536

/** 客户端比服务端多等一会儿：先让 bridge 自己给出 timeout，再谈本地放弃。 */
const CLIENT_GRACE_MS = 15_000

/** stdout 最多转述几行，免得一条命令把这一轮的上下文吃光。 */
const STDOUT_TAIL_LINES = 20

/** 失败时 stderr 转述几行。 */
const STDERR_TAIL_LINES = 5

/** 每种 kind 在失败文案里的主语。 */
const FAILURE_SUBJECT = Object.freeze({ exec: '这条命令', read: '这次读文件', write: '这次写入' })

/** 主动查一次 `/node/pc/status` 的预算：查不到就算了，别让这次查询拖住回话。 */
const STATUS_TIMEOUT_MS = 5_000

/** 撞墙时的解释：她得知道自己撞的是哪一堵，而不是只知道「失败了」。 */
const WALLS = Object.freeze({
	not_allowlisted: '这条命令不在白名单里（能跑的是 dir / type / where / findstr / git / node / python / py / npm 和几个 Get-*，且不能带 ; & | > < 这类串联符号）',
	path_denied: '这个路径不在允许的目录里（只放 Documents / Desktop / Downloads 下面，.ssh / .git / AppData 这类一律拒）',
	too_large: '内容超过了单次传输上限（读 64KB，写 1MB）',
	timeout: '电脑上这条命令自己跑超时了（默认 30 秒）',
	spawn_failed: '命令起来了但立刻失败（多半是找不到这个可执行文件）',
	internal: '电脑端内部出错了',
})

/** A failure that already carries model-readable wording; nothing to unwrap. */
export class PcError extends Error {
	constructor(message, { code, cause } = {}) {
		super(message, cause === undefined ? undefined : { cause })
		this.name = 'PcError'
		this.code = code
	}
}

/** 把秒数说成人话；未知就用「时间未知」。 */
export function formatAge(seconds) {
	if (!Number.isFinite(seconds) || seconds < 0) return '时间未知'
	const total = Math.floor(seconds)
	if (total < 60) return `${total} 秒前`
	if (total < 3600) return `${Math.max(1, Math.floor(total / 60))} 分钟前`
	if (total < 86_400) return `${Math.floor(total / 3600)} 小时前`
	return `${Math.floor(total / 86_400)} 天前`
}

/** 把 timeoutMs 夹进契约区间；没给或不合法就用默认值。 */
export function clampPcTimeoutMs(value) {
	const n = Number(value)
	if (!Number.isFinite(n) || n <= 0) return DEFAULT_PC_TIMEOUT_MS
	return Math.min(MAX_PC_TIMEOUT_MS, Math.max(MIN_PC_TIMEOUT_MS, Math.floor(n)))
}

/**
 * 通道三态的人话。
 *
 * 「没开机」和「刚断开」不是一回事：后者他大概只是切了个网络，等十几秒就好，
 * 所以她该说「等一下再试」而不是「你电脑没开」。
 *
 * @param options.probe - `fetchPcStatus()` 的结果（可能为 null）：比 enqueue 那一刻
 * 的回包更新，所以它说什么优先。
 */
export function describeChannelFailure(state, { timeoutMs = DEFAULT_PC_TIMEOUT_MS, lastSeenSeconds, probe } = {}) {
	if (state === 'timeout') {
		return `电脑开着，但 ${Math.round(clampPcTimeoutMs(timeoutMs) / 1000)} 秒没回话，可能在忙；这条命令发出去了，不知道它跑没跑完`
	}
	if (state === 'busy') return '电脑那边手头的活还没干完（在途命令已满 4 条），这条没排上，等一会儿再试'
	if (probe?.state === 'just_lost') {
		return `电脑刚断开（最后报到 ${formatAge(probe.lastPollSeconds)}），可能正在重连，这条命令没发出去，等十几秒再试`
	}
	if (probe?.state === 'online') {
		return `电脑这会儿又连上了（${formatAge(probe.lastPollSeconds)}刚报到），刚才那条命令没发出去，重发一次就行`
	}
	// 探不到状态就退回 enqueue 那一刻的 lastSeenSeconds；探到了就以它为准。
	const age = Number.isFinite(probe?.lastPollSeconds) ? probe.lastPollSeconds : Number.isFinite(lastSeenSeconds) ? lastSeenSeconds : undefined
	if (age === undefined) return 'PC 没开机（还没报到过），这条命令没发出去'
	if (age <= JUST_LOST_SECONDS) return `电脑刚断开（最后心跳 ${formatAge(age)}），可能正在重连，这条命令没发出去，等十几秒再试`
	return `PC 没开机（最后心跳 ${formatAge(age)}），这条命令没发出去`
}

/** 撞墙说明；`error` 是电脑端那句中文原话，有就带上，别替它改口。 */
export function describeWall(errorCode, error) {
	const human = typeof error === 'string' ? error.trim() : ''
	const wall = typeof errorCode === 'string' ? WALLS[errorCode] : undefined
	if (wall === undefined) return human === '' ? '电脑没说是为什么' : human
	return human === '' ? wall : `${wall}（电脑原话：${human}）`
}

/** 取文本末尾几行；不改变原文，只截断。 */
export function tailLines(text, count) {
	const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
	while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
	if (lines.length <= count) return lines.join('\n')
	return lines.slice(-count).join('\n')
}

/** 结果体里的正文（契约 §2：read 的内容也放在 stdout）。 */
function resultText(result) {
	return typeof result?.stdout === 'string' ? result.stdout : ''
}

/** 秒数说成「1.2 秒」这种短形式；耗时只用于附注。 */
function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return undefined
	return ms < 1000 ? `${Math.round(ms)} 毫秒` : `${(ms / 1000).toFixed(1)} 秒`
}

/** `exec` 成功时的转述：exitCode + stdout 末尾 + stderr 末尾。 */
export function describeExecResult(result) {
	const code = Number.isFinite(result?.exitCode) ? result.exitCode : 0
	const duration = formatDuration(result?.durationMs)
	const lines = [`电脑上跑完了（exitCode=${code}${duration === undefined ? '' : `，耗时 ${duration}`}）`]
	const stdout = resultText(result)
	if (stdout.trim() === '') lines.push('没有任何输出')
	else lines.push(tailLines(stdout, STDOUT_TAIL_LINES))
	if (result?.truncated === true) lines.push('（输出太长，上面只是末尾一段）')
	const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
	if (stderr.trim() !== '') lines.push(`stderr 末尾：\n${tailLines(stderr, STDERR_TAIL_LINES)}`)
	return lines.join('\n')
}

/** `read` 成功时的转述：路径 + 字节数 + 正文。 */
export function describeReadResult(result, path) {
	const text = resultText(result)
	const bytes = Number.isFinite(result?.bytes) ? result.bytes : undefined
	const size = bytes === undefined ? '' : `，${bytes} 字节`
	const cut = result?.truncated === true ? `（文件超过单次 ${READ_MAX_BYTES} 字节，只给了截断后的内容）` : ''
	return `${path} 读到了${size}${cut}：\n${text}`
}

/** `write` 成功时的转述 ── 只有真的拿到了 done 才敢说「写好了」。 */
export function describeWriteResult(result, { path, append }) {
	const bytes = Number.isFinite(result?.bytes) ? result.bytes : undefined
	return `已${append === true ? '追加写入' : '覆盖写入'} ${path}${bytes === undefined ? '' : `（${bytes} 字节）`}`
}

/** `result.ok === false` 的人话：通道好好的，是电脑上那一下失败了。 */
export function describePcFailure(kind, result) {
	const subject = FAILURE_SUBJECT[kind] ?? '这次操作'
	const code = Number.isFinite(result?.exitCode) ? result.exitCode : undefined
	const head = code === undefined ? `电脑上${subject}失败了` : `电脑上${subject}失败了（exitCode=${code}）`
	const lines = [`${head}：${describeWall(result?.errorCode, result?.error)}`]
	const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
	if (stderr.trim() !== '') lines.push(`stderr 末尾：\n${tailLines(stderr, STDERR_TAIL_LINES)}`)
	const stdout = resultText(result)
	if (stderr.trim() === '' && stdout.trim() !== '') lines.push(`输出末尾：\n${tailLines(stdout, STDERR_TAIL_LINES)}`)
	lines.push('（这是电脑上那条命令自己失败了，通道没坏：命令送到了，也跑过了）')
	return lines.join('\n')
}

/** 预算信号：本地 deadline 与调用方的取消信号取先到的那个。 */
function deadlineSignal(signal, ms) {
	const timeout = AbortSignal.timeout(ms)
	if (signal === undefined || signal === null || typeof AbortSignal.any !== 'function') return timeout
	return AbortSignal.any([timeout, signal])
}

/**
 * 往 bridge 投一条命令并等回包。
 *
 * 只归一化「通道」这一层：`{ state:'done', result }`，或者
 * `{ state:'offline'|'timeout'|'busy', lastSeenSeconds, error }`。
 * 连不上 bridge、HTTP 非 2xx、回包不是 JSON 都抛 `PcError` ——
 * 这些是「云端那条路断了」，绝不能说成「PC 没开机」。
 */
export async function enqueuePc({ baseUrl = DEFAULT_PC_BASE_URL, token, kind, payload, timeoutMs = DEFAULT_PC_TIMEOUT_MS, fetchImpl, signal }) {
	const budget = clampPcTimeoutMs(timeoutMs)
	const doFetch = fetchImpl ?? globalThis.fetch
	if (typeof doFetch !== 'function') throw new PcError('这个 Node 没有内置 fetch，够不到 cloud bridge', { code: 'unsupported' })
	const url = `${String(baseUrl ?? '').trim().replace(/\/+$/, '')}/node/pc/enqueue`
	let response
	try {
		response = await doFetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${String(token ?? '')}` },
			body: JSON.stringify({ kind, payload, timeoutMs: budget }),
			signal: deadlineSignal(signal, budget + CLIENT_GRACE_MS),
		})
	} catch (error) {
		throw new PcError(`连不上 cloud bridge（${url}）：${error?.message ?? String(error)}`, { code: 'transport', cause: error })
	}
	if (response.ok !== true) {
		throw new PcError(`cloud bridge 拒了这次请求（HTTP ${response.status}）：这是插件到 bridge 的那一段出了问题，不是电脑没开机`, { code: 'http' })
	}
	let body
	try {
		body = await response.json()
	} catch (error) {
		throw new PcError('cloud bridge 回的不是 JSON，这次命令没法确认结果', { code: 'protocol', cause: error })
	}
	if (body === null || typeof body !== 'object') throw new PcError('cloud bridge 回了空包，这次命令没法确认结果', { code: 'protocol' })
	const state = typeof body.state === 'string' ? body.state : body.ok === true ? 'done' : 'offline'
	if (state === 'done') return { state, id: body.id, result: body.result ?? null }
	return { state, id: body.id, error: body.error, lastSeenSeconds: body.lastSeenSeconds }
}

/**
 * 主动问 bridge「电脑现在什么样」（契约 §3 的三态）。
 *
 * 只在 `offline` 那条路上用：心跳刚过期和真的没开机说的话不一样，而 enqueue 的回包
 * 只带那一刻的 `lastSeenSeconds`。任何失败都返回 `null` —— 这是一次锦上添花的查询，
 * 不能因为它把「命令没发出去」变成别的错。
 */
export async function fetchPcStatus({ baseUrl = DEFAULT_PC_BASE_URL, token, fetchImpl, signal } = {}) {
	const doFetch = fetchImpl ?? globalThis.fetch
	if (typeof doFetch !== 'function') return null
	const url = `${String(baseUrl ?? '').trim().replace(/\/+$/, '')}/node/pc/status`
	try {
		const response = await doFetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${String(token ?? '')}` },
			signal: deadlineSignal(signal, STATUS_TIMEOUT_MS),
		})
		if (response.ok !== true) return null
		const body = await response.json()
		if (body === null || typeof body !== 'object') return null
		return {
			state: typeof body.state === 'string' ? body.state : '',
			lastPollSeconds: body.lastPollSeconds,
			lastHeartbeatSeconds: body.lastHeartbeatSeconds,
		}
	} catch {
		return null
	}
}

/**
 * 三个工具只在「主人 + 私聊」那一轮里才该存在。
 *
 * 群还是私聊，只有走到某一轮才知道（`lib/context.js` 的 AsyncLocalStorage），
 * 所以注册不发生在 `apply()`，而发生在 `agent/inbox/inserted`：那一刻还在
 * `runInTaskScope()` 的调用栈里，场景读得到；而它又早于这一轮的任何一次请求装配，
 * 所以她第一句就看得见（或看不见）这三个工具。私聊和群本来就是两个 agent session，
 * 于是群里从头到尾一个都不注册。
 *
 * @param options.baseUrl - cloud bridge 基址。
 * @param options.token - node token，正是 `/node/pc/*` 的 bearer。
 * @param options.timeoutMs - 单条命令等待预算。
 * @param options.fetchImpl - 可注入的 fetch，测试用。
 * @param options.log - 诊断行出口。
 */
export function createPcToolGate({ baseUrl = DEFAULT_PC_BASE_URL, token, timeoutMs = DEFAULT_PC_TIMEOUT_MS, fetchImpl, log = () => {} } = {}) {
	const live = new Map()

	function forget(agentId) {
		const dispose = live.get(agentId)
		if (dispose === undefined) return false
		live.delete(agentId)
		try {
			dispose()
		} catch (error) {
			log('warn', `qq-node: 撤销 pc 工具注册时出错：${error?.message ?? String(error)}`)
		}
		return true
	}

	function idOf(agent) {
		const id = agent?.id
		if (typeof id === 'string') return id
		return id === undefined || id === null ? '' : String(id)
	}

	return {
		/**
		 * 这一轮该有就有、不该有就撤掉；返回最终是否有注册。
		 * @param agent - `agent/inbox/inserted` 事件里的那个 agent。
		 */
		admit(agent) {
			const agentId = idOf(agent)
			if (agentId === '') return false
			// 读的是这一轮的真实场景：群里、或者不是主人，立刻撤干净。
			if (!isPrivateOwnerTurn()) {
				forget(agentId)
				return false
			}
			if (live.has(agentId)) return true
			const tools = agent?.ctx?.get?.('tools')
			if (tools === undefined || tools === null || typeof tools.register !== 'function') {
				log('warn', 'qq-node: this agent has no tools service, so the pc tools are not registered')
				return false
			}
			const disposers = createPcTools({ baseUrl, token, timeoutMs, fetchImpl }).map((tool) => tools.register(tool))
			live.set(agentId, () => {
				for (const dispose of disposers) dispose()
			})
			return true
		},
		/** agent 走了，把它的注册也带走。 */
		release(agent) {
			return forget(idOf(agent))
		},
		/** 插件卸载时清干净。 */
		disposeAll() {
			for (const agentId of [...live.keys()]) forget(agentId)
		},
		/** 当前挂着注册的 agent 数量（诊断与测试用）。 */
		get size() {
			return live.size
		},
	}
}

const EXEC_DESCRIPTION = [
	'在主人的电脑上执行一条命令（不是云端：命令转发到他那台 Windows 上跑，输出原样回来）。',
	'返回的文本分四种情况，别混为一谈：',
	'1)「PC 没开机（最后心跳 N 分钟前），这条命令没发出去」——电脑关着或代理没在跑，命令根本没送出去；',
	'2)「电脑刚断开（最后心跳 N 秒前），可能正在重连」——刚掉线，等十几秒再试就行；',
	'3)「电脑开着，但 30 秒没回话，可能在忙」——发出去了但没回话，不知道跑没跑完；',
	'4)「电脑上这条命令失败了（exitCode=N）」——通道和电脑都正常，是这条命令自己失败了，',
	'   会带上 exitCode 与 stderr 末几行，照实转述，不要改口说成「没发出去」；',
	'5)「电脑这会儿又连上了，重发一次就行」——刚才判离线那一刻去查，它已经回来了。',
	'命令受白名单限制（dir/type/where/findstr/git/node/python/npm/Get-* 等，且不能串 ; & | > <），',
	'路径受目录白名单限制（Documents/Desktop/Downloads 内，.ssh/.git/AppData 之类一律拒）；',
	'被拒时会明确说是撞了哪一条，不要猜。',
].join('\n')

const READ_DESCRIPTION = [
	'读主人电脑上的一个文本文件（不是云端）。返回文件内容。',
	`单次最多 ${READ_MAX_BYTES} 字节，超过就只给截断后的内容。`,
	'路径受白名单限制：只允许 Documents / Desktop / Downloads 下面，.ssh / .git / AppData 这类一律拒。',
	'通道三态照样适用：「PC 没开机…」「电脑刚断开…」「电脑开着，但 30 秒没回话…」都是通道问题，文件没读到；',
	'「这个路径不在允许的目录里」是被白名单挡了 —— 换路径或者去问主人。',
].join('\n')

const WRITE_DESCRIPTION = [
	'在主人电脑上写一个文本文件（覆盖或追加，不是云端）。',
	'路径受白名单限制：只允许 Documents / Desktop / Downloads 下面；.ssh / .git / AppData 与 .exe/.bat/.ps1 这类一律拒。',
	'「PC 没开机…」「电脑刚断开…」「电脑开着，但 30 秒没回话…」是通道问题，文件没写进去 ——',
	'这几种情况绝对不要说「已经写好了」。只有拿到执行成功，才可以说写进去了。',
].join('\n')

/** 命令/路径这类必填字符串：不允许空串冒充内容。 */
function requireText(value, label) {
	if (typeof value !== 'string') throw new PcError(`${label} 必须是字符串`, { code: label })
	const text = value.trim()
	if (text === '') throw new PcError(`${label} 不能为空`, { code: label })
	return text
}

/**
 * 三个工具的最后一道门：不在「主人私聊」这一轮里，一个都不许跑。
 *
 * 注册时机已经保证了这一点，但门不能只靠前一环；没有场景（调度器、别处直接调用）
 * 按不是主人私聊处理 —— 这是 `lib/context.js` 一贯的默认拒绝。
 */
function assertOwnerPrivate() {
	if (isPrivateOwnerTurn()) return
	const scope = currentTaskScope()
	const where = scope === null ? '这一轮不在任何 QQ 会话里' : scope.group === true ? '这是在群里' : '这一轮不是主人发起的'
	throw new PcError(`${where}：电脑上的命令只在主人的私聊里执行，别的地方我不碰他那台电脑`, { code: 'scope' })
}

/**
 * 三个工具的定义。
 *
 * @param options.baseUrl - cloud bridge 基址（`pcBaseUrl`）。
 * @param options.token - node token（`nodeToken`）。
 * @param options.timeoutMs - 单条命令等待预算（`pcTimeoutMs`）。
 * @param options.fetchImpl - 可注入的 fetch，测试用。
 */
export function createPcTools({ baseUrl = DEFAULT_PC_BASE_URL, token, timeoutMs = DEFAULT_PC_TIMEOUT_MS, fetchImpl } = {}) {
	const budget = clampPcTimeoutMs(timeoutMs)

	async function call(kind, payload, signal) {
		const envelope = await enqueuePc({ baseUrl, token, kind, payload, timeoutMs: budget, fetchImpl, signal })
		if (envelope.state !== 'done') {
			// offline 时再主动查一次状态：「刚断开」和「没开机」说的话不一样。
			const probe = envelope.state === 'offline' ? await fetchPcStatus({ baseUrl, token, fetchImpl, signal }) : null
			// 通道失败：命令没送到，或者不知道跑没跑。文案直接给人看。
			throw new PcError(describeChannelFailure(envelope.state, { timeoutMs: budget, lastSeenSeconds: envelope.lastSeenSeconds, probe }), { code: envelope.state })
		}
		if (envelope.result === null || typeof envelope.result !== 'object') {
			throw new PcError('cloud bridge 说做完了，却没带回结果（契约被破了）', { code: 'protocol' })
		}
		return envelope.result
	}

	return [
		defineTool({
			name: 'pc_exec',
			description: EXEC_DESCRIPTION,
			parameters: {
				command: { type: 'string', required: true, description: '要在电脑上执行的命令，例如 `git status` 或 `dir`；不能带 ; & | > < 串联' },
				cwd: { type: 'string', description: '工作目录，必须在白名单目录内；省略则用电脑那边的默认目录' },
			},
			output: {
				schema: { type: 'string', description: '电脑上的输出摘要，含 exitCode' },
				render(_args, value) {
					return [{ type: 'text', text: value }]
				},
			},
			timeoutMs: budget + CLIENT_GRACE_MS + 5_000,
			async execute(args, exec) {
				assertOwnerPrivate()
				const command = requireText(args?.command, 'command')
				const cwd = typeof args?.cwd === 'string' ? args.cwd.trim() : ''
				const result = await call('exec', { command, ...(cwd === '' ? {} : { cwd }), timeoutMs: budget }, exec?.signal)
				if (result.ok === false) return describePcFailure('exec', result)
				return describeExecResult(result)
			},
		}),
		defineTool({
			name: 'pc_read',
			description: READ_DESCRIPTION,
			parameters: {
				path: { type: 'string', required: true, description: '电脑上的完整路径，例如 C:\\Users\\lenovo\\Documents\\note.md' },
			},
			output: {
				schema: { type: 'string', description: '文件内容，或一句说明为什么没读到' },
				render(_args, value) {
					return [{ type: 'text', text: value }]
				},
			},
			timeoutMs: budget + CLIENT_GRACE_MS + 5_000,
			isConcurrencySafe: () => true,
			async execute(args, exec) {
				assertOwnerPrivate()
				const path = requireText(args?.path, 'path')
				const result = await call('read', { path, maxBytes: READ_MAX_BYTES }, exec?.signal)
				if (result.ok === false) return describePcFailure('read', result)
				return describeReadResult(result, path)
			},
		}),
		defineTool({
			name: 'pc_write',
			description: WRITE_DESCRIPTION,
			parameters: {
				path: { type: 'string', required: true, description: '电脑上的完整路径，例如 C:\\Users\\lenovo\\Documents\\note.md' },
				content: { type: 'string', required: true, description: '要写入的正文，原样写入（不 trim）' },
				append: { type: 'boolean', description: 'true 追加到文件末尾，false 或省略则整份覆盖' },
			},
			output: {
				schema: { type: 'string', description: '一句确认，或一句说明为什么没写进去' },
				render(_args, value) {
					return [{ type: 'text', text: value }]
				},
			},
			timeoutMs: budget + CLIENT_GRACE_MS + 5_000,
			async execute(args, exec) {
				assertOwnerPrivate()
				const path = requireText(args?.path, 'path')
				if (typeof args?.content !== 'string') throw new PcError('content 必须是字符串', { code: 'content' })
				const append = args.append === true
				const result = await call('write', { path, content: args.content, append }, exec?.signal)
				if (result.ok === false) return describePcFailure('write', result)
				return describeWriteResult(result, { path, append })
			},
		}),
	]
}
