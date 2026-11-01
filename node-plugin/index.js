import { join, dirname } from 'node:path'
import { QqBridgeClient } from './lib/bridge.js'
import { QqNodeRunner } from './lib/runner.js'
import { QqSessionStore } from './lib/session.js'
import { QqPersona, defaultPersonaDir } from './lib/persona.js'
import { INTERJECTION_DEFAULTS } from './lib/groups.js'
import { createAuditLog } from './lib/audit.js'
import { CORRECTION_FILE, createCorrectionBook } from './lib/correction.js'
import { DEFAULT_NAPCAT_URL, NAPCAT_TOKEN_ENV, createQzoneTool } from './lib/qzone.js'
import { createMemoryWriter, createRememberTool } from './lib/remember.js'
import { createRemindTool } from './lib/remind.js'
import { createSendFileTool } from './lib/send-file.js'
import { createRecallTool } from './lib/recall.js'
import { DEFAULT_PC_BASE_URL, DEFAULT_PC_TIMEOUT_MS, PC_TOOL_NAMES, clampPcTimeoutMs, createPcToolGate } from './lib/pc-tools.js'
import { QqNightlyRunner } from './lib/nightly-runner.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'qq-node'

/** `agents` is the one hard requirement; attachments and tools are read opportunistically. */
export const inject = ['agents']

/** Config defaults; every key is documented in README.md. */export const CONFIG_DEFAULTS = Object.freeze({
	bridgeUrl: 'http://127.0.0.1:8787',
	/** Read from QQ_NODE_TOKEN when left empty, so the shared secret need not live in a file. */
	nodeToken: '',
	pollWaitSeconds: 25,
	pollLimit: 2,
	maxConcurrentTurns: 2,
	turnTimeoutMs: 180_000,
	// 长回合里她已经说出口的那一句，先发出去，别让人对着静音等四分钟（0 关掉）。
	earlyReplyMs: 75_000,
	// 但不必等到 75 秒：说出一句完整的话（有句末标点或够长）就先发，
	// 这样 20–40 秒那种回合也不用一路静音（0 表示只在 earlyReplyMs 到点时发）。
	earlyReplyMinMs: 25_000,
	// 一步模型往返约 5 秒，工具调用越多这一轮越长；线上 41 次的回合正好撞满 240 秒。
	// 到预算就收尾（把已经说的话和一句交代送出去），剩下的留给下一轮（0 关掉）。
	toolCallBudget: 20,
	idleRecycleMs: 6 * 60 * 60 * 1000,
	// 会话轮转：一聊一整天的会话会一路涨到十几万 token，每轮都要把前面那段重送一遍。
	// 60 轮或静默 10 分钟后换一个新会话；身份和长期记忆在 system prompt 里，换掉不丢。
	sessionMaxTurns: 60,
	sessionRotateAfterIdleMs: 10 * 60 * 1000,
	// 攒批窗口：他连发三条短消息，现在会开三轮完整上下文。攒一小会儿合成一轮，代价是晚 1.5 秒。
	// 默认关（0）：群里每条消息的发送人不同，攒批会压平「谁说的」，也打乱群历史顺序。
	batchWindowMs: 0,
	provider: '',
	model: '',
	reasoningEffort: '',
	maxTokens: 0,
	cwd: '',
	nonOwnerPreset: 'qq-chat-only',
	/** Empty means `qq-dsh/persona`, resolved from this package's location. */
	personaDir: '',
	/**
	 * Memory decay: score the items of MEMORY.md with a forgetting curve and drop
	 * the ones that fell below the line — into `memory/archive.md`, never into
	 * nothing — and archive diary days that fell out of the injected window.
	 * Off restores the previous behaviour byte for byte.
	 */
	memoryDecay: true,
	/** Group interjection; off by default, see README.md. */
	proactiveInterjection: { ...INTERJECTION_DEFAULTS },
	/** Audit trail directory; empty means `<personaDir>/../audit`. */
	auditDir: '',
	/** Per-turn effort tiering; off means one effort for every message. */
	effortTiering: false,
	/** Effort for the light tier when tiering is on; empty omits the override entirely. */
	lightReasoningEffort: '',
	/** Longest message still eligible for the light tier. */
	lightMaxChars: 40,
	/** NapCat OneBot11 WS endpoint used by `qzone_send`; the plugin never holds the connection. */
	napcatUrl: DEFAULT_NAPCAT_URL,
	/** 主人电脑通道的总开关；默认关闭，打开才注册 pc_exec/pc_read/pc_write。 */
	pcEnabled: false,
	/** 三个 PC 工具投命令用的 bridge 基址（`POST /node/pc/enqueue`），通常与 bridgeUrl 相同。 */
	pcBaseUrl: DEFAULT_PC_BASE_URL,
	/** 一条命令在 bridge 上等多久，夹在契约的 1000..120000。 */
	pcTimeoutMs: DEFAULT_PC_TIMEOUT_MS,
	/** 夜班总开关；默认关闭——没人看着的自动写入，得由人亲手打开。 */
	nightlyEnabled: false,
	/** 夜班的那个整点（服务器本地时区）；契约的复盘时刻是 03:10。 */
	nightlyHour: 3,
	/** 夜班单轮预算；契约每晚 120 秒、周日深度档 180 秒。 */
	nightlyTimeoutMs: 120_000,
	/** 每晚最多接受几条记忆；契约上限 5（周日深度档 10）。 */
	nightlyMaxMemories: 5,
	/** 每晚最多接受几条代码提案；契约上限 3（周日深度档 5）。 */
	nightlyMaxProposals: 3,
	/** 挖矿器写 digest-YYYY-MM-DD.md 的目录；契约默认就是这个路径。 */
	nightlyDigestDir: '/var/lib/dsh-qq-agent/nightly',
	/** 提案落盘目录；空意味着 `<personaDir>/../proposals`。 */
	proposalsDir: '',
})

