import test from "node:test";
import assert from "node:assert/strict";
import { InMemoryBridgeStore } from "../src/storage/in-memory-store.js";

test("InMemoryBridgeStore lists followed DIDs", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  store.upsertActor({ did: "did:plc:bob", handle: "bob.bsky.social" });

  store.addFollower("did:plc:bob", {
    actorId: "https://remote.example/users/r2",
    inboxUrl: "https://remote.example/users/r2/inbox"
  });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/r1",
    inboxUrl: "https://remote.example/users/r1/inbox"
  });

  assert.deepEqual(store.listFollowedDids(), ["did:plc:alice", "did:plc:bob"]);
});

test("InMemoryBridgeStore stores objects and exposes outbox activities", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });

  store.upsertObjectActivity({
    did: "did:plc:alice",
    rkey: "post-1",
    operation: "create",
    object: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/post-1",
      type: "Note",
      published: "2026-03-04T00:00:01.000Z"
    },
    activity: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/post-1/activity/create",
      type: "Create",
      published: "2026-03-04T00:00:01.000Z"
    }
  });

  store.upsertObjectActivity({
    did: "did:plc:alice",
    rkey: "post-2",
    operation: "create",
    object: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/post-2",
      type: "Note",
      published: "2026-03-04T00:00:02.000Z"
    },
    activity: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/post-2/activity/create",
      type: "Create",
      published: "2026-03-04T00:00:02.000Z"
    }
  });

  const object = store.getObjectByRkey("did:plc:alice", "post-2");
  assert.equal(object.deleted, false);
  assert.equal(object.object.type, "Note");

  const outbox = store.listOutboxActivities("did:plc:alice", { limit: 20 });
  assert.equal(outbox.length, 2);
  assert.equal(outbox[0].id, "https://bridge.example/ap/object/did%3Aplc%3Aalice/post-2/activity/create");
});
