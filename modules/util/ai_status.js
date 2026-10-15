let _statusPromise;

const unavailable = Object.freeze({
    ai: false,
    translate: false,
    privacy: false
});

export function utilAIStatus() {
    if (_statusPromise) return _statusPromise;

    // `fetch` is called inside the promise so that a synchronous throw (no
    // fetch at all, or a mocked one) degrades to "unavailable" like a network
    // error does, instead of crashing the UI that asked for the status.
    _statusPromise = new Promise(resolve => resolve(fetch('/api/osm-ai/status')))
        .then(response => {
            if (!response.ok) throw new Error('AI status request failed');
            return response.json();
        })
        .then(status => ({
            ai: status.ai === true,
            translate: status.translate === true,
            privacy: status.privacy === true
        }))
        .catch(() => unavailable);

    return _statusPromise;
}

export function utilResetAIStatus() {
    _statusPromise = undefined;
}
