# Planning and Progress

## Current Goal
Promote live-network validation from manual checks to repeatable automated E2E, then prepare CI-compatible hardening.

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
  - dedicated live runbook in `live_testing.md`
  - machine-readable local secrets file support (`test_credentials.json`, gitignored)
- Implemented outbound transport abstraction with observability hooks:
  - `HttpDeliveryTransport` for signed delivery HTTP calls
  - transport attempt/result callbacks for metrics/logging integration
- Implemented automated live E2E harness:
  - script: `npm run e2e:live`
  - quick tunnel startup/shutdown orchestration
  - two-phase bridge startup (discovery mode, then ingest mode)
  - GtS remote discovery + follow state polling
  - real Bluesky post publish + GtS home timeline assertion
  - robust handling for transient tunnel/bootstrap fetch failures
- Hardened live E2E reliability based on observed quirks:
  - persistent key manager wired for data-dir runs to keep signing keys stable across restarts
  - GtS search path standardized on `/api/v2/search` with full remote acct query
  - follow call request formatting fixed (no JSON content-type on empty POST body)
  - bridge post visibility defaulted to `unlisted` to avoid federated public feed noise
- Expanded AP surface and coverage:
  - actor followers and outbox collection endpoints
  - additional tests for audience mapping, invalid/control event handling, transport error body capture, file key persistence, and live harness helpers
- Implemented automatic actor materialization on WebFinger lookup:
  - unknown `acct:` handles are resolved against Bluesky handle resolver
  - actor records are created on successful DID resolution (no seed-only dependency)
- Improved reply/thread fidelity for self-thread chains:
  - self-replies now map `inReplyTo` to bridged object IDs
  - reply root now maps into ActivityPub `context` for better thread continuity
- Documented media test fixtures:
  - added `tests/data/README.md` describing available local image/video fixtures and usage guidance
- Added unit and integration-style tests for all implemented behavior.

## Verification Status
- Test commands:
  - `npm test`
  - `npm run e2e:local`
  - `npm run e2e:live`
- Result:
  - automated suite passing (26/26)
  - local E2E harness succeeds
  - live E2E harness succeeds end-to-end (`ok: true`) against real Bluesky + GtS with trycloudflare tunnel

## Next Milestone
CI-ready live E2E execution strategy:
- Gate live tests behind explicit opt-in environment flag and credential presence.
- Add structured JSON log/events output for easier CI diagnostics.
- Add automatic artifact retention (run dir, queue/state snapshots) on failure.

## TODO
- Automatic WebFinger onboarding:
  - Resolve unknown Bluesky handles to DID at discovery time.
  - Materialize/update actor profile in store on first lookup/follow.
- Reply/thread fidelity:
  - Expand thread context handling for non-self replies where bridged parent objects exist.
- Media mapping:
  - Map Bluesky embed/view media into ActivityPub attachments (`Image`/`Document`) with alt text.
  - Add deterministic unit tests using local fixtures in `tests/data/` (`example_image.jpg`, `example_video.mp4`).
- AP read-surface completeness:
  - Implement object dereference endpoint and non-empty outbox pagination backed by cached activities.
- Federation compatibility hardening:
  - Add RFC 9421 HTTP Message Signatures support alongside current cavage-style signatures.
- Production durability/ops:
  - Move from JSON files to SQLite/Postgres.
  - Add metrics and alertable delivery failure signals.

## Notes
- Durability is currently JSON-file-backed for zero-dependency local/dev reliability.
- For higher-scale production usage, move persistence from JSON files to SQLite/Postgres.
