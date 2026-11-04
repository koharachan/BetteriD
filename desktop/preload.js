// Runs in the editor window before the page, isolated from it. Exposes the
// little the editor needs to know about the desktop and relays the OAuth
// redirect caught by the main process.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const callbacks = new Set();
ipcRenderer.on('betterid:oauth-callback', (event, url) => {
    callbacks.forEach(callback => {
        try { callback(String(url)); } catch { /* ignore */ }
    });
});

contextBridge.exposeInMainWorld('BETTERID_DESKTOP', {
    /** Resolves with { version, platform, osm, userFile }. */
    config: () => ipcRenderer.invoke('betterid:config'),
    openExternal: url => ipcRenderer.send('betterid:open-external', String(url)),
    /**
     * Synchronous on purpose: `beforeunload` cannot wait for a promise.
     * Resolves true when the user chooses Exit.
     */
    confirmLeave: (message, locale) => ipcRenderer.sendSync('betterid:confirm-leave', {
        message: String(message ?? ''),
        locale: String(locale ?? '')
    }) === true,
    /** The OAuth redirect URL, once login comes back from openstreetmap.org. */
    onOAuthCallback: callback => {
        if (typeof callback === 'function') callbacks.add(callback);
    }
});
