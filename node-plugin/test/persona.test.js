/**
 * Persona + long-term memory injection.
 *
 * Every case runs against a temporary persona directory: the shipped
 * `qq-dsh/persona/*.md` files belong to the operator and this suite never
 * writes to them. The prompt itself is rendered with the real `renderPrompt`
 * from `@deepseek-ai/dsh-system-prompt`, so interpolation, empty-section
 * dropping and `interpolate: false` behave exactly as in a live turn.
 */

import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { BridgeStub } from './bridge-stub.js'
import { FakeSystemPrompt, createFakeRuntime } from './fake-runtime.js'
import {
	DIARY_ORDER,
	DIARY_SECTION,
	LIMITS,
	PERSONA_ORDER,
	PACE_ORDER,
	PACE_SECTION,
	PERSONA_SECTION,
	QZONE_NOTES_ORDER,
	QZONE_NOTES_SECTION,
	WORLD_LIFE_ORDER,
	WORLD_LIFE_SECTION,
	QqPersona,
	defaultPersonaDir,
	tailCapped,
	trackQqSession,
	untrackQqSession,
} from '../lib/persona.js'
import { apply } from '../index.js'

const SANDBOX = mkdtempSync(join(tmpdir(), 'qq-persona-'))
after(() => rmSync(SANDBOX, { recursive: true, force: true }))

/** Build one throwaway persona directory. */
function makePersona({ persona, memory, diary = {} } = {}) {
	const dir = mkdtempSync(join(SANDBOX, 'p-'))
	if (persona !== undefined) writeFileSync(join(dir, 'PERSONA.md'), persona)
	if (memory !== undefined) writeFileSync(join(dir, 'MEMORY.md'), memory)
	const dates = Object.keys(diary)
	if (dates.length > 0) {
		mkdirSync(join(dir, 'diary'))
		for (const date of dates) writeFileSync(join(dir, 'diary', `${date}.md`), diary[date])
	}
	return dir
}

/** Collect the plugin's diagnostic lines instead of printing them. */
function recorder() {
	const lines = []
	return {
		lines,
		log: (level, message) => lines.push(`${level}: ${message}`),
		warns: () => lines.filter((line) => line.startsWith('warn: ')),
		infos: () => lines.filter((line) => line.startsWith('info: ')),
	}
}

/** Mirror `assembleContextFor(agent)`: the assembly context a real turn passes. */
function contextFor(sessionId) {
	const agent = { id: sessionId, session: { id: sessionId } }
	return { agent, scope: agent }
}

const sectionOf = (assembly, name) => assembly.sections.find((section) => section.name === name)

