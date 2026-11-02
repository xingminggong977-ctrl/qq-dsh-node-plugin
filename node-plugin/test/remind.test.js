import test from 'node:test'
import assert from 'node:assert/strict'
import { runInTaskScope } from '../lib/context.js'
import {
	REMIND_TOOL_NAME,
	RemindError,
	createRemindTool,
	humanWhen,
	parseNumber,
	parseWhen,
} from '../lib/remind.js'

const OWNER = { group: false, isOwner: true }
const MINUTE = 60 * 1000

/** 11 月 1 日 10:00（本地时区），测试里的「现在」。 */
const NOW = new Date(2026, 10, 1, 10, 0, 0, 0).getTime()

function local(month, day, hour, minute) {
	return new Date(2026, month - 1, day, hour, minute, 0, 0).getTime()
}

test('remind — 中文与阿拉伯数字都认', () => {
	assert.equal(parseNumber('19'), 19)
	assert.equal(parseNumber('07'), 7)
	assert.equal(parseNumber('零'), 0)
	assert.equal(parseNumber('七'), 7)
	assert.equal(parseNumber('十二'), 12)
	assert.equal(parseNumber('二十三'), 23)
	assert.ok(Number.isNaN(parseNumber('半')))
	assert.ok(Number.isNaN(parseNumber('')))
})

test('remind — 钟点：今天还没到就是今天，过了就是明天', () => {
	assert.equal(parseWhen('19:00', { now: NOW }), local(11, 1, 19, 0))
	assert.equal(parseWhen('今晚 21：30', { now: NOW }), local(11, 1, 21, 30))
	assert.equal(parseWhen('08:00', { now: NOW }), local(11, 2, 8, 0))
})

test('remind — 明天 / 后天 把日子挪过去，钟点照旧', () => {
	assert.equal(parseWhen('明天 08:30', { now: NOW }), local(11, 2, 8, 30))
	assert.equal(parseWhen('明天七点', { now: NOW }), local(11, 2, 7, 0))
	assert.equal(parseWhen('明晚八点半', { now: NOW }), local(11, 2, 20, 30))
	assert.equal(parseWhen('后天 19点30分', { now: NOW }), local(11, 3, 19, 30))
	assert.equal(parseWhen('tomorrow 9:00', { now: NOW }), local(11, 2, 9, 0))
})

test('remind — 「多少分钟后」直接加到当前时间', () => {
	assert.equal(parseWhen('20 分钟后', { now: NOW }), NOW + 20 * MINUTE)
	assert.equal(parseWhen('in 5 minutes', { now: NOW }), NOW + 5 * MINUTE)
	assert.equal(parseWhen('2 小时后', { now: NOW }), NOW + 120 * MINUTE)
})

test('remind — ISO 字符串原样相信', () => {
	const iso = '2026-11-02T19:00:00+08:00'
	assert.equal(parseWhen(iso, { now: NOW }), Date.parse(iso))
})

test('remind — 看不懂或已经过去的时间当场报错，绝不排一条不会响的闹钟', () => {
	for (const input of ['', '随便吧', '25:00', '19:61', '明天']) {
		assert.throws(
			() => parseWhen(input, { now: NOW }),
			(error) => error instanceof RemindError && error.code === 'bad-time',
			`应该拒绝：${JSON.stringify(input)}`,
		)
	}
	assert.throws(
		() => parseWhen('今天 05:00', { now: NOW }),
		(error) => error instanceof RemindError && error.code === 'past',
	)
})

test('remind — 回给她的人话带日期与钟点', () => {
	assert.equal(humanWhen(local(11, 2, 8, 5)), '11月2日 08:05')
})

test('remind — 拿不到桥接客户端就不注册', () => {
	assert.throws(() => createRemindTool({}), (error) => error.code === 'config')
	assert.throws(() => createRemindTool({ client: {} }), (error) => error.code === 'config')
})

test('remind tool — 排好了就把时间与那句话回给她', async () => {
	const asked = []
	const tool = createRemindTool({
		client: {
			async remind(payload) {
				asked.push(payload)
				return { ok: true, reminderId: 'r-1', at: payload.at }
			},
		},
		now: () => NOW,
	})

	const answer = await runInTaskScope(OWNER, () => tool.execute({ at: '明天 08:30', text: ' 该吃药了 ' }))

	assert.equal(tool.name, REMIND_TOOL_NAME)
	assert.deepEqual(asked, [{ at: local(11, 2, 8, 30), text: ' 该吃药了 ' }])
	assert.equal(answer, '排好了：11月2日 08:30，到点我会说「该吃药了」')
})

test('remind tool — 同一件事排第二遍，说的是「本来就定着了」而不是再排一条', async () => {
	const tool = createRemindTool({
		client: {
			async remind(payload) {
				return { ok: true, reminderId: 'r-1', at: payload.at, duplicate: true }
			},
		},
		now: () => NOW,
	})

	const answer = await runInTaskScope(OWNER, () => tool.execute({ at: '明天 19:00', text: '给爸爸打个电话' }))

	assert.match(answer, /本来就定着了/)
	assert.match(answer, /只会说一次/)
	assert.doesNotMatch(answer, /^排好了/)
})

test('remind tool — 桥接没排上就报错，不假装排上了', async () => {
	const tool = createRemindTool({
		client: { remind: async () => ({ ok: false, error: '太远了，我只能记一个月内的' }) },
		now: () => NOW,
	})

	await assert.rejects(
		runInTaskScope(OWNER, () => tool.execute({ at: '19:00', text: '叫我' })),
		(error) => error instanceof RemindError && error.code === 'bridge' && /太远/.test(error.message),
	)
})

test('remind tool — 只在主人的私聊里可用', async () => {
	const tool = createRemindTool({ client: { remind: async () => ({ ok: true, at: NOW + MINUTE }) } })

	await assert.rejects(tool.execute({ at: '19:00', text: '叫我' }), (error) => error.code === 'scope')
	await assert.rejects(
		runInTaskScope({ group: true, isOwner: true }, () => tool.execute({ at: '19:00', text: '群里说的' })),
		(error) => error.code === 'scope',
	)
})
