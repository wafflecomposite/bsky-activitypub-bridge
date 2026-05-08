# Live E2E Runbook

This project treats live federation as the acceptance test for production-like behavior.

## Credentials

Create `test_credentials.json` in the repo root. It is gitignored.

```json
{
  "gts": {
    "instanceUrl": "https://your-gts.example",
    "accessToken": "YOUR_GTS_TOKEN"
  },
  "bluesky": {
    "identifier": "your-handle.bsky.social",
    "appPassword": "xxxx-xxxx-xxxx-xxxx",
    "unfollowedPostUrl": "https://bsky.app/profile/did:plc:.../post/..."
  }
}
```

Environment overrides:
- `GTS_INSTANCE_URL`
- `GTS_ACCESS_TOKEN`
- `BLUESKY_IDENTIFIER`
- `BLUESKY_APP_PASSWORD`
- `BLUESKY_UNFOLLOWED_POST_URL`

## Requirements

- Node.js `>=22`
- `./tools/bin/cloudflared`
- usable Bluesky credentials with app password
- usable GtS account token

## Commands

Normal live run:

```bash
npm run e2e:live
```

CI-style gated run:

```bash
RUN_LIVE_E2E=1 npm run e2e:live:ci
```

Useful options:
- `LIVE_E2E_CREDENTIALS_FILE` default `test_credentials.json`
- `LIVE_E2E_CREDENTIALS_MD_FILE` fallback default `test_credentials.md`
- `LIVE_E2E_MEDIA_FIXTURE` default `tests/data/example_image.jpg`
- `LIVE_E2E_ENABLE_HTTP_MESSAGE_SIGNATURES=1`
- `LIVE_E2E_CLEANUP=1`
- `LIVE_E2E_ARTIFACTS_BASE_DIR` default `.data/live-e2e-artifacts`
- `LIVE_E2E_RUN_ID`

## What The Harness Checks

The automated harness:
- starts a temporary Cloudflare tunnel
- starts the bridge in discovery mode, then ingest mode
- verifies actor/profile metadata, remote account `bot` visibility, and featured collection availability
- verifies resolver output for actor, followed post, and unfollowed post URLs
- verifies AP fetch paths still work for remote import despite browser-facing redirects
- imports an unfollowed bridge object through GtS and Mastodon status search
- discovers and follows the bridged account from GtS and Mastodon
- verifies follow/unfollow/refollow lifecycle from GtS and Mastodon, including receiver relationship state and bridge followers collection updates
- temporarily updates the Bluesky profile description and verifies both receivers get the ActivityPub actor `Update`, then restores the original profile
- publishes a real Bluesky thread and verifies delivery/linkage plus `unlisted` visibility in both receivers
- verifies bridge outbox/object endpoints for the thread, including unlisted ActivityPub addressing
- publishes a quote post and verifies bridge FEP-044f quote fields, fallback link, quote authorization, and receiver quote references
- publishes a media post and verifies receiver `unlisted` visibility plus AP attachment output
- publishes a labeled media post and verifies receiver plus AP CW/sensitive-media output with `unlisted` visibility
- publishes a repost and verifies ActivityPub `Announce`
- waits for delivery queue drain and checks runtime delivery metrics

## Manual Debug Bring-Up

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

## Known Quirks

- `trycloudflare` URL changes every run; restart the bridge with the new `BASE_URL`.
- GtS discovery for fresh actors can take minutes. Use `/api/v2/search?q=<full-acct>&resolve=true&limit=40&type=accounts&offset=0`.
- Follow state may sit at `requested`; poll `/api/v1/accounts/relationships` and inspect bridge inbox/delivery logs.
- Bridge follow diagnostics are disabled by default. Set `BRIDGE_DEBUG_LOGS=follow` to emit `[bridge-follow] {...}` JSON lines, or `BRIDGE_DEBUG_LOGS=all` for all debug categories as they are added.
- Keep `DATA_DIR` stable during a run so actor signing keys survive restarts.
- Existing remote account cache entries may keep an old actor type. If a bridged profile was discovered before the bridge emitted ActivityStreams `Service`, force a remote refresh or use a fresh bridge domain before judging the bot flag.
- If Jetstream is off during the posting phase, Bluesky posts will not deliver.
- Live automation uses and verifies `BRIDGE_POST_VISIBILITY=unlisted` to avoid public-feed noise while still delivering to followers.
- Optional Mastodon live credentials can be supplied with `MASTODON_INSTANCE_URL` and `MASTODON_ACCESS_TOKEN`, or a `mastodon` object in `test_credentials.json`.
