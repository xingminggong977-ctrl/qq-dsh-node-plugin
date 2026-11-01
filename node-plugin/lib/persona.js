/**
 * Persona and long-term memory injection for QQ conversations.
 *
 * Four global prompt sections are registered on `ctx.systemPrompt`; their `text`
 * is a function, so the files are re-read on every prompt assembly and an edit
 * takes effect on the next sentence. The persona applies to every QQ session
 * (owner and non-owner alike), and so do the world-life fragment, the list of
 * posts she already published and her own `knowledge/` notes; MEMORY.md, the
 * rules file and the diary days are the owner's private life and reach owner
 * sessions only, and so does the diary write contract — only owners keep tools.
 *
 * Nothing here may throw into the prompt path: a missing, empty or unreadable
 * file degrades to "that block is absent" plus one warn line.
 *
 * Memory is allowed to be forgotten (`memoryDecay`, on by default): items of
 * MEMORY.md are scored with a forgetting curve and the ones that fell out are
 * archived instead of silently dropped, and diary days older than the injected
 * window are archived by month. `memoryDecay: false` restores the previous
 * behaviour byte for byte — same `#compose`, same `tailCapped`, no item model.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORRECTION_FILE } from './correction.js'
import { DEFAULT_MEMORY_LIMITS, PINNED_KINDS, isNearDuplicate, readKind, readWeight, renderMemory, selectItems, splitMemoryItems } from './memory.js'
import { DIARY_ARCHIVE_DIR, ITEM_ARCHIVE_FILE, MEMORY_DIR, memoryDir, readMeta, touchItems } from './memory-store.js'
import { defaultQzoneLogFile, renderQzoneNotes } from './qzone-notes.js'
import { defaultWorldLifeFile, renderWorldLife } from './world-life.js'

/** Section name of the persona + memory block. */
export const PERSONA_SECTION = 'qq:persona'
/** Placed after DEPLOYMENT_PERSONA_PREFIX (0) and before PLAN_POLICY (500). */
export const PERSONA_ORDER = 100
/** Section name of the owner-only diary contract. */
export const DIARY_SECTION = 'qq:diary'
/** Directly after the persona block, so the contract reads as a continuation. */
export const DIARY_ORDER = 150
/** Section name of her own Minecraft days. */
export const WORLD_LIFE_SECTION = 'qq:world-life'
/** Behind persona and memory, in front of PLAN_POLICY (500). */
export const WORLD_LIFE_ORDER = 200
/** How the block is introduced; the fragment itself stays one line. */
const WORLD_LIFE_TITLE = '## 她的世界'
const WORLD_LIFE_GUIDE = '这是你自己在世界里过日子的近况，可以自然提起，但别逐条汇报。'
/** Section name of the posts she already published to QQ Zone. */
export const QZONE_NOTES_SECTION = 'qq:qzone-notes'
/** Behind her world (200), so the list reads as the last thing she remembers. */
export const QZONE_NOTES_ORDER = 210
/** Section name of the per-turn tool budget. */
export const PACE_SECTION = 'qq:pace'
/** Right after the persona block: it is about how she works, not what she knows. */
export const PACE_ORDER = 120
/** How the block is introduced; the budget itself stays four lines. */
const PACE_TITLE = '## 干活的节奏'
const PACE_LINES = [
	'一个回合里工具调用控制在 8 次以内；不够就先回话，剩下的下一轮接着做。',
	'每次调用前想清楚要看什么，能一条命令看完的别拆成好几条。',
	'互不依赖的几件事，写在同一条消息里一起发出去（一次可以发好几个工具调用），别一个一个排队等。',
	'一件事 60 秒还没结论，就先说卡在哪，别一直埋头试——对方在等一句话。',
]
/** How the block is introduced; the list itself stays five short lines. */
const QZONE_NOTES_TITLE = '## 我发过的说说'
const QZONE_NOTES_GUIDE = '这些是你自己在 QQ 空间发过的说说。被问到就用自己的话复述，可以说「我刚刚写过……」，但平时不要主动逐条播报，也不要背原句。'

/** Byte caps that keep one injected prompt bounded. */
export const LIMITS = Object.freeze({
	memoryBytes: 8 * 1024,
	knowledgeBytes: 4 * 1024,
	diaryDayBytes: 4 * 1024,
	// 日记先占一块，再让记忆和笔记去分剩下的。按「谁在前面谁先拿」的方式分，
	// 记忆一长到 6-8K，日记就一天都进不去——她当天写的东西到不了当天的对话里。
	diaryReserveBytes: 6 * 1024,
	// 32 KiB 而不是 28：线上 2026-11-01 那次是 `total 28671/28672`——预算一分不剩，
	// 再多写一条记忆或一句规矩，就得从她的日记尾部悄悄切掉一天。几千字节的余量
	// 换的是「她写的东西不会因为别人长了半句话而消失」。
	totalBytes: 32 * 1024,
	// 一周：她要能想起上周三自己写过什么。多出来的日子由 reserve 撑着，
	// 更早的日子照旧先写进 memory/archive/YYYY-MM.md 再离开提示词。
	diaryDays: 7,
	// 分区预算：`ops` 是「这台机器怎么跑」的运维笔记，`note` 是索引/wiki 类笔记，
	// 两者都会稳定增长，而 `event` 才是她自己的生活。给这两档各自封一个顶，
	// 免得运维笔记把她的塔、麦田、小尾巴挤出去。钉住的条目不在此列（永不因为容量被丢）。
	opsMemoryBytes: 3 * 1024,
	noteMemoryBytes: 3 * 1024,
})

