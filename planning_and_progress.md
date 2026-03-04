# Planning and Progress

## Current Goal
Finalize real-network readiness controls around startup wiring, Jetstream DID refresh, delivery observability hooks, and strict inbox signature policy.

## Completed
- Initialized a runnable Node.js project with zero external runtime dependencies.
- Implemented deterministic identity and URL mapping primitives:
  - acct URI parsing/validation
  - handle and DID validation
  - stable actor/object/followers/outbox URL builders
- Implemented ActivityPub-facing primitives:
  - actor document generation (`Person` + public key material)
  - WebFinger JRD generation
  - inbox `Follow` handling with idempotent follower storage
  - `Accept` activity generation
- Implemented HTTP endpoint dispatch for MVP surface:
  - `GET /.well-known/webfinger`
  - `GET /ap/actor/{did}`
  - `POST /ap/actor/{did}/inbox`
- Implemented Bluesky post mapping core:
  - `app.bsky.feed.post` -> ActivityPub `Note` + `Create`
  - UTF-8 byte-range facet rendering (mentions, links, hashtags)
  - overlap-safe facet handling
  - reply linkage conversion (`at://` parent -> web fallback URL)
  - self-label to content warning mapping (`sensitive` + `summary`)
- Implemented ingestion/fanout pipeline primitives:
  - delivery target planner (shared inbox grouping + inbox fallback)
  - Jetstream commit processor for post create/update/delete
  - outbound delivery queue interface
- Implemented outbound delivery mechanics:
  - HTTP `Digest` generation
  - draft-cavage-style HTTP Signature header generation for POST inbox delivery
  - signed GET header generation for remote actor discovery
  - delivery worker with success, permanent-failure, retry scheduling, and capped exponential backoff
- Implemented runtime orchestration and Jetstream lifecycle:
  - runtime ingest/queue/delivery drain loop
  - Jetstream start/stop/update hooks
  - configurable Jetstream URL/reconnect/rewind
  - auto-refresh of `wantedDids` from provider on interval
- Implemented follow-path network hardening:
  - signed GET actor fetch when follow payload only contains actor ID
  - TTL-based remote actor cache with invalidation and expiry
  - cache-aware follow endpoint resolution in inbox path
  - queued outbound `Accept` delivery after follow acceptance
- Implemented optional inbound inbox signature verification:
  - digest validation
  - date skew checks
  - public key lookup from remote actor document via `keyId`
  - RSA signature verification over signed header list
  - server-side 401 rejection on verification failure
- Implemented file-backed durability components:
  - file-backed bridge store (actors + followers)
  - file-backed Jetstream cursor/dedup state
  - file-backed outbound delivery queue
  - restart recovery integration proving queued delivery replay and cursor continuity
- Implemented local executable E2E harness:
  - reusable harness module for simulated ingest/retry/delivery flow
  - runnable script `npm run e2e:local`
  - harness test asserting retry-then-deliver semantics and cursor continuity
- Implemented startup/application wiring for deployment controls:
  - `createBridgeApplication()` composition layer
  - env-driven runtime/server configuration in `src/index.js`
  - strict inbox signature mode toggle (`STRICT_INBOX_SIGNATURES`)
  - data directory persistence toggle (`DATA_DIR`)
- Prepared real-world tunnel test tooling:
  - local `cloudflared` binary bootstrap for `trycloudflare`
  - local credential/tunnel workflow instructions updated in `test_credentials.md`
- Implemented outbound transport abstraction with observability hooks:
  - `HttpDeliveryTransport` for signed delivery HTTP calls
  - transport attempt/result callbacks for metrics/logging integration
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test commands:
  - `npm test`
  - `npm run e2e:local`
- Result: all tests passing (24/24) and local E2E harness succeeds.

## Next Milestone
Real-world E2E with live services:
- Run a credentialed staging flow against real Jetstream and a real remote ActivityPub account/server.
- Validate follow discovery, signed inbox delivery, and post propagation end-to-end with real network responses.
- Capture reproducible test steps and expected outputs for repeated live checks.

## Notes
- Durability is currently JSON-file-backed for zero-dependency local/dev reliability.
- For higher-scale production usage, move persistence from JSON files to SQLite/Postgres.
