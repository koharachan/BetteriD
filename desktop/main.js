// BetteriD desktop: the editor as a Windows / Linux application.
//
// There is no BetteriD server here. The built editor (`dist/`) is served to
// the window over a private `betterid://` scheme, the editor talks to the
// OpenStreetMap API and the imagery providers directly, AI features use the
// provider the user configures in Preferences → AI, and OSM login completes
// by catching the OAuth redirect in the popup instead of hosting a landing
// page on a web server.

'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { leaveApproved: choiceAllowsLeave, leaveDialogOptions } = require('./leave-prompt.js');

const SCHEME = 'betterid';
const ORIGIN = `${SCHEME}://app`;
const SMOKE = process.argv.includes('--smoke');

function quitProbeMode() {
    const arg = process.argv.find(item => item.startsWith('--quit-probe='));
    if (!arg) return null;
    const mode = arg.slice('--quit-probe='.length);
    return mode === 'quit' || mode === 'menu' || mode === 'stay' || mode === 'clean' ? mode : null;
}

const QUIT_PROBE = quitProbeMode();

let mainWindow = null;
let config = null;
// Set once the user has confirmed Exit, so the second close is not prompted again.
let allowUnload = false;
let closePromptOpen = false;
let probeTimer = null;
let probeSettled = false;
let mcpAdmin = null;


/* ------------------------------------------------------------- config -- */

/** Bundled defaults, overridden by `<userData>/config.json` when present. */
function loadConfig() {
    const defaults = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    const userFile = path.join(app.getPath('userData'), 'config.json');
    let user = {};
    try {
        user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
    } catch (error) {
        if (error.code !== 'ENOENT') {
            dialog.showErrorBox('BetteriD', `Could not read ${userFile}:\n${error.message}\n\nThe built-in defaults are used.`);
        }
    }
    const merged = {
        ...defaults,
        ...user,
        osm: { ...defaults.osm, ...(user.osm || {}) },
        window: { ...defaults.window, ...(user.window || {}) },
        mcp: { ...(defaults.mcp || {}), ...(user.mcp || {}) }
    };
    merged.userAgent = String(merged.userAgent || '').replace('{version}', app.getVersion());
    merged.userFile = userFile;
    return merged;
}


/* -------------------------------------------------------- static files -- */

/**
 * Where the editor's files live: the desktop shell, then the built editor.
 * In development the repository's `dist/` is used as it is (with a
 * `dist-desktop/` bundle taking precedence when one was built).
 */
function resourceRoots() {
    const roots = [path.join(__dirname, 'app')];
    if (!app.isPackaged) roots.push(path.join(__dirname, 'test'));   // quit-probe.html
    if (app.isPackaged) {
        roots.push(path.join(process.resourcesPath, 'dist'));
    } else {
        roots.push(path.join(__dirname, '..', 'dist-desktop'));
        roots.push(path.join(__dirname, '..', 'dist'));
        roots.push(path.join(__dirname, '..'));   // land.html
    }
    return roots;
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.map': 'application/json'
};

function resolveFile(pathname) {
    const relative = pathname.replace(/^\/+/, '') || 'index.html';
    // the shell links `dist/iD.css` like the website does; the editor itself
    // asks for `img/…`, `locales/…`, `tagging-schema/…` relative to the page
    const candidates = [relative];
    if (relative.startsWith('dist/')) candidates.push(relative.slice(5));

    for (const root of resourceRoots()) {
        for (const candidate of candidates) {
            const file = path.normalize(path.join(root, candidate));
            if (!file.startsWith(path.normalize(root + path.sep)) && file !== path.normalize(root)) continue;  // no escaping the roots
            if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
        }
    }
    return null;
}