test('persona 1 — the section is registered once, ordered, and re-reads disk on every assembly', async () => {
	const dir = makePersona({ persona: '# 小D\n\n我叫小D。\n', memory: '# 记忆\n\n- 关于主人。\n' })
	const recorderLines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: recorderLines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)

	assert.deepEqual([...prompt.sections.keys()], [PERSONA_SECTION, PACE_SECTION, DIARY_SECTION, WORLD_LIFE_SECTION, QZONE_NOTES_SECTION])
	assert.equal(PERSONA_SECTION, 'qq:persona')
	assert.equal(prompt.sections.get(PERSONA_SECTION).order, PERSONA_ORDER)
	assert.equal(prompt.sections.get(PACE_SECTION).order, PACE_ORDER)
	assert.equal(prompt.sections.get(DIARY_SECTION).order, DIARY_ORDER)
	assert.equal(prompt.sections.get(WORLD_LIFE_SECTION).order, WORLD_LIFE_ORDER)
	assert.equal(prompt.sections.get(QZONE_NOTES_SECTION).order, QZONE_NOTES_ORDER)
	// After DEPLOYMENT_PERSONA_PREFIX (0) and before PLAN_POLICY (500): the persona
	// wraps the deployment prompt, and the contract sits directly behind it.
	assert.ok(PERSONA_ORDER > 0 && PERSONA_ORDER < 500)
	// 干活的节奏紧跟人格：先知道「我是谁」，再知道「这一回合怎么用力」。
	assert.ok(PACE_ORDER > PERSONA_ORDER && PACE_ORDER < DIARY_ORDER)
	assert.ok(DIARY_ORDER > PERSONA_ORDER && DIARY_ORDER < 500)
	// 她自己的世界排在人格与记忆之后：先读「我是谁」，再读「我最近在过什么日子」。
	assert.ok(WORLD_LIFE_ORDER > DIARY_ORDER && WORLD_LIFE_ORDER < 500)
	// 说说排在世界之后：那是她刚刚做过的事，最后一件事最好记得住。
	assert.ok(QZONE_NOTES_ORDER > WORLD_LIFE_ORDER && QZONE_NOTES_ORDER < 500)
	// `{{name}}` in a diary entry is prose, not a prompt variable.
	assert.equal(prompt.sections.get(PERSONA_SECTION).interpolate, false)
	assert.equal(prompt.sections.get(DIARY_SECTION).interpolate, false)
	assert.equal(typeof prompt.sections.get(PERSONA_SECTION).text, 'function')

	trackQqSession('qq-1', true)
	const first = sectionOf(await prompt.assemble(contextFor('qq-1')), PERSONA_SECTION).text
	assert.match(first, /我叫小D。/)
	writeFileSync(join(dir, 'PERSONA.md'), '# 小D\n\n我叫小D，刚改过一行。\n')
	const second = sectionOf(await prompt.assemble(contextFor('qq-1')), PERSONA_SECTION).text
	assert.notEqual(second, first, 'the section text must change when the file changes')
	assert.match(second, /刚改过一行/)
	assert.ok(!second.includes('我叫小D。\n'), 'the stale line is gone')
	assert.equal(prompt.assemblies, 2)

	// A second registration of the same name is refused, not thrown.
	const detachAgain = persona.attach(prompt)
	assert.equal(prompt.sections.size, 5)
	assert.ok(recorderLines.warns().some((line) => /already registered/.test(line)))
	detachAgain()

	// Braces survive: `interpolate: false` keeps `{{…}}` literal through the real renderer.
	writeFileSync(join(dir, 'MEMORY.md'), '# 记忆\n\n- 他说过 {{不是变量}}。\n')
	const rendered = renderPrompt(await prompt.assemble(contextFor('qq-1')))
	assert.match(rendered, /\{\{不是变量\}\}/)

	// Metadata-only logging: sizes, never the memory body.
	const loaded = recorderLines.infos().find((line) => line.includes('persona: loaded'))
	assert.match(loaded, /persona: loaded \d+ bytes, memory \d+\/8192, diary 0d, total \d+\/32768/)
	assert.ok(!recorderLines.lines.some((line) => line.includes('我叫小D')), 'no persona body in the log')
	assert.ok(!recorderLines.lines.some((line) => line.includes('不是变量')), 'no memory body in the log')

	detach()
	assert.equal(prompt.sections.size, 0)
	untrackQqSession('qq-1')
	console.log('[persona 1] sections =', JSON.stringify([...new Set([PERSONA_SECTION, PACE_SECTION, DIARY_SECTION, WORLD_LIFE_SECTION, QZONE_NOTES_SECTION])]), '| orders =', PERSONA_ORDER, DIARY_ORDER, WORLD_LIFE_ORDER, QZONE_NOTES_ORDER, '|', loaded)
})

test('persona 2a — a missing MEMORY.md does not crash: sections stay, one warn', () => {
	const dir = makePersona({ persona: '# 小D\n\n人格还在。\n' })
	const recorderLines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: recorderLines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)

	assert.deepEqual([...prompt.sections.keys()], [PERSONA_SECTION, PACE_SECTION, DIARY_SECTION, WORLD_LIFE_SECTION, QZONE_NOTES_SECTION])
	trackQqSession('qq-2a', true)
	const text = persona.personaText(contextFor('qq-2a'))
	assert.match(text, /人格还在。/)
	assert.ok(!text.includes('长期记忆'))
	const memoryWarns = recorderLines.warns().filter((line) => line.includes('MEMORY.md'))
	assert.equal(memoryWarns.length, 1, `one warn for MEMORY.md, got ${JSON.stringify(recorderLines.lines)}`)
	persona.personaText(contextFor('qq-2a'))
	assert.equal(recorderLines.warns().filter((line) => line.includes('MEMORY.md')).length, 1, 'the warn is not repeated per turn')

	detach()
	untrackQqSession('qq-2a')
	console.log('[persona 2a] warns =', JSON.stringify(recorderLines.warns()))
})

