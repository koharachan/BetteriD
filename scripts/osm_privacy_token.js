#!/usr/bin/env node
/*
 * Obtain an OpenStreetMap OAuth2 token for the server-side "privacy"
 * (anonymous) upload account used by POST /api/osm-ai/privacy/upload.
 *
 * The script never stores credentials: it prints the authorize URL, waits for
 * the callback URL that your browser lands on, exchanges the code with the
 * matching PKCE verifier, and prints environment lines for the proxy `.env`.
 *
 * Usage:
 *   node scripts/osm_privacy_token.js --client-id <id> --redirect-uri <uri>
 *   node scripts/osm_privacy_token.js ... --callback 'https://.../callback?code=...'
 *
 * Sign in as the account that should own the anonymous edits when the browser
 * asks. Keep the printed tokens out of git (they belong in the server env file).
 */

import { createHash, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { env } from 'node:process';

const AUTHORIZE_URL = 'https://www.openstreetmap.org/oauth2/authorize';
const TOKEN_URL = 'https://www.openstreetmap.org/oauth2/token';
const SCOPE = 'write_api read_prefs';

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function base64url(buffer) {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/[=]+$/, '');
}

function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

const clientId = arg('client-id') || env.OSM_PRIVACY_CLIENT_ID;
const redirectUri = arg('redirect-uri') || env.OSM_PRIVACY_REDIRECT_URI;
const tokenUrl = arg('token-url') || env.OSM_PRIVACY_TOKEN_URL || TOKEN_URL;

if (!clientId || !redirectUri) {
  console.error('Usage: node scripts/osm_privacy_token.js --client-id <id> --redirect-uri <uri> [--callback <url>]');
  process.exit(2);
}

const verifier = base64url(randomBytes(64));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = base64url(randomBytes(12));

const authorize = new URL(AUTHORIZE_URL);
authorize.searchParams.set('client_id', clientId);
authorize.searchParams.set('redirect_uri', redirectUri);
authorize.searchParams.set('response_type', 'code');
authorize.searchParams.set('scope', SCOPE);
authorize.searchParams.set('state', state);
authorize.searchParams.set('code_challenge', challenge);
authorize.searchParams.set('code_challenge_method', 'S256');

console.log('\n1) Open this URL and sign in as the privacy account:\n');
console.log(authorize.toString());
console.log('\n2) After you approve, the browser lands on the callback URL.');
console.log('   Copy that whole URL (it contains ?code=...).\n');

let callback = arg('callback');
if (!callback) {
  callback = await ask('Callback URL: ');
}

let code;
let returnedState;
try {
  const parsed = new URL(callback);
  code = parsed.searchParams.get('code') || undefined;
  returnedState = parsed.searchParams.get('state') || undefined;
} catch {
  code = callback;   // allow pasting the bare code
}

if (!code) {
  console.error('No `code` found in the callback URL.');
  process.exit(1);
}
if (returnedState && returnedState !== state) {
  console.error('State mismatch: the callback URL does not belong to this request.');
  process.exit(1);
}

const body = new URLSearchParams({
  grant_type: 'authorization_code',
  code,
  redirect_uri: redirectUri,
  client_id: clientId,
  code_verifier: verifier
});

const response = await fetch(tokenUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body
});
const text = await response.text();

if (!response.ok) {
  console.error(`Token exchange failed (${response.status}): ${text.slice(0, 300)}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(text);
} catch {
  console.error(`Token endpoint did not return JSON: ${text.slice(0, 300)}`);
  process.exit(1);
}

console.log('\nToken issued. Add these lines to the proxy `.env` (chmod 600) and restart it:\n');
console.log(`OSM_PRIVACY_CLIENT_ID=${clientId}`);
console.log(`OSM_PRIVACY_ACCESS_TOKEN=${payload.access_token}`);
if (payload.refresh_token) {
  console.log(`OSM_PRIVACY_REFRESH_TOKEN=${payload.refresh_token}`);
} else {
  console.log('# no refresh_token returned: the access token expires, re-run this script when it does');
}
console.log(`OSM_PRIVACY_TOKEN_URL=${tokenUrl}`);
console.log('OSM_PRIVACY_API_URL=https://api.openstreetmap.org');
if (payload.expires_in) console.log(`# expires_in: ${payload.expires_in}s`);
if (payload.scope) console.log(`# scope: ${payload.scope}`);
console.log('\nShell tip: read the lines with `env $(grep ...)` or paste them into the env file with `chmod 600`.');
