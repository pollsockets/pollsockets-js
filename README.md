# Serverside implementation of pollsockets tailored for Laravel

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

## Usage

```js
import {useSocket} from "pollsockets-js"

// Channel name can be any string. Can be used to separate events from different sources.
let channelName = 'channel';
// Event name can be any string. Can be used to separate events of the same type.
let event = 'reload';

// Subscribe to an event from anywhere in your code. Perfect for updating the UI when something happens.
useSocket(channelName, {
	event: () => doSomething()
}, {
	pollInterval: 1000,
})
```

You can stop polling by calling `stopSockets()`.
```js
import {stopSockets} from "pollsockets-js"

stopSockets()
```

## Changelog

Please see [CHANGELOG](CHANGELOG.md) for more information on what has changed recently.

## Security Vulnerabilities

Please review [our security policy](../../security/policy) on how to report security vulnerabilities.

## Credits

- [Vytautas Smilingis](https://github.com/Plytas)
- [All Contributors](../../contributors)

## License

The MIT License (MIT). Please see [License File](LICENSE.md) for more information.