test('persona 2b — memory reaches the prompt, and an oversized MEMORY.md keeps the newest bytes', async () => {
	const memory = `OLD-MARK${'x'.repeat(9000)}NEW-MARK`
	const dir = makePersona({ persona: '# 小D\n\n我叫小D。\n', memory })
	const recorderLines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: recorderLines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-2b', true)

	const assembly = await prompt.assemble(contextFor('qq-2b'))
	const section = sectionOf(assembly, PERSONA_SECTION)
	const rendered = renderPrompt(assembly)
	assert.ok(Buffer.byteLength(memory, 'utf8') > LIMITS.memoryBytes)
	assert.match(rendered, /我叫小D。/)
	assert.match(rendered, /NEW-MARK/, 'the newest bytes reach the prompt')
	assert.ok(!rendered.includes('OLD-MARK'), 'the oldest bytes are cut, the block is kept')

	const snapshot = persona.snapshot(contextFor('qq-2b'))
	assert.ok(snapshot.memory.bytes <= LIMITS.memoryBytes)
	assert.equal(snapshot.memory.truncated, true)
	assert.ok(snapshot.totalBytes <= LIMITS.totalBytes)
	assert.ok(Buffer.byteLength(section.text, 'utf8') <= LIMITS.totalBytes)
	assert.equal(LIMITS.memoryBytes, 8192)
	assert.equal(LIMITS.diaryDayBytes, 4096)
	assert.equal(LIMITS.diaryReserveBytes, 6144)
	assert.equal(LIMITS.totalBytes, 32768)

	detach()
	untrackQqSession('qq-2b')
	console.log('[persona 2b] memory bytes =', snapshot.memory.bytes, '| total =', snapshot.totalBytes, '|', recorderLines.infos().find((line) => line.includes('persona: loaded')))
})

test('persona 2c — only the newest seven diary days are read, each truncated to keep its newest bytes', () => {
	const dir = makePersona({
		persona: '# 小D\n\n我叫小D。\n',
		memory: '# 记忆\n\n- 一条。\n',
		diary: {
			'2025-12-28': 'DAY-1228 body\n',
			'2025-12-29': 'DAY-1229 body\n',
			'2025-12-30': 'DAY-1230 body\n',
			'2025-12-31': 'DAY-1231 body\n',
			'2026-01-01': 'DAY-0101 body\n',
			'2026-01-02': 'DAY-0102 body\n',
			'2026-01-03': 'D3-OLD\n',
			'2026-01-04': `D4-OLD${'z'.repeat(6000)}D4-NEW\n`,
		},
	})
	const recorderLines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: recorderLines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-2c', true)

	const snapshot = persona.snapshot(contextFor('qq-2c'))
	assert.equal(snapshot.days.length, 7, 'seven days, not eight')
	assert.deepEqual(
		snapshot.days.map((day) => day.date),
		['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'],
		'displayed oldest-first',
	)
	const text = persona.personaText(contextFor('qq-2c'))
	assert.ok(!text.includes('DAY-1228'), 'the eighth day is out of scope')
	const newest = snapshot.days.at(-1)
	assert.ok(newest.bytes <= LIMITS.diaryDayBytes, `day cap: ${newest.bytes}`)
	assert.match(newest.text, /D4-NEW/)
	assert.ok(!newest.text.includes('D4-OLD'))
	assert.match(text, /## 最近的日记（7 天，旧的在前）/)
	assert.ok(snapshot.totalBytes <= LIMITS.totalBytes)

	detach()
	untrackQqSession('qq-2c')
	console.log('[persona 2c] days =', JSON.stringify(snapshot.days.map((day) => `${day.date}:${day.bytes}`)), '| total =', snapshot.totalBytes)
})

test('persona 2d2 — a full memory and note block still leaves room for the newest diary day', () => {
	// 线上真实形状：人格 4K、记忆 6-8K、笔记 1-2K。按「谁在前面谁先拿」分预算时，
	// 轮到她日记时预算已经见底，于是 diary 0d——她当天写的东西进不了当天的对话。
	const dir = makePersona({
		persona: `# 小D\n\n${'p'.repeat(3800)}\n`,
		memory: `#记忆\n\n${'m'.repeat(7900)}\n`,
		diary: {
			'2026-01-03': `D3${'b'.repeat(900)}\n`,
			'2026-01-04': `D4${'c'.repeat(900)}D4-NEWEST\n`,
		},
	})
	mkdirSync(join(dir, 'knowledge'), { recursive: true })
	writeFileSync(join(dir, 'knowledge', 'note.md'), `# 笔记\n\n${'k'.repeat(3900)}\n`)
	const recorderLines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: recorderLines.log })
	persona.attach(new FakeSystemPrompt())
	trackQqSession('qq-2d2', true)

	const snapshot = persona.snapshot(contextFor('qq-2d2'))
	const text = persona.personaText(contextFor('qq-2d2'))
	assert.ok(snapshot.totalBytes <= LIMITS.totalBytes, `total ${snapshot.totalBytes} <= ${LIMITS.totalBytes}`)
	assert.ok(snapshot.days.length >= 1, `at least one diary day reaches the prompt, got ${snapshot.days.length}`)
	assert.match(text, /D4-NEWEST/, 'the newest diary day survives a full memory block')
	assert.match(text, /m{100}/, 'the memory block still survives too')
	assert.equal(snapshot.memory.bytes <= LIMITS.memoryBytes, true)

	untrackQqSession('qq-2d2')
	console.log('[persona 2d2] total =', snapshot.totalBytes, '/', LIMITS.totalBytes, '| days =', JSON.stringify(snapshot.days.map((day) => `${day.date}:${day.bytes}`)), '| memory =', snapshot.memory.bytes, '|', recorderLines.infos().find((line) => line.includes('persona: loaded')))
})