function registerScheme() {
    protocol.handle(SCHEME, async (request) => {
        const url = new URL(request.url);
        const file = resolveFile(decodeURIComponent(url.pathname));
        if (!file) return new Response('Not found: ' + url.pathname, { status: 404 });
        const response = await net.fetch(pathToFileURL(file).toString());
        const headers = new Headers(response.headers);
        headers.set('Content-Type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
        return new Response(response.body, { status: 200, headers });
    });
}


/* ----------------------------------------------------- network headers -- */

/**
 * What the BetteriD server did for the website, done per request here:
 * identify the app honestly to every host (tile usage policies require a
 * real User-Agent), and let the pixel tools read imagery tiles that come
 * without CORS headers.
 */
function installRequestFilters(ses) {
    ses.setUserAgent(config.userAgent);

    ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = details.requestHeaders;
        headers['User-Agent'] = config.userAgent;
        callback({ requestHeaders: headers });
    });

    ses.webRequest.onHeadersReceived((details, callback) => {
        const headers = details.responseHeaders || {};
        const readable = details.resourceType === 'image' || details.resourceType === 'xhr' || details.resourceType === 'fetch';
        if (readable && !details.url.startsWith(ORIGIN)) {
            const hasCors = Object.keys(headers).some(name => name.toLowerCase() === 'access-control-allow-origin');
            if (!hasCors) headers['Access-Control-Allow-Origin'] = ['*'];
        }
        callback({ responseHeaders: headers });
    });
}


/* ---------------------------------------------------------------- OAuth -- */

/**
 * osm-auth opens a popup, sends it to openstreetmap.org and expects the
 * redirect page to post the callback URL on a BroadcastChannel. Without a
 * server there is nothing at the redirect URI, so the redirect is caught
 * here before it is requested and handed to the editor window.
 */
function watchOAuthPopup(popup) {
    const redirectUri = config.osm.redirect_uri;
    const intercept = (event, url) => {
        if (!url.startsWith(redirectUri)) return;
        event.preventDefault();
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('betterid:oauth-callback', url);
            mainWindow.focus();
        }
        if (!popup.isDestroyed()) popup.close();
    };
    popup.webContents.on('will-redirect', intercept);
    popup.webContents.on('will-navigate', intercept);
    popup.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });
}


/* --------------------------------------------------------------- window -- */

function boundsFile() {
    return path.join(app.getPath('userData'), 'window.json');
}

function restoreBounds() {
    try {
        return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
    } catch {
        return {};
    }
}

function saveBounds(win) {
    try {
        const bounds = win.isMaximized() ? { ...win.getNormalBounds(), maximized: true } : win.getBounds();
        fs.writeFileSync(boundsFile(), JSON.stringify(bounds));
    } catch { /* ignore */ }
}

