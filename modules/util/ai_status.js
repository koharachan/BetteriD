let _statusPromise;

const unavailable = Object.freeze({
    ai: false,
    translate: false,
    privacy: false
});

export function utilAIStatus() {
    if (_statusPromise) return _statusPromise;

    _statusPromise = fetch('/api/osm-ai/status')
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
