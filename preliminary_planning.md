# One-way Bluesky-to-ActivityPub Bridge: Architecture and Engineering Plan

## Scope and success criteria

This project is a one-way bridge where ActivityPub users can follow Bluesky accounts and receive their posts, while the Bluesky side remains read-only (no outbound “follow” or interactions unless you later choose to add them). The bridge behaves like a proxy that *materializes* “virtual ActivityPub actors” representing Bluesky accounts and then federates their posts outward to followers.

Success looks like:

- An ActivityPub user can enter an address like `alice.bsky.social@bridge.example`, have their server discover it via WebFinger, and successfully follow it.
- After follow acceptance, new Bluesky posts appear in the follower’s home timeline via normal federation delivery (POST to inbox / sharedInbox).
- The bridge hosts only minimal state: follower relationships, cryptographic keys, and enough cached post/profile data to serve ActivityPub GETs (actor/outbox/object) and to be resilient to restarts.
- Operationally: low bandwidth to Bluesky by using the streaming event layer + cached public appview endpoints; scalable fan-out using shared inbox delivery and queued deliveries with retry/backoff. 

Because ActivityPub federation is effectively server-to-server messaging over signed HTTP requests and discovered inbox endpoints, your bridge must implement the *server-to-server surface area* (inbox handling and outbound delivery), even if it does **not** implement a full multi-user instance UI.

## Upstream ingestion from Bluesky

### Which upstream interfaces to depend on

Use two complementary upstream sources:

- **Streaming updates (primary): Jetstream**  
  Jetstream is a simplified JSON event stream built by consuming the AT Protocol firehose (`com.atproto.sync.subscribeRepos`) and translating the underlying CBOR/MST data into “lightweight, friendly JSON.” It is explicitly designed for cases where you want real-time updates but don’t need full sync protocol semantics.
  Jetstream supports server-side filtering by collection (`wantedCollections`) and by repo DID (`wantedDids`), with published limits (notably, up to 10,000 DIDs per connection), and it supports updating these filters after connection via an `options_update` message.

- **On-demand hydration and backfill (secondary): public AppView HTTP APIs**  
  Many `app.bsky.*` endpoints are public and can be called directly against the Bluesky AppView; the documentation explicitly asks developers to prefer `https://public.api.bsky.app` because it includes additional caching and is intended for public web use cases.

This pairing lets you minimize upstream calls (stream first; API calls for profile refresh, initial outbox fill, and “view” hydration for embeds).

### Why Jetstream over polling

Polling per-followed account with `app.bsky.feed.getAuthorFeed` is possible (it’s public and returns an actor’s author feed).
However, polling scales poorly with many followed accounts. Jetstream is designed to reduce bandwidth and complexity: it provides JSON encoding, optional compression, and built-in filtering so you are not forced to ingest the entire firehose if you only need posts from opted-in DIDs.

### Identity and handle resolution strategy

Internally, treat **DID as canonical** and **handle as alias**:

- Bluesky accounts are addressed by `did:plc:…` (or other DID methods) at the protocol level, and handles can change. Jetstream emits `identity` events specifically to tell downstream consumers that identity information may have changed and caches should be refreshed.
- The Bluesky docs show using `com.atproto.identity.resolveHandle` to resolve a handle into a DID when parsing mentions or otherwise needing resolution.

For your bridge, this implies:

- WebFinger queries come in as “acct addresses” (e.g., `acct:alice.bsky.social@bridge.example`). Your bridge resolves `alice.bsky.social` → DID (cached), creates/loads the virtual actor for that DID, and returns the actor URL.
- Jetstream `identity` events keep your DID↔handle mapping fresh without hammering resolve endpoints.

### Post record structure you must be able to interpret

A Bluesky post is a repository record with Lexicon type `app.bsky.feed.post`. The Lexicon defines required fields `text` and `createdAt`, and optional fields including `facets` (rich text annotations), `reply` (strong refs to root/parent), `embed` (union of image/video/external/record/recordWithMedia), `langs`, `labels` (self-labels; effectively content warnings), and `tags`.

