import { createServer } from 'node:http'

/** Default bearer token of the stub; tests pass it as QQ_NODE_TOKEN or config.nodeToken. */
export const STUB_TOKEN = 'stub-node-token'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * In-process fake of the cloud bridge's node-facing protocol v1.
 *
 * It implements exactly the four surfaces the node touches — `/node/poll`,
 * `/node/status`, `/node/result`, `/blob/<id>` — plus `/health`, records every
 * request, and lets a test queue tasks and inspect the results the node
 * submitted.
 */
export class BridgeStub {
	#token
	#server
	#sockets = new Set()
	#queue = []
	#waiters = []
	#closed = false

	constructor({ token = STUB_TOKEN } = {}) {
		this.#token = token
		this.requests = []
		this.statuses = []
		this.results = new Map()
		this.sentTexts = []
		this.blobs = new Map()
		this.unknownTaskIds = new Set()
	}

	get port() {
		return this.#server?.address()?.port
	}

	get url() {
		return `http://127.0.0.1:${this.port}`
	}

	get token() {
		return this.#token
	}

	async start({ port = 0 } = {}) {
		this.#server = createServer((request, response) => {
			this.#handle(request, response).catch((error) => {
				response.writeHead(500, { 'content-type': 'application/json' })
				response.end(JSON.stringify({ error: error.message }))
			})
		})
		this.#server.on('connection', (socket) => {
			this.#sockets.add(socket)
			socket.on('close', () => this.#sockets.delete(socket))
		})
		await new Promise((resolve) => this.#server.listen(port, '127.0.0.1', resolve))
		this.#closed = false
		return this
	}

	async stop() {
		this.#closed = true
		for (const waiter of this.#waiters.splice(0)) waiter({ tasks: [] })
		if (this.#server !== undefined) {
			await new Promise((resolve) => this.#server.close(resolve))
			for (const socket of this.#sockets) socket.destroy()
			this.#sockets.clear()
			this.#server = undefined
		}
	}

	/** Deliver one task on the next long poll. */
	queue(task) {
		if (typeof task.taskId !== 'string') throw new TypeError('stub: a task needs a taskId')
		this.#queue.push({
			kind: 'private',
			groupId: null,
			nickname: 'tester',
			text: 'hello',
			images: [],
			receivedAt: new Date().toISOString(),
			deadlineAt: new Date(Date.now() + 120_000).toISOString(),
			isOwner: false,
			...task,
		})
		const waiter = this.#waiters.shift()
		if (waiter !== undefined) waiter(null)
		return this
	}

	/** Register an image blob served by `/blob/<id>`. */
	putBlob(blobId, bytes, mime = 'image/png') {
		this.blobs.set(blobId, { bytes, mime })
		return this
	}

	/** Poll a predicate until it holds or the timeout expires. */
	async waitFor(predicate, { timeoutMs = 5000, label = 'condition' } = {}) {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (predicate(this)) return true
			await sleep(20)
		}
		throw new Error(`stub: timed out waiting for ${label}`)
	}

	requestsTo(path) {
		return this.requests.filter((entry) => entry.pathname === path)
	}

	async #handle(request, response) {
		const url = new URL(request.url, 'http://127.0.0.1')
		const body = await readBody(request)
		this.requests.push({
			method: request.method,
			pathname: url.pathname,
			query: url.search,
			authorization: request.headers.authorization,
			body,
		})
		const send = (status, payload, headers = {}) => {
			response.writeHead(status, { 'content-type': 'application/json', ...headers })
			response.end(JSON.stringify(payload))
		}
		if (url.pathname === '/health') return send(200, { ok: true })
		if (request.headers.authorization !== `Bearer ${this.#token}`) {
			return send(401, { error: 'unauthorized' })
		}
		if (request.method === 'GET' && url.pathname === '/node/poll') return this.#poll(url, response, send)
		if (request.method === 'POST' && url.pathname === '/node/status') return this.#status(body, send)
		if (request.method === 'POST' && url.pathname === '/node/result') return this.#result(body, send)
		if (request.method === 'POST' && url.pathname === '/node/send') return this.#sendText(body, send)
		if (request.method === 'GET' && url.pathname.startsWith('/blob/')) return this.#blob(url, response)
		return send(404, { error: 'not found' })
	}

	async #poll(url, response, send) {
		if (this.#closed) return send(200, { tasks: [] })
		const limit = Math.min(Number(url.searchParams.get('limit') ?? 2), 5)
		const waitMs = Math.min(Number(url.searchParams.get('wait') ?? 25), 30) * 1000
		const take = () => this.#queue.splice(0, limit)
		let tasks = take()
		if (tasks.length === 0 && waitMs > 0) {
			await new Promise((resolve) => {
				const timer = setTimeout(() => {
					this.#waiters = this.#waiters.filter((waiter) => waiter !== wake)
					resolve()
				}, Math.min(waitMs, 750))
				const wake = () => {
					clearTimeout(timer)
					resolve()
				}
				this.#waiters.push(wake)
			})
			tasks = take()
		}
		if (response.writableEnded || this.#closed) return
		return send(200, { tasks })
	}

	#status(body, send) {
		const taskId = body?.taskId
		if (typeof taskId !== 'string' || !['accepted', 'running'].includes(body?.state)) {
			return send(400, { error: 'bad request' })
		}
		if (this.unknownTaskIds.has(taskId)) return send(404, { error: 'unknown task' })
		this.statuses.push({ taskId, state: body.state })
		return send(200, { ok: true })
	}

	#result(body, send) {
		const taskId = body?.taskId
		if (typeof taskId !== 'string') return send(400, { error: 'bad request' })
		if (this.results.has(taskId)) return send(200, { ok: true, duplicate: true })
		this.results.set(taskId, { ok: body.ok, text: body.text, error: body.error ?? null })
		return send(200, { ok: true })
	}

	/** `POST /node/send`：长回合里先发出去的那一句（桥只认主人私聊）。 */
	#sendText(body, send) {
		const to = body?.to
		if (typeof to !== 'string' || !/^\d{5,12}$/.test(to)) return send(400, { error: 'to must be a QQ number' })
		if (typeof body?.text !== 'string' || body.text.trim() === '') return send(400, { error: 'text must be a non-empty string' })
		this.sentTexts.push({ to, text: body.text.trim() })
		return send(200, { ok: true, messageId: 1 })
	}

	#blob(url, response) {
		const blobId = decodeURIComponent(url.pathname.slice('/blob/'.length))
		const blob = this.blobs.get(blobId)
		if (blob === undefined) {
			response.writeHead(404, { 'content-type': 'application/json' })
			return response.end(JSON.stringify({ error: 'unknown blob' }))
		}
		response.writeHead(200, { 'content-type': blob.mime, 'content-length': blob.bytes.length })
		return response.end(blob.bytes)
	}
}

async function readBody(request) {
	if (request.method !== 'POST') return undefined
	const chunks = []
	for await (const chunk of request) chunks.push(chunk)
	if (chunks.length === 0) return undefined
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		return undefined
	}
}
