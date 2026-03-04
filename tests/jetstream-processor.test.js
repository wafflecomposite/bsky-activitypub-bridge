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

test("JetstreamProcessor ignores invalid or control events without throwing", () => {
  const { queue, processor } = createProcessorFixture();

  const controlLike = processor.process({
    type: "options_update_ack"
  });

  assert.equal(controlLike.status, "invalid-event");
  assert.equal(controlLike.enqueued, 0);
  assert.equal(queue.size(), 0);
});

test("JetstreamProcessor defaults to unlisted audience for creates", () => {
  const { store, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/a1",
    inboxUrl: "https://remote.example/users/a1/inbox"
  });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 900,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "audience",
      record: {
        text: "audience test",
        createdAt: "2026-03-04T00:00:00.000Z"
      }
    }
  });

  assert.equal(result.status, "enqueued");
  const queued = queue.list()[0];
  assert.deepEqual(queued.activity.to, ["https://bridge.example/ap/actor/did%3Aplc%3Aalice/followers"]);
  assert.deepEqual(queued.activity.cc, ["https://www.w3.org/ns/activitystreams#Public"]);
});

test("JetstreamProcessor preserves self-thread reply linkage", () => {
  const { store, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/a1",
    inboxUrl: "https://remote.example/users/a1/inbox"
  });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 901,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "thread-reply",
      record: {
        text: "reply",
        createdAt: "2026-03-04T00:00:00.000Z",
        reply: {
          parent: {
            uri: "at://did:plc:alice/app.bsky.feed.post/thread-parent"
          },
          root: {
            uri: "at://did:plc:alice/app.bsky.feed.post/thread-root"
          }
        }
      }
    }
  });

  assert.equal(result.status, "enqueued");
  const queued = queue.list()[0];
  assert.equal(
    queued.activity.object.inReplyTo,
    "https://bridge.example/ap/object/did%3Aplc%3Aalice/thread-parent"
  );
  assert.equal(
    queued.activity.object.context,
    "https://bridge.example/ap/object/did%3Aplc%3Aalice/thread-root"
  );
});

test("JetstreamProcessor caches mapped object even when there are no followers", () => {
  const { store, processor } = createProcessorFixture();
  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 902,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "cached-without-followers",
      record: {
        text: "cache me",
        createdAt: "2026-03-04T00:00:00.000Z"
      }
    }
  });

  assert.equal(result.status, "no-followers");
  const cached = store.getObjectByRkey("did:plc:alice", "cached-without-followers");
  assert.equal(cached?.object?.type, "Note");
});

test("JetstreamProcessor maps replies to bridged non-self parent when cached", () => {
  const { store, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.upsertActor({ did: "did:plc:bob", handle: "bob.bsky.social" });
  store.upsertObjectActivity({
    did: "did:plc:bob",
    rkey: "root9",
    operation: "create",
    object: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Abob/root9",
      type: "Note",
      published: "2026-03-04T00:00:00.000Z"
    },
    activity: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Abob/root9/activity/create",
      type: "Create",
      published: "2026-03-04T00:00:00.000Z"
    }
  });

  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/a1",
    inboxUrl: "https://remote.example/users/a1/inbox"
  });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 903,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "reply-to-bob",
      record: {
        text: "reply",
        createdAt: "2026-03-04T00:00:00.000Z",
        reply: {
          parent: {
            uri: "at://did:plc:bob/app.bsky.feed.post/root9"
          }
        }
      }
    }
  });

  assert.equal(result.status, "enqueued");
  const queued = queue.list()[0];
  assert.equal(
    queued.activity.object.inReplyTo,
    "https://bridge.example/ap/object/did%3Aplc%3Abob/root9"
  );
});

test("JetstreamProcessor maps repost create to Announce activity", () => {
  const { store, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/a1",
    inboxUrl: "https://remote.example/users/a1/inbox"
  });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 904,
    commit: {
      collection: "app.bsky.feed.repost",
      operation: "create",
      rkey: "rp1",
      record: {
        createdAt: "2026-03-04T00:00:00.000Z",
        subject: {
          uri: "at://did:plc:bob/app.bsky.feed.post/post9",
          cid: "cid-1"
        }
      }
    }
  });

  assert.equal(result.status, "enqueued");
  const queued = queue.list()[0];
  assert.equal(queued.activity.type, "Announce");
  assert.equal(queued.activity.object, "https://bridge.example/ap/object/did%3Aplc%3Abob/post9");

  const cached = store.getObjectByRkey("did:plc:alice", "app.bsky.feed.repost:rp1");
  assert.equal(cached?.activity?.type, "Announce");
});

test("JetstreamProcessor maps repost delete to Delete activity", () => {
  const { store, queue, processor } = createProcessorFixture();

  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/a1",
    inboxUrl: "https://remote.example/users/a1/inbox"
  });

  const result = processor.process({
    did: "did:plc:alice",
    time_us: 905,
    commit: {
      collection: "app.bsky.feed.repost",
      operation: "delete",
      rkey: "rp2"
    }
  });

  assert.equal(result.status, "enqueued");
  const queued = queue.list()[0];
  assert.equal(queued.activity.type, "Delete");
  assert.equal(queued.activity.object, "https://bridge.example/ap/object/did%3Aplc%3Aalice/repost%3Arp2");
});
