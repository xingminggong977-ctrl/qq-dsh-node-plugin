import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	DEEP_CAPS,
	NIGHTLY_CAPS,
	NIGHTLY_FILE_PATHS,
	NIGHTLY_NONE_MARKER,
	capsFor,
	diffLineCount,
	intentWhyHasEvidence,
	mergeMemory,
	parseNightlyOutput,
	recountPatchHunks,
	validateNightly,
	writeIntents,
	writeProposals,
} from '../lib/nightly.js'
import { NIGHTLY_FILE_HINTS, QqNightlyRunner, buildNightlyPrompt, isDeepNight, runNightlyTurn, zonedParts } from '../lib/nightly-runner.js'
import { resolveOptions } from '../index.js'
import { createFakeRuntime } from './fake-runtime.js'

/**
 * 自检会按「部署布局」去读真实文件，而本机和服务器一个有 /opt 一个没有。
 * 不把三个前缀都钉到不存在的目录，用例结果就取决于「这台机器上有没有那棵树」——
 * 2026-10-28 服务器上因此红了两条。需要真文件的用例在 nightly-verify.test.js 里自己注入。
 */
async function withoutRealSources(body) {
	const keys = ['DSH_QQ_NODE_PLUGIN_DIR', 'DSH_QQ_BRIDGE_DIR', 'DSH_QQ_DEPLOY_DIR']
	const saved = keys.map((key) => [key, process.env[key]])
	const absent = join(tmpdir(), 'dsh-qq-test-no-such-source-tree')
	for (const key of keys) process.env[key] = absent
	try {
		return await body()
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key]
			else process.env[key] = value
		}
	}
}

/** 三反引号在模板串里要转义，索性拼出来，免得整份测试变成反斜杠展览。 */
const fence = (language) => `${'`'.repeat(3)}${language}`

/** 2026-03-11 03:10 Asia/Shanghai（周三）。 */
const WEDNESDAY = new Date('2026-03-10T19:10:00Z')
/** 2026-03-08 03:10 Asia/Shanghai（周日，深度档）。 */
const SUNDAY = new Date('2026-03-07T19:10:00Z')

const TEMP_DIRS = []
test.after(() => {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'qq-nightly-'))
	TEMP_DIRS.push(dir)
	return dir
}

const LEGAL_REPLY = [
	'夜里想了想，有两条值得记。',
	'',
	fence('memory'),
	'- [w:5] 群里问装机预算时，先问清用途再报配置',
	'- [w:3] 他说「随便」通常是要我拿主意，不是真的随便',
	fence(''),
	'',
	fence('proposal'),
	'file: node-plugin/lib/tier.js',
	'why: 短句被误判成低档，导致群聊里回复太慢',
	'---',
	'--- a/node-plugin/lib/tier.js',
	'+++ b/node-plugin/lib/tier.js',
	'@@ -1,2 +1,2 @@',
	'-const light = text.length < 40',
	'+const light = text.length < 24',
	fence(''),
	'',
].join('\n')

/** 一份像模像样的 MEMORY.md：结构性行 + 若干带权重的条目，一共 59 行。 */
function memoryFixture59() {
	const lines = ['# 记忆', '', '> 长期事实与约定；越靠下的越旧。', '', '## 关于主人', '', '- 称呼用「你」，讲到他时说「主人」。', '']
	for (let index = 0; index < 30; index += 1) lines.push(`- [w:5] 长期事实第 ${index + 1} 条，只在这一行里说完。`)
	lines.push('')
	for (let index = 0; index < 10; index += 1) lines.push(`- [w:2] 早就过时的琐事第 ${index + 1} 条。`)
	lines.push('## 正在做的事', '', '- [w:4] 在给群里做记账机器人。')
	// 剩下的凑到 59 行；最后一行必须有内容，否则 trimEnd 之后就不够 59 了。
	lines.push('', '## 还有一些没归类的', '', '- 群里不用「您」。', '', '- 晚十一点后少打扰他。', '- 她不喜欢连续追问。')
	assert.equal(lines.length, 59)
	return `${lines.join('\n')}\n`
}

function nightlyOptions(overrides = {}) {
	return {
		nightlyEnabled: true,
		nightlyHour: 3,
		nightlyTimeoutMs: 120_000,
		nightlyMaxMemories: 5,
		nightlyMaxProposals: 3,
		nightlyDigestDir: '',
		personaDir: '',
		proposalsDir: '',
		provider: '',
		model: '',
		reasoningEffort: '',
		maxTokens: 0,
		turnTimeoutMs: 180_000,
		cwd: process.cwd(),
		nonOwnerPreset: 'qq-chat-only',
		...overrides,
	}
}

function recorder() {
	return {
		records: [],
		record(entry) {
			this.records.push(entry)
		},
	}
}

// ---------------------------------------------------------------- parseNightlyOutput

test('nightly parse — a legal reply yields both memories and the proposal', () => {
	const parsed = parseNightlyOutput(LEGAL_REPLY)
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.memories, [
		{ weight: 5, text: '群里问装机预算时，先问清用途再报配置' },
		{ weight: 3, text: '他说「随便」通常是要我拿主意，不是真的随便' },
	])
	assert.equal(parsed.proposals.length, 1)
	assert.equal(parsed.proposals[0].file, 'node-plugin/lib/tier.js')
	assert.match(parsed.proposals[0].why, /短句被误判/)
	assert.match(parsed.proposals[0].diff, /^--- a\/node-plugin\/lib\/tier\.js/)
	assert.equal(diffLineCount(parsed.proposals[0].diff), 5)
})

test('nightly parse — a weight outside 1..5 rejects the whole reply', () => {
	const parsed = parseNightlyOutput([fence('memory'), '- [w:9] 这条权重根本没定义过', fence('')].join('\n'))
	assert.equal(parsed.ok, false)
	assert.match(parsed.reason, /权重越界（只能 1\.\.5）/u)
	assert.match(parsed.reason, /\[w:9\]/u)
})

test('nightly parse — a memory line without the "- [w:N] " shape rejects the whole reply', () => {
	const parsed = parseNightlyOutput([fence('memory'), '- 忘了写权重', fence('')].join('\n'))
	assert.equal(parsed.ok, false)
	assert.match(parsed.reason, /memory 行格式必须是/u)
})

test('nightly parse — one bad line sinks an otherwise good block', () => {
	const parsed = parseNightlyOutput([fence('memory'), '- [w:4] 这一条是好的', '* [w:2] 这一条换了 bullet 但少了空格', fence('')].join('\n'))
	assert.equal(parsed.ok, false)
	assert.equal(parsed.memories, undefined)
})

test('nightly parse — a proposal without --- drops only that block', () => {
	const parsed = parseNightlyOutput(
		[fence('proposal'), 'file: node-plugin/index.js', 'why: 少了一条分隔线', '--- a/node-plugin/index.js', fence('')].join('\n'),
	)
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.proposals, [])
	assert.match(parsed.rejected[0].reason, /第三行必须是 ---/u)
})

test('nightly parse — a proposal without file: drops only that block', () => {
	const parsed = parseNightlyOutput([fence('proposal'), 'why: 忘了写文件', '---', '--- a/x.js', fence('')].join('\n'))
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.proposals, [])
	assert.match(parsed.rejected[0].reason, /第一行必须是 "file: <路径>"/u)
})

