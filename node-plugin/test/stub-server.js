/**
 * Standalone bridge stub for a live `dsh --profile qq` run:
 *
 *   node test/stub-server.js            # serves 127.0.0.1:8787 with one task
 *
 * It prints every request it receives and the result the node submits, then
 * exits. Nothing here talks to the real cloud bridge or to QQ.
 */
import { BridgeStub, STUB_TOKEN } from './bridge-stub.js'

const task = {
	taskId: `stub-${Date.now()}`,
	kind: 'private',
	groupId: null,
	userId: '1001',
	nickname: 'stub-user',
	text: '用一句话确认你是 QQ 侧的 DSH。',
	images: [],
	receivedAt: new Date().toISOString(),
	deadlineAt: new Date(Date.now() + 180_000).toISOString(),
	isOwner: false,
}

const stub = await new BridgeStub().start({ port: 8787 })
stub.queue(task)
console.log(`[stub] listening on ${stub.url} token=${STUB_TOKEN} task=${task.taskId}`)

try {
	await stub.waitFor((instance) => instance.results.has(task.taskId), { label: 'result', timeoutMs: 240_000 })
	const result = stub.results.get(task.taskId)
	console.log(`[stub] requests=${stub.requests.map((request) => `${request.method} ${request.pathname}`).join(' ')}`)
	console.log(`[stub] statuses=${JSON.stringify(stub.statuses)}`)
	console.log(`[stub] result=${JSON.stringify(result)}`)
} catch (error) {
	console.log(`[stub] FAILED ${error.message}`)
	console.log(`[stub] requests=${stub.requests.map((request) => `${request.method} ${request.pathname}`).join(' ')}`)
} finally {
	await stub.stop()
}
