/**
 * Local web UI for MCP server configuration.
 *
 * Bind it to 127.0.0.1. It stores server definitions and can probe an HTTP
 * or SSE URL. It does not spawn stdio commands: those are launched by the
 * MCP client that imports the copied config.
 *
 * Codex sign-in also lives here, because the OAuth redirect has to land on
 * a localhost port the Codex client is allowed to use.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const TRANSPORTS = new Set(['stdio', 'sse', 'http']);

export const EDITOR_MCP_TEMPLATE = Object.freeze({
  name: 'BetteriD web editor',
  transport: 'stdio',
  command: 'node',
  args: ['mcp/dist/index.js'],
  env: { OSM_WEB_URL: 'http://127.0.0.1:8080' },
  enabled: true
});


function randomId() {
  return crypto.randomBytes(8).toString('hex');
}


function asObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  Object.entries(value).forEach(([key, item]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) return;
    out[key] = String(item).slice(0, 2000);
  });
  return out;
}


/** A stored MCP server, or a throw if the name is missing. */
export function normalizeServer(input) {
  const source = input || {};
  const name = String(source.name || '').trim().slice(0, 80);
  if (!name) throw new Error('A name is required');
  const transport = TRANSPORTS.has(source.transport) ? source.transport : 'stdio';
  let args = [];
  if (Array.isArray(source.args)) args = source.args.map(item => String(item).slice(0, 500)).slice(0, 20);
  else if (typeof source.args === 'string') args = source.args.split(/\s+/).filter(Boolean).slice(0, 20);
  const id = /^[a-zA-Z0-9_-]{4,40}$/.test(String(source.id || '')) ? String(source.id) : randomId();
  return {
    id,
    name,
    enabled: source.enabled !== false,
    transport,
    command: String(source.command || '').trim().slice(0, 300),
    args,
    url: String(source.url || '').trim().slice(0, 500),
    env: asObject(source.env),
    headers: asObject(source.headers)
  };
}


export function mutateStore(store, action) {
  const servers = (store.servers || []).slice();
  if (action.type === 'add') {
    const server = normalizeServer(action.server);
    servers.push(server);
    return { store: { servers }, server };
  }
  if (action.type === 'update') {
    const index = servers.findIndex(server => server.id === action.id);
    if (index < 0) throw new Error('Server not found');
    const server = normalizeServer(Object.assign({}, servers[index], action.server, { id: action.id }));
    servers[index] = server;
    return { store: { servers }, server };
  }
  if (action.type === 'remove') {
    return { store: { servers: servers.filter(server => server.id !== action.id) } };
  }
  throw new Error('Unknown action');
}


function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    request.on('data', chunk => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error('Request body is too large'));
        request.destroy();
        return;
      }
      body += chunk.toString();
    });
    request.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Request body must be valid JSON'));
      }
    });
    request.on('error', reject);
  });
}


function sendJson(response, status, data) {
  const body = JSON.stringify(data);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store'
  });
  response.end(body);
}


function pageHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>BetteriD MCP</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { margin: 0 auto; max-width: 760px; padding: 24px 16px 48px; line-height: 1.45; }
    h1 { font-size: 1.3rem; margin-bottom: 0.2rem; }
    p.lead, .note { color: #555; }
    form, .card { border: 1px solid #ccc; border-radius: 8px; padding: 12px; margin: 12px 0; }
    label { display: grid; gap: 4px; margin: 8px 0; font-size: 0.92rem; }
    input, select, textarea { font: inherit; padding: 6px 8px; }
    textarea { min-height: 72px; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    button { font: inherit; padding: 6px 12px; cursor: pointer; }
    .danger { color: #9b1c1c; }
    pre { overflow: auto; background: #f4f4f4; padding: 8px; border-radius: 6px; }
    @media (prefers-color-scheme: dark) {
      p.lead, .note { color: #bbb; }
      form, .card { border-color: #444; }
      pre { background: #1e1e1e; }
    }
  </style>
</head>
<body>
  <h1>BetteriD MCP</h1>
  <p class="lead">Add, edit, or remove MCP servers while BetteriD is running. Stdio servers are saved for your MCP client; this page does not launch them. HTTP and SSE servers can be probed.</p>
  <div class="row">
    <button type="button" id="add-template">Add BetteriD editor template</button>
    <button type="button" id="copy-config">Copy client config</button>
  </div>
  <div id="list"></div>
  <form id="editor">
    <h2>Server</h2>
    <input type="hidden" name="id">
    <label>Name <input name="name" required maxlength="80"></label>
    <label>Transport
      <select name="transport">
        <option value="stdio">stdio</option>
        <option value="http">http</option>
        <option value="sse">sse</option>
      </select>
    </label>
    <label>Command <input name="command" placeholder="node"></label>
    <label>Arguments <input name="args" placeholder="mcp/dist/index.js"></label>
    <label>URL <input name="url" placeholder="http://127.0.0.1:3000/mcp"></label>
    <label>Environment <textarea name="env" placeholder="OSM_WEB_URL=http://127.0.0.1:8080"></textarea></label>
    <label>Headers <textarea name="headers" placeholder="Authorization=Bearer …"></textarea></label>
    <label class="row"><input type="checkbox" name="enabled" checked> Enabled</label>
    <div class="row">
      <button type="submit">Save</button>
      <button type="button" id="reset">Clear</button>
    </div>
    <p id="message" class="note"></p>
  </form>
  <h2>Client config</h2>
  <pre id="snippet">{}</pre>
  <script>
    const root = location.pathname.replace(/\\/$/, '');
    const api = (root === '' ? '' : root) + '/api/servers';
    const list = document.querySelector('#list');
    const form = document.querySelector('#editor');
    const message = document.querySelector('#message');
    const snippet = document.querySelector('#snippet');

    function lines(value) {
      const out = {};
      String(value || '').split(/\\n/).forEach(line => {
        const index = line.indexOf('=');
        if (index < 1) return;
        out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
      });
      return out;
    }
    function dump(object) {
      return Object.entries(object || {}).map(([key, value]) => key + '=' + value).join('\\n');
    }
    function clientConfig(servers) {
      const mcpServers = {};
      servers.filter(server => server.enabled).forEach(server => {
        mcpServers[server.name] = server.transport === 'stdio'
          ? { command: server.command, args: server.args, env: server.env }
          : { url: server.url, headers: server.headers };
      });
      return { mcpServers };
    }
    function say(text) { message.textContent = text || ''; }

    async function reload() {
      const response = await fetch(api);
      const data = await response.json();
      list.replaceChildren();
      (data.servers || []).forEach(server => {
        const card = document.createElement('article');
        card.className = 'card';
        const title = document.createElement('strong');
        title.textContent = server.name + (server.enabled ? '' : ' (disabled)');
        const meta = document.createElement('div');
        meta.className = 'note';
        meta.textContent = server.transport === 'stdio'
          ? server.transport + ' ' + server.command + ' ' + (server.args || []).join(' ')
          : server.transport + ' ' + server.url;
        const row = document.createElement('div');
        row.className = 'row';
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => fill(server));
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'danger';
        remove.textContent = 'Remove';
        remove.addEventListener('click', async () => {
          await fetch(api + '/' + server.id, { method: 'DELETE' });
          reload();
        });
        const check = document.createElement('button');
        check.type = 'button';
        check.textContent = 'Check';
        check.addEventListener('click', async () => {
          const result = await fetch(api + '/' + server.id + '/check', { method: 'POST' });
          const body = await result.json();
          say(body.detail || ('HTTP ' + body.status));
        });
        row.append(edit, check, remove);
        card.append(title, meta, row);
        list.append(card);
      });
      snippet.textContent = JSON.stringify(clientConfig(data.servers || []), null, 2);
    }

    function fill(server) {
      form.elements.id.value = server.id || '';
      form.elements.name.value = server.name || '';
      form.elements.transport.value = server.transport || 'stdio';
      form.elements.command.value = server.command || '';
      form.elements.args.value = (server.args || []).join(' ');
      form.elements.url.value = server.url || '';
      form.elements.env.value = dump(server.env);
      form.elements.headers.value = dump(server.headers);
      form.elements.enabled.checked = server.enabled !== false;
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      const payload = {
        id: form.elements.id.value || undefined,
        name: form.elements.name.value,
        transport: form.elements.transport.value,
        command: form.elements.command.value,
        args: form.elements.args.value,
        url: form.elements.url.value,
        env: lines(form.elements.env.value),
        headers: lines(form.elements.headers.value),
        enabled: form.elements.enabled.checked
      };
      const id = form.elements.id.value;
      const response = await fetch(id ? api + '/' + id : api, {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const body = await response.json();
      if (!response.ok) { say(body.error || 'Could not save'); return; }
      form.reset();
      form.elements.enabled.checked = true;
      say('Saved');
      reload();
    });
    document.querySelector('#reset').addEventListener('click', () => { form.reset(); form.elements.id.value = ''; form.elements.enabled.checked = true; });
    document.querySelector('#add-template').addEventListener('click', async () => {
      await fetch(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(${JSON.stringify(EDITOR_MCP_TEMPLATE)})
      });
      reload();
    });
    document.querySelector('#copy-config').addEventListener('click', async () => {
      await navigator.clipboard.writeText(snippet.textContent);
      say('Copied');
    });
    reload().catch(error => { say(error.message); });
  </script>
</body>
</html>`;
}


function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}


function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}


export function createMcpAdmin(options) {
  const prefix = options.prefix || '';
  const storePath = options.storePath;
  const logins = new Map();
  const callbackServers = new Set();
  let httpServer = null;
  let publicUrl = options.publicUrl || '';

  function readStore() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath, 'utf8'));
      const servers = Array.isArray(parsed.servers) ? parsed.servers : [];
      return {
        servers: servers.map(server => {
          try { return normalizeServer(server); } catch { return null; }
        }).filter(Boolean)
      };
    } catch (error) {
      if (error && error.code !== 'ENOENT') return { servers: [] };
      return { servers: [] };
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    const file = `${storePath}.tmp`;
    fs.writeFileSync(file, JSON.stringify(store, null, 2));
    fs.renameSync(file, storePath);
  }

  function routeOf(pathname) {
    if (!prefix) return pathname || '/';
    if (pathname === prefix || pathname === `${prefix}/`) return '/';
    if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length) || '/';
    return null;
  }

  async function checkServer(server) {
    if (server.transport === 'stdio') {
      return { ok: false, detail: 'stdio servers are stored here and started by your MCP client' };
    }
    let target;
    try { target = new URL(server.url); } catch { return { ok: false, detail: 'URL is not valid' }; }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return { ok: false, detail: 'Only http and https URLs can be checked' };
    }
    try {
      const response = await fetch(target, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(4000) });
      return { ok: response.status < 500, status: response.status, detail: `HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  }

  function finishLogin(login, error, tokens) {
    if (error) {
      login.status = 'error';
      login.error = error.message || String(error);
      return;
    }
    login.status = 'complete';
    login.tokens = {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token || '',
      expiresAt: tokens.expires_in ? Date.now() + Number(tokens.expires_in) * 1000 : 0
    };
    login.verifier = '';
  }

  async function exchangeCode(login, code) {
    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CODEX_CLIENT_ID,
        code,
        redirect_uri: login.redirectUri,
        code_verifier: login.verifier
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error_description || data.error || `Token exchange failed (${response.status})`);
    }
    finishLogin(login, null, data);
  }

  function openCallback(login) {
    return new Promise((resolve, reject) => {
      const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname !== '/auth/callback') {
          response.writeHead(404);
          response.end('Not found');
          return;
        }
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><meta charset="utf-8"><title>BetteriD</title><p>Codex sign-in returned to BetteriD. You can close this tab.</p>');
        const code = url.searchParams.get('code');
        const oauthError = url.searchParams.get('error');
        server.close();
        callbackServers.delete(server);
        if (oauthError || !code) finishLogin(login, new Error(oauthError || 'Codex did not return a code'));
        else exchangeCode(login, code).catch(error => finishLogin(login, error));
      });
      server.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        callbackServers.add(server);
        login.redirectUri = `http://localhost:${port}/auth/callback`;
        resolve(login.redirectUri);
      });
      server.on('error', reject);
    });
  }

  async function startBrowserLogin() {
    const { verifier, challenge } = pkcePair();
    const loginId = randomId();
    const login = { mode: 'browser', status: 'pending', verifier, redirectUri: '' };
    logins.set(loginId, login);
    await openCallback(login);
    const url = new URL('https://auth.openai.com/oauth/authorize');
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', CODEX_CLIENT_ID);
    url.searchParams.set('redirect_uri', login.redirectUri);
    url.searchParams.set('scope', 'openid profile email offline_access');
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', loginId);
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');
    url.searchParams.set('originator', 'betterid');
    return { loginId, mode: 'browser', authorizeUrl: url.toString() };
  }

  async function startDeviceLogin() {
    const response = await fetch('https://auth.openai.com/api/accounts/deviceauth/usercode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.user_code) {
      throw new Error(data.error || data.message || `Device login is not available (${response.status})`);
    }
    const loginId = randomId();
    const login = {
      mode: 'device',
      status: 'pending',
      deviceAuthId: data.device_auth_id,
      userCode: data.user_code,
      interval: Number(data.interval) || 5
    };
    logins.set(loginId, login);
    pollDevice(login);
    return {
      loginId,
      mode: 'device',
      userCode: data.user_code,
      verificationUrl: 'https://auth.openai.com/codex/device',
      interval: login.interval
    };
  }

  async function pollDevice(login) {
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && login.status === 'pending') {
      await delay(login.interval * 1000);
      if (login.status !== 'pending') return;
      try {
        const response = await fetch('https://auth.openai.com/api/accounts/deviceauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_auth_id: login.deviceAuthId, user_code: login.userCode })
        });
        if (!response.ok) continue;
        const data = await response.json();
        if (data.access_token) finishLogin(login, null, data);
      } catch (error) {
        finishLogin(login, error);
        return;
      }
    }
    if (login.status === 'pending') finishLogin(login, new Error('Codex device login timed out'));
  }

  async function refreshToken(refreshToken) {
    const response = await fetch('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID
      })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error_description || data.error || 'Codex token refresh failed');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || refreshToken,
      expiresAt: data.expires_in ? Date.now() + Number(data.expires_in) * 1000 : 0
    };
  }

  async function handleApi(request, response, route, url) {
    if (request.method === 'GET' && route === '/api/servers') {
      sendJson(response, 200, readStore());
      return;
    }
    if (request.method === 'POST' && route === '/api/servers') {
      try {
        const result = mutateStore(readStore(), { type: 'add', server: await readBody(request) });
        writeStore(result.store);
        sendJson(response, 200, result.server);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }
    const one = route.match(/^\/api\/servers\/([a-zA-Z0-9_-]{4,40})(\/check)?$/);
    if (one && request.method === 'PUT' && !one[2]) {
      try {
        const result = mutateStore(readStore(), { type: 'update', id: one[1], server: await readBody(request) });
        writeStore(result.store);
        sendJson(response, 200, result.server);
      } catch (error) {
        sendJson(response, 400, { error: error.message });
      }
      return;
    }
    if (one && request.method === 'DELETE' && !one[2]) {
      const result = mutateStore(readStore(), { type: 'remove', id: one[1] });
      writeStore(result.store);
      sendJson(response, 200, { ok: true });
      return;
    }
    if (one && request.method === 'POST' && one[2]) {
      const server = readStore().servers.find(item => item.id === one[1]);
      if (!server) {
        sendJson(response, 404, { error: 'Server not found' });
        return;
      }
      sendJson(response, 200, await checkServer(server));
      return;
    }
    if (request.method === 'POST' && route === '/api/codex/start') {
      try {
        const body = await readBody(request);
        const started = body.mode === 'device' ? await startDeviceLogin() : await startBrowserLogin();
        sendJson(response, 200, started);
      } catch (error) {
        sendJson(response, 502, { error: error.message });
      }
      return;
    }
    if (request.method === 'GET' && route === '/api/codex/poll') {
      const login = logins.get(url.searchParams.get('id'));
      if (!login) {
        sendJson(response, 404, { status: 'error', error: 'Login not found' });
        return;
      }
      if (login.status === 'complete') sendJson(response, 200, Object.assign({ status: 'complete' }, login.tokens));
      else if (login.status === 'error') sendJson(response, 200, { status: 'error', error: login.error });
      else sendJson(response, 200, { status: 'pending' });
      return;
    }
    if (request.method === 'POST' && route === '/api/codex/refresh') {
      try {
        const body = await readBody(request);
        sendJson(response, 200, await refreshToken(String(body.refreshToken || '')));
      } catch (error) {
        sendJson(response, 502, { error: error.message });
      }
      return;
    }
    sendJson(response, 404, { error: 'Not found' });
  }

  function handle(request, response) {
    const url = new URL(request.url, 'http://127.0.0.1');
    const route = routeOf(url.pathname);
    if (route === null) return false;
    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      response.end();
      return true;
    }
    if (request.method === 'GET' && (route === '/' || route === '')) {
      const html = pageHtml();
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store'
      });
      response.end(html);
      return true;
    }
    handleApi(request, response, route, url).catch(error => {
      if (!response.headersSent) sendJson(response, 500, { error: error.message });
    });
    return true;
  }

  function listen(server, host, port) {
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off('error', onError);
        reject(error);
      };
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve(server.address());
      });
    });
  }

  async function start(listenOptions = {}) {
    const host = listenOptions.host || '127.0.0.1';
    const first = listenOptions.port === undefined ? 9179 : listenOptions.port;
    const attempts = first === 0 ? 1 : 6;
    let port = first;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const server = http.createServer((request, response) => {
        if (!handle(request, response)) {
          response.writeHead(404);
          response.end('Not found');
        }
      });
      try {
        const address = await listen(server, host, port);
        httpServer = server;
        publicUrl = `http://${host}:${address.port}`;
        return { url: publicUrl, port: address.port };
      } catch (error) {
        server.close();
        if (error.code !== 'EADDRINUSE' || first === 0) throw error;
        port += 1;
      }
    }
    throw new Error('No free port for the MCP admin page');
  }

  function stop() {
    callbackServers.forEach(server => server.close());
    callbackServers.clear();
    if (httpServer) {
      httpServer.close();
      httpServer = null;
    }
  }

  return { handle, start, stop, get url() { return publicUrl; } };
}
