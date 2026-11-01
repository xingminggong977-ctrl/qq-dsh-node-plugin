import test from 'node:test'
import assert from 'node:assert/strict'
import { FALLBACK_REPLY, stripToolMarkup } from '../lib/reply-guard.js'

// 真实漏出来的那一串（2026-10-28 15:08，发给一个不是主人的人）。
const LEAK_ONE = `<||DSML|| calls>\n<||DSML|| invoke name="bash">\n<||DSML|| parameter name="command" string="true">cd /var/lib/dsh-qq-agent/workspace 2>/dev/null || cd ~; pwd; ls -la; echo ---; grep -ril "qzone\\|说说" . --include=*.md --include=*.json 2>/dev/null | head -50</||DSML|| parameter>\n</||DSML|| invoke>\n</||DSML|| calls>`

test('reply-guard: 完整的工具调用文本协议被整段删掉', () => {
	assert.equal(stripToolMarkup(LEAK_ONE), '')
})

test('reply-guard: 两串连在一起也删干净', () => {
	assert.equal(stripToolMarkup(`${LEAK_ONE}\n${LEAK_ONE}`), '')
})

test('reply-guard: 标记后面还跟着人话，人话留着', () => {
	const text = `${LEAK_ONE}\n这条我说的是那天的《我的世界》呀。`
	assert.equal(stripToolMarkup(text), '这条我说的是那天的《我的世界》呀。')
})

test('reply-guard: 被截断、没有收尾标记的也吃到结尾', () => {
	const truncated = '<||DSML|| calls>\n<||DSML|| invoke name="bash">\n<||DSML|| parameter name="command" string="true">ls -la</||DSML|| parameter>\n<||DSML|| invoke>'
	assert.equal(stripToolMarkup(truncated), '')
})

test('reply-guard: 只剩下的零星标记也删掉', () => {
	assert.equal(stripToolMarkup('我先看看\n</||DSML|| parameter>'), '我先看看')
})

test('reply-guard: 全角竖线那种写法也认', () => {
	assert.equal(stripToolMarkup('＜｜｜DSML｜｜ calls＞'.replaceAll('＜', '<').replaceAll('＞', '>')), '')
})

test('reply-guard: 正常回复一个字都不动', () => {
	for (const text of ['在呢在呢，怎么啦茶茶？', '考完了。\n出门风比早上凉。', '']) {
		assert.equal(stripToolMarkup(text), text)
	}
})

test('reply-guard: 非字符串原样当作空', () => {
	assert.equal(stripToolMarkup(undefined), '')
	assert.equal(stripToolMarkup(null), '')
})

test('reply-guard: 兜底那句不是空的', () => {
	assert.equal(typeof FALLBACK_REPLY, 'string')
	assert.ok(FALLBACK_REPLY.length > 0)
})