/**
 * Schema support is optional: a linked plugin resolves its imports from its own
 * directory, where the installation's packages are not visible. Without
 * schemastery the row keeps working, because resolveOptions() is the single
 * validator and default source; the schema only feeds `--dump-config-schema`.
 */
const { default: z } = await import('@deepseek-ai/schemastery').catch(() => ({ default: undefined }))

export const Config = z === undefined ? undefined : z.object({
	bridgeUrl: z.string().default(CONFIG_DEFAULTS.bridgeUrl).description('Base URL of the cloud bridge, e.g. http://127.0.0.1:8787.'),
	nodeToken: z.string().default(CONFIG_DEFAULTS.nodeToken).description('Node bearer token. Empty means read QQ_NODE_TOKEN from the environment.'),
	pollWaitSeconds: z.number().default(CONFIG_DEFAULTS.pollWaitSeconds).description('Long-poll wait per /node/poll request (protocol cap: 30).'),
	pollLimit: z.number().default(CONFIG_DEFAULTS.pollLimit).description('Tasks requested per long poll (protocol cap: 5).'),
	maxConcurrentTurns: z.number().default(CONFIG_DEFAULTS.maxConcurrentTurns).description('Global cap on concurrently running turns; same-conversation turns are serialized regardless.'),
	turnTimeoutMs: z.number().default(CONFIG_DEFAULTS.turnTimeoutMs).description('Per-turn timeout; a timed-out turn reports error "turn timeout".'),
	earlyReplyMs: z.number().default(CONFIG_DEFAULTS.earlyReplyMs).description('Send the sentence she has already said this many ms into a long turn, so the other side hears her instead of silence (0 disables).'),
	earlyReplyMinMs: z.number().default(CONFIG_DEFAULTS.earlyReplyMinMs).description('From this many ms into a turn, send the sentence she has already finished (ends with punctuation) instead of waiting for earlyReplyMs.'),
	toolCallBudget: z.number().default(CONFIG_DEFAULTS.toolCallBudget).description('Tool calls allowed in one turn before it is wrapped up with whatever she has said so far; each call costs a model round trip (0 disables).'),
	idleRecycleMs: z.number().default(CONFIG_DEFAULTS.idleRecycleMs).description('Idle age after which a QQ conversation session is disposed and dropped.'),
	sessionMaxTurns: z.number().default(CONFIG_DEFAULTS.sessionMaxTurns).description('Rotate a conversation to a fresh session after this many turns (0 disables).'),
	sessionRotateAfterIdleMs: z.number().default(CONFIG_DEFAULTS.sessionRotateAfterIdleMs).description('Rotate a conversation to a fresh session when the next message arrives after this much silence (0 disables).'),
	batchWindowMs: z.number().default(CONFIG_DEFAULTS.batchWindowMs).description('Merge consecutive private-chat messages arriving within this window into one turn (0 disables; group chats never batch).'),
	provider: z.string().default('').description('LLM provider id for QQ sessions; empty inherits the profile default.'),
	model: z.string().default('').description('LLM model id for QQ sessions; empty inherits the profile default.'),
	reasoningEffort: z.string().default('').description('Reasoning effort id for QQ sessions; empty inherits the profile default.'),
	maxTokens: z.number().default(0).description('Max output tokens per turn; 0 inherits the profile default.'),
	cwd: z.string().default('').description('Workspace directory handed to agent sessions; empty means the DSH process cwd.'),
	nonOwnerPreset: z.string().default(CONFIG_DEFAULTS.nonOwnerPreset).description('Auditable preset id recorded on non-owner sessions; the tool lockdown is enforced by the setup hook, not by the preset.'),
	personaDir: z.string().default(CONFIG_DEFAULTS.personaDir).description('Directory holding PERSONA.md, MEMORY.md and diary/; empty resolves qq-dsh/persona next to this package.'),
	memoryDecay: z.boolean().default(CONFIG_DEFAULTS.memoryDecay).description('Score MEMORY.md items and forget the ones below the line (archived to memory/archive.md, never deleted); off restores the previous behaviour byte for byte.'),
	proactiveInterjection: z.object({
		enabled: z.boolean().default(INTERJECTION_DEFAULTS.enabled).description('Let her join a group conversation that does not require a reply. Off by default.'),
		minIntervalMs: z.number().default(INTERJECTION_DEFAULTS.minIntervalMs).description('Minimum gap between two of her messages in one group.'),
		maxPerMinute: z.number().default(INTERJECTION_DEFAULTS.maxPerMinute).description('Interjections allowed per rolling minute across all groups.'),
		maxPerGroupPerDay: z.number().default(INTERJECTION_DEFAULTS.maxPerGroupPerDay).description('Interjections allowed per group per rolling day.'),
	}).description('Optional group interjection; disabled means un-mentioned group chatter is only buffered as history.'),
	auditDir: z.string().default(CONFIG_DEFAULTS.auditDir).description('Directory for the monthly audit JSONL files; empty disables the trail. Set it explicitly — the cloud profile points it at /opt/dsh-qq-agent/audit so the nightly backup covers it.'),
	effortTiering: z.boolean().default(CONFIG_DEFAULTS.effortTiering).description('Drop the reasoning-effort override for short, non-task messages. Needs a concrete provider and model.'),
	lightReasoningEffort: z.string().default(CONFIG_DEFAULTS.lightReasoningEffort).description('Reasoning effort for the light tier; empty omits the override so the provider default applies.'),
	lightMaxChars: z.number().default(CONFIG_DEFAULTS.lightMaxChars).description('Longest message still classified as light.'),
	napcatUrl: z.string().default(CONFIG_DEFAULTS.napcatUrl).description('NapCat OneBot11 WS endpoint used by qzone_send; one short-lived connection per call.'),
	pcEnabled: z.boolean().default(CONFIG_DEFAULTS.pcEnabled).description('Owner PC channel. Off means pc_exec/pc_read/pc_write are not registered at all; the startup line says why.'),
	pcBaseUrl: z.string().default(CONFIG_DEFAULTS.pcBaseUrl).description('Bridge base URL the PC tools enqueue against (POST /node/pc/enqueue). Must be http(s).'),
	pcTimeoutMs: z.number().default(CONFIG_DEFAULTS.pcTimeoutMs).description('How long one PC command waits on the bridge; clamped to 1000..120000 by the protocol.'),
	nightlyEnabled: z.boolean().default(CONFIG_DEFAULTS.nightlyEnabled).description('Nightly self-review. Off by default: at 03:10 she reads the day\'s digest and may write MEMORY.md plus proposal files — nothing else, and never any code.'),
	nightlyHour: z.number().default(CONFIG_DEFAULTS.nightlyHour).description('Hour (0..23, server local time) whose 03:10 slot the review fires in; the minute is fixed by the contract.'),
	nightlyTimeoutMs: z.number().default(CONFIG_DEFAULTS.nightlyTimeoutMs).description('Budget for the one nightly turn; the deep (Sunday) caps raise it to at least 180000.'),
	nightlyMaxMemories: z.number().default(CONFIG_DEFAULTS.nightlyMaxMemories).description('Most memory lines accepted per night; the contract cap is 5 (10 on the Sunday deep run).'),
	nightlyMaxProposals: z.number().default(CONFIG_DEFAULTS.nightlyMaxProposals).description('Most code proposals accepted per night; the contract cap is 3 (5 on the Sunday deep run).'),
	nightlyDigestDir: z.string().default(CONFIG_DEFAULTS.nightlyDigestDir).description('Directory the miner writes digest-YYYY-MM-DD.md into. A missing file is one log line and no retry.'),
	proposalsDir: z.string().default(CONFIG_DEFAULTS.proposalsDir).description('Where proposals land as YYYY-MM-DD/NN-slug.patch + .json; empty means <personaDir>/../proposals.'),
})

