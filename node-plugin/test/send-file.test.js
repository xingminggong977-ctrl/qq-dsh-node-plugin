import test from 'node:test'
import assert from 'node:assert/strict'
import { runInTaskScope } from '../lib/context.js'
import { SEND_FILE_TOOL_NAME, SendFileError, createSendFileTool } from '../lib/send-file.js'

const OWNER = { group: false, isOwner: true }

test('qq_send_file — 发出去之后回一句人话，带上她挑的名字和大小', async () => {
	const asked = []
	const tool = createSendFileTool({
		client: {
			sendFile: async (args) => {
				asked.push(args)
				return { ok: true, name: args.name ?? '汇报.pptx', bytes: 2 * 1024 * 1024 }
			},
		},
	})

	const answer = await runInTaskScope(OWNER, () => tool.execute({
		path: '/var/lib/dsh-qq-agent/workspace/汇报.pptx',
		name: '汇报.pptx',
	}))

	assert.equal(tool.name, SEND_FILE_TOOL_NAME)
	assert.deepEqual(asked, [{ path: '/var/lib/dsh-qq-agent/workspace/汇报.pptx', name: '汇报.pptx' }])
	assert.equal(answer, '发出去了：汇报.pptx（2.0 MB）')
})

test('qq_send_file — 不填名字就不传 name，交给桥用原文件名', async () => {
	const asked = []
	const tool = createSendFileTool({
		client: {
			sendFile: async (args) => {
				asked.push(args)
				return { ok: true, name: 'shot.png', bytes: 900 }
			},
		},
	})

	const answer = await runInTaskScope(OWNER, () => tool.execute({ path: '/tmp/shot.png' }))

	assert.deepEqual(asked, [{ path: '/tmp/shot.png', name: undefined }])
	assert.equal(answer, '发出去了：shot.png（900 B）')
})

test('qq_send_file — 路径不在白名单里就把桥的原话翻成人话', async () => {
	const tool = createSendFileTool({ client: { sendFile: async () => ({ ok: false, error: 'not_in_allowed_roots' }) } })

	await assert.rejects(
		runInTaskScope(OWNER, () => tool.execute({ path: '/etc/shadow' })),
		(error) => error instanceof SendFileError
			&& error.code === 'bridge'
			&& /只能发工作区或 \/tmp 下的文件/.test(error.message),
	)
})

test('qq_send_file — 文件不存在时说没找到，别的错误照原样透出来', async () => {
	const missing = createSendFileTool({ client: { sendFile: async () => ({ ok: false, error: 'file not found' }) } })
	await assert.rejects(
		runInTaskScope(OWNER, () => missing.execute({ path: '/tmp/x.pptx' })),
		(error) => error.code === 'bridge' && /没找到这个文件/.test(error.message),
	)

	const other = createSendFileTool({ client: { sendFile: async () => ({ ok: false, error: 'onebot rejected file' }) } })
	await assert.rejects(
		runInTaskScope(OWNER, () => other.execute({ path: '/tmp/x.pptx' })),
		(error) => error.code === 'bridge' && /onebot rejected file/.test(error.message),
	)
})

test('qq_send_file — 没给路径就别去麻烦桥', async () => {
	let called = false
	const tool = createSendFileTool({
		client: { sendFile: async () => { called = true; return { ok: true } } },
	})

	await assert.rejects(
		runInTaskScope(OWNER, () => tool.execute({ path: '   ' })),
		(error) => error.code === 'bad-path',
	)
	assert.equal(called, false)
})

test('qq_send_file — 只在主人的私聊里可用', async () => {
	const tool = createSendFileTool({ client: { sendFile: async () => ({ ok: true, name: 'a.png', bytes: 1 }) } })

	await assert.rejects(tool.execute({ path: '/tmp/a.png' }), (error) => error.code === 'scope')
	await assert.rejects(
		runInTaskScope({ group: true, isOwner: true }, () => tool.execute({ path: '/tmp/a.png' })),
		(error) => error.code === 'scope',
	)
})
