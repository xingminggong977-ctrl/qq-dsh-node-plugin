/**
 * Her own QQ-Zone posts: the log reader, the fragment renderer, and the
 * `qq:qzone-notes` section it feeds.
 *
 * The log is appended by the cloud box, so most cases are about surviving its
 * bad input — a missing file, a half-written line, an impossible date. The
 * window and the two character caps are measured against one fixed moment, so
 * nothing here depends on the wall clock; only the wiring case uses "now",
 * because the persona section does too.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

import { FakeSystemPrompt } from './fake-runtime.js'
import {
	PERSONA_SECTION,
	QZONE_NOTES_ORDER,
	QZONE_NOTES_SECTION,
	QqPersona,
	WORLD_LIFE_ORDER,
	WORLD_LIFE_SECTION,
	trackQqSession,
	untrackQqSession,
} from '../lib/persona.js'
import { QZONE_LOG_FILE, QZONE_NOTE_LIMITS, defaultQzoneLogFile, readQzoneNotes, renderQzoneNotes } from '../lib/qzone-notes.js'
import { renderWorldLife } from '../lib/world-life.js'

const SANDBOX = mkdtempSync(join(tmpdir(), 'qq-qzone-notes-'))
after(() => rmSync(SANDBOX, { recursive: true, force: true }))

/** One fixed moment, so every window and every spoken time word is decided. */
const NOW = Date.parse('2026-10-29T13:00:00.000Z')
const minutesAgo = (minutes) => NOW - minutes * 60_000
const HEADER = '# 她发过的说说（最近 20 条）'
const LABEL = '最近发过的说说（新的在前）：'
const GUIDE = '被问到就用自己的话复述'
const QQ_ID = 'qq-zq-1'

