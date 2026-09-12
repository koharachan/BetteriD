#!/bin/bash
# Warm the CDN edge caches with the assets the editor needs to boot, so the first
# visitor after a deploy or an eviction gets a cache hit instead of a cold pull.
#
# Why "edges" and not just the domain: the provider's GeoDNS answers differently
# per resolver, so pulling `https://<domain>/...` only warms the edge *our* resolver
# maps to - which can be a different continent from our users (measured: the origin
# host's resolver sent us to a Brazilian edge that served 32KB in 36s). This script
# asks public resolvers (incl. AliDNS / DNSPod, i.e. what Chinese users get) for
# their edge, then warms each of those IPs directly with `--resolve`.
#
# Usage:  warm-cache.sh [host]              (default map.osm.asia)
# Env:    DIST_DIR=/opt/betterid/build/dist
#         EDGES="203.160.55.7 24.233.15.183"   override the discovered edge IPs
#         FULL=1                              also warm every file in dist (~50MB)
#         PARA=6                              parallel requests per edge
#
# Install: install -m 755 scripts/warm-cache.sh /opt/betterid/warm-cache.sh
# Log:     /var/log/betterid-warm.log   (one line per edge: status code histogram)
#
# A completely cold edge is slow (that is the problem being solved) while a warm one
# takes seconds, so the timer fires often and `flock` turns overlaps into no-ops.
set -u

HOST="${1:-map.osm.asia}"
DIST="${DIST_DIR:-/opt/betterid/build/dist}"
UA="BetteriD cache warmer (+https://$HOST)"
LOG=/var/log/betterid-warm.log
LOCK=/run/betterid-warm.lock
PARA="${PARA:-6}"
RESOLVERS="223.5.5.5 119.29.29.29 8.8.8.8 1.1.1.1"

exec 9>"$LOCK" || exit 1
if ! flock -n 9; then
  echo "$(date '+%F %T') already running, skipping" >> "$LOG"
  exit 0
fi

[ -d "$DIST" ] || { echo "dist dir $DIST not found" >&2; exit 1; }

# The build stamps every asset URL with `?v=<build>`, which is also part of the
# cache key, so warming the wrong value would warm nothing useful: read it from
# the live editor, and fall back to the deployed index.html if that fetch fails.
VERSION=""
for _ in 1 2 3; do
  VERSION=$(curl -sf --max-time 30 -A "$UA" "https://$HOST/id/" \
              | grep -oE 'dist/iD\.min\.js\?v=[0-9]+' | head -1 | sed 's/.*v=//')
  [ -n "$VERSION" ] && break
  sleep 2
done
if [ -z "$VERSION" ]; then
  IDX="${INDEX_HTML:-$(dirname "$DIST")/index.html}"
  [ -f "$IDX" ] && VERSION=$(grep -oE 'iD\.min\.js\?v=[0-9]+' "$IDX" | head -1 | sed 's/.*v=//')
fi

BASE="https://$HOST"
PRIORITY=$(mktemp)
ALL=""
trap 'rm -f "$PRIORITY" $ALL' EXIT

