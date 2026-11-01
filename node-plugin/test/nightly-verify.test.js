import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NIGHTLY_CAPS, PROPOSAL_MAX_BYTES, readProposalSource, resolveProposalPath, verifyPatchAgainstText, writeProposals } from '../lib/nightly.js'
import { QqNightlyRunner, buildRepairPrompt } from '../lib/nightly-runner.js'

/**
 * 提案「落地自检」：《夜班产出的 diff 打不上真实文件》那一类事故的回归测试。
 *
 * 两种层次都要盯：`verifyPatchAgainstText` 是判定器（纯函数，直接喂字符串），
 * `QqNightlyRunner` 是编排（读真实文件、补救一次、标记未通过）。前者错了后者的
 * 结论必然错；后者错了前者的正确判定也没人用。
 */

/** 三反引号在模板串里要转义，索性拼出来，免得整份测试变成反斜杠展览。 */
const fence = (language) => `${'`'.repeat(3)}${language}`

/** 2026-03-11 03:10 Asia/Shanghai（周三）。 */
const WEDNESDAY = new Date('2026-03-10T19:10:00Z')

const TEMP_DIRS = []
test.after(() => {
	for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), 'qq-nightly-verify-'))
	TEMP_DIRS.push(dir)
	return dir
}

/** 一份「真实文件」：下面所有 diff 都对着它的 7 行较真。 */
const SOURCE_LINES = [
	'/** 主动开口的闸门：沉默够了才说话。 */',
	'const GAPS = [30, 90, 240]',
	'',
	'export function shouldSpeak(ctx) {',
	'\tif (ctx.quiet === true) return false',
	'\treturn ctx.pending === 0',
	'}',
]
const SOURCE = `${SOURCE_LINES.join('\n')}\n`

/** 上下文与删除行逐字抄自 SOURCE：打得上的那一份。 */
const GOOD_DIFF = [
	'--- a/node-plugin/lib/proactive.js',
	'+++ b/node-plugin/lib/proactive.js',
	'@@ -4,4 +4,5 @@',
	` ${SOURCE_LINES[3]}`,
	` ${SOURCE_LINES[4]}`,
	'+\tif (ctx.muted === true) return false',
	` ${SOURCE_LINES[5]}`,
	` ${SOURCE_LINES[6]}`,
].join('\n')

/** 正文一字不改，只把行号写成 88：patch 也是按上下文找，这依然打得上去。 */
const OFFSET_DIFF = GOOD_DIFF.replace('@@ -4,4 +4,5 @@', '@@ -88,4 +88,5 @@')

/** 2026-10-28 那两份提案的形状：函数名与上下文全是编的。 */
const INVENTED_DIFF = [
	'--- a/node-plugin/lib/proactive.js',
	'+++ b/node-plugin/lib/proactive.js',
	'@@ -47,4 +47,6 @@',
	' export function choose(ctx) {',
	' \tif (ctx.gap > 0) return { text: \'\' }',
	'-\treturn choose(ctx)',
	'+\treturn pick(ctx)',
	' }',
].join('\n')

/** 补救轮该交上来的那一份：上下文抄对了。 */
const REPAIRED_DIFF = [
	'--- a/node-plugin/lib/proactive.js',
	'+++ b/node-plugin/lib/proactive.js',
	'@@ -5,2 +5,3 @@',
	` ${SOURCE_LINES[4]}`,
	'+\tif (ctx.muted === true) return false',
	` ${SOURCE_LINES[5]}`,
].join('\n')

// ---------------------------------------------------------------- verifyPatchAgainstText

test('nightly verify — 上下文真的在文件里就判打得上去', () => {
	const result = verifyPatchAgainstText(GOOD_DIFF, SOURCE)
	assert.deepEqual(result, { ok: true, hunks: 1 })
})

test('nightly verify — 行号写错但上下文真实存在时仍然判 true，第二段接着往后找', () => {
	assert.equal(verifyPatchAgainstText(OFFSET_DIFF, SOURCE).ok, true)
	const twoHunks = [
		'--- a/node-plugin/lib/proactive.js',
		'+++ b/node-plugin/lib/proactive.js',
		'@@ -1,1 +1,1 @@',
		` ${SOURCE_LINES[0]}`,
		'@@ -4,2 +4,2 @@',
		` ${SOURCE_LINES[3]}`,
		` ${SOURCE_LINES[4]}`,
	].join('\n')
	assert.deepEqual(verifyPatchAgainstText(twoHunks, SOURCE), { ok: true, hunks: 2 })
})

