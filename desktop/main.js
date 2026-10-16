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
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SCHEME = 'betterid';
const ORIGIN = `${SCHEME}://app`;
const SMOKE = process.argv.includes('--smoke');

let mainWindow = null;
let config = null;


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
        window: { ...defaults.window, ...(user.window || {}) }
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
    mainWindow.on('close', () => saveBounds(mainWindow));
    mainWindow.on('closed', () => { mainWindow = null; });

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

    mainWindow.loadURL(`${ORIGIN}/index.html`);

    if (SMOKE) runSmokeTest(mainWindow);
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
                    errors: window.__betteridErrors || [],
                    body: document.body.innerText.slice(0, 500),
                    html: document.querySelector('#id-container').innerHTML.slice(0, 500)
                })`);
                fs.mkdirSync(outDir, { recursive: true });
                const image = await win.webContents.capturePage();
                fs.writeFileSync(path.join(outDir, 'smoke.png'), image.toPNG());
                clearTimeout(timer);
                const ok = state.hasID && state.map && state.palette >= 4 && state.desktop && !state.errors.length;
                finish(ok, JSON.stringify(state));
            } catch (error) {
                clearTimeout(timer);
                finish(false, error.message);
            }
        }, 15000);
    });
}


function buildMenu() {
    const template = [
        {
            label: 'BetteriD',
            submenu: [
                { label: 'Open settings file…', click: () => shell.openPath(config.userFile).then(() => shell.showItemInFolder(config.userFile)) },
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

if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });

    app.whenReady().then(() => {
        config = loadConfig();
        registerScheme();
        installRequestFilters(session.defaultSession);
        buildMenu();

        ipcMain.handle('betterid:config', () => ({
            version: app.getVersion(),
            platform: process.platform,
            osm: config.osm,
            userFile: config.userFile
        }));
        ipcMain.on('betterid:open-external', (event, url) => {
            if (/^https?:/.test(String(url))) shell.openExternal(String(url));
        });

        createWindow();

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) createWindow();
        });
    });

    app.on('window-all-closed', () => {
        app.quit();
    });
}
