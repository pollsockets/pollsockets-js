export const CLIENT_HEADER = 'X-Pollsockets-Client'

const MAX_BACKOFF = 30000
const STALE_MARGIN = 2000
/** Milliseconds below the cursor that every poll reads again, to get members whose write landed late. */
const OVERLAP = 2000
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

export interface PollsocketOptions {
	/** Poll endpoint. Default: `/_pollsockets/${encodeURIComponent(channel)}/poll` */
	url?: string
	/** Milliseconds between polls. Default: 1000 */
	interval?: number
	/** Milliseconds an event stays pollable. Must match the server's retention. Default: 60000 */
	retention?: number
	/** Initial cursor in server milliseconds, e.g. from `Pollsockets::now()` rendered into the page */
	since?: number | null
	/** Id of this client. The app sends it as the `X-Pollsockets-Client` header on its writes. Default: random */
	clientId?: string
	headers?: Record<string, string>
	/** Default: `globalThis.fetch`, resolved at call time */
	fetch?: typeof fetch
	onStale?: () => void
	onError?: (error: unknown) => void
}

export interface Pollsocket {
	readonly channel: string
	readonly clientId: string
	on(event: string, callback: () => void): () => void
	onAny(callback: (events: string[]) => void): () => void
	start(): void
	stop(): void
}

interface PollResponse {
	time: number
	events: Record<string, number>
}

export function createPollsocket(channel: string, options: PollsocketOptions = {}): Pollsocket {
	const url = options.url ?? `/_pollsockets/${encodeURIComponent(channel)}/poll`
	const interval = options.interval ?? 1000
	const retention = options.retention ?? 60000
	const clientId = options.clientId ?? randomId()
	const since = options.since ?? null

	if (!isPositiveInteger(interval) || !isPositiveInteger(retention) || interval >= retention - STALE_MARGIN) {
		throw new RangeError(
			`Pollsockets interval and retention must be positive integers with interval < retention - ${STALE_MARGIN}`,
		)
	}
	if (!CLIENT_ID_PATTERN.test(clientId)) {
		throw new TypeError('Pollsockets clientId must match /^[A-Za-z0-9_-]{1,64}$/')
	}
	if (since !== null && !(Number.isSafeInteger(since) && since >= 0)) {
		throw new RangeError('Pollsockets since must be null or a non-negative integer of server milliseconds')
	}

	const listeners = new Map<string, Set<() => void>>()
	const anyListeners = new Set<(events: string[]) => void>()

	let cursor: number | null = since
	let lastTime: number | null = null
	/** Member → highest score already handled (fired, baselined, stale-reset or own). */
	let seen = new Map<string, number>()
	let failures = 0
	let running = false
	let hidden = false
	let offline = false
	let generation = 0
	let timer: ReturnType<typeof setTimeout> | null = null
	let controller: AbortController | null = null

	function reportError(error: unknown): void {
		try {
			options.onError?.(error)
		} catch {
			// An error handler that throws must not stop the loop.
		}
	}

	function call(callback: () => void): void {
		try {
			callback()
		} catch (error) {
			reportError(error)
		}
	}

	function buildUrl(): string {
		const base = globalThis.location?.href
		const target = base === undefined ? new URL(url) : new URL(url, base)

		if (cursor !== null) {
			target.searchParams.set('since', String(Math.max(0, cursor - OVERLAP)))
		}

		return target.toString()
	}

	function clearTimer(): void {
		if (timer !== null) {
			clearTimeout(timer)
			timer = null
		}
	}

	/** Abort the in-flight request, clear the timer and discard any late response. */
	function halt(): void {
		generation++
		clearTimer()
		controller?.abort()
		controller = null
	}

	function active(): boolean {
		return running && !hidden && !offline
	}

	function schedule(delay: number): void {
		clearTimer()
		timer = setTimeout(() => {
			timer = null
			poll()
		}, delay)
	}

	function poll(): void {
		if (!active() || controller !== null) {
			return
		}

		const current = generation
		const abort = new AbortController()
		controller = abort

		request(abort.signal).then(
			(data) => {
				if (current !== generation) {
					return
				}
				controller = null
				failures = 0
				handle(data)
				// A callback can stop, restart or pause this instance.
				if (current === generation && active()) {
					schedule(interval)
				}
			},
			(error: unknown) => {
				if (current !== generation) {
					return
				}
				controller = null
				reportError(error)
				const delay = Math.min(MAX_BACKOFF, interval * 2 ** failures)
				failures++
				// onError can stop, restart or pause this instance.
				if (current === generation && active()) {
					schedule(delay)
				}
			},
		)
	}

	/** An async function, so a synchronous throw from `fetch` becomes a rejection too. */
	async function request(signal: AbortSignal): Promise<PollResponse> {
		const response = await (options.fetch ?? globalThis.fetch)(buildUrl(), {
			credentials: 'same-origin',
			cache: 'no-store',
			headers: {
				Accept: 'application/json',
				'X-Requested-With': 'XMLHttpRequest',
				...options.headers,
			},
			signal,
		})

		if (!response.ok) {
			throw new Error(`Pollsockets poll failed with status ${response.status}`)
		}

		return parse(await response.json())
	}

	/** Baseline or stale reset: start again from the server time and fire nothing for this response. */
	function reset(time: number, events: Record<string, number>): void {
		cursor = time
		lastTime = time
		seen = new Map(Object.entries(events))
	}

	function handle({ time, events }: PollResponse): void {
		if (cursor === null) {
			reset(time, events)

			return
		}

		if (time - (lastTime ?? cursor) > retention - STALE_MARGIN) {
			reset(time, events)
			call(() => options.onStale?.())

			return
		}

		const fired = new Set<string>()
		for (const [member, score] of Object.entries(events)) {
			cursor = Math.max(cursor, score)

			const handled = seen.get(member)
			if (handled !== undefined && handled >= score) {
				continue
			}
			seen.set(member, score)

			const separator = member.lastIndexOf('|')
			const event = separator === -1 ? member : member.slice(0, separator)
			const origin = separator === -1 ? '' : member.slice(separator + 1)

			if (event !== '' && origin !== clientId) {
				fired.add(event)
			}
		}
		lastTime = time

		// The bound is exclusive, so the server cannot return these members again.
		for (const [member, score] of seen) {
			if (score <= cursor - OVERLAP) {
				seen.delete(member)
			}
		}

		const names = [...fired].sort()
		for (const name of names) {
			for (const callback of [...(listeners.get(name) ?? [])]) {
				call(callback)
			}
		}

		if (names.length > 0) {
			for (const callback of [...anyListeners]) {
				call(() => callback([...names]))
			}
		}
	}

	/** Apply a hidden/offline change: stop all work, then poll immediately if polling is allowed. */
	function refresh(): void {
		halt()
		poll()
	}

	function onVisibilityChange(): void {
		hidden = globalThis.document.visibilityState === 'hidden'
		refresh()
	}

	function onOffline(): void {
		offline = true
		refresh()
	}

	function onOnline(): void {
		offline = false
		refresh()
	}

	return {
		channel,
		clientId,
		on(event, callback) {
			let set = listeners.get(event)
			if (set === undefined) {
				set = new Set()
				listeners.set(event, set)
			}
			set.add(callback)

			return () => {
				set.delete(callback)
				if (set.size === 0 && listeners.get(event) === set) {
					listeners.delete(event)
				}
			}
		},
		onAny(callback) {
			anyListeners.add(callback)

			return () => {
				anyListeners.delete(callback)
			}
		},
		start() {
			if (running) {
				return
			}
			running = true
			clearTimer()
			hidden = globalThis.document?.visibilityState === 'hidden'
			offline = globalThis.navigator?.onLine === false

			globalThis.document?.addEventListener('visibilitychange', onVisibilityChange)
			globalThis.window?.addEventListener('offline', onOffline)
			globalThis.window?.addEventListener('online', onOnline)

			poll()
		},
		stop() {
			if (!running) {
				return
			}
			running = false
			halt()

			globalThis.document?.removeEventListener('visibilitychange', onVisibilityChange)
			globalThis.window?.removeEventListener('offline', onOffline)
			globalThis.window?.removeEventListener('online', onOnline)
		},
	}
}

