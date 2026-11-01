import test from 'node:test'
import assert from 'node:assert/strict'
import { TIER_DEFAULTS, TIER_HEAVY, TIER_LIGHT, tierOf } from '../lib/tier.js'

test('tier: disabled always answers heavy, whatever the message', () => {
	for (const text of ['', '在吗', '帮我改一下这个脚本', 'x'.repeat(500)]) {
		assert.equal(tierOf(text, { enabled: false }), TIER_HEAVY)
	}
	assert.equal(TIER_DEFAULTS.enabled, false)
})

test('tier: a short greeting is light', () => {
	for (const text of ['在吗', '早上好', '晚安', '哈哈哈', '嗯']) {
		assert.equal(tierOf(text, { enabled: true }), TIER_LIGHT, text)
	}
})

test('tier: a short message carrying a work verb is heavy', () => {
	for (const text of ['帮我改一下', '查下天气', '翻译这句', '总结一下', '为什么报错', '看看这个报错']) {
		assert.equal(tierOf(text, { enabled: true }), TIER_HEAVY, text)
	}
})

test('tier: length past lightMaxChars is heavy even without a verb', () => {
	const long = '今'.repeat(41)
	assert.equal(tierOf(long, { enabled: true }), TIER_HEAVY)
	assert.equal(tierOf('今'.repeat(40), { enabled: true }), TIER_LIGHT)
	assert.equal(tierOf('今'.repeat(10), { enabled: true, lightMaxChars: 9 }), TIER_HEAVY)
})

test('tier: an emoji counts as one character, not two', () => {
	const emoji = '🙂'.repeat(40)
	assert.equal([...emoji].length, 40)
	assert.equal(emoji.length, 80)
	assert.equal(tierOf(emoji, { enabled: true }), TIER_LIGHT)
	assert.equal(tierOf('🙂'.repeat(41), { enabled: true }), TIER_HEAVY)
})

test('tier: an image makes the message heavy', () => {
	assert.equal(tierOf('看看', { enabled: true, hasImages: true }), TIER_HEAVY)
	assert.equal(tierOf('', { enabled: true, hasImages: true }), TIER_HEAVY)
})

test('tier: empty or whitespace-only text is light', () => {
	for (const text of ['', '   ', '\n\t', undefined, null]) {
		assert.equal(tierOf(text, { enabled: true }), TIER_LIGHT, String(text))
	}
})

test('tier: a group message that needs no reply is light', () => {
	assert.equal(tierOf('帮我查一下', { enabled: true, isGroupContextOnly: true }), TIER_LIGHT)
})
