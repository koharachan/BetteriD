// Electron cancels a window close silently when `beforeunload` returns a
// string. The editor does that for unsaved changes (`context.save()`), which
// is why the title-bar X and the Exit menu do nothing after you draw.
// This guard keeps that check, asks the shell with a real dialog, and only
// returns the string when the user chooses to stay.

'use strict';

(function(global) {
    function editorLocale() {
        try {
            var container = global.document && global.document.getElementById('id-container');
            var fromEditor = container && container.getAttribute('lang');
            if (fromEditor) return fromEditor;
            var root = global.document && global.document.documentElement;
            if (root && root.lang) return root.lang;
            return (global.navigator && global.navigator.language) || '';
        } catch (error) {
            return '';
        }
    }

    function shouldConfirm(message) {
        return message != null && message !== false && message !== '';
    }

    function record(error) {
        var bucket = global.__betteridErrors;
        if (bucket && typeof bucket.push === 'function') {
            bucket.push('leave: ' + String((error && error.stack) || error));
        }
    }

    function install() {
        if (global.__betteridLeaveGuardInstalled) return;
        global.__betteridLeaveGuardInstalled = true;

        var inner = global.onbeforeunload;

        function pendingMessage() {
            var message = '';
            try {
                if (typeof inner === 'function') {
                    var value = inner.call(global);
                    if (shouldConfirm(value)) message = String(value);
                }
            } catch (error) {
                record(error);
            }
            return { message: message, locale: editorLocale() };
        }

        global.BetteriDLeaveGuard.pendingMessage = pendingMessage;

        // Window close is handled in the main process (so the unsaved-changes
        // dialog is not trapped inside beforeunload). This handler still runs
        // for reload and any other unload.
        global.onbeforeunload = function(event) {
            if (global.__betteridAllowLeave) {
                global.__betteridAllowLeave = false;
                if (event) event.returnValue = undefined;
                return;
            }

            var pending = pendingMessage();
            if (!pending.message) return;

            var leave = true;
            try {
                leave = global.BETTERID_DESKTOP.confirmLeave(pending.message, pending.locale) === true;
            } catch (error) {
                record(error);
                leave = true;
            }
            if (leave) {
                if (event) event.returnValue = undefined;
                return;
            }
            if (event) {
                event.preventDefault();
                event.returnValue = pending.message;
            }
            return pending.message;
        };
    }

    global.BetteriDLeaveGuard = { install: install };
})(typeof window !== 'undefined' ? window : globalThis);