Key details for correct rendering:

- Rich text is represented via *facets* with byte offsets into UTF-8 text, with inclusive start and exclusive end. Bluesky explicitly warns that incorrect indexing produces bad data and recommends using the official RichText tooling in JavaScript environments. Facets should not overlap; renderers should sort by `byteStart` and discard overlaps.
- Replies reference both `root` and `parent` strong references (AT URI + CID) so that long threads can be reconstructed.
- Quote posts use an embed of type `app.bsky.embed.record` (a strong reference to another record), and record-with-media combines a record embed plus compatible media embed.

### Media handling with low resource usage

To keep the bridge lightweight, avoid proxying blobs when possible:

- The images embed “view” schema includes `thumb` and `fullsize` as fully-qualified URLs that can be fetched (e.g., CDN locations provided by the app view).
- External embeds similarly have a “view” form where the thumbnail (`thumb`) is a URL.

Jetstream commit records may include blob references rather than appview URLs, so for posts containing embeds you’ll typically do a **single AppView hydration call per new post** (e.g., fetch post “view” data) and then publish ActivityPub attachments that point directly to `thumb/fullsize` URLs. This shifts bandwidth to follower instances fetching media directly from CDN, preserving your “minimal caching” goal.

### Rate-limit-aware upstream usage

The Bluesky docs emphasize rate limits and explain that `public.api.bsky.app` is cached and intended for public web use cases; they also note that limits evolve and that 429 is used when exceeded.
Because the bridge is read-only, you should avoid authenticated PDS calls and prefer the cached AppView endpoints to reduce both complexity and rate-limit pressure.

## ActivityPub surface area you must implement

ActivityPub server-to-server federation has concrete requirements around inbox/outbox semantics, content types, and delivery behavior. The W3C recommendation specifies that:

- Servers POST to inboxes to deliver activities and GET outboxes to read what an actor posted; actor documents expose `inbox`, `outbox`, `followers`, etc.
- The outbox **MUST** be an `OrderedCollection`, and collections must be presented consistently in reverse chronological order.
- Server-to-server POST requests to inbox MUST use `Content-Type: application/ld+json; profile="https://www.w3.org/ns/activitystreams"`, and GET requests should use the corresponding `Accept` header; `application/activity+json` is commonly treated as equivalent.
- Receiving a `Follow` in an inbox should trigger generating and delivering an `Accept` or `Reject`.
- Shared inbox delivery is an optional optimization: if multiple followers share the same `endpoints.sharedInbox`, a sender may deliver once to that shared inbox instead of many personal inbox POSTs.

In addition to core ActivityPub, **WebFinger** is practically required for Mastodon-style discovery and remote follow. Mastodon’s docs describe that a WebFinger response must return the canonical `subject` and a `rel=self` link with `type=application/activity+json` pointing at the account’s ActivityPub actor URL.

Finally, **HTTP signatures are required for interoperability with major fediverse servers**:

- Mastodon requires HTTP signatures to validate that received activities were authored by the actor generating them; for POST you must also include and sign a body digest (`Digest:`) under the older “HTTP Signatures” approach.
- Mastodon also supports RFC 9421 (“HTTP Message Signatures”) by default since 4.5.0, with strict requirements such as signing `@method`, `@target-uri`, and including a `Content-Digest` header.

### Minimal HTTP endpoints to expose

A pragmatic, interoperability-focused minimum set is:

- `GET /.well-known/webfinger?resource=acct:USER@bridge.example`  
- `GET /ap/actor/{did}` (ActivityPub actor JSON-LD)  
- `POST /ap/actor/{did}/inbox` (receive Follow/Undo Follow/etc)  
- `GET /ap/actor/{did}/outbox` (OrderedCollection with recent Create activities)  
- `GET /ap/actor/{did}/followers` (Collection/OrderedCollection of follower actor IDs; can be minimal/filtered)
- `GET /ap/object/{did}/{rkey}` (Note object JSON-LD; enough for remote fetch and dereference)