test('nightly parse — prose with no fenced block is a rejected round', () => {
	const parsed = parseNightlyOutput('今晚没什么好记的，我睡了。')
	assert.equal(parsed.ok, false)
	assert.match(parsed.reason, /没有任何 memory \/ proposal 块/u)
})

test('nightly parse — the explicit "nothing to note" marker is a success with zero writes', () => {
	const parsed = parseNightlyOutput(NIGHTLY_NONE_MARKER)
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.memories, [])
	assert.deepEqual(parsed.proposals, [])
})

test('nightly parse — the marker rides along with a real memory block and never hides it', () => {
	const text = [NIGHTLY_NONE_MARKER, fence('memory'), '- [w:3] 暗号不该盖住真块', fence('')].join('\n')
	const parsed = parseNightlyOutput(text)
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.memories, [{ weight: 3, text: '暗号不该盖住真块' }])
})

test('nightly parse — a leaked tool-call markup reply stays a rejected round', () => {
	// 这一轮的实测原样：工具全封死之后模型照样吐了一段调用标记，没有暗号也没有块。
	const leaked = '<||DSML|| calls>\n<||DSML|| invoke name="bash">\n<||DSML|| parameter name="command" string="true">ls /\n</||DSML|| invoke>\n</||DSML|| calls>'
	const parsed = parseNightlyOutput(leaked)
	assert.equal(parsed.ok, false)
	assert.match(parsed.reason, /没有任何 memory \/ proposal 块/u)
})

test('nightly prompt — tells the model it has no tools and how to say "nothing to note"', () => {
	const prompt = buildNightlyPrompt({ digest: '# 夜班素材', memory: '', date: '2026-03-11', caps: NIGHTLY_CAPS })
	assert.match(prompt, /没有任何工具可用|不许使用任何工具/u)
	assert.ok(prompt.includes(NIGHTLY_NONE_MARKER))
})

test('nightly prompt — proposal paths come from the real file list, hunks carry line numbers', () => {
	const prompt = buildNightlyPrompt({ digest: '# 夜班素材', memory: '', date: '2026-03-11', caps: NIGHTLY_CAPS })
	for (const hint of NIGHTLY_FILE_HINTS) {
		assert.ok(prompt.includes(`- ${hint}`), `prompt 应该原样列出 ${hint}`)
	}
	// 实测踩过的坑：她把 bridge/src/asr.js 写成 agent/src/asr.js，补丁因此打不上。
	assert.ok(prompt.includes('bridge/src/asr.js'))
	assert.ok(!prompt.includes('agent/src/asr.js'))
	assert.match(prompt, /必须带行号/u)
})

test('nightly parse — other languages and bare fences are ignored, not rejected', () => {
	const text = [
		fence('js'),
		'const weight = 9',
		fence(''),
		fence('diff'),
		'--- a/x.js',
		fence(''),
		fence('memory'),
		'- [w:2] 只有这一条是真要记的',
		fence(''),
	].join('\n')
	const parsed = parseNightlyOutput(text)
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.memories, [{ weight: 2, text: '只有这一条是真要记的' }])
	assert.deepEqual(parsed.proposals, [])
})

test('nightly parse — an unterminated fence rejects the round', () => {
	const parsed = parseNightlyOutput([fence('memory'), '- [w:3] 收尾的三反引号掉了'].join('\n'))
	assert.equal(parsed.ok, false)
	assert.match(parsed.reason, /没有收尾/u)
})

test('nightly parse — CRLF output parses the same as LF', () => {
	const parsed = parseNightlyOutput(LEGAL_REPLY.replace(/\n/g, '\r\n'))
	assert.equal(parsed.ok, true)
	assert.equal(parsed.memories.length, 2)
})

// ---------------------------------------------------------------- intent（主通道）

/**
 * 一份合法的 intent 块；overrides 用来造各种坏块。
 * 默认值就是提示词里的例子——它必须自己先能过校验，否则提示词在教她写废块。
 */
function intentBlock(overrides = {}) {
	const fields = {
		file: 'node-plugin/lib/audit.js',
		why: '05:57:22 那条日志写着 `PermissionError`，转写失败 4 次',
		change: ['1. 在 catch 里把 stdout 也拼进失败原因', '2. 失败时补一条 audit 记录，带上 exit code', '3. 其余日志格式不动'],
		verify: '跑 node --test test/index.js，再 grep 确认 stdout 进了 reason',
		...overrides,
	}
	const lines = [`file: ${fields.file}`, `why: ${fields.why}`, 'change:']
	for (const line of fields.change) lines.push(`  ${line}`)
	lines.push(`verify: ${fields.verify}`)
	return [fence('intent'), ...lines, fence('')].join('\n')
}

test('nightly intent — 一块合法意图解析出四个字段，且不产出任何 proposal', () => {
	const parsed = parseNightlyOutput(intentBlock())
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.proposals, [])
	assert.deepEqual(parsed.rejected, [])
	assert.deepEqual(parsed.intents, [
		{
			file: 'node-plugin/lib/audit.js',
			why: '05:57:22 那条日志写着 `PermissionError`，转写失败 4 次',
			change: '1. 在 catch 里把 stdout 也拼进失败原因\n2. 失败时补一条 audit 记录，带上 exit code\n3. 其余日志格式不动',
			verify: '跑 node --test test/index.js，再 grep 确认 stdout 进了 reason',
		},
	])
})

test('nightly intent — 四个字段缺任何一个都整条丢弃，同一轮的记忆照收', () => {
	const cases = [
		{ label: 'file', block: intentBlock({ file: '' }), reason: /缺 file/u },
		{ label: 'why', block: intentBlock({ why: '' }), reason: /缺 why/u },
		{ label: 'change', block: intentBlock({ change: [] }), reason: /要 3 到 6 行中文/u },
		{ label: 'verify', block: intentBlock({ verify: '' }), reason: /缺 verify/u },
	]
	for (const item of cases) {
		const text = [fence('memory'), '- [w:4] 语音失败先看 stdout', fence(''), item.block].join('\n')
		const parsed = parseNightlyOutput(text)
		// 一条说不清证据的意图不连累一条说得清的记忆——这正是 intent 与 memory 的区别。
		assert.equal(parsed.ok, true, `${item.label}: 整轮不该作废`)
		assert.deepEqual(parsed.memories, [{ weight: 4, text: '语音失败先看 stdout' }], `${item.label}: 记忆应当照收`)
		assert.equal(parsed.intents.length, 0, `${item.label}: 这条意图应当被丢掉`)
		assert.match(parsed.rejected[0].reason, item.reason, `${item.label}: 原因应当指名缺哪个字段`)
	}
})

