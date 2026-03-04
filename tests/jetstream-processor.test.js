import test from "node:test";
import assert from "node:assert/strict";
import { JetstreamProcessor, InMemoryDeliveryQueue } from "../src/ingest/jetstream-processor.js";
import { InMemoryJetstreamState } from "../src/ingest/in-memory-jetstream-state.js";
import { InMemoryBridgeStore } from "../src/storage/in-memory-store.js";

function createProcessorFixture() {
  const store = new InMemoryBridgeStore();
  const state = new InMemoryJetstreamState();
  const queue = new InMemoryDeliveryQueue();

  const processor = new JetstreamProcessor({
    baseUrl: "https://bridge.example",
    shardId: "shard-1",
    store,
    state,
    queue
  });

  return { store, state, queue, processor };
}

test("JetstreamProcessor enqueues grouped deliveries and advances cursor", () => {
  const { store, state, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote-a.example/users/a1",
    inboxUrl: "https://remote-a.example/users/a1/inbox",
    sharedInboxUrl: "https://remote-a.example/inbox"
  });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote-a.example/users/a2",
    inboxUrl: "https://remote-a.example/users/a2/inbox",
    sharedInboxUrl: "https://remote-a.example/inbox"
  });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote-b.example/users/b1",
    inboxUrl: "https://remote-b.example/users/b1/inbox"
  });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 100,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "abc",
      record: {
        text: "hello",
        createdAt: "2026-03-04T00:00:00.000Z"
      }
    }
  });

  assert.equal(result.status, "enqueued");
  assert.equal(result.enqueued, 2);
  assert.equal(state.getCursor("shard-1"), 100);
  assert.equal(queue.size(), 2);

  const destinations = queue.list().map((item) => item.destination).sort();
  assert.deepEqual(destinations, [
    "https://remote-a.example/inbox",
    "https://remote-b.example/users/b1/inbox"
  ]);
});

test("JetstreamProcessor deduplicates repeated event keys", () => {
  const { store, state, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/a1",
    inboxUrl: "https://remote.example/users/a1/inbox"
  });

  const event = {
    did: "did:plc:alice",
    time_us: 123,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "abc",
      record: {
        text: "hello",
        createdAt: "2026-03-04T00:00:00.000Z"
      }
    }
  };

  const first = processor.process(event);
  const second = processor.process(event);

  assert.equal(first.status, "enqueued");
  assert.equal(second.status, "duplicate");
  assert.equal(queue.size(), 1);
  assert.equal(state.getCursor("shard-1"), 123);
});

test("JetstreamProcessor advances cursor but ignores non-post collections", () => {
  const { state, queue, processor } = createProcessorFixture();

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 222,
    commit: {
      collection: "app.bsky.graph.follow",
      operation: "create",
      rkey: "abc",
      record: {
        subject: "did:plc:bob"
      }
    }
  });

  assert.equal(result.status, "ignored");
  assert.equal(result.enqueued, 0);
  assert.equal(queue.size(), 0);
  assert.equal(state.getCursor("shard-1"), 222);
});

test("JetstreamProcessor handles delete by enqueuing Delete activity", () => {
  const { store, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/a1",
    inboxUrl: "https://remote.example/users/a1/inbox"
  });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 444,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "delete",
      rkey: "gone"
    }
  });

  assert.equal(result.status, "enqueued");
  assert.equal(result.enqueued, 1);

  const queued = queue.list()[0];
  assert.equal(queued.activity.type, "Delete");
  assert.equal(queued.activity.object, "https://bridge.example/ap/object/did%3Aplc%3Aalice/gone");
});
