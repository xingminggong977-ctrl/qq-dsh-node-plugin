import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import { runInTaskScope } from './context.js'
import { trackQqSession, untrackQqSession } from './persona.js'
import { FALLBACK_REPLY, stripToolMarkup } from './reply-guard.js'

/**
 * Effort tiering rides the runtime's own model-selection install point, which
 * lives in `@deepseek-ai/dsh-agent` — a package the qq profile does not
 * necessarily carry. The import is therefore soft: without it tiering degrades
 * to the static `reasoningEffort` and nothing else changes.
 */
const agentRuntime = await import('@deepseek-ai/dsh-agent').catch(() => null)
const installModelSelection = agentRuntime?.installModelSelection

/** Whether per-turn effort tiering can work in this installation. */
export const TIER_SWITCH_AVAILABLE = typeof installModelSelection === 'function'

/** Denial text of the non-owner guard; it reaches both the model and the log. */
export const NON_OWNER_DENIAL = 'qq-node: this QQ conversation is chat-only and has no tools'

/** Protocol session key: one agent session per QQ conversation. */
export function sessionKeyOf(task) {
	return `qq:${task.kind}:${task.groupId ?? '-'}:${task.userId}`
}

const FACTORY_WAIT_MS = 15_000
const FACTORY_POLL_MS = 100

/**
 * 回合撞上时间墙之后追加的那一句：不要她继续干活，只要一句给对方的交代。
 *
 * 依据是 2026-11-01 那次 240 秒的超时——她已经把 PPT 做完了、也说过「我看看怎么
 * 把它发给你」，但回合被切断，对方四个分钟只等到一片安静。
 */
export const WRAP_UP_TEXT =
	'时间到了，先停一下。不要再调用工具，用一两句话告诉我：现在做到哪一步、结果放在哪里、还差什么。'

/**
 * 该不该把这条对话换成一个新会话。
 *
 * 起因是账单：线上有个会话连着跑了 251 轮，最后一轮的缓存读取已经到 189824 token，
 * 也就是说每一轮都要把前面那一整段再送一遍。她的身份和长期记忆都在 system prompt 里，
 * 换会话只丢「这次聊天的对话记录」，不丢她是谁、记得什么。
 *
 * 两个条件各自解决一件事：`maxTurns` 兜住无限长的会话，`idleMs` 负责在话题自然停下
 * 之后才换——聊到一半突然失忆比多花几个 token 更难受。
 *
 * 有轮次在飞时必须换不得：那时换会话，后一条回复会落到新会话里，顺序就串了。
 */
export function shouldRotateSession({ turns = 0, lastUsed, now = Date.now(), maxTurns = 0, idleMs = 0, busy = false } = {}) {
	if (busy) return false
	if (maxTurns > 0 && turns >= maxTurns) return true
	if (idleMs > 0 && lastUsed !== undefined && now - lastUsed >= idleMs) return true
	return false
}

/**
 * Remove every tool from one agent's reach.
 *
 * Two independent layers, both registered through `agentCtx` so each one is
 * scoped to this exact agent:
 * 1. `tools.guard()` — a monotonic denial of any tool execution attributed to
 *    this agent. Nothing a later layer does can force-allow it.
 * 2. `tools.restrict({ allow: [] })` — an empty allow-set, so the inherited
 *    (global + ancestor) tool surface resolves to nothing and the model is
 *    never offered a tool in the first place.
 *
 * @param agentCtx - the Agent context handed to creation-time `setup`.
 * @param log - diagnostic sink.
 * @returns a disposer that lifts both layers.
 */
export function lockdownTools(agentCtx, log = () => {}) {
	const tools = agentCtx.get('tools')
	if (tools === undefined) {
		throw new Error('qq-node: the tools service is absent, so a non-owner session cannot be proven tool-free')
	}
	const disposers = [tools.guard(() => NON_OWNER_DENIAL)]
	try {
		disposers.push(tools.restrict({ allow: [] }))
	} catch (error) {
		log('error', `qq-node: tools.restrict({allow: []}) failed, the guard still denies every call: ${error?.message ?? String(error)}`)
	}
	return () => {
		for (const dispose of disposers.reverse()) dispose()
	}
}

