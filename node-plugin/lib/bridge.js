/** Result text cap for /node/result, per PROTOCOL.md. */

export const MAX_RESULT_TEXT = 8000

/** Cut one reply to the protocol's text budget without splitting a surrogate pair. */
export function truncateResultText(text, max = MAX_RESULT_TEXT) {
	if (typeof text !== 'string') throw new TypeError('qq-node: reply text must be a string')
	if (text.length <= max) return text
	const cut = max > 0 && /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max
	return text.slice(0, cut)
}

/** One transport failure, carrying the HTTP status when the bridge answered at all. */
export class BridgeError extends Error {
	constructor(message, status) {
		super(message)
		this.name = 'BridgeError'
		this.status = status
	}
}

/**
 * Client side of the v1 node protocol: `/node/poll`, `/node/status`,
 * `/node/result`, `/blob/<id>`, all behind one bearer token.
 */
export class QqBridgeClient {
	#baseUrl
	#token
	#fetch
	#log

	constructor({ baseUrl, token, fetchImpl, log }) {
		if (typeof baseUrl !== 'string' || baseUrl === '') throw new TypeError('qq-node: bridgeUrl is required')
		if (typeof token !== 'string' || token === '') throw new TypeError('qq-node: node token is required')
		this.#baseUrl = baseUrl.replace(/\/+$/, '')
		this.#token = token
		this.#fetch = fetchImpl ?? globalThis.fetch
		this.#log = log ?? (() => {})
	}

	get baseUrl() {
		return this.#baseUrl
	}

	#headers(json) {
		return {
			authorization: `Bearer ${this.#token}`,
			accept: 'application/json',
			...(json ? { 'content-type': 'application/json' } : {}),
		}
	}

	async #request(pathAndQuery, { method = 'GET', body, signal, timeoutMs } = {}) {
		const url = `${this.#baseUrl}${pathAndQuery}`
		const signals = []
		if (signal !== undefined) signals.push(signal)
		if (timeoutMs !== undefined) signals.push(AbortSignal.timeout(timeoutMs))
		let response
		try {
			response = await this.#fetch(url, {
				method,
				headers: this.#headers(body !== undefined),
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				...(signals.length === 0 ? {} : { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }),
			})
		} catch (error) {
			throw new BridgeError(`bridge ${method} ${pathAndQuery} failed: ${error?.message ?? String(error)}`)
		}
		if (!response.ok) {
			const detail = await response.text().catch(() => '')
			throw new BridgeError(
				`bridge ${method} ${pathAndQuery} answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`,
				response.status,
			)
		}
		return response
	}

	/** Long-poll one batch of tasks (protocol defaults: wait 25s, limit 2). */
	async poll({ wait, limit, signal }) {
		const query = `?wait=${encodeURIComponent(String(wait))}&limit=${encodeURIComponent(String(limit))}`
		const response = await this.#request(`/node/poll${query}`, { signal, timeoutMs: (wait + 15) * 1000 })
		const payload = await response.json()
		if (!payload || !Array.isArray(payload.tasks)) throw new BridgeError('bridge /node/poll returned no tasks array')
		return payload.tasks
	}

	/** Report `accepted` or `running` for one task (idempotent on the bridge). */
	async markStatus(taskId, state) {
		await this.#request('/node/status', {
			method: 'POST',
			body: { taskId, state },
			timeoutMs: 15000,
		})
	}

	/** Submit the terminal result for one task; a repeat submission is answered `duplicate`. */
	async submitResult({ taskId, ok, text, error }) {
		const response = await this.#request('/node/result', {
			method: 'POST',
			body: { taskId, ok, text: truncateResultText(text ?? ''), error: error ?? null },
			timeoutMs: 20000,
		})
		return await response.json().catch(() => ({}))
	}

	/**
	 * 先把已经说出口的一句发给主人（`POST /node/send`）。
	 *
	 * 长回合里的静音比慢更难受：桥那边 22/90/180 秒的垫话是罐头话，这一条是她
	 * 自己刚说的句子。只给主人私聊用，桥会拒掉别的收信人。
	 */
	async sendText({ to, text, taskId }) {
		const response = await this.#request('/node/send', {
			method: 'POST',
			body: { to, text, ...(taskId === undefined ? {} : { taskId }) },
			timeoutMs: 15000,
		})
		return await response.json().catch(() => ({}))
	}

	/**
	 * 把她做好的文件发给主人（`POST /node/send_file`）。
	 *
	 * 桥那边只肯打开 QQ_FILE_ROOTS 里的路径、只发给主人；文件内容由桥读成 base64，
	 * 因为 NapCat 在另一台机器上，路径过去就是「文件不存在」。
	 */
	async sendFile({ path, name, timeoutMs = 60000 }) {
		const response = await this.#request('/node/send_file', {
			method: 'POST',
			body: { path, ...(name === undefined ? {} : { name }) },
			timeoutMs,
		})
		return await response.json().catch(() => ({}))
	}

	/** Schedule one reminder; the bridge fires it at `at` (epoch ms). */
	async remind({ at, text, to }) {
		const response = await this.#request('/node/remind', {
			method: 'POST',
			body: { at, text, ...(to === undefined ? {} : { to }) },
			timeoutMs: 15000,
		})
		return await response.json().catch(() => ({}))
	}

	/** Fetch one image blob; returns its bytes and the recorded MIME type. */
	async fetchBlob(blobId, { signal, timeoutMs = 30000 } = {}) {
		const response = await this.#request(`/blob/${encodeURIComponent(blobId)}`, { signal, timeoutMs })
		const mediaType = response.headers.get('content-type') ?? 'application/octet-stream'
		const bytes = new Uint8Array(await response.arrayBuffer())
		return { bytes, mediaType }
	}
}
