import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runInTaskScope } from '../lib/context.js'
import { createRecallTool, recallTokens, RECALL_MAX_HITS } from '../lib/recall.js'

const owner = (fn) => runInTaskScope({ group: false, isOwner: true }, fn)

function personaDir(files) {
	const dir = mkdtempSync(join(tmpdir(), 'recall-'))
	for (const [name, body] of Object.entries(files)) {
		const file = join(dir, name)
		mkdirSync(join(file, '..'), { recursive: true })
		writeFileSync(file, body)
	}
	return dir
}

test('recallTokens — 中文用二元组，英文用整词', () => {
	const tokens = recallTokens('生日 birthday')
	assert.deepEqual(tokens.sort(), ['birthday', '生日'])
	assert.deepEqual(recallTokens('雨'), ['雨'], '单字查询要保留，否则查不到')
	assert.deepEqual(recallTokens('  '), [])
})

test('recall 1 — 记忆里的条目查得到，并标明来源', async () => {
	const dir = personaDir({ 'MEMORY.md': '# 记忆\n- 主人的生日是 3 月 14 日。\n- 喜欢下雨天。' })
	const tool = createRecallTool({ dir })
	const result = await owner(() => tool.execute({ query: '生日' }))
	assert.match(result, /\[记忆\]/)
	assert.match(result, /3 月 14 日/)
})

test('recall 2 — 日记与笔记也会被搜到，标题和引用行不参与', async () => {
	const dir = personaDir({
		'MEMORY.md': '# 记忆\n',
		'diary/2026-10-20.md': '# 10-20\n> 说明行\n今天她提到想去大理。',
		'knowledge/2026-10-21-大理.md': '## 大理\n大理的苍山洱海，海拔两千。',
	})
	const tool = createRecallTool({ dir })
	const result = await owner(() => tool.execute({ query: '大理' }))
	assert.match(result, /\[日记\/2026-10-20\]/)
	assert.match(result, /\[笔记\/2026-10-21-大理\]/)
	assert.doesNotMatch(result, /说明行/, '说明行不该被当成记忆')
})

test('recall 3 — archive 与 CORRECTIONS 也在范围内', async () => {
	const dir = personaDir({
		'memory/archive.md': '- 忘了的那条：外婆家的院子。\n',
		'CORRECTIONS.md': '- [2026-10-25] 不要在群里叫我宝贝。\n',
	})
	const tool = createRecallTool({ dir })
	assert.match(await owner(() => tool.execute({ query: '院子' })), /\[档案\]/)
	assert.match(await owner(() => tool.execute({ query: '宝贝' })), /\[规矩\]/)
})

test('recall 4 — 查不到就说没有，不是空字符串', async () => {
	const dir = personaDir({ 'MEMORY.md': '- 喜欢下雨天。' })
	const tool = createRecallTool({ dir })
	assert.equal(await owner(() => tool.execute({ query: '量子力学' })), '本子里没有相关的记录。')
})

test('recall 5 — 群里或外人问，一律不翻本子', async () => {
	const dir = personaDir({ 'MEMORY.md': '- 主人的生日是 3 月 14 日。' })
	const tool = createRecallTool({ dir })
	const inGroup = await runInTaskScope({ group: true, isOwner: true }, () => tool.execute({ query: '生日' }))
	assert.doesNotMatch(inGroup, /3 月 14 日/)
	const stranger = await runInTaskScope({ group: false, isOwner: false }, () => tool.execute({ query: '生日' }))
	assert.match(stranger, /私事/)
	const nowhere = await tool.execute({ query: '生日' })
	assert.doesNotMatch(nowhere, /3 月 14 日/, '没有场景信息时必须关门')
})

test('recall 6 — 缺失目录不抛，空参数由框架先挡掉', async () => {
	const dir = personaDir({ 'MEMORY.md': '- 随便。' })
	const tool = createRecallTool({ dir })
	const empty = createRecallTool({ dir: join(dir, 'does-not-exist') })
	assert.equal(await owner(() => empty.execute({ query: '生日' })), '本子里没有相关的记录。')
})

test('recall 7 — 命中太多时按分数截断，不会把整个记忆灌进去', async () => {
	// 每行都带一个不同的词，否则「同一条话」会被去重，测的就不是截断了。
	const distinct = ['蛋糕', '蜡烛', '礼物', '照片', '歌', '卡片', '气球', '视频', '花束', '餐馆', '长信', '车票', '约定', '凌晨', '雨', '旧相册', '布丁', '围巾']
	const lines = Array.from({ length: RECALL_MAX_HITS + 10 }, (_value, index) => `- 生日相关的第 ${index} 条记录，关于${distinct[index % distinct.length]}。`)
	const dir = personaDir({ 'MEMORY.md': lines.join('\n') })
	const tool = createRecallTool({ dir })
	const result = await owner(() => tool.execute({ query: '生日' }))
	assert.equal(result.split('\n').length, RECALL_MAX_HITS)
	assert.ok(result.length <= 1200)
})

test('recall 7b — 同一条话在记忆和日记里各有一份时只给她一遍', async () => {
	const same = '他说过想在海边住一间有阳台的屋子。'
	const dir = personaDir({
		'MEMORY.md': `- [w:5][k:event] ${same}`,
		'diary/2026-11-01.md': `${same}\n今天又聊到海边。\n`,
	})
	const tool = createRecallTool({ dir })
	const result = await owner(() => tool.execute({ query: '海边 阳台' }))
	assert.equal(result.split('\n').filter((line) => line.includes('海边的屋子') || line.includes('的屋子')).length, 1)
	assert.match(result, /今天又聊到海边/, '不重复，但不是把别的内容也滤掉')
})

test('recall 8 — 目录消失时安静返回「没有」，不炸', async () => {
	const dir = mkdtempSync(join(tmpdir(), 'recall-'))
	writeFileSync(join(dir, 'MEMORY.md'), 'x'.repeat(300 * 1024))
	const tool = createRecallTool({ dir, log: () => {} })
	rmSync(dir, { recursive: true, force: true })
	assert.equal(await owner(() => tool.execute({ query: '生日' })), '本子里没有相关的记录。')
})

test('recall 9 — 工具形状符合 dsh 契约（output 与参数表）', () => {
	const tool = createRecallTool({ dir: mkdtempSync(join(tmpdir(), 'recall-')) })
	assert.equal(tool.name, 'recall')
	assert.equal(tool.output.schema.type, 'string')
	assert.deepEqual(tool.output.render({}, '正文'), [{ type: 'text', text: '正文' }])
	assert.equal(tool.parameters.properties.query.type, 'string')
	assert.deepEqual(tool.parameters.required, ['query'])
})