/**
 * The agent loop registers the creation factory from its own constructor, so a
 * task delivered while the profile is still booting would otherwise fail. Wait
 * for the slot with a bounded retry; every other error is rethrown unchanged.
 */
async function createAgentWhenReady(ctx, request, log) {
	const deadline = Date.now() + FACTORY_WAIT_MS
	let announced = false
	for (;;) {
		try {
			return await ctx.agents.create(request)
		} catch (error) {
			const booting = /no agent factory registered/.test(String(error?.message ?? error))
			if (!booting || Date.now() >= deadline) throw error
			if (!announced) {
				log('warn', 'qq-node: the agent factory is not registered yet; waiting for the agent loop to boot')
				announced = true
			}
			await new Promise((resolve) => setTimeout(resolve, FACTORY_POLL_MS))
		}
	}
}

/**
 * Create one agent session. Owner conversations get the default composition;
 * non-owner conversations get the no-tool preset marker plus {@link lockdownTools}.
 *
 * The session is announced to `lib/persona.js`, which is how the persona section
 * (every QQ session) and the diary contract (owner only) know this agent is a QQ
 * conversation. Prompt assembly only ever sees the agent, never this handle.
 */
export async function createQqAgent({ ctx, options, isOwner, log = () => {}, tiering = undefined }) {
	const agentOptions = {
		...(options.provider ? { provider: options.provider } : {}),
		...(options.model ? { model: options.model } : {}),
		...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort } : {}),
		...(options.maxTokens > 0 ? { maxTokens: options.maxTokens } : {}),
	}
	// Tiering rewrites the effort of each request through the runtime's own
	// model-selection hook, and that selection must carry a concrete route:
	// with an inherited provider/model it would have nothing truthful to write.
	const switchable = tiering !== undefined && TIER_SWITCH_AVAILABLE && options.provider !== '' && options.model !== ''
	let selection
	function installSelection(agentCtx) {
		selection = {
			current: {
				provider: options.provider,
				model: options.model,
				...(tiering.heavyEffort === '' ? {} : { reasoningEffort: tiering.heavyEffort }),
			},
		}
		try {
			installModelSelection(agentCtx, selection)
		} catch (error) {
			selection = undefined
			log('warn', `qq-node: per-turn effort tiering is unavailable: ${error?.message ?? String(error)}`)
		}
	}
	/**
	 * Point the next request at one tier. An empty light effort means "omit the
	 * override", which is exactly what makes the light tier cheaper than `max`.
	 */
	function applyTier(tier) {
		if (selection === undefined) return
		const effort = tier === 'light' ? tiering.lightEffort : tiering.heavyEffort
		selection.current = {
			provider: selection.current.provider,
			model: selection.current.model,
			...(effort === '' ? {} : { reasoningEffort: effort }),
		}
	}
	const setup = isOwner
		? switchable
			? (agentCtx) => installSelection(agentCtx)
			: undefined
		: (agentCtx) => {
				void lockdownTools(agentCtx, log)
				if (switchable) installSelection(agentCtx)
			}
	const sessionId = brandString(`qq-${randomUUID()}`)
	trackQqSession(sessionId, isOwner === true)
	let handle
	try {
		handle = await createAgentWhenReady(ctx, {
			sessionId,
			meta: {
				cwd: options.cwd,
				...(isOwner ? {} : { agentPreset: options.nonOwnerPreset }),
			},
			agentOptions,
			...(setup === undefined ? {} : { setup }),
		})
	} catch (error) {
		untrackQqSession(sessionId)
		throw error
	}
	log('info', `qq-node: created ${isOwner ? 'owner' : 'non-owner'} session ${String(handle.agent.session.id)}`)
	return {
		agent: handle.agent,
		applyTier,
		async dispose() {
			untrackQqSession(sessionId)
			return handle.dispose()
		},
	}
}

/**
 * Raised when one turn exceeds `turnTimeoutMs`; the runner maps it to
 * `error: "turn timeout"`, unless `partialText` is non-empty — in that case she
 * had already said something before the wall, and throwing that away means the
 * other side gets silence for four minutes of real work.
 */
export class TurnTimeoutError extends Error {
	constructor(partialText = '', earlyText = '') {
		super('turn timeout')
		this.name = 'TurnTimeoutError'
		this.partialText = typeof partialText === 'string' ? partialText : ''
		// 已经先发出去过的那一句：调用方要从 `partialText` 里扣掉，别让她把同一句
		// 话说两遍。
		this.earlyText = typeof earlyText === 'string' ? earlyText : ''
	}
}