test('nightly intent — file 不在 NIGHTLY_FILE_PATHS 里就整条丢弃，并留下可读的原因', () => {
	// 10-26 那三份的路径是编的：agent/src/asr.js 根本不存在。
	const parsed = parseNightlyOutput(intentBlock({ file: 'agent/src/asr.js' }))
	assert.equal(parsed.ok, true)
	assert.equal(parsed.intents.length, 0)
	assert.match(parsed.rejected[0].reason, /不在真实清单里/u)
	assert.match(parsed.rejected[0].reason, /agent\/src\/asr\.js/u)
	// 清单里是真路径：写对的那份能过。
	assert.ok(NIGHTLY_FILE_PATHS.includes('bridge/src/asr.js'))
	assert.ok(!NIGHTLY_FILE_PATHS.includes('agent/src/asr.js'))
	assert.equal(parseNightlyOutput(intentBlock({ file: 'bridge/src/asr.js' })).intents.length, 1)
})

test('nightly intent — why 里没有具体证据（只有形容词）就整条丢弃', () => {
	const parsed = parseNightlyOutput(intentBlock({ why: '这里可能有点问题，建议关注一下性能' }))
	assert.equal(parsed.ok, true)
	assert.equal(parsed.intents.length, 0)
	assert.match(parsed.rejected[0].reason, /没有任何具体证据/u)
})

test('nightly intent — 时间戳、引号里的日志原文、带单位的审计数字，命中任一条都算证据', () => {
	assert.equal(intentWhyHasEvidence('05:57:22 那条异常'), true)
	assert.equal(intentWhyHasEvidence('日志里是 `PermissionError`'), true)
	assert.equal(intentWhyHasEvidence('转写失败 4 次'), true)
	assert.equal(intentWhyHasEvidence('72% 的请求超时'), true)
	assert.equal(intentWhyHasEvidence('这里可能有点问题'), false)
	assert.equal(intentWhyHasEvidence(''), false)
})

test('nightly intent — change 少于三行、多于六行、或整段没有中文，都整条丢弃', () => {
	const two = parseNightlyOutput(intentBlock({ change: ['1. 一', '2. 二'] }))
	assert.equal(two.intents.length, 0)
	assert.match(two.rejected[0].reason, /实际 2 行/u)

	const seven = parseNightlyOutput(intentBlock({ change: ['1. 一', '2. 二', '3. 三', '4. 四', '5. 五', '6. 六', '7. 七'] }))
	assert.equal(seven.intents.length, 0)
	assert.match(seven.rejected[0].reason, /实际 7 行/u)

	const latin = parseNightlyOutput(intentBlock({ change: ['one', 'two', 'three'] }))
	assert.equal(latin.intents.length, 0)
	assert.match(latin.rejected[0].reason, /没有中文/u)

	// 六行正好在上限上。
	assert.equal(parseNightlyOutput(intentBlock({ change: ['1. 一', '2. 二', '3. 三', '4. 四', '5. 五', '6. 六'] })).intents.length, 1)
})

test('nightly intent — 四条意图超过提案上限就整轮作废，不截断', () => {
	const parsed = parseNightlyOutput(Array.from({ length: 4 }, () => intentBlock()).join('\n\n'))
	assert.equal(parsed.ok, true)
	assert.equal(parsed.intents.length, 4)
	const result = validateNightly(parsed, NIGHTLY_CAPS)
	assert.equal(result.ok, false)
	assert.match(result.reason, /intent 有 4 条，超过上限 3 条/u)
	// 数据一个都没被截掉：作废是作废，不是「留下前三条」。
	assert.equal(parsed.intents.length, 4)
	// 周日深度档的上限是 5，五条就过得去。
	const deep = validateNightly({ memories: [], proposals: [], intents: Array.from({ length: 5 }, () => parsed.intents[0]) }, DEEP_CAPS)
	assert.deepEqual(deep, { ok: true })
})

test('nightly intent — 旧 proposal 块与新 intent 块混排时各归各的通道', () => {
	const parsed = parseNightlyOutput([LEGAL_REPLY, intentBlock()].join('\n\n'))
	assert.equal(parsed.ok, true)
	assert.equal(parsed.memories.length, 2)
	assert.equal(parsed.proposals.length, 1)
	assert.equal(parsed.intents.length, 1)
	assert.equal(parsed.rejected.length, 0)
})

test('nightly intent — 旧的畸形 diff 仍由 recountPatchHunks 兜住，不整轮作废', () => {
	// 10-27 那两份的原始症状：头里写着 @@ -52,6，正文只有 5 行旧文。
	const text = [
		fence('proposal'),
		'file: node-plugin/lib/session.js',
		'why: hunk 头里的数字和正文对不上',
		'---',
		'@@ -52,6 +52,8 @@',
		' a',
		' b',
		' c',
		' d',
		' e',
		'+f',
		'+g',
		fence(''),
	].join('\n')
	const parsed = parseNightlyOutput(text)
	assert.equal(parsed.ok, true)
	assert.match(parsed.proposals[0].diff, /^@@ -52,5 \+52,7 @@/u)
})

test('nightly intent — 「无新增」标记与坏意图并存：整轮成功、零意图，原因不丢', () => {
	const alone = parseNightlyOutput(NIGHTLY_NONE_MARKER)
	assert.equal(alone.ok, true)
	assert.deepEqual(alone.intents, [])

	const mixed = parseNightlyOutput([NIGHTLY_NONE_MARKER, intentBlock({ file: 'agent/src/x.js' })].join('\n\n'))
	assert.equal(mixed.ok, true)
	assert.deepEqual(mixed.intents, [])
	assert.match(mixed.rejected[0].reason, /不在真实清单里/u)
})

test('nightly parse — 畸形 proposal 只丢这一块，同轮的记忆与意图照收', () => {
	const text = [
		fence('memory'),
		'- [w:4] 语音失败先看 stdout',
		fence(''),
		intentBlock(),
		fence('proposal'),
		'file: bridge/src/asr.js',
		'why: xx',
		fence(''),
	].join('\n')
	const parsed = parseNightlyOutput(text)
	// 结构不成立的补丁根本写不成 .patch，下游看不到它，所以它没资格取消整轮。
	assert.equal(parsed.ok, true)
	assert.equal(parsed.memories.length, 1)
	assert.equal(parsed.intents.length, 1)
	assert.deepEqual(parsed.proposals, [])
	assert.match(parsed.rejected[0].reason, /proposal 至少要有 file:、why:、--- 三行/u)
})

test('nightly parse — 整轮只剩畸形 proposal：仍算解析成功，但一条都不收、理由留痕', () => {
	const text = [fence('proposal'), 'file: bridge/src/asr.js', 'why: xx', fence('')].join('\n')
	const parsed = parseNightlyOutput(text)
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.proposals, [])
	assert.deepEqual(parsed.memories, [])
	assert.deepEqual(parsed.intents, [])
	assert.match(parsed.rejected[0].reason, /proposal 至少要有/u)
})

test('nightly parse — 畸形 proposal 与「无新增」标记并存时整轮算成功', () => {
	const text = [NIGHTLY_NONE_MARKER, fence('proposal'), 'file: x', 'why: y', fence('')].join('\n')
	const parsed = parseNightlyOutput(text)
	assert.equal(parsed.ok, true)
	assert.deepEqual(parsed.memories, [])
	assert.equal(parsed.rejected.length, 1)
})

// ---------------------------------------------------------------- validateNightly