Optional but often helpful:

- `GET /.well-known/nodeinfo` + `GET /nodeinfo/2.0` for instance metadata. (This improves compatibility and tooling; many frameworks and validators expect it, though it’s not strictly required for follow+delivery.)

### Example WebFinger response shape

```json
{
  "subject": "acct:alice.bsky.social@bridge.example",
  "aliases": [
    "https://bridge.example/@alice.bsky.social"
  ],
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://bridge.example/ap/actor/did:plc:abcd..."
    }
  ]
}
```

This matches the kind of response Mastodon documents and is the core of remote discovery.

image_group{"layout":"carousel","aspect_ratio":"16:9","query":["ActivityPub inbox outbox diagram","ActivityPub actor object JSON example","AT Protocol Jetstream websocket example","Bluesky AT Protocol architecture diagram"],"num_per_query":1}

## Conversion rules from Bluesky objects to ActivityStreams

This section describes deterministic mapping rules so the bridge is predictable, cacheable, and easy to validate.

### Actor mapping (profile → `Person`)

Create a virtual ActivityPub `Person` actor per Bluesky DID:

- `id`: stable actor URL, e.g. `https://bridge.example/ap/actor/{did}`  
- `preferredUsername`: current handle (cached DID→handle mapping)
- `name`: Bluesky display name (if available)
- `summary`: Bluesky profile description
- `icon`: avatar image URL (from hydrated profile view)
- `image`: banner image URL (if available)
- `inbox`, `outbox`, `followers`: your bridge endpoints 
- `endpoints.sharedInbox` (optional): a *bridge-level* shared inbox (`/ap/sharedInbox`) can reduce inbound complexity, but you can also omit it and rely on per-actor inbox. The spec defines `sharedInbox` as an optional endpoint for wide delivery

#### Cryptographic keys on the actor

Your actor JSON must include a public key reference so remote servers can verify signatures. Mastodon explicitly documents `publicKey` with `id`, `owner`, and PEM material (and ties `Signature.keyId` to this).

Because you are generating “virtual users,” generate and store a keypair **per DID** lazily (first time it is followed). That avoids a key explosion while preserving clean actor isolation.

### Post mapping (record → `Create` with `Note`)

For each Bluesky `app.bsky.feed.post`:

- Activity: `Create`
- Object: `Note`
- `object.id`: stable dereferenceable URL, e.g. `https://bridge.example/ap/object/{did}/{rkey}`
- `attributedTo`: actor URL (`/ap/actor/{did}`)
- `published`: map from `createdAt`
- `content`: HTML (sanitized by receivers like Mastodon)
- Audience:  
  - `to`: `https://www.w3.org/ns/activitystreams#Public` for public visibility
  - `cc`: the actor’s followers collection URL (common practice and aligns with “followers are default delivery target”) 

#### Rendering text and facets

Convert Bluesky rich text facets into HTML anchors and ActivityStreams `tag` objects:

- Use facet byte ranges (UTF-8) to locate substrings and insert `<a href="…">…</a>` for links and mentions.
- Enforce the no-overlap property by sorting facets and dropping overlaps, as recommended.
- For mentions: Bluesky mention facets carry the mentioned account’s DID, so you can link mention anchors either to:
  - the bridged actor URL for that DID (even if unfollowed), or  
  - the original profile on bsky.app as a safe fallback.

Mastodon uses the ActivityPub `tag` property to mark up mentions and hashtags and expects `Mention`/`Hashtag` types in `tag[]`.

#### Embeds and attachments

Map embeds into ActivityPub `attachment`:

- Image embeds: create `Image` or `Document` attachments with `mediaType`, `url` pointing to the `fullsize` URL (optionally also include `thumb` as `icon`), and `name` (or other descriptive field) carrying alt text. The Bluesky embed images view explicitly provides `thumb` and `fullsize` URLs and includes alt text.
- External link cards: add an attachment with `url` set to the external `uri`, and optionally a thumbnail. The external embed schema includes `uri`, `title`, `description`, and a `thumb` URL in the view form.
- Quote posts: if the embed is a record reference, include a link to the quoted post (ideally to the bridged object if it’s in your system; otherwise to a bsky.app URL). Bluesky models quote posts as `app.bsky.embed.record` and record-with-media as `app.bsky.embed.recordWithMedia`.  

#### Replies and threading

If a post has a `reply` block:

- Set `inReplyTo` in the ActivityPub Note. ActivityPub receivers (including Mastodon) use `inReplyTo` for threading.
- If the parent/root posts are bridged, reference their bridged object IDs; otherwise reference the original Bluesky web URL (or omit `inReplyTo` and include a backlink in `content`). Bluesky provides strong refs for both root and parent in replies.

### Deletes and updates

Jetstream exposes commit operations `create`, `update`, and `delete` for records; for deletes you get `(did, collection, rkey)` which is enough to compute the bridged object ID deterministically. 

On ActivityPub side:

- For deletes: send a `Delete` activity for the object ID. ActivityPub specifies that receivers *should* remove their representation or replace with a `Tombstone`, but notes deletions can’t be strictly enforced across servers. 
- For updates: send an `Update` activity containing a full replacement of the object per the spec’s server-to-server update behavior.

Mastodon documents support for `Create`, `Delete`, `Update`, etc. for federated statuses, which aligns with these choices.

### Content warnings from Bluesky self-labels

The `labels` field on `app.bsky.feed.post` is described as self-label values and “effectively content warnings.”
Mastodon uses `summary` as CW text and `sensitive` to decide whether content/media should be hidden by default.

A practical mapping:

- If Bluesky post has self-labels, set `Note.sensitive=true` and set `Note.summary` to a stable string like `Content warning: <label values>`.

## Cache design and minimal persistence model

### What must be stored

Even a “proxy-like” bridge needs persistence for correctness and scalability:

- **Follower relationships**: who follows which bridged actor, plus the follower’s inbox and (if available) sharedInbox for efficient delivery. ActivityPub requires that a successful `Follow` results in the follower being added to the target’s followers collection.
- **Per-actor key material**: private keys must be stored to sign outbound deliveries; public keys are served in actor JSON. Mastodon’s verification model relies on fetching the actor’s public key via `keyId`.
- **A Jetstream cursor**: Jetstream cursors are time-based (unix microseconds). The Jetstream README recommends using `time_us` from the most recently processed event and rewinding a few seconds on reconnect for gapless playback, assuming idempotent processing.
- **A small post cache per actor**: enough to serve outbox pages and dereference object IDs without hitting upstream on every GET. ActivityPub outboxes are expected to be retrievable and ordered, and servers may fetch objects for validation or display.

### What can remain ephemeral

To keep hosting minimal:

- You do **not** need to store full media blobs if you publish ActivityPub attachments with URLs pointing to CDN resources (via hydrated embed “view” objects).
- You do **not** need to store large historical archives; ActivityPub explicitly allows implementers discretion over how many public items are available in outbox without authorization.

### Proposed storage schema (conceptual)

A relational schema (PostgreSQL recommended for scale; SQLite for single-node MVP) can be small:

- `bsky_actor`  
  - `did` (PK), `handle_current`, `display_name`, `description`, `avatar_url`, `banner_url`, `account_state`, `profile_fetched_at`
- `ap_actor_keys`  
  - `did` (PK/FK), `public_key_pem`, `private_key_pem`, `created_at`, `rotated_at`
