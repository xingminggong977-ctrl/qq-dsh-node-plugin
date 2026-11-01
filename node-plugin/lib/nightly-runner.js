import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { QqSessionStore } from './session.js'
import { NIGHTLY_CAPS, NIGHTLY_FILE_HINTS, NIGHTLY_NONE_MARKER, capsFor, diffLineCount, mergeMemory, parseNightlyOutput, readProposalSource, validateNightly, verifyPatchAgainstText, writeIntents, writeProposals } from './nightly.js'

/**
 * 夜班的调度与落盘：03:10 读清单 → 跑一次受限轮次 → 严格解析 → 只写记忆 + 落提案。
 *
 * 三条不变量：
 * 1. 每晚最多一次。进了窗口就先把日期记下来，成败都不再重试——重试就是烧钱。
 * 2. 夜班日期一律用契约里的服务器时区（Asia/Shanghai）。审计文件按 UTC 月分片，
 *    那是 `lib/audit.js` 自己的事，两边不许互相换算。
 * 3. 这一轮碰不到任何文件：它走非主人的无工具会话构造，改代码在物理上不可能。
 */

/** 契约的时间表：挖矿器 03:00 生成 digest，node-plugin 03:10 复盘。 */
export const NIGHTLY_MINUTE = 10

/** 契约里的服务器时区；夜班日期与窗口都按它算。 */
export const NIGHTLY_ZONE = 'Asia/Shanghai'

/** How often the scheduler looks at the clock. */
export const TICK_INTERVAL_MS = 60_000

const clock = new Intl.DateTimeFormat('en-CA', {
	timeZone: NIGHTLY_ZONE,
	year: 'numeric',
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	hourCycle: 'h23',
})

/**
 * 把这个时刻换成夜班时区里的日期与时分。
 * @param moment - Date 或毫秒数。
 * @returns `{ date: 'YYYY-MM-DD', hour, minute }`。
 */
export function zonedParts(moment) {
	const parts = {}
	for (const part of clock.formatToParts(new Date(moment))) {
		if (part.type !== 'literal') parts[part.type] = part.value
	}
	return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) }
}

/** 夜班用的那个日期（服务器本地，不是 UTC）。 */
export function localDateOf(moment) {
	return zonedParts(moment).date
}

/**
 * 周日走深度档。星期几从日期本身算，不依赖 locale 的星期名——
 * 某个 ICU 版本把 `Sun` 输出成 `Sun.` 就会让深度档悄悄消失。
 */
export function isDeepNight(moment) {
	const [year, month, day] = zonedParts(moment).date.split('-').map(Number)
	return new Date(Date.UTC(year, month - 1, day)).getUTCDay() === 0
}

/**
 * 提案/意图只允许指向仓库里真实存在的文件，清单正本在 `lib/nightly.js`。
 *
 * 为什么正本搬到了解析模块：`intent` 的 `file:` 不合清单要**整条丢弃**，那是校验
 * 的活；提示词只是把同一份清单原样列出来给她抄。两处各存一份迟早会飘。
 */
export { NIGHTLY_FILE_HINTS }

/**
 * 这一轮喂给她的全部内容。只描述事实与格式，不许她自由发挥成聊天。
 *
 * 2026-03 改契约：这一轮唯一的产出通道从「盲写 unified diff」换成「intent 意图 +
 * 真实证据」。原因不是提示词没写好，而是契约本身错了——这一轮 `isOwner:false` 且
 * 工具全被撤掉，模型看不到任何文件内容，凭记忆写出来的 `@@` 行号与上下文必然对不上：
 * 2026-10-26 三份、10-27 两份、10-28 两份，五晚七份提案没有一份打得上。
 * 现在她要写的是「改哪里、为什么、打算怎么改、怎么验证」，能不能改由早上的人决定。
 */
