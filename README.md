# Client side implementation of pollsockets

[![Latest Version on NPM](https://img.shields.io/npm/v/pollsockets-js.svg?style=flat-square)](https://www.npmjs.com/package/pollsockets-js)
[![Total Downloads](https://img.shields.io/npm/dt/pollsockets-js.svg?style=flat-square)](https://www.npmjs.com/package/pollsockets-js)

## Why pollsockets?

Pollsockets is a simple, yet powerful, server-client communication library. It is designed to be used in situations where you need to send data from the server to the client. It is a great alternative to websockets, as it is much simpler to implement and use.

## How does it work?

Pollsockets uses a simple polling mechanism to send events from the server to the client. Instead of polling an endpoint that returns data, pollsockets polls an endpoint that returns a list of events that have occurred, thus saving bandwidth and response time. The client then processes the events and updates the UI accordingly.

## Ecosystem

### Server side
- [Laravel](https://github.com/pollsockets/pollsockets-laravel)

### Client side
- [Javascript](https://github.com/pollsockets/pollsockets-js)

## Installation

You can install the package via npm:

```bash
npm i pollsockets-js
```

Version 2.x of this package works with version 2.x of [pollsockets-laravel](https://github.com/pollsockets/pollsockets-laravel).

## Usage

```js
import { createPollsocket, CLIENT_HEADER } from 'pollsockets-js'

const socket = createPollsocket('orders', {
	// Optional: the server time (ms) from Pollsockets::now(), captured before the page's data is loaded.
	since: window.dataLoadedSince,
	// The client missed events it can no longer get, for example after the laptop slept.
	onStale: () => window.location.reload(),
})

const unsubscribe = socket.on('created', () => refreshOrders())
socket.onAny((events) => console.log('changed:', events))

socket.start()

// Later:
unsubscribe()
socket.stop()
```

`createPollsocket` does not start polling. Call `start()` when you are ready, and `stop()` when you are done. Both are safe to call more than once.

### Ignoring your own changes

Every instance has a `clientId`. Send it as the `X-Pollsockets-Client` header (exported as `CLIENT_HEADER`) on the requests that change data. The server stores it with the event, and this instance then ignores events that it caused. For example, with axios:

```js
axios.interceptors.request.use((config) => {
	config.headers[CLIENT_HEADER] = socket.clientId
	return config
})
```

### Starting point

Without `since`, the first response only sets the starting point and fires nothing. To also get the events that happen between the page render and the first poll, render `Pollsockets::now()` into the page and pass it as `since`.

Get the value of `Pollsockets::now()` **before** the page's data queries run, for example on the first line of the controller, or as an Inertia prop that resolves first. Do not get it at render time. A change that is committed between the data queries and the render is not in the page, and a `since` from the render time is after that change, so the client skips it.

> **Warning:** `since` must be the value of `Pollsockets::now()`, in **milliseconds**, rendered into a page that is **not cached**. A value in seconds (for example `now()->timestamp`), or a page from a cache that is older than `retention - 2000` ms, makes the first response stale. With `onStale: () => location.reload()` the page then reloads again and again.

With a `since`, the first poll also reads again the 2000 ms before it (see [Late writes](#late-writes)). An event in that window fires even if the page already shows the change. This can cause one redundant notification right after `start()`.

### Late writes

Every poll reads again the last 2000 ms before the client's cursor (the newest event received, or the server time after a reset). The client ignores the events that it already handled. Thus an event whose write reaches the server up to about 2 seconds after its timestamp is still delivered, for example two writes in the same millisecond or two server workers that finish in a different order. An event whose write is later than that can be missed.

### Missed events

The server keeps events for `retention` milliseconds. If the time between two successful polls is more than `retention - 2000` ms (for example, the tab was hidden or the device slept), some events can be lost. The client then calls `onStale()` and fires nothing for that response. Reloading the data, or the page, is the usual reaction.

### Behaviour

- `createPollsocket` throws if an option has an invalid value (see [Options](#options)).
- One request at a time. The next poll starts `interval` ms after the previous one finishes.
- While the tab is hidden or the browser is offline, polling pauses. It polls immediately when the tab is visible or the browser is online again.
- On an error (network, non-2xx status or an invalid body) the client calls `onError` and retries after `interval`, then 2×, 4×… up to 30 seconds. It never stops by itself.
- An exception in a callback goes to `onError`. The other callbacks still run.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | `/_pollsockets/{channel}/poll` | Poll endpoint. Relative to the current page, or absolute. |
| `interval` | `1000` | Milliseconds between polls. A positive integer, less than `retention - 2000`. |
| `retention` | `60000` | Milliseconds the server keeps an event. A positive integer. Must match the server's `retention` setting (seconds × 1000). |
| `since` | `null` | Initial cursor in server milliseconds, from `Pollsockets::now()`. `null` or a non-negative integer. |
| `clientId` | random 16 characters | Id sent with `X-Pollsockets-Client` to ignore your own events. Must match `^[A-Za-z0-9_-]{1,64}$`, because the server ignores any other value. |
| `headers` | `{}` | Extra request headers for the poll request. |
| `fetch` | `globalThis.fetch` | Custom fetch implementation. |
| `onStale` | – | Called when events were possibly missed. |
| `onError` | – | Called with every request error and callback exception. |

## Upgrading from v1

- `useSocket()` and `stopSockets()` are removed. Use `createPollsocket(channel, options)`, `on()` / `onAny()` and `start()` / `stop()`.
- `pollInterval` is now `interval`, and the default changed from 250 ms to 1000 ms.
- The server response format changed. Use pollsockets-laravel 2.x.
- The package is now an ES module with TypeScript types.

## Changelog

Please see [CHANGELOG](CHANGELOG.md) for more information on what has changed recently.

## Security Vulnerabilities

Please review [our security policy](../../security/policy) on how to report security vulnerabilities.

## Credits

- [Vytautas Smilingis](https://github.com/Plytas)
- [All Contributors](../../contributors)

## License

The MIT License (MIT). Please see [License File](LICENSE.md) for more information.
