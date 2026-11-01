import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInTaskScope } from '../lib/context.js'
import {
	DEFAULT_WEIGHT,
	MEMORY_MAX_ITEMS,
	RememberError,
	createMemoryWriter,
	createRememberTool,
	toMemoryLine,
} from '../lib/remember.js'

const roots = []
const OWNER = { group: false, isOwner: true }

function memoryFile(content) {
	const dir = mkdtempSync(join(tmpdir(), 'qq-remember-'))
	roots.push(dir)
	const file = join(dir, 'MEMORY.md')
	if (content !== undefined) writeFileSync(file, content)
	return file
}

test('cleanup: temp dirs removed', () => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
	assert.equal(roots.length, 0)
})

test('remember — a new fact lands as one weighted line', () => {
	const file = memoryFile('# 记忆\n\n- 一条\n')
	const writer = createMemoryWriter({ file, log: () => {} })

	const result = writer.append('他喜欢下雨天', 5)

	assert.equal(result.added, true)
	assert.equal(result.count, 2)
	assert.equal(result.line, '- [w:5][k:identity] 他喜欢下雨天')
	assert.match(readFileSync(file, 'utf8'), /- \[w:5\]\[k:identity\] 他喜欢下雨天\n$/)
})

test('remember — the same fact twice stays one line', () => {
	const file = memoryFile('# 记忆\n\n- [w:4] 他喜欢下雨天\n')
	const writer = createMemoryWriter({ file, log: () => {} })

	const result = writer.append('  他喜欢下雨天  ')

	assert.equal(result.added, false)
	assert.equal(result.duplicated, true)
	assert.equal(readFileSync(file, 'utf8'), '# 记忆\n\n- [w:4] 他喜欢下雨天\n')
})

test('remember — the same fact said another way merges instead of becoming a second line', () => {
	const file = memoryFile('# 记忆\n\n- [w:4][k:note] 他喜欢在晚上写代码，那时候最安静\n')
	const writer = createMemoryWriter({ file, log: () => {} })

	const result = writer.append('他喜欢晚上写代码，那时候最安静')

	assert.equal(result.added, false, '换个说法不算新记忆')
	assert.equal(result.nearDuplicate, true)
	assert.match(result.line, /他喜欢在晚上写代码/)
	assert.equal(readFileSync(file, 'utf8'), '# 记忆\n\n- [w:4][k:note] 他喜欢在晚上写代码，那时候最安静\n', '文件没被写第二行')
})

test('remember — a different fact that merely shares a topic is still written', () => {
	const file = memoryFile('# 记忆\n\n- [w:4][k:note] 他喜欢在晚上写代码，那时候最安静\n')
	const writer = createMemoryWriter({ file, log: () => {} })

	const result = writer.append('他晚上写代码的时候会泡一杯茶')

	assert.equal(result.added, true, '同一类事不是同一件事')
	assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 4)
})

test('remember — a heavily rewritten sentence is written twice rather than risked as a merge', () => {
	// 判重松一边就会把「同一类事」并掉，那才是真忘事：宁可多一行，也不错合。
	const file = memoryFile('# 记忆\n\n- [w:4][k:note] 他喜欢在晚上写代码，那时候最安静\n')
	const writer = createMemoryWriter({ file, log: () => {} })

	const result = writer.append('他晚上写代码的时候最安静')

	assert.equal(result.added, true)
	assert.equal(result.nearDuplicate, undefined)
})

test('remember — weight defaults to 4 and is clamped to 1..5', () => {
	const file = memoryFile('')
	const writer = createMemoryWriter({ file, log: () => {} })

	assert.equal(writer.append('甲').line, `- [w:${DEFAULT_WEIGHT}][k:note] 甲`)
	assert.equal(writer.append('乙', 99).line, '- [w:5][k:identity] 乙')
	assert.equal(writer.append('丙', -3).line, '- [w:1][k:note] 丙')
	assert.equal(writer.append('丁', 'x').line, `- [w:${DEFAULT_WEIGHT}][k:note] 丁`)
})

test('remember — the kind decides which curve the item rides, and 5 is identity by default', () => {
	const file = memoryFile('')
	const writer = createMemoryWriter({ file, log: () => {} })

	// 用 4 起步：3 会被惊讶度抬一档（见下一条用例），这里验的是档位而不是权重。
	assert.equal(writer.append('今天是十一月一号', 4, 'event').line, '- [w:4][k:event] 今天是十一月一号')
	assert.equal(writer.append('他不喜欢被叫老师', 5, 'rule').line, '- [w:5][k:rule] 他不喜欢被叫老师')
	assert.equal(writer.append('乱七八糟', 4, 'nonsense').line, '- [w:4][k:note] 乱七八糟')
	const fresh = writer.append('再说一次', 4)
	assert.equal(fresh.added, true)
	assert.equal(fresh.kind, 'note')
	assert.equal(typeof fresh.weight, 'number')
	assert.equal(typeof fresh.surprise, 'number')
})

