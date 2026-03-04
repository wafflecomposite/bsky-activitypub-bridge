#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLOUDFLARED_PATH="${CLOUDFLARED_PATH:-${ROOT_DIR}/tools/bin/cloudflared}"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3000}"
# Keep disabled by default for compatibility with instances that do not sign every inbox request.
STRICT_INBOX_SIGNATURES="${STRICT_INBOX_SIGNATURES:-0}"
ENABLE_JETSTREAM="${ENABLE_JETSTREAM:-1}"
JETSTREAM_AUTO_FOLLOWED_DIDS="${JETSTREAM_AUTO_FOLLOWED_DIDS:-1}"
JETSTREAM_WANTED_DIDS_REFRESH_MS="${JETSTREAM_WANTED_DIDS_REFRESH_MS:-2000}"
BRIDGE_POST_VISIBILITY="${BRIDGE_POST_VISIBILITY:-unlisted}"
UNSAFE_ALLOW_UNFILTERED_JETSTREAM="${UNSAFE_ALLOW_UNFILTERED_JETSTREAM:-0}"

# Keep DATA_DIR optional. Empty means in-memory mode.
DATA_DIR="${DATA_DIR:-}"

# Optional auto-seed from test credentials.
SEED_ACTORS="${SEED_ACTORS:-}"
if [[ -z "${SEED_ACTORS}" && -f "${ROOT_DIR}/test_credentials.json" ]] && command -v jq >/dev/null 2>&1; then
  CANDIDATE_HANDLE="$(jq -r '.bluesky.identifier // .blueskyIdentifier // empty' "${ROOT_DIR}/test_credentials.json" 2>/dev/null || true)"
  if [[ -n "${CANDIDATE_HANDLE}" ]]; then
    # Default DID used throughout the existing live harness.
    SEED_ACTORS="did:plc:ct7l6fgjtseazmaunhzrbydz=${CANDIDATE_HANDLE}"
  fi
fi

if [[ ! -x "${CLOUDFLARED_PATH}" ]]; then
  echo "cloudflared binary not found or not executable at: ${CLOUDFLARED_PATH}" >&2
  exit 1
fi

TUNNEL_LOG="$(mktemp -t bridge-cloudflared-XXXXXX.log)"
TUNNEL_PID=""

cleanup() {
  if [[ -n "${TUNNEL_PID}" ]] && kill -0 "${TUNNEL_PID}" >/dev/null 2>&1; then
    kill -INT "${TUNNEL_PID}" >/dev/null 2>&1 || true
    wait "${TUNNEL_PID}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

echo "Starting quick tunnel..."
"${CLOUDFLARED_PATH}" tunnel --url "http://${HOST}:${PORT}" --no-autoupdate >"${TUNNEL_LOG}" 2>&1 &
TUNNEL_PID="$!"

BASE_URL=""
for _ in $(seq 1 90); do
  if ! kill -0 "${TUNNEL_PID}" >/dev/null 2>&1; then
    echo "cloudflared exited unexpectedly." >&2
    sed -n '1,200p' "${TUNNEL_LOG}" >&2
    exit 1
  fi

  BASE_URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "${TUNNEL_LOG}" | head -n 1 || true)"
  if [[ -n "${BASE_URL}" ]]; then
    break
  fi
  sleep 0.5
done

if [[ -z "${BASE_URL}" ]]; then
  echo "Failed to obtain trycloudflare URL." >&2
  sed -n '1,200p' "${TUNNEL_LOG}" >&2
  exit 1
fi

echo "Tunnel URL: ${BASE_URL}"
if [[ -n "${SEED_ACTORS}" ]]; then
  echo "Seed actors: ${SEED_ACTORS}"
fi
echo "Starting bridge..."

cd "${ROOT_DIR}"

env \
  HOST="${HOST}" \
  PORT="${PORT}" \
  BASE_URL="${BASE_URL}" \
  STRICT_INBOX_SIGNATURES="${STRICT_INBOX_SIGNATURES}" \
  ENABLE_JETSTREAM="${ENABLE_JETSTREAM}" \
  JETSTREAM_AUTO_FOLLOWED_DIDS="${JETSTREAM_AUTO_FOLLOWED_DIDS}" \
  JETSTREAM_WANTED_DIDS_REFRESH_MS="${JETSTREAM_WANTED_DIDS_REFRESH_MS}" \
  BRIDGE_POST_VISIBILITY="${BRIDGE_POST_VISIBILITY}" \
  UNSAFE_ALLOW_UNFILTERED_JETSTREAM="${UNSAFE_ALLOW_UNFILTERED_JETSTREAM}" \
  DATA_DIR="${DATA_DIR}" \
  SEED_ACTORS="${SEED_ACTORS}" \
  npm start