/**
 * Item caps of the decay model (`maxItems`, `forgetBelow`, `pinnedWeight`).
 * Re-exported here because this module is the plugin's memory surface; the model
 * that owns and uses them is `lib/memory.js`. Deliberately *not* part of
 * {@link LIMITS}, which only counts bytes and must keep its old shape.
 */
export { DEFAULT_MEMORY_LIMITS }

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/
const TRUNCATION_MARK = '[… 较早的内容已截断 …]\n'
/** `<!-- key: <16 hex> -->` marks one archived item, so the archive stays idempotent. */
const ARCHIVED_ITEM_KEY = /<!--\s*key:\s*([0-9a-f]{16})\s*-->/g

/** One entry per live QQ conversation session, keyed by agent session id. */
const SESSIONS = new Map()

/**
 * Record that one agent session is a QQ conversation.
 * @param sessionId - the agent session id (`qq-<uuid>`).
 * @param isOwner - whether this conversation keeps its tools.
 */
export function trackQqSession(sessionId, isOwner) {
	if (typeof sessionId === 'string' && sessionId !== '') SESSIONS.set(sessionId, { isOwner: isOwner === true })
}

/** Forget one agent session; called when its handle is disposed. */
export function untrackQqSession(sessionId) {
	SESSIONS.delete(String(sessionId))
}

/**
 * Resolve the QQ conversation entry for the agent an assembly is for.
 * @param agent - `context.agent` of one prompt assembly.
 * @returns `{ isOwner }`, or `undefined` when this is not a QQ session.
 */
export function qqSessionOf(agent) {
	if (agent === undefined || agent === null) return undefined
	const id = String(agent.session?.id ?? agent.id ?? '')
	return id === '' ? undefined : SESSIONS.get(id)
}

/** The node-plugin package root (`…/qq-dsh/node-plugin`), from this module's own URL. */
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/**
 * `<repo>/qq-dsh/persona`, derived from this module's location. Deliberately
 * independent of the process cwd, which is the workspace the agent runs in.
 */
export function defaultPersonaDir() {
	return resolve(PACKAGE_ROOT, '..', 'persona')
}

/**
 * Keep the newest `maxBytes` bytes of a text, cutting on a UTF-8 boundary and
 * prefixing a truncation marker when the marker itself fits.
 * @param text - the full text.
 * @param maxBytes - the byte budget for the result.
 * @returns `{ text, bytes, total, truncated }`; `bytes` never exceeds `maxBytes`.
 */
export function tailCapped(text, maxBytes) {
	const full = Buffer.from(String(text ?? ''), 'utf8')
	const total = full.byteLength
	if (maxBytes <= 0) return { text: '', bytes: 0, total, truncated: total > 0 }
	if (total <= maxBytes) return { text: full.toString('utf8'), bytes: total, total, truncated: false }
	const mark = Buffer.from(TRUNCATION_MARK, 'utf8')
	const markText = maxBytes > mark.byteLength ? TRUNCATION_MARK : ''
	let start = total - (maxBytes - Buffer.byteLength(markText))
	while (start < total && (full[start] & 0xc0) === 0x80) start += 1
	const tail = full.subarray(start)
	return { text: markText + tail.toString('utf8'), bytes: Buffer.byteLength(markText) + tail.byteLength, total, truncated: true }
}

/** Human-readable state of one failed or empty read, for a warn line. */
function describe(read) {
	return read.ok ? 'empty' : `unreadable (${read.code})`
}

/** A read that yields no text: what a non-owner session sees instead of a private file. */
const EMPTY_READ = Object.freeze({ ok: true, text: '', bytes: 0, code: '' })

/** Newlines that keep two appended archive blocks separated by exactly one blank line. */
/** 按 MEMORY.md 里的原始顺序排回去：挑条目时新旧的顺序被打乱过。 */
function sortByIndex(entries) {
	return [...entries].sort((left, right) => left.index - right.index)
}
function separatorAfter(existing) {
	if (existing === '' || existing.endsWith('\n\n')) return ''
	return existing.endsWith('\n') ? '\n' : '\n\n'
}