- `ap_follow`  
  - `did` (FK), `follower_actor_id` (the remote actor URI), `inbox_url`, `shared_inbox_url`, `state` (accepted/pending), `accepted_at`, `last_success_at`
- `post_cache` (ring buffer / capped)  
  - `(did, rkey)` (PK), `note_json`, `create_activity_json`, `published_at`, `deleted` boolean, `cached_at`  
- `jetstream_state`  
  - `shard_id`, `cursor_time_us`, `updated_at`

This supports minimal GET surfaces (actor/outbox/object), deterministic IDs, and efficient recipient fanout.

## Scalability and delivery architecture

### Scaling Jetstream subscriptions

Jetstream supports:

- Multiple public instances operated by Bluesky, and it encourages multiple connections if needed.
- Filtering by `wantedDids` with a documented maximum of 10,000 DIDs per connection, and dynamic updates via subscriber-sent `options_update`.

Plan for scale:

- **Shard followed DIDs across N “ingest workers”**, each maintaining a Jetstream websocket with up to ~10k wanted DIDs.  
- Store per-shard cursor and rewind on reconnect, processing idempotently (dedupe by `(did, collection, rkey, cid/rev)` depending on event).
- If the project ever needs full-network ingestion, fall back to `com.atproto.sync.subscribeRepos` directly (no auth required), but treat that as a later-stage operational choice because Jetstream exists explicitly to avoid full firehose complexity.

### Scaling ActivityPub fan-out

ActivityPub defines shared inbox delivery precisely because per-follower inbox POSTs can be overwhelming at scale; servers may deliver to a follower server’s `sharedInbox` when many recipients share it. 

Your fan-out pipeline should therefore:

- Group recipients by `sharedInbox` where present; otherwise fall back to personal `inbox`.
- Use an **outbound message queue** with retry/backoff and concurrency caps per destination to avoid thundering herds when a large Bluesky account posts. ActivityPub recommends asynchronous delivery and retry on network failure.

### HTTP signature interoperability and “secure fetch” reality

Many real-world servers require signed requests even for GET of actor/object JSON (so-called “secure mode” / “authorized fetch”). Mastodon documents that, when secure mode is enabled, all GET requests require HTTP signatures, and it also describes how to construct signatures and required digest headers for POST.

Therefore your bridge must sign:

- Outbound POST deliveries to remote inboxes (always). 
- Outbound GET requests to fetch follower actor documents (inbox discovery) and potentially other remote objects. 

### Recommended implementation framework: Fedify-powered ActivityPub

A major risk in ActivityPub projects is spending months re-discovering signature edge cases and interoperability expectations. A framework approach helps.

Fedify provides:

- Inbox listeners that automatically verify incoming activity signatures using multiple specifications, including draft-cavage HTTP Signatures and RFC 9421 HTTP Message Signatures.
- Automatic exposure of `/.well-known/webfinger` when wired through its request handler. 
- Actor dispatchers, outbox dispatchers, and a built-in queue concept for outgoing activities.
- Recent (2026) focus on ordered message delivery, permanent failure handling, and modular packages (including message queue backends).

This aligns strongly with your requirement: *minimal server implementation + scalable federation behavior* without building a full instance stack.

## Concrete tech stack and implementation plan

### Language and runtime

**TypeScript on Node.js 22+** is recommended, primarily because modern Fedify requires Node 22 or later in Node environments and because its TypeScript-first architecture reduces the risk of subtle protocol bugs.

### Core dependencies

ActivityPub side (recommended):

- Fedify core + vocabulary packages (Fedify 2.x modular structure).
- A Fedify integration package for your HTTP framework (e.g., Hono integration is explicitly part of the modularization). 
- A message queue backend and persistence:  
  - Start single-node with SQLite-backed queue/storage; scale to Postgres-backed queue. Fedify 2.0 explicitly references multiple official message queue implementations and ordering support.

AT Protocol side (recommended):