test('nightly validate — a legal night passes and is left untouched', () => {
	const { memories, proposals } = parseNightlyOutput(LEGAL_REPLY)
	const before = JSON.stringify({ memories, proposals })
	assert.deepEqual(validateNightly({ memories, proposals }, NIGHTLY_CAPS), { ok: true })
	assert.equal(JSON.stringify({ memories, proposals }), before)
})

test('nightly validate — six memories break the nightly cap of five, with no truncation', () => {
	const memories = Array.from({ length: 6 }, (_, index) => ({ weight: 3, text: `第 ${index + 1} 条` }))
	const result = validateNightly({ memories, proposals: [] }, NIGHTLY_CAPS)
	assert.equal(result.ok, false)
	assert.match(result.reason, /memory 有 6 行，超过上限 5 行/u)
	assert.equal(memories.length, 6)
})

test('nightly validate — four proposals break the nightly cap of three', () => {
	const proposals = Array.from({ length: 4 }, () => ({ file: 'a.js', why: 'why', diff: '--- a/a.js\n+++ b/a.js' }))
	const result = validateNightly({ memories: [], proposals }, NIGHTLY_CAPS)
	assert.equal(result.ok, false)
	assert.match(result.reason, /proposal 有 4 条，超过上限 3 条/u)
})

test('nightly validate — a diff over 120 lines breaks the cap in both directions', () => {
	const long = { file: 'a.js', why: 'why', diff: Array.from({ length: 121 }, (_, index) => `+line ${index}`).join('\n') }
	assert.equal(validateNightly({ memories: [], proposals: [long] }, NIGHTLY_CAPS).ok, false)
	const relaxed = { ...long, diff: Array.from({ length: 120 }, (_, index) => `+line ${index}`).join('\n') }
	assert.equal(validateNightly({ memories: [], proposals: [relaxed] }, NIGHTLY_CAPS).ok, true)
})

test('nightly validate — a weight of 0 or a fractional weight is not a valid nightly weight', () => {
	assert.equal(validateNightly({ memories: [{ weight: 0, text: 'x' }], proposals: [] }, NIGHTLY_CAPS).ok, false)
	assert.equal(validateNightly({ memories: [{ weight: 2.5, text: 'x' }], proposals: [] }, NIGHTLY_CAPS).ok, false)
	assert.equal(validateNightly({ memories: [{ weight: 1, text: '   ' }], proposals: [] }, NIGHTLY_CAPS).ok, false)
	assert.equal(validateNightly({}, NIGHTLY_CAPS).ok, false)
})

test('nightly caps — the Sunday deep run doubles counts but never the memory line budget', () => {
	const normal = capsFor({ maxMemories: 5, maxProposals: 3, timeoutMs: 120_000 })
	assert.deepEqual(normal, NIGHTLY_CAPS)
	const deep = capsFor({ deep: true, maxMemories: 5, maxProposals: 3, timeoutMs: 120_000 })
	assert.equal(deep.memories, 10)
	assert.equal(deep.proposals, 5)
	assert.equal(deep.diffLines, DEEP_CAPS.diffLines)
	assert.equal(deep.memoryLines, 60)
	assert.equal(deep.timeoutMs, 180_000)
	// 配得比契约还宽也压不回契约上限之上。
	const cramped = capsFor({ deep: true, maxMemories: 2, maxProposals: 1, timeoutMs: 300_000 })
	assert.equal(cramped.memories, 4)
	assert.equal(cramped.proposals, 2)
	assert.equal(cramped.timeoutMs, 300_000)
})

// ---------------------------------------------------------------- mergeMemory

test('nightly merge — three new memories push a 59-line file to 62 and evict exactly two', () => {
	const before = memoryFixture59()
	assert.equal(before.trimEnd().split('\n').length, 59)
	const merged = mergeMemory(
		before,
		[
			{ weight: 4, text: '装机预算先问用途' },
			{ weight: 5, text: '他说随便就是要我拿主意' },
			{ weight: 3, text: '群里 @全体 的消息先看是谁发的' },
		],
		{ maxLines: 60 },
	)
	assert.equal(merged.added, 3)
	assert.equal(merged.dropped, 2)
	assert.equal(merged.droppedLines.length, 2)
	assert.equal(merged.text.trimEnd().split('\n').length, 60)
	// 挤掉的必须是最低权重且最旧的那两条，不是刚写进来的新事实。
	for (const line of merged.droppedLines) assert.match(line, /\[w:2\]/u)
	assert.doesNotMatch(merged.text, /早就过时的琐事第 1 条/u)
	assert.doesNotMatch(merged.text, /早就过时的琐事第 2 条/u)
	assert.match(merged.text, /早就过时的琐事第 3 条/u)
	assert.match(merged.text, /^- \[w:4\]\[k:note\] 装机预算先问用途$/mu)
	assert.ok(merged.text.endsWith('\n'))
})

test('nightly merge — the same fact is not written twice', () => {
	const existing = '# 记忆\n\n- [w:4] 装机预算先问用途\n'
	const merged = mergeMemory(existing, [{ weight: 4, text: '装机预算先问用途' }], { maxLines: 60 })
	assert.equal(merged.added, 0)
	assert.equal(merged.dropped, 0)
	assert.equal(merged.text, existing)
})

test('nightly merge — a weighted line goes before any plain bullet', () => {
	const existing = ['# 记忆', '- [w:5] 高权重', '- 一件没有权重的旧事', '- 另一件没有权重的旧事'].join('\n')
	const merged = mergeMemory(existing, [{ weight: 4, text: '新的事实' }], { maxLines: 4 })
	assert.equal(merged.added, 1)
	assert.equal(merged.dropped, 1)
	assert.deepEqual(merged.droppedLines, ['- [w:5] 高权重'])
	assert.match(merged.text, /^- 一件没有权重的旧事$/mu)
	assert.match(merged.text, /^- 另一件没有权重的旧事$/mu)
})

test('nightly merge — identity and rule lines survive eviction, and a tagged duplicate is not written twice', () => {
	const existing = [
		'# 记忆',
		'- [w:5][k:identity] 他叫主人，生日 3 月 7 日',
		'- [k:rule] 群里不用「您」',
		'- [w:2][k:note] 一条快过时的旧事',
	].join('\n')
	// 同一条事实再报一遍：判重只看正文，标签不算内容。
	const merged = mergeMemory(existing, [{ weight: 2, text: '一条快过时的旧事' }], { maxLines: 3 })
	assert.equal(merged.added, 0)
	assert.equal(merged.dropped, 1)
	assert.deepEqual(merged.droppedLines, ['- [w:2][k:note] 一条快过时的旧事'])
	assert.match(merged.text, /^- \[w:5\]\[k:identity\] 他叫主人，生日 3 月 7 日$/mu)
	assert.match(merged.text, /^- \[k:rule\] 群里不用「您」$/mu)
})

test('nightly merge — a plain bullet is evicted only when no weighted line is left', () => {
	const existing = ['# 记忆', '- 一件没有权重的旧事', '- 另一件没有权重的旧事'].join('\n')
	const merged = mergeMemory(existing, [{ weight: 4, text: '新的事实' }], { maxLines: 3 })
	assert.equal(merged.added, 1)
	assert.equal(merged.dropped, 1)
	assert.deepEqual(merged.droppedLines, ['- 一件没有权重的旧事'])
	assert.match(merged.text, /^- 另一件没有权重的旧事$/mu)
})