export function buildNightlyPrompt({ digest, memory, date, caps }) {
	const body = String(memory ?? '').trim()
	return [
		`（夜班复盘，${date}。这是你自己的一轮，没有人会看到这段对话，除了两样产出：记忆补丁与代码意图。）`,
		'',
		'## 今天的真实异常清单（挖矿脚本从日志里挖的，不是想出来的）',
		String(digest ?? '').trim(),
		'',
		'## 你现在的记忆（MEMORY.md 全文）',
		body === '' ? '（还是空的）' : body,
		'',
		'## 你要做的',
		`从清单里挑出「以后还会用到」的规则，最多 ${caps.memories} 条写进记忆；`,
		`如果某个异常的根因在代码里，可以写一条代码意图，最多 ${caps.proposals} 条。`,
		'',
		// 这一轮的工具是全封死的。不把这件事说明白，模型会照习惯吐出一段工具调用的
		// 标记文本（实测就是这样作废了一整轮），既不产出记忆也解析不了。
		'注意：这一轮你没有、也不许使用任何工具，不要写任何工具调用或类似的标记文本。',
		// 比「没有工具」更硬的一条：她连文件内容都**看不见**。不把这条摆在明处，
		// 她会继续凭记忆编补丁，而编出来的东西一个字节都打不上。
		'更要紧的一条：**你现在看不到任何文件内容**，只有下面这份清单和你的记忆。所以不要写 unified diff，不要写 --- / +++ 文件头，不要写 @@ 行号——凭记忆编出来的行号对不上任何文件。',
		'',
		'只输出下面两种 fenced block，别的一个字都不要写：',
		'',
		'```memory',
		'- [w:4] 一句话说清一条规则，权重 1..5',
		'```',
		'',
		'```intent',
		'file: node-plugin/lib/audit.js',
		'why: 05:57:22 那条日志写着 `PermissionError`，转写失败 4 次——原因只取了 stderr',
		'change:',
		'1. 在 catch 里把 stdout 也拼进失败原因',
		'2. 失败时补一条 audit 记录，带上 exit code',
		'3. 其余日志格式不动',
		'verify: 跑 node --test test/index.js；再用 grep 确认 stdout 与 exit code 都进了 reason',
		'```',
		'',
		// 她第一次跑夜班时把 bridge/src/asr.js 写成了 agent/src/asr.js——目录是编的。
		// 路径错了，后面写得再对也没意义，所以把真实路径原样摆给她抄。
		'intent 的 file: 只能从下面这份清单里原样抄一个路径，不许自己拼目录：',
		'',
		...NIGHTLY_FILE_HINTS.map((line) => `- ${line}`),
		'',
		'intent 的四个字段都是必填，缺任何一个整条会被丢掉：',
		'- file: 上面清单里的某一行，只抄路径，别把后面的中文说明抄进去；不在清单里整条丢弃；',
		'- why: 必须带至少一个具体证据——HH:MM 时间戳、引号里的日志原文、或带单位的审计数字（如「失败 4 次」）。只有形容词的 why 会被丢掉；',
		'- change: 3 到 6 行中文，说清打算怎么改。可以提函数名，但**不要求精确**，也不要写行号；',
		'- verify: 说明怎么验证这次改动（跑什么、看什么）。',
		'',
		'硬性要求：',
		`- memory 行数不超过 ${caps.memories}，每行格式严格是 "- [w:N] 文本"，N 只能是 1 到 5 的整数；`,
		`- intent 条数不超过 ${caps.proposals}，超了整轮作废，不会截断；`,
		// 旧的 proposal 通道这一轮停用（没有工具读文件，diff 必然打不上），但解析器
		// 还留着它：将来这一轮能读文件了就把它启用回来，不必重写一遍契约。
		`- 旧的 proposal 通道（unified diff）这一轮停用，不要写；将来这一轮能读文件时才会恢复：每块必须是 file:、why:、--- 三段，之后才是 diff，单条不超过 ${caps.diffLines} 行，每个段落头必须带行号，形如 "@@ -12,3 +12,5 @@"；`,
		'- 意图只是意图，没有人会自动应用它，你也改不了任何文件；不要假装改过了；',
		'- 想不出值得记的就少写几条——宁可两条真的，不要五条废话。',
		`- 今天确实没有值得记的规则、也没有意图时，整条回复只写一行 ${NIGHTLY_NONE_MARKER}，别的都不要写。`,
	].join('\n')
}

