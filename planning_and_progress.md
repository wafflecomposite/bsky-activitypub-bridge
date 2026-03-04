# Planning and Progress

## Current Goal
Build a runnable bridge pipeline that can ingest Jetstream events and produce signed ActivityPub deliveries end-to-end.

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
  - delivery worker with success, permanent-failure, retry scheduling, and capped exponential backoff
- Implemented runtime orchestration layer:
  - single runtime that wires ingestion processor + queue + delivery worker
  - drain loop for queued deliveries
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test command: `npm test`
- Result: all tests passing (10/10)

## Next Milestone
Integrate real protocol endpoints and network flows:
- Add real Jetstream WebSocket subscription lifecycle with reconnect cursor rewind.
- Add remote follower actor discovery fetch (resolve inbox/sharedInbox from actor object).
- Add outbound signed `Accept` delivery from inbox follow handling.
- Add integration tests with mocked WebSocket Jetstream stream and mocked remote inbox actors.

## Notes
- Current state is intentionally in-memory for fast iteration and deterministic tests.
- Persistent storage (SQLite/Postgres) is required before restart-safe reliability and production operation.