test('nightly verify — 凭空编的上下文判失败，原因里带行号与期望/实际', () => {
	const result = verifyPatchAgainstText(INVENTED_DIFF, SOURCE)
	assert.equal(result.ok, false)
	assert.equal(result.hunk, 1)
	assert.equal(result.line, 47)
	assert.match(result.reason, /hunk #1/u)
	assert.match(result.reason, /第 47 行/u)
	// 期望的那一行原样引在原因里：人一眼能看出模型编了个 choose()
	assert.match(result.reason, /choose\(ctx\)/u)
})

test('nightly verify — 上下文前半真、后半假时指出具体是哪一行对不上', () => {
	const halfReal = [
		'--- a/node-plugin/lib/proactive.js',
		'+++ b/node-plugin/lib/proactive.js',
		'@@ -4,3 +4,3 @@',
		` ${SOURCE_LINES[3]}`,
		'-\tif (ctx.quiet === false) return false',
		'+\tif (ctx.quiet === false) return true',
	].join('\n')
	const result = verifyPatchAgainstText(halfReal, SOURCE)
	assert.equal(result.ok, false)
	assert.equal(result.line, 4)
	assert.match(result.reason, /第 5 行对不上/u)
	assert.match(result.reason, /ctx\.quiet === false/u)
})

test('nightly verify — 文件与 diff 都以换行收尾时不多算一行，结论不变', () => {
	// 写盘的 .patch 与真实文件都以 '\n' 收尾：结尾的换行不是一行空上下文。
	assert.deepEqual(verifyPatchAgainstText(`${GOOD_DIFF}\n`, SOURCE), { ok: true, hunks: 1 })
	assert.deepEqual(verifyPatchAgainstText(GOOD_DIFF, SOURCE.trimEnd()), { ok: true, hunks: 1 })
	assert.deepEqual(verifyPatchAgainstText(`${GOOD_DIFF}\n`, SOURCE.trimEnd()), { ok: true, hunks: 1 })
	// 但 hunk 中间那个真空行仍然是真空行，得对上。
	const blankInside = ['--- a/x', '+++ b/x', '@@ -2,3 +2,3 @@', ` ${SOURCE_LINES[1]}`, ' ', ` ${SOURCE_LINES[3]}`].join('\n')
	assert.equal(verifyPatchAgainstText(blankInside, SOURCE).ok, true)
})

test('nightly verify — 只有文件头没有 @@ 的 diff 什么也改不了，判失败', () => {
	const result = verifyPatchAgainstText('--- a/node-plugin/lib/proactive.js\n+++ b/node-plugin/lib/proactive.js', SOURCE)
	assert.equal(result.ok, false)
	assert.match(result.reason, /@@/u)
})

// ---------------------------------------------------------------- 真实路径与读取规则

test('nightly verify — 三个前缀映射到服务器布局，.. 与别的扩展名一律拒绝', () => {
	const pathOf = (file, env = {}) => String(resolveProposalPath(file, { env }).path).replace(/\\/gu, '/')
	assert.equal(pathOf('node-plugin/lib/tier.js'), '/opt/dsh-qq-agent/node-plugin/lib/tier.js')
	assert.equal(pathOf('bridge/src/proactive.js'), '/opt/dsh-qq-bridge/src/proactive.js')
	assert.equal(pathOf('deploy/nightly.sh'), '/opt/dsh-qq-agent/deploy/nightly.sh')
	// 本机调试的出口：只覆盖 node-plugin/ 这一个根目录。
	assert.equal(pathOf('node-plugin/lib/x.mjs', { DSH_QQ_NODE_PLUGIN_DIR: 'C:\\tmp\\ai\\node-plugin' }), 'C:/tmp/ai/node-plugin/lib/x.mjs')

	assert.match(resolveProposalPath('node-plugin/../lib/tier.js', { env: {} }).reason, /\.\./u)
	assert.match(resolveProposalPath('bridge/src/../../etc/passwd.js', { env: {} }).reason, /\.\./u)
	assert.match(resolveProposalPath('bridge/src/asr.ts', { env: {} }).reason, /\.js \/ \.mjs \/ \.sh/u)
	assert.match(resolveProposalPath('Cloudflare/worker.js', { env: {} }).reason, /前缀/u)
	for (const bad of ['', '   ', 'node-plugin/../x.js', 'node-plugin/lib/x.ts', 'node-plugin/lib/x', 'Cloudflare/worker.js', '/etc/passwd.sh', '../bridge/src/x.js']) {
		assert.equal(resolveProposalPath(bad, { env: {} }).ok, false)
	}
})

test('nightly verify — 目标文件超过 24KB 直接判为不可补救，原因写明文件过大', () => {
	const dir = tempDir()
	const root = join(dir, 'node-plugin')
	mkdirSync(join(root, 'lib'), { recursive: true })
	writeFileSync(join(root, 'lib', 'big.js'), 'x'.repeat(PROPOSAL_MAX_BYTES + 1), 'utf8')
	writeFileSync(join(root, 'lib', 'edge.js'), 'x'.repeat(PROPOSAL_MAX_BYTES), 'utf8')
	const env = { DSH_QQ_NODE_PLUGIN_DIR: root }
	const big = readProposalSource('node-plugin/lib/big.js', { env })
	assert.equal(big.ok, false)
	assert.match(big.reason, /文件过大/u)
	assert.match(big.reason, /big\.js/u)
	// 正好 24KB 还算读得动：边界不能一刀切在「等于」上。
	assert.equal(readProposalSource('node-plugin/lib/edge.js', { env }).ok, true)
	assert.equal(readProposalSource('node-plugin/lib/missing.js', { env }).ok, false)
})

// ---------------------------------------------------------------- 元数据与补救提示

test('nightly proposals — 只有知道自检结论时才写 verified 字段', () => {
	const plainDir = tempDir()
	writeProposals(plainDir, '2026-03-11', [{ file: 'node-plugin/lib/x.js', why: 'w', diff: '+x' }])
	const plain = JSON.parse(readFileSync(join(plainDir, '2026-03-11', '01-x.json'), 'utf8'))
	assert.deepEqual(Object.keys(plain), ['title', 'why', 'files', 'created'])

	const failedDir = tempDir()
	writeProposals(failedDir, '2026-03-11', [{ file: 'node-plugin/lib/y.js', why: 'w', diff: '+y', verified: false, verifyReason: 'hunk #1 第 3 行对不上' }])
	const failed = JSON.parse(readFileSync(join(failedDir, '2026-03-11', '01-y.json'), 'utf8'))
	assert.equal(failed.verified, false)
	assert.match(failed.verifyReason, /hunk #1/u)

	const passedDir = tempDir()
	writeProposals(passedDir, '2026-03-11', [{ file: 'node-plugin/lib/z.js', why: 'w', diff: '+z', verified: true }])
	const passed = JSON.parse(readFileSync(join(passedDir, '2026-03-11', '01-z.json'), 'utf8'))
	assert.equal(passed.verified, true)
	assert.equal('verifyReason' in passed, false)
})

test('nightly verify — 补救提示里只有这一个文件的真实全文与失败原因', () => {
	const prompt = buildRepairPrompt({
		file: 'node-plugin/lib/proactive.js',
		diff: INVENTED_DIFF,
		reason: 'hunk #1 按顺序找不到（从第 47 行起，4 行上下文/删除行）',
		source: SOURCE,
		date: '2026-10-28',
		caps: NIGHTLY_CAPS,
	})
	assert.match(prompt, /node-plugin\/lib\/proactive\.js/u)
	assert.match(prompt, /hunk #1/u)
	assert.match(prompt, /第 47 行/u)
	// 真实全文里的那一行必须原样摆着，模型才有东西可抄。
	assert.match(prompt, /export function shouldSpeak\(ctx\) \{/u)
	assert.match(prompt, /不超过 120 行/u)
	assert.match(prompt, /没有任何工具/u)
	// 不收集里别的上下文：这一轮只谈一个文件。
	assert.equal(prompt.includes('MEMORY.md'), false)
})

// ---------------------------------------------------------------- QqNightlyRunner

/** 本机没有 /opt 那棵树：用环境变量把 node-plugin/ 指到临时目录上，用完还原。 */
async function withPluginDir(root, body) {
	const previous = process.env.DSH_QQ_NODE_PLUGIN_DIR
	process.env.DSH_QQ_NODE_PLUGIN_DIR = root
	try {
		return await body()
	} finally {
		if (previous === undefined) delete process.env.DSH_QQ_NODE_PLUGIN_DIR
		else process.env.DSH_QQ_NODE_PLUGIN_DIR = previous
	}
}

function pluginTree() {
	const dir = tempDir()
	const root = join(dir, 'node-plugin')
	mkdirSync(join(root, 'lib'), { recursive: true })
	writeFileSync(join(root, 'lib', 'proactive.js'), SOURCE, 'utf8')
	return { dir, root }
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

/** 清单 + 空 persona + 提案目录：一次夜班需要的三处路径。 */
function workspaceFiles(dir) {
	const digestDir = join(dir, 'nightly')
	mkdirSync(digestDir, { recursive: true })
	writeFileSync(join(digestDir, 'digest-2026-03-11.md'), '# 夜班素材 2026-03-11\n- 主动开口的闸门没生效\n', 'utf8')
	const personaDir = join(dir, 'persona')
	mkdirSync(personaDir, { recursive: true })
	return { nightlyDigestDir: digestDir, personaDir, proposalsDir: join(dir, 'proposals') }
}

function replyWithDiff(diff, { file = 'node-plugin/lib/proactive.js', why = '闸门漏了静音判断' } = {}) {
	return [fence('proposal'), `file: ${file}`, `why: ${why}`, '---', diff, fence('')].join('\n')
}

function expectOk(result) {
	assert.equal(result.ok, true, `这一夜应该跑完，实际停在：${result.reason ?? '(没有 reason)'}`)
	return result
}

function metaAt(proposalsDir, stem = '01-proactive') {
	return JSON.parse(readFileSync(join(proposalsDir, '2026-03-11', `${stem}.json`), 'utf8'))
}

test('nightly self-check — 打得上的提案落 verified: true，不额外跑一轮', async () => {
	const { dir, root } = pluginTree()
	const files = workspaceFiles(dir)
	let calls = 0
	await withPluginDir(root, async () => {
		const runner = new QqNightlyRunner({
			ctx: undefined,
			options: nightlyOptions(files),
			runTurn: async () => {
				calls += 1
				return replyWithDiff(GOOD_DIFF)
			},
		})
		const result = await runner.tick(WEDNESDAY)
		assert.equal(result.ok, true)
	})
	assert.equal(calls, 1)
	const meta = metaAt(files.proposalsDir)
	assert.equal(meta.verified, true)
	assert.equal('verifyReason' in meta, false)
	assert.match(readFileSync(join(files.proposalsDir, '2026-03-11', '01-proactive.patch'), 'utf8'), /ctx\.muted === true/u)
})

test('nightly self-check — 编出来的上下文判 verified: false，verifyReason 带行号', async () => {
	const { dir, root } = pluginTree()
	const files = workspaceFiles(dir)
	let calls = 0
	await withPluginDir(root, async () => {
		const runner = new QqNightlyRunner({
			ctx: undefined,
			options: nightlyOptions(files),
			runTurn: async () => {
				calls += 1
				return replyWithDiff(INVENTED_DIFF)
			},
		})
		expectOk(await runner.tick(WEDNESDAY))
	})
	// 一次正轮 + 一次补救：补救也救不回来，但提案照样落盘，只是标了未通过。
	assert.equal(calls, 2)
	const meta = metaAt(files.proposalsDir)
	assert.equal(meta.verified, false)
	assert.match(meta.verifyReason, /第 47 行/u)
	assert.match(meta.verifyReason, /choose\(ctx\)/u)
	assert.match(readFileSync(join(files.proposalsDir, '2026-03-11', '01-proactive.patch'), 'utf8'), /choose\(ctx\)/u)
})

test('nightly self-check — 补救一次后打得上了，落盘的是补救后的 diff', async () => {
	const { dir, root } = pluginTree()
	const files = workspaceFiles(dir)
	const prompts = []
	await withPluginDir(root, async () => {
		const runner = new QqNightlyRunner({
			ctx: undefined,
			options: nightlyOptions(files),
			runTurn: async ({ prompt }) => {
				prompts.push(prompt)
				return prompts.length === 1 ? replyWithDiff(INVENTED_DIFF) : replyWithDiff(REPAIRED_DIFF)
			},
		})
		expectOk(await runner.tick(WEDNESDAY))
	})
	assert.equal(prompts.length, 2)
	// 补救提示里必须真的带着目标文件的全文，否则模型还是只能靠猜。
	assert.match(prompts[1], /export function shouldSpeak\(ctx\) \{/u)
	assert.match(prompts[1], /hunk #1/u)
	const meta = metaAt(files.proposalsDir)
	assert.equal(meta.verified, true)
	assert.equal('verifyReason' in meta, false)
	const patch = readFileSync(join(files.proposalsDir, '2026-03-11', '01-proactive.patch'), 'utf8')
	assert.match(patch, /ctx\.muted === true/u)
	assert.equal(patch.includes('choose(ctx)'), false)
})

test('nightly self-check — 补救只做一次，第三条提示永远不会发出', async () => {
	const { dir, root } = pluginTree()
	const files = workspaceFiles(dir)
	let calls = 0
	let runner
	await withPluginDir(root, async () => {
		runner = new QqNightlyRunner({
			ctx: undefined,
			options: nightlyOptions(files),
			runTurn: async () => {
				calls += 1
				return replyWithDiff(INVENTED_DIFF)
			},
		})
		expectOk(await runner.tick(WEDNESDAY))
	})
	assert.equal(calls, 2)
	const meta = metaAt(files.proposalsDir)
	assert.equal(meta.verified, false)
	// 这一夜不重跑：同一个窗口里再 tick 一次也不会再多一条提示。
	const again = await runner.tick(new Date('2026-03-10T19:30:00Z'))
	assert.equal(again.ok, false)
	assert.match(again.reason, /already ran/u)
	assert.equal(calls, 2)
})

test('nightly self-check — 文件超过 24KB 时不补救，直接 verified: false 并写明文件过大', async () => {
	const { dir, root } = pluginTree()
	// 前 7 行还是那份真实文件：只要读得到，GOOD_DIFF 本来打得上去。
	writeFileSync(join(root, 'lib', 'proactive.js'), `${SOURCE}${'// 填充一行让文件变胖\n'.repeat(2000)}`, 'utf8')
	const files = workspaceFiles(dir)
	let calls = 0
	await withPluginDir(root, async () => {
		const runner = new QqNightlyRunner({
			ctx: undefined,
			options: nightlyOptions(files),
			runTurn: async () => {
				calls += 1
				return replyWithDiff(GOOD_DIFF)
			},
		})
		expectOk(await runner.tick(WEDNESDAY))
	})
	assert.equal(calls, 1)
	const meta = metaAt(files.proposalsDir)
	assert.equal(meta.verified, false)
	assert.match(meta.verifyReason, /文件过大/u)
	assert.match(meta.verifyReason, /24KB|24576/u)
})

test('nightly self-check — 路径里出现 .. 时拒绝读取，自检连试都不试', async () => {
	const { dir, root } = pluginTree()
	const files = workspaceFiles(dir)
	let calls = 0
	await withPluginDir(root, async () => {
		const runner = new QqNightlyRunner({
			ctx: undefined,
			options: nightlyOptions(files),
			runTurn: async () => {
				calls += 1
				return replyWithDiff(GOOD_DIFF, { file: 'node-plugin/lib/../lib/proactive.js' })
			},
		})
		expectOk(await runner.tick(WEDNESDAY))
	})
	assert.equal(calls, 1)
	const meta = metaAt(files.proposalsDir)
	assert.equal(meta.verified, false)
	assert.match(meta.verifyReason, /\.\./u)
	assert.match(meta.verifyReason, /拒绝/u)
})