/**
 * 自检失败后的补救提示：只给一个文件，要求逐字抄上下文重写 diff。
 *
 * 为什么要补救：03:10 那一轮读不到任何文件，模型写的 diff 里路径、函数名、上下文
 * 全是想象出来的（2026-10-28 那两份就是这么废的）。补救轮把**这个文件的真实全文**
 * 摆到它眼前，它至少能抄对；抄不对也还有最后一道「标记未通过自检」，不会悄悄落盘。
 *
 * 为什么只做一次、且只针对一个文件：一轮的预算是分钟级的，一份提案再试一次还付得起，
 * 逐条无限重试会把这晚的时间与钱都烧光。
 *
 * @param options.file - 提案里的仓库相对路径。
 * @param options.diff - 打不上的那份 diff。
 * @param options.reason - 自检给出的原因（含行号与期望/实际摘要）。
 * @param options.source - 目标文件的真实全文。
 * @param options.date - 夜班日期。
 * @param options.caps - 本次上限，只用来复述 diff 行数上限。
 */
export function buildRepairPrompt({ file, diff, reason, source, date = '', caps = NIGHTLY_CAPS }) {
	const limit = Number.isInteger(caps?.diffLines) ? caps.diffLines : NIGHTLY_CAPS.diffLines
	return [
		`（夜班自检，${date}。你刚才那份提案在真实文件上打不上。这一轮只补救这一个文件，别的提案都不要再提。）`,
		'',
		`目标文件：${file}`,
		'',
		'## 自检说它打不上',
		String(reason ?? '').trim(),
		'',
		'## 你刚才写的 diff',
		'```diff',
		String(diff ?? '').trim(),
		'```',
		'',
		'## 这个文件现在的真实全文（逐字抄这里，不许凭记忆写）',
		'```',
		String(source ?? '').replace(/\n+$/u, ''),
		'```',
		'',
		'## 这次怎么做',
		'- 只输出一个 proposal 块，散文一个字的都不要写；',
		`- file: 仍然写 ${file}，不许换文件；`,
		'- 上下文行与删除行必须从上面全文里逐字复制：缩进、空格、标点一个都不能变；',
		'- 加号行才是你想改成的内容；',
		`- @@ 头带行号，形如 "@@ -12,3 +12,5 @@"；整条 diff 不超过 ${limit} 行；`,
		'- 行号写不准没关系，自检按上下文找；但上下文本身必须是文件里真有的那几行。',
		'',
		// 这一轮的工具同样是全封死的：不写这一句，模型会以为还能再读一次文件。
		'注意：这一轮你依然没有任何工具，上面这段全文就是你手里的全部信息。',
	].join('\n')
}

/** 读文件，把「读不到」原样交回调用方：缺清单和读不了清单是两件事。 */
function readTextFile(path) {
	try {
		return { text: readFileSync(path, 'utf8') }
	} catch (error) {
		return { text: '', error }
	}
}

/**
 * 默认的「跑一轮」实现：复用白天那套会话机制（`lib/session.js` 的 `runTask`）。
 *
 * 单开一个只服务夜班的 store，是因为超时必须用夜班自己的预算（每晚 120 秒、
 * 周日 180 秒），而不是白天那条 `turnTimeoutMs`；这样就不必去改白天那份 store。
 * 会话按**非主人**构造：工具被 `lockdownTools` 全部封死，于是「夜班绝不改代码」
 * 不靠自觉，靠构造。
 *
 * @param options.prompt - 这一轮的完整输入。
 * @param options.timeoutMs - 本轮预算。
 * @returns 模型回复的原始文本。
 */
export async function runNightlyTurn({ ctx, options, client = undefined, log = () => {}, prompt, timeoutMs, date = '' }) {
	const store = new QqSessionStore({ ctx, client, options: { ...options, turnTimeoutMs: timeoutMs }, log })
	const detach = store.attach()
	try {
		const result = await store.runTask(
			{ taskId: `nightly-${date}`, kind: 'nightly', userId: 'nightly', text: prompt, isOwner: false },
			{ allowEmpty: false },
		)
		return result.text
	} finally {
		detach()
		store.dispose()
	}
}

export class QqNightlyRunner {
	#ctx
	#options
	#client
	#log
	#audit
	#now
	#runTurn
	#lastDate = ''
	#timer
	#busy = false

