/**
 * Her own Minecraft days: the feed reader, the fragment renderer, and the
 * `qq:world-life` section it feeds.
 *
 * The feed is written by another machine, so most of these cases are about
 * surviving its bad input: a missing file, a half-written last line, an event
 * from three days ago. The prompt side is checked with the real `renderPrompt`,
 * because "empty means the section disappears" is a renderer contract, not
 * something a `text()` function can prove on its own.
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { after } from 'node:test'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'

import { FakeSystemPrompt } from './fake-runtime.js'
import { PERSONA_SECTION, QqPersona, WORLD_LIFE_ORDER, WORLD_LIFE_SECTION, trackQqSession, untrackQqSession } from '../lib/persona.js'
import { readWorldLife, renderWorldLife, WORLD_LIFE_LIMITS } from '../lib/world-life.js'

const SANDBOX = mkdtempSync(join(tmpdir(), 'qq-world-life-'))
after(() => rmSync(SANDBOX, { recursive: true, force: true }))

/** One fixed moment, so every window and every spoken time word is decided. */
const NOW = Date.parse('2026-10-28T13:00:00.000Z')
const minutesAgo = (minutes) => new Date(NOW - minutes * 60_000).toISOString()
/** Local midnight of NOW: the boundary 「今天」 is measured from. */
const MIDNIGHT = (() => {
	const now = new Date(NOW)
	return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
})()
const hoursAfterMidnight = (hours) => new Date(MIDNIGHT + hours * 3_600_000).toISOString()
const hoursBeforeMidnight = (hours) => new Date(MIDNIGHT - hours * 3_600_000).toISOString()

let feedCount = 0
/** Write one throwaway feed; `lines` go to disk verbatim, blanks included. */
function feed(lines) {
	feedCount += 1
	const file = join(SANDBOX, `feed-${feedCount}.jsonl`)
	writeFileSync(file, lines.length === 0 ? '' : `${lines.join('\n')}\n`)
	return file
}
const event = (ts, kind, text) => JSON.stringify({ ts, kind, text })
const notable = (ts, kind, text) => JSON.stringify({ ts, kind, text, notable: true })

const LABEL = '她自己的世界（Minecraft）：'
const clausesOf = (text) => text.slice(LABEL.length).replace(/。$/, '').split('；')

test('world-life 1 — 缺文件、空文件、目录都返回空串，一个都不抛', () => {
	assert.equal(renderWorldLife({ file: join(SANDBOX, 'nowhere.jsonl'), now: NOW }), '')
	assert.equal(renderWorldLife({ file: feed([]), now: NOW }), '')
	assert.deepEqual(readWorldLife(join(SANDBOX, 'nowhere.jsonl'), { now: NOW }), [])
	assert.equal(renderWorldLife({ file: SANDBOX, now: NOW }), '')
	// 参数坏死也不能炸：抛出去就进提示词链路了。
	assert.equal(renderWorldLife({ file: feed([event(minutesAgo(1), 'build', '修了屋顶')]), now: 'not-a-date' }), '')
	console.log('[world-life 1] missing/empty/dir/bad-now = ""')
})

test('world-life 2 — 空行、坏行、半行、未知 kind、空 text 逐行跳过，好的那条还在', () => {
	const file = feed([
		'',
		'{"ts":',
		event(hoursAfterMidnight(8), 'build', '把院墙补好了'),
		'{"ts":"2026-10-28T10:00:00.000Z","kind":"teleport","text":"去了末地"}',
		event(hoursAfterMidnight(9), 'build', '   '),
		'{"ts":"不是时间","kind":"build","text":"不该出现"}',
		'{"ts":"2026-10-28T11:00:00.000Z","kind":"build","text":"这一行被写了一半',
		'[]',
	])
	const events = readWorldLife(file, { now: NOW })
	assert.equal(events.length, 1, `一条可用事件，实际 ${JSON.stringify(events)}`)
	assert.equal(events[0].text, '把院墙补好了')
	const text = renderWorldLife({ file, now: NOW })
	assert.match(text, /把院墙补好了/)
	assert.ok(!text.includes('末地'), '未知 kind 不猜着渲染')
	assert.ok(!text.includes('不该出现'))
	console.log('[world-life 2] kept =', events.length, '| rendered =', text)
})

