import { sessionKeyOf } from './session.js'
import { INTERJECTION_SILENCE, InterjectionGate, QqGroupBuffer, groupKeyOf, isGroupTask, mentionedOf, needsReplyOf } from './groups.js'
import { isCorrection } from './correction.js'
import { tierOf } from './tier.js'

/**
 * 她「这一轮没什么想说的」的唯一合法回答。
 * 模型偶尔会写成 "NONE." 或 "NONE（今天没什么事）"，前面认 NONE 就算弃权——
 * 宁可漏掉一句开场白，也不要把「NONE」当正文发到他手机上。
 */
export const PROACTIVE_SILENCE = 'NONE'

/** 主动开口这一轮是否被弃权。 */
export function declinedProactive(text) {
	const trimmed = String(text ?? '').trim()
	if (trimmed === '') return false
	return /^NONE\b/i.test(trimmed)
}

const sleep = (ms, signal) =>
	new Promise((resolve) => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener('abort', () => {
			clearTimeout(timer)
			resolve()
		}, { once: true })
	})

/** Counting semaphore bounding globally-concurrent turns. */
export class Semaphore {
	#limit
	#active = 0
	#waiters = []

	constructor(limit) {
		if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError('qq-node: semaphore limit must be a positive integer')
		this.#limit = limit
	}

	get active() {
		return this.#active
	}

	acquire() {
		if (this.#active < this.#limit) {
			this.#active += 1
			return Promise.resolve(() => this.#release())
		}
		return new Promise((resolve) => {
			this.#waiters.push(() => {
				this.#active += 1
				resolve(() => this.#release())
			})
		})
	}

	#release() {
		this.#active -= 1
		const next = this.#waiters.shift()
		if (next !== undefined) next()
	}
}

/** Size cap of the taskId dedup window (D14: at-least-once delivery, node-side idempotency). */
const SEEN_LIMIT = 2048

/** 攒批上限：再多就不等了，先把手里的回掉。 */
const MAX_BATCH = 8

/**
 * The poll loop and the execution dispatcher: one task at a time per QQ
 * conversation key (`sessionKeyOf`, i.e. per user), at most
 * `maxConcurrentTurns` turns in flight overall, every taskId executed at most
 * once, and a bridge outage that never stops the loop.
 *
 * Protocol v2: a group task marked `needsReply: false` only enters its **group's**
 * history buffer and is answered with empty text — no turn — unless the optional
 * interjection takes a slot for that group. A `needsReply: true` task runs as
 * before, with the group's buffered history prepended to its content. The two
 * keys differ on purpose: history and throttling are per group, sessions per user.
 */
export class QqNodeRunner {
	#ctx
	#client
	#store
	#options
	#log
	#sem
	#controller = new AbortController()
	#chains = new Map()
	#seen = new Map()
	#groups = new QqGroupBuffer()
	#interjection
	#loop
	#detach
	#sweepTimer
	#stopping = false
	#backoffMs = 0
	#audit
	#corrections
	#batches = new Map()

	constructor({ ctx, client, store, options, log = () => {}, audit = undefined, corrections = undefined }) {
		this.#ctx = ctx
		this.#client = client
		this.#store = store
		this.#options = options
		this.#log = log
		this.#audit = audit
		this.#corrections = corrections
		this.#sem = new Semaphore(options.maxConcurrentTurns)
		this.#interjection = new InterjectionGate(options.proactiveInterjection)
	}

	/** Number of taskIds currently remembered as executed (diagnostics). */
	get seenCount() {
		return this.#seen.size
	}

	/** The group history buffer, exposed for tests and probes. */
	get groups() {
		return this.#groups
	}

	/** The interjection throttle, exposed for tests and probes. */
	get interjection() {
		return this.#interjection
	}

