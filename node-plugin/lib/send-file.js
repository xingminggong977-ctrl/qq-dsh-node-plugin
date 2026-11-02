import { defineTool } from '@deepseek-ai/dsh-tools'
import { isPrivateOwnerTurn } from './context.js'

/** Name she sees in the tool list. */
export const SEND_FILE_TOOL_NAME = 'qq_send_file'

export class SendFileError extends Error {
	constructor(message, { code = 'failed' } = {}) {
		super(message)
		this.name = 'SendFileError'
		this.code = code
	}
}

const TOOL_DESCRIPTION = [
	'把你做好的文件（PPT、PDF、表格、图片、压缩包）发给主人的 QQ。',
	'文件必须在工作区或 /tmp 下——别的路径桥接那边不会打开，那是防止把系统文件发出去。',
	'只在主人的私聊里可用。发之前先确认文件真的在那里；发不出去就直说哪儿不对，别只说「我看看怎么发给你」。',
].join('\n')

function humanBytes(bytes) {
	const size = Number(bytes)
	if (!Number.isFinite(size) || size <= 0) return ''
	if (size < 1024) return `${size} B`
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
	return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function createSendFileTool({ client } = {}) {
	if (client === undefined || typeof client.sendFile !== 'function') {
		throw new SendFileError('桥接客户端缺失', { code: 'config' })
	}
	return defineTool({
		name: SEND_FILE_TOOL_NAME,
		description: TOOL_DESCRIPTION,
		parameters: {
			path: { type: 'string', required: true, description: '文件的绝对路径，必须在工作区目录下' },
			// 可选参数不能写 required: false —— schema 编译器只接受 required: true 或干脆没有这个字段。
			name: { type: 'string', description: '在 QQ 里显示的文件名；不填就用原文件名' },
		},
		output: {
			schema: { type: 'string', description: '一行结果：发出去了叫什么、多大，还是哪里不对' },
			render(_args, value) {
				return [{ type: 'text', text: value }]
			},
		},
		isConcurrencySafe: () => true,
		async execute(args) {
			if (!isPrivateOwnerTurn()) {
				throw new SendFileError('发文件只能在主人的私聊里进行', { code: 'scope' })
			}
			const path = String(args?.path ?? '').trim()
			if (path === '') throw new SendFileError('没说要发哪个文件', { code: 'bad-path' })
			const name = typeof args?.name === 'string' && args.name.trim() !== '' ? args.name.trim() : undefined
			const sent = await client.sendFile({ path, name })
			if (sent?.ok !== true) {
				const reason = sent?.error === 'not_in_allowed_roots'
					? '这个路径桥接不会打开：只能发工作区里的文件（/tmp 在服务里是它自己的私有目录）'
					: sent?.error === 'file not found'
						? '那边没找到这个文件'
						: sent?.error ?? '桥接没发出去'
				throw new SendFileError(reason, { code: 'bridge' })
			}
			const size = humanBytes(sent.bytes)
			return `发出去了：${sent.name ?? name ?? path}${size === '' ? '' : `（${size}）`}`
		},
	})
}
