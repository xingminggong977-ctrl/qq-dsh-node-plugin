import test from 'node:test'
import assert from 'node:assert/strict'
import { QqNodeRunner } from '../lib/runner.js'

/** Poll-log client stub: delivers the queued tasks once, then idles. */
function stubClient(tasks) {
	const queue = [...tasks]
	return {
		delivered: [],
		async poll() {
			if (queue.length > 0) {
				const batch = queue.splice(0)
				this.delivered.push(...batch)
				return batch
			}
			await new Promise((resolve) => setTimeout(resolve, 10))
			return []
		},
		async markStatus() {},
		async submitResult() {
			return { ok: true }
		},
	}
}

function stubStore({ text = '收到啦' } = {}) {
	const seen = []
	return {
		seen,
		attach: () => () => {},
		sweep: () => 0,
		dispose() {},
		async runTask(task, options) {
			seen.push({ task, options })
			return { ok: true, text }
		},
	}
}

const OPTIONS = Object.freeze({
	pollWaitSeconds: 1,
	pollLimit: 2,
	maxConcurrentTurns: 1,
	idleRecycleMs: 60_000,
	turnTimeoutMs: 5_000,
	proactiveInterjection: { enabled: false, minIntervalMs: 1, maxPerMinute: 1, maxPerGroupPerDay: 1 },
})

function recorder() {
	const records = []
	return {
		records,
		record(entry) {
			records.push(entry)
			return true
		},
	}
}

/** Wait until `predicate` holds or the budget runs out. */
async function waitFor(predicate, budgetMs = 2_000) {
	const deadline = Date.now() + budgetMs
	while (Date.now() < deadline) {
		if (predicate()) return true
		await new Promise((resolve) => setTimeout(resolve, 10))
	}
	return false
}

const PRIVATE_TASK = Object.freeze({
	taskId: 't-audit-1',
	kind: 'private',
	userId: '10001',
	nickname: '主人',
	text: '在吗',
	images: [],
	receivedAt: Date.now(),
	isOwner: true,
})

test('audit wiring: one private reply writes exactly one private_reply record', async () => {
	const client = stubClient([{ ...PRIVATE_TASK }])
	const store = stubStore({ text: '在呢' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => audit.records.length >= 1), true, 'no audit record was written')
		assert.deepEqual(audit.records[0], {
			kind: 'private_reply',
			target: '10001',
			text: '在呢',
			taskId: 't-audit-1',
			needsReply: true,
			isOwner: true,
		})
	} finally {
		await runner.stop()
	}
})

test('audit wiring: a group reply records the group, not the person', async () => {
	const client = stubClient([{ ...PRIVATE_TASK, taskId: 't-audit-2', kind: 'group', groupId: '123456', text: '小D 你好' }])
	const store = stubStore({ text: '你好呀' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => audit.records.length >= 1), true)
		assert.equal(audit.records[0].kind, 'group_reply')
		assert.equal(audit.records[0].target, '123456')
	} finally {
		await runner.stop()
	}
})

test('audit wiring: with tiering on the record names the tier that produced it', async () => {
	const tiering = { heavyEffort: 'max', lightEffort: '', lightMaxChars: 40 }
	const client = stubClient([{ ...PRIVATE_TASK, taskId: 't-audit-tier', text: '在吗' }])
	const store = stubStore({ text: '在呢' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: { ...OPTIONS, tiering }, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => audit.records.length >= 1), true, 'no audit record was written')
		assert.equal(audit.records[0].tier, 'light')
	} finally {
		await runner.stop()
	}
})

test('audit wiring: an empty reply is recorded as zero characters, so the log and the audit agree', async () => {
	const client = stubClient([{ ...PRIVATE_TASK, taskId: 't-audit-3' }])
	const store = stubStore({ text: '' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => audit.records.length >= 1), true, 'the empty answer left no trace')
		assert.equal(audit.records[0].text, '')
		assert.equal(audit.records[0].needsReply, true)
		assert.equal(audit.records[0].isOwner, true)
	} finally {
		await runner.stop()
	}
})

test('audit wiring: a missing audit sink does not break the reply path', async () => {
	const client = stubClient([{ ...PRIVATE_TASK, taskId: 't-audit-4' }])
	const store = stubStore({ text: '在呢' })
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {} })
	runner.start()
	try {
		assert.equal(await waitFor(() => store.seen.length >= 1), true)
	} finally {
		await runner.stop()
	}
})

