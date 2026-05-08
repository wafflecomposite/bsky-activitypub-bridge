# Planning and Progress

Keep this file current and compact. Historical implementation detail belongs in git history, not here.

## Current Goal

Soft reboot the project around a stable baseline:
- keep ingest strictly scoped
- keep follow/discovery/import paths reliable against real ActivityPub servers
- keep AP read surfaces accurate enough for federation consumers
- preserve automated local and live tests as the source of truth

## Current Baseline

Runtime:
- Node.js 22+ app with zero external runtime dependencies.
- `createBridgeApplication()` wires server, runtime, store, key manager, Jetstream state, and delivery queue.
- Env-driven startup in `src/index.js`; main scripts are `npm start`, `npm test`, `npm run e2e:local`, `npm run e2e:live`, and `npm run e2e:live:ci`.

ActivityPub surface:
- WebFinger, actor, inbox, followers, following, featured, outbox, object, root resolver page, and `/api/resolve`.
- Follow inbox accepts and stores followers, resolves remote actor inboxes, queues signed `Accept` delivery, and can enforce inbound legacy HTTP signatures.
- Follow inbox also accepts `Undo` of `Follow` and removes followers so unfollow/refollow churn does not leave stale bridge subscription state.
- Actor documents use ActivityStreams `Service` type for bridged profiles so Mastodon-compatible servers mark them as bots; they also include bridge profile metadata, original Bluesky web URL, public key material, counters/collections, and featured collection link.
- Bluesky profile commits for followed actors update stored actor profile fields and fan out ActivityPub actor `Update` activities.
- Object/outbox endpoints serve cached or on-demand-materialized bridged posts; deleted objects return `Tombstone`.
- Bridged posts default to unlisted ActivityPub addressing, with followers in `to` and public audience in `cc`, to avoid public timeline flooding.
- Browser/HTML requests to bridged actor and object URLs redirect to the corresponding Bluesky profile/post, while ActivityPub/JSON/default fetches still receive AP JSON.
- Resolver landing page examples use the official `bsky.app` profile and post URLs.

Bluesky side:
- DID is canonical; handles are aliases.
- Unknown handles can be resolved/materialized on WebFinger or resolver lookup.
- Jetstream ingest supports scoped wanted DIDs/collections, profile update fanout, cursor/dedup state, reconnect rewind, and client-side DID filtering.
- Unfiltered Jetstream is blocked by default unless `UNSAFE_ALLOW_UNFILTERED_JETSTREAM` is set.
- Post mapper covers text facets, links, mentions, hashtags, replies/thread context, original Bluesky web URLs, unlisted AP audiences, Bluesky content labels/CWs with sensitive media flags, media/external embeds, FEP-044f quote posts with compatibility fields and quote authorization stamps, reposts, updates, and deletes.

Delivery and durability:
- Delivery planner groups by shared inbox with inbox fallback.
- File-backed queue/store/state/key manager support restart recovery and debounced async persistence with explicit flush on shutdown.
- Delivery worker records metrics, retries transient failures with capped exponential backoff, and treats permanent failures separately.
- Outbound transport supports legacy HTTP signatures and optional RFC9421-style message signature headers.

Testing:
- Unit/integration coverage spans identifiers, AP generation, follow handling, signatures, resolver parsing, post mapping, stores, queues, Jetstream, runtime wiring, server dispatch, and recovery.
- Local E2E covers ingest, retry/delivery, and cursor continuity.
- Live E2E uses real Bluesky + GtS + Mastodon through a Cloudflare tunnel and covers discovery, follow, resolver actor/post targets, unfollowed post import, profile update delivery, threaded delivery, unlisted visibility, quote posts, media, labeled media CW/sensitivity, reposts, AP read surfaces, and runtime metrics.

## Verification

Routine local verification:
- `npm test`
- `npm run e2e:local`

Last local verification on 2026-05-08:
- `npm test` passed, 30/30 tests.
- `npm run e2e:local` returned `ok: true` with `queuedUnlisted: true`, `unfollowedIngestStatus: "no-followers"`, and `queueSizeAfterUnfollowedIngest: 0`.

Live verification:
- `npm run e2e:live`
- `RUN_LIVE_E2E=1 npm run e2e:live:ci`

Last live verification on 2026-05-08:
- `npm run e2e:live` returned `ok: true` against real Bluesky + GtS + Mastodon through `https://discharge-notes-modern-patio.trycloudflare.com`.
- Confirmed served actor `type: "Service"`, remote account API `bot: true` on both receivers, original Bluesky profile/post URLs exposed where receivers support them while AP URI fetch/import still works, follow/unfollow/refollow state transitions update bridge followers as expected on both receivers, thread/media posts arrive as `unlisted`, Mastodon accepts quote posts, profile description changes fan out as AP actor `Update`, and labeled media maps to reason-only CW plus sensitive media state.

Do not mark live federation work complete unless the live harness passes or the failure is intentionally documented with artifacts.

## Active Risks

- A previous manual run captured thousands of unrelated DIDs in persistent storage, which indicates unscoped ingest happened at least once. Guardrails now exist, but this needs regression coverage that proves persistent storage does not grow from unrelated DIDs when no wanted DIDs are configured.
- GtS/Mastodon follow state can remain `requested` during real-world runs. The live harness waits for `following=true`; any recurrence should be investigated from request logs and artifacts rather than assumed transient.
- On 2026-05-08, live GtS had `add9575.bsky.social@bskytest1.sdu.li` stuck at `requested:true` while the bridge followers collection for `did:plc:7zhmr4wh5ombv6hxzfumbfmp` was empty. A controlled GtS API unfollow/follow retry then reached `following:true` and populated the bridge follower immediately, so the observed state was a stale pending GtS follow rather than a persistent bridge rejection.
- JSON files are adequate for local/dev and live harness runs, but not the intended production durability layer.
- Inbound RFC9421 verification is not implemented; current strict inbound mode is legacy signature verification.

## Next Work

P0:
- Add regression coverage for the unscoped-ingest storage incident.
- Add an explicit startup/runtime signal when Jetstream is enabled but idle because there are no wanted DIDs.
- Re-run live E2E after the docs cleanup and record the result here.

P1:
- Validate follow/discovery behavior against Mastodon in addition to GtS.
- Add inbound RFC9421 message-signature verification.
- Expand resolver parsing for more fediverse profile/status URL shapes.

P2:
- Replace JSON persistence with SQLite or Postgres.
- Add operational alerting for sustained delivery failures and backlog growth.
- Revisit Fedify or another AP framework only if compatibility maintenance becomes larger than the local implementation.

## Notes

- Keep `live_testing.md` as the runbook for credentials, commands, and live quirks.
- Keep `preliminary_planning.md` as compact architecture reference, not an active TODO list.