function createWindow() {
    const saved = restoreBounds();
    mainWindow = new BrowserWindow({
        width: saved.width || config.window.width,
        height: saved.height || config.window.height,
        x: saved.x,
        y: saved.y,
        minWidth: 800,
        minHeight: 500,
        title: 'BetteriD',
        backgroundColor: '#ffffff',
        show: false,
        icon: path.join(__dirname, 'build', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            spellcheck: false
        }
    });
    if (saved.maximized) mainWindow.maximize();

    mainWindow.once('ready-to-show', () => mainWindow.show());
    // Electron never shows the browser beforeunload prompt: a returned string
    // cancels the close with no dialog. The title-bar X and the Exit menu
    // (role: quit → app.quit → this event) both hit that path once the editor
    // has unsaved changes. Ask ourselves, then close for real.
    mainWindow.on('close', (event) => {
        saveBounds(mainWindow);
        if (allowUnload) {
            for (const win of BrowserWindow.getAllWindows()) {
                if (win !== mainWindow && !win.isDestroyed()) win.destroy();
            }
            return;
        }
        event.preventDefault();
        beginClose(mainWindow);
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.on('will-prevent-unload', (event) => {
        if (allowUnload) event.preventDefault();
    });

    // only osm-auth's popup stays inside the app; every other link opens in
    // the system browser
    mainWindow.webContents.setWindowOpenHandler(({ url, frameName }) => {
        if (frameName === 'oauth_window' || url === 'about:blank' || url.startsWith(config.osm.url + '/oauth2/') ||
            url.startsWith(config.osm.url + '/login') || url.startsWith(config.osm.url + '/logout')) {
            return {
                action: 'allow',
                overrideBrowserWindowOptions: {
                    width: 560,
                    height: 700,
                    parent: mainWindow,
                    autoHideMenuBar: true,
                    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
                }
            };
        }
        if (/^https?:/.test(url)) shell.openExternal(url);
        return { action: 'deny' };
    });
    mainWindow.webContents.on('did-create-window', watchOAuthPopup);

    // the editor is a single page: a navigation away from it is a link
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url.startsWith(ORIGIN)) return;
        event.preventDefault();
        if (/^https?:/.test(url)) shell.openExternal(url);
    });

    const page = QUIT_PROBE
        ? `${ORIGIN}/quit-probe.html${QUIT_PROBE === 'clean' ? '?clean=1' : ''}`
        : `${ORIGIN}/index.html`;
    mainWindow.loadURL(page);

    if (SMOKE) runSmokeTest(mainWindow);
    if (QUIT_PROBE) runQuitProbe(mainWindow);
}


/**
 * The editor's `beforeunload` handler returns a warning string when there are
 * unsaved changes, after writing them to local storage. Show that warning and,
 * if the user exits, let the window close so the process can quit.
 */
function beginClose(win) {
    if (allowUnload || win.isDestroyed() || closePromptOpen) return;
    closePromptOpen = true;

    const finish = (approved) => {
        closePromptOpen = false;
        if (!approved || win.isDestroyed()) {
            if (QUIT_PROBE === 'stay' && !approved) {
                setTimeout(() => {
                    const alive = mainWindow && !mainWindow.isDestroyed();
                    finishProbe(alive, alive ? 'window stayed open' : 'closed after cancel');
                }, 800);
            }
            return;
        }
        allowUnload = true;
        const leave = () => {
            if (win.isDestroyed()) return;
            win.close();
            // A cancelled app.quit() can leave the portable wrapper alive after the
            // window is gone. If nothing is left open, end the process.
            setTimeout(() => {
                if (QUIT_PROBE || probeSettled) return;
                if (BrowserWindow.getAllWindows().length === 0) app.exit(0);
            }, 1000);
        };
        win.webContents.executeJavaScript('window.__betteridAllowLeave = true').then(leave, leave);
    };

    win.webContents.executeJavaScript(`(() => {
        if (!window.BetteriDLeaveGuard || typeof window.BetteriDLeaveGuard.pendingMessage !== 'function') {
            return { message: '', locale: '' };
        }
        return window.BetteriDLeaveGuard.pendingMessage();
    })()`).then((state) => {
        const message = state && state.message ? String(state.message) : '';
        if (!message) return finish(true);
        if (QUIT_PROBE === 'clean') {
            console.log('[quit-probe] FAIL: prompted with no unsaved changes');   // eslint-disable-line no-console
            finishProbe(false, 'prompted with no unsaved changes');
            return;
        }
        if (QUIT_PROBE === 'quit' || QUIT_PROBE === 'menu') return finish(true);
        if (QUIT_PROBE === 'stay') return finish(false);

        const locale = String((state && state.locale) || app.getLocale() || '');
        let approved = true;
        try {
            const choice = dialog.showMessageBoxSync(win, leaveDialogOptions({
                locale,
                message,
                platform: process.platform
            }));
            approved = choiceAllowsLeave(choice);
        } catch (error) {
            // A broken dialog must not leave the process unkillable except from Task Manager.
            console.error('[betterid] quit dialog failed:', error);   // eslint-disable-line no-console
            approved = true;
        }
        finish(approved);
    }, () => finish(true));
}