test('tier wiring: tiering off classifies every message heavy, so effort never moves', async () => {
	const client = stubClient([{ ...PRIVATE_TASK, taskId: 't-tier-1', text: '在吗' }])
	const store = stubStore()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {} })
	runner.start()
	try {
		assert.equal(await waitFor(() => store.seen.length >= 1), true)
		assert.equal(store.seen[0].options.tier, 'heavy')
	} finally {
		await runner.stop()
	}
})

test('tier wiring: tiering on classifies a greeting light and a task heavy', async () => {
	const tiering = { heavyEffort: 'max', lightEffort: '', lightMaxChars: 40 }
	const client = stubClient([
		{ ...PRIVATE_TASK, taskId: 't-tier-2', text: '在吗' },
		{ ...PRIVATE_TASK, taskId: 't-tier-3', text: '帮我改一下这个脚本' },
	])
	const store = stubStore()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: { ...OPTIONS, tiering }, log: () => {} })
	runner.start()
	try {
		assert.equal(await waitFor(() => store.seen.length >= 2), true, 'both tasks must run')
		const tiers = new Map(store.seen.map((call) => [call.task.taskId, call.options.tier]))
		assert.equal(tiers.get('t-tier-2'), 'light')
		assert.equal(tiers.get('t-tier-3'), 'heavy')
	} finally {
		await runner.stop()
	}
})

function ruleBook() {
	const added = []
	return {
		added,
		add(text) {
			added.push(text)
			return true
		},
	}
}

test('correction wiring: an owner instruction is filed as a standing rule', async () => {
	const client = stubClient([{ ...PRIVATE_TASK, taskId: 't-rule-1', text: '以后别在群里叫我宝贝' }])
	const store = stubStore({ text: '记住了' })
	const corrections = ruleBook()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, corrections })
	runner.start()
	try {
		assert.equal(await waitFor(() => corrections.added.length >= 1), true, 'no rule was filed')
		assert.deepEqual(corrections.added, ['以后别在群里叫我宝贝'])
	} finally {
		await runner.stop()
	}
})

test('correction wiring: chatter is not a rule, and a group cannot write one', async () => {
	const client = stubClient([
		{ ...PRIVATE_TASK, taskId: 't-rule-2', text: '今天加班到十点' },
		{ ...PRIVATE_TASK, taskId: 't-rule-3', kind: 'group', groupId: '123456', mentioned: true, text: '以后别在群里叫我宝贝' },
	])
	const store = stubStore()
	const corrections = ruleBook()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, corrections })
	runner.start()
	try {
		assert.equal(await waitFor(() => store.seen.length >= 2), true, 'both tasks must run')
		assert.deepEqual(corrections.added, [], 'neither chatter nor a group message may become a rule')
	} finally {
		await runner.stop()
	}
})

test('audit wiring: a reply that came out empty is still one record, so the two sides can be reconciled', async () => {
	const client = stubClient([{ ...PRIVATE_TASK, taskId: 't-audit-empty', needsReply: true }])
	const store = stubStore({ text: '' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => audit.records.length >= 1), true, 'an empty reply left no trace')
		assert.deepEqual(audit.records[0], {
			kind: 'private_reply',
			target: '10001',
			text: '',
			taskId: 't-audit-empty',
			needsReply: true,
			isOwner: true,
		})
	} finally {
		await runner.stop()
	}
})

test('audit wiring: a group turn that was asked and said nothing is recorded too, without isOwner', async () => {
	const client = stubClient([
		{ ...PRIVATE_TASK, taskId: 't-audit-quiet', kind: 'group', groupId: '123456', isOwner: false, mentioned: true, needsReply: true },
	])
	const store = stubStore({ text: '' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => audit.records.length >= 1), true, 'an empty group answer left no trace')
		assert.deepEqual(audit.records[0], {
			kind: 'group_reply',
			target: '123456',
			text: '',
			taskId: 't-audit-quiet',
			needsReply: true,
		})
	} finally {
		await runner.stop()
	}
})

test('audit wiring: a turn nobody asked to answer writes nothing', async () => {
	const client = stubClient([
		{ ...PRIVATE_TASK, taskId: 't-audit-context', userId: '20002', isOwner: false, needsReply: false },
	])
	const store = stubStore({ text: '' })
	const audit = recorder()
	const runner = new QqNodeRunner({ ctx: {}, client, store, options: OPTIONS, log: () => {}, audit })
	runner.start()
	try {
		assert.equal(await waitFor(() => store.seen.length >= 1), true, 'the task must run')
		assert.deepEqual(audit.records, [], 'nobody asked, so there is nothing to reconcile')
	} finally {
		await runner.stop()
	}
})

