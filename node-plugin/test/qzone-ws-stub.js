/**
 * Minimal in-process WebSocket server standing in for NapCat's OneBot11 WS port.
 *
 * The plugin's client is the built-in `WebSocket`, so the test cannot use one
 * of those on the server side; this file hand-rolls the pieces that matter:
 * the RFC 6455 handshake on `http`'s `upgrade` event (so the test can assert the
 * `Authorization` header), masked client-frame decoding, and unmasked
 * server-frame encoding. Only the frame forms this plugin produces are
 * supported: single-frame text, close, ping.
 *
 * `reply` scripts the answer: it receives the parsed request and returns the
 * object to send back, or `undefined` to stay silent (the timeout case).
 */
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** `Sec-WebSocket-Accept` per RFC 6455 §4.2.2. */
function acceptKeyOf(key) {
	return createHash('sha1').update(key + WS_GUID).digest('base64')
}

/** Encode one unmasked, final text frame. */
function encodeTextFrame(text) {
	const payload = Buffer.from(text, 'utf8')
	const length = payload.length
	let header
	if (length < 126) {
		header = Buffer.from([0x81, length])
	} else if (length < 65_536) {
		header = Buffer.alloc(4)
		header[0] = 0x81
		header[1] = 126
		header.writeUInt16BE(length, 2)
	} else {
		header = Buffer.alloc(10)
		header[0] = 0x81
		header[1] = 127
		header.writeBigUInt64BE(BigInt(length), 2)
	}
	return Buffer.concat([header, payload])
}

/**
 * Decode whatever complete frames a byte buffer holds.
 * @returns `{ frames, rest }`; `rest` is the still-incomplete tail.
 */
function decodeFrames(buffer) {
	const frames = []
	let offset = 0
	for (;;) {
		if (buffer.length - offset < 2) break
		const first = buffer[offset]
		const second = buffer[offset + 1]
		const opcode = first & 0x0f
		const masked = (second & 0x80) !== 0
		let length = second & 0x7f
		let cursor = offset + 2
		if (length === 126) {
			if (buffer.length - cursor < 2) break
			length = buffer.readUInt16BE(cursor)
			cursor += 2
		} else if (length === 127) {
			if (buffer.length - cursor < 8) break
			length = Number(buffer.readBigUInt64BE(cursor))
			cursor += 8
		}
		let mask
		if (masked) {
			if (buffer.length - cursor < 4) break
			mask = buffer.subarray(cursor, cursor + 4)
			cursor += 4
		}
		if (buffer.length - cursor < length) break
		const payload = Buffer.from(buffer.subarray(cursor, cursor + length))
		if (mask !== undefined) for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4]
		frames.push({ opcode, payload })
		offset = cursor + length
	}
	return { frames, rest: buffer.subarray(offset) }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class QzoneWsStub {
	#server
	#sockets = new Set()

	/**
	 * @param options.reply - `(request) => object | undefined`; the default echoes
	 *   `echo` back with `{ status: 'ok', retcode: 0, data: { tid } }`.
	 * @param options.tid - tid the default reply reports.
	 * @param options.requireAuthorization - reject the handshake without this exact header.
	 */
	constructor({ reply, tid = 'ff86d9d85270dd6a82e30a00', requireAuthorization } = {}) {
		this.tid = tid
		this.requireAuthorization = requireAuthorization
		this.requests = []
		this.rawMessages = []
		this.upgrades = []
		this.closes = 0
		this.reply = reply ?? ((request) => ({ status: 'ok', retcode: 0, data: { tid: this.tid }, echo: request?.echo }))
	}

	get port() {
		return this.#server?.address()?.port
	}

	get url() {
		return `ws://127.0.0.1:${this.port}`
	}

	async start({ port = 0 } = {}) {
		this.#server = createServer((_request, response) => {
			response.writeHead(426, { 'content-type': 'text/plain' })
			response.end('this stub only speaks WebSocket')
		})
		this.#server.on('upgrade', (request, socket, head) => {
			this.#onUpgrade(request, socket, head)
		})
		this.#server.on('connection', (socket) => {
			this.#sockets.add(socket)
			socket.on('close', () => this.#sockets.delete(socket))
		})
		await new Promise((resolve) => this.#server.listen(port, '127.0.0.1', resolve))
		return this
	}

	async stop() {
		if (this.#server === undefined) return
		await new Promise((resolve) => this.#server.close(resolve))
		for (const socket of this.#sockets) socket.destroy()
		this.#sockets.clear()
		this.#server = undefined
	}

	/** Poll a predicate until it holds or the timeout expires. */
	async waitFor(predicate, { timeoutMs = 3000, label = 'condition' } = {}) {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (predicate(this)) return true
			await sleep(10)
		}
		throw new Error(`qzone stub: timed out waiting for ${label}`)
	}

	#onUpgrade(request, socket, head) {
		const record = { url: request.url, authorization: request.headers.authorization, headers: request.headers }
		this.upgrades.push(record)
		if (this.requireAuthorization !== undefined && request.headers.authorization !== this.requireAuthorization) {
			socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
			return
		}
		const key = request.headers['sec-websocket-key']
		if (typeof key !== 'string' || key === '') {
			socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
			return
		}
		socket.write(
			['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${acceptKeyOf(key)}`, '', ''].join('\r\n'),
		)
		socket.on('error', () => {})
		socket.on('close', () => {
			this.closes += 1
		})
		let pending = Buffer.alloc(0)
		if (head.length > 0) pending = Buffer.concat([pending, head])
		socket.on('data', (chunk) => {
			pending = Buffer.concat([pending, chunk])
			const { frames, rest } = decodeFrames(pending)
			pending = rest
			for (const frame of frames) this.#onFrame(socket, frame)
		})
	}

	#onFrame(socket, frame) {
		if (frame.opcode === 0x8) {
			socket.write(Buffer.from([0x88, 0x00]))
			socket.end()
			return
		}
		if (frame.opcode === 0x9) return
		if (frame.opcode !== 0x1) return
		const text = frame.payload.toString('utf8')
		this.rawMessages.push(text)
		let request
		try {
			request = JSON.parse(text)
		} catch {
			return
		}
		this.requests.push(request)
		const answer = this.reply(request, socket)
		if (answer === undefined) return
		// An array scripts several frames for one request: the echo-mismatch case
		// sends a foreign frame first, then the real reply.
		for (const frame of Array.isArray(answer) ? answer : [answer]) {
			if (socket.writableEnded) return
			socket.write(encodeTextFrame(JSON.stringify(frame)))
		}
	}
}
