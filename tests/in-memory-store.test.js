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

test("InMemoryBridgeStore removes followers and drops empty followed DIDs", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });

  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/r1",
    inboxUrl: "https://remote.example/users/r1/inbox"
  });

  const removed = store.removeFollower("did:plc:alice", "https://remote.example/users/r1");
  assert.equal(removed.actorId, "https://remote.example/users/r1");
  assert.deepEqual(store.listFollowers("did:plc:alice"), []);
  assert.deepEqual(store.listFollowedDids(), []);
  assert.equal(store.removeFollower("did:plc:alice", "https://remote.example/users/r1"), null);
});

test("InMemoryBridgeStore stores objects and exposes outbox activities", () => {
  const store = new InMemoryBridgeStore();
  const actor = store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    pinnedPostUri: "at://did:plc:alice/app.bsky.feed.post/pin1"
  });
  assert.equal(actor.pinnedPostUri, "at://did:plc:alice/app.bsky.feed.post/pin1");

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
  assert.equal(store.countOutboxActivities("did:plc:alice"), 2);
});

test("InMemoryBridgeStore expires object cache entries by last access", () => {
  let now = Date.parse("2026-03-04T00:00:00.000Z");
  const store = new InMemoryBridgeStore({
    objectCacheTtlMs: 1000,
    now: () => now
  });

  store.upsertObjectActivity({
    did: "did:plc:alice",
    rkey: "old-post",
    operation: "create",
    object: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/old-post",
      type: "Note",
      published: "2026-03-04T00:00:00.000Z"
    },
    activity: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/old-post/activity/create",
      type: "Create",
      published: "2026-03-04T00:00:00.000Z"
    }
  });

  now += 1001;

  assert.equal(store.getObjectByRkey("did:plc:alice", "old-post"), null);
  assert.equal(store.countOutboxActivities("did:plc:alice"), 0);
});

test("InMemoryBridgeStore prunes least recently used object records over max size", () => {
  let now = Date.parse("2026-03-04T00:00:00.000Z");
  const store = new InMemoryBridgeStore({
    objectCacheMaxRecords: 2,
    now: () => now
  });

  for (const rkey of ["post-1", "post-2", "post-3"]) {
    store.upsertObjectActivity({
      did: "did:plc:alice",
      rkey,
      operation: "create",
      object: {
        id: `https://bridge.example/ap/object/did%3Aplc%3Aalice/${rkey}`,
        type: "Note",
        published: new Date(now).toISOString()
      },
      activity: {
        id: `https://bridge.example/ap/object/did%3Aplc%3Aalice/${rkey}/activity/create`,
        type: "Create",
        published: new Date(now).toISOString()
      }
    });
    now += 1;
  }

  assert.equal(store.getObjectByRkey("did:plc:alice", "post-1"), null);
  assert.equal(store.getObjectByRkey("did:plc:alice", "post-2")?.object?.type, "Note");
  assert.equal(store.getObjectByRkey("did:plc:alice", "post-3")?.object?.type, "Note");
  assert.equal(store.countOutboxActivities("did:plc:alice"), 2);
});

test("InMemoryBridgeStore prunes stale profile details while retaining followed actor identity", () => {
  let now = Date.parse("2026-03-04T00:00:00.000Z");
  const store = new InMemoryBridgeStore({
    profileCacheTtlMs: 1000,
    now: () => now
  });

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    displayName: "Alice",
    summary: "bio",
    avatarUrl: "https://cdn.example/avatar.jpg",
    pinnedPostUri: "at://did:plc:alice/app.bsky.feed.post/pin1",
    profileFetchedAt: "2026-03-04T00:00:00.000Z"
  });
  store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/r1",
    inboxUrl: "https://remote.example/users/r1/inbox"
  });

  now += 1001;
  const result = store.pruneCache();
  const actor = store.getActorByDid("did:plc:alice");

  assert.equal(result.profilesCleared, 1);
  assert.equal(actor.handle, "alice.bsky.social");
  assert.equal(actor.displayName, null);
  assert.equal(actor.summary, null);
  assert.equal(actor.avatarUrl, null);
  assert.equal(actor.pinnedPostUri, null);
  assert.equal(store.listFollowers("did:plc:alice").length, 1);
});

test("InMemoryBridgeStore preserves profile fields on partial actor upsert", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    displayName: "Alice",
    avatarUrl: "https://cdn.bsky.app/avatar/alice.jpg",
    profileFetchedAt: "2026-03-04T00:00:00.000Z"
  });

  const merged = store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social"
  });

  assert.equal(merged.displayName, "Alice");
  assert.equal(merged.avatarUrl, "https://cdn.bsky.app/avatar/alice.jpg");
  assert.equal(merged.profileFetchedAt, "2026-03-04T00:00:00.000Z");
});