test('nightly merge — headings, quotes and blank lines are never evicted', () => {
	const existing = ['# 记忆', '', '> 长期事实与约定', '', '## 关于主人', '', '- [w:1] 一条快过时的旧事', '', '- [w:1] 另一条快过时的旧事', ''].join('\n')
	const merged = mergeMemory(existing, [], { maxLines: 5 })
	assert.equal(merged.added, 0)
	assert.equal(merged.dropped, 2)
	assert.match(merged.text, /^# 记忆$/mu)
	assert.match(merged.text, /^> 长期事实与约定$/mu)
	assert.match(merged.text, /^## 关于主人$/mu)
	// 挤不动了就停：两条 w:1 走掉之后没有可挤的了，剩下的结构行一个都不能少。
	assert.doesNotMatch(merged.text, /旧事/u)
})

test('nightly merge — an empty or missing file starts clean and adds one line per memory', () => {
	const merged = mergeMemory('', [{ weight: 2, text: '第一条' }, { weight: 2, text: '第二条' }], { maxLines: 60 })
	assert.equal(merged.added, 2)
	assert.equal(merged.dropped, 0)
	assert.deepEqual(merged.droppedLines, [])
	// 新写下的事实自带档位：w5 是 identity，其余按 note 走。
	assert.equal(merged.text, '- [w:2][k:note] 第一条\n- [w:2][k:note] 第二条\n')
})

test('nightly merge — structural lines survive even when the budget cannot be met', () => {
	const existing = ['# 记忆', '## 关于主人', '> 引用块'].join('\n')
	const merged = mergeMemory(existing, [], { maxLines: 1 })
	assert.equal(merged.added, 0)
	assert.equal(merged.dropped, 0)
	assert.equal(merged.text, '# 记忆\n## 关于主人\n> 引用块\n')
})

// ---------------------------------------------------------------- writeProposals

test('nightly proposals — one patch and one json per proposal, numbered from 01', () => {
	const dir = tempDir()
	const written = writeProposals(
		dir,
		'2026-03-11',
		[
			{ file: 'node-plugin/lib/tier.js', why: '短句被判成低档', diff: '--- a/node-plugin/lib/tier.js\n+++ b/node-plugin/lib/tier.js' },
			{ file: 'Cloudflare/worker.ts', why: '少了超时', diff: '--- a/worker.ts\n+++ b/worker.ts' },
		],
		{ now: () => new Date('2026-03-10T19:20:00Z') },
	)
	assert.equal(written.length, 4)
	assert.equal(written[0], join(dir, '2026-03-11', '01-tier.patch'))
	assert.equal(written[2], join(dir, '2026-03-11', '02-worker.patch'))
	assert.match(readFileSync(written[0], 'utf8'), /^\+\+\+ b\/node-plugin\/lib\/tier\.js\n$/mu)
	const meta = JSON.parse(readFileSync(written[1], 'utf8'))
	assert.deepEqual(meta, {
		title: 'tier.js',
		why: '短句被判成低档',
		files: ['node-plugin/lib/tier.js'],
		created: '2026-03-10T19:20:00.000Z',
	})
})

test('nightly proposals — an existing patch is never overwritten', () => {
	const dir = tempDir()
	const proposals = [{ file: 'a/tier.js', why: 'why', diff: '--- a\n+++ b' }]
	writeProposals(dir, '2026-03-11', proposals)
	assert.throws(() => writeProposals(dir, '2026-03-11', proposals), /EEXIST/u)
	// 半份提案不许留在盘上。
	const jsonPath = join(dir, '2026-03-11', '01-tier.json')
	assert.equal(existsSync(jsonPath), true)
})

test('nightly proposals — a date that is not YYYY-MM-DD is refused before anything is written', () => {
	const dir = tempDir()
	assert.throws(() => writeProposals(dir, '2026/03/11', [{ file: 'a.js', why: 'w', diff: 'x' }]), /YYYY-MM-DD/u)
	assert.throws(() => writeProposals('', '2026-03-11', []), /proposalsDir 是空的/u)
	assert.equal(existsSync(join(dir, '2026-03-11')), false)
})

test('nightly proposals — a file with no usable name still gets a numbered stem', () => {
	const dir = tempDir()
	const written = writeProposals(dir, '2026-03-11', [{ file: '???', why: 'w', diff: '+x' }])
	assert.equal(written[0], join(dir, '2026-03-11', '01-proposal-1.patch'))
})

// ---------------------------------------------------------------- writeIntents

test('nightly intents — 一条意图一个 .json，没有 .patch，编号接着提案往下数', () => {
	const dir = tempDir()
	const written = writeIntents(
		dir,
		'2026-03-11',
		[{ file: 'node-plugin/lib/audit.js', why: '05:57:22 那条', change: '1. 一\n2. 二\n3. 三', verify: '跑测试' }],
		{ now: () => new Date('2026-03-10T19:20:00Z'), start: 2 },
	)
	assert.equal(written.length, 1)
	assert.equal(written[0], join(dir, '2026-03-11', '02-audit.json'))
	// intent 没有资格被 patch 应用，所以它连 .patch 都不该生成。
	assert.equal(existsSync(join(dir, '2026-03-11', '02-audit.patch')), false)
	assert.deepEqual(JSON.parse(readFileSync(written[0], 'utf8')), {
		kind: 'intent',
		title: 'audit.js',
		file: 'node-plugin/lib/audit.js',
		why: '05:57:22 那条',
		change: '1. 一\n2. 二\n3. 三',
		verify: '跑测试',
		created: '2026-03-10T19:20:00.000Z',
	})
})

test('nightly intents — 已存在的 .json 绝不覆盖，空列表连目录都不建', () => {
	const dir = tempDir()
	const intents = [{ file: 'a/audit.js', why: '05:57:22', change: '1. 一\n2. 二\n3. 三', verify: '跑测试' }]
	writeIntents(dir, '2026-03-11', intents)
	assert.throws(() => writeIntents(dir, '2026-03-11', intents), /EEXIST/u)
	assert.deepEqual(writeIntents(dir, '2026-03-12', []), [])
	assert.equal(existsSync(join(dir, '2026-03-12')), false)
	assert.throws(() => writeIntents(dir, '2026/03/11', intents), /YYYY-MM-DD/u)
})

// ---------------------------------------------------------------- clock and prompt

test('nightly clock — the zoned parts are Shanghai time, and Sunday is the deep night', () => {
	assert.deepEqual(zonedParts(WEDNESDAY), { date: '2026-03-11', hour: 3, minute: 10 })
	assert.deepEqual(zonedParts(SUNDAY), { date: '2026-03-08', hour: 3, minute: 10 })
	assert.equal(isDeepNight(SUNDAY), true)
	assert.equal(isDeepNight(WEDNESDAY), false)
})

test('nightly prompt — it carries the digest, the whole memory file and both envelopes', () => {
	const prompt = buildNightlyPrompt({ digest: '# 夜班素材 2026-03-11\n- 语音挂了 14 小时', memory: '# 记忆\n- [w:4] 旧事实', date: '2026-03-11', caps: NIGHTLY_CAPS })
	assert.match(prompt, /夜班素材 2026-03-11/u)
	assert.match(prompt, /语音挂了 14 小时/u)
	assert.match(prompt, /- \[w:4\] 旧事实/u)
	assert.match(prompt, /memory/u)
	assert.match(prompt, /proposal/u)
	assert.match(prompt, /file:/u)
	assert.match(prompt, /不超过 5/u)
})

test('nightly prompt — 明说这一轮看不见文件内容，不许写 unified diff 与 @@ 行号', () => {
	const prompt = buildNightlyPrompt({ digest: '# 夜班素材', memory: '', date: '2026-03-11', caps: NIGHTLY_CAPS })
	// 契约错在「让它写它看不见的东西」：这条话必须直白到没有解释空间。
	assert.match(prompt, /看不到任何文件内容/u)
	assert.match(prompt, /不要写 unified diff/u)
	assert.match(prompt, /不要写 @@ 行号/u)
	// 主通道是 intent，而且给了一份能过校验的例子。
	assert.match(prompt, /intent 的四个字段都是必填/u)
	assert.match(prompt, /file: node-plugin\/lib\/audit\.js/u)
	assert.match(prompt, /verify:/u)
	// proposal 只是降级，没有被拆掉。
	assert.match(prompt, /旧的 proposal 通道/u)
	assert.match(prompt, /停用/u)
})

// ---------------------------------------------------------------- QqNightlyRunner

function digestFor(dir, date, text) {
	mkdirSync(dir, { recursive: true })
	writeFileSync(join(dir, `digest-${date}.md`), text, 'utf8')
}

test('nightly runner — disabled means the clock is never consulted', async () => {
	let calls = 0
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyEnabled: false }),
		runTurn: async () => {
			calls += 1
			return ''
		},
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	assert.match(result.reason, /disabled/u)
	assert.equal(calls, 0)
})

