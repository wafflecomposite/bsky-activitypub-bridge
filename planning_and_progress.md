# Planning and Progress

## Current Goal
Provide an executable end-to-end local validation loop for bridge behavior (ingest -> queue -> retry -> delivery) with durable state.

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
- Implemented runtime orchestration layer:
  - single runtime that wires ingestion processor + queue + delivery worker
  - delivery drain loop
  - Jetstream client start/stop/update hooks
- Implemented Jetstream WebSocket lifecycle client:
  - subscription URL builder with wanted collection/DID filters
  - cursor rewind on reconnect/start
  - options update messages for dynamic DID updates
  - auto-reconnect scheduling on disconnect
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
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test commands:
  - `npm test`
  - `npm run e2e:local`
- Result: all tests passing (20/20) and local E2E harness succeeds.

## Next Milestone
Bridge-to-real-network readiness:
- Add real Jetstream WebSocket adapter execution path in runtime startup (configurable endpoint + DID filter refresh loop).
- Add HTTP transport abstraction for outbound inbox deliveries with structured metrics/logging hooks.
- Add configurable strict server mode that always enforces inbox signature verification in production.

## Notes
- Durability is currently JSON-file-backed for zero-dependency local/dev reliability.
- For higher-scale production usage, move persistence from JSON files to SQLite/Postgres.
