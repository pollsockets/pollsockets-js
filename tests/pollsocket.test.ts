import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLIENT_HEADER, createPollsocket, type PollsocketOptions } from '../src/index.js'

type Body = unknown

class FakeDocument extends EventTarget {
	visibilityState: 'visible' | 'hidden' = 'visible'

	setVisibility(state: 'visible' | 'hidden'): void {
		this.visibilityState = state
		this.dispatchEvent(new Event('visibilitychange'))
	}
}

let fakeDocument: FakeDocument
let fakeWindow: EventTarget

function json(body: Body, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** A fetch mock that answers each call with the next queued body (or the fallback). */
function mockFetch(...bodies: Array<Body | Error | Response>) {
	const queue = [...bodies]
	const fallback = { time: 0, events: {} }

	return vi.fn((_url: string | URL | Request, _init?: RequestInit) => {
		const next = queue.length > 0 ? queue.shift() : fallback
		if (next instanceof Error) {
			return Promise.reject(next)
		}
		if (next instanceof Response) {
			return Promise.resolve(next)
		}

		return Promise.resolve(json(next))
	})
}

function create(fetch: ReturnType<typeof mockFetch>, options: PollsocketOptions = {}) {
	return createPollsocket('orders', { fetch, clientId: 'me', ...options })
}

/** A fetch mock whose requests stay pending until `resolve` answers the latest one. */
function pendingFetch() {
	let settle: (response: Response) => void = () => {}
	const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => new Promise<Response>((r) => (settle = r)))

	return { fetch, resolve: (response: Response) => settle(response) }
}

function sinceOf(fetch: ReturnType<typeof mockFetch>, call: number): string | null {
	return new URL(String(fetch.mock.calls[call]![0])).searchParams.get('since')
}

/** The `since` query the client sends for a given cursor: it reads the last 2000 ms again. */
function sinceFor(cursor: number): string {
	return String(Math.max(0, cursor - 2000))
}

