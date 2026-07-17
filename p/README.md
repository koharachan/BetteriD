# BetteriD Rust Proxy

The Rust service is the production entry point for `map.osm.asia`. It serves the
locally built BetteriD editor, proxies the required OpenStreetMap and tile
requests, and exposes same-origin translation, AI, and moderated-photo APIs.

Provider credentials remain on the server. The frontend receives capability
flags from `/api/osm-ai/status`, never API keys.

## Prerequisites

- A current stable Rust toolchain
- A completed editor build in `../dist`
- An OpenStreetMap OAuth 2 application for login and upload workflows

Build the editor from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm run all
```

Then start the proxy:

```bash
cd p
cp .env.example .env
cargo run
```

The default editor URL is <http://127.0.0.1:9178/id/>. Requests to `/edit`,
`/editor`, `/id`, and `/iD` are redirected to the local editor.

## Configuration

Configuration is loaded in this order:

1. Process environment variables
2. `p/.env`
3. The repository-root `.env`
4. Built-in defaults

Blank optional values are treated as unconfigured. Start from
[`.env.example`](.env.example); never commit the populated `.env` file.

### Core service

| Variable | Default | Purpose |
| --- | --- | --- |
| `OSM_LISTEN_ADDR` | `127.0.0.1:9178` | HTTP listen address |
| `OSM_UPSTREAM_URL` | `https://www.openstreetmap.org` | OSM website/API upstream |
| `OSM_TILE_UPSTREAM_URL` | `https://tile.openstreetmap.org` | Public tile upstream |
| `OSM_ID_DIST_DIR` | `../dist` | Built BetteriD asset directory |
| `OSM_CACHE_DIR` | `./cache` | Persistent cache directory |
| `OSM_CACHE_MAX_SIZE` | `10000` | Maximum cached entries |
| `OSM_CACHE_DEFAULT_TTL` | `1800` | Default cache lifetime in seconds |
| `OSM_OAUTH_CLIENT_ID` | Built-in public client ID | OAuth 2 public client identifier |
| `OSM_OAUTH_REDIRECT_URI` | Derived from request host | Exact deployed OAuth callback |
| `OSM_TRUSTED_PROXY_IPS` | Empty | Comma-separated exact reverse-proxy IPs |
| `OSM_PHOTO_UPLOAD_DIR` | `./photo-uploads` | Persistent approved-photo directory |

For local development, register this exact OAuth redirect URI:

```text
http://127.0.0.1:9178/id/land.html
```

OAuth uses PKCE. Do not place an OAuth client secret in the editor, repository,
or any browser response. A deployment may use either `/id/land.html` or
`/callback`, but `OSM_OAUTH_REDIRECT_URI` must exactly match the URI registered
with OpenStreetMap.

### AI and translation providers

| Task | Providers in accepted order | Relevant variables |
| --- | --- | --- |
| Text and translation | DeepSeek, OpenAI, MiMo | `DEEPSEEK_*`, `OPENAI_*`, `MIMO_*` |
| Web-backed tag search | OpenAI, Kimi | `OPENAI_SEARCH_MODEL`, `KIMI_*` |
| Photo moderation and analysis | OpenAI, MiMo | `OPENAI_MODERATION_MODEL`, `OPENAI_VISION_MODEL`, `MIMO_VISION_MODEL` |
| Bing translation fallback | Bing Translator | `BING_TRANSLATE_API_KEY`, `BING_TRANSLATE_REGION` |

Request `provider_order` values are bounded, deduplicated, and filtered by task.
Unknown providers are ignored. Configured providers and multiple MiMo keys are
tried silently in order, including fallback after quota, payment, or transient
upstream errors. Kimi is used only through its `$web_search` tool.

`OPENAI_RESOLVE_IP` is an optional DNS override for deployments that require a
fixed upstream IP. The URL hostname and TLS SNI are preserved.

## Same-origin API

| Method and path | Purpose |
| --- | --- |
| `GET /api/osm-ai/status` | Return available task capabilities and provider names |
| `POST /api/osm-ai/translate` | Generate selected language variants |
| `POST /api/osm-ai/summarize` | Generate a concise changeset comment |
| `POST /api/osm-ai/tag-suggestions` | Research OSM tag suggestions and sources |
| `POST /api/osm-ai/photo-upload` | Validate, moderate, and persist a photo |
| `POST /api/osm-ai/photo-analyze` | Analyze a previously approved photo |
| `GET /api/osm-ai/photos/{id}.jpg` | Serve an approved immutable JPEG |

The legacy aliases `/api/osm-ai/photos/upload` and
`/api/osm-ai/photos/analyze` are also accepted.

## Photo safety model

`photo-upload` accepts JSON containing a base64 string or data URL in `image`.
The proxy:

1. Enforces request, decoded-byte, allocation, pixel, and dimension limits.
2. Accepts only JPEG, PNG, or WebP input.
3. Applies image orientation and re-encodes to JPEG, removing embedded metadata.
4. Runs server-side moderation before writing the file.
5. Returns an immutable same-origin public URL only for approved content.

`photo-analyze` accepts only a photo ID or URL previously issued by this service.
Configure `OSM_PHOTO_UPLOAD_DIR` on persistent storage and define an operational
retention policy for public uploads.

## Reverse proxies and rate limits

AI endpoints are rate-limited by client IP. Forwarded client headers are ignored
unless the immediate peer and every forwarded hop are listed in
`OSM_TRUSTED_PROXY_IPS`. Add only exact IP addresses for proxies that sanitize or
append `Forwarded`/`X-Forwarded-For` correctly; do not add broad client ranges.

Keep TLS termination, upload body limits, and request timeouts aligned with the
application limits. Do not cache authenticated OSM API responses or AI POST
responses at the reverse proxy.

## Verification

```bash
cargo fmt --check
cargo test
cargo clippy --all-targets --all-features
```

On Windows with Visual Studio, `run-vs.cmd` loads the Visual Studio 18 x64 MSVC
developer environment before invoking Cargo:

```cmd
run-vs.cmd
run-vs.cmd test
```
