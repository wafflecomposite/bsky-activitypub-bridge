# Preliminary Architecture Notes

These notes are retained as compact reference material. They are not the current task plan; keep live status and next work in `planning_and_progress.md`.

## Product Shape

The bridge is one-way: ActivityPub users follow virtual ActivityPub actors that represent Bluesky accounts. Bluesky remains read-only from the bridge's perspective.

Success criteria:
- WebFinger lookup for `acct:handle@bridge.example` returns a stable ActivityPub actor URL.
- A remote ActivityPub server can follow that actor and receive an `Accept`.
- New Bluesky posts, replies, media, reposts, updates, and deletes are mapped into ActivityPub activities and delivered to followers.
- The bridge stores only what federation needs: actors/profiles, signing keys, followers, delivery queue state, Jetstream cursor/dedup state, and a bounded object/outbox cache.

## Key Design Decisions

- Treat DID as canonical identity. Handles are aliases that can change.
- Use DID-based ActivityPub IDs:
  - actor: `/ap/actor/{did}`
  - followers: `/ap/actor/{did}/followers`
  - following: `/ap/actor/{did}/following`
  - featured: `/ap/actor/{did}/featured`
  - object: `/ap/object/{did}/{rkey}`
- Use Jetstream as the primary Bluesky ingest source, scoped by wanted DIDs and collections.
- Use public Bluesky AppView/repo HTTP APIs only for discovery, profile hydration, on-demand object materialization, and cases where Jetstream commit data is insufficient.
- Do not run unfiltered firehose ingest by default.
- Prefer remote media/CDN URLs in ActivityPub attachments; avoid proxying blobs unless a later compatibility issue requires it.
- Sign outbound ActivityPub delivery. Support both legacy cavage-style HTTP signatures and RFC9421-style message signatures where useful.
- Use shared inbox grouping for fanout when the remote actor exposes `endpoints.sharedInbox`.

## Minimal Federation Surface

Required/implemented surface:
- `GET /`
- `GET /api/resolve?q=...`
- `GET /.well-known/webfinger?resource=acct:...`
- `GET /ap/actor/{did}`
- `POST /ap/actor/{did}/inbox`
- `GET /ap/actor/{did}/followers`
- `GET /ap/actor/{did}/following`
- `GET /ap/actor/{did}/featured`
- `GET /ap/actor/{did}/outbox`
- `GET /ap/object/{did}/{rkey}`

Optional future surface:
- NodeInfo endpoints if federation tooling starts depending on them.
- Broader ActivityPub activity handling beyond follow/unfollow if the bridge becomes two-way.

## Mapping Rules

Actor:
- Bluesky profile maps to ActivityPub `Service` so Mastodon-compatible servers treat bridged profiles as bot accounts.
- Include profile fields where available: handle, display name, description, avatar, banner, original Bluesky web URL, bridge notice, followers/outbox/following/featured links, and public key.
- Generate and persist a signing key per DID.

Post:
- `app.bsky.feed.post` create maps to `Create` with `Note`.
- Note `url` points to the original Bluesky web post; the bridge AP object ID remains the note `id`.
- Text facets map to safe HTML and ActivityPub tags. Use UTF-8 byte ranges and drop overlapping facets.
- Replies map to `inReplyTo`; root/thread continuity maps to ActivityPub `context` where possible.
- Content labels/self-labels map to `sensitive: true` plus a reason-only content-warning `summary`; attached media also gets `sensitive: true`.
- Images/video/external links/quotes/record-with-media map to ActivityPub attachments or links.
- Deletes map to `Delete`; dereferencing a deleted cached object returns `Tombstone`.
- Reposts map to `Announce`; repost deletes map to `Delete`.

## Persistence Model

Current implementation uses JSON-backed local files for zero-dependency development and live testing. Production should move this state to SQLite or Postgres.

Persist:
- actor/profile records keyed by DID
- per-DID AP signing keys
- follower records with actor ID, inbox, shared inbox, and follow metadata
- cached object/activity records for object dereference and outbox
- delivery queue
- Jetstream cursor and dedup state

Do not persist:
- full media blobs by default
- large historical archives unless product requirements change

## Scale And Reliability Notes

- Jetstream has wanted DID limits; shard followed DIDs across multiple Jetstream connections when needed.
- Delivery should remain asynchronous with retry/backoff and permanent-failure handling for dead inboxes.
- Preserve per-destination ordering where possible.
- Keep ingest, storage, and delivery idempotent because reconnect rewind and retry are normal behavior.
- Live interoperability with GtS/Mastodon is the real acceptance bar; unit tests are necessary but not sufficient.

## Future Stack Direction

The current code is a zero-runtime-dependency Node.js implementation. If ActivityPub compatibility work becomes a drag, revisit using a dedicated ActivityPub framework such as Fedify. Do that only if it removes more complexity than it adds.