function requirePositiveInteger(key, value, fallback, max) {
	const effective = Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
	if (effective < 1) throw new Error(`qq-node: ${key} must be a positive integer`)
	return max === undefined ? effective : Math.min(effective, max)
}

/** 0 和正数都合法：0 表示「关掉这件事」，所以不能走 `requirePositiveInteger`。 */
function requireNonNegativeInteger(key, value, fallback) {
	if (!Number.isFinite(value)) return fallback
	const effective = Math.floor(value)
	if (effective < 0) throw new Error(`qq-node: ${key} must be zero or a positive integer`)
	return effective
}

/** Normalize `proactiveInterjection`; a partial or absent object keeps every default. */
function resolveInterjection(value) {
	const raw = value !== null && typeof value === 'object' ? value : {}
	return {
		enabled: raw.enabled === true,
		minIntervalMs: requirePositiveInteger('proactiveInterjection.minIntervalMs', raw.minIntervalMs, INTERJECTION_DEFAULTS.minIntervalMs),
		maxPerMinute: requirePositiveInteger('proactiveInterjection.maxPerMinute', raw.maxPerMinute, INTERJECTION_DEFAULTS.maxPerMinute),
		maxPerGroupPerDay: requirePositiveInteger('proactiveInterjection.maxPerGroupPerDay', raw.maxPerGroupPerDay, INTERJECTION_DEFAULTS.maxPerGroupPerDay),
	}
}

