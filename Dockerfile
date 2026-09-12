# Production image for BetteriD: the compiled same-origin proxy plus the built editor.
#
# Build context: the repository root, after `pnpm install --frozen-lockfile && pnpm run all`.
#   docker build -t betterid:latest .
#
# Run it with the credentials in an env file (see p/.env.example and
# docs/DEPLOYMENT.md):
#   docker run -d --name betterid --restart=always --network=host \
#     --env-file /opt/betterid/betterid.env \
#     -v /opt/betterid/cache:/app/cache \
#     -v /opt/betterid/photo-uploads:/app/photo-uploads \
#     betterid:latest

FROM rust:1.97-bookworm AS builder

ENV CARGO_BUILD_JOBS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY p/Cargo.toml p/Cargo.lock ./
COPY p/src ./src
COPY p/web ./web
RUN cargo build --release

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/osm ./osm
COPY dist ./dist
COPY index.html land.html ./

ENV OSM_LISTEN_ADDR=0.0.0.0:9178 \
    OSM_ID_DIST_DIR=/app/dist \
    OSM_CACHE_DIR=/app/cache \
    OSM_PHOTO_UPLOAD_DIR=/app/photo-uploads

EXPOSE 9178
CMD ["./osm"]
