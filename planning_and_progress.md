# Planning and Progress

## Current Goal
Move from static bridge primitives to an ingestion-to-fanout pipeline that can transform Jetstream post events into queued ActivityPub deliveries.

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
  - in-memory outbound delivery queue abstraction
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test command: `npm test`
- Result: all tests passing (7/7)

## Next Milestone
Wire the queue into actual ActivityPub HTTP delivery mechanics:
- Implement outbound request builder for inbox delivery payloads.
- Add HTTP Signature and Digest generation for signed POST delivery.
- Implement delivery worker with retry/backoff and permanent-failure handling.
- Add tests for signature headers, grouping-driven single-delivery semantics, and retry behavior.

## Notes
- Current state is intentionally in-memory for fast iteration and deterministic tests.
- Persistent storage (SQLite/Postgres) is required before restart-safe reliability.