test('world-life 3 — 只看 48 小时，时间说成「刚刚 / 今天 21:40 / 昨天」', () => {
	const file = feed([
		event(new Date(NOW - 49 * 3_600_000).toISOString(), 'build', '前天就该过期的房子'),
		event(hoursBeforeMidnight(25), 'explore', '往北走了两千格'),
		event(hoursBeforeMidnight(13), 'build', '盖了一间小屋'),
		event(hoursAfterMidnight(1), 'first', '做出了石剑'),
		event(minutesAgo(4), 'companion', '有只猫跟着回了家'),
	])
	const events = readWorldLife(file, { now: NOW })
	assert.equal(events.length, 4, '49 小时前的那条被窗口挡掉')
	const text = renderWorldLife({ file, now: NOW })
	assert.ok(!text.includes('过期'), text)
	assert.match(text, /刚刚有只猫跟着回了家/)
	assert.match(text, /今天 01:00 第一次做出了石剑/)
	assert.match(text, /昨天 11:00 盖了一间小屋/)
	assert.match(text, /前天 23:00 往北走了两千格/)
	assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(text), '不出现 ISO 时间')
	console.log('[world-life 3] rendered =', text)
})

test('world-life 4 — thought 只取最后 1 条，用「心里想」说出来', () => {
	const file = feed([
		event(minutesAgo(300), 'thought', '旧的心里话'),
		event(minutesAgo(200), 'build', '盖了鸡窝'),
		event(minutesAgo(30), 'thought', '今天有点想他'),
	])
	const text = renderWorldLife({ file, now: NOW })
	assert.equal((text.match(/心里想/g) ?? []).length, 1, `只留一条心里话：${text}`)
	assert.match(text, /心里想：今天有点想他/)
	assert.ok(!text.includes('旧的心里话'))
	assert.match(text, /盖了鸡窝/)
	console.log('[world-life 4] rendered =', text)
})

test('world-life 5 — 其余事件倒序最多 6 条，更早的整条不进提示词', () => {
	const lines = []
	for (let index = 1; index <= 10; index += 1) lines.push(event(minutesAgo(60 * index), 'build', `第${index}件`))
	const text = renderWorldLife({ file: feed(lines), now: NOW })
	const clauses = clausesOf(text)
	assert.equal(clauses.length, WORLD_LIFE_LIMITS.maxEvents, `6 条，实际 ${clauses.length}`)
	assert.ok(!text.includes('第7件'), `第 7 件太旧：${text}`)
	assert.match(text, /第6件/)
	assert.equal(clauses[0].endsWith('第1件'), true, '最新的排在最前')
	console.log('[world-life 5] clauses =', JSON.stringify(clauses))
})

test('world-life 6 — notable 的旧事优先占名额，总数仍是 6', () => {
	const lines = [notable(minutesAgo(900), 'build', '值得记住的第一间屋子')]
	for (let index = 1; index <= 9; index += 1) lines.push(event(minutesAgo(60 * index), 'build', `第${index}件`))
	const text = renderWorldLife({ file: feed(lines), now: NOW })
	const clauses = clausesOf(text)
	assert.equal(clauses.length, 6)
	assert.match(text, /值得记住的第一间屋子/)
	assert.match(text, /第1件/, '更新的普通事照样进')
	assert.ok(!text.includes('第6件'), `名额紧时最旧的普通事让位：${text}`)
	console.log('[world-life 6] rendered =', text)
})

test('world-life 7 — 400 字符硬上限按条丢弃，不会留下半句话', () => {
	const tail = 'x'.repeat(160)
	const lines = []
	for (let index = 1; index <= 7; index += 1) lines.push(event(minutesAgo(30 * index), 'build', `记号${index}${tail}`))
	const text = renderWorldLife({ file: feed(lines), now: NOW })
	assert.ok(text.length <= WORLD_LIFE_LIMITS.maxChars, `长度 ${text.length} <= 400`)
	const clauses = clausesOf(text)
	assert.ok(clauses.length >= 1 && clauses.length < 7, `丢掉整条，不是截断：${clauses.length} 条`)
	for (const clause of clauses) assert.match(clause, new RegExp(`${tail}$`), '每条都是完整的')
	assert.match(text, /记号1/, '最新的那条留下来了')
	console.log('[world-life 7] length =', text.length, '| clauses =', clauses.length, '| head =', text.slice(0, 40) + '…')
})

test('world-life 8 — 渲染文本里没有 JSON 字段名，也没有原样的时间戳', () => {
	const file = feed([
		notable(hoursAfterMidnight(2), 'build', '盖好了 7x7x4 的慢屋，坐标 (-185,67,73)'),
		event(hoursAfterMidnight(4), 'first', '做出了石剑'),
		event(hoursAfterMidnight(3), 'death', '被僵尸围住，身上的东西掉在原地'),
	])
	const text = renderWorldLife({ file, now: NOW })
	for (const token of ['kind', 'notable', 'text', '{', '}', '":', 'kind=', 'JSON']) {
		assert.ok(!text.includes(token), `不该出现 ${token}：${text}`)
	}
	assert.match(text, /^她自己的世界（Minecraft）：/)
	assert.match(text, /第一次做出了石剑/)
	assert.match(text, /死了一次，被僵尸围住/)
	console.log('[world-life 8] rendered =', text)
})