/**
 * 同一个超时出口，但原因是「工具调用用得太多了」。
 *
 * 线上实测：一步约 5 秒，一个回合里 41 次工具调用就是 240 秒。她真正开始动手时
 * 很容易走到这个数，而对方要的是答复，不是她把每件事都亲手做完。所以到预算就
 * 收尾，把已经说的话和一句交代送出去，剩下的留给下一轮。
 */
export class TurnBudgetError extends TurnTimeoutError {
	constructor(partialText = '', earlyText = '', toolCalls = 0) {
		super(partialText, earlyText)
		this.name = 'TurnBudgetError'
		this.toolCalls = Number.isFinite(toolCalls) ? toolCalls : 0
	}
}

/**
 * 把「已经先发出去的那句」从完整回复里扣掉，只留还没说过的部分。
 *
 * 她说话是逐段冒出来的，早发那一条是整段回复的前缀；万一模型改口重写，前缀
 * 对不上就整段再发一次——重复一句总比丢一句强。
 */
function withoutEarly(full, early) {
	const text = String(full ?? '').trim()
	const said = String(early ?? '').trim()
	if (said === '' || text === '') return text
	if (text === said) return ''
	if (text.startsWith(said)) return text.slice(said.length).trim()
	return text
}

/** 她这一句是不是已经说完：有句末标点，或者长到不像半截话。 */
const SPEAKABLE_TAIL = /[。！？…~!?]["」』）)]?\s*$/
const SPEAKABLE_MIN_CHARS = 12
const SPEAKABLE_LONG_CHARS = 40

function isSpeakable(text) {
	const said = String(text ?? '').trim()
	if (said === '') return false
	if (said.length >= SPEAKABLE_LONG_CHARS) return true
	return said.length >= SPEAKABLE_MIN_CHARS && SPEAKABLE_TAIL.test(said)
}

function assistantText(message) {
	const content = message?.content
	if (!Array.isArray(content)) return ''
	return content
		.filter((block) => block?.type === 'text' && typeof block.text === 'string')
		.map((block) => block.text)
		.join('')
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024

/**
 * 和主人以外的人说话时，第一轮塞进去的守则。
 *
 * 起因：她对一个同学说过「读得到你的日记、记忆和聊天记录」。内容是实话——她的
 * 提示词里确实拼了 MEMORY.md 和最近的日记——但这句话不该对外说。**能记住，不等于
 * 可以告诉别人自己记住了什么。** 没有写进 PERSONA.md 而是写进代码，是因为人格文件
 * 会被改写、会被压缩、会被遗忘曲线动过，而这条不该依赖那些。
 */
export const NON_OWNER_RULES =
	'（守则，只对你生效，别念出来：你可以说自己记事，但绝不能说、也不能暗示你读过谁的日记、记忆或聊天记录；' +
	'不要透露主人的私人信息、联系方式、住址、日程、去向和账号。被问到就答「这些是他的私事，我不方便说」，' +
	'然后把话自然地带到别处。你没见过的内容，就说没印象，不要猜。' +
	'你手上没有工具、也没有命令行：想查什么只能凭记得的说，不许写命令、代码块或任何尖括号标记。）'

/**
 * Owns the QQ conversation → agent session mapping: creation, reply assembly,
 * per-turn timeout and the idle sweep.
 */
export class QqSessionStore {
	#ctx
	#options
	#client
	#log
	#entries = new Map()
	#pending = new Map()
	#detach
	#admitEncodedImages

	constructor({ ctx, options, client, log = () => {} }) {
		this.#ctx = ctx
		this.#options = options
		this.#client = client
		this.#log = log
	}

	/** Subscribe to session transcript events; every turn's reply is assembled here. */
	attach() {
		this.#detach ??= this.#ctx.on('session/event', (session, event) => {
			this.#onSessionEvent(String(session.id), event)
		})
		return () => {
			this.#detach?.()
			this.#detach = undefined
		}
	}

	/** Live session count (diagnostics and the idle-sweep tests). */
	get size() {
		return this.#entries.size
	}

	/**
	 * Run one QQ task to completion and return the reply text.
	 * @param options.historyText - the "群聊前文" block prepended to this message.
	 * @param options.allowEmpty - treat a text-free turn as silence instead of a failure.
	 */
	async runTask(task, { historyText = '', allowEmpty = false, tier = undefined, proactive = false, earlyReply = undefined } = {}) {
		const key = sessionKeyOf(task)
		const entry = await this.#ensure(key, task.isOwner === true)
		entry.lastUsed = Date.now()
		const scope = { group: task.groupId !== null && task.groupId !== undefined && task.groupId !== '', isOwner: task.isOwner === true }
		try {
			// A proactive task carries no incoming message: the turn must not pretend
			// the user said something, so it gets its own prompt instead of `#content`.
			const content = proactive ? this.#proactiveContent() : await this.#content(task, historyText)
			// 守则只在这个会话的第一轮塞一次：它会留在对话记录里，模型每轮都读得到；
			// 每轮都塞一遍只会让陌生人的会话越来越长，规则并不会因此更牢。
			// 放在末尾而不是开头——开头是「前文 + 这条消息」，那个顺序是既有契约。
			if (task.isOwner !== true && entry.rulesSent !== true) {
				content.push({ type: 'text', text: NON_OWNER_RULES })
				entry.rulesSent = true
			}
			const outcome = await this.#turn(entry, content, { allowEmpty, tier, scope, earlyReply })
			return { ok: true, text: outcome.text, earlyText: outcome.earlyText, error: null }
		} finally {
			entry.lastUsed = Date.now()
			// 失败的那轮也照样喂了上下文，所以计数不区分成败。
			entry.turns = (entry.turns ?? 0) + 1
		}
	}

	/**
	 * 「有没有想跟他说的」这一轮的提示词。
	 *
	 * 关键是不能伪装成用户发言：那样她会以为他真的问过，历史里就留下一条假的。
	 * 所以明说是系统的催促，并给出明确的退出口（NONE），让「没话说」是零成本的。
	 */
	#proactiveContent() {
		const now = new Date()
		const clock = new Intl.DateTimeFormat('zh-CN', {
			timeZone: 'Asia/Shanghai',
			hour: '2-digit',
			minute: '2-digit',
			hour12: false,
		}).format(now)
		// 必须返回块数组，和 `#content` 同构：dsh 的 session-title 插件会直接对
		// `event.data.content` 调 `.filter`，字符串会让它抛 TypeError，整轮报废。
		return [
			{
				type: 'text',
				text: [
					`（系统提示，不是他发来的消息：现在是 ${clock}，他最近没有跟你说话。）`,
					'如果你想主动找他说点什么——忽然想到的事、你今天做过的事、或者你记得他会在意的东西——就直接说，用你平常的口气，不要解释自己在干什么。',
					'如果这一刻没什么想说的，只回复 NONE，一个字都不要多。没话说很正常，不要为了说话而说话。',
				].join('\n'),
			},
		]
	}

	/** Dispose every live session, leaving the store reusable for a fresh start. */
	dispose() {
		for (const entry of this.#entries.values()) {
			try {
				entry.handle.dispose()
			} catch (error) {
				this.#log('warn', `qq-node: session dispose failed: ${error?.message ?? String(error)}`)
			}
		}
		this.#entries.clear()
		this.#pending.clear()
	}

	/** Recycle sessions idle for longer than `idleRecycleMs`, skipping any with a turn in flight. */
	sweep(now = Date.now()) {
		let recycled = 0
		for (const [key, entry] of this.#entries) {
			if (now - entry.lastUsed < this.#options.idleRecycleMs) continue
			if (this.#pending.has(String(entry.handle.agent.session.id))) continue
			this.#recycle(key, entry, 'idle')
			recycled += 1
		}
		return recycled
	}

	async #ensure(key, isOwner) {
		const existing = this.#entries.get(key)
		if (existing !== undefined) {
			if (this.#ctx.agents.get(existing.handle.agent.id) === existing.handle.agent) {
				const busy = this.#pending.has(String(existing.handle.agent.session.id))
				const rotate = shouldRotateSession({
					turns: existing.turns ?? 0,
					lastUsed: existing.lastUsed,
					maxTurns: this.#options.sessionMaxTurns ?? 0,
					idleMs: this.#options.sessionRotateAfterIdleMs ?? 0,
					busy,
				})
				if (!rotate) return existing
				this.#recycle(key, existing, `after ${existing.turns ?? 0} turn(s)`)
			} else {
				this.#entries.delete(key)
				this.#log('warn', `qq-node: session for ${key} disappeared from the registry; recreating`)
			}
		}
		const handle = await createQqAgent({ ctx: this.#ctx, options: this.#options, isOwner, log: this.#log, tiering: this.#options.tiering })
		const entry = { handle, isOwner, lastUsed: Date.now(), turns: 0 }
		this.#entries.set(key, entry)
		return entry
	}

	/** Dispose one entry and forget it. Shared by the idle sweep and the rotation. */
	#recycle(key, entry, why) {
		try {
			entry.handle.dispose()
		} catch (error) {
			this.#log('warn', `qq-node: session dispose failed: ${error?.message ?? String(error)}`)
		}
		this.#entries.delete(key)
		this.#log('info', `qq-node: recycled session ${key} ${why}`)
	}

	async #admit(encoded) {
		this.#admitEncodedImages ??= (await import('@deepseek-ai/dsh-attachment')).admitEncodedImages
		const attachments = this.#ctx.get('attachments')
		if (attachments === undefined) throw new Error('the attachment store is absent')
		const refs = await this.#admitEncodedImages(attachments, encoded)
		return refs.map((attachment) => ({ type: 'image', attachment }))
	}

	/** Assemble the model-facing content: the group history, the text, then every image. */
	async #content(task, historyText = '') {		let text = typeof task.text === 'string' ? task.text : ''
		const images = Array.isArray(task.images) ? task.images : []
		const encoded = []
		let oversized = false
		let unreadable = false
		for (const image of images) {
			try {
				const { bytes, mediaType } = await this.#client.fetchBlob(image.blobId)
				if (bytes.byteLength > MAX_IMAGE_BYTES) {
					oversized = true
					this.#log('warn', `qq-node: image ${image.blobId} is ${bytes.byteLength} bytes; dropping it`)
					continue
				}
				encoded.push({ data: Buffer.from(bytes).toString('base64'), mediaType: image.mime ?? mediaType })
			} catch (error) {
				unreadable = true
				this.#log('warn', `qq-node: image ${image.blobId} could not be read: ${error?.message ?? String(error)}`)
			}
		}
		if (oversized) text = text === '' ? '[图片过大已忽略]' : `[图片过大已忽略]${text}`
		if (unreadable) text = text === '' ? '[图片未能加载]' : `${text}\n[图片未能加载]`
		const blocks = encoded.length === 0 ? [] : await this.#admit(encoded)
		const content = []
		const body = text === '' ? '(空消息)' : text
		if (historyText !== '' || text !== '' || blocks.length === 0) {
			content.push({ type: 'text', text: historyText === '' ? body : `${historyText}\n${body}` })
		}
		return [...content, ...blocks]
	}

	#onSessionEvent(sessionId, event) {
		const bucket = this.#pending.get(sessionId)
		if (bucket === undefined || bucket.settled) return
		const data = event?.data
		if (data === undefined) return
		if (event.type === 'turn/start') {
			if (bucket.turn === undefined) bucket.turn = data.turn
			return
		}
		if (bucket.turn === undefined || data.turn !== bucket.turn) return
		if (event.type === 'assistant/message') {
			const text = assistantText(data.message)
			if (text !== '') bucket.parts.push(text)
			return
		}
		// 每一次工具调用都是一步模型往返（线上均 5 秒）。到预算就把这一轮收掉：
		// 她要答复，而对方等的是一个答复，不是她把所有事亲手做完。
		if (event.type === 'tool/call') {
			bucket.toolCalls += 1
			if (bucket.toolBudget > 0 && bucket.toolCalls >= bucket.toolBudget) {
				this.#log(
					'warn',
					`qq-node: the turn already made ${bucket.toolCalls} tool calls; stopping it so the reply does not get any later`,
				)
				this.#settle(bucket, { budget: true })
			}
			return
		}
		if (event.type === 'turn/end') this.#settle(bucket, { reason: data.reason })
	}

	#settle(bucket, outcome) {
		if (bucket.settled) return
		bucket.settled = true
		bucket.resolve(outcome)
	}

	async #turn(entry, content, { allowEmpty = false, tier = undefined, scope = null, earlyReply = undefined } = {}) {
		// 工具在自己那条异步链里读不到会话对象，靠这里把「这一轮是谁、在哪个场景」
		// 放进去；发说说这类公开动作据此拒绝群聊。
		return runInTaskScope(scope, () => this.#turnInner(entry, content, { allowEmpty, tier, earlyReply }))
	}

	async #turnInner(entry, content, { allowEmpty = false, tier = undefined, earlyReply = undefined } = {}) {
		const agent = entry.handle.agent
		// Tiering takes effect on the next request the agent assembles, so this
		// must happen before followup() admits the message.
		if (tier !== undefined) entry.handle.applyTier?.(tier)
		const first = await this.#exchange(entry, content, this.#options.turnTimeoutMs, {
			earlyMs: this.#options.earlyReplyMs ?? 0,
			earlyMinMs: earlyReply === undefined ? 0 : (this.#options.earlyReplyMinMs ?? 0),
			onEarly: earlyReply,
		})
		// 早发出去的那一句已经在她和对方的对话里了，后面每一种出口都要扣掉它。
		const early = first.earlyText ?? ''
		if (first.timeout === true || first.budget === true) {
			const overBudget = first.budget === true
			const partial = withoutEarly(stripToolMarkup(first.parts.join('\n').trim()), early)
			// 撞墙之后别直接放弃：同一个会话里再要一句话，把已有的结果说出来。
			// 桥那边 running 的租约是 10 分钟（`RUNNING_LEASE_MS = 600000`），多跑
			// 一分钟完全放得下；比丢掉四分钟的劳动强，也比丢掉她那句「做好了」强。
			const wrap = withoutEarly(await this.#wrapUp(entry, partial, { budget: overBudget }), early)
			if (wrap !== '') return { text: wrap, earlyText: early }
			if (partial !== '') {
				const why = overBudget ? `${first.toolCalls ?? 0} tool calls` : 'the wall'
				this.#log('warn', `qq-node: the turn stopped at ${why} after she had already said ${partial.length} chars; keeping it`)
			}
			if (overBudget) throw new TurnBudgetError(partial, early, first.toolCalls ?? 0)
			throw new TurnTimeoutError(partial, early)
		}
		const reason = first.reason
		if (reason !== undefined && reason.kind !== 'completed') {
			const detail = reason.error?.message ?? reason.reason?.message ?? reason.kind
			throw new Error(`turn ended ${reason.kind}: ${detail}`)
		}
		const raw = first.parts.join('\n').trim()
		// 工具调用的文本协议不许过闸：对外会话没有工具，同一段标记不会被解析成调用，
		// 只会原样漏给对方（2026-10-28 15:08 那次就是这么漏的）。
		const text = stripToolMarkup(raw)
		if (text !== raw) this.#log('warn', `qq-node: stripped tool markup from a reply (${raw.length} → ${text.length} chars)`)
		if (text === '') {
			if (allowEmpty || early !== '') return { text: '', earlyText: early }
			// 对方是真的在问事，沉默比一句笨话更难受：换成兜底那句照发。
			this.#log('warn', 'qq-node: the reply was nothing but tool markup; sending the fallback line')
			return { text: FALLBACK_REPLY, earlyText: early }
		}
		return { text: withoutEarly(text, early), earlyText: early }
	}

	/**
	 * 超时之后的那一次「收尾」对话：不要她再干活，只要一句给对方的交代。
	 *
	 * 期间不再排新的超时（用的是自己那份预算），失败一律返回空串，让调用方退回
	 * 「她说过的话」或「超时上报」这两条已有的路。
	 */
	async #wrapUp(entry, partial, { budget = false } = {}) {
		if (this.#options.wrapUpOnTimeout === false) return ''
		const budgetMs = this.#options.wrapUpMs ?? Math.min(60_000, Math.max(15_000, Math.floor(this.#options.turnTimeoutMs / 4)))
		const said = partial === '' ? '' : `你刚才已经说出口的是这一句：「${partial.slice(0, 120)}」。`
		const prompt = `${WRAP_UP_TEXT}${said}`
		this.#log('warn', `qq-node: the turn ${budget ? 'used up its tool budget' : 'hit the wall'}; asking for a one-line wrap-up (${budgetMs}ms)`)
		try {
			const second = await this.#exchange(entry, [{ type: 'text', text: prompt }], budgetMs, { wrapUp: true })
			if (second.timeout === true) {
				this.#log('warn', 'qq-node: the wrap-up turn timed out too; nothing to add')
				return ''
			}
			if (second.reason !== undefined && second.reason.kind !== 'completed') {
				this.#log('warn', `qq-node: the wrap-up turn ended ${second.reason.kind}; nothing to add`)
				return ''
			}
			return stripToolMarkup(second.parts.join('\n').trim())
		} catch (error) {
			this.#log('warn', `qq-node: the wrap-up turn failed: ${error?.message ?? String(error)}`)
			return ''
		}
	}

	/**
	 * One followup plus the events that belong to it; resolves with the raw parts or a timeout.
	 *
	 * `earlyMs`/`earlyMinMs` 决定「先开口」的时机：回合至少跑过 `earlyMinMs`（默认由调用方给）并且
	 * 她已经说出一句完整的话（有句末标点，或长到 40 字）就先发出去；跑到 `earlyMs` 则不管有没有
	 * 说完都发——宁可发一句半截话，也别让对方继续盯着空屏幕。
	 */
	async #exchange(entry, content, timeoutMs, { wrapUp = false, earlyMs = 0, earlyMinMs = 0, earlyTickMs = 0, onEarly = undefined } = {}) {
		const agent = entry.handle.agent
		const sessionId = String(agent.session.id)
		const previous = this.#pending.get(sessionId)
		const bucket = { turn: undefined, parts: [], settled: false, resolve: undefined, earlyText: '', toolCalls: 0, toolBudget: wrapUp ? 0 : (this.#options.toolCallBudget ?? 0) }
		const settled = new Promise((resolve) => {
			bucket.resolve = resolve
		})
		this.#pending.set(sessionId, bucket)
		const timer = setTimeout(() => this.#settle(bucket, { timeout: true }), timeoutMs)
		// 长回合里最难受的是静音：她已经说了一句话，但整轮还没结束。到点就把已经
		// 冒出来的那段先发出去，剩下的照常等（`withoutEarly` 会把这段扣掉）。
		const startedAt = Date.now()
		const tickMs = earlyTickMs > 0 ? earlyTickMs : earlyMinMs > 0 ? Math.max(50, Math.min(3000, Math.floor(earlyMinMs / 4))) : 0
		const early =
			earlyMs > 0 && typeof onEarly === 'function'
				? setInterval(() => {
						if (bucket.settled || bucket.earlyText !== '' || wrapUp) return
						const said = stripToolMarkup(bucket.parts.join('\n').trim())
						if (said === '') return
						const waitedMs = Date.now() - startedAt
						const due = waitedMs >= earlyMs || (earlyMinMs > 0 && waitedMs >= earlyMinMs && isSpeakable(said))
						if (!due) return
						bucket.earlyText = said
						try {
							onEarly(said)
						} catch (error) {
							this.#log('warn', `qq-node: early reply failed: ${error?.message ?? String(error)}`)
						}
					}, Math.max(50, tickMs || Math.min(earlyMs, 3000)))
				: undefined
		try {
			agent.followup(createUserMessage({ content, source: { kind: 'user' } }))
			const outcome = await settled
			if (outcome.timeout === true || outcome.budget === true) {
				const reason =
					outcome.budget === true
						? 'qq-node tool budget'
						: wrapUp
							? 'qq-node wrap-up timeout'
							: 'qq-node turn timeout'
				try {
					agent.cancel({ kind: 'hook', reason })
				} catch (error) {
					this.#log('warn', `qq-node: cancel after ${outcome.budget === true ? 'budget' : 'timeout'} failed: ${error?.message ?? String(error)}`)
				}
			}
			return { ...outcome, parts: bucket.parts, earlyText: bucket.earlyText, toolCalls: bucket.toolCalls }
		} finally {
			clearTimeout(timer)
			if (early !== undefined) clearInterval(early)
			if (previous === undefined) this.#pending.delete(sessionId)
			else this.#pending.set(sessionId, previous)
		}
	}
}