/** Let pending promise callbacks run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
	vi.useFakeTimers()
	fakeDocument = new FakeDocument()
	fakeWindow = new EventTarget()
	vi.stubGlobal('document', fakeDocument)
	vi.stubGlobal('window', fakeWindow)
	vi.stubGlobal('location', { href: 'https://app.test/dashboard' })
	vi.stubGlobal('navigator', { onLine: true })
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
})

describe('createPollsocket', () => {
	it('does not start polling until start() is called', async () => {
		const fetch = mockFetch()
		create(fetch)

		await vi.advanceTimersByTimeAsync(5000)

		expect(fetch).not.toHaveBeenCalled()
	})

	it('exposes channel, client id and the header name', () => {
		const socket = create(mockFetch())

		expect(socket.channel).toBe('orders')
		expect(socket.clientId).toBe('me')
		expect(CLIENT_HEADER).toBe('X-Pollsockets-Client')
	})

	it('generates a random 16-character client id', () => {
		const a = createPollsocket('orders')
		const b = createPollsocket('orders')

		expect(a.clientId).toMatch(/^[a-z0-9]{16}$/)
		expect(b.clientId).toMatch(/^[a-z0-9]{16}$/)
		expect(a.clientId).not.toBe(b.clientId)
	})

	it('requests the default url with the expected fetch options', async () => {
		const fetch = mockFetch()
		const socket = createPollsocket('a b', { fetch, headers: { 'X-CSRF': 'token' } })

		socket.start()
		await flush()

		const [url, init] = fetch.mock.calls[0]!
		expect(url).toBe('https://app.test/_pollsockets/a%20b/poll')
		expect(init).toMatchObject({
			credentials: 'same-origin',
			cache: 'no-store',
			headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'X-CSRF': 'token' },
		})
		expect(init!.signal).toBeInstanceOf(AbortSignal)
		socket.stop()
	})

	it('resolves the global fetch at call time', async () => {
		const fetch = mockFetch()
		const socket = createPollsocket('orders')
		vi.stubGlobal('fetch', fetch)

		socket.start()
		await flush()

		expect(fetch).toHaveBeenCalledTimes(1)
		socket.stop()
	})

	it('uses an absolute url when there is no location', async () => {
		vi.stubGlobal('location', undefined)
		const fetch = mockFetch()
		const socket = create(fetch, { url: 'https://api.test/poll?x=1', since: 5000 })

		socket.start()
		await flush()

		expect(fetch.mock.calls[0]![0]).toBe('https://api.test/poll?x=1&since=3000')
		socket.stop()
	})

	it('baselines on the first response without firing', async () => {
		const fetch = mockFetch({ time: 1000, events: { 'created|other': 900 } }, { time: 2000, events: {} })
		const socket = create(fetch)
		const callback = vi.fn()
		const any = vi.fn()
		socket.on('created', callback)
		socket.onAny(any)

		socket.start()
		await flush()
		expect(sinceOf(fetch, 0)).toBeNull()

		await vi.advanceTimersByTimeAsync(1000)

		expect(callback).not.toHaveBeenCalled()
		expect(any).not.toHaveBeenCalled()
		expect(sinceOf(fetch, 1)).toBe(sinceFor(1000))
		socket.stop()
	})

	it('fires on and onAny once with sorted unique event names', async () => {
		const fetch = mockFetch(
			{ time: 1000, events: {} },
			{ time: 2000, events: { 'updated|a': 1500, 'created|b': 1600, 'created|': 1700, 'deleted|x': 1100 } },
		)
		const socket = create(fetch)
		const created = vi.fn()
		const updated = vi.fn()
		const any = vi.fn()
		socket.on('created', created)
		socket.on('updated', updated)
		socket.onAny(any)

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(created).toHaveBeenCalledTimes(1)
		expect(updated).toHaveBeenCalledTimes(1)
		expect(any).toHaveBeenCalledTimes(1)
		expect(any).toHaveBeenCalledWith(['created', 'deleted', 'updated'])
		socket.stop()
	})

	it('splits members at the last separator', async () => {
		const fetch = mockFetch({ time: 1000, events: {} }, { time: 2000, events: { 'a|b|me': 1500, 'c|d|x': 1600 } })
		const socket = create(fetch)
		const any = vi.fn()
		socket.onAny(any)

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(any).toHaveBeenCalledWith(['c|d'])
		socket.stop()
	})

	it('skips own-origin members but still advances the cursor', async () => {
		const fetch = mockFetch(
			{ time: 1000, events: {} },
			{ time: 2000, events: { 'created|me': 1900, 'updated|other': 1200 } },
			{ time: 3000, events: {} },
		)
		const socket = create(fetch)
		const created = vi.fn()
		const any = vi.fn()
		socket.on('created', created)
		socket.onAny(any)

		socket.start()
		await vi.advanceTimersByTimeAsync(2000)

		expect(created).not.toHaveBeenCalled()
		expect(any).toHaveBeenCalledWith(['updated'])
		expect(sinceOf(fetch, 2)).toBe(sinceFor(1900))
		socket.stop()
	})

	it('does not fire onAny when only own events arrive', async () => {
		const fetch = mockFetch({ time: 1000, events: {} }, { time: 2000, events: { 'created|me': 1900 } })
		const socket = create(fetch)
		const any = vi.fn()
		socket.onAny(any)

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(any).not.toHaveBeenCalled()
		socket.stop()
	})

	it('sends since from the max score and does not re-fire an event the cursor has passed', async () => {
		const fetch = mockFetch(
			{ time: 1000, events: {} },
			{ time: 2000, events: { 'created|x': 1500 } },
			// The server bound is exclusive, so the next response holds only newer members.
			{ time: 3000, events: {} },
			{ time: 4000, events: { 'created|x': 3500 } },
		)
		const socket = create(fetch)
		const created = vi.fn()
		socket.on('created', created)

		socket.start()
		await vi.advanceTimersByTimeAsync(3000)

		expect(sinceOf(fetch, 1)).toBe(sinceFor(1000))
		expect(sinceOf(fetch, 2)).toBe(sinceFor(1500))
		expect(sinceOf(fetch, 3)).toBe(sinceFor(1500))
		expect(created).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('never moves the cursor backwards', async () => {
		const fetch = mockFetch({ time: 5000, events: {} }, { time: 6000, events: { 'created|x': 4000 } }, { time: 7000, events: {} })
		const socket = create(fetch)

		socket.start()
		await vi.advanceTimersByTimeAsync(2000)

		expect(sinceOf(fetch, 2)).toBe(sinceFor(5000))
		socket.stop()
	})

	it('starts from the since option and fires on the first response', async () => {
		const fetch = mockFetch({ time: 2000, events: { 'created|x': 1500 } })
		const socket = create(fetch, { since: 1000 })
		const created = vi.fn()
		socket.on('created', created)

		socket.start()
		await flush()

		expect(sinceOf(fetch, 0)).toBe(sinceFor(1000))
		expect(created).toHaveBeenCalledTimes(1)
		socket.stop()
	})

	it('calls onStale and fires nothing when the gap between responses is too long', async () => {
		const fetch = mockFetch(
			{ time: 1000, events: {} },
			{ time: 1000 + 58001, events: { 'created|x': 50000 } },
			{ time: 60000, events: {} },
		)
		const onStale = vi.fn()
		const socket = create(fetch, { onStale })
		const created = vi.fn()
		socket.on('created', created)

		socket.start()
		await vi.advanceTimersByTimeAsync(2000)

		expect(onStale).toHaveBeenCalledTimes(1)
		expect(created).not.toHaveBeenCalled()
		expect(sinceOf(fetch, 2)).toBe(sinceFor(59001))
		socket.stop()
	})

	it('is not stale at exactly retention minus the margin', async () => {
		const fetch = mockFetch({ time: 1000, events: {} }, { time: 1000 + 8000, events: { 'created|x': 5000 } })
		const onStale = vi.fn()
		const socket = create(fetch, { onStale, retention: 10000 })
		const created = vi.fn()
		socket.on('created', created)

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(onStale).not.toHaveBeenCalled()
		expect(created).toHaveBeenCalledTimes(1)
		socket.stop()
	})

	it('calls onStale when the initial since is already too old', async () => {
		const fetch = mockFetch({ time: 100000, events: { 'created|x': 99000 } }, { time: 101000, events: {} })
		const onStale = vi.fn()
		const socket = create(fetch, { onStale, since: 1000 })
		const created = vi.fn()
		socket.on('created', created)

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(onStale).toHaveBeenCalledTimes(1)
		expect(created).not.toHaveBeenCalled()
		expect(sinceOf(fetch, 1)).toBe(sinceFor(100000))
		socket.stop()
	})

	it('backs off 1s, 2s, 4s up to 30s on errors and resets after a success', async () => {
		const fetch = mockFetch(
			new Error('1'),
			new Error('2'),
			new Error('3'),
			new Error('4'),
			new Error('5'),
			new Error('6'),
			new Error('7'),
			{ time: 1000, events: {} },
			new Error('8'),
		)
		const onError = vi.fn()
		const socket = create(fetch, { onError })

		socket.start()
		await flush()
		expect(fetch).toHaveBeenCalledTimes(1)

		const delays = [1000, 2000, 4000, 8000, 16000, 30000, 30000]
		for (const [index, delay] of delays.entries()) {
			await vi.advanceTimersByTimeAsync(delay - 1)
			expect(fetch).toHaveBeenCalledTimes(index + 1)
			await vi.advanceTimersByTimeAsync(1)
			expect(fetch).toHaveBeenCalledTimes(index + 2)
		}

		// Call 8 succeeded: normal interval, then the next failure starts again at 1s.
		await vi.advanceTimersByTimeAsync(1000)
		expect(fetch).toHaveBeenCalledTimes(9)
		await vi.advanceTimersByTimeAsync(999)
		expect(fetch).toHaveBeenCalledTimes(9)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetch).toHaveBeenCalledTimes(10)

		expect(onError).toHaveBeenCalledTimes(8)
		socket.stop()
	})

	it('treats a non-2xx response as an error', async () => {
		const fetch = mockFetch(json({ message: 'Server Error' }, 500))
		const onError = vi.fn()
		const socket = create(fetch, { onError })

		socket.start()
		await flush()

		expect(onError).toHaveBeenCalledTimes(1)
		expect(String(onError.mock.calls[0]![0])).toContain('500')
		socket.stop()
	})

	it.each([
		['null', null],
		['missing time', { events: {} }],
		['fractional time', { time: 1.5, events: {} }],
		['non-empty array events', { time: 1, events: [1] }],
		['missing events', { time: 1 }],
		['string score', { time: 1, events: { 'a|': '5' } }],
		['null score', { time: 1, events: { 'a|': null } }],
		['fractional score', { time: 1, events: { 'a|': 1.5 } }],
		['unsafe integer time', { time: 1e20, events: {} }],
		['unsafe integer score', { time: 1, events: { 'a|': 1e20 } }],
	])('treats an invalid body (%s) as an error', async (_name, body) => {
		const fetch = mockFetch(body)
		const onError = vi.fn()
		const socket = create(fetch, { onError })

		socket.start()
		await flush()

		expect(onError).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1000)
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('treats a fetch that throws synchronously as an error and keeps polling', async () => {
		const fetch = vi.fn(() => {
			throw new Error('sync')
		})
		const onError = vi.fn()
		const socket = createPollsocket('orders', { fetch, onError })

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(onError).toHaveBeenCalledTimes(2)
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('treats an invalid JSON body as an error', async () => {
		const fetch = mockFetch(new Response('<html>', { status: 200 }))
		const onError = vi.fn()
		const socket = create(fetch, { onError })

		socket.start()
		await flush()

		expect(onError).toHaveBeenCalledTimes(1)
		socket.stop()
	})

	it('accepts an empty array as no events', async () => {
		const fetch = mockFetch({ time: 1000, events: [] }, { time: 2000, events: [] })
		const onError = vi.fn()
		const socket = create(fetch, { onError })

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(onError).not.toHaveBeenCalled()
		expect(sinceOf(fetch, 1)).toBe(sinceFor(1000))
		socket.stop()
	})

	it('reports callback exceptions and still runs the other callbacks and the loop', async () => {
		const fetch = mockFetch({ time: 1000, events: {} }, { time: 2000, events: { 'created|x': 1500 } })
		const failure = new Error('boom')
		const onError = vi.fn()
		const socket = create(fetch, { onError })
		const second = vi.fn()
		const any = vi.fn()
		socket.on('created', () => {
			throw failure
		})
		socket.on('created', second)
		socket.onAny(any)

		socket.start()
		await vi.advanceTimersByTimeAsync(2000)

		expect(onError).toHaveBeenCalledWith(failure)
		expect(second).toHaveBeenCalledTimes(1)
		expect(any).toHaveBeenCalledTimes(1)
		expect(fetch).toHaveBeenCalledTimes(3)
		socket.stop()
	})

	it('keeps polling when onError itself throws', async () => {
		const fetch = mockFetch(new Error('network'))
		const socket = create(fetch, {
			onError: () => {
				throw new Error('handler')
			},
		})

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('schedules the next poll only after the previous one completes', async () => {
		const { fetch, resolve } = pendingFetch()
		const socket = createPollsocket('orders', { fetch })

		socket.start()
		await vi.advanceTimersByTimeAsync(10000)
		expect(fetch).toHaveBeenCalledTimes(1)

		resolve(json({ time: 1, events: {} }))
		await vi.advanceTimersByTimeAsync(999)
		expect(fetch).toHaveBeenCalledTimes(1)
		await vi.advanceTimersByTimeAsync(1)
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('pauses while hidden and polls immediately when visible again', async () => {
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await flush()
		expect(fetch).toHaveBeenCalledTimes(1)

		fakeDocument.setVisibility('hidden')
		await vi.advanceTimersByTimeAsync(10000)
		expect(fetch).toHaveBeenCalledTimes(1)

		fakeDocument.setVisibility('visible')
		await flush()
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('aborts the in-flight request when hidden and discards its response', async () => {
		const { fetch, resolve } = pendingFetch()
		const any = vi.fn()
		const socket = createPollsocket('orders', { fetch, since: 1 })
		socket.onAny(any)

		socket.start()
		await flush()
		const signal = fetch.mock.calls[0]![1]!.signal!

		fakeDocument.setVisibility('hidden')
		expect(signal.aborted).toBe(true)

		resolve(json({ time: 2, events: { 'created|x': 2 } }))
		await vi.advanceTimersByTimeAsync(10000)

		expect(any).not.toHaveBeenCalled()
		expect(fetch).toHaveBeenCalledTimes(1)
		socket.stop()
	})

	it('does not poll on start while hidden', async () => {
		fakeDocument.visibilityState = 'hidden'
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await vi.advanceTimersByTimeAsync(5000)
		expect(fetch).not.toHaveBeenCalled()

		fakeDocument.setVisibility('visible')
		await flush()
		expect(fetch).toHaveBeenCalledTimes(1)
		socket.stop()
	})

	it('pauses while offline and polls immediately when online', async () => {
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await flush()

		fakeWindow.dispatchEvent(new Event('offline'))
		await vi.advanceTimersByTimeAsync(10000)
		expect(fetch).toHaveBeenCalledTimes(1)

		fakeWindow.dispatchEvent(new Event('online'))
		await flush()
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('discards a response that arrives after stop() and does not fetch again', async () => {
		const { fetch, resolve } = pendingFetch()
		const any = vi.fn()
		const onError = vi.fn()
		const socket = createPollsocket('orders', { fetch, since: 1, onError })
		socket.onAny(any)

		socket.start()
		await flush()
		socket.stop()
		expect(fetch.mock.calls[0]![1]!.signal!.aborted).toBe(true)

		resolve(json({ time: 2, events: { 'created|x': 2 } }))
		await vi.advanceTimersByTimeAsync(10000)

		expect(any).not.toHaveBeenCalled()
		expect(onError).not.toHaveBeenCalled()
		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it('removes its listeners on stop()', async () => {
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await flush()
		socket.stop()

		fakeDocument.setVisibility('hidden')
		fakeDocument.setVisibility('visible')
		fakeWindow.dispatchEvent(new Event('online'))
		await vi.advanceTimersByTimeAsync(10000)

		expect(fetch).toHaveBeenCalledTimes(1)
	})

	it('start() and stop() are idempotent', async () => {
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.stop()
		socket.start()
		socket.start()
		await flush()
		expect(fetch).toHaveBeenCalledTimes(1)

		socket.stop()
		socket.stop()
		socket.start()
		await flush()
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('works without document and window', async () => {
		vi.stubGlobal('document', undefined)
		vi.stubGlobal('window', undefined)
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await vi.advanceTimersByTimeAsync(1000)
		socket.stop()

		expect(fetch).toHaveBeenCalledTimes(2)
	})

	it('keeps state per instance', async () => {
		const fetchA = mockFetch({ time: 1000, events: {} }, { time: 2000, events: { 'created|x': 1500 } })
		const fetchB = mockFetch({ time: 5000, events: {} }, { time: 6000, events: {} })
		const a = createPollsocket('a', { fetch: fetchA })
		const b = createPollsocket('b', { fetch: fetchB })
		const createdA = vi.fn()
		const createdB = vi.fn()
		a.on('created', createdA)
		b.on('created', createdB)

		a.start()
		b.start()
		await vi.advanceTimersByTimeAsync(2000)
		b.stop()
		await vi.advanceTimersByTimeAsync(1000)

		expect(createdA).toHaveBeenCalledTimes(1)
		expect(createdB).not.toHaveBeenCalled()
		expect(sinceOf(fetchA, 2)).toBe(sinceFor(1500))
		expect(sinceOf(fetchB, 2)).toBe(sinceFor(5000))
		expect(fetchA).toHaveBeenCalledTimes(4)
		expect(fetchB).toHaveBeenCalledTimes(3)
		a.stop()
	})

	it('unsubscribes on and onAny callbacks', async () => {
		const fetch = mockFetch({ time: 1000, events: {} }, { time: 2000, events: { 'created|x': 1500 } })
		const socket = create(fetch)
		const created = vi.fn()
		const kept = vi.fn()
		const any = vi.fn()
		const offCreated = socket.on('created', created)
		socket.on('created', kept)
		const offAny = socket.onAny(any)

		offCreated()
		offAny()
		socket.start()
		await vi.advanceTimersByTimeAsync(1000)

		expect(created).not.toHaveBeenCalled()
		expect(any).not.toHaveBeenCalled()
		expect(kept).toHaveBeenCalledTimes(1)
		socket.stop()
	})
})

type Trigger = 'on' | 'onStale' | 'onError'

/**
 * Build an instance whose `trigger` callback runs `react` once:
 * `on` and `onStale` at t=1000 (second response), `onError` at t=0 (first response).
 */
