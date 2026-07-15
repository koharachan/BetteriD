# map.osm.asia Rust Proxy

This service proxies OpenStreetMap, serves the locally built BetteriD editor,
and exposes same-origin translation and AI summary endpoints.

## Build the editor

From the parent repository:

```powershell
pnpm all
```

The Rust service serves `../index.html` at `/id/` and assets from `../dist` at
`/id/dist/`. Requests to `/edit`, `/editor`, `/id`, and `/iD` use the local
editor by default.

## Configuration

The service reads process environment variables first, then `.env` and
`../.env`. See `.env.example`. For the default local address, register this exact
redirect URI with the OSM OAuth application:

`http://127.0.0.1:9178/id/land.html`

Set `OSM_OAUTH_CLIENT_ID` to the public client ID. OAuth uses PKCE, so the client
secret must not be placed in the editor, this repository, or any browser response.

Blank optional values are treated as unconfigured. BetteriD checks
`/api/osm-ai/status` once and disables translation or AI summary controls when
the corresponding service is not configured.

## Run with Visual Studio

```cmd
run-vs.cmd
```

The script loads the Visual Studio 18 x64 MSVC developer environment before
running Cargo. The default address is `http://127.0.0.1:9178/id/`.
