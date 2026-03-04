# Planning and Progress

## Current Goal
Move the bridge from isolated pipeline pieces to realistic network lifecycle behavior: Jetstream subscription management, remote actor discovery for follows, and signed outbound accept delivery.

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
- Implemented remote actor discovery for follow requests:
  - resolves follower inbox/sharedInbox via signed GET when follow payload only contains actor ID
  - queues outbound `Accept` delivery after follow acceptance
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test command: `npm test`
- Result: all tests passing (13/13)

## Next Milestone
Add durable and protocol-hardening pieces before live federation trials:
- Persist state and queue (SQLite first) for restart-safe operation.
- Implement remote actor fetch caching and invalidation strategy.
- Add inbound signature verification for ActivityPub inbox requests.
- Add end-to-end integration test harness with mocked Jetstream stream and remote ActivityPub server behavior (including retry/permanent-failure paths).

## Notes
- Current state is intentionally in-memory for fast iteration and deterministic tests.
- Real deployment requires persistent storage and inbox request signature verification.
