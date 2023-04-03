let events = {};
let timeout = null;

export function useSocket(socketChannel, socketEvents, options = {}) {
	Object.entries(socketEvents).forEach(([event, callback]) => {
		events[event] = {
			lastTimestamp: Math.floor(Date.now() / 1000),
			callback: callback
		}
	})

	poll(socketChannel, options);
}

function callEvent(event, timestamp) {
	if (events[event] && events[event].callback && typeof events[event].callback === 'function') {
		if (events[event].lastTimestamp < timestamp) {
			events[event].lastTimestamp = timestamp;
			events[event].callback();
		}
	}
}

function poll(socketChannel, options = {}) {
	fetch(`/_pollsockets/${socketChannel}/poll`)
		.then((response) => response.json())
		.then(data => {
			if (typeof data === 'object') {
				Object.entries(data).forEach(([event, timestamp]) => {
					callEvent(event, timestamp);
				})
			}

			timeout = setTimeout(() => poll(socketChannel, options), options.pollInterval ?? 250);
		});
}

export function stopSockets() {
	clearTimeout(timeout);
}
