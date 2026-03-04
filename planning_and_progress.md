# Planning and Progress

## Current Goal
Harden bridge trust and protocol behavior so inbox traffic can be validated and processing remains deterministic under realistic federation conditions.

## Completed
- Initialized a runnable Node.js project with zero external runtime dependencies.
- Implemented deterministic identity and URL mapping primitives:
  - acct URI parsing/validation
  - handle and DID validation
  - stable actor/object/followers/outbox URL builders
- Implemented in-memory persistence for:
  - bridged actors (DID + handle + profile fields)
  - follower relationships per actor DID
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
  - in-memory Jetstream cursor and dedup state
  - delivery target planner (shared inbox grouping + inbox fallback)
  - Jetstream commit processor for post create/update/delete
  - in-memory outbound delivery queue
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
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test command: `npm test`
- Result: all tests passing (15/15)

## Next Milestone
Add durability and execution-level E2E validation:
- Persist queue/state (SQLite-backed) for restart-safe operation.
- Add a local executable E2E harness that simulates Jetstream stream + remote ActivityPub server behavior.
- Add restart/recovery tests proving cursor continuity and queued delivery replay.

## Notes
- Current state is intentionally in-memory for fast iteration and deterministic tests.
- Before live federation trials, persistent storage is required.
