import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'

/**
 * 夜班产出的解析、校验与落盘（`docs/nightly-contract.md` 的「输出信封」与「硬上限」两节）。
 *
 * 这里没有一处「尽力修补」：解析失败就是整轮作废，超过上限也是整轮作废。
 * 半截记忆比没有记忆更坏——她会当真；半截 diff 比没有提案更坏——apply 脚本会把它
 * 打进代码里。所以解析器只在输出完全符合信封时才返回 ok。
 */

/** 每晚档的硬上限；与契约表格一一对应。 */
export const NIGHTLY_CAPS = Object.freeze({
	/** 新增 memory 行数。 */
	memories: 5,
	/** proposal 条数。 */
	proposals: 3,
	/** 单条 diff 行数。 */
	diffLines: 120,
	/** MEMORY.md 总行数。 */
	memoryLines: 60,
	/** 输入 digest 行数。 */
	digestLines: 200,
	/** 轮次超时（毫秒）。 */
	timeoutMs: 120_000,
})

/** 周日深度档：行数与超时按契约放宽，记忆总行数仍锁在 60。 */
export const DEEP_CAPS = Object.freeze({
	memories: 10,
	proposals: 5,
	diffLines: 200,
	memoryLines: 60,
	digestLines: 400,
	timeoutMs: 180_000,
})

/**
 * 按档位算出本次的实际上限。
 *
 * 配置里的 `nightlyMaxMemories` / `nightlyMaxProposals` 是**每晚**档；深度档最多翻倍，
 * 但不得越过契约的每周上限——所以是 `min(契约上限, 配置值 × 2)`。
 *
 * @param options.deep - 是否深度档（周日）。
 * @param options.maxMemories - 配置的每晚 memory 上限。
 * @param options.maxProposals - 配置的每晚 proposal 上限。
 * @param options.timeoutMs - 配置的每晚轮次超时。
 */
export function capsFor({ deep = false, maxMemories = NIGHTLY_CAPS.memories, maxProposals = NIGHTLY_CAPS.proposals, timeoutMs = NIGHTLY_CAPS.timeoutMs } = {}) {
	const nightly = positiveInt(maxMemories, NIGHTLY_CAPS.memories)
	const proposals = positiveInt(maxProposals, NIGHTLY_CAPS.proposals)
	const timeout = positiveInt(timeoutMs, NIGHTLY_CAPS.timeoutMs)
	if (deep !== true) return { ...NIGHTLY_CAPS, memories: nightly, proposals, timeoutMs: timeout }
	return {
		memories: Math.min(DEEP_CAPS.memories, nightly * 2),
		proposals: Math.min(DEEP_CAPS.proposals, proposals * 2),
		diffLines: DEEP_CAPS.diffLines,
		memoryLines: DEEP_CAPS.memoryLines,
		digestLines: DEEP_CAPS.digestLines,
		timeoutMs: Math.max(DEEP_CAPS.timeoutMs, timeout),
	}
}

function positiveInt(value, fallback) {
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}

