/**
 * A minimal stand-in for the parts of the DSH runtime the node touches:
 * `ctx.agents.create/get`, `ctx.on('session/event')`, `ctx.get('tools')`,
 * `ctx.effect`, and scripted agent turns.
 *
 * It is deliberately tiny: it reproduces the contracts the node relies on
 * (turn/start, assistant/message, turn/end; followup returns void; cancel
 * aborts the turn) so the acceptance test can run without an LLM.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class FakeTools {
	constructor(scope) {
		this.scope = scope
		this.guards = []
		this.restrictions = []
	}

	guard(fn) {
		this.guards.push(fn)
		return () => {
			this.guards = this.guards.filter((entry) => entry !== fn)
		}
	}

	restrict(filter) {
		this.restrictions.push(filter)
		return () => {
			this.restrictions = this.restrictions.filter((entry) => entry !== filter)
		}
	}

	/** Run the guard chain the way the real runtime does; first reason wins. */
	denyReason() {
		for (const guard of this.guards) {
			const reason = guard({ name: 'bash', agent: this.scope?.agent })
			if (typeof reason === 'string') return reason
		}
		return undefined
	}
}

/**
 * Stand-in for `ctx.systemPrompt`: one global section registry with the parts of
 * the real contract the plugin depends on — duplicate names in one layer throw,
 * sections sort by `order` then name, and `text` functions are evaluated per
 * assembly with that assembly's context.
 */
export class FakeSystemPrompt {
	constructor() {
		this.sections = new Map()
		this.assemblies = 0
	}

	section(section) {
		if (!Number.isFinite(section.order)) throw new TypeError(`prompt section "${section.name}" order must be a finite number`)
		if (this.sections.has(section.name)) throw new Error(`prompt section "${section.name}" is already registered`)
		this.sections.set(section.name, section)
		return () => {
			this.sections.delete(section.name)
		}
	}

	/** Evaluate every registered section, mirroring `SystemPrompt.assemble`. */
	async assemble(context = {}) {
		this.assemblies += 1
		const definitions = [...this.sections.values()].sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
		return {
			sections: definitions.map((section) => ({
				name: section.name,
				text: typeof section.text === 'function' ? section.text(context) : section.text,
				...(section.interpolate === undefined ? {} : { interpolate: section.interpolate }),
			})),
			contexts: [],
			tools: [],
			variables: {},
		}
	}
}

/**
 * @param options.reply - `(context) => {text, delayMs, hang}`; `context` is
 *   `{agentId, sessionId, turn, message, agent}`.
 */
export function createFakeRuntime({ reply } = {}) {
	const listeners = []
	const agents = new Map()
	const disposers = []
	const contexts = new Map()
	const systemPrompt = new FakeSystemPrompt()
	const stats = { turnsStarted: 0, turnsCompleted: 0, peakActive: 0, active: 0, overlap: [] }

	const emit = (agent, type, data) => {
		for (const listener of listeners) listener({ id: agent.session.id }, { type, data })
	}

	const toolFor = (scope) => {
		if (!contexts.has(scope)) contexts.set(scope, new FakeTools(scope))
		return contexts.get(scope)
	}

	const ctx = {
		get(name) {
			if (name === 'tools') return toolFor('root')
			if (name === 'attachments') return { store: async () => 'attachment-1' }
			if (name === 'systemPrompt') return systemPrompt
			return undefined
		},
		on(event, listener) {
			if (event !== 'session/event') throw new Error(`fake runtime: unsupported event ${event}`)
			listeners.push(listener)
			return () => {
				const index = listeners.indexOf(listener)
				if (index >= 0) listeners.splice(index, 1)
			}
		},
		effect(fn, label) {
			const dispose = fn()
			if (typeof dispose === 'function') disposers.push({ dispose, label })
			return dispose
		},
		agents: {
			async create(options) {
				const id = `agent-${agents.size + 1}`
				const agent = {
					id,
					session: { id: options.sessionId },
					options,
					turnCount: 0,
					disposed: false,
					pending: undefined,
					lastMessage: undefined,
					followup(message) {
						if (agent.disposed) throw new Error('fake runtime: followup on a disposed agent')
						agent.lastMessage = message
						void runTurn(agent, message)
					},
					cancel(cause) {
						const pending = agent.pending
						if (pending === undefined) return
						agent.pending = undefined
						emit(agent, 'turn/end', { turn: pending, reason: { kind: 'aborted', reason: cause } })
					},
				}
				agents.set(id, agent)
				const agentCtx = {
					...ctx,
					get(name) {
						return name === 'tools' ? toolFor(agent) : ctx.get(name)
					},
				}
				if (typeof options.setup === 'function') await options.setup(agentCtx, agent)
				return {
					agent,
					dispose() {
						agent.disposed = true
						agents.delete(id)
					},
				}
			},
			get(id) {
				return agents.get(id)
			},
		},
	}

	async function runTurn(agent, message) {
		const turn = (agent.turnCount += 1)
		stats.turnsStarted += 1
		stats.active += 1
		stats.peakActive = Math.max(stats.peakActive, stats.active)
		if (agent.pending !== undefined) stats.overlap.push(agent.id)
		agent.pending = turn
		emit(agent, 'turn/start', { turn })
		try {
			const script = (await reply({ agentId: agent.id, sessionId: agent.session.id, turn, message, agent })) ?? {}
			if (script.hang === true) return
			await sleep(script.delayMs ?? 2)
			if (agent.pending !== turn) return
			// 先说一句再去动手：线上她常在动手前交代一句，用来验「到预算时她已经说过话」。
			for (const text of script.preTexts ?? []) {
				if (agent.pending !== turn) return
				emit(agent, 'assistant/message', { turn, step: 0, message: { role: 'assistant', content: [{ type: 'text', text }] } })
			}
			// 工具调用：每一次都是一步模型往返，用来验「工具预算到点就收尾」那条路。
			for (let index = 0; index < (script.toolCalls ?? 0); index += 1) {
				if (agent.pending !== turn) return
				emit(agent, 'tool/call', { turn, step: index + 1, callId: `call-${turn}-${index + 1}`, name: 'bash', arguments: '{}' })
				if ((script.toolDelayMs ?? 0) > 0) {
					await sleep(script.toolDelayMs)
					if (agent.pending !== turn) return
				}
			}
			const texts = script.texts ?? [script.text ?? 'ok']
			for (const text of texts) {
				if (agent.pending !== turn) return
				emit(agent, 'assistant/message', {
					turn,
					step: 1,
					message: { role: 'assistant', content: [{ type: 'text', text }] },
				})
				// 逐句之间留出时间：用来验「说到一半先把这句发出去」那条路。
				if ((script.textDelayMs ?? 0) > 0) {
					await sleep(script.textDelayMs)
					if (agent.pending !== turn) return
				}
			}
			// 说了话但回合永远不结束：模拟「干到一半撞上时间墙」，用来验超时那条路。
			if (script.hangAfterTexts === true) return
			agent.pending = undefined
			stats.turnsCompleted += 1
			emit(agent, 'turn/end', { turn, reason: { kind: 'completed' } })
		} finally {
			stats.active -= 1
		}
	}

	return {
		ctx,
		stats,
		agents,
		systemPrompt,
		toolsFor: toolFor,
		dispose() {
			for (const entry of disposers.reverse()) entry.dispose()
		},
	}
}