test('nightly runner — 03:05 is too early and 03:10 is the slot', async () => await withoutRealSources(async () => {
	const seen = []
	const dir = tempDir()
	digestFor(dir, '2026-03-11', '# 夜班素材 2026-03-11\n- 一次异常')
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: dir, personaDir: join(dir, 'persona'), proposalsDir: join(dir, 'proposals') }),
		runTurn: async () => {
			seen.push('turn')
			return LEGAL_REPLY
		},
	})
	const early = await runner.tick(new Date('2026-03-10T19:05:00Z'))
	assert.equal(early.ok, false)
	assert.match(early.reason, /outside/u)
	assert.equal(seen.length, 0)
	const onTime = await runner.tick(WEDNESDAY)
	assert.equal(onTime.ok, true)
	assert.equal(seen.length, 1)
}))

test('nightly runner — a missing digest is one log line, no turn, no throw, no retry', async () => {
	const dir = tempDir()
	let calls = 0
	const lines = []
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nowhere'), personaDir: join(dir, 'persona'), proposalsDir: join(dir, 'proposals') }),
		log: (level, message) => lines.push(`${level} ${message}`),
		runTurn: async () => {
			calls += 1
			return LEGAL_REPLY
		},
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'no digest')
	assert.equal(calls, 0)
	assert.equal(lines.length, 1)
	assert.match(lines[0], /no digest/u)
	assert.equal(existsSync(join(dir, 'persona')), false)
})

test('nightly runner — a rejected round logs a snippet of what the model actually said', async () => {
	const dir = tempDir()
	const digestDir = join(dir, 'nightly')
	digestFor(digestDir, '2026-03-11', '# 夜班素材 2026-03-11\n- 语音挂了 14 小时')
	const lines = []
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: digestDir, personaDir: join(dir, 'persona'), proposalsDir: join(dir, 'proposals') }),
		log: (level, message) => lines.push(`${level} ${message}`),
		runTurn: async () => '<||DSML|| invoke name="bash">\n<||DSML|| parameter name="command" string="true">ls /',
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	const warning = lines.find((line) => line.includes('discarded'))
	assert.ok(warning !== undefined)
	assert.match(warning, /reply starts: <\|\|DSML\|\| invoke name="bash">/u)
	assert.equal(existsSync(join(dir, 'persona')), false)
})

test('nightly runner — the good night writes memory, a dated backup and the proposal files', async () => await withoutRealSources(async () => {
	const dir = tempDir()
	const persona = join(dir, 'persona')
	mkdirSync(persona, { recursive: true })
	writeFileSync(join(persona, 'MEMORY.md'), memoryFixture59(), 'utf8')
	const digestDir = join(dir, 'nightly')
	digestFor(digestDir, '2026-03-11', '# 夜班素材 2026-03-11\n- 语音挂了 14 小时')
	const audit = recorder()
	const prompts = []
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: digestDir, personaDir: persona, proposalsDir: join(dir, 'proposals') }),
		audit,
		now: () => new Date('2026-03-10T19:11:00Z'),
		runTurn: async ({ prompt, timeoutMs }) => {
			prompts.push({ prompt, timeoutMs })
			return LEGAL_REPLY
		},
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, true)
	assert.equal(prompts.length, 1)
	assert.equal(prompts[0].timeoutMs, 120_000)
	assert.match(prompts[0].prompt, /语音挂了 14 小时/u)
	assert.match(prompts[0].prompt, /长期事实第 1 条/u)

	const memory = readFileSync(join(persona, 'MEMORY.md'), 'utf8')
	assert.match(memory, /^- \[w:5\]\[k:identity\] 群里问装机预算时/mu)
	assert.match(memory, /^- \[w:3\]\[k:note\] 他说「随便」/mu)
	// 这一条是文件里本来就有的老行，格式不跟着改。
	assert.match(memory, /^- \[w:4\] 在给群里做记账机器人。$/mu)
	assert.equal(readFileSync(join(persona, 'MEMORY.md.bak-2026-03-11'), 'utf8'), memoryFixture59())
	assert.equal(existsSync(join(dir, 'proposals', '2026-03-11', '01-tier.patch')), true)
	const meta = JSON.parse(readFileSync(join(dir, 'proposals', '2026-03-11', '01-tier.json'), 'utf8'))
	assert.equal(meta.created, '2026-03-10T19:11:00.000Z')
	assert.equal(audit.records.length >= 1, true)
	assert.equal(audit.records[0].kind, 'memory_write')
	assert.equal(audit.records[0].ok, true)
	assert.match(audit.records[0].text, /\+2 行/u)
	assert.equal(runner.lastDate, '2026-03-11')
}))

