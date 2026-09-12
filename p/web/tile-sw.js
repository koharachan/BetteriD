// BetteriD tile proxy Service Worker
// Intercepts external image requests from the iD editor and routes them through
// the tile proxy, so users do not need a VPN and the tiles are cached on our own
// edge.
//
// The proxy can live on a dedicated host (for example `wap.map.osm.asia`, set
// with `OSM_TILE_PROXY_BASE`) whose CDN caches by directory:
//
//   /long/   immutable tiles (OpenStreetMap raster, fixed z/x/y)   -> 30 days
//   /mid/    re-fetched imagery (aerial/satellite providers)       -> 7 days
//   /short/  anything that may change                              -> 8 hours
//
// The worker is registered as `/betterid/tile-sw.js?base=https%3A%2F%2Fwap.map.osm.asia`.
// Whenever that host cannot be reached (DNS not set up yet, edge down, gateway
// timeout) the request is retried against this origin, so tiles never break.

const PROXY_PATH = '/tile/proxy?url=';

const PARAMS = new URL(self.location.href).searchParams;
const BASE = (PARAMS.get('base') || '').replace(/\/+$/, '');

/** Immutable map tiles belong in /long/, everything else in /mid/. */
function isImmutableTile(target) {
  try {
    const url = new URL(target);
    const host = url.hostname.toLowerCase();
    return host === 'tile.openstreetmap.org' ||
      host.endsWith('.tile.openstreetmap.org') ||
      url.pathname.includes('/osm-intl/') ||
      /\/\d+\/\d+\/\d+\.(png|jpe?g|webp)$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function dedicatedUrl(target) {
  const immutable = isImmutableTile(target);
  if (immutable) {
    try {
      const url = new URL(target);
      return BASE + '/long' + url.pathname + url.search;
    } catch {
      /* fall through to the generic proxy path */
    }
  }
  return BASE + '/mid/proxy?url=' + encodeURIComponent(target);
}

function sameOriginFetch(target) {
  return fetch(PROXY_PATH + encodeURIComponent(target), { credentials: 'omit' });
}

function proxyTile(target) {
  if (!BASE) return sameOriginFetch(target);

  const url = dedicatedUrl(target);

  // 1) a CORS fetch so a 5xx can be detected and retried,
  // 2) an opaque fetch (works even when the CDN does not add CORS headers),
  // 3) finally this origin, so a missing DNS record or a dead edge never breaks
  //    the map.
  return fetch(url, { credentials: 'omit' })
    .then((response) => (response.status >= 500 ? sameOriginFetch(target) : response))
    .catch(() => fetch(url, { mode: 'no-cors', credentials: 'omit' }))
    .catch(() => sameOriginFetch(target))
    .catch(() => new Response('', { status: 502, statusText: 'Tile proxy unavailable' }));
}

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

  event.respondWith(proxyTile(event.request.url));
});
