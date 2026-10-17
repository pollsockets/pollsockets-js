# Changelog

All notable changes to `pollsockets-js` will be documented in this file.

## 2.0.0 - Unreleased

### Breaking changes

- Rewritten in TypeScript. The package is an ES module and ships type declarations.
- `useSocket()` and `stopSockets()` are removed. Use `createPollsocket(channel, options)` with `on()`, `onAny()`, `start()` and `stop()`.
- Requires pollsockets-laravel 2.x, because the poll response format changed.

### Added

- A cursor with server time (`since`). Each poll asks for the events newer than 2000 ms before the client's cursor (the newest event received, or the server time after a reset). The client ignores the events that it already handled, so an event whose write lands up to about 2 s late is still delivered.
- `clientId` and the `X-Pollsockets-Client` header to ignore events that this client caused.
- `onStale` when events were possibly missed, and `onError` for errors.
- Pause while the tab is hidden or the browser is offline.
- Retry with backoff after errors.
- `createPollsocket` throws on an invalid `clientId`, `interval`, `retention` or `since`.
- Every instance keeps its own state, so more than one channel can be used at the same time.

## 1.0.1 - 2023-04-04

Bumping version for npm registry

**Full Changelog**: https://github.com/pollsockets/pollsockets-js/compare/1.0.0...1.0.1

## 1.0.0 - 2023-04-03

### First release

**Full Changelog**: https://github.com/pollsockets/pollsockets-js/commits/1.0.0