test('persona 2d — the total cap binds before the newest content does', () => {
	const dir = makePersona({
		persona: `# 小D\n\n${'p'.repeat(2000)}\n`,
		memory: `#M${'m'.repeat(8000)}`,
		diary: {
			'2026-01-02': `D2${'a'.repeat(5000)}`,
			'2026-01-03': `D3${'b'.repeat(5000)}`,
			'2026-01-04': `D4${'c'.repeat(5000)}D4-NEWEST`,
		},
	})
	const recorderLines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: recorderLines.log })
	persona.attach(new FakeSystemPrompt())
	trackQqSession('qq-2d', true)

	const snapshot = persona.snapshot(contextFor('qq-2d'))
	const text = persona.personaText(contextFor('qq-2d'))
	assert.ok(snapshot.totalBytes <= LIMITS.totalBytes, `total ${snapshot.totalBytes} <= ${LIMITS.totalBytes}`)
	assert.ok(Buffer.byteLength(text, 'utf8') <= LIMITS.totalBytes)
	assert.match(text, /p{100}/, 'the persona block survives intact')
	assert.match(text, /D4-NEWEST/, 'the newest diary content survives')
	assert.ok(text.includes('长期记忆'))

	untrackQqSession('qq-2d')
	console.log('[persona 2d] total =', snapshot.totalBytes, '/', LIMITS.totalBytes, '| days =', JSON.stringify(snapshot.days.map((day) => day.bytes)), '|', recorderLines.infos().find((line) => line.includes('persona: loaded')))
})

test('persona 2e — tailCapped keeps the newest bytes and never exceeds the budget', () => {
	const cut = tailCapped('旧'.repeat(100) + '尾巴', 60)
	assert.ok(cut.bytes <= 60, `bytes ${cut.bytes}`)
	assert.match(cut.text, /尾巴$/)
	assert.equal(cut.truncated, true)
	const untouched = tailCapped('短', 60)
	assert.deepEqual([untouched.text, untouched.truncated], ['短', false])
	assert.equal(tailCapped('anything', 0).bytes, 0)
})