const pad2 = (value) => String(value).padStart(2, '0')
/** The cloud writes local wall clock (`YYYY-MM-DD HH:MM`), so the fixture does too. */
const stamp = (ms) => {
	const at = new Date(ms)
	return `${at.getFullYear()}-${pad2(at.getMonth() + 1)}-${pad2(at.getDate())} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
}
const note = (ms, text) => `- ${stamp(ms)}｜${text}`

let logCount = 0
/** Write one throwaway log; `lines` go to disk verbatim, blanks included. */
function log(lines) {
	logCount += 1
	const file = join(SANDBOX, `qzone-${logCount}.md`)
	writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
	return file
}

const contextFor = (sessionId) => ({ agent: { id: sessionId, session: { id: sessionId } } })
/** The QQ entry only exists once the session registry holds it. */
function qqContext(sessionId = QQ_ID) {
	trackQqSession(sessionId, true)
	return contextFor(sessionId)
}
const bodyLines = (text) => text.split('\n').slice(1)

test('qzone-notes 1 — 缺文件、空文件、目录、坏行都返回空串，一个都不抛', () => {
	const qq = qqContext()
	assert.equal(renderQzoneNotes(qq, { file: join(SANDBOX, 'nowhere.md'), now: NOW }), '')
	assert.equal(renderQzoneNotes(qq, { file: log([]), now: NOW }), '')
	assert.deepEqual(readQzoneNotes(join(SANDBOX, 'nowhere.md'), { now: NOW }), [])
	assert.equal(renderQzoneNotes(qq, { file: SANDBOX, now: NOW }), '')
	const garbage = log([
		HEADER,
		'',
		'{"ts":',
		'- 不是时间｜随便',
		'- 2026-02-30 10:00｜二月没有三十号',
		'- 2026-10-29 10:00｜',
		'只有散文，没有正文',
	])
	assert.equal(renderQzoneNotes(qq, { file: garbage, now: NOW }), '', '一条可用的都没有')
	// 参数坏死也不能炸：抛出去就进提示词链路了。
	assert.equal(renderQzoneNotes(qq, { file: log([note(minutesAgo(1), '刚发的')]), now: 'not-a-date' }), '')
	// 路径优先级：环境变量在前，缺省是云端那一份。
	const saved = process.env.QZONE_LOG_FILE
	try {
		process.env.QZONE_LOG_FILE = '  C:/tmp/qzone.md  '
		assert.equal(defaultQzoneLogFile(), 'C:/tmp/qzone.md')
		delete process.env.QZONE_LOG_FILE
		assert.equal(defaultQzoneLogFile(), QZONE_LOG_FILE)
		assert.equal(QZONE_LOG_FILE, '/opt/whale-craft/qzone-log.md')
	} finally {
		if (saved === undefined) delete process.env.QZONE_LOG_FILE
		else process.env.QZONE_LOG_FILE = saved
	}
	console.log('[qzone-notes 1] missing/empty/dir/garbage = "" | default =', QZONE_LOG_FILE)
})

test('qzone-notes 2 — 只看 72 小时内，最多 5 条，新的在前，时间说成人话', () => {
	const qq = qqContext()
	// 5 分钟、1 小时、5 小时、20 小时、40 小时、70 小时在内；83 小时在外。
	const ages = [5, 60, 300, 1200, 2400, 4200, 5000]
	const file = log([HEADER, '', ...ages.map((age, index) => note(minutesAgo(age), `第${index + 1}条说说`))])
	assert.equal(readQzoneNotes(file, { now: NOW }).length, 6, '72 小时窗口挡掉 83 小时前那条')

	const text = renderQzoneNotes(qq, { file, now: NOW })
	const lines = bodyLines(text)
	assert.equal(lines.length, QZONE_NOTE_LIMITS.maxNotes, `只留最近 5 条：\n${text}`)
	assert.equal(lines[0], '- 刚刚｜第1条说说', '十分钟内的说「刚刚」')
	assert.ok(!text.includes('第6条说说'), `第 6 条让位给更新的：${text}`)
	assert.ok(!text.includes('第7条说说'))
	for (const token of ['ts', 'JSON', '{', '":']) assert.ok(!text.includes(token), `不该出现 ${token}`)
	assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), '不出现 ISO 时间')
	assert.match(lines[1], /^- (今天|昨天) \d{2}:\d{2}｜第2条说说$/)
	console.log('[qzone-notes 2] rendered =\n' + text)
})

test('qzone-notes 3 — 单条截断到 120 字，省略号也算在里面', () => {
	const qq = qqContext()
	const long = '今天风很大'.repeat(40)
	const file = log([HEADER, '', note(minutesAgo(30), long), note(minutesAgo(40), '短的这条')])
	const text = renderQzoneNotes(qq, { file, now: NOW })
	const lines = bodyLines(text)
	assert.equal(lines.length, 2)
	const clipped = lines[0].slice(lines[0].indexOf('｜') + 1)
	assert.equal(clipped.length, QZONE_NOTE_LIMITS.maxNoteChars, `单条 ${clipped.length} 字`)
	assert.ok(clipped.endsWith('…'), '截断留标记')
	assert.ok(!text.includes(long), '原文那 200 字没有整段进来')
	assert.match(lines[1], /｜短的这条$/)
	console.log('[qzone-notes 3] clipped =', clipped.length, '| tail =', clipped.slice(-8))
})

test('qzone-notes 4 — 整段 ≤ 420 字：先丢最旧的整条，只剩一条时再截断', () => {
	const qq = qqContext()
	const tail = '啊'.repeat(116)
	const lines = [HEADER, '']
	for (let index = 1; index <= 5; index += 1) lines.push(note(minutesAgo(30 * index), `记号${index}${tail}`))
	const text = renderQzoneNotes(qq, { file: log(lines), now: NOW })
	assert.ok(text.length <= QZONE_NOTE_LIMITS.maxChars, `长度 ${text.length} <= 420`)
	const kept = bodyLines(text)
	assert.ok(kept.length >= 1 && kept.length < 5, `丢掉整条，不是把每条都砍短：${kept.length} 条`)
	for (const line of kept) assert.match(line, /啊$/, '留下的每条都完整')
	assert.match(text, /记号1/, '最新那条一定在')
	assert.ok(!text.includes('记号5'), `最旧的先丢：${text.slice(0, 40)}…`)

	// 上限压到 60 字，最近一条自己也放不下，这时才动单条截断。
	const tight = renderQzoneNotes(qq, { file: log([note(minutesAgo(30), `记号1${tail}`)]), now: NOW, maxChars: 60 })
	assert.ok(tight.length <= 60, `长度 ${tight.length} <= 60`)
	assert.ok(tight.startsWith(`${LABEL}\n- `), `还留着标签和那一条：${tight}`)
	assert.match(tight, /｜[^｜]*…$/, '正文按需截短')
	console.log('[qzone-notes 4] length =', text.length, '| kept =', kept.length, '| tight =', JSON.stringify(tight))
})

/** One throwaway persona directory: the shipped one belongs to the operator. */
function makePersona() {
	const dir = mkdtempSync(join(SANDBOX, 'p-'))
	mkdirSync(join(dir, 'diary'), { recursive: true })
	writeFileSync(join(dir, 'PERSONA.md'), '# 小D\n\n我叫小D，是主人的助手。\n')
	writeFileSync(join(dir, 'MEMORY.md'), '# 记忆\n\n- 他在把 DSH 接进 QQ。\n')
	return dir
}

const sectionOf = (assembly, name) => assembly.sections.find((section) => section.name === name)

test('qzone-notes 5 — 非 QQ 会话一个字都没有；QQ 里排在「她的世界」之后，前三段原样不动', async () => {
	// 这一段跑在「此刻」，和真实运行时一致。
	const recentNow = Date.now()
	const recent = (minutes) => recentNow - minutes * 60_000
	const dir = makePersona()
	const worldFeed = join(SANDBOX, 'life-feed.jsonl')
	writeFileSync(worldFeed, `${JSON.stringify({ ts: new Date(recent(5)).toISOString(), kind: 'build', text: '盖好了小屋' })}\n`)
	const loud = log([HEADER, '', note(recent(4), '今天风很大，想起了他'), note(recent(90), '夜里把窗户开着'), note(recent(200), '他今天没怎么说话')])
	const expectedWorld = renderWorldLife({ file: worldFeed, now: recentNow })

	const persona = new QqPersona({ personaDir: dir, worldLifeFile: worldFeed, qzoneLogFile: loud, log: () => {} })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	const qq = qqContext('qq-zq-2')
	const assembly = await prompt.assemble(qq)

	const names = assembly.sections.map((entry) => entry.name)
	assert.ok(names.indexOf(WORLD_LIFE_SECTION) > names.indexOf(PERSONA_SECTION), '人设在前')
	assert.ok(names.indexOf(QZONE_NOTES_SECTION) > names.indexOf(WORLD_LIFE_SECTION), '说说排在「她的世界」之后')
	assert.equal(names.at(-1), QZONE_NOTES_SECTION, '挂在最后一段')

	const section = sectionOf(assembly, QZONE_NOTES_SECTION)
	const world = sectionOf(assembly, WORLD_LIFE_SECTION)
	assert.equal(section.text.split('\n')[0], '## 我发过的说说')
	assert.match(section.text, new RegExp(GUIDE), '告诉她被问到就复述')
	assert.match(section.text, /不要主动逐条播报/, '平时不逐条播报')
	assert.equal(bodyLines(section.text.split('\n\n').at(-1)).length, 3, `三条说说都进来了：\n${section.text}`)
	assert.match(section.text, /今天风很大，想起了他/)
	// 「她的世界」还是原来那段，一个字都没被这一节带动。
	assert.equal(world.text.split('\n')[0], '## 她的世界')
	assert.equal(world.text.endsWith(expectedWorld), true, `她的世界没被改：\n${world.text}`)

	const rendered = renderPrompt(assembly)
	assert.match(rendered, /## 我发过的说说/)
	assert.match(rendered, /我叫小D，是主人的助手。/, '人设照旧')
	assert.match(rendered, /## 最近的日记|## 长期记忆/, '记忆照旧')
	console.log('[qzone-notes 5] section =\n' + section.text)
	console.log('[qzone-notes 5] prompt tail =\n' + rendered.slice(rendered.indexOf('## 我发过的说说')))

	// 不是 QQ 会话：一个字都不注入。
	untrackQqSession('qq-zq-2')
	assert.equal(renderQzoneNotes(contextFor('qq-elsewhere'), { file: loud }), '')
	assert.equal(persona.qzoneNotesText(contextFor('qq-elsewhere')), '')

	// 日志没了 / 写坏了：整节消失，人设一个字不掉。
	for (const [label, file] of [['缺文件', join(SANDBOX, 'nowhere.md')], ['空文件', log([])]]) {
		const silent = new QqPersona({ personaDir: dir, worldLifeFile: worldFeed, qzoneLogFile: file, log: () => {} })
		const silentPrompt = new FakeSystemPrompt()
		silent.attach(silentPrompt)
		const quietRendered = renderPrompt(await silentPrompt.assemble(qqContext('qq-zq-3')))
		assert.ok(!quietRendered.includes('我发过的说说'), `${label}: 不留空标题`)
		assert.match(quietRendered, /我叫小D，是主人的助手。/, `${label}: 人设照旧`)
		assert.match(quietRendered, /他在把 DSH 接进 QQ。/, `${label}: 记忆照旧`)
		assert.match(quietRendered, /## 她的世界/, `${label}: 世界那节照旧`)
		untrackQqSession('qq-zq-3')
		console.log(`[qzone-notes 5] ${label}: heading in prompt = ${quietRendered.includes('我发过的说说')} | persona kept = true`)
	}

	detach()
	assert.equal(prompt.sections.size, 0)
	assert.ok(QZONE_NOTES_ORDER > WORLD_LIFE_ORDER && QZONE_NOTES_ORDER < 500)
})

test('qzone-notes 6 — 指到 JSONL 那版日志时也读得懂，坏行只丢自己', () => {
	const qq = qqContext()
	const file = join(SANDBOX, 'qzone-log.jsonl')
	writeFileSync(
		file,
		[
			'{"ts":',
			JSON.stringify({ ts: new Date(minutesAgo(5)).toISOString(), tid: 'ff86d9d8', text: '  今天风很大  ' }),
			JSON.stringify({ ts: new Date(minutesAgo(50)).toISOString(), text: '   ' }),
			JSON.stringify({ ts: '不是时间', text: '不该出现' }),
			JSON.stringify({ ts: new Date(minutesAgo(60)).toISOString(), text: '夜里\n把窗开着' }),
			'',
		].join('\n'),
	)
	const text = renderQzoneNotes(qq, { file, now: NOW })
	const lines = bodyLines(text)
	assert.equal(lines.length, 2, `两条可用：\n${text}`)
	assert.equal(lines[0], '- 刚刚｜今天风很大', '两侧空白被吃掉')
	assert.match(lines[1], /｜夜里 把窗开着$/, '换行压成一行，列表不被打断')
	assert.ok(!text.includes('不该出现'))
	console.log('[qzone-notes 6] rendered =', JSON.stringify(text))
})
