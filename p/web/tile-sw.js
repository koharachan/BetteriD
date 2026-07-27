// BetteriD tile proxy Service Worker
// Intercepts external image requests from iD editor and routes them
// through the local proxy so users don't need a VPN.

const PROXY_BASE = '/tile/proxy?url=';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  if (event.request.destination !== 'image') return;

  let url;
  try {
    url = new URL(event.request.url);
  } catch {
    return;
  }

  // Only proxy requests to external origins (not our own server)
  if (url.origin === self.location.origin) return;

  event.respondWith(
    fetch(PROXY_BASE + encodeURIComponent(event.request.url), {
      credentials: 'omit',
    }).catch(() => {
      return new Response('', { status: 502, statusText: 'Tile proxy unavailable' });
    })
  );
});