test('persona 3 — the diary contract reaches owner sessions only', async () => {
	const dir = makePersona({
		persona: '# 小D\n\n我叫小D，是主人的助手。\n',
		memory: '# 记忆\n\n- 他在把 DSH 接进 QQ。\n',
		diary: { '2026-01-04': '今天他有点累。\n' },
	})
	const stub = await new BridgeStub().start()
	const runtime = createFakeRuntime({ reply: () => ({ text: '嗯，我在。' }) })
	try {
		apply(runtime.ctx, {
			bridgeUrl: stub.url,
			nodeToken: stub.token,
			pollWaitSeconds: 1,
			pollLimit: 2,
			maxConcurrentTurns: 2,
			turnTimeoutMs: 5000,
			idleRecycleMs: 60_000,
			cwd: process.cwd(),
			personaDir: dir,
		})
		stub.queue({ taskId: 'owner-1', userId: '1001', text: '在吗', isOwner: true })
		stub.queue({ taskId: 'guest-1', userId: '2002', text: '在吗' })
		await stub.waitFor((bridge) => bridge.results.has('owner-1') && bridge.results.has('guest-1'), { label: 'owner + guest results', timeoutMs: 15_000 })

		const agents = [...runtime.agents.values()]
		const owner = agents.find((agent) => agent.options.meta.agentPreset === undefined)
		const guest = agents.find((agent) => agent.options.meta.agentPreset === 'qq-chat-only')
		assert.ok(owner !== undefined && guest !== undefined, 'apply() created one owner and one non-owner session')

		const diaryFile = join(dir, 'diary', 'YYYY-MM-DD.md')
		const ownerAssembly = await runtime.systemPrompt.assemble(contextFor(String(owner.session.id)))
		const guestAssembly = await runtime.systemPrompt.assemble(contextFor(String(guest.session.id)))
		const ownerPrompt = renderPrompt(ownerAssembly)
		const guestPrompt = renderPrompt(guestAssembly)

		// Both conversations are 小D…
		assert.match(ownerPrompt, /我叫小D，是主人的助手。/)
		assert.match(guestPrompt, /我叫小D，是主人的助手。/)
		// …but his private life — memory, rules, diary — stays in the owner's session.
		assert.match(ownerPrompt, /他在把 DSH 接进 QQ。/)
		assert.match(ownerPrompt, /今天他有点累。/)
		assert.ok(!guestPrompt.includes('他在把 DSH 接进 QQ。'), 'non-owner prompt carries no MEMORY.md content')
		assert.ok(!guestPrompt.includes('今天他有点累。'), 'non-owner prompt carries no diary content')
		assert.ok(!guestPrompt.includes('## 长期记忆'), 'the memory block is dropped for a non-owner')
		assert.ok(!guestPrompt.includes('## 最近的日记'), 'the diary block is dropped for a non-owner')
		assert.ok(!guestPrompt.includes('## 他给你立的规矩'), 'the rules block is dropped for a non-owner')
		// …only the owner is told where the diary lives and how to append to it.
		assert.ok(ownerPrompt.includes(diaryFile), 'owner prompt carries the absolute diary path')
		assert.match(ownerPrompt, /追加/)
		assert.match(ownerPrompt, /不要重写/)
		assert.ok(!guestPrompt.includes(diaryFile), 'non-owner prompt carries no diary path')
		assert.ok(!guestPrompt.includes(join(dir, 'diary')), 'non-owner prompt carries no diary directory')
		assert.ok(!/追加|写文件|文件工具|write/i.test(guestPrompt), 'non-owner prompt carries no write instruction')
		assert.ok(!guestPrompt.includes('## 日记'), 'the diary section is empty for a non-owner')
		assert.equal(sectionOf(guestAssembly, DIARY_SECTION).text, '')
		// The persona section is the one that entered the system prompt.
		const ownerSection = sectionOf(ownerAssembly, PERSONA_SECTION)
		assert.equal(ownerSection.interpolate, false)
		assert.ok(ownerPrompt.indexOf(ownerSection.text) >= 0, 'the persona section is literally present in the prompt')
		assert.ok(ownerPrompt.indexOf(ownerSection.text) < ownerPrompt.indexOf(sectionOf(ownerAssembly, DIARY_SECTION).text), 'persona before the diary contract')

		console.log('[persona 3] owner prompt bytes =', Buffer.byteLength(ownerPrompt, 'utf8'), '| guest prompt bytes =', Buffer.byteLength(guestPrompt, 'utf8'))
		console.log('[persona 3] owner persona section =\n' + ownerSection.text)
		console.log('[persona 3] owner diary section =\n' + sectionOf(ownerAssembly, DIARY_SECTION).text)
		console.log('[persona 3] guest has diary path =', guestPrompt.includes(diaryFile), '| guest diary section =', JSON.stringify(sectionOf(guestAssembly, DIARY_SECTION).text))
	} finally {
		runtime.dispose()
		await new Promise((done) => setTimeout(done, 100))
		await stub.stop()
	}
})