/** Compose the section body: persona first, then memory, then the kept diary days. */
function render(personaText, memoryText, days, correctionsText = '', knowledgeText = '') {
	const parts = []
	if (personaText.trim() !== '') parts.push(personaText.trim())
	// 规矩排在人格之后、记忆之前：它是主人的明确要求，不该被会衰减的记忆挤掉。
	if (correctionsText.trim() !== '') parts.push(`## 他给你立的规矩\n\n${correctionsText.trim()}`)
	if (memoryText.trim() !== '') parts.push(`## 长期记忆\n\n${memoryText.trim()}`)
	if (knowledgeText.trim() !== '') parts.push(`## 我记下的笔记\n\n${knowledgeText.trim()}`)
	const written = days.filter((day) => day.text.trim() !== '')
	if (written.length > 0) {
		const body = written.map((day) => `### ${day.date}\n\n${day.text.trim()}`).join('\n\n')
		parts.push(`## 最近的日记（${written.length} 天，旧的在前）\n\n${body}`)
	}
	return parts.join('\n\n')
}

/**
 * Owns the persona/memory files and the three prompt sections that expose them.
 * One instance per plugin row; `attach()` registers the sections.
 */
export class QqPersona {
	#dir
	#limits
	#memoryLimits
	#memoryDecay
	#worldLifeFile
	#qzoneLogFile
	#log
	#warned = new Set()
	#signature = ''

	/**
	 * `lib/memory-store.js` speaks `(level, message)`; the plugin's log takes the
	 * message alone. Adapter kept here so the store stays usable on its own.
	 */
	#storeLog = (_level, message) => this.#warn(message, message)

	/**
	 * @param options.personaDir - directory holding `PERSONA.md`, `MEMORY.md`, `diary/`.
	 * @param options.limits - overrides for {@link LIMITS}.
	 * @param options.memoryLimits - overrides for {@link DEFAULT_MEMORY_LIMITS}.
	 * @param options.memoryDecay - score, forget and archive memory items;
	 *   `false` restores the previous behaviour byte for byte.
	 * @param options.worldLifeFile - the world's JSONL feed; empty resolves
	 *   `WORLD_LIFE_FILE`, else `/opt/whale-craft/life-feed.jsonl`.
	 * @param options.qzoneLogFile - the QQ-Zone log the cloud side appends; empty
	 *   resolves `QZONE_LOG_FILE`, else `/opt/whale-craft/qzone-log.md`.
	 * @param options.log - `(level, message) => void` diagnostic sink.
	 */
	constructor({
		personaDir = defaultPersonaDir(),
		limits = LIMITS,
		memoryLimits = DEFAULT_MEMORY_LIMITS,
		memoryDecay = true,
		worldLifeFile = defaultWorldLifeFile(),
		qzoneLogFile = defaultQzoneLogFile(),
		log = () => {},
	} = {}) {
		this.#dir = resolve(String(personaDir === '' ? defaultPersonaDir() : personaDir))
		this.#limits = { ...LIMITS, ...limits }
		this.#memoryLimits = { ...DEFAULT_MEMORY_LIMITS, ...memoryLimits }
		this.#memoryDecay = memoryDecay !== false
		this.#worldLifeFile = String(worldLifeFile === undefined || worldLifeFile === '' ? defaultWorldLifeFile() : worldLifeFile)
		this.#qzoneLogFile = String(qzoneLogFile === undefined || qzoneLogFile === '' ? defaultQzoneLogFile() : qzoneLogFile)
		this.#log = log
	}

	/** Whether the decay model is active for this instance. */
	get memoryDecay() {
		return this.#memoryDecay
	}

	/** The resolved persona directory (absolute). */
	get personaDir() {
		return this.#dir
	}

