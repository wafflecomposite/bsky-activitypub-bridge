# Planning and Progress

## Current Goal
Build a bridge MVP that can expose followable ActivityPub actors and deterministically map Bluesky posts into federatable ActivityPub activities.

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
- Added unit and integration-style dispatch tests for all implemented behavior.

## Verification Status
- Test command: `npm test`
- Result: all tests passing (5/5)

## Next Milestone
Implement ingestion and fanout plumbing:
- Add Jetstream event consumer abstraction and cursor state management.
- Wire mapped `Create` activities into a delivery planner over current follower state.
- Implement recipient grouping by `sharedInbox` with per-inbox fallback.
- Add tests for event deduplication, cursor advancement, and recipient grouping.

## Notes
- Current state is intentionally in-memory for fast iteration and deterministic tests.
- Persistent storage (SQLite/Postgres) is required before reliability and restart-safe operation work.