function parse(body: unknown): PollResponse {
	if (typeof body !== 'object' || body === null) {
		throw new Error('Pollsockets poll returned an invalid body')
	}

	const { time, events } = body as { time?: unknown; events?: unknown }

	if (typeof time !== 'number' || !Number.isSafeInteger(time)) {
		throw new Error('Pollsockets poll returned an invalid time')
	}

	// PHP encodes an empty array as `[]`; accept it as no events.
	if (Array.isArray(events) && events.length === 0) {
		return { time, events: {} }
	}

	if (!isPlainObject(events)) {
		throw new Error('Pollsockets poll returned invalid events')
	}

	if (!Object.values(events).every(Number.isSafeInteger)) {
		throw new Error('Pollsockets poll returned an invalid event score')
	}

	return { time, events: events as Record<string, number> }
}

function isPositiveInteger(value: number): boolean {
	return Number.isInteger(value) && value > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null) {
		return false
	}
	const prototype = Object.getPrototypeOf(value)

	return prototype === Object.prototype || prototype === null
}

function randomId(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
	const bytes = new Uint8Array(16)

	if (globalThis.crypto?.getRandomValues !== undefined) {
		globalThis.crypto.getRandomValues(bytes)
	} else {
		for (let i = 0; i < bytes.length; i++) {
			bytes[i] = Math.floor(Math.random() * 256)
		}
	}

	return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}
