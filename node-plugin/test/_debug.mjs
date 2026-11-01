import { BridgeStub } from './bridge-stub.js'
import { createFakeRuntime } from './fake-runtime.js'
import { QqBridgeClient } from '../lib/bridge.js'
import { QqSessionStore } from '../lib/session.js'
import { QqNodeRunner } from '../lib/runner.js'

const options = {
	pollWaitSeconds: 1,
	pollLimit: 2,
	maxConcurrentTurns: 2,
	turnTimeoutMs: 5000,
	idleRecycleMs: 3_600_000,
	provider: '',
	model: '',
	reasoningEffort: '',
	maxTokens: 0,
	cwd: process.cwd(),
	nonOwnerPreset: 'qq-chat-only',
}
const stub = await new BridgeStub().start()
const runtime = createFakeRuntime({ reply: () => ({ text: 'hi-back' }) })
const lines = []
const log = (level, message) => lines.push(`${level}: ${message}`)
const client = new QqBridgeClient({ baseUrl: stub.url, token: stub.token })
const store = new QqSessionStore({ ctx: runtime.ctx, options, client, log })
const runner = new QqNodeRunner({ ctx: runtime.ctx, client, store, options, log })
runner.start()
stub.queue({ taskId: 't-1', userId: '1001', text: 'hi' })
try {
	await stub.waitFor((instance) => instance.results.has('t-1'), { label: 'result', timeoutMs: 8000 })
	console.log('RESULT', JSON.stringify(stub.results.get('t-1')))
} catch (error) {
	console.log('FAILED', error.message)
}
console.log('STATUSES', JSON.stringify(stub.statuses))
console.log('LOGS', JSON.stringify(lines))
await runner.stop()
await stub.stop()
process.exit(0)