/** A fence opener: three or more backticks, then an optional language tag. */
const OPEN_FENCE = /^(`{3,})([A-Za-z]*)$/
/** A fence closer. */
const CLOSE_FENCE = /^`{3,}$/
/** One memory line: `- [w:3] 文本`. The weight digits are checked for range after matching. */
const MEMORY_LINE = /^- \[w:([0-9]+)\][ \t]+(\S.*)$/
/** First line of a proposal block. */
const FILE_FIELD = /^file:[ \t]*(\S.*)$/
/** Second line of a proposal block. */
const WHY_FIELD = /^why:[ \t]*(\S.*)$/
/** 她写进 MEMORY.md 的记忆行：`- [w:N][k:kind] 文本`，档位可有可无（旧文件里没有）。 */
const WEIGHTED_ITEM = /^[-*+][ \t]+\[w:([0-9]+(?:\.[0-9]+)?)\](?:\[k:([a-z]+)\])?[ \t]+(\S.*)$/
/** 只有档没有权重的行：`- [k:event] 文本`。 */
const KIND_ONLY_ITEM = /^[-*+][ \t]+\[k:([a-z]+)\][ \t]+(\S.*)$/
/** A top-level bullet with no weight prefix: an ordinary line, evicted only as a last resort. */
const PLAIN_ITEM = /^[-*+][ \t]+(\S.*)$/
/** 不许被夜间合并挤掉的档位：这几档是「她是谁」「他怎么要求」和共同经历。 */
const PROTECTED_KINDS = new Set(['identity', 'rule'])

const clip = (line) => {
	const text = String(line ?? '')
	return text.length > 60 ? `${text.slice(0, 60)}…` : text
}

/**
 * 这一轮的「今天没什么可记」暗号。模型只回这一行时，解析算成功、零写入。
 *
 * 为什么需要它：没有工具的一轮里，模型很容易把「无话可说」表达成一句抱怨，
 * 那种回复既没有块也不该算失败；但「它偷偷去调工具、结果吐出半截标记」必须算失败。
 * 两者只能靠模型自己挑的暗号区分，不能靠猜。
 */
export const NIGHTLY_NONE_MARKER = 'NIGHTLY-NONE'

/**
 * 提案/意图唯一能指向的真实文件清单：**路径 + 一句人话**。
 *
 * 为什么写死一份：她第一次跑夜班时把 `bridge/src/asr.js` 写成了 `agent/src/asr.js`，
 * 目录是编的，补丁再好也打不上。清单短、变化慢，比让她自由猜路径可靠得多。
 *
 * 为什么放在解析模块里而不是留在提示词里：提示词只是提醒，一条 `file:` 收不收得下
 * 得由校验说了算。两处各存一份清单迟早会飘，所以正本在这里，`nightly-runner.js`
 * 只把它转出去并原样列进提示词。
 */
const FILE_GLOSS = Object.freeze([
	['bridge/src/delivery.js', '发送与重试'],
	['bridge/src/asr.js', '语音转写'],
	['bridge/src/proactive.js', '主动开口的闸门'],
	['bridge/src/dispatch.js', '回复分段、语音/文字'],
	['bridge/src/http.js', '节点 API 路由'],
	['bridge/src/onebot.js', 'OneBot 11 客户端'],
	['bridge/src/config.js', '环境变量解析'],
	['node-plugin/lib/tier.js', '思考分档'],
	['node-plugin/lib/audit.js', '审计留痕'],
	['node-plugin/lib/pc-tools.js', 'PC 工具通道'],
	['node-plugin/lib/nightly.js', '夜班输出解析'],
	['node-plugin/lib/nightly-runner.js', '夜班触发与落盘'],
	['node-plugin/lib/session.js', '会话轮次'],
	['node-plugin/lib/runner.js', '任务投递'],
])

/** 清单里的路径本身；intent 的 `file:` 必须逐字命中其中一条。 */
export const NIGHTLY_FILE_PATHS = Object.freeze(FILE_GLOSS.map(([file]) => file))

/** 同一份清单带注释，提示词原样列出来给她抄——与 {@link NIGHTLY_FILE_PATHS} 永远同源。 */
export const NIGHTLY_FILE_HINTS = Object.freeze(FILE_GLOSS.map(([file, note]) => `${file} — ${note}`))

/** 时间戳：`HH:MM`，或带秒的 `HH:MM:SS`（digest 里 `证据 05:57:22Z` 的那一段也算）。 */
const EVIDENCE_CLOCK = /(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?/u
/** 引号里的日志原文片段：反引号、中文引号、直角引号都算，里面至少 4 个字符。 */
const EVIDENCE_QUOTE = /[`「『“"][^`」』”"]{4,}[`」』”"]/u
/** 审计数字：数字 + 计数/计量单位，或百分数。`失败 4 次`、`37 条`、`72%` 都算。 */
const EVIDENCE_COUNT = /\d+(?:\.\d+)?[ \t]*(?:次|条|笔|行|份|个|秒|分钟|小时|天|ms|MB|KB|%)/u

/**
 * `why:` 里有没有「具体证据」。
 *
 * 判据只有三条，命中任意一条即算——这三条正好是挖矿器写进 digest 的东西，
 * 能抄对一条就说明她真读了清单，而不是又编一句「这里可能有问题」：
 * 1. 时间戳 `HH:MM` / `HH:MM:SS`（digest 每条异常后面都挂着 `证据 05:57:22Z`）；
 * 2. 引号里的日志原文（`` `PermissionError` ``、「Failed to connect」）；
 * 3. 带单位的审计数字（`失败 4 次`、`37 条`、`72%`）。
 *
 * 只判「有没有」，不判「对不对」：对不对要靠早上看那一行日志的人。
 *
 * @param why - intent 块里 `why:` 的原文。
 * @returns 命中任意一条判据时为 true。
 */
export function intentWhyHasEvidence(why) {
	const text = String(why ?? '')
	return EVIDENCE_CLOCK.test(text) || EVIDENCE_QUOTE.test(text) || EVIDENCE_COUNT.test(text)
}

/** intent 块里的四个必填字段，每行一个「名字: 值」，值可以续行。 */
const INTENT_FIELD = /^(file|why|change|verify)[ \t]*:[ \t]*(.*)$/
/** `change:` 的行数区间：少于三行说不清要改什么，多于六行早上没人看得完。 */
const CHANGE_MIN_LINES = 3
const CHANGE_MAX_LINES = 6
/** 汉字；只用来判「这行是中文说明」还是「这行是半截代码」。 */
const HAN = /\p{Script=Han}/u

/**
 * 解析模型那一轮的回复。
 *
 * 认三种 fenced block：`memory`、`intent`（主通道）与 `proposal`（旧通道，没有工具
 * 可读文件时打不上，暂时停用但没有拆掉）。其余文字与其余语言的块一律忽略。
 *
 * 作废的粒度按「坏了会有什么后果」定：
 * - memory 块里有一行不合格式 → 整轮作废。半截记忆比没有记忆更坏，她会当真；
 * - proposal 块结构不对 → **只丢这一块**，原因进 `rejected`。结构不成立的补丁根本
 *   不会写成 `.patch`，下游 apply 脚本连看都看不到，因此它没有能力伤到代码；反过来
 *   若为它作废整轮，一条旧通道的坏块就能连带丢掉同一晚的记忆与意图——这正是三晚
 *   零产出的事故形态；
 * - intent 块坏了 → 同样只丢这一条。一条说不清证据的意图不连累一条说得清的记忆；
 * - 丢光的轮次仍是成功：写盘侧什么都不写，但每一条被丢的理由都进日志，避免「无声
 *   的一夜」被当成一夜无事。
 *
 * @param text - 模型回复原文。
 * @returns `{ ok: true, memories, proposals, intents, rejected }`，或 `{ ok: false, reason }`。
 */
export function parseNightlyOutput(text) {
	const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n')
	const memories = []
	const proposals = []
	const intents = []
	const rejected = []
	let blocks = 0
	for (let index = 0; index < lines.length; index += 1) {
		const open = OPEN_FENCE.exec(lines[index].trim())
		if (open === null) continue
		const language = open[2].toLowerCase()
		const body = []
		let closed = false
		for (index += 1; index < lines.length; index += 1) {
			if (CLOSE_FENCE.test(lines[index].trim())) {
				closed = true
				break
			}
			body.push(lines[index])
		}
		if (!closed) return { ok: false, reason: '有一个 fenced block 没有收尾（缺收尾的 ```），整轮作废' }
		// 孤零零的三反引号，以及 `js`、`diff` 这类别的块：整块跳过，连里面像不像
		// 我们的信封都不看。
		if (language !== 'memory' && language !== 'proposal' && language !== 'intent') continue
		blocks += 1
		if (language === 'memory') {
			const parsed = parseMemoryBlock(body)
			if (parsed.ok !== true) return parsed
			memories.push(...parsed.memories)
			continue
		}
		if (language === 'intent') {
			const parsed = parseIntentBlock(body)
			if (parsed.ok === true) intents.push(parsed.intent)
			else rejected.push({ reason: parsed.reason })
			continue
		}
		const parsed = parseProposalBlock(body)
		if (parsed.ok !== true) {
			rejected.push({ reason: parsed.reason })
			continue
		}
		proposals.push(parsed.proposal)
	}
	const envelope = { ok: true, memories, proposals, intents, rejected }
	if (blocks === 0) {
		if (String(text ?? '').includes(NIGHTLY_NONE_MARKER)) return envelope
		return { ok: false, reason: '回复里没有任何 memory / proposal 块（也没有 intent 块），整轮作废' }
	}
	return envelope
}

function parseMemoryBlock(rawLines) {
	const memories = []
	for (const raw of rawLines) {
		const line = raw.trim()
		if (line === '') continue
		const match = MEMORY_LINE.exec(line)
		if (match === null) return { ok: false, reason: `memory 行格式必须是 "- [w:N] 文本"，实际是 ${clip(line)}` }
		const weight = Number(match[1])
		if (!(weight >= 1 && weight <= 5)) return { ok: false, reason: `memory 权重越界（只能 1..5），实际是 [w:${match[1]}]` }
		memories.push({ weight, text: match[2].trim() })
	}
	if (memories.length === 0) return { ok: false, reason: 'memory 块是空的' }
	return { ok: true, memories }
}

function parseProposalBlock(rawLines) {
	const lines = trimBlankLines(rawLines)
	if (lines.length === 0) return { ok: false, reason: 'proposal 块是空的' }
	const file = FILE_FIELD.exec(lines[0].trim())
	if (file === null) return { ok: false, reason: `proposal 第一行必须是 "file: <路径>"，实际是 ${clip(lines[0])}` }
	if (lines.length < 3) return { ok: false, reason: 'proposal 至少要有 file:、why:、--- 三行' }
	const why = WHY_FIELD.exec(lines[1].trim())
	if (why === null) return { ok: false, reason: `proposal 第二行必须是 "why: <理由>"，实际是 ${clip(lines[1])}` }
	if (lines[2].trim() !== '---') return { ok: false, reason: `proposal 第三行必须是 ---，实际是 ${clip(lines[2])}` }
	const diff = recountPatchHunks(trimBlankLines(lines.slice(3)).join('\n'))
	if (diff === '') return { ok: false, reason: 'proposal 的 diff 是空的' }
	return { ok: true, proposal: { file: file[1].trim(), why: why[1].trim(), diff } }
}

/**
 * 解析一个 `intent` 块：意图 + 真实证据，不是补丁。
 *
 * 格式是一行一个 `名字: 值`，值后面可以继续带缩进续行（`change:` 就是这么写成
 * 三到六条要点的）。字段名之前的散行没有归属，整块判废——猜它属于哪个字段比丢掉
 * 它更危险。
 *
 * 校验顺序就是提示词里列的顺序，报错文案里带字段名，好让她自己看懂哪一条被丢了。
 *
 * @param rawLines - 块内每一行原文。
 * @returns `{ ok: true, intent: { file, why, change, verify } }`，或 `{ ok: false, reason }`。
 */
function parseIntentBlock(rawLines) {
	const lines = trimBlankLines(rawLines)
	if (lines.length === 0) return { ok: false, reason: 'intent 块是空的' }
	const fields = new Map()
	let current = ''
	for (const raw of lines) {
		const match = INTENT_FIELD.exec(raw.trim())
		if (match !== null) {
			current = match[1]
			if (!fields.has(current)) fields.set(current, [])
			const value = match[2].trim()
			if (value !== '') fields.get(current).push(value)
			continue
		}
		if (current === '') {
			return { ok: false, reason: `intent 第一行必须是 file: / why: / change: / verify:，实际是 ${clip(raw)}` }
		}
		fields.get(current).push(raw.trim())
	}
	const value = (name) => (fields.get(name) ?? []).filter((line) => line !== '')
	const file = value('file')[0] ?? ''
	const why = value('why').join(' ').trim()
	const change = value('change')
	const verify = value('verify').join(' ').trim()
	if (file === '') return { ok: false, reason: 'intent 缺 file:（必填）' }
	if (!NIGHTLY_FILE_PATHS.includes(file)) {
		return { ok: false, reason: `intent 的 file 不在真实清单里，整条丢弃：${clip(file)}` }
	}
	if (why === '') return { ok: false, reason: `intent 缺 why:（必填）：${file}` }
	if (!intentWhyHasEvidence(why)) {
		return { ok: false, reason: `intent 的 why: 里没有任何具体证据（要 HH:MM 时间戳、引号里的日志原文，或带单位的审计数字）：${file} — ${clip(why)}` }
	}
	if (change.length < CHANGE_MIN_LINES || change.length > CHANGE_MAX_LINES) {
		return { ok: false, reason: `intent 的 change: 要 ${CHANGE_MIN_LINES} 到 ${CHANGE_MAX_LINES} 行中文，实际 ${change.length} 行：${file}` }
	}
	if (!change.some((line) => HAN.test(line))) {
		return { ok: false, reason: `intent 的 change: 里没有中文，看不出打算怎么改：${file}` }
	}
	if (verify === '') return { ok: false, reason: `intent 缺 verify:（必填）：${file}` }
	return { ok: true, intent: { file, why, change: change.join('\n'), verify } }
}

/** 一段 hunk 头：`@@` 可带也可不带行号，尾部允许有函数名提示。 */
const HUNK_HEADER = /^@@(?:\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?)?\s*(?:@@(.*))?$/

/**
 * 按 hunk 正文重算行数，修掉「头里写的行数和正文对不上」这类畸形 diff。
 *
 * 模型写补丁时经常把 `@@ -52,6 +52,9 @@` 的数字写错（正文只有 5 旧行 8 新行），
 * GNU patch 会直接 `malformed patch` 拒绝——2026-10-27 那两份提案就是这么废掉的。
 * 行数可以从正文数出来，起始行号错了 patch 还能靠上下文搜，所以只重算计数、不动起点；
 * 头里没有行号的，起点用上一个 hunk 的结尾推算。正文出现既不是 +/-/空格/反斜杠的行
 * （多半是散文漏进来了）就整段原样返回，交给应用端报错，不在这里瞎猜。
 *
 * @param diff - 原始 diff 文本。
 * @returns 行数已校正的 diff；没有 hunk 或正文不合法时原样返回。
 */
export function recountPatchHunks(diff) {
	const text = String(diff ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
	if (text === '') return ''
	const lines = text.split('\n')
	const out = []
	let cursor = 0
	let lastOldEnd = 0
	let lastNewEnd = 0
	while (cursor < lines.length) {
		const header = HUNK_HEADER.exec(lines[cursor])
		if (header === null) {
			out.push(lines[cursor])
			cursor += 1
			continue
		}
		const body = []
		let next = cursor + 1
		while (next < lines.length && !lines[next].startsWith('@@')) {
			body.push(lines[next])
			next += 1
		}
		const counted = countHunkBody(body)
		if (counted === null) {
			out.push(...lines.slice(cursor, next))
			cursor = next
			continue
		}
		const oldStart = header[1] !== undefined ? Number(header[1]) : (lastOldEnd > 0 ? lastOldEnd : 1)
		const newStart = header[3] !== undefined ? Number(header[3]) : (lastNewEnd > 0 ? lastNewEnd : 1)
		const trailing = header[5] ?? ''
		out.push(`@@ -${oldStart},${counted.oldCount} +${newStart},${counted.newCount} @@${trailing}`)
		out.push(...counted.lines)
		lastOldEnd = oldStart + counted.oldCount
		lastNewEnd = newStart + counted.newCount
		cursor = next
	}
	return out.join('\n')
}

/**
 * 数一段 hunk 正文的旧行/新行。空行按「空上下文行」算并补回前导空格——
 * 模型常把只有空格的上下文行写成真正的空行，patch 会当成畸形。
 *
 * @param body - hunk 头之后、下一个 hunk 之前的行。
 * @returns `{ lines, oldCount, newCount }`；正文不合法时 `null`。
 */
function countHunkBody(body) {
	const lines = []
	let oldCount = 0
	let newCount = 0
	for (const raw of body) {
		if (raw === '') {
			lines.push(' ')
			oldCount += 1
			newCount += 1
			continue
		}
		const lead = raw[0]
		if (lead === ' ') {
			lines.push(raw)
			oldCount += 1
			newCount += 1
		} else if (lead === '-') {
			lines.push(raw)
			oldCount += 1
		} else if (lead === '+') {
			lines.push(raw)
			newCount += 1
		} else if (lead === '\\') {
			lines.push(raw)
		} else {
			return null
		}
	}
	return { lines, oldCount, newCount }
}

function trimBlankLines(lines) {
	let start = 0
	let end = lines.length
	while (start < end && lines[start].trim() === '') start += 1
	while (end > start && lines[end - 1].trim() === '') end -= 1
	return lines.slice(start, end)
}

/** 一条 diff 占几行；空 diff 是 0 行。 */
export function diffLineCount(diff) {
	const text = String(diff ?? '').trim()
	return text === '' ? 0 : text.split('\n').length
}

/**
 * 按硬上限校验一次解析结果。
 *
 * 只回答「行不行」，从不改数据：超限就整轮作废，不截断——截断出来的 diff 会
 * 少一半上下文，apply 脚本照样会把它打进文件里；截断出来的 intent 则会被当成
 * 「完整意图」交给早上照着改代码的人，比没有更糟。
 *
 * intent 的四个字段在解析阶段已经逐条验过（不在清单里的 file 早就被丢了），
 * 这里只再兜一遍形状，防止有人绕过 {@link parseNightlyOutput} 直接喂数据。
 *
 * @param parsed - `{ memories, proposals, intents }`。
 * @param caps - 上限集合，缺省 {@link NIGHTLY_CAPS}。
 */
export function validateNightly({ memories, proposals, intents } = {}, caps = NIGHTLY_CAPS) {
	if (!Array.isArray(memories) || !Array.isArray(proposals)) {
		return { ok: false, reason: 'memories 与 proposals 必须是数组' }
	}
	const list = Array.isArray(intents) ? intents : []
	const limit = { ...NIGHTLY_CAPS, ...(caps ?? {}) }
	if (memories.length > limit.memories) {
		return { ok: false, reason: `memory 有 ${memories.length} 行，超过上限 ${limit.memories} 行` }
	}
	if (proposals.length > limit.proposals) {
		return { ok: false, reason: `proposal 有 ${proposals.length} 条，超过上限 ${limit.proposals} 条` }
	}
	// intent 与 proposal 共用一个数量上限：两条通道各自都不许超过它。
	if (list.length > limit.proposals) {
		return { ok: false, reason: `intent 有 ${list.length} 条，超过上限 ${limit.proposals} 条` }
	}
	for (const [index, memory] of memories.entries()) {
		const weight = memory?.weight
		if (!Number.isInteger(weight) || weight < 1 || weight > 5) {
			return { ok: false, reason: `第 ${index + 1} 条 memory 的权重必须是 1..5 的整数，实际是 ${JSON.stringify(weight)}` }
		}
		if (typeof memory?.text !== 'string' || memory.text.trim() === '') {
			return { ok: false, reason: `第 ${index + 1} 条 memory 没有正文` }
		}
	}
	for (const [index, intent] of list.entries()) {
		if (typeof intent?.file !== 'string' || intent.file.trim() === '') {
			return { ok: false, reason: `第 ${index + 1} 条 intent 没有 file` }
		}
		if (typeof intent?.why !== 'string' || intent.why.trim() === '') {
			return { ok: false, reason: `第 ${index + 1} 条 intent 没有 why` }
		}
		if (typeof intent?.change !== 'string' || intent.change.trim() === '') {
			return { ok: false, reason: `第 ${index + 1} 条 intent 没有 change` }
		}
		if (typeof intent?.verify !== 'string' || intent.verify.trim() === '') {
			return { ok: false, reason: `第 ${index + 1} 条 intent 没有 verify` }
		}
	}
	for (const [index, proposal] of proposals.entries()) {
		if (typeof proposal?.file !== 'string' || proposal.file.trim() === '') {
			return { ok: false, reason: `第 ${index + 1} 条 proposal 没有 file` }
		}
		if (typeof proposal?.why !== 'string' || proposal.why.trim() === '') {
			return { ok: false, reason: `第 ${index + 1} 条 proposal 没有 why` }
		}
		const count = diffLineCount(proposal?.diff)
		if (count === 0) return { ok: false, reason: `第 ${index + 1} 条 proposal 的 diff 是空的` }
		if (count > limit.diffLines) {
			return { ok: false, reason: `第 ${index + 1} 条 proposal 的 diff 有 ${count} 行，超过上限 ${limit.diffLines} 行` }
		}
	}
	return { ok: true }
}

/**
 * 提案能指向的真实文件根目录：**服务器上的布局**，不是仓库布局。
 *
 * 提案里写的是仓库视图（`node-plugin/lib/x.js`），夜里自检要读的却是服务器上跑着
 * 的那份副本；两边根目录不同，猜错一个目录就等于对着空文件做自检。
 * `node-plugin/` 额外留了一个环境变量出口：本机调试时没有 `/opt` 这棵树。
 */
export const PROPOSAL_ROOTS = Object.freeze([
	{ prefix: 'node-plugin/', root: '/opt/dsh-qq-agent/node-plugin/', env: 'DSH_QQ_NODE_PLUGIN_DIR' },
	{ prefix: 'bridge/', root: '/opt/dsh-qq-bridge/', env: 'DSH_QQ_BRIDGE_DIR' },
	{ prefix: 'deploy/', root: '/opt/dsh-qq-agent/deploy/', env: 'DSH_QQ_DEPLOY_DIR' },
])

/** 自检能读的单文件上限；超过就不补救——把这么长的全文塞进提示词，多半只是烧钱。 */
export const PROPOSAL_MAX_BYTES = 24 * 1024

/** 只读这三种源码：别的文件读不了，一律按「没法自检」处理。 */
const PROPOSAL_EXTENSIONS = new Set(['.js', '.mjs', '.sh'])

/**
 * 把提案里的 `file:` 换成真实路径。
 *
 * 这里只做映射与拒绝，不碰文件系统：路径不合规要在读盘之前就说清楚。
 *
 * @param file - 提案里的仓库相对路径。
 * @param options.env - 环境变量表，只有 `node-plugin/` 的根目录可以被它覆盖。
 * @returns `{ ok: true, path, file }`，或 `{ ok: false, reason }`。
 */
export function resolveProposalPath(file, { env = process.env } = {}) {
	const text = String(file ?? '').trim().replace(/\\/gu, '/')
	if (text === '') return { ok: false, reason: '提案没有 file，无从自检' }
	// `..` 不是「拼错了一点」，是「想读别处」：直接拒绝，不做归一化后重试。
	if (text.split('/').includes('..')) return { ok: false, reason: `路径里出现 ..，拒绝读取：${text}` }
	const entry = PROPOSAL_ROOTS.find((item) => text.startsWith(item.prefix))
	if (entry === undefined) return { ok: false, reason: `不在可读的三个前缀（node-plugin/、bridge/、deploy/）之内：${text}` }
	const extension = extname(text).toLowerCase()
	if (!PROPOSAL_EXTENSIONS.has(extension)) {
		return { ok: false, reason: `只读 .js / .mjs / .sh，收到 ${JSON.stringify(extension === '' ? '(没有扩展名)' : extension)}：${text}` }
	}
	const override = entry.env === '' ? '' : String(env?.[entry.env] ?? '').trim()
	const base = override === '' ? entry.root : `${override.replace(/\\/gu, '/').replace(/\/+$/u, '')}/`
	return { ok: true, path: join(base, text.slice(entry.prefix.length)), file: text }
}

/**
 * 读出一份提案要改的真实文件，读之前先把「能不能读」判掉。
 *
 * 读不到不等于打不上：ENOENT 只说明服务器上没有这个文件，说明不了补丁好不好。
 * 但对提案来说两者一样致命——所以这里返回失败，由调用方标记 `verified: false`。
 *
 * @param file - 提案里的仓库相对路径。
 * @param options.env - 环境变量表，见 {@link resolveProposalPath}。
 * @param options.readFile - 注入的读文件函数（测试用）。
 * @returns `{ ok: true, path, file, text }`，或 `{ ok: false, reason }`。
 */
export function readProposalSource(file, { env = process.env, readFile = readFileSync } = {}) {
	const resolved = resolveProposalPath(file, { env })
	if (resolved.ok !== true) return resolved
	let text
	try {
		text = String(readFile(resolved.path, 'utf8'))
	} catch (error) {
		return { ok: false, path: resolved.path, reason: `读不到真实文件（${error?.code ?? error?.message ?? String(error)}），无法自检：${resolved.file}` }
	}
	const bytes = Buffer.byteLength(text, 'utf8')
	if (bytes > PROPOSAL_MAX_BYTES) {
		return { ok: false, path: resolved.path, reason: `真实文件过大（${bytes} 字节，上限 ${PROPOSAL_MAX_BYTES} 字节），无法自检：${resolved.file}` }
	}
	return { ok: true, path: resolved.path, file: resolved.file, text }
}

/** 一段「期望 / 实际」摘要里引用的一行：夹在一对 JSON 引号里，\t 之类的空白才看得见。 */
const quoteLine = (line) => JSON.stringify(clip(line))

/**
 * 按行切开，且**不把结尾的换行算成一行**：磁盘上的文件与写盘的 .patch 都以换行收尾，
 * 若把末尾那个 `''` 当真空行，最后一个 hunk 就会凭空多要求一行上下文，明明打得上的
 * 补丁会被判成打不上。
 */
const splitLines = (value) => {
	const text = String(value ?? '').replace(/\r\n?/gu, '\n')
	if (text === '') return []
	const lines = text.split('\n')
	if (lines[lines.length - 1] === '') lines.pop()
	return lines
}

/**
 * 把 diff 拆成 hunk，每个 hunk 只留「旧文件那一侧」的行。
 *
 * 旧文件那一侧 = 上下文行（前导空格）+ 删除行（前导 `-`）。`+` 行是新内容、
 * `\` 是「文件末尾没有换行」的标记，两者都不在旧文件里，不参与查找。
 */
function readHunks(lines) {
	const hunks = []
	let cursor = 0
	while (cursor < lines.length) {
		const header = HUNK_HEADER.exec(lines[cursor])
		if (header === null) {
			cursor += 1
			continue
		}
		const old = []
		let next = cursor + 1
		while (next < lines.length && !lines[next].startsWith('@@')) {
			const raw = lines[next]
			// 真空行按空上下文行算：recount 已经补过前导空格，这里只是兜底。
			if (raw === '' || raw[0] === ' ') old.push(raw.slice(1))
			else if (raw[0] === '-') old.push(raw.slice(1))
			next += 1
		}
		hunks.push({ oldStart: header[1] === undefined ? 0 : Number(header[1]), old })
		cursor = next
	}
	return hunks
}

/** 在 target 里从 from 起找 seq 第一次连续出现的位置；找不到返回 -1。 */
function searchSequence(target, seq, from) {
	if (seq.length === 0) return Math.min(Math.max(0, from), target.length)
	for (let start = Math.max(0, from); start + seq.length <= target.length; start += 1) {
		let offset = 0
		while (offset < seq.length && target[start + offset] === seq[offset]) offset += 1
		if (offset === seq.length) return start
	}
	return -1
}

/**
 * 一段差异摘要：只说行号与那两行本身，绝不把整份文件搬进日志。
 *
 * 引用行按 60 字裁过，而且一律走 {@link quoteLine}——缩进对不上时，
 * `"\tconst x"` 和 `"    const x"` 一眼就能看出区别，纯文本看不出来。
 */
function describeMiss(target, seq, start) {
	const index = Math.max(0, start - 1)
	const expected = seq[0] ?? ''
	const actual = target[index]
	if (actual === undefined) return `文件只有 ${target.length} 行，没有第 ${index + 1} 行（期望 ${quoteLine(expected)}）`
	if (actual !== expected) {
		const elsewhere = target.indexOf(expected)
		const tail = elsewhere < 0 ? '这一行在目标文件里根本不存在' : `同样的一行出现在第 ${elsewhere + 1} 行`
		return `期望第 ${index + 1} 行是 ${quoteLine(expected)}，实际是 ${quoteLine(actual)}；${tail}`
	}
	let offset = 1
	while (offset < seq.length && index + offset < target.length && target[index + offset] === seq[offset]) offset += 1
	const line = index + offset
	return `第 ${line + 1} 行对不上：期望 ${quoteLine(seq[offset] ?? '')}，实际 ${quoteLine(target[line] ?? '(文件结束)')}`
}

/**
 * 判一份 diff 能不能打到 `text` 上：不调 `patch`、不写临时文件。
 *
 * 判据只有一个：每个 hunk 的上下文行与删除行必须能在目标文件里**逐字、连续**
 * 地按顺序找到。行号允许偏移（GNU patch 也是按上下文搜的），第二个 hunk 从第一个
 * 结束的位置往后找，不回头。这样判出来的结论与 `patch --dry-run` 在「打得上 /
 * 打不上」上一致，但不必起子进程，也不怕服务器上根本没有 patch 命令。
 *
 * @param diff - 校正过行数的 diff 文本。
 * @param text - 目标文件全文。
 * @returns `{ ok: true, hunks }`，或 `{ ok: false, hunk, line, reason }`。
 */
export function verifyPatchAgainstText(diff, text) {
	const hunks = readHunks(splitLines(diff))
	// 只有 `---`/`+++` 两个文件头的 diff 什么也改不了：它「打得上」，但等于没提案。
	if (hunks.length === 0) return { ok: false, hunk: 0, line: 0, reason: '这份 diff 里没有任何 @@ 段落头，打不上' }
	const target = splitLines(text)
	let cursor = 0
	for (const [index, hunk] of hunks.entries()) {
		const found = searchSequence(target, hunk.old, cursor)
		if (found >= 0) {
			cursor = found + hunk.old.length
			continue
		}
		// 找不到就按「本来应该在哪一行」报告：头里的起点，且不能早于上一段结束的位置。
		const line = Math.max(hunk.oldStart > 0 ? hunk.oldStart : cursor + 1, cursor + 1)
		return {
			ok: false,
			hunk: index + 1,
			line,
			reason: `hunk #${index + 1} 按顺序找不到（从第 ${line} 行起，${hunk.old.length} 行上下文/删除行）：${describeMiss(target, hunk.old, line)}`,
		}
	}
	return { ok: true, hunks: hunks.length }
}

const collapse = (value) => String(value ?? '').replace(/\s+/gu, ' ').trim()

/** 权重兜底：只有绕过校验直接调用 mergeMemory 时才会走到这里。 */
function weightOf(value) {
	return Number.isInteger(value) && value >= 1 && value <= 5 ? value : 3
}

/** 这一行的档位（`[k:…]`）；没打标就是空串，按旧行为处理。 */
function kindOf(line) {
	const weighted = WEIGHTED_ITEM.exec(line)
	if (weighted !== null) return weighted[2] ?? ''
	const kindOnly = KIND_ONLY_ITEM.exec(line)
	return kindOnly === null ? '' : kindOnly[1]
}

/** The body of a memory/plain bullet line, used to keep the same fact out of the file twice. */
function bodyOf(line) {
	const weighted = WEIGHTED_ITEM.exec(line)
	if (weighted !== null) return collapse(weighted[3])
	const kindOnly = KIND_ONLY_ITEM.exec(line)
	if (kindOnly !== null) return collapse(kindOnly[2])
	const plain = PLAIN_ITEM.exec(line)
	return plain === null ? '' : collapse(plain[1])
}

/**
 * 往 MEMORY.md 里追加新行，超出 `maxLines` 时按「权重最低、且最旧」挤掉旧行。
 *
 * 可挤的范围只有两类：带 `[w:N]` 的记忆条目（先挤），其次是不带权重的普通条目
 * （实在没别的可挤时才动）。标题、引用、空行这些结构性行永远不动——挤掉 `## 关于主人`
 * 不会让文件变短，只会让它失去意义。
 *
 * @param existingText - 现有 MEMORY.md 全文，可为空。
 * @param memories - `{ weight, text }[]`。
 * @param options.maxLines - 总行数上限。
 * @returns `{ text, added, dropped, droppedLines }`；`text` 以换行结尾（非空时）。
 */
export function mergeMemory(existingText, memories, { maxLines = NIGHTLY_CAPS.memoryLines } = {}) {
	const limit = positiveInt(maxLines, NIGHTLY_CAPS.memoryLines)
	const base = String(existingText ?? '').replace(/\r\n?/g, '\n')
	const lines = base === '' ? [] : base.replace(/\n+$/, '').split('\n')
	// 只许挤掉「今天之前就在文件里」的行：同一轮里刚写进来的事实不能被同一轮删掉，
	// 否则 added=1 / dropped=1 的账看着对，实际她一个字都没多记住。
	const existingCount = lines.length
	const seen = new Set()
	for (const line of lines) {
		const body = bodyOf(line)
		if (body !== '') seen.add(body)
	}
	let added = 0
	for (const memory of Array.isArray(memories) ? memories : []) {
		const text = collapse(memory?.text)
		if (text === '' || seen.has(text)) continue
		const weight = weightOf(memory?.weight)
		// 夜班写下的事实自带档位：w5 是「她是谁」，其余按笔记走 90 天曲线。
		const kind = weight >= 5 ? 'identity' : 'note'
		lines.push(`- [w:${weight}][k:${kind}] ${text}`)
		seen.add(text)
		added += 1
	}
	const droppedLines = []
	while (lines.length > limit) {
		const index = evictionIndex(lines, existingCount)
		// 一条都挤不动了（整份文件都是标题与正文）：宁可超限，也不删她的结构。
		// 这一天的事实由调用方记日志，不在这里偷偷丢内容。
		if (index < 0) break
		droppedLines.push(lines.splice(index, 1)[0])
	}
	const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`
	return { text, added, dropped: droppedLines.length, droppedLines }
}

/**
 * 该挤掉哪一行：只在 `[0, limit)` 这段旧行里找，权重最低的加权条目先走，同权重取最旧
 * （行号最小）；没有加权条目时退回最旧的普通条目；都没有就返回 -1。
 *
 * identity / rule 两档不参与淘汰：它们要么是她是谁，要么是他亲口立的规矩。
 */
function evictionIndex(lines, limit) {
	let chosen = -1
	let chosenWeight = Number.POSITIVE_INFINITY
	for (let index = 0; index < Math.min(limit, lines.length); index += 1) {
		const match = WEIGHTED_ITEM.exec(lines[index])
		if (match === null) continue
		if (PROTECTED_KINDS.has(kindOf(lines[index]))) continue
		const weight = Number(match[1])
		if (weight < chosenWeight) {
			chosen = index
			chosenWeight = weight
		}
	}
	if (chosen >= 0) return chosen
	for (let index = 0; index < Math.min(limit, lines.length); index += 1) {
		if (PROTECTED_KINDS.has(kindOf(lines[index]))) continue
		if (PLAIN_ITEM.exec(lines[index]) !== null) return index
	}
	return -1
}

const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/** 根目录 + 日期 → 当天那一个目录；两条通道共用这套校验。 */
function proposalDayDir(dir, date) {
	const root = String(dir ?? '').trim()
	if (root === '') throw new Error('qq-node: proposalsDir 是空的，提案无处可写')
	const day = String(date ?? '').trim()
	if (!DATE_SHAPE.test(day)) throw new Error(`qq-node: 提案日期必须是 YYYY-MM-DD，收到 ${JSON.stringify(date)}`)
	return join(root, day)
}

/**
 * 把提案写成文件：`<dir>/<date>/NN-slug.patch` 与同名 `.json`。
 *
 * 用 `wx` 而不是 `w`：文件已存在就抛错。覆盖等于悄悄改掉上一次的提案，
 * 而提案是要给人看、给 apply 脚本跑的东西。
 *
 * @param dir - 提案根目录（`proposalsDir`）。
 * @param date - 服务器本地日期 `YYYY-MM-DD`。
 * @param proposals - `{ file, why, diff }[]`。
 * @param options.now - 时钟，决定 json 里的 `created`。
 * @returns 实际写入的文件路径（先 patch 后 json，按提案顺序）。
 */
export function writeProposals(dir, date, proposals, { now = () => new Date() } = {}) {
	const target = proposalDayDir(dir, date)
	mkdirSync(target, { recursive: true })
	const created = now().toISOString()
	const written = []
	const list = Array.isArray(proposals) ? proposals : []
	for (const [index, proposal] of list.entries()) {
		const stem = `${String(index + 1).padStart(2, '0')}-${slugOf(proposal?.file, index)}`
		const patchPath = join(target, `${stem}.patch`)
		const metaPath = join(target, `${stem}.json`)
		const diff = String(proposal?.diff ?? '')
		writeFileSync(patchPath, diff === '' ? '' : `${diff}\n`, { encoding: 'utf8', flag: 'wx' })
		try {
			const meta = { title: titleOf(proposal), why: String(proposal?.why ?? ''), files: [String(proposal?.file ?? '')], created }
			// 自检结论只在知道的时候写：直接调用本函数的调用方没有这一位，
			// 凭空补一个 `verified: true` 就是替它撒谎。
			if (typeof proposal?.verified === 'boolean') {
				meta.verified = proposal.verified
				if (proposal.verified === false) meta.verifyReason = String(proposal?.verifyReason ?? '')
			}
			writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
		} catch (error) {
			// 半份提案（有 patch 没 json）会让明天夜里永远写不进去：wx 每次都撞上它。
			try {
				unlinkSync(patchPath)
			} catch {}
			throw error
		}
		written.push(patchPath, metaPath)
	}
	return written
}

/**
 * 把 intent 写成 `<dir>/<date>/NN-slug.json`。
 *
 * 与提案同一个目录、同一套编号，但**没有 `.patch`**——intent 不是补丁，它没有
 * 资格被 apply 脚本打进代码；它是一张写给早上那个人的说明书。文件里 `kind: 'intent'`
 * 就是给 `deploy/apply-proposal.sh --list-intents` 认的标签。
 *
 * 同样用 `wx`：覆盖等于悄悄改掉昨晚那条意图。
 *
 * @param dir - 提案根目录（`proposalsDir`）。
 * @param date - 服务器本地日期 `YYYY-MM-DD`。
 * @param intents - `{ file, why, change, verify }[]`。
 * @param options.now - 时钟，决定 json 里的 `created`。
 * @param options.start - 第一条的编号；同目录下提案已经占了前面的号，接着数。
 * @returns 实际写入的 `.json` 路径。
 */
export function writeIntents(dir, date, intents, { now = () => new Date(), start = 1 } = {}) {
	const list = Array.isArray(intents) ? intents : []
	if (list.length === 0) return []
	const target = proposalDayDir(dir, date)
	mkdirSync(target, { recursive: true })
	const created = now().toISOString()
	const offset = Number.isInteger(start) && start > 0 ? start : 1
	const written = []
	for (const [index, intent] of list.entries()) {
		const stem = `${String(offset + index).padStart(2, '0')}-${slugOf(intent?.file, index)}`
		const metaPath = join(target, `${stem}.json`)
		const meta = {
			kind: 'intent',
			title: titleOf(intent),
			file: String(intent?.file ?? ''),
			why: String(intent?.why ?? ''),
			change: String(intent?.change ?? ''),
			verify: String(intent?.verify ?? ''),
			created,
		}
		writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
		written.push(metaPath)
	}
	return written
}

function slugOf(file, index) {
	const name = basename(String(file ?? ''))
	const stem = name === '' ? '' : name.slice(0, name.length - extname(name).length)
	const slug = stem
		.toLowerCase()
		.replace(/[^a-z0-9]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
	return slug === '' ? `proposal-${index + 1}` : slug
}

function titleOf(proposal) {
	const name = basename(String(proposal?.file ?? ''))
	return name === '' ? 'proposal' : name
}