# --- the resources a visitor needs before the map renders --------------------
{
  echo "$BASE/id/"
  echo "$BASE/id/land.html"
  [ -n "${VERSION:-}" ] && echo "$BASE/id/dist/iD.min.js?v=$VERSION"
  [ -n "${VERSION:-}" ] && echo "$BASE/id/dist/iD.css?v=$VERSION"
  [ -n "${VERSION:-}" ] && echo "$BASE/id/dist/locales/en.min.json?v=$VERSION"
  [ -n "${VERSION:-}" ] && echo "$BASE/id/dist/locales/zh.min.json?v=$VERSION"
  for f in data/phone_formats.min.json data/shortcuts.min.json \
           nsi/dist/json/nsi.min.json nsi/dist/wikidata/wikidata.min.json \
           nsi/dist/json/replacements.min.json \
           tagging-schema/dist/presets.min.json tagging-schema/dist/fields.min.json \
           tagging-schema/dist/defaults.min.json tagging-schema/dist/deprecated.min.json; do
    [ -f "$DIST/$f" ] || continue
    case "$f" in
      nsi/*|tagging-schema/*) echo "$BASE/id/dist/$f" ;;
      *) [ -n "${VERSION:-}" ] && echo "$BASE/id/dist/$f?v=$VERSION" ;;
    esac
  done
} > "$PRIORITY"

# --- optionally warm every shipped file (large: ~50MB per edge) --------------
if [ "${FULL:-0}" = 1 ]; then
  ALL=$(mktemp)
  while IFS= read -r file; do
    rel="${file#"$DIST"/}"
    case "$rel" in *.map) continue ;; esac
    if [ -n "${VERSION:-}" ]; then
      echo "$BASE/id/dist/$rel?v=$VERSION"
    else
      echo "$BASE/id/dist/$rel"
    fi
  done < <(find "$DIST" -type f | sort) > "$ALL"
fi

# --- which edges to warm -----------------------------------------------------
EDGE_IPS=""
if [ -n "${EDGES:-}" ]; then
  EDGE_IPS="$EDGES"
else
  for r in $RESOLVERS; do
    ip=$(dig +short +time=4 +tries=1 A "$HOST" @"$r" 2>/dev/null | grep -E '^[0-9]+\.' | tail -1)
    [ -n "$ip" ] && EDGE_IPS="$EDGE_IPS $ip"
  done
  EDGE_IPS=$(echo "$EDGE_IPS" | tr ' ' '\n' | grep -E '^[0-9]+\.' | sort -u | tr '\n' ' ')
fi
# Resolver answers rotate, and the Chinese-facing edge is the one that matters most,
# so always offer it (and anything in SEED_EDGES) as a candidate; the probe below
# drops it again if it is unreachable.
EDGE_IPS=$(printf '%s\n%s\n' "$(echo ${EDGE_IPS:-} | tr ' ' '\n')" \
             "$(echo "${SEED_EDGES:-203.160.55.7}" | tr ' ' '\n')" \
           | grep -E '^[0-9]+\.' | sort -u | tr '\n' ' ')
[ -n "${EDGE_IPS// /}" ] || EDGE_IPS=$(getent ahostsv4 "$HOST" | awk '{print $1}' | sort -u | head -1)

TOTAL=$(wc -l < "$PRIORITY")
echo "$(date '+%F %T') warming $HOST (v=${VERSION:-unknown}, priority=$TOTAL, edges:${EDGE_IPS:-none}, full=${FULL:-0})" >> "$LOG"

# --- keep the fast edges, drop the far ones ----------------------------------
# A cold edge that our resolver happens to pick can be an order of magnitude
# slower than the edge our users get (measured 193s vs 2s for the same 14 URLs),
# so probe `/id/` on every candidate and only warm the responsive ones.
WARMN="${WARMN:-3}"
MAXRTT="${MAXRTT:-5}"
PROBED=""
for ip in $EDGE_IPS; do
  T=$(curl -s -o /dev/null --max-time 20 -A "$UA" --resolve "$HOST:443:$ip" \
        -w '%{time_starttransfer}' "https://$HOST/id/" 2>/dev/null)
  case "$T" in ''|*[!0-9.]*) T=999 ;; esac
  PROBED="$PROBED$T $ip
"
done
SORTED=$(printf '%s' "$PROBED" | sort -n)
SEL=$(echo "$SORTED" | awk -v max="$MAXRTT" '$1 <= max {print $2}' \
        | head -n "$WARMN" | tr '\n' ' ')
# every edge is far away (or unreachable): still warm the least-bad one
[ -n "${SEL// /}" ] || SEL=$(echo "$SORTED" | head -1 | awk '{print $2}')
echo "$(date '+%F %T') probes: $(echo "$SORTED" | tr '\n' ' ')| warming ${SEL:-none}" >> "$LOG"

for ip in $SEL; do
  START=$(date +%s)
  CODES=$(xargs -a "$PRIORITY" -P "$PARA" -n 1 \
            curl -s -o /dev/null --max-time 180 -A "$UA" -H 'Accept-Encoding: br, gzip' \
                 --resolve "$HOST:443:$ip" -w '%{http_code}\n' \
          | sort | uniq -c | tr '\n' ' ')
  MSG="priority $ip -> $CODES"
  if [ -n "$ALL" ]; then
    CODES=$(xargs -a "$ALL" -P "$PARA" -n 1 \
              curl -s -o /dev/null --max-time 180 -A "$UA" -H 'Accept-Encoding: br, gzip' \
                   --resolve "$HOST:443:$ip" -w '%{http_code}\n' \
            | sort | uniq -c | tr '\n' ' ')
    MSG="$MSG | full $CODES"
  fi
  echo "$(date '+%F %T') $MSG ($(( $(date +%s) - START ))s)" >> "$LOG"
done
tail -1 "$LOG"