	/**
	 * @param options.ctx - the plugin context (agents + session/event).
	 * @param options.options - resolved config: `nightlyEnabled`, `nightlyHour`,
	 *   `nightlyTimeoutMs`, `nightlyMaxMemories`, `nightlyMaxProposals`,
	 *   `nightlyDigestDir`, `personaDir`, `proposalsDir`.
	 * @param options.client - bridge client, forwarded to the session store.
	 * @param options.audit - audit sink; the night's write lands here as `memory_write`.
	 * @param options.now - injectable clock; tests never wait for real time.
	 * @param options.runTurn - injectable turn runner; must resolve to the raw reply text.
	 */
	constructor({ ctx, options, client = undefined, log = () => {}, audit = undefined, now = () => new Date(), runTurn = undefined }) {
		this.#ctx = ctx
		this.#options = options
		this.#client = client
		this.#log = log
		this.#audit = audit
		this.#now = now
		this.#runTurn = runTurn ?? ((request) => runNightlyTurn({ ctx, options, client, log, ...request }))
	}

	/** 最近一次开跑的夜班日期；空串表示这个进程还没跑过。 */
	get lastDate() {
		return this.#lastDate
	}

	/** Start the minute-granularity clock watcher. */
	start() {
		if (this.#timer !== undefined) return
		this.#timer = setInterval(() => {
			void this.tick().catch((error) => {
				this.#log('warn', `qq-node: nightly tick failed: ${error?.message ?? String(error)}`)
			})
		}, TICK_INTERVAL_MS)
		this.#timer.unref?.()
	}

	/** Stop the watcher; a run already in flight is left to finish. */
	stop() {
		if (this.#timer === undefined) return
		clearInterval(this.#timer)
		this.#timer = undefined
	}

	/**
	 * 看一眼时钟：该跑就跑，不该跑就什么都不做。测试直接调它，不等真实时间。
	 * @param at - 覆盖当前时刻（毫秒或 Date）。
	 * @returns `{ ok, ... }` 描述这次 tick 干了什么。
	 */
	async tick(at = undefined) {
		if (this.#options.nightlyEnabled !== true) return { ok: false, reason: 'nightly review is disabled' }
		const moment = at ?? this.#now()
		const parts = zonedParts(moment)
		if (this.#lastDate === parts.date) return { ok: false, reason: `already ran on ${parts.date}` }
		const hour = Number.isInteger(this.#options.nightlyHour) ? this.#options.nightlyHour : 3
		// 窗口开到整点结束：03:10 错过一次 tick（进程刚起、事件循环忙）也能补上，
		// 但不会早于 03:10 跑——那时挖矿器可能还没写完清单。
		if (parts.hour !== hour || parts.minute < NIGHTLY_MINUTE) {
			return { ok: false, reason: `outside the ${String(hour).padStart(2, '0')}:${NIGHTLY_MINUTE} window` }
		}
		if (this.#busy) return { ok: false, reason: 'a review is already running' }
		this.#busy = true
		// 先记账再动手：这一夜只试一次，成败都一样。
		this.#lastDate = parts.date
		try {
			return await this.#run(parts.date, moment)
		} finally {
			this.#busy = false
		}
	}

	async #run(date, moment) {
		const deep = isDeepNight(moment)
		const caps = capsFor({
			deep,
			maxMemories: this.#options.nightlyMaxMemories,
			maxProposals: this.#options.nightlyMaxProposals,
			timeoutMs: this.#options.nightlyTimeoutMs,
		})
		const digestPath = join(this.#options.nightlyDigestDir, `digest-${date}.md`)
		const digest = readTextFile(digestPath)
		if (digest.error !== undefined) {
			// 没有清单就是没有素材：跳过，不报错、不重试。挖矿器那边哪天挂了，
			// 这里只该留一行日志，不该让插件开始每十分钟试一次。
			const missing = digest.error?.code === 'ENOENT'
			this.#log(
				missing ? 'info' : 'warn',
				`qq-node: nightly ${date}: ${missing ? 'no digest' : `cannot read digest (${digest.error?.message ?? digest.error})`} at ${digestPath}; skipping tonight, no retry`,
			)
			return { ok: false, reason: 'no digest' }
		}
		const digestLines = digest.text.trim() === '' ? 0 : digest.text.trim().split('\n').length
		if (digestLines === 0) {
			this.#log('info', `qq-node: nightly ${date}: the digest at ${digestPath} is empty; skipping tonight`)
			return { ok: false, reason: 'empty digest' }
		}
		if (digestLines > caps.digestLines) {
			this.#log('warn', `qq-node: nightly ${date}: digest has ${digestLines} lines, over the cap of ${caps.digestLines}; skipping tonight, no truncation`)
			return { ok: false, reason: 'digest too long' }
		}
		const memoryFile = join(this.#options.personaDir, 'MEMORY.md')
		const memoryRead = readTextFile(memoryFile)
		if (memoryRead.error !== undefined && memoryRead.error?.code !== 'ENOENT') {
			this.#log('warn', `qq-node: nightly ${date}: cannot read ${memoryFile} (${memoryRead.error?.message ?? memoryRead.error}); treating memory as empty`)
		}
		const existing = memoryRead.text
		const prompt = buildNightlyPrompt({ digest: digest.text, memory: existing, date, caps })
		this.#log('info', `qq-node: nightly ${date}: running one ${deep ? 'deep' : 'normal'} review turn (timeout=${caps.timeoutMs}ms, digest=${digestLines} lines)`)

		let reply
		try {
			reply = await this.#runTurn({ prompt, timeoutMs: caps.timeoutMs, date, deep })
		} catch (error) {
			this.#log('warn', `qq-node: nightly ${date}: the review turn failed (${error?.name === 'TurnTimeoutError' ? 'turn timeout' : (error?.message ?? String(error))}); nothing is written`)
			return { ok: false, reason: 'turn failed' }
		}

		const parsed = parseNightlyOutput(reply)
		if (parsed.ok !== true) return this.#discard(date, `parse failed: ${parsed.reason}`, reply)
		const valid = validateNightly({ memories: parsed.memories, proposals: parsed.proposals, intents: parsed.intents }, caps)
		if (valid.ok !== true) return this.#discard(date, `over the caps: ${valid.reason}`, reply)
		// 被丢掉的块只丢它自己：一条说不清证据的意图不该连累一条说得清的记忆，一块
		// 结构不成立的旧 proposal 也不该。原因写进日志，早上翻日志就能看见她哪一条编了。
		if (parsed.rejected.length > 0) {
			const reasons = parsed.rejected.map((item) => item.reason).join(' | ')
			this.#log('warn', `qq-node: nightly ${date}: ${parsed.rejected.length} block(s) dropped — ${reasons}`)
		}

		// 写盘之前先自己打一遍。打不上的在这里补救一次，仍打不上就带着
		// `verified: false` 落盘——让提案明说「我没通过自检」，而不是静静躺在那儿等人踩。
		const proposals = await this.#selfCheck({ date, proposals: parsed.proposals, caps, deep })

		return this.#persist({ date, parsed: { ...parsed, proposals }, caps, existing, memoryFile, deep })
	}

	/**
	 * 逐条自检；每条最多补救一次。
	 *
	 * 失败不影响整轮：记忆照写、提案照落盘，只是各自带上 `verified: false` 与原因。
	 * 整轮作废留给「解析不了」和「超上限」——自检失败是提案自己的事。
	 */
	async #selfCheck({ date, proposals, caps, deep }) {
		const checked = []
		for (const proposal of proposals) checked.push(await this.#selfCheckOne({ date, proposal, caps, deep }))
		return checked
	}

	async #selfCheckOne({ date, proposal, caps, deep }) {
		const file = String(proposal?.file ?? '')
		const source = readProposalSource(proposal?.file)
		if (source.ok !== true) {
			// 读不到真实文件就没法自检：不补救（补救提示里没东西可抄），直接判失败。
			this.#log('warn', `qq-node: nightly ${date}: no self-check for ${file} (${source.reason}); it is written as verified:false`)
			return { ...proposal, verified: false, verifyReason: source.reason }
		}
		const first = verifyPatchAgainstText(proposal?.diff, source.text)
		if (first.ok === true) {
			this.#log('info', `qq-node: nightly ${date}: ${file} passed the landing check (${first.hunks} hunk(s) found verbatim in the real file)`)
			return { ...proposal, verified: true }
		}
		// 日志里只写行号，不写源码：原因原文里带着目标文件的那两行，它属于 .json。
		const where = `hunk #${first.hunk} at line ${first.line}`
		this.#log('warn', `qq-node: nightly ${date}: ${file} does not apply (${where}); one repair turn with the real file, no second`)
		const repair = await this.#repairProposal({ date, proposal, source, caps, deep, reason: first.reason })
		if (repair.ok === true) {
			this.#log('info', `qq-node: nightly ${date}: ${file} passed the landing check after the one repair turn (was ${where})`)
			return { ...proposal, diff: repair.diff, verified: true }
		}
		this.#log('warn', `qq-node: nightly ${date}: ${file} still does not apply (${repair.where}); it is written as verified:false`)
		return { ...proposal, verified: false, verifyReason: repair.reason }
	}

	/**
	 * 补救一次：把真实全文交给模型，只要求它重写这一个文件的 diff。
	 *
	 * @returns `{ ok: true, diff }`，或 `{ ok: false, where, reason }`——
	 *   `where` 是不含源码的短标签（给日志），`reason` 是完整原因（给 .json）。
	 */
	async #repairProposal({ date, proposal, source, caps, deep, reason }) {
		const file = String(proposal?.file ?? '')
		const prompt = buildRepairPrompt({ file, diff: proposal?.diff, reason, source: source.text, date, caps })
		let reply
		try {
			reply = await this.#runTurn({ prompt, timeoutMs: caps.timeoutMs, date, deep, repair: true })
		} catch (error) {
			const label = error?.name === 'TurnTimeoutError' ? 'turn timeout' : (error?.message ?? String(error))
			return { ok: false, where: 'the repair turn failed', reason: `补救轮失败（${label}），没能重写：${reason}` }
		}
		const parsed = parseNightlyOutput(reply)
		if (parsed.ok !== true) {
			return { ok: false, where: 'the repair reply did not parse', reason: `补救回复解析不了（${parsed.reason}）：${reason}` }
		}
		// 换了文件的补救没有意义：自检要读的是这次读到的这份全文。
		const repaired = parsed.proposals.find((item) => String(item?.file ?? '').trim() === file)
		if (repaired === undefined) {
			const seen = parsed.proposals.map((item) => String(item?.file ?? '').trim()).join(' | ')
			return { ok: false, where: 'the repair reply changed the file', reason: `补救回复没有给出同一个文件的 diff（收到 ${seen === '' ? '空' : seen}）：${reason}` }
		}
		const count = diffLineCount(repaired.diff)
		if (count > caps.diffLines) {
			return { ok: false, where: `the repair diff had ${count} lines`, reason: `补救后的 diff 有 ${count} 行，超过上限 ${caps.diffLines} 行：${reason}` }
		}
		const second = verifyPatchAgainstText(repaired.diff, source.text)
		if (second.ok === true) return { ok: true, diff: repaired.diff }
		return { ok: false, where: `hunk #${second.hunk} at line ${second.line}`, reason: `补救后仍然打不上（hunk #${second.hunk} 第 ${second.line} 行）：${second.reason}` }
	}

	/** 解析/校验失败：整轮作废，只留日志与审计。不重试，也不写半个字。 */
	#discard(date, reason, reply) {
		// 带上回复摘要：上次因为没打这一行，只能对着「没有任何 memory / proposal 块」
		// 猜模型干了什么，最后靠翻会话记录才发现它吐的是一段工具调用标记。
		const snippet = String(reply ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)
		this.#log('warn', `qq-node: nightly ${date}: ${reason}; the whole round is discarded, nothing is written${snippet === '' ? ' (reply was empty)' : ` (reply starts: ${snippet})`}`)
		try {
			this.#audit?.record({ kind: 'memory_write', target: 'nightly', text: `nightly ${date} 作废：${reason}`, ok: false })
		} catch (error) {
			this.#log('warn', `qq-node: nightly ${date}: audit write failed: ${error?.message ?? String(error)}`)
		}
		return { ok: false, reason }
	}

	async #persist({ date, parsed, caps, existing, memoryFile, deep }) {
		const merged = mergeMemory(existing, parsed.memories, { maxLines: caps.memoryLines })
		const backupFile = `${memoryFile}.bak-${date}`
		try {
			// 先备份再写，而且备份失败也算失败：没有备份的夜班写入不可回退。
			mkdirSync(this.#options.personaDir, { recursive: true })
			if (existsSync(memoryFile)) copyFileSync(memoryFile, backupFile)
			writeFileSync(memoryFile, merged.text, 'utf8')
		} catch (error) {
			// 盘上写不进去不该让插件崩：今天已经因为一个没建的目录挂过一整天。
			this.#log('error', `qq-node: nightly ${date}: writing ${memoryFile} failed (${error?.message ?? String(error)}); the round is dropped`)
			return { ok: false, reason: 'memory write failed' }
		}
		this.#log(
			'info',
			`qq-node: nightly ${date}: MEMORY.md written (${merged.added} added, ${merged.dropped} dropped, backup=${existsSync(backupFile) ? backupFile : '(none)'}), depth=${deep ? 'deep' : 'normal'}`,
		)

		let written = []
		if (parsed.proposals.length > 0) {
			try {
				written = writeProposals(this.#options.proposalsDir, date, parsed.proposals, { now: this.#now })
				this.#log('info', `qq-node: nightly ${date}: ${written.length} proposal file(s) under ${join(this.#options.proposalsDir, date)} — nothing is applied automatically`)
			} catch (error) {
				// 提案写不进去不算整轮失败：记忆已经落盘，而且明天还能再提。
				this.#log('error', `qq-node: nightly ${date}: writing proposals to ${this.#options.proposalsDir} failed: ${error?.message ?? String(error)}`)
			}
			const unverified = parsed.proposals.filter((proposal) => proposal?.verified === false)
			if (unverified.length > 0) {
				// 原因只写进各自的 .json：里面带行号与那两行摘要，日志里不放源码。
				this.#log(
					'warn',
					`qq-node: nightly ${date}: ${unverified.length} of ${parsed.proposals.length} proposal(s) did not pass the landing check and are marked verified:false — read verifyReason in their .json before applying anything`,
				)
			}
		}

		// intent 与提案同一个目录、接着提案的编号往下数：早上那一个目录里就是
		// 「昨晚想改什么」的全部内容，不用再去别处找。
		let intents = []
		if (parsed.intents.length > 0) {
			try {
				intents = writeIntents(this.#options.proposalsDir, date, parsed.intents, { now: this.#now, start: parsed.proposals.length + 1 })
				this.#log(
					'info',
					`qq-node: nightly ${date}: ${intents.length} intent file(s) under ${join(this.#options.proposalsDir, date)} — nothing is applied automatically; read them with deploy/apply-proposal.sh --list-intents`,
				)
			} catch (error) {
				// 同提案：写不进去不算整轮失败，记忆已经落盘。
				this.#log('error', `qq-node: nightly ${date}: writing intents to ${this.#options.proposalsDir} failed: ${error?.message ?? String(error)}`)
			}
		}

		const added = parsed.memories.map((memory) => `[w:${memory.weight}] ${memory.text}`).join(' | ')
		try {
			this.#audit?.record({ kind: 'memory_write', target: 'nightly', text: `nightly ${date}: +${merged.added} 行：${added}`, ok: true })
			if (merged.dropped > 0) {
				this.#audit?.record({
					kind: 'memory_write',
					target: 'nightly',
					text: `nightly ${date}: 挤出 ${merged.dropped} 行（权重最低且最旧）：${merged.droppedLines.join(' | ')}`,
					ok: true,
				})
			}
		} catch (error) {
			this.#log('warn', `qq-node: nightly ${date}: audit write failed: ${error?.message ?? String(error)}`)
		}
		return {
			ok: true,
			date,
			added: merged.added,
			dropped: merged.dropped,
			droppedLines: merged.droppedLines,
			proposals: written,
			intents,
		}
	}
}