test('nightly runner — 一轮 intent 只落成 .json，编号接着提案，绝不生成 .patch', async () => await withoutRealSources(async () => {
	const dir = tempDir()
	const persona = join(dir, 'persona')
	mkdirSync(persona, { recursive: true })
	writeFileSync(join(persona, 'MEMORY.md'), '# 记忆\n', 'utf8')
	digestFor(join(dir, 'nightly'), '2026-03-11', '# 夜班素材 2026-03-11\n- 语音挂了 14 小时')
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: persona, proposalsDir: join(dir, 'proposals') }),
		now: () => new Date('2026-03-10T19:11:00Z'),
		runTurn: async () => [fence('memory'), '- [w:4] 语音失败先看 stdout', fence(''), intentBlock()].join('\n'),
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, true)
	assert.equal(result.intents.length, 1)
	assert.match(result.intents[0], /01-audit\.json$/u)
	assert.equal(result.proposals.length, 0)
	const meta = JSON.parse(readFileSync(result.intents[0], 'utf8'))
	assert.equal(meta.kind, 'intent')
	assert.equal(meta.file, 'node-plugin/lib/audit.js')
	assert.equal(meta.created, '2026-03-10T19:11:00.000Z')
	assert.equal(existsSync(join(dir, 'proposals', '2026-03-11', '01-audit.patch')), false)
	assert.match(readFileSync(join(persona, 'MEMORY.md'), 'utf8'), /语音失败先看 stdout/u)
}))

test('nightly runner — 被丢掉的 intent 原因进日志，记忆照写、整轮不作废', async () => await withoutRealSources(async () => {
	const dir = tempDir()
	const persona = join(dir, 'persona')
	mkdirSync(persona, { recursive: true })
	writeFileSync(join(persona, 'MEMORY.md'), '# 记忆\n', 'utf8')
	digestFor(join(dir, 'nightly'), '2026-03-11', '# 夜班素材 2026-03-11\n- 一次异常')
	const lines = []
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: persona, proposalsDir: join(dir, 'proposals') }),
		log: (level, message) => lines.push(`${level} ${message}`),
		runTurn: async () => [fence('memory'), '- [w:3] 失败先看 stdout', fence(''), intentBlock({ file: 'agent/src/asr.js' })].join('\n'),
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, true)
	assert.equal(result.intents.length, 0)
	const warning = lines.find((line) => line.includes('block(s) dropped'))
	assert.ok(warning !== undefined, '被丢掉的 intent 必须留下原因')
	assert.match(warning, /不在真实清单里/u)
	assert.match(warning, /agent\/src\/asr\.js/u)
	// 记忆照写：丢一条意图不该连累整轮。
	assert.match(readFileSync(join(persona, 'MEMORY.md'), 'utf8'), /失败先看 stdout/u)
	assert.equal(existsSync(join(dir, 'proposals', '2026-03-11')), false)
}))

test('nightly runner — the Sunday run gets the deep budget', async () => {
	const dir = tempDir()
	mkdirSync(join(dir, 'persona'), { recursive: true })
	digestFor(join(dir, 'nightly'), '2026-03-08', '# 夜班素材 2026-03-08\n- 一次异常')
	const timeouts = []
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: join(dir, 'persona'), proposalsDir: join(dir, 'proposals') }),
		runTurn: async ({ timeoutMs }) => {
			timeouts.push(timeoutMs)
			return LEGAL_REPLY
		},
	})
	const result = await runner.tick(SUNDAY)
	assert.equal(result.ok, true)
	assert.equal(timeouts[0], 180_000)
})

test('nightly runner — an unparsable reply is discarded whole and audited, and not retried that night', async () => {
	const dir = tempDir()
	const persona = join(dir, 'persona')
	mkdirSync(persona, { recursive: true })
	const before = memoryFixture59()
	writeFileSync(join(persona, 'MEMORY.md'), before, 'utf8')
	digestFor(join(dir, 'nightly'), '2026-03-11', '# 夜班素材 2026-03-11\n- 一次异常')
	const audit = recorder()
	const lines = []
	let calls = 0
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: persona, proposalsDir: join(dir, 'proposals') }),
		audit,
		log: (level, message) => lines.push(`${level} ${message}`),
		runTurn: async () => {
			calls += 1
			return [fence('memory'), '- [w:9] 权重越界', fence('')].join('\n')
		},
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	assert.match(result.reason, /parse failed/u)
	assert.equal(calls, 1)
	assert.equal(readFileSync(join(persona, 'MEMORY.md'), 'utf8'), before)
	assert.equal(existsSync(join(persona, 'MEMORY.md.bak-2026-03-11')), false)
	assert.equal(existsSync(join(dir, 'proposals')), false)
	assert.equal(audit.records.length, 1)
	assert.equal(audit.records[0].ok, false)
	assert.match(audit.records[0].text, /作废/u)
	assert.match(lines.at(-1), /discarded/u)
	const again = await runner.tick(new Date('2026-03-10T19:30:00Z'))
	assert.equal(again.ok, false)
	assert.match(again.reason, /already ran/u)
	assert.equal(calls, 1)
})

test('nightly runner — over the caps is discarded too, with no truncation', async () => {
	const dir = tempDir()
	const persona = join(dir, 'persona')
	mkdirSync(persona, { recursive: true })
	const before = memoryFixture59()
	writeFileSync(join(persona, 'MEMORY.md'), before, 'utf8')
	digestFor(join(dir, 'nightly'), '2026-03-11', '# 夜班素材 2026-03-11\n- 一次异常')
	const six = ['- [w:4] 一', '- [w:4] 二', '- [w:4] 三', '- [w:4] 四', '- [w:4] 五', '- [w:4] 六']
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: persona, proposalsDir: join(dir, 'proposals'), nightlyMaxMemories: 5 }),
		runTurn: async () => [fence('memory'), ...six, fence('')].join('\n'),
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	assert.match(result.reason, /over the caps/u)
	assert.equal(readFileSync(join(persona, 'MEMORY.md'), 'utf8'), before)
})

test('nightly runner — a failed turn is logged and writes nothing, and does not crash', async () => {
	const dir = tempDir()
	mkdirSync(join(dir, 'persona'), { recursive: true })
	digestFor(join(dir, 'nightly'), '2026-03-11', '# 夜班素材 2026-03-11\n- 一次异常')
	const lines = []
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: join(dir, 'persona'), proposalsDir: join(dir, 'proposals') }),
		log: (level, message) => lines.push(`${level} ${message}`),
		runTurn: async () => {
			const error = new Error('the turn ran out of time')
			error.name = 'TurnTimeoutError'
			throw error
		},
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'turn failed')
	assert.match(lines.at(-1), /turn timeout/u)
	assert.equal(existsSync(join(dir, 'persona', 'MEMORY.md')), false)
})

test('nightly runner — an unwritable persona path is caught, logged, and never crashes the plugin', async () => {
	const dir = tempDir()
	// personaDir 指到一个**文件**上：mkdir 与写 MEMORY.md 都会失败。
	const personaFile = join(dir, 'persona')
	writeFileSync(personaFile, 'not a directory', 'utf8')
	digestFor(join(dir, 'nightly'), '2026-03-11', '# 夜班素材 2026-03-11\n- 一次异常')
	const lines = []
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: personaFile, proposalsDir: join(dir, 'proposals') }),
		log: (level, message) => lines.push(`${level} ${message}`),
		runTurn: async () => LEGAL_REPLY,
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'memory write failed')
	assert.match(lines.at(-1), /failed/u)
	assert.equal(existsSync(join(dir, 'proposals')), false)
})

