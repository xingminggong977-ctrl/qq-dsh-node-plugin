import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
	CORRECTION_FILE,
	CORRECTION_MAX_LINES,
	createCorrectionBook,
	correctionBody,
	isCorrection,
	mergeCorrections,
	normalizeCorrection,
} from '../lib/correction.js'
import { QqPersona, trackQqSession } from '../lib/persona.js'

const dirs = []
function tmp() {
	const dir = mkdtempSync(join(tmpdir(), 'qq-corrections-'))
	dirs.push(dir)
	return dir
}

test('isCorrection — standing instructions are caught, feelings are not', () => {
	// 明确的要求
	assert.equal(isCorrection('以后别在群里叫我宝贝'), true)
	assert.equal(isCorrection('下次我说吃饭你就直接说好'), true)
	assert.equal(isCorrection('记住我不吃香菜'), true)
	assert.equal(isCorrection('你别老发表情包'), true)
	assert.equal(isCorrection('我喜欢你叫我小D'), true)
	// 单纯的情绪与闲聊不该被当成规矩
	assert.equal(isCorrection('我受不了今天好热'), false)
	assert.equal(isCorrection('今天加班到十点'), false)
	assert.equal(isCorrection('哈哈哈'), false)
	assert.equal(isCorrection(''), false)
	assert.equal(isCorrection(undefined), false)
	// 太长的一段话不是一条规矩
	assert.equal(isCorrection(`记住${'啊'.repeat(300)}`), false)
})

test('normalizeCorrection — one line, no quotes, bounded', () => {
	assert.equal(normalizeCorrection('  以后  别在\n群里叫我「宝贝」 '), '以后 别在 群里叫我宝贝')
	assert.equal(normalizeCorrection('   '), '')
	assert.equal(normalizeCorrection(null), '')
	const long = normalizeCorrection('记住' + '啊'.repeat(400))
	assert.equal([...long].length, 200)
})

test('mergeCorrections — newest last, duplicates dropped, capped', () => {
	const merged = mergeCorrections(['- [2026-10-20] 记住我不吃香菜'], ['记住我不吃香菜', '以后别叫我宝贝'], '2026-10-25')
	assert.deepEqual(merged, ['- [2026-10-25] 记住我不吃香菜', '- [2026-10-25] 以后别叫我宝贝'])

	const many = Array.from({ length: CORRECTION_MAX_LINES + 5 }, (_, index) => `规矩${index}`)
	const capped = mergeCorrections([], many, '2026-10-25')
	assert.equal(capped.length, CORRECTION_MAX_LINES)
	// 留下的是**最新**的那批，最老的先掉出去
	assert.equal(correctionBody(capped[capped.length - 1]), `规矩${many.length - 1}`)
	assert.equal(correctionBody(capped[0]), `规矩${many.length - CORRECTION_MAX_LINES}`)
})

test('createCorrectionBook — appends, survives a missing file, never throws', () => {
	const dir = tmp()
	const file = join(dir, 'nested', CORRECTION_FILE)
	const book = createCorrectionBook({ file, now: () => Date.parse('2026-10-25T10:00:00Z') })
	assert.equal(book.read(), '')
	assert.equal(book.add('以后别在群里叫我宝贝'), true)
	assert.match(readFileSync(file, 'utf8'), /^- \[2026-10-25\] 以后别在群里叫我宝贝$/mu)
	// 同一条规矩重复说，不会堆成两行
	assert.equal(book.add('以后别在群里叫我宝贝'), true)
	assert.equal(book.read().trim().split('\n').length, 1)
	// 空内容不进文件
	assert.equal(book.add('   '), false)
	// 写不进去时只报警，不抛
	const broken = createCorrectionBook({ file: join(dir, 'file.txt', 'x.md'), log: () => {} })
	writeFileSync(join(dir, 'file.txt'), 'not a directory')
	assert.equal(broken.add('记住我不吃香菜'), false)
})

test('QqPersona — rules are injected under their own heading and never decay', () => {
	const dir = tmp()
	const personaDir = join(dir, 'persona')
	mkdirSync(personaDir, { recursive: true })
	writeFileSync(join(personaDir, 'PERSONA.md'), '# 关于小D\n\n我是小D。\n')
	writeFileSync(join(personaDir, 'MEMORY.md'), '他喜欢喝冰美式。\n')
	writeFileSync(join(personaDir, CORRECTION_FILE), '- [2026-10-25] 以后别在群里叫我宝贝\n')

	const persona = new QqPersona({ personaDir, log: () => {} })
	trackQqSession('qq-rules', true)
	const snapshot = persona.snapshot({ agent: { session: { id: 'qq-rules' } } })
	assert.match(snapshot.text, /## 他给你立的规矩\n\n- \[2026-10-25\] 以后别在群里叫我宝贝/u)
	// 规矩排在记忆之前
	assert.ok(
		snapshot.text.indexOf('## 他给你立的规矩') < snapshot.text.indexOf('## 长期记忆'),
		'rules must come before memory, so fading memory cannot squeeze them out',
	)
})

test('QqPersona — a persona directory without a rule book still renders', () => {
	const dir = tmp()
	const personaDir = join(dir, 'persona')
	mkdirSync(personaDir, { recursive: true })
	writeFileSync(join(personaDir, 'PERSONA.md'), '# 关于小D\n\n我是小D。\n')
	const persona = new QqPersona({ personaDir, log: () => {} })
	trackQqSession('qq-rules-2', true)
	const snapshot = persona.snapshot({ agent: { session: { id: 'qq-rules-2' } } })
	assert.match(snapshot.text, /我是小D/u)
	assert.doesNotMatch(snapshot.text, /他给你立的规矩/u)
})