function finishProbe(ok, message) {
    if (probeSettled) return;
    probeSettled = true;
    if (probeTimer) clearTimeout(probeTimer);
    probeTimer = null;
    console.log(`[quit-probe] ${ok ? 'OK' : 'FAIL'}: ${message}`);   // eslint-disable-line no-console
    app.exit(ok ? 0 : 1);
}


/** `--quit-probe`: close a page with and without an unsaved-changes warning. */
function runQuitProbe(win) {
    const finish = (ok, message) => finishProbe(ok, message);
    probeTimer = setTimeout(() => finish(false, 'timed out'), 15000);

    win.webContents.once('did-fail-load', (event, code, description) => {
        finish(false, `load failed: ${code} ${description}`);
    });
    win.webContents.once('did-finish-load', () => {
        win.webContents.executeJavaScript('document.title').then((title) => {
            if (title !== 'quit-probe-ready') {
                finish(false, `probe page did not load (${title})`);
                return;
            }
            if (QUIT_PROBE === 'menu') app.quit();
            else win.close();
        }).catch((error) => finish(false, error.message));
    });
}


/** `--smoke`: load the editor, check it came up, save a screenshot, exit. */
function runSmokeTest(win) {
    const outDir = path.join(__dirname, '..', 'dist-desktop');
    const finish = (ok, message) => {
        console.log(`[smoke] ${ok ? 'OK' : 'FAIL'}: ${message}`);   // eslint-disable-line no-console
        setTimeout(() => app.exit(ok ? 0 : 1), 50);
    };
    const timer = setTimeout(() => finish(false, 'the editor did not load within 60s'), 60000);

    win.webContents.on('did-fail-load', (event, code, description) => {
        clearTimeout(timer);
        finish(false, `load failed: ${code} ${description}`);
    });
    win.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
            try {
                const state = await win.webContents.executeJavaScript(`({
                    hasID: typeof iD !== 'undefined',
                    map: !!document.querySelector('.main-map svg'),
                    palette: document.querySelectorAll('.betterid-tool-button').length,
                    desktop: !!window.BETTERID_DESKTOP,
                    leaveGuard: window.__betteridLeaveGuardInstalled === true,
                    errors: window.__betteridErrors || [],
                    body: document.body.innerText.slice(0, 500),
                    html: document.querySelector('#id-container').innerHTML.slice(0, 500)
                })`);
                fs.mkdirSync(outDir, { recursive: true });
                const image = await win.webContents.capturePage();
                fs.writeFileSync(path.join(outDir, 'smoke.png'), image.toPNG());
                clearTimeout(timer);
                const ok = state.hasID && state.map && state.palette >= 4 && state.desktop && state.leaveGuard && !state.errors.length;
                finish(ok, JSON.stringify(state));
            } catch (error) {
                clearTimeout(timer);
                finish(false, error.message);
            }
        }, 15000);
    });
}


function mcpAdminModulePath() {
    if (app.isPackaged) return path.join(process.resourcesPath, 'mcp_admin.mjs');
    return path.join(__dirname, '..', 'scripts', 'mcp_admin.mjs');
}


/** Local page for MCP servers and Codex sign-in. Failure here must not stop the editor. */
async function startMcpAdmin() {
    try {
        const { createMcpAdmin } = await import(pathToFileURL(mcpAdminModulePath()).href);
        mcpAdmin = createMcpAdmin({
            prefix: '',
            storePath: path.join(app.getPath('userData'), 'mcp-servers.json')
        });
        const started = await mcpAdmin.start({
            host: '127.0.0.1',
            port: Number(config.mcp && config.mcp.port) || 9179
        });
        config.mcpAdminUrl = started.url;
    } catch (error) {
        config.mcpAdminUrl = '';
        console.error('MCP settings did not start:', error);
    }
}


