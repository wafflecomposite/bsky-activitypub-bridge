# Jetstream Scaling Notes

This is a future-task note, not an implementation plan.

## Current State

- The bridge currently uses one `JetstreamClient` from `BridgeRuntime.startJetstream()`.
- `wantedDidsProvider` returns all followed DIDs, and the client sends the full list as `wantedDids` query params or `options_update` payload.
- The bridge also applies client-side DID filtering, which is useful as defense in depth but does not remove the upstream wanted-DID limit.
- Jetstream cursor and dedup state are already keyed by `shardId`, so the persistence model can support multiple stream shards.
- There is no current internal cap, warning, or sharding behavior. If the followed DID list exceeds Jetstream service limits, the single subscription can fail at the service boundary.

## External Limits And Sources

- Current Jetstream docs describe `wantedDids` as limited to 10,000 DIDs per connection, `wantedCollections` as limited to 100 collections, and `options_update` messages as limited to 10 MB.
- The earlier remembered 1,000-account limit appears stale or from a different service/period.
- Relevant references:
  - `https://github.com/bluesky-social/jetstream`
  - `https://atproto.com/blog/jetstream`
  - `https://atproto.com/specs/sync`
  - `https://atproto.com/guides/streaming-data`

## Scaling Options

### 1. Shard Jetstream By Followed DID

Split followed DIDs into chunks below the public limit, for example with a configurable safety cap such as `JETSTREAM_MAX_DIDS_PER_STREAM=8000`.

Expected shape:
- one `JetstreamClient` per shard
- stable shard IDs, such as `jetstream:0`, `jetstream:1`, etc.
- shared `JetstreamProcessor`, store, and delivery queue
- independent cursor/dedup state per shard
- per-shard metrics: wanted DID count, connection URL, reconnects, last cursor, last event time

Rebalancing should avoid event gaps:
- add a DID to its new shard first
- wait for that shard connection/options update to be active
- remove the DID from its previous shard after that
- tolerate duplicates during transitions; processing is already deduped by shard, but cross-shard duplicate handling may need a global event-key cache if DIDs can overlap briefly

This is the smallest practical step.

### 2. Self-Host Jetstream

Self-hosting avoids relying on public best-effort Jetstream instances and gives operational control, but it does not by itself remove software/configuration limits. It pairs well with sharding.

### 3. Consume The Full ATProto Firehose

Use `com.atproto.sync.subscribeRepos` from a relay and perform filtering locally.

Pros:
- no wanted-DID subscription limit
- protocol-native source of truth
- more control over replay, verification, and recovery

Costs:
- parse repo commit/firehose frames
- handle CAR/CBOR data
- maintain stronger repo/account sync state
- implement gap recovery and backfill paths

This is the long-term correctness path if Jetstream sharding becomes operationally insufficient.

### 4. Polling As Repair Only

Polling public AppView/repo APIs per followed account should not be primary ingest. It has poor scaling properties, higher latency, and weaker delete/profile-update coverage. It is useful as repair/backfill.

## Test Strategy Without Many Real Accounts

- Unit test with injected low shard cap, for example `maxDidsPerJetstream=2`, then use 5 synthetic DIDs and assert 3 WebSocket connections.
- Add a synthetic 10,001-DID test using fake DID strings only. No real accounts or live subscriptions are required.
- Assert no generated subscription exceeds the shard cap.
- Assert each followed DID maps to exactly one intended shard during steady state.
- Assert each shard sends correct `wantedDids` in initial URL and `options_update`.
- Assert events from all shards reach the shared processor.
- Assert out-of-shard events are still rejected client-side.
- Test rebalance behavior with add/remove followed DIDs:
  - new shard receives DID before old shard loses it
  - duplicate transition events are safe
  - empty shards stop cleanly
- Local E2E can use a fake Jetstream WebSocket server that enforces a tiny DID cap and disconnects on violation.
- Live E2E can set `JETSTREAM_MAX_DIDS_PER_STREAM=1` with one real followed DID plus fake followed DIDs, then assert multiple stream connections exist and the real DID still delivers.

## Recommendation

Implement Jetstream DID sharding first, behind a configurable shard cap. Keep full-firehose ingestion as a separate future strategy so the mapper, store, delivery queue, and ActivityPub surface remain reusable.
