# Live E2E Testing Runbook

This document covers real-world testing against live Bluesky and ActivityPub instances.

## Local Secrets File (Machine Readable)

Create `test_credentials.json` in repo root (it is gitignored):

```json
{
  "gts": {
    "instanceUrl": "https://your-gts.example",
    "accessToken": "YOUR_GTS_TOKEN"
  },
  "bluesky": {
    "identifier": "your-handle.bsky.social",
    "appPassword": "xxxx-xxxx-xxxx-xxxx"
  }
}
```

The live harness also accepts env overrides:
- `GTS_INSTANCE_URL`
- `GTS_ACCESS_TOKEN`
- `BLUESKY_IDENTIFIER`
- `BLUESKY_APP_PASSWORD`

## Required Tooling

- `./tools/bin/cloudflared` available locally.
- Node.js `>=22`.

## Automated Live E2E

Run:

```bash
npm run e2e:live
```

Optional env:
- `LIVE_E2E_CREDENTIALS_FILE` (default: `test_credentials.json`)
- `LIVE_E2E_CREDENTIALS_MD_FILE` (fallback default: `test_credentials.md`)
- `LIVE_E2E_CLEANUP=1` to remove temporary workdir after run

The harness:
1. Starts a quick Cloudflare tunnel.
2. Boots bridge in discovery mode (Jetstream off) and waits for actor readiness.
3. Discovers remote account from GtS search and follows it.
4. Restarts bridge in ingest mode (Jetstream on, wanted DID pinned).
5. Publishes a real Bluesky post and waits for it on GtS home timeline.

## Manual Bring-Up (Debug Path)

Terminal A:

```bash
./tools/bin/cloudflared tunnel --url http://127.0.0.1:3000 --no-autoupdate
```

Terminal B:

```bash
HOST=127.0.0.1 \
PORT=3000 \
BASE_URL='https://<random>.trycloudflare.com' \
DATA_DIR='./.data/live-e2e' \
STRICT_INBOX_SIGNATURES=1 \
ENABLE_JETSTREAM=1 \
JETSTREAM_AUTO_FOLLOWED_DIDS=1 \
JETSTREAM_WANTED_DIDS_REFRESH_MS=2000 \
BRIDGE_POST_VISIBILITY='unlisted' \
SEED_ACTORS='did:plc:ct7l6fgjtseazmaunhzrbydz=bridgetest7334.bsky.social' \
npm start
```

## Quirks and Reliability Notes

- `trycloudflare` URL changes every run. Any URL change requires restarting bridge with new `BASE_URL`.
- GtS discovery is slow/intermittent for fresh remote actors; allow several minutes and retry search.
- For GtS, account discovery is more reliable with:
  - `/api/v2/search?q=<full-acct>&resolve=true&limit=40&type=accounts&offset=0`
- Follow state can stay in `requested` for a while; poll `/api/v1/accounts/relationships`.
- Keep signing keys persistent across restarts (`DATA_DIR` + file-backed key manager) or stricter servers may reject signed deliveries.
- If Jetstream is disabled during the posting phase, no Bluesky posts are ingested or delivered.
- Bridge post visibility is intentionally `unlisted` (`to: followers`, `cc: Public`) to avoid polluting federated public feeds.