test('persona 3b — a non-owner snapshot strips memory, rules and diary but still reports the files on disk', () => {
	const dir = makePersona({ persona: '# 小D\n\n我叫小D。\n', memory: '# 记忆\n\n- 他生日三月十四。\n', diary: { '2026-01-04': '今天他没睡好。\n' } })
	writeFileSync(join(dir, 'CORRECTIONS.md'), '- [2026-01-01] 别对外提我的真名\n')
	const persona = new QqPersona({ personaDir: dir })
	trackQqSession('qq-test-owner', true)
	trackQqSession('qq-test-guest', false)
	try {
		const owner = persona.snapshot(contextFor('qq-test-owner'))
		const guest = persona.snapshot(contextFor('qq-test-guest'))
		assert.match(owner.text, /他生日三月十四/)
		assert.match(owner.text, /别对外提我的真名/)
		assert.match(owner.text, /今天他没睡好/)
		assert.match(guest.text, /我叫小D/)
		assert.ok(!guest.text.includes('他生日三月十四'), 'no memory body for a guest')
		assert.ok(!guest.text.includes('别对外提我的真名'), 'no rules body for a guest')
		assert.ok(!guest.text.includes('今天他没睡好'), 'no diary body for a guest')
		// The metrics block is the layout on disk, so the once-per-layout boot line
		// does not flip back and forth as guests and the owner alternate.
		assert.equal(guest.metrics.memory.bytes, owner.metrics.memory.bytes)
		assert.equal(guest.metrics.days.length, owner.metrics.days.length)
		assert.ok(guest.totalBytes < owner.totalBytes, 'the guest block is the smaller one')
	} finally {
		untrackQqSession('qq-test-owner')
		untrackQqSession('qq-test-guest')
	}
})

test('persona 4 — the default persona directory comes from the module URL, not the cwd', () => {
	const expected = resolve(fileURLToPath(new URL('../..', import.meta.url)), 'persona')
	assert.equal(defaultPersonaDir(), expected)
	assert.ok(existsSync(join(expected, 'PERSONA.md')), 'the shipped persona is found from the package location')
	const moduleUrl = pathToFileURL(fileURLToPath(new URL('../lib/persona.js', import.meta.url))).href
	const elsewhere = execFileSync(
		process.execPath,
		['--input-type=module', '-e', `import { defaultPersonaDir } from ${JSON.stringify(moduleUrl)}; process.stdout.write(defaultPersonaDir())`],
		{ cwd: tmpdir(), encoding: 'utf8' },
	)
	assert.equal(elsewhere.trim(), expected, 'a child process started in another cwd resolves the same directory')
	console.log('[persona 4] defaultPersonaDir =', defaultPersonaDir(), '| child (cwd=tmpdir) =', elsewhere.trim())
})