function withTrigger(trigger: Trigger, react: (socket: ReturnType<typeof createPollsocket>) => void) {
	const bodies: Record<Trigger, Array<Body | Error>> = {
		on: [{ time: 1000, events: {} }, { time: 2000, events: { 'created|x': 1500 } }],
		onStale: [{ time: 1000, events: {} }, { time: 1000 + 58001, events: {} }],
		onError: [new Error('network')],
	}
	const fetch = mockFetch(...bodies[trigger])
	let fired = false
	const once = () => {
		if (!fired) {
			fired = true
			react(socket)
		}
	}
	const socket = createPollsocket('orders', {
		fetch,
		...(trigger === 'onStale' ? { onStale: once } : {}),
		...(trigger === 'onError' ? { onError: once } : {}),
	})
	if (trigger === 'on') {
		socket.on('created', once)
	}

	return { socket, fetch, triggerAt: trigger === 'onError' ? 0 : 1000 }
}

describe('stop() and start() from callbacks', () => {
	it.each(['on', 'onStale', 'onError'] as const)('stop() from %s leaves no pending timer and no more fetches', async (trigger) => {
		const { socket, fetch, triggerAt } = withTrigger(trigger, (s) => s.stop())

		socket.start()
		await vi.advanceTimersByTimeAsync(triggerAt)
		const calls = fetch.mock.calls.length

		expect(vi.getTimerCount()).toBe(0)
		await vi.advanceTimersByTimeAsync(10000)
		expect(fetch).toHaveBeenCalledTimes(calls)
	})

	it.each(['on', 'onStale', 'onError'] as const)('stop() from %s and a later start() poll at the normal rate', async (trigger) => {
		const { socket, fetch, triggerAt } = withTrigger(trigger, (s) => {
			s.stop()
			setTimeout(() => s.start(), 100)
		})

		socket.start()
		await vi.advanceTimersByTimeAsync(triggerAt + 100)
		const calls = fetch.mock.calls.length

		await vi.advanceTimersByTimeAsync(10000)

		expect(fetch.mock.calls.length - calls).toBe(10)
		expect(vi.getTimerCount()).toBe(1)
		socket.stop()
		expect(vi.getTimerCount()).toBe(0)
	})

	it.each(['on', 'onStale', 'onError'] as const)('stop() and start() at once from %s poll at the normal rate', async (trigger) => {
		const { socket, fetch, triggerAt } = withTrigger(trigger, (s) => {
			s.stop()
			s.start()
		})

		socket.start()
		await vi.advanceTimersByTimeAsync(triggerAt)
		const calls = fetch.mock.calls.length

		await vi.advanceTimersByTimeAsync(10000)

		expect(fetch.mock.calls.length - calls).toBe(10)
		expect(vi.getTimerCount()).toBe(1)
		socket.stop()
	})
})

