import { defineTool } from '@deepseek-ai/dsh-tools'
import { isPrivateOwnerTurn } from './context.js'

/** Name she sees in the tool list. */
export const REMIND_TOOL_NAME = 'remind'

export class RemindError extends Error {
	constructor(message, { code = 'failed' } = {}) {
		super(message)
		this.name = 'RemindError'
		this.code = code
	}
}

const MINUTE = 60 * 1000

/** 「明天」「后天」这类前缀只是往前挪几天，剩下的钟点照常解析。 */
const DAY_OFFSETS = new Map([
	['今天', 0],
	['今晚', 0],
	['晚上', 0],
	['tonight', 0],
	['today', 0],
	['明天', 1],
	['明早', 1],
	['明晚', 1],
	['tomorrow', 1],
	['后天', 2],
])

const DAY_PATTERN = [...DAY_OFFSETS.keys()].join('|')

const CN_DIGITS = new Map([
	['零', 0],
	['〇', 0],
	['一', 1],
	['二', 2],
	['两', 2],
	['三', 3],
	['四', 4],
	['五', 5],
	['六', 6],
	['七', 7],
	['八', 8],
	['九', 9],
])

/** 「19」「七」「十二」「二十三」→ 数字；看不懂给 NaN。 */
export function parseNumber(input) {
	const raw = String(input ?? '').trim()
	if (/^\d{1,2}$/u.test(raw)) return Number(raw)
	const tens = raw.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u)
	if (tens) return (tens[1] ? CN_DIGITS.get(tens[1]) : 1) * 10 + (tens[2] ? CN_DIGITS.get(tens[2]) : 0)
	const single = CN_DIGITS.get(raw)
	return single === undefined ? Number.NaN : single
}

/**
 * 把「七点叫我」翻译成时间戳。
 *
 * 她给的东西不会永远是 ISO 字符串：`19:00`、`明天七点`、`20 分钟后` 都会出现。
 * 解析不了的宁可当场报错，也不要排一条永远不会响的闹钟——那正是这次要修的病。
 */
export function parseWhen(input, { now = Date.now() } = {}) {
	const raw = String(input ?? '').trim()
	if (raw === '') throw new RemindError('没说什么时候', { code: 'bad-time' })

	const inMinutes = raw.match(/^(?:\+|in\s*)?(\d{1,4})\s*(?:分钟|min|minutes?)\s*(?:后|later|from now)?$/iu)
	if (inMinutes) return now + Number(inMinutes[1]) * MINUTE

	const inHours = raw.match(/^(\d{1,2})\s*(?:个)?(?:小时|h|hours?)\s*(?:后|later|from now)?$/iu)
	if (inHours) return now + Number(inHours[1]) * 60 * MINUTE

	const day = raw.match(new RegExp(`^(${DAY_PATTERN})\\s*`, 'iu'))
	const dayOffset = day ? DAY_OFFSETS.get(day[1].toLowerCase()) : null
	const rest = day ? raw.slice(day[0].length) : raw

	const CLOCK = '[0-9]{1,2}|[零〇一二两三四五六七八九十]{1,3}'
	const clock = rest.match(new RegExp(`^(${CLOCK})\\s*[:：点]\\s*(${CLOCK})?\\s*(分|半)?$`, 'u'))
	if (clock) {
		const evening = /[晚夜]|tonight|pm/iu.test(day ? day[0] : '')
		const hour = parseNumber(clock[1]) + (evening && parseNumber(clock[1]) < 12 ? 12 : 0)
		const minute = clock[3] === '半' ? 30 : parseNumber(clock[2] ?? '0')
		if (!(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) {
			throw new RemindError('这个点不存在', { code: 'bad-time' })
		}
		const when = new Date(now)
		when.setDate(when.getDate() + (dayOffset ?? 0))
		when.setHours(hour, minute, 0, 0)
		const at = when.getTime()
		if (at > now) return at
		// 没写哪一天时，过去的钟点指明天；写了「今天」还说过去的点，是算错了，别猜。
		if (dayOffset === null) return at + 24 * 60 * MINUTE
		throw new RemindError('这个点已经过去了', { code: 'past' })
	}

	const parsed = Date.parse(raw)
	if (Number.isFinite(parsed)) return parsed
	throw new RemindError(`时间看不懂：${raw}`, { code: 'bad-time' })
}

/** 「19:00」这种格式回给她，比一个时间戳更像人话。 */
export function humanWhen(at) {
	const when = new Date(at)
	const pad = (value) => String(value).padStart(2, '0')
	return `${when.getMonth() + 1}月${when.getDate()}日 ${pad(when.getHours())}:${pad(when.getMinutes())}`
}

const TOOL_DESCRIPTION = [
	'排一个到点就会响的提醒：到了那个时间，系统会主动把这件事发到主人的 QQ 上。',
	'适合：他让你几点叫他、该吃药了、约好的时间点、家务与日程。',
	'不适合：需要你临场说话的事（那用普通回复）、你自己的想法与心情。',
	'只在主人的私聊里可用，最多排一个月以内的时间。排了就一定会响，别口头答应却不排。',
].join('\n')

export function createRemindTool({ client, now = Date.now } = {}) {
	if (client === undefined || typeof client.remind !== 'function') {
		throw new RemindError('桥接客户端缺失', { code: 'config' })
	}
	return defineTool({
		name: REMIND_TOOL_NAME,
		description: TOOL_DESCRIPTION,
		parameters: {
			at: {
				type: 'string',
				required: true,
				description: '什么时候提醒：`19:00`、`明天 08:30`、`2026-11-02T19:00:00+08:00`、`20 分钟后` 都行',
			},
			text: { type: 'string', required: true, description: '到点要说的那句话，最多 200 字' },
		},
		output: {
			schema: { type: 'string', description: '一行结果：排在什么时候，还是哪里不对' },
			render(_args, value) {
				return [{ type: 'text', text: value }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (!isPrivateOwnerTurn()) {
				throw new RemindError('排提醒只能在主人的私聊里进行', { code: 'scope' })
			}
			const at = parseWhen(args?.at, { now: now() })
			const created = await client.remind({ at, text: String(args?.text ?? '') })
			if (created?.ok !== true) throw new RemindError(created?.error ?? '桥接没排上', { code: 'bridge' })
			return `排好了：${humanWhen(created.at ?? at)}，到点我会说「${String(args?.text ?? '').trim()}」`
		},
	})
}