/** Validate and normalize the patch row's config; throws on values the protocol cannot honor. */
export function resolveOptions(config = {}) {
	const merged = { ...CONFIG_DEFAULTS, ...config }
	const bridgeUrl = String(merged.bridgeUrl ?? '').trim().replace(/\/+$/, '')
	if (!/^https?:\/\//.test(bridgeUrl)) throw new Error(`qq-node: bridgeUrl must be an http(s) URL, got ${JSON.stringify(merged.bridgeUrl)}`)
	const napcatUrl = String(merged.napcatUrl ?? '').trim() || CONFIG_DEFAULTS.napcatUrl
	if (!/^wss?:\/\//.test(napcatUrl)) throw new Error(`qq-node: napcatUrl must be a ws(s) URL, got ${JSON.stringify(merged.napcatUrl)}`)
	const pcBaseUrl = String(merged.pcBaseUrl ?? '').trim().replace(/\/+$/, '') || CONFIG_DEFAULTS.pcBaseUrl
	if (!/^https?:\/\//.test(pcBaseUrl)) throw new Error(`qq-node: pcBaseUrl must be an http(s) URL, got ${JSON.stringify(merged.pcBaseUrl)}`)
	const nodeToken = String(merged.nodeToken ?? '').trim() || String(process.env.QQ_NODE_TOKEN ?? '').trim()
	const provider = String(merged.provider ?? '').trim()
	const model = String(merged.model ?? '').trim()
	const heavyEffort = String(merged.reasoningEffort ?? '').trim()
	const personaDir = String(merged.personaDir ?? '').trim() || defaultPersonaDir()
	// Empty means the trail is off. It is configured explicitly rather than
	// defaulted to a path next to persona/ because a derived default makes the
	// test suite write records into a live audit log — the sink must be a
	// deliberate deployment decision, and the startup line says which it is.
	const auditDir = String(merged.auditDir ?? '').trim()
	// Tiering rewrites both provider and model on every request, so an inherited
	// (empty) route cannot be expressed; without a route, tiering stays off.
	const tiering = merged.effortTiering === true && provider !== '' && model !== ''
		? {
				heavyEffort,
				lightEffort: String(merged.lightReasoningEffort ?? '').trim(),
				lightMaxChars: requirePositiveInteger('lightMaxChars', merged.lightMaxChars, CONFIG_DEFAULTS.lightMaxChars),
			}
		: undefined
	const proposalsDir = String(merged.proposalsDir ?? '').trim() || join(personaDir, '..', 'proposals')
	// 小时是 0..23 的整数，`requirePositiveInteger` 会把合法的 0 点判死，所以单独夹。
	const nightlyHour = Number.isInteger(merged.nightlyHour) && merged.nightlyHour >= 0 && merged.nightlyHour <= 23
		? merged.nightlyHour
		: CONFIG_DEFAULTS.nightlyHour
	return {
		bridgeUrl,
		nodeToken,
		pollWaitSeconds: requirePositiveInteger('pollWaitSeconds', merged.pollWaitSeconds, CONFIG_DEFAULTS.pollWaitSeconds, 30),
		pollLimit: requirePositiveInteger('pollLimit', merged.pollLimit, CONFIG_DEFAULTS.pollLimit, 5),
		maxConcurrentTurns: requirePositiveInteger('maxConcurrentTurns', merged.maxConcurrentTurns, CONFIG_DEFAULTS.maxConcurrentTurns),
		turnTimeoutMs: requirePositiveInteger('turnTimeoutMs', merged.turnTimeoutMs, CONFIG_DEFAULTS.turnTimeoutMs),
		earlyReplyMs: requireNonNegativeInteger('earlyReplyMs', merged.earlyReplyMs, CONFIG_DEFAULTS.earlyReplyMs),
		earlyReplyMinMs: requireNonNegativeInteger('earlyReplyMinMs', merged.earlyReplyMinMs, CONFIG_DEFAULTS.earlyReplyMinMs),
		toolCallBudget: requireNonNegativeInteger('toolCallBudget', merged.toolCallBudget, CONFIG_DEFAULTS.toolCallBudget),
		idleRecycleMs: requirePositiveInteger('idleRecycleMs', merged.idleRecycleMs, CONFIG_DEFAULTS.idleRecycleMs),
		sessionMaxTurns: requireNonNegativeInteger('sessionMaxTurns', merged.sessionMaxTurns, CONFIG_DEFAULTS.sessionMaxTurns),
		sessionRotateAfterIdleMs: requireNonNegativeInteger('sessionRotateAfterIdleMs', merged.sessionRotateAfterIdleMs, CONFIG_DEFAULTS.sessionRotateAfterIdleMs),
		batchWindowMs: requireNonNegativeInteger('batchWindowMs', merged.batchWindowMs, CONFIG_DEFAULTS.batchWindowMs),
		provider,
		model,
		reasoningEffort: heavyEffort,
		maxTokens: Number.isFinite(merged.maxTokens) && merged.maxTokens > 0 ? Math.floor(merged.maxTokens) : 0,
		cwd: String(merged.cwd ?? '').trim() || process.cwd(),
		nonOwnerPreset: String(merged.nonOwnerPreset ?? '').trim() || CONFIG_DEFAULTS.nonOwnerPreset,
		personaDir,
		// `!== false` keeps the wire default on when the key is absent from YAML.
		memoryDecay: merged.memoryDecay !== false,
		auditDir,
		tiering,
		proactiveInterjection: resolveInterjection(merged.proactiveInterjection),
		napcatUrl,
		// Off unless explicitly turned on: 没打开就一个 PC 工具都不注册。
		pcEnabled: merged.pcEnabled === true,
		pcBaseUrl,
		pcTimeoutMs: clampPcTimeoutMs(merged.pcTimeoutMs),
		// 夜班默认关闭：没人看着的自动写入必须由人亲手打开。
		nightlyEnabled: merged.nightlyEnabled === true,
		nightlyHour,
		nightlyTimeoutMs: requirePositiveInteger('nightlyTimeoutMs', merged.nightlyTimeoutMs, CONFIG_DEFAULTS.nightlyTimeoutMs),
		nightlyMaxMemories: requirePositiveInteger('nightlyMaxMemories', merged.nightlyMaxMemories, CONFIG_DEFAULTS.nightlyMaxMemories),
		nightlyMaxProposals: requirePositiveInteger('nightlyMaxProposals', merged.nightlyMaxProposals, CONFIG_DEFAULTS.nightlyMaxProposals),
		nightlyDigestDir: String(merged.nightlyDigestDir ?? '').trim() || CONFIG_DEFAULTS.nightlyDigestDir,
		proposalsDir,
	}
}

/** Diagnostic sink. DSH ships no logger service, so the prefixed console line is the record. */
function log(level, message) {
	const line = `[qq-node] ${message}`
	if (level === 'error') console.error(line)
	else if (level === 'warn') console.warn(line)
	else console.info(line)
}

/**
 * Register `qzone_send` when a NapCat token is present.
 *
 * The token is read from the environment only and never becomes a Config key,
 * so it cannot land in a profile file. A missing token is one warn line and a
 * skipped registration: the rest of the node boots normally.
 *
 * @param ctx - the plugin context; `tools` is read opportunistically.
 * @param options - resolved config, for `napcatUrl`.
 * @param audit - the audit sink; a post that is not recorded here leaves no trace.
 * @returns whether the tool was registered.
 */
export function registerQzoneTool(ctx, options, audit = undefined) {
	const token = String(process.env[NAPCAT_TOKEN_ENV] ?? '').trim()
	if (token === '') {
		log('warn', `qq-node: ${NAPCAT_TOKEN_ENV} is empty, so qzone_send is not registered; set it to let the agent post to QQ 空间`)
		return false
	}
	const tools = ctx.get('tools')
	if (tools === undefined || tools === null || typeof tools.register !== 'function') {
		log('warn', 'qq-node: the tools service is absent, so qzone_send is not registered')
		return false
	}
	// For a qzone record the `taskId` field carries the post tid, so the line
	// still points at the thing to delete if it ever needs deleting.
	const onSent = ({ content, visibility, tid }) =>
		audit?.record({
			kind: 'qzone_post',
			target: 'qzone',
			text: visibility === 'self' ? `[仅自己可见] ${content}` : content,
			...(typeof tid === 'string' && tid !== '' && !tid.startsWith('(') ? { taskId: tid } : {}),
		})
	// A bare register() is the first-party idiom (dsh-tool-* and qq-bili do the
	// same): the returned disposer is bound to the registry's own lifecycle.
	tools.register(createQzoneTool({ url: options.napcatUrl, token, onSent }))
	log('info', `qq-node: registered qzone_send against NapCat ${options.napcatUrl}`)
	return true
}

/**
 * `remember` —— 让她真的能记事。
 *
 * 在此之前，能写 `MEMORY.md` 的只有人：她说「记住了」只是那一轮的事，明天就没了。
 * 记忆文件跟人格住在一起，所以备份 persona 目录就带上了她所有记得的事。
 */
export function registerRememberTool(ctx, options, audit = undefined) {
	const tools = ctx.get('tools')
	if (tools === undefined || tools === null || typeof tools.register !== 'function') {
		log('warn', 'qq-node: the tools service is absent, so remember is not registered')
		return false
	}
	const writer = createMemoryWriter({ file: join(options.personaDir, 'MEMORY.md'), log })
	const onWrite = ({ text, weight }) =>
		audit?.record({ kind: 'memory_write', target: 'memory', text: `[w:${weight}] ${text}` })
	tools.register(createRememberTool({ writer, onWrite }))
	log('info', `qq-node: registered remember against ${join(options.personaDir, 'MEMORY.md')}`)
	return true
}

/**
 * `recall` —— 让她能翻自己的本子。
 *
 * 记忆是按衰减与预算筛选后才注入的，所以一条记录可以好好地存着、却恰好没在
 * 这一轮的提示词里；于是她对一件自己写过的事答「没印象」。查文件很便宜，
 * 假装忘了不便宜。只在主人私聊里可用 —— 本子里全是他的私事。
 */
/**
 * `qq_send_file` —— 让她把做好的东西真的交到主人手上。
 *
 * 以前做不到：她在 240 秒那个回合里说过「PPT 已经做好了，我看看怎么把它发给你」，
 * 而插件里没有任何发文件的工具，桥也只有图片那条路。文件内容由桥读成 base64 再交给
 * NapCat（它在另一台机器上），路径直接发过去那边只会说「文件不存在」。
 */
export function registerSendFileTool(ctx, options) {
	if (options.nodeToken === '') {
		log('warn', 'qq-node: no node token, so qq_send_file cannot reach the bridge and is not registered')
		return false
	}
	const tools = ctx.get('tools')
	if (tools === undefined || tools === null || typeof tools.register !== 'function') {
		log('warn', 'qq-node: the tools service is absent, so qq_send_file is not registered')
		return false
	}
	const client = new QqBridgeClient({ baseUrl: options.bridgeUrl, token: options.nodeToken, log })
	tools.register(createSendFileTool({ client }))
	log('info', `qq-node: registered qq_send_file against ${options.bridgeUrl}`)
	return true
}

/**
 * `remind` —— 让她答应的「几点叫你」真的会响。
 *
 * 这条链以前根本不存在：她会在聊天里承诺「明天七点提醒你」，然后什么都不会发生。
 * 提醒由桥接落库并在到点时直接推 QQ，不依赖她那一轮还活着。只在主人私聊里可用。
 */
export function registerRemindTool(ctx, options) {
	if (options.nodeToken === '') {
		log('warn', 'qq-node: no node token, so remind cannot reach the bridge and is not registered')
		return false
	}
	const tools = ctx.get('tools')
	if (tools === undefined || tools === null || typeof tools.register !== 'function') {
		log('warn', 'qq-node: the tools service is absent, so remind is not registered')
		return false
	}
	const client = new QqBridgeClient({ baseUrl: options.bridgeUrl, token: options.nodeToken, log })
	tools.register(createRemindTool({ client }))
	log('info', `qq-node: registered remind against ${options.bridgeUrl}`)
	return true
}
export function registerRecallTool(ctx, options) {
	const tools = ctx.get('tools')
	if (tools === undefined || tools === null || typeof tools.register !== 'function') {
		log('warn', 'qq-node: the tools service is absent, so recall is not registered')
		return false
	}
	tools.register(createRecallTool({ dir: options.personaDir, log }))
	log('info', `qq-node: registered recall against ${options.personaDir}`)
	return true
}

/**
 * `pc_exec` / `pc_read` / `pc_write` —— 她够得到主人的电脑，但只够得到一小块。
 *
 * 注册时机不在 `apply()`：群还是私聊只有走到某一轮才知道（`runInTaskScope` 的
 * AsyncLocalStorage），所以在 `agent/inbox/inserted` 里按这一轮的真实场景决定注册或撤销。
 * 于是主人的私聊里有这三个工具，群里、别人面前一个都没有。细节见 `lib/pc-tools.js`。
 *
 * @param ctx - the plugin context; the agent-scoped `tools` service does the registering.
 * @param options - resolved config, for `pcEnabled` / `pcBaseUrl` / `pcTimeoutMs` / `nodeToken`.
 * @returns whether the channel is armed.
 */
export function registerPcTools(ctx, options) {
	if (options.pcEnabled !== true) {
		log('info', 'qq-node: pcEnabled is false, so pc_exec/pc_read/pc_write are not registered; the owner PC channel stays closed (set pcEnabled: true to open it)')
		return false
	}
	if (options.nodeToken === '') {
		log('warn', 'qq-node: pcEnabled is on but there is no node token, so the PC tools cannot authenticate against the bridge and are not registered')
		return false
	}
	const tools = ctx.get('tools')
	if (tools === undefined || tools === null || typeof tools.register !== 'function') {
		log('warn', 'qq-node: the tools service is absent, so the pc tools are not registered')
		return false
	}
	const gate = createPcToolGate({ baseUrl: options.pcBaseUrl, token: options.nodeToken, timeoutMs: options.pcTimeoutMs, log })
	// followup() 是同步插收件箱的，所以这一刻仍在 runInTaskScope() 的调用栈里：
	// 监听器读得到这一轮是群还是私聊、是不是主人，而且早于这一轮任何一次请求装配。
	ctx.on('agent/inbox/inserted', ({ agent }) => {
		gate.admit(agent)
	})
	ctx.on('agent/disposed', ({ agent }) => {
		gate.release(agent)
	})
	log('info', `qq-node: armed ${PC_TOOL_NAMES.join('/')} against ${options.pcBaseUrl} (timeout=${options.pcTimeoutMs}ms, owner private chats only)`)
	return true
}

/**
 * Start the QQ node: long-poll the cloud bridge, run each task in its QQ
 * conversation's own agent session, submit the reply.
 * @param ctx - the plugin context; `agents` is injected.
 * @param config - the patch row's config (see README).
 */export function apply(ctx, config) {
	const options = resolveOptions(config)
	// Persona and memory ride the same effect as the runner: the plugin keeps one
	// lifecycle, and `systemPrompt` is optional, so absence degrades to no injection.
	const persona = new QqPersona({ personaDir: options.personaDir, memoryDecay: options.memoryDecay, log })
	const audit = createAuditLog({ dir: options.auditDir, log })
	// 规矩和人格住在一起：备份 persona 目录就顺带保住了「他立过的规矩」。
	const corrections = createCorrectionBook({ file: join(options.personaDir, CORRECTION_FILE), log })
	registerQzoneTool(ctx, options, audit)
	registerRememberTool(ctx, options, audit)
	registerRecallTool(ctx, options)
	registerRemindTool(ctx, options)
	registerSendFileTool(ctx, options)
	registerPcTools(ctx, options)
	ctx.effect(() => {
		const detachPersona = persona.attach(ctx.get('systemPrompt'))
		if (options.nodeToken === '') {
			log('error', `qq-node: no node token (set QQ_NODE_TOKEN or config.nodeToken); not polling ${options.bridgeUrl}`)
			return () => detachPersona()
		}
		const client = new QqBridgeClient({ baseUrl: options.bridgeUrl, token: options.nodeToken, log })
		const store = new QqSessionStore({ ctx, options, client, log })
		const runner = new QqNodeRunner({ ctx, client, store, options, log, audit, corrections })
		// 夜班挂在同一条 lifecycle 上：它和长轮询是同一个插件的两件事，关掉插件就该两件
		// 都停。它写盘失败也烧不到主链路（见 lib/nightly-runner.js）。
		const nightly = new QqNightlyRunner({ ctx, options, log, audit })
		if (options.nightlyEnabled === true) {
			log('info', `qq-node: nightly review armed for ${String(options.nightlyHour).padStart(2, '0')}:10 Asia/Shanghai (digest ← ${options.nightlyDigestDir}, memory → ${join(options.personaDir, 'MEMORY.md')}, proposals → ${options.proposalsDir}, timeout=${options.nightlyTimeoutMs}ms)`)
			nightly.start()
		} else {
			log('info', 'qq-node: nightly review is off; nothing reads the digest or touches MEMORY.md at night (set nightlyEnabled: true to turn it on)')
		}
		log('info', `qq-node: polling ${options.bridgeUrl} (limit=${options.pollLimit}, wait=${options.pollWaitSeconds}s, concurrency=${options.maxConcurrentTurns})`)
		log('info', `qq-node: audit → ${audit.disabled ? '(disabled)' : options.auditDir}; effort tiering ${options.tiering === undefined ? 'off' : `on (light ≤ ${options.tiering.lightMaxChars} chars → ${options.tiering.lightEffort === '' ? 'provider default' : options.tiering.lightEffort})`}`)
		log('info', `qq-node: session rotation ${options.sessionMaxTurns === 0 ? 'off' : `after ${options.sessionMaxTurns} turn(s)`}; idle rotation ${options.sessionRotateAfterIdleMs === 0 ? 'off' : `after ${Math.round(options.sessionRotateAfterIdleMs / 60_000)}min of silence`}`)
		log('info', `qq-node: private-chat batching ${options.batchWindowMs === 0 ? 'off' : `on (${options.batchWindowMs}ms window, groups never batch)`}`)
		runner.start()
		return () => {
			nightly.stop()
			detachPersona()
			return runner.stop()
		}
	}, 'qq-node.runner')
}
