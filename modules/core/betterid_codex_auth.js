/**
 * Sign in to Codex (ChatGPT) from Preferences → AI.
 *
 * The browser or device round-trip is performed by the local MCP admin
 * server, which can receive the localhost OAuth redirect. The resulting
 * tokens stay in this browser's preferences.
 */

import { prefs } from './preferences';

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_PREFS = Object.freeze({
  access: 'betterid.ai.custom.codex_access',
  refresh: 'betterid.ai.custom.codex_refresh',
  expires: 'betterid.ai.custom.codex_expires',
  account: 'betterid.ai.custom.codex_account'
});


function trimmed(key) {
  const value = prefs(key);
  return typeof value === 'string' ? value.trim() : '';
}


export function mcpAdminUrl() {
  const configured = globalThis.BETTERID_MCP_ADMIN_URL;
  if (configured) return String(configured).replace(/\/$/, '');
  const page = globalThis.location;
  if (page && /^https?:$/.test(page.protocol)) {
    return `${page.origin}/mcp`;
  }
  return 'http://127.0.0.1:9179';
}


export function codexAccessToken() {
  return trimmed(CODEX_PREFS.access);
}


export function codexAccountId() {
  return trimmed(CODEX_PREFS.account);
}


export function setCodexSession(session) {
  const write = (key, value) => prefs(key, value ? String(value) : null);
  write(CODEX_PREFS.access, session && session.accessToken);
  write(CODEX_PREFS.refresh, session && session.refreshToken);
  write(CODEX_PREFS.expires, session && session.expiresAt);
  write(CODEX_PREFS.account, session && (session.accountId || accountIdFromToken(session.accessToken)));
}


export function clearCodexSession() {
  setCodexSession(null);
}


/** chatgpt_account_id from a Codex access token, when the JWT carries one. */
export function accountIdFromToken(token) {
  if (!token || token.split('.').length < 2) return '';
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    const auth = payload['https://api.openai.com/auth'] || {};
    return auth.chatgpt_account_id || payload.chatgpt_account_id || '';
  } catch {
    return '';
  }
}


function normalizeToken(data) {
  const accessToken = data.access_token || data.accessToken;
  if (!accessToken) throw new Error('Codex login did not return an access token');
  const expiresIn = Number(data.expires_in || data.expiresIn || 0);
  return {
    accessToken,
    refreshToken: data.refresh_token || data.refreshToken || '',
    expiresAt: data.expiresAt || (expiresIn ? Date.now() + expiresIn * 1000 : 0),
    accountId: data.accountId || accountIdFromToken(accessToken)
  };
}


export async function refreshCodexToken(refreshToken) {
  const base = mcpAdminUrl();
  try {
    const response = await fetch(`${base}/api/codex/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken })
    });
    if (response.ok) return normalizeToken(await response.json());
  } catch { /* the admin server is optional; try the token endpoint directly */ }

  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID
    })
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail.slice(0, 180) || 'Codex token refresh failed');
  }
  return normalizeToken(await response.json());
}


/** Use the stored token, refreshing it when it is close to expiry. */
export async function ensureCodexAccess() {
  const access = codexAccessToken();
  const expires = Number(prefs(CODEX_PREFS.expires) || 0);
  if (access && (!expires || expires > Date.now() + 60000)) return access;
  const refresh = trimmed(CODEX_PREFS.refresh);
  if (!refresh) return access;
  const next = await refreshCodexToken(refresh);
  setCodexSession(next);
  return next.accessToken;
}


function delay(ms) {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}


function openAuthorize(url) {
  const popup = window.open(url, '_blank', 'noopener');
  const desktop = globalThis.BETTERID_DESKTOP;
  if (!popup && desktop && typeof desktop.openExternal === 'function') desktop.openExternal(url);
}


/**
 * Browser (PKCE via the local admin server) or device-code login.
 * Resolves with the stored session once Codex returns a token.
 */
export async function startCodexLogin(options) {
  const mode = options && options.mode || 'browser';
  const base = mcpAdminUrl();
  let response;
  try {
    response = await fetch(`${base}/api/codex/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode })
    });
  } catch {
    throw new Error('The MCP admin page is not running, so Codex sign-in cannot open a browser login.');
  }
  const started = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(started.error || 'Codex login could not start');
  if (started.authorizeUrl) openAuthorize(started.authorizeUrl);
  if (started.userCode && options && options.onCode) options.onCode(started);

  const interval = Math.max(1, Number(started.interval) || 1.5) * 1000;
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(interval);
    const poll = await fetch(`${base}/api/codex/poll?id=${encodeURIComponent(started.loginId)}`);
    const body = await poll.json().catch(() => ({}));
    if (body.status === 'complete') {
      const session = normalizeToken(body);
      setCodexSession(session);
      return session;
    }
    if (body.status === 'error') throw new Error(body.error || 'Codex login failed');
  }
  throw new Error('Codex login timed out');
}