	start() {
		if (this.#loop !== undefined) return
		this.#detach = this.#store.attach()
		this.#sweepTimer = setInterval(() => {
			try {
				this.#store.sweep()
			} catch (error) {
				this.#log('warn', `qq-node: idle sweep failed: ${error?.message ?? String(error)}`)
			}
		}, Math.min(60_000, Math.max(5_000, Math.floor(this.#options.idleRecycleMs / 4))))
		this.#sweepTimer.unref?.()
		this.#loop = this.#pollLoop()
	}

	async stop() {
		this.#stopping = true
		this.#controller.abort()
		// 还在等的批次先交出去：这些消息已经收下了，不该因为一次重启就没人回。
		for (const key of [...this.#batches.keys()]) this.#seal(key)
		if (this.#sweepTimer !== undefined) clearInterval(this.#sweepTimer)
		this.#detach?.()
		await this.#loop?.catch(() => {})
		await Promise.allSettled([...this.#chains.values()])
		this.#store.dispose()
		this.#loop = undefined
	}

	async #pollLoop() {
		const { pollWaitSeconds, pollLimit } = this.#options
		while (!this.#stopping) {
			let tasks
			try {
				tasks = await this.#client.poll({ wait: pollWaitSeconds, limit: pollLimit, signal: this.#controller.signal })
				if (this.#backoffMs !== 0) this.#log('info', 'qq-node: bridge reachable again')
				this.#backoffMs = 0
			} catch (error) {
				if (this.#stopping || this.#controller.signal.aborted) return
				this.#backoffMs = Math.min(30_000, this.#backoffMs === 0 ? 1_000 : this.#backoffMs * 2)
				this.#log('warn', `qq-node: ${error?.message ?? String(error)}; retrying in ${this.#backoffMs}ms`)
				await sleep(this.#backoffMs, this.#controller.signal)
				continue
			}
			for (const task of tasks) this.#accept(task)
		}
	}

	#accept(task) {
		if (typeof task?.taskId !== 'string' || task.taskId === '') {
			this.#log('warn', 'qq-node: the bridge delivered a task without a taskId; dropping it')
			return
		}
		if (this.#seen.has(task.taskId)) {
			this.#log('info', `qq-node: duplicate taskId ${task.taskId} ignored (already executed)`)
			return
		}
		this.#remember(task.taskId)
		this.#client
			.markStatus(task.taskId, 'accepted')
			.catch((error) => this.#log('warn', `qq-node: accepted status for ${task.taskId} failed: ${error?.message ?? String(error)}`))
		const window = this.#batchWindowFor(task)
		if (window === 0) {
			this.#chain(task)
			return
		}
		// 攒一小会儿：他经常连着发三条「在吗」「睡了吗」「跟你说个事」，
		// 每一条都开一轮完整上下文，是这份账单里最容易漏掉的那部分。
		const key = sessionKeyOf(task)
		let batch = this.#batches.get(key)
		if (batch === undefined) {
			batch = { tasks: [], timer: undefined }
			batch.timer = setTimeout(() => this.#seal(key), window)
			batch.timer.unref?.()
			this.#batches.set(key, batch)
		}
		batch.tasks.push(task)
		if (batch.tasks.length >= MAX_BATCH) {
			clearTimeout(batch.timer)
			this.#seal(key)
		}
	}

	/** 这一条要不要攒批，攒多久。攒批只对私聊、且不是主动开口的那一轮。 */
	#batchWindowFor(task) {
		const window = this.#options.batchWindowMs ?? 0
		if (!(window > 0)) return 0
		if (task.proactive === true) return 0
		// 群里每句话的发送人不同，合并会把「谁说的」压平，还会打乱群历史的顺序。
		if (isGroupTask(task)) return 0
		return window
	}

	/** 时间到（或攒满了），把这一批合成一轮交出去。 */
	#seal(key) {
		const batch = this.#batches.get(key)
		if (batch === undefined) return
		this.#batches.delete(key)
		clearTimeout(batch.timer)
		if (batch.tasks.length === 0) return
		this.#chain(batch.tasks.length === 1 ? batch.tasks[0] : this.#mergeTasks(batch.tasks))
	}

	/**
	 * 几条消息并成一条任务：取最后一条当底（taskId、userId 都以它为准），
	 * 正文按到达顺序用换行接起来，图片累加。被并掉的 taskId 记在 `batched` 里，
	 * 等这一轮结束再分别回一个空结果，免得 bridge 那边一直等。
	 */
	#mergeTasks(tasks) {
		const last = tasks[tasks.length - 1]
		const text = tasks
			.map((task) => (typeof task.text === 'string' ? task.text : ''))
			.filter((line) => line !== '')
			.join('\n')
		const images = tasks.flatMap((task) => (Array.isArray(task.images) ? task.images : []))
		this.#log('info', `qq-node: batched ${tasks.length} messages into one turn for ${sessionKeyOf(last)}`)
		return { ...last, text, images, batched: tasks.slice(0, -1).map((task) => task.taskId) }
	}

	/** 把并掉的那些 taskId 各自结掉：正文已经随合并后的那一轮发出去了。 */
	async #settleBatched(task, { ok, error }) {
		if (!Array.isArray(task.batched)) return
		for (const taskId of task.batched) {
			await this.#submit({ taskId, ok, text: '', error: ok ? null : error })
		}
	}

	#chain(task) {
		const key = sessionKeyOf(task)
		const previous = this.#chains.get(key) ?? Promise.resolve()
		const next = previous.then(() => this.#run(task))
		this.#chains.set(key, next)
		next.finally(() => {
			if (this.#chains.get(key) === next) this.#chains.delete(key)
		})
	}

	#remember(taskId) {
		this.#seen.set(taskId, Date.now())
		if (this.#seen.size > SEEN_LIMIT) {
			for (const oldest of this.#seen.keys()) {
				this.#seen.delete(oldest)
				if (this.#seen.size <= SEEN_LIMIT) break
			}
		}
	}

	async #run(task) {
		const group = isGroupTask(task)
		// The bridge invents this task to give her a chance to speak first; no user
		// message exists, so it must never be treated as one.
		const proactive = task.proactive === true
		// History and throttle are group-granular (every member of one group shares
		// one 群聊前文); the agent session stays per user, see `#accept`.
		const key = group ? groupKeyOf(task) : ''
		// Snapshot the history before this message joins it: the current line must
		// not appear twice, once as history and once as the message itself.
		const historyText = group ? this.#groups.format(key) : ''
		if (group) {
			this.#groups.record(key, {
				nickname: task.nickname,
				text: task.text,
				mentioned: mentionedOf(task),
				at: task.receivedAt,
			})
		}
		// Only a group message can be context-only: private chat behaves exactly as
		// it did before protocol v2, whatever the bridge puts in `needsReply`.
		const contextOnly = group && !needsReplyOf(task)
		// A context-only message runs no turn, unless the interjection claims it.
		const interject = contextOnly && this.#interjection.tryTake(key)
		if (contextOnly && !interject) {
			await this.#submit({ taskId: task.taskId, ok: true, text: '', error: null })
			return
		}
		const release = await this.#sem.acquire()
		try {
			await this.#client
				.markStatus(task.taskId, 'running')
				.catch((error) => this.#log('warn', `qq-node: running status for ${task.taskId} failed: ${error?.message ?? String(error)}`))
			const tier = tierOf(task.text, {
				enabled: this.#options.tiering !== undefined,
				lightMaxChars: this.#options.tiering?.lightMaxChars,
				hasImages: Array.isArray(task.images) && task.images.length > 0,
				isGroupContextOnly: contextOnly,
			})
			let outcome
			// 长回合里先开口：240 秒里她可能早就说了一句完整的话，桥那边 22/90/180 秒
			// 的垫话是罐头句子，这一条是她自己刚说的。只给「主人私聊、真的在问事、
			// 不是主动搭话」的回合开——群里别人不该收到半截回复。
			const earlyReply =
				!group && !proactive && task.isOwner === true && needsReplyOf(task)
					? (text) => {
							const to = String(task.userId ?? '')
							void this.#client
								.sendText({ to, text, taskId: task.taskId })
								.then(() => {
									this.#log('info', `qq-node: sent the first sentence early (${text.length} chars) for ${task.taskId}`)
									this.#audit?.record({
										kind: 'private_reply',
										target: to,
										text,
										...(this.#options.tiering !== undefined ? { tier } : {}),
										taskId: task.taskId,
									})
								})
								.catch((error) => this.#log('warn', `qq-node: early reply for ${task.taskId} failed: ${error?.message ?? String(error)}`))
						}
					: undefined
			try {
				outcome = await this.#store.runTask(task, {
					historyText,
					allowEmpty: interject || proactive,
					tier,
					proactive,
					earlyReply,
				})
			} catch (error) {
				const hitBudget = error?.name === 'TurnBudgetError'
				const timedOut = error?.name === 'TurnTimeoutError' || hitBudget
				const message = timedOut ? (hitBudget ? 'tool budget' : 'turn timeout') : (error?.message ?? String(error))
				// 超时的回合常常是「干到一半被墙切断」，而她已经说过话（样本：做完 PPT 说
				// 「我看看怎么把它发给你」）。把那句发出去，比让她从零再来一遍强。
				const partial = timedOut ? String(error?.partialText ?? '') : ''
				const said = timedOut ? String(error?.earlyText ?? '') : ''
				if (partial !== '') {
					const text = `${partial}\n（这事儿还没完，你回一句「继续」我就接着弄。）`
					this.#log(
						'warn',
						`qq-node: task ${task.taskId} ${hitBudget ? 'used up its tool budget' : 'hit the turn timeout'} after a partial reply (${partial.length} chars); delivering it`,
					)
					await this.#submit({ taskId: task.taskId, ok: true, text, error: null })
					await this.#settleBatched(task, { ok: true, error: null })
					return
				}
				// 那句话已经先发出去过了，剩下的没有新内容：这一轮到此为止，别再补一句。
				if (said !== '') {
					this.#log('info', `qq-node: task ${task.taskId} stopped after the early reply; nothing new to send`)
					await this.#submit({ taskId: task.taskId, ok: true, text: '', error: null })
					await this.#settleBatched(task, { ok: true, error: null })
					return
				}
				this.#log('warn', `qq-node: task ${task.taskId} failed: ${message}`)
				await this.#submit({ taskId: task.taskId, ok: false, text: '', error: message })
				await this.#settleBatched(task, { ok: false, error: message })
				return
			}
			// Silence is an answer: an interjection that produced nothing must not
			// put a message in the group, and "nothing to say" must not become a
			// message that fills the daily allowance.
			const nothingToSay = proactive && declinedProactive(outcome.text)
			const silent = (interject && outcome.text === INTERJECTION_SILENCE) || nothingToSay
			if (nothingToSay) this.#log('info', `qq-node: proactive turn ${task.taskId} declined`)
			const text = silent ? '' : outcome.text
			await this.#submit({ taskId: task.taskId, ok: true, text, error: null })
			await this.#settleBatched(task, { ok: true, error: null })
			if (text !== '') {
				this.#audit?.record({
					kind: proactive ? 'proactive' : group ? 'group_reply' : 'private_reply',
					target: group ? String(task.groupId ?? '') : String(task.userId ?? ''),
					text,
					...(this.#options.tiering !== undefined ? { tier } : {}),
					taskId: task.taskId,
				})
			}
			if (group && text !== '') this.#interjection.noteSpoke(key)
			// 「以后别这样」「记住我……」只在主人私聊里收录：群里别人说的话不是规矩，
			// 而且不收录就不会有人拿它去改她的性格。
			if (!group && !proactive && task.isOwner === true && isCorrection(task.text)) {
				if (this.#corrections?.add(task.text) === true) this.#log('info', 'qq-node: recorded a standing rule')
			}
		} finally {
			release()
		}
	}

	async #submit(payload) {
		for (let attempt = 1; attempt <= 3; attempt += 1) {
			try {
				const response = await this.#client.submitResult(payload)
				this.#log('info', `qq-node: result ${payload.taskId} ${payload.ok ? 'ok' : `error=${payload.error}`}${response?.duplicate ? ' (duplicate)' : ''}`)
				return
			} catch (error) {
				this.#log('warn', `qq-node: result ${payload.taskId} attempt ${attempt} failed: ${error?.message ?? String(error)}`)
				if (attempt === 3) return
				await sleep(attempt * 500, this.#controller.signal)
			}
		}
	}
}