describe('hidden and offline', () => {
	it('does not poll on hide/show while offline', async () => {
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await flush()
		fakeWindow.dispatchEvent(new Event('offline'))
		fakeDocument.setVisibility('hidden')
		fakeDocument.setVisibility('visible')
		await vi.advanceTimersByTimeAsync(10000)
		expect(fetch).toHaveBeenCalledTimes(1)

		fakeWindow.dispatchEvent(new Event('online'))
		await flush()
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('does not poll on online while hidden', async () => {
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await flush()
		fakeDocument.setVisibility('hidden')
		fakeWindow.dispatchEvent(new Event('offline'))
		fakeWindow.dispatchEvent(new Event('online'))
		await vi.advanceTimersByTimeAsync(10000)
		expect(fetch).toHaveBeenCalledTimes(1)

		fakeDocument.setVisibility('visible')
		await flush()
		expect(fetch).toHaveBeenCalledTimes(2)
		socket.stop()
	})

	it('reads navigator.onLine at start()', async () => {
		vi.stubGlobal('navigator', { onLine: false })
		const fetch = mockFetch()
		const socket = create(fetch)

		socket.start()
		await vi.advanceTimersByTimeAsync(5000)
		expect(fetch).not.toHaveBeenCalled()

		fakeWindow.dispatchEvent(new Event('online'))
		await flush()
		expect(fetch).toHaveBeenCalledTimes(1)
		socket.stop()
	})
})

describe('option validation', () => {
	it.each(['', 'a b', 'user:5', 'x'.repeat(65), 'ä'])('rejects clientId %j', (clientId) => {
		expect(() => createPollsocket('orders', { clientId })).toThrow(TypeError)
	})

	it.each(['A-z_9', 'x'.repeat(64)])('accepts clientId %j', (clientId) => {
		expect(createPollsocket('orders', { clientId }).clientId).toBe(clientId)
	})

	it.each([
		{ interval: 0 },
		{ interval: -1000 },
		{ interval: Number.NaN },
		{ interval: 1.5 },
		{ retention: 0 },
		{ retention: 60000.5 },
		{ interval: 58000, retention: 60000 },
		{ interval: 1000, retention: 2500 },
	])('rejects %j', (options) => {
		expect(() => createPollsocket('orders', options)).toThrow(RangeError)
	})

	it('accepts interval just below retention minus the margin', () => {
		expect(() => createPollsocket('orders', { interval: 57999, retention: 60000 })).not.toThrow()
	})

	it.each([-1, 1.5, 1e20, Number.NaN, Number.POSITIVE_INFINITY, '5' as unknown as number])('rejects since %j', (since) => {
		expect(() => createPollsocket('orders', { since })).toThrow(RangeError)
	})

	it.each([0, null, undefined])('accepts since %j', (since) => {
		expect(() => createPollsocket('orders', { since })).not.toThrow()
	})
})

describe('cursor overlap', () => {
	/** Start an instance with the given responses and return the onAny calls after `polls` polls. */
	async function run(bodies: Body[], options: PollsocketOptions = {}) {
		const fetch = mockFetch(...bodies)
		const any = vi.fn()
		const socket = create(fetch, options)
		socket.onAny(any)

		socket.start()
		await vi.advanceTimersByTimeAsync((bodies.length - 1) * 1000)
		socket.stop()

		return { fetch, fired: any.mock.calls.map(([events]) => events as string[]) }
	}

	it('sends since as the cursor minus 2000 ms, and no since before the baseline', async () => {
		const { fetch } = await run([
			{ time: 10000, events: {} },
			{ time: 13000, events: { 'a|x': 12500 } },
			{ time: 14000, events: {} },
		])

		expect(sinceOf(fetch, 0)).toBeNull()
		expect(sinceOf(fetch, 1)).toBe('8000')
		expect(sinceOf(fetch, 2)).toBe('10500')
	})

	it('sends since=0 when the cursor is 1500 (never a negative since)', async () => {
		const { fetch } = await run([{ time: 1500, events: {} }, { time: 2500, events: {} }])

		expect(sinceOf(fetch, 1)).toBe('0')
	})

	it('fires a member that arrives late with the same score as the cursor', async () => {
		const { fired } = await run([
			{ time: 900, events: {} },
			{ time: 1100, events: { 'a|x': 1000 } },
			{ time: 2100, events: { 'a|x': 1000, 'b|x': 1000 } },
		])

		expect(fired).toEqual([['a'], ['b']])
	})

	it('fires a member that arrives late with a score below the cursor', async () => {
		const { fired } = await run([
			{ time: 900, events: {} },
			{ time: 1100, events: { 'b|x': 1005 } },
			{ time: 2100, events: { 'a|x': 1000, 'b|x': 1005 } },
		])

		expect(fired).toEqual([['b'], ['a']])
	})

	it('does not fire a member again when the overlap returns it again', async () => {
		const { fired } = await run([
			{ time: 900, events: {} },
			{ time: 1100, events: { 'a|x': 1000 } },
			{ time: 2100, events: { 'a|x': 1000 } },
			{ time: 2900, events: { 'a|x': 1000 } },
		])

		expect(fired).toEqual([['a']])
	})

	it('fires a member again when it is published again with a higher score', async () => {
		const { fired } = await run([
			{ time: 900, events: {} },
			{ time: 1100, events: { 'a|x': 1000 } },
			{ time: 2100, events: { 'a|x': 1500 } },
		])

		expect(fired).toEqual([['a'], ['a']])
	})

	it('records own-origin members in the overlap without firing them', async () => {
		const { fired } = await run([
			{ time: 900, events: {} },
			{ time: 1100, events: { 'a|me': 1000 } },
			{ time: 2100, events: { 'a|me': 1000, 'b|x': 1001 } },
			{ time: 3100, events: { 'a|me': 1000, 'b|x': 1001 } },
		])

		expect(fired).toEqual([['b']])
	})

	it('fires a member committed at the baseline time after the baseline', async () => {
		const { fetch, fired } = await run([
			{ time: 2000, events: {} },
			{ time: 3000, events: { 'c|x': 2000 } },
		])

		expect(sinceOf(fetch, 1)).toBe('0')
		expect(fired).toEqual([['c']])
	})

	it('does not fire members that the baseline already returned', async () => {
		const { fired } = await run([
			{ time: 1000, events: { 'a|x': 1000 } },
			{ time: 2000, events: { 'a|x': 1000, 'b|x': 1500 } },
		])

		expect(fired).toEqual([['b']])
	})

	it('does not fire members that a stale response already returned', async () => {
		const onStale = vi.fn()
		const { fired } = await run(
			[
				{ time: 1000, events: {} },
				{ time: 60000, events: { 'a|x': 59500 } },
				{ time: 61000, events: { 'a|x': 59500, 'b|x': 60500 } },
			],
			{ onStale },
		)

		expect(onStale).toHaveBeenCalledTimes(1)
		expect(fired).toEqual([['b']])
	})

	it('fires members inside the overlap of an initial since on the first response', async () => {
		const { fetch, fired } = await run([{ time: 10500, events: { 'a|x': 9500, 'b|x': 10200 } }], { since: 10000 })

		expect(sinceOf(fetch, 0)).toBe('8000')
		expect(fired).toEqual([['a', 'b']])
	})
})