/** One throwaway persona directory: the shipped one belongs to the operator. */
function makePersona() {
	const dir = mkdtempSync(join(SANDBOX, 'p-'))
	mkdirSync(join(dir, 'diary'), { recursive: true })
	writeFileSync(join(dir, 'PERSONA.md'), '# 小D\n\n我叫小D，是主人的助手。\n')
	writeFileSync(join(dir, 'MEMORY.md'), '# 记忆\n\n- 他在把 DSH 接进 QQ。\n')
	return dir
}

const contextFor = (sessionId) => ({ agent: { id: sessionId, session: { id: sessionId } } })
const sectionOf = (assembly, name) => assembly.sections.find((section) => section.name === name)

test('world-life 9 — 注入后快照里多出这一节；喂空或喂缺文件时整节不出现', async () => {
	// 这一段的时间基准是「此刻」，和真实运行时一致；`now` 钉死后渲染可复现。
	const recentNow = Date.now()
	const recent = (minutes) => new Date(recentNow - minutes * 60_000).toISOString()
	const dir = makePersona()
	const loud = feed([
		notable(recent(3), 'build', '盖好了 7x7x4 的慢屋，坐标 (-185,67,73)'),
		notable(recent(90), 'first', '做出了石剑'),
		event(recent(120), 'thought', '今天有点想他'),
		event(recent(150), 'death', '被僵尸围住，身上的东西掉在原地'),
		'{"ts":"2026-10-28T12:30:00.000Z","kind":"build","text":"这一行被写了一半',
	])
	const quiet = feed([])
	const expected = renderWorldLife({ file: loud, now: recentNow })

	const persona = new QqPersona({ personaDir: dir, worldLifeFile: loud, log: () => {} })
	const prompt = new FakeSystemPrompt()
	const detach = persona.attach(prompt)
	trackQqSession('qq-world-1', true)
	const assembly = await prompt.assemble(contextFor('qq-world-1'))
	const section = sectionOf(assembly, WORLD_LIFE_SECTION)
	const names = assembly.sections.map((entry) => entry.name)
	assert.ok(names.indexOf(WORLD_LIFE_SECTION) > names.indexOf(PERSONA_SECTION), '人设在前，她的日子在后')
	assert.equal(section.text.split('\n')[0], '## 她的世界')
	assert.match(section.text, /这是你自己在世界里过日子的近况，可以自然提起，但别逐条汇报。/)
	assert.equal(section.text.endsWith(expected), true, `正文就是渲染出来的那一段：\n${section.text}`)
	const rendered = renderPrompt(assembly)
	assert.match(rendered, /## 她的世界/)
	assert.match(rendered, /她自己的世界（Minecraft）：/)
	console.log('[world-life 9] section =\n' + section.text)
	console.log('[world-life 9] prompt tail =\n' + rendered.slice(rendered.indexOf('## 她的世界')))

	// 不是 QQ 会话：一个字都不注入。
	untrackQqSession('qq-world-1')
	assert.equal(persona.worldLifeText(contextFor('qq-elsewhere')), '')

	for (const [label, file] of [['空文件', quiet], ['缺文件', join(SANDBOX, 'nowhere.jsonl')]]) {
		const silent = new QqPersona({ personaDir: dir, worldLifeFile: file, log: () => {} })
		const silentPrompt = new FakeSystemPrompt()
		silent.attach(silentPrompt)
		trackQqSession('qq-world-2', true)
		const quietAssembly = await silentPrompt.assemble(contextFor('qq-world-2'))
		const quietText = sectionOf(quietAssembly, WORLD_LIFE_SECTION).text
		const quietRendered = renderPrompt(quietAssembly)
		assert.equal(quietText, '', `${label}: 该小节完全为空`)
		assert.ok(!quietRendered.includes('她的世界'), `${label}: 不留空标题`)
		assert.ok(!quietRendered.includes('Minecraft'), `${label}: 不留正文`)
		assert.match(quietRendered, /我叫小D，是主人的助手。/, `${label}: 人设照旧`)
		assert.match(quietRendered, /他在把 DSH 接进 QQ。/, `${label}: 记忆照旧`)
		console.log(`[world-life 9] ${label}: section = ${JSON.stringify(quietText)} | heading in prompt = ${quietRendered.includes('她的世界')} | persona kept = ${quietRendered.includes('我叫小D，是主人的助手。')}`)
		untrackQqSession('qq-world-2')
	}

	detach()
	assert.equal(prompt.sections.size, 0)
	assert.ok(WORLD_LIFE_ORDER > 150 && WORLD_LIFE_ORDER < 500)
})