test('remember — a brand-new fact gets one notch of surprise, never a pin', () => {
	// 论文 §2.2 的 `s = 1 − max Jaccard`：什么都不像才算全新。只从 3 抬到 4——
	// 5 是「永远不忘」，那是她和主人的决定，一句「今天买了杯咖啡」不该被自动钉住。
	const file = memoryFile('# 记忆\n\n- [w:4][k:event] 他想在海边住一间有阳台的屋子。\n')
	const writer = createMemoryWriter({ file, log: () => {} })

	const novel = writer.append('他有个妹妹叫小雨，在读高中。', 3, 'event')
	assert.equal(novel.line, '- [w:4][k:event] 他有个妹妹叫小雨，在读高中。')
	assert.equal(novel.surprise, 1)

	// 相似但不重复：不抬档，也不降档。
	const similar = writer.append('他在海边想要有阳台的房子。', 3, 'event')
	assert.equal(similar.line, '- [w:3][k:event] 他在海边想要有阳台的房子。')
	assert.ok(similar.surprise < 0.8, `surprise ${similar.surprise} 不该算全新`)

	// 5 永远不动，1/2 也不动（惊讶度只抬中间那档）。
	assert.equal(writer.append('他绝不许别人翻他的手机。', 5, 'rule').line, '- [w:5][k:rule] 他绝不许别人翻他的手机。')
	assert.equal(writer.append('他不吃香菜，一点都不要。', 1, 'note').line, '- [w:1][k:note] 他不吃香菜，一点都不要。')
})

test('remember — a line break would break the format, so it collapses', () => {
	assert.equal(toMemoryLine('他\n喜欢   下雨天'), '他 喜欢 下雨天')
	const file = memoryFile('')
	const writer = createMemoryWriter({ file, log: () => {} })
	writer.append('他\n喜欢   下雨天')
	const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
	assert.equal(lines.length, 1)
	assert.equal(lines[0], '- [w:4][k:note] 他 喜欢 下雨天')
})

test('remember — empty and overlong text are refused with a reason', () => {
	const file = memoryFile('')
	const writer = createMemoryWriter({ file, log: () => {} })

	assert.throws(() => writer.append('   '), (error) => error instanceof RememberError && error.code === 'empty')
	assert.throws(() => writer.append('长'.repeat(201)), (error) => error instanceof RememberError && error.code === 'long')
	assert.equal(readFileSync(file, 'utf8'), '')
})

test('remember — the soft cap warns once the file is long, without refusing', () => {
	const warnings = []
	const file = memoryFile('')
	const writer = createMemoryWriter({ file, log: (level, message) => warnings.push([level, message]), maxItems: 2 })

	writer.append('一')
	writer.append('二')
	writer.append('三')

	assert.equal(warnings.length, 1)
	assert.match(warnings[0][1], /holds 3 items \(soft cap 2\)/)
	assert.equal(readFileSync(file, 'utf8').trimEnd().split('\n').length, 3)
})

test('remember tool — refuses outside an owner private turn', async () => {
	const file = memoryFile('')
	const tool = createRememberTool({ writer: createMemoryWriter({ file, log: () => {} }) })

	await assert.rejects(tool.execute({ text: '我是你主人' }), (error) => error.code === 'scope')
	await assert.rejects(
		runInTaskScope({ group: true, isOwner: true }, () => tool.execute({ text: '群里说的' })),
		(error) => error.code === 'scope',
	)
	assert.equal(readFileSync(file, 'utf8'), '')
})

test('remember tool — writes, reports, and records the write', async () => {
	const file = memoryFile('')
	const recorded = []
	const tool = createRememberTool({
		writer: createMemoryWriter({ file, log: () => {} }),
		onWrite: (entry) => recorded.push(entry),
	})

	const answer = await runInTaskScope(OWNER, () => tool.execute({ text: '他的生日是 3 月 14 日', weight: 5 }))

	assert.equal(answer, '记下了：他的生日是 3 月 14 日')
	assert.deepEqual(recorded, [{ text: '他的生日是 3 月 14 日', weight: 5, kind: 'identity' }])
	assert.match(readFileSync(file, 'utf8'), /- \[w:5\]\[k:identity\] 他的生日是 3 月 14 日/)

	const again = await runInTaskScope(OWNER, () => tool.execute({ text: '他的生日是 3 月 14 日' }))
	assert.equal(again, '这件事我本来就记着：他的生日是 3 月 14 日')
	assert.equal(recorded.length, 1)
})