function buildMenu() {
    const template = [
        {
            label: 'BetteriD',
            submenu: [
                { label: 'Open settings file…', click: () => shell.openPath(config.userFile).then(() => shell.showItemInFolder(config.userFile)) },
                {
                    label: 'Open MCP settings',
                    enabled: Boolean(config.mcpAdminUrl),
                    click: () => shell.openExternal(config.mcpAdminUrl)
                },
                { type: 'separator' },
                { role: 'quit' }
            ]
        },
        { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
        { label: 'View', submenu: [{ role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' }, { role: 'togglefullscreen' }] },
        {
            label: 'Help',
            submenu: [
                { label: 'BetteriD on GitHub', click: () => shell.openExternal('https://github.com/koharachan/BetteriD') },
                { label: 'Report an issue', click: () => shell.openExternal('https://github.com/koharachan/BetteriD/issues') },
                { label: 'Register an OSM OAuth client (for your own build)', click: () => shell.openExternal(config.osm.url + '/oauth2/applications/new') }
            ]
        }
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}


/* ----------------------------------------------------------------- app -- */

protocol.registerSchemesAsPrivileged([{
    scheme: SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true }
}]);

if (QUIT_PROBE) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'betterid-quit-probe-'));
    app.setPath('userData', dir);
}

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(async () => {
        config = loadConfig();
        registerScheme();
        installRequestFilters(session.defaultSession);
        await startMcpAdmin();
        buildMenu();

        ipcMain.handle('betterid:config', () => ({
            version: app.getVersion(),
            platform: process.platform,
            osm: config.osm,
            userFile: config.userFile,
            mcpAdminUrl: config.mcpAdminUrl || ''
        }));
        ipcMain.on('betterid:open-external', (event, url) => {
            if (/^https?:/.test(String(url))) shell.openExternal(String(url));
        });
        // Reload (and any unload that is not the window `close` event) still
        // goes through the page's beforeunload handler, which asks here.
        ipcMain.on('betterid:confirm-leave', (event, payload) => {
            if (QUIT_PROBE) {
                // Window close is handled in the main process. If beforeunload
                // also runs, the user would get a second dialog.
                console.log('[quit-probe] FAIL: beforeunload ran during close');   // eslint-disable-line no-console
                event.returnValue = false;
                finishProbe(false, 'beforeunload ran during close');
                return;
            }
            const request = payload && typeof payload === 'object' ? payload : { message: payload };
            const message = String(request.message || '');
            const locale = String(request.locale || app.getLocale() || '');
            if (!message) {
                event.returnValue = true;
                return;
            }
            if (QUIT_PROBE === 'quit' || QUIT_PROBE === 'menu') {
                allowUnload = true;
                event.returnValue = true;
                return;
            }
            if (QUIT_PROBE === 'stay' || QUIT_PROBE === 'clean') {
                event.returnValue = false;
                return;
            }
            const win = BrowserWindow.fromWebContents(event.sender);
            if (!win || win.isDestroyed()) {
                allowUnload = true;
                event.returnValue = true;
                return;
            }
            try {
                const choice = dialog.showMessageBoxSync(win, leaveDialogOptions({
                    locale,
                    message,
                    platform: process.platform
                }));
                const approved = choiceAllowsLeave(choice);
                if (approved) allowUnload = true;
                event.returnValue = approved;
            } catch (error) {
                console.error('[betterid] quit dialog failed:', error);   // eslint-disable-line no-console
                allowUnload = true;
                event.returnValue = true;
            }
        });

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        if (QUIT_PROBE === 'stay') {
            finishProbe(false, 'window closed');
            return;
        }
        if (probeTimer) {
            clearTimeout(probeTimer);
            probeTimer = null;
        }
        if (QUIT_PROBE) {
            console.log('[quit-probe] OK: window closed');   // eslint-disable-line no-console
        }
        if (mcpAdmin) mcpAdmin.stop();
        app.quit();
    });
}