test('persona 5 — the per-turn tool budget goes to the owner and stops there', async () => {
	const dir = makePersona({ persona: '# 小D\n\n我叫小D。\n' })
	const persona = new QqPersona({ personaDir: dir, log: () => {} })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)

	trackQqSession('qq-pace-owner', true)
	trackQqSession('qq-pace-guest', false)
	try {
		const owner = sectionOf(await prompt.assemble(contextFor('qq-pace-owner')), PACE_SECTION)
		assert.match(owner.text, /## 干活的节奏/)
		assert.match(owner.text, /工具调用控制在 8 次以内/)
		// 一步一次模型往返，平均 5 秒；并行的几件事必须写在同一句话里才省得下来。
		assert.match(owner.text, /同一条消息里一起发出去/)
		assert.match(owner.text, /60 秒还没结论/)
		// 早发那条路要有话可发：先撂一句再动手，25 秒时这句就会先出去。
		assert.match(owner.text, /先撂一句「我去弄，稍等」再开始/)

		// 访客没有工具，这段节奏对他只是噪声：一个字都不给。
		const guest = sectionOf(await prompt.assemble(contextFor('qq-pace-guest')), PACE_SECTION)
		assert.equal(guest?.text ?? '', '')

		// 不是 QQ 会话（比如夜班自己的回合）同样不注入。
		assert.equal(persona.paceText({ agent: { session: { id: 'some-other-turn' } } }), '')
		console.log('[persona 5] owner pace bytes =', Buffer.byteLength(owner.text, 'utf8'))
	} finally {
		untrackQqSession('qq-pace-owner')
		untrackQqSession('qq-pace-guest')
		detach()
	}
})

test('persona 6 — two memories that say the same sentence reach the prompt once, and the file keeps both', async () => {
	// 检索多样性：同一件事写了两行时，提示词里只要一行——另一行还留在文件里，
	// recall 翻得到，只是不占她已经很紧张的注意力预算。
	const memory = [
		'# 记忆',
		'',
		'- [w:4][k:event] 他想在海边住一间有阳台的屋子，下午能晒到太阳。',
		'- [w:4][k:event] 他想在海边住一间有阳台的屋子，下午晒太阳。',
		'- [w:4][k:event] 他养了一盆薄荷，浇多了会烂根。',
		'',
	].join('\n')
	const dir = makePersona({ persona: '# 小D\n\n我叫小D。\n', memory })
	const lines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: lines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-similar', true)
	try {
		const text = persona.personaText(contextFor('qq-similar'))
		assert.equal(text.split('有阳台的屋子').length - 1, 1, '同一句话只出现一次')
		assert.match(text, /薄荷/, '别的条目照旧')
		assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), memory, '文件一个字都没动')
		console.log('[persona 6] drops =', lines.warns().filter((line) => line.includes('repeat one already shown')).length, '| memory bytes =', Buffer.byteLength(text, 'utf8'))
	} finally {
		untrackQqSession('qq-similar')
		detach()
	}
})

test('persona 7 — a pile of ops notes cannot crowd her own life out of the prompt', async () => {
	// 分区预算：`ops` 是「这台机器怎么跑」的运维笔记，长得最稳也最没用。
	// 池子只有 3 KiB，满了这一次就不注入；她那几条 `event` 必须照旧进去。
	const WORDS = ['重启', '服务', '队列', '证书', '端口', '备份', '日志', '磁盘', '密钥', '代理', '定时', '同步', '限流', '重连', '握手', '编码', '转码', '索引', '分区', '快照', '熔断', '灰度', '回滚', '镜像', '挂载', '时钟', '内存', '带宽', '指纹', '种子']
	const ops = []
	for (let index = 0; index < 40; index += 1) {
		const first = WORDS[index % WORDS.length]
		const second = WORDS[(index * 3 + 7) % WORDS.length]
		const third = WORDS[(index * 7 + 11) % WORDS.length]
		ops.push(`- [w:3][k:ops] 运维笔记：${first}和${second}的${third}怎么配，出问题先看${second}再动${first}，改完记得复核${third}。`)
	}
	const pinnedOps = '- [w:5][k:ops] 钉住的运维条目：这台机器怎么跑，她要一直记得。'
	const memory = ['# 记忆', '', '- [w:4][k:event] 她在岛上有一座塔，塔顶能看见整片麦田。', ...ops, pinnedOps, '- [w:4][k:note] 索引：怎么用 grep 翻旧账。', ''].join('\n')
	const dir = makePersona({ persona: '# 小D\n\n我叫小D。\n', memory })
	const lines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: lines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-pool', true)
	try {
		const text = persona.personaText(contextFor('qq-pool'))
		assert.match(text, /她在岛上有一座塔/, '她的生活照旧进提示词')
		assert.match(text, /钉住的运维条目/, '钉住的条目不受池子限制')
		const opsLines = text.split('\n').filter((line) => line.includes('[k:ops]'))
		const opsBytes = opsLines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0)
		assert.ok(opsBytes <= LIMITS.opsMemoryBytes + 200, `ops 注入 ${opsBytes} 应受 ${LIMITS.opsMemoryBytes} 约束`)
		assert.ok(opsLines.length < ops.length + 1, `池子之外的不该全进来：${opsLines.length} / ${ops.length}`)
		assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), memory, '文件一个字都没动')
		assert.ok(lines.warns().some((line) => line.includes('over their pool')), '省下来的要说一声')
		console.log('[persona 7] ops lines =', opsLines.length, '/', ops.length + 1, '| ops bytes =', opsBytes, '|', lines.warns().find((line) => line.includes('over their pool')))
	} finally {
		untrackQqSession('qq-pool')
		detach()
	}
})

