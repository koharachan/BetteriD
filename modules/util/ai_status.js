import { directAiAvailable } from '../core/betterid_ai';

let _statusPromise;

const unavailable = Object.freeze({
    ai: false,
    translate: false,
    privacy: false
});


/**
 * What AI-backed features are usable right now.
 *
 * The server's capability flags are fetched once; a provider the user
 * configured in Preferences → AI (or one the deployment ships for the
 * browser) is layered on top at call time, so enabling a key takes effect
 * without a reload. Privacy upload is a server credential and never comes
 * from the browser side. The desktop app has no server to ask.
 *
 * @returns {Promise<{ai: boolean, translate: boolean, privacy: boolean}>}
 */
export function utilAIStatus() {
    if (!_statusPromise) {
        _statusPromise = globalThis.BETTERID_DESKTOP
            ? Promise.resolve(unavailable)
            // `fetch` is called inside the promise so that a synchronous throw
            // (no fetch at all, or a mocked one) degrades to "unavailable" like
            // a network error does, instead of crashing the UI that asked.
            : new Promise(resolve => resolve(fetch('/api/osm-ai/status')))
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
    }

    return _statusPromise.then(server => {
        const direct = directAiAvailable();
        if (!direct) return server;
        return { ai: true, translate: true, privacy: server.privacy };
    });
}

export function utilResetAIStatus() {
    _statusPromise = undefined;
}