test('nightly runner — a digest over the line cap is skipped instead of truncated', async () => {
	const dir = tempDir()
	mkdirSync(join(dir, 'persona'), { recursive: true })
	const digest = ['# 夜班素材 2026-03-11', ...Array.from({ length: 200 }, (_, index) => `- 异常 ${index}`)].join('\n')
	digestFor(join(dir, 'nightly'), '2026-03-11', digest)
	let calls = 0
	const runner = new QqNightlyRunner({
		ctx: undefined,
		options: nightlyOptions({ nightlyDigestDir: join(dir, 'nightly'), personaDir: join(dir, 'persona'), proposalsDir: join(dir, 'proposals') }),
		runTurn: async () => {
			calls += 1
			return LEGAL_REPLY
		},
	})
	const result = await runner.tick(WEDNESDAY)
	assert.equal(result.ok, false)
	assert.equal(result.reason, 'digest too long')
	assert.equal(calls, 0)
})

test('nightly turn — it runs through the real session store as a locked-down non-owner turn', async () => {
	let captured
	const runtime = createFakeRuntime({
		reply: ({ agent }) => {
			captured = agent
			return { text: LEGAL_REPLY }
		},
	})
	const reply = await runNightlyTurn({
		ctx: runtime.ctx,
		options: nightlyOptions(),
		prompt: '# 夜班素材 2026-03-11\n- 一次异常',
		timeoutMs: 5_000,
		date: '2026-03-11',
	})
	assert.equal(reply.trimEnd(), LEGAL_REPLY.trimEnd())
	assert.equal(runtime.stats.turnsStarted, 1)
	assert.ok(captured !== undefined, 'the turn must have created an agent')
	// 输入是块数组（字符串会让别的插件抛 TypeError），而且带上了夜班素材。
	assert.ok(Array.isArray(captured.lastMessage.content))
	assert.match(captured.lastMessage.content.map((block) => block.text).join('\n'), /夜班素材 2026-03-11/u)
	// 非主人会话：工具被 guard + restrict 全封死，于是「夜班绝不改代码」是构造出来的。
	const tools = runtime.toolsFor(captured)
	assert.equal(typeof tools.denyReason(), 'string')
	assert.ok(tools.restrictions.some((entry) => Array.isArray(entry?.allow) && entry.allow.length === 0))
})

// ---------------------------------------------------------------- config wiring

test('nightly config — off by default, 03:00 hour, and proposals next to persona/', () => {
	const options = resolveOptions({})
	assert.equal(options.nightlyEnabled, false)
	assert.equal(options.nightlyHour, 3)
	assert.equal(options.nightlyTimeoutMs, 120_000)
	assert.equal(options.nightlyMaxMemories, 5)
	assert.equal(options.nightlyMaxProposals, 3)
	assert.equal(options.nightlyDigestDir, '/var/lib/dsh-qq-agent/nightly')
	assert.equal(options.proposalsDir, join(options.personaDir, '..', 'proposals'))
})

test('nightly config — hour 0 is legal, hour 25 falls back to 03:00, and proposalsDir can be pinned', () => {
	assert.equal(resolveOptions({ nightlyHour: 0 }).nightlyHour, 0)
	assert.equal(resolveOptions({ nightlyHour: 23 }).nightlyHour, 23)
	assert.equal(resolveOptions({ nightlyHour: 25 }).nightlyHour, 3)
	assert.equal(resolveOptions({ nightlyHour: 2.5 }).nightlyHour, 3)
	assert.equal(resolveOptions({ proposalsDir: '/tmp/proposals' }).proposalsDir, '/tmp/proposals')
	assert.equal(resolveOptions({ nightlyEnabled: true }).nightlyEnabled, true)
	assert.equal(resolveOptions({ nightlyMaxMemories: 4 }).nightlyMaxMemories, 4)
})

// ---------------------------------------------------------------- hunk 行数校正

test('recountPatchHunks — 行数本来就对的 diff 一个字节都不改', () => {
	const diff = [
		'--- a/node-plugin/lib/x.js',
		'+++ b/node-plugin/lib/x.js',
		'@@ -10,3 +10,4 @@ function f() {',
		' a',
		'-b',
		'+B',
		'+B2',
		' c',
	].join('\n')
	assert.equal(recountPatchHunks(diff), diff)
})

test('recountPatchHunks — 头里数字写错时按正文重算（线上 10-27 那两份就是这么废的）', () => {
	const broken = [
		'--- a/node-plugin/lib/session.js',
		'+++ b/node-plugin/lib/session.js',
		'@@ -52,6 +52,9 @@',
		' \tconst text = await runTurn(ctx);',
		' \tif (!text) {',
		'+\t\tif (ctx.needsReply) await deliver(ctx, "我在，你说");',
		' \t\treturn;',
		' \t}',
	].join('\n')
	const fixed = recountPatchHunks(broken)
	assert.match(fixed, /^@@ -52,4 \+52,5 @@$/m)
	// 正文一字不动，只换头
	assert.deepEqual(fixed.split('\n').slice(3), broken.split('\n').slice(3))
})

test('recountPatchHunks — 只有 @@ 没有行号时补出行号，起点接着上一个 hunk', () => {
	const diff = [
		'--- a/x',
		'+++ b/x',
		'@@ -1,1 +1,1 @@',
		'-a',
		'+b',
		'@@',
		'-c',
		'+d',
	].join('\n')
	const fixed = recountPatchHunks(diff)
	const headers = fixed.split('\n').filter((line) => line.startsWith('@@'))
	assert.deepEqual(headers, ['@@ -1,1 +1,1 @@', '@@ -2,1 +2,1 @@'])
})

test('recountPatchHunks — hunk 里的真空行按空上下文行算并补回前导空格', () => {
	const diff = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', ' a', '', '-b', '+c'].join('\n')
	const fixed = recountPatchHunks(diff)
	assert.match(fixed, /^@@ -1,3 \+1,3 @@$/m)
	assert.deepEqual(fixed.split('\n').slice(3), [' a', ' ', '-b', '+c'])
})

test('recountPatchHunks — 正文混进散文就原样返回，不在解析层瞎猜', () => {
	const diff = ['--- a/x', '+++ b/x', '@@ -1,2 +1,2 @@', '这是说明文字', '-a', '+b'].join('\n')
	assert.equal(recountPatchHunks(diff), diff)
})

test('recountPatchHunks — 没有 hunk 头的文本原样返回，CRLF 归一', () => {
	const plain = '--- a/x\r\n+++ b/x\r\n'
	assert.equal(recountPatchHunks(plain), '--- a/x\n+++ b/x\n')
	assert.equal(recountPatchHunks(''), '')
	assert.equal(recountPatchHunks(undefined), '')
})

test('nightly parse — 畸形 hunk 存盘前已被校正，parse 本身不因此整轮作废', () => {
	const reply = [
		fence('proposal'),
		'file: node-plugin/lib/tier.js',
		'why: 短句被误判成低档',
		'---',
		'--- a/node-plugin/lib/tier.js',
		'+++ b/node-plugin/lib/tier.js',
		'@@ -1,2 +1,2 @@',
		'-const light = text.length < 40',
		'+const light = text.length < 24',
		fence(''),
	].join('\n')
	const result = parseNightlyOutput(reply)
	assert.equal(result.ok, true)
	assert.match(result.proposals[0].diff, /^@@ -1,1 \+1,1 @@$/m)
})
