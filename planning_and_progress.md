# Planning and Progress

## Current Goal
Build an end-to-end bridge pipeline skeleton: ingest Jetstream events, map to ActivityPub activities, and deliver outbound signed inbox requests with retry semantics.

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
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test command: `npm test`
- Result: all tests passing (9/9)

## Next Milestone
Connect abstractions into a runnable bridge loop and harden protocol behavior:
- Add a real Jetstream WebSocket client integration (subscription lifecycle + reconnect cursor rewind).
- Add follower actor fetch/discovery to capture inbox/sharedInbox from remote actor documents.
- Add richer ActivityPub compatibility behavior for `Undo Follow`, `Reject`, and stricter content negotiation.
- Add integration tests around ingestion-to-delivery flow with mocked Jetstream and mocked remote inboxes.

## Notes
- Current state is intentionally in-memory for fast iteration and deterministic tests.
- Persistent storage (SQLite/Postgres) is required before restart-safe reliability and production operation.