test('persona 8 — an oversized memory block says out loud what fell out of the window', async () => {
	// 30 条各 300 字节，远超 8 KiB 的记忆窗口：最旧的被挤出提示词，但文件一个字不动。
	const items = []
	for (let index = 1; index <= 30; index += 1) {
		const word = String.fromCharCode(0x4e00 + index * 7)
		items.push(`- [w:3][k:event] 第 ${index} 件事：${word.repeat(90)}`)
	}
	const memoryOnDisk = `# 记忆\n\n${items.join('\n')}\n`
	const dir = makePersona({ persona: '# 小D\n', memory: memoryOnDisk })
	const lines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: lines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-overflow', true)
	try {
		const text = persona.personaText(contextFor('qq-overflow'))
		assert.ok(text.includes('第 30 件事'), '最新那条留在窗口里')
		assert.ok(!text.includes('第 1 件事：'), '最旧的被挤出窗口')
		const warn = lines.warns().find((line) => line.includes('fell out of the 8 KiB window'))
		assert.ok(warn !== undefined, '挤出去几条要写进日志')
		assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), memoryOnDisk, '文件一条都没少')
		console.log('[persona 8]', warn)
	} finally {
		untrackQqSession('qq-overflow')
		detach()
	}
})

test('persona 8b — a memory block that fits never complains', async () => {
	const memory = '# 记忆\n\n- [w:3][k:event] 很短的一条。\n'
	const dir = makePersona({ persona: '# 小D\n', memory })
	const lines = recorder()
	const persona = new QqPersona({ personaDir: dir, log: lines.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-fit', true)
	try {
		persona.personaText(contextFor('qq-fit'))
		assert.deepEqual(lines.warns().filter((line) => line.includes('fell out of')), [], '没超窗口就不要喊')
	} finally {
		untrackQqSession('qq-fit')
		detach()
	}
})
test('persona 8c — when memory overflows, who she is and the rules stay in the window', async () => {
	// 记忆窗口不够时先丢普通条目：identity / rule 哪怕写在最上面（最旧）也不能被切掉。
	const lines = ['# 记忆', '', '- [w:5][k:identity] 我叫小D，住在海边。', '- [w:5][k:rule] 别叫他「用户」，叫他主人。']
	for (let index = 1; index <= 30; index += 1) {
		const word = String.fromCharCode(0x4e00 + index * 5)
		lines.push(`- [w:3][k:event] 流水账 ${index}：${word.repeat(90)}`)
	}
	const memory = `${lines.join('\n')}\n`
	const dir = makePersona({ persona: '# 小D\n', memory })
	const rec = recorder()
	const persona = new QqPersona({ personaDir: dir, log: rec.log })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-pinned', true)
	try {
		const text = persona.personaText(contextFor('qq-pinned'))
		assert.ok(text.includes('我叫小D，住在海边。'), 'identity 那行必须在')
		assert.ok(text.includes('别叫他「用户」，叫他主人。'), '规矩那行必须在')
		assert.ok(text.includes('流水账 30'), '最新的普通条目也在')
		assert.ok(!text.includes('流水账 1：'), '最旧的普通条目被让出去了')
		assert.equal(readFileSync(join(dir, 'MEMORY.md'), 'utf8'), memory, '文件一个字都没动')
	} finally {
		untrackQqSession('qq-pinned')
		detach()
	}
})