- WebSocket client (standard Node WebSocket or a well-supported library) to connect to Jetstream `/subscribe`. Jetstream provides a stable websocket interface with query parameters and subscriber-sent options updates.
- A small HTTP client wrapper to call `https://public.api.bsky.app/xrpc/*` endpoints for profile and post hydration that benefit from AppView caching.

Text/rendering:

- Use official RichText tooling where possible (Bluesky warns against naive substring slicing in JS due to UTF-8 byte indexing for facets).

### Bridge endpoint layout

A stable, DID-based actor/object addressing scheme reduces breakage from handle changes:

- WebFinger address users *type* (`alice.bsky.social@bridge.example`) but map to DID-based actor IDs.
- Actor ID: `https://bridge.example/ap/actor/{did}`
- Object ID: `https://bridge.example/ap/object/{did}/{rkey}`

This is compatible with ActivityPub’s emphasis on dereferenceable IDs and lets you keep actor/object identities stable even if the handle changes.

### Request/processing flows

**Follow flow (ActivityPub → bridge)**

1. Remote instance does WebFinger lookup for `acct:handle@bridge.example`.
2. Bridge resolves handle→DID (cache first; resolve if missing) and returns actor URL.
3. Remote instance fetches actor JSON-LD, discovers `inbox`/`followers` and (optionally) `sharedInbox`.
4. Remote sends `Follow` activity to actor inbox.
5. Bridge verifies signature (recommended), stores follower relationship, and sends `Accept` back to follower’s inbox.

**Post flow (Bluesky → bridge → ActivityPub followers)**

1. Jetstream emits a commit event for `app.bsky.feed.post`, with operation create/update/delete, and includes `did` and `rkey`.
2. Bridge checks whether `did` currently has ActivityPub followers; if not, ignore for minimal resource usage (this mirrors how federation generally only delivers where followers exist).
3. For create/update:
   - Build Note + Create/Update activity.
   - If embeds exist, hydrate via AppView to obtain CDN URLs for attachments.
4. Enqueue outbound deliveries grouped by sharedInbox (if present).
5. Deliver signed POST requests with required digest/signature formats; support RFC 9421 and draft-cavage for compatibility.

### Scalability guardrails

- **DID scale**: shard ingestion beyond 10k followed DIDs by multiple Jetstream connections; reuse cursor strategy and idempotent processing. 
- **Inbox scale**: sharedInbox grouping is the primary lever; ActivityPub explicitly designs this for the “many followers” case. 
- **Failure handling**: treat 404/410 inbox endpoints as permanent failures and garbage-collect followers mapped to those inboxes; this is aligned with real-world federation behavior and is explicitly a feature focus in modern Fedify.
- **Ordering**: preserve per-actor post order at least per destination inbox; Fedify 2.0’s “orderingKey” concept and ordered delivery tooling are specifically aimed at preventing out-of-order federation issues.

### Milestone roadmap

MVP (bridge works for follow + new posts):

- WebFinger → actor discovery, actor JSON served, inbox accepts Follow and responds Accept.
- Jetstream ingestion for `app.bsky.feed.post` create events; build Create+Note; push to followers.
- Basic outbox serving last N posts (from cache, no deep pagination) as an OrderedCollection in reverse chronological order.

Hardening:

- Robust facet-to-HTML conversion using UTF-8 byte ranges; overlap handling.
- Media hydration for embeds using AppView “view” URLs; avoid blob proxying.
- Deletes and (optional) updates propagated.

Scale-out:

- Sharded Jetstream ingestion beyond 10k DIDs; multi-worker outbound queue; sharedInbox optimization.

---

This plan intentionally treats the ActivityPub side as a minimal federation engine (actors + inbox/outbox + delivery + WebFinger) and treats the Bluesky side as a read-only data source via Jetstream + cached public AppView endpoints, meeting the project requirement of “minimal hosting” while remaining compatible with real fediverse interoperability expectations like signed delivery and shared inbox optimization.