	/** The diary directory (absolute); not created here. */
	get diaryDir() {
		return join(this.#dir, 'diary')
	}

	/** The world-life feed this instance reads. */
	get worldLifeFile() {
		return this.#worldLifeFile
	}

	/** The QQ-Zone log this instance reads. */
	get qzoneLogFile() {
		return this.#qzoneLogFile
	}

	/**
	 * Register every section on a systemPrompt service and report the files
	 * this instance actually sees, so a broken layout is one warn at boot.
	 * @param prompt - the `ctx.systemPrompt` service, or `undefined` when absent.
	 * @returns a disposer that unregisters whatever was accepted.
	 */
	attach(prompt) {
		this.#layout()
		if (prompt === undefined || prompt === null || typeof prompt.section !== 'function') {
			this.#warn('service', 'qq-node: no systemPrompt service; persona and memory are not injected')
			return () => {}
		}
		const disposers = []
		const sections = [
			{ name: PERSONA_SECTION, order: PERSONA_ORDER, interpolate: false, text: (context) => this.personaText(context) },
			{ name: PACE_SECTION, order: PACE_ORDER, interpolate: false, text: (context) => this.paceText(context) },
			{ name: DIARY_SECTION, order: DIARY_ORDER, interpolate: false, text: (context) => this.diaryText(context) },
			{ name: WORLD_LIFE_SECTION, order: WORLD_LIFE_ORDER, interpolate: false, text: (context) => this.worldLifeText(context) },
			{ name: QZONE_NOTES_SECTION, order: QZONE_NOTES_ORDER, interpolate: false, text: (context) => this.qzoneNotesText(context) },
		]
		for (const section of sections) {
			try {
				disposers.push(prompt.section(section))
			} catch (error) {
				this.#warn(`section:${section.name}`, `qq-node: prompt section "${section.name}" was refused: ${error?.message ?? String(error)}`)
			}
		}
		return () => {
			for (const dispose of disposers.reverse()) {
				try {
					dispose()
				} catch (error) {
					this.#warn('dispose', `qq-node: prompt section dispose failed: ${error?.message ?? String(error)}`)
				}
			}
		}
	}

	/**
	 * The persona + memory block, rendered fresh from disk on every assembly.
	 * @param context - the assembly context; `context.agent` selects the session.
	 * @returns the section text, or `''` for a session that is not a QQ conversation.
	 */
	personaText(context) {
		const snapshot = this.snapshot(context)
		if (snapshot === undefined) return ''
		this.#report(snapshot)
		return snapshot.text
	}

	/**
	 * The per-turn tool budget. Owner sessions only: guests have no tools, and the
	 * 2026-11-01 timeout came from a 41-tool-call turn that never got to speak.
	 * @param context - the assembly context; `context.agent` selects the session.
	 * @returns the section text, or `''` for a non-owner (or non-QQ) session.
	 */
	paceText(context) {
		const session = qqSessionOf(context?.agent)
		if (session === undefined || session.isOwner !== true) return ''
		return [PACE_TITLE, '', ...PACE_LINES.map((line) => `- ${line}`)].join('\n')
	}

	/**
	 * The diary write convention. Owner sessions only: a non-owner session has no
	 * tools, so it must not be told that a diary file exists at all.
	 * @param context - the assembly context; `context.agent` selects the session.
	 * @returns the section text, or `''` for a non-owner (or non-QQ) session.
	 */
	diaryText(context) {
		const session = qqSessionOf(context?.agent)
		if (session === undefined || session.isOwner !== true) return ''
		const file = join(this.diaryDir, 'YYYY-MM-DD.md')
		return [
			'## 日记',
			'',
			'你和主人聊完之后，把这一轮记进日记。用你自己的文件工具写，不要问我能不能写。',
			'',
			`- 位置：\`${file}\`（YYYY-MM-DD 换成当天日期，一天一个文件）`,
			'- 写法：只追加到文件末尾。不要重写、不要覆盖、不要改昨天已经写好的内容。',
			'- 写什么：一两句，写他今天的样子、情绪、你答应过的事。不是流水账，也不要抄聊天原文。',
			'- 当天文件还不存在，就直接新建。没内容就不写，不必每句话都记。',
		].join('\n')
	}

	/**
	 * Her own Minecraft days, as one short fragment.
	 *
	 * Empty when the feed is missing or holds nothing from the last two days: an
	 * empty section is dropped by the renderer, so not even a heading survives.
	 * @param context - the assembly context; `context.agent` selects the session.
	 * @returns the section text, or `''` for a non-QQ session or a quiet feed.
	 */
	worldLifeText(context) {
		if (qqSessionOf(context?.agent) === undefined) return ''
		const body = renderWorldLife({ file: this.#worldLifeFile })
		if (body === '') return ''
		return `${WORLD_LIFE_TITLE}\n\n${WORLD_LIFE_GUIDE}\n\n${body}`
	}

	/**
	 * The posts she already published to QQ Zone, as a short list.
	 *
	 * NapCat has no "list my moments" call, so this log is the only thing that can
	 * answer 「你刚才说说讲了什么」; the fragment drops the QQ gate for us and a
	 * missing log renders as `''`, which the renderer drops whole.
	 * @param context - the assembly context; `context.agent` selects the session.
	 * @returns the section text, or `''` for a non-QQ session or an empty log.
	 */
	qzoneNotesText(context) {
		const body = renderQzoneNotes(context, { file: this.#qzoneLogFile })
		if (body === '') return ''
		return `${QZONE_NOTES_TITLE}\n\n${QZONE_NOTES_GUIDE}\n\n${body}`
	}

	/**
	 * Read the memory scope from disk and fit it into the caps, newest first.
	 * @param context - the assembly context; `context.agent` selects the session.
	 * @returns `{ persona, memory, days, text, totalBytes }` — `totalBytes` is the
	 *   byte length of `text`, the exact section body — or `undefined` when this is
	 *   not a QQ conversation.
	 */
	snapshot(context) {
		const session = qqSessionOf(context?.agent)
		if (session === undefined) return undefined
		const layout = this.#layout()
		// 与他的记忆只给主人：MEMORY.md 写的是他的生日、作息、家里的事，规矩文件
		// 是他亲口立的规矩，日记写的是他每天的样子。这三样出现在别人的会话里，
		// 就是把他的私事摊给第三方——他自己说过「与我的记忆和别人跟你对话要分开」。
		const visible = session.isOwner === true ? layout : { ...layout, memory: EMPTY_READ, corrections: EMPTY_READ, days: [] }
		if (session.isOwner !== true) this.#warn('persona:guest', 'qq-node: non-owner session gets the persona only; memory, rules and diary stay with the owner')
		const cap = this.#limits.totalBytes
		let result = this.#compose(visible, cap)
		// The headings are part of what gets injected, so the content budget is the
		// cap minus them; one extra pass suffices, the loop only guards the edge.
		for (let pass = 0; pass < 3 && result.totalBytes > cap; pass += 1) {
			result = this.#compose(visible, Math.max(0, cap - (result.totalBytes - cap)))
		}
		// `metrics` always describes the files on disk, never the viewer: the
		// once-per-layout boot line must not flip back and forth per session.
		return { ...result, metrics: layout }
	}

	/** Fit the layout into `budget` bytes, newest first, and render it. */
	#compose(layout, budget) {
		// 日记（尤其是当天那篇）先占住一块预算，剩下的才交给记忆和笔记。
		// 没有日记可注入时不预留，免得白白浪费一半预算。
		const hasDiary = layout.days.some((entry) => entry.text.trim() !== '')
		const reserve = hasDiary ? Math.min(this.#limits.diaryReserveBytes, Math.floor(budget / 2)) : 0
		let personaText = layout.persona.text
		let personaBytes = Buffer.byteLength(personaText, 'utf8')
		if (personaBytes > budget - reserve) {
			personaText = tailCapped(personaText, Math.max(0, budget - reserve)).text
			personaBytes = Buffer.byteLength(personaText, 'utf8')
		}
		let remaining = budget - reserve - personaBytes
		const corrections = tailCapped(layout.corrections.text, Math.max(0, remaining))
		remaining -= corrections.bytes
		// Decay decides *what* memory is worth injecting; `tailCapped` below still
		// bounds it. With `memoryDecay: false` the source is the raw file, so this
		// line is the previous one character for character.
		const memoryText = this.#memoryDecay ? this.#decayMemory(layout.memory) : layout.memory.text
		const memory = this.#fitMemory(memoryText, Math.min(this.#limits.memoryBytes, Math.max(0, remaining)))
		// 记忆窗口满了以后，先丢的是最旧的那些**普通**条目；identity / rule 那几行永远留着
		// （它们是「她是谁」「主人立过的规矩」）。丢下的仍在 MEMORY.md 里，recall 也翻得到，
		// 但日志里得看得见，否则「她忘了」会变成无迹可寻。
		if (memory.dropped > 0) {
			this.#warn(
				'memory:overflow',
				`qq-node: memory: ${memory.dropped} of ${memory.total} item(s) fell out of the ${Math.round(this.#limits.memoryBytes / 1024)} KiB window; identity and rules stay, the rest remain in MEMORY.md and recall still finds them`,
			)
		}
		remaining -= memory.bytes
		// 她自己记下的笔记排在记忆之后、日记之前：是「学来的」，比流水账重要。
		const knowledge = tailCapped(layout.knowledge ?? '', Math.max(0, remaining))
		remaining -= knowledge.bytes
		// 留给日记的那一块此刻回到手上。
		remaining += reserve

		// Budget the newest diary day first, then display the kept days oldest-first.
		const days = []
		for (const entry of layout.days) {
			const part = tailCapped(entry.text, Math.min(this.#limits.diaryDayBytes, Math.max(0, remaining)))
			remaining -= part.bytes
			days.push({ date: entry.date, text: part.text, bytes: part.bytes, truncated: part.truncated })
		}
		days.reverse()

		const text = render(personaText, memory.text, days, corrections.text, knowledge.text)
		return {
			persona: { text: personaText, bytes: personaBytes, truncated: personaText !== layout.persona.text },
			memory: { text: memory.text, bytes: memory.bytes, truncated: memory.truncated },
			knowledge: { text: knowledge.text, bytes: knowledge.bytes, truncated: knowledge.truncated },
			days,
			text,
			totalBytes: Buffer.byteLength(text, 'utf8'),
		}
	}

	/**
	 * 把记忆塞进 `budgetBytes`：装得下就原样（照旧走 `tailCapped`，与旧行为逐字一致）。
	 * 装不下时先保 identity / rule，再按「新的优先」挑普通条目——`tailCapped` 那种按文件
	 * 位置硬切会把她是谁、主人立过的规矩一起切掉，那是这个系统最不能丢的东西。
	 * 返回 `{ text, bytes, truncated, dropped, total }`。
	 */
	#fitMemory(text, budgetBytes) {
		const capped = tailCapped(text, budgetBytes)
		if (!capped.truncated) return { ...capped, dropped: 0, total: 0 }
		try {
			const { preamble, items } = splitMemoryItems(text)
			if (items.length === 0) return { ...capped, dropped: 0, total: 0 }
			const pinned = []
			const others = []
			for (const [index, item] of items.entries()) {
				const kind = readKind(item.text)
				const weight = readWeight(item.text)
				const pinnedItem = weight >= this.#memoryLimits.pinnedWeight || (kind !== undefined && PINNED_KINDS.includes(kind))
				;(pinnedItem ? pinned : others).push({ item, index })
			}
			const keep = [...pinned]
			// 普通条目从新到旧往里填：新的还热着，旧的有 recall 兜底。
			for (let index = others.length - 1; index >= 0; index -= 1) {
				const candidate = [...keep, others[index]]
				const bytes = Buffer.byteLength(renderMemory({ preamble, items: sortByIndex(candidate).map((entry) => entry.item) }), 'utf8')
				if (bytes > budgetBytes) continue
				keep.push(others[index])
			}
			if (keep.length === 0) return { ...capped, dropped: items.length, total: items.length }
			const rendered = renderMemory({ preamble, items: sortByIndex(keep).map((entry) => entry.item) })
			const bytes = Buffer.byteLength(rendered, 'utf8')
			// 钉住的条目自己就超预算时退回硬切，保证窗口一定装得下。
			if (bytes > budgetBytes) return { ...capped, dropped: items.length - pinned.length, total: items.length }
			return { text: rendered, bytes, truncated: true, dropped: items.length - keep.length, total: items.length }
		} catch (error) {
			this.#warn('memory:fit', `qq-node: memory: cannot fit the memory block (${error?.code ?? error?.message ?? String(error)}); cutting by size instead`)
			return { ...capped, dropped: 0, total: 0 }
		}
	}

	/**
	 * The decay step of `#compose`: split MEMORY.md into items, keep the ones that
	 * still score above the line, archive what fell out, render the rest.
	 *
	 * Any failure returns the input text unchanged: a corrupt `meta.json`, a
	 * read-only directory or a parser surprise degrades to the previous behaviour
	 * instead of emptying the memory block of a live prompt.
	 */
	#decayMemory(read) {
		if (read.bytes === 0) return read.text
		try {
			const { preamble, items } = splitMemoryItems(read.text)
			if (items.length === 0) return read.text
			const meta = readMeta(this.#dir, { log: this.#storeLog })
			const { kept, forgotten } = selectItems(items, meta.items, {
				...this.#memoryLimits,
				freshLastTouchedAt: this.#memoryTouchedAt(),
			})
			if (forgotten.length > 0) this.#archiveForgotten(forgotten)
			// 检索多样性：两条几乎是同一句话时不并排注入两遍——她的注意力被同一件事占两次，
			// 别的事就没地方放了。被省下的那条仍在 MEMORY.md 里，recall 随时能翻到。
			const shown = this.#diverseItems(kept)
			const pooled = this.#capKinds(shown)
			this.#countInjections(pooled)
			// Score decides *what* survives, not how the survivors read: keep the
			// file's own order so the injected block still makes sense.
			const rank = new Map(items.map((item, index) => [item.key, index]))
			const ordered = [...pooled].sort((left, right) => (rank.get(left.key) ?? 0) - (rank.get(right.key) ?? 0))
			return renderMemory({ preamble, items: ordered })
		} catch (error) {
			this.#warn('memory:decay', `qq-node: memory: the decay pass failed (${error?.code ?? error?.message ?? String(error)}); MEMORY.md is injected whole`)
			return read.text
		}
	}

	/**
	 * Drop items that repeat one already in the list.
	 *
	 * Pinned items (identity / rule, or weight 5) are never dropped: if two of them
	 * say the same thing, both stay, because a rule she must never break is worth the
	 * duplicate bytes. Everything else yields to the item listed before it.
	 */
	#diverseItems(items) {
		const shown = []
		const texts = []
		let dropped = 0
		for (const item of items) {
			const kind = readKind(item.text)
			const pinned = readWeight(item.text) >= this.#memoryLimits.pinnedWeight || (kind !== undefined && PINNED_KINDS.includes(kind))
			if (!pinned && texts.some((other) => isNearDuplicate(other, item.text))) {
				dropped += 1
				continue
			}
			shown.push(item)
			texts.push(item.text)
		}
		if (dropped > 0) this.#warn('memory:similar', `qq-node: memory: ${dropped} item(s) repeat one already shown; they stay in MEMORY.md and recall still finds them`)
		return shown
	}

	/**
	 * Cap the note-shaped kinds so they cannot crowd her own life out.
	 *
	 * `ops`（这台机器怎么跑）和 `note`（索引/wiki）长得最稳，`event`（她的塔、麦田、
	 * 小尾巴）才是她该记得的。两档各有一个字节池，池满之后的新条目这一次不注入——
	 * 文件不动，`recall` 照样找得到。钉住的条目不受池子限制。
	 */
	#capKinds(items) {
		const caps = new Map([
			['ops', this.#limits.opsMemoryBytes],
			['note', this.#limits.noteMemoryBytes],
		])
		const used = new Map()
		const kept = []
		let dropped = 0
		for (const item of items) {
			const kind = readKind(item.text)
			const cap = kind === undefined ? undefined : caps.get(kind)
			if (cap === undefined) {
				kept.push(item)
				continue
			}
			const pinned = readWeight(item.text) >= this.#memoryLimits.pinnedWeight || PINNED_KINDS.includes(kind)
			const bytes = Buffer.byteLength(item.text, 'utf8')
			const soFar = used.get(kind) ?? 0
			if (!pinned && soFar + bytes > cap) {
				dropped += 1
				continue
			}
			used.set(kind, soFar + bytes)
			kept.push(item)
		}
		if (dropped > 0) this.#warn('memory:pool', `qq-node: memory: ${dropped} ops/note item(s) over their pool; they stay in MEMORY.md and recall still finds them`)
		return kept
	}

	/**
	 * Count one injection per injected item.
	 *
	 * 这里**不是**复习：注入不等于复习。2026-11-01 之前每次装配都调 `touchItems`
	 * 让每条注入项的 `reviews += 1`，于是「复习次数」量的是 prompt 装配了多少次，
	 * 而不是他重提了多少次——`stabilityDays = 2 ** reviews` 几分钟就撞上 `MAX_REVIEWS`
	 * 上限，35 条全部变成永不遗忘，`archive.md` 至今只有一条。现在只记 `injections`
	 * （统计用），`lastTouchedAt` / `reviews` 只由真正的确认（remember 写入、夜班合并）
	 * 推进；`memoryDecay: false` 时这段根本不跑。
	 *
	 * Items are grouped by weight so the file is rewritten at most once per distinct
	 * weight instead of once per item.
	 */
	#countInjections(items) {
		const byWeight = new Map()
		for (const item of items) {
			const weight = readWeight(item.text)
			const keys = byWeight.get(weight)
			if (keys === undefined) byWeight.set(weight, [item.key])
			else keys.push(item.key)
		}
		const nowMs = Date.now()
		for (const [weight, keys] of byWeight) {
			try {
				touchItems(this.#dir, keys, { nowMs, weight, mode: 'inject', log: this.#storeLog })
			} catch (error) {
				this.#warn('memory:inject', `qq-node: memory: cannot record ${keys.length} injected item(s) (${error?.code ?? error?.message ?? String(error)})`)
			}
		}
	}

	/** MEMORY.md's mtime: the last touch of an item that has no record yet. */
	#memoryTouchedAt() {
		try {
			return statSync(join(this.#dir, 'MEMORY.md')).mtimeMs
		} catch {
			return Date.now()
		}
	}

	/**
	 * Append forgotten items to `memory/archive.md`, each marked with its key so
	 * the same item is never written twice. Failure is one warn: the items are
	 * still forgotten, they are just not recoverable from the archive.
	 */
	#archiveForgotten(items) {
		const file = join(memoryDir(this.#dir), ITEM_ARCHIVE_FILE)
		try {
			mkdirSync(dirname(file), { recursive: true })
			const existing = this.#readSide(file)
			const seen = new Set()
			for (const match of existing.matchAll(ARCHIVED_ITEM_KEY)) seen.add(match[1])
			const blocks = []
			for (const item of items) {
				if (seen.has(item.key)) continue
				seen.add(item.key)
				blocks.push(`<!-- key: ${item.key} -->\n${renderMemory({ items: [item] })}\n\n`)
			}
			if (blocks.length > 0) appendFileSync(file, `${separatorAfter(existing)}${blocks.join('')}`)
			this.#warn(`memory:forgot:${items.length}`, `qq-node: memory: forgot ${items.length} item(s), archived to ${MEMORY_DIR}/${ITEM_ARCHIVE_FILE}`)
		} catch (error) {
			this.#warn('memory:archive', `qq-node: memory: cannot archive ${items.length} forgotten item(s) to ${file} (${error?.code ?? error?.message ?? String(error)})`)
		}
	}

	/**
	 * Append diary days that fell out of the injected window to
	 * `memory/archive/YYYY-MM.md`, one `## YYYY-MM-DD` block per day, skipping a
	 * date that is already there. The diary files themselves are never touched.
	 */
	#archiveDays(older) {
		for (const entry of older) {
			try {
				const read = this.#read(entry.file)
				if (read.bytes === 0) {
					if (!read.ok) this.#warn(`day:${entry.date}`, `qq-node: ${entry.file} is ${describe(read)}; that day is skipped`)
					continue
				}
				const file = join(memoryDir(this.#dir), DIARY_ARCHIVE_DIR, `${entry.date.slice(0, 7)}.md`)
				mkdirSync(dirname(file), { recursive: true })
				const existing = this.#readSide(file)
				if (existing.split('\n').some((line) => line.trim() === `## ${entry.date}`)) continue
				appendFileSync(file, `${separatorAfter(existing)}## ${entry.date}\n\n${read.text.trim()}\n\n`)
			} catch (error) {
				this.#warn('diary:archive', `qq-node: diary: cannot archive days older than ${this.#limits.diaryDays} (${error?.code ?? error?.message ?? String(error)}); those days stay out of the prompt`)
			}
		}
	}

	/** Read a side file for an idempotency check; a missing file is empty, not a failure. */
	#readSide(file) {
		try {
			return readFileSync(file, 'utf8')
		} catch (error) {
			if (error?.code === 'ENOENT') return ''
			throw error
		}
	}

	/** Read the whole memory scope; warns once per unreadable required file. */
	#layout() {
		const personaFile = join(this.#dir, 'PERSONA.md')
		const memoryFile = join(this.#dir, 'MEMORY.md')
		const correctionsFile = join(this.#dir, CORRECTION_FILE)
		const persona = this.#read(personaFile)
		const memory = this.#read(memoryFile)
		if (persona.bytes === 0) this.#warn('persona', `qq-node: ${personaFile} is ${describe(persona)}; no persona text is injected`)
		if (memory.bytes === 0) this.#warn('memory', `qq-node: ${memoryFile} is ${describe(memory)}; no long-term memory is injected`)
		// 规矩文件按设计可能不存在（还没人立过规矩），缺了不告警。
		const corrections = this.#read(correctionsFile)
		return { persona, memory, corrections, knowledge: this.#knowledgeText(), days: this.#diaryEntries() }
	}

	/**
	 * `knowledge/` 下她自己写的 notes，新写的优先。
	 *
	 * 这个目录存在很久了，但一直没人读——她写进去的东西从没回到她眼前。收进来
	 * 之后「学到的」才算真的学到；没有目录、没有文件都只是空串，不告警。
	 */
	#knowledgeText() {
		const dir = join(this.#dir, 'knowledge')
		let names
		try {
			names = readdirSync(dir)
		} catch {
			return ''
		}
		const entries = []
		for (const name of names) {
			if (!name.endsWith('.md')) continue
			const file = join(dir, name)
			try {
				entries.push({ file, mtime: statSync(file).mtimeMs })
			} catch {
				continue
			}
		}
		entries.sort((left, right) => right.mtime - left.mtime)
		const parts = []
		let used = 0
		for (const entry of entries) {
			const read = this.#read(entry.file)
			if (read.bytes === 0) continue
			const text = read.text.trim()
			// 超过预算就整篇跳过，不要半篇——半篇笔记比没有更容易误导人。
			if (used + Buffer.byteLength(text, 'utf8') > this.#limits.knowledgeBytes) continue
			used += Buffer.byteLength(text, 'utf8')
			parts.push(text)
		}
		return parts.join('\n\n')
	}

	/** Newest-first diary files, at most `diaryDays`, restricted to dated names. */
	#diaryEntries() {
		let names
		try {
			names = readdirSync(this.diaryDir)
		} catch (error) {
			this.#warn('diary', `qq-node: ${this.diaryDir} is not readable (${error?.code ?? error?.message ?? String(error)}); no diary is injected`)
			return []
		}
		const dated = []
		for (const name of names) {
			const match = DAY_FILE.exec(name)
			if (match !== null) dated.push({ date: match[1], file: join(this.diaryDir, name) })
		}
		dated.sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0))
		const kept = dated.slice(0, this.#limits.diaryDays)
		// A day is archived *before* it stops being injected, and the diary file
		// itself is never removed: the archive is a fallback, not a move.
		if (dated.length > kept.length) this.#archiveDays(dated.slice(kept.length))
		const entries = []
		for (const entry of kept) {
			const read = this.#read(entry.file)
			if (read.bytes > 0) entries.push({ date: entry.date, text: read.text, bytes: read.bytes })
			else if (!read.ok) this.#warn(`day:${entry.date}`, `qq-node: ${entry.file} is ${describe(read)}; that day is skipped`)
		}
		return entries
	}

	/** Read one file; a missing or unreadable file yields `ok: false`, an empty one `bytes: 0`. */
	#read(file) {
		try {
			const raw = readFileSync(file)
			return { ok: true, text: raw.toString('utf8'), bytes: raw.byteLength, code: '' }
		} catch (error) {
			return { ok: false, text: '', bytes: 0, code: String(error?.code ?? error?.message ?? error) }
		}
	}

	/** One metadata-only line per distinct file layout; never the memory body. */
	#report(snapshot) {
		const metrics = snapshot.metrics ?? snapshot
		const diaryDays = metrics.days.filter((day) => day.bytes > 0).length
		const signature = `${metrics.persona.bytes}|${metrics.memory.bytes}|${metrics.days.map((day) => `${day.date}:${day.bytes}`).join(',')}`
		if (signature === this.#signature) return
		this.#signature = signature
		this.#log(
			'info',
			`qq-node: persona: loaded ${metrics.persona.bytes} bytes, memory ${metrics.memory.bytes}/${this.#limits.memoryBytes}, diary ${diaryDays}d, total ${snapshot.totalBytes}/${this.#limits.totalBytes}`,
		)
	}

	/** Emit one warn per distinct condition, so a 24/7 plugin does not flood the log. */
	#warn(key, message) {
		if (this.#warned.has(key)) return
		this.#warned.add(key)
		this.#log('warn', message)
	}
}
