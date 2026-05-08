import test from "node:test";
import assert from "node:assert/strict";
import { processInboxActivity } from "../src/ap/follow.js";
import { InMemoryBridgeStore } from "../src/storage/in-memory-store.js";

const BASE_URL = "https://bridge.example";
const DID = "did:plc:alice";

test("processInboxActivity accepts valid Follow and stores follower", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: DID, handle: "alice.bsky.social" });

  const activity = {
    id: "https://remote.example/activities/123",
    type: "Follow",
    actor: {
      id: "https://remote.example/users/bob",
      inbox: "https://remote.example/inbox",
      endpoints: {
        sharedInbox: "https://remote.example/inbox"
      }
    },
    object: "https://bridge.example/ap/actor/did%3Aplc%3Aalice"
  };

  const result = processInboxActivity({
    activity,
    targetDid: DID,
    baseUrl: BASE_URL,
    store
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.status, "accepted");

  const followers = store.listFollowers(DID);
  assert.equal(followers.length, 1);
  assert.equal(followers[0].actorId, "https://remote.example/users/bob");
  assert.equal(followers[0].inboxUrl, "https://remote.example/inbox");
});

test("processInboxActivity rejects non-targeted Follow object", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: DID, handle: "alice.bsky.social" });

  const result = processInboxActivity({
    activity: {
      type: "Follow",
      actor: "https://remote.example/users/bob",
      object: "https://bridge.example/ap/actor/did%3Aplc%3Anot-alice"
    },
    targetDid: DID,
    baseUrl: BASE_URL,
    store
  });

  assert.equal(result.status, 400);
});

test("processInboxActivity accepts Undo Follow and removes follower", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: DID, handle: "alice.bsky.social" });
  store.addFollower(DID, {
    actorId: "https://remote.example/users/bob",
    inboxUrl: "https://remote.example/inbox"
  });

  const result = processInboxActivity({
    activity: {
      id: "https://remote.example/activities/undo-1",
      type: "Undo",
      actor: "https://remote.example/users/bob",
      object: {
        id: "https://remote.example/activities/follow-1",
        type: "Follow",
        actor: "https://remote.example/users/bob",
        object: "https://bridge.example/ap/actor/did%3Aplc%3Aalice"
      }
    },
    targetDid: DID,
    baseUrl: BASE_URL,
    store
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.status, "undone");
  assert.equal(result.body.removed, true);
  assert.equal(store.listFollowers(DID).length, 0);
  assert.deepEqual(store.listFollowedDids(), []);
});

test("processInboxActivity accepts Undo with linked Follow object", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: DID, handle: "alice.bsky.social" });
  store.addFollower(DID, {
    actorId: "https://remote.example/users/bob",
    inboxUrl: "https://remote.example/inbox"
  });

  const result = processInboxActivity({
    activity: {
      type: "Undo",
      actor: "https://remote.example/users/bob",
      object: "https://remote.example/activities/follow-1"
    },
    targetDid: DID,
    baseUrl: BASE_URL,
    store
  });

  assert.equal(result.status, 202);
  assert.equal(result.body.removed, true);
  assert.equal(store.listFollowers(DID).length, 0);
});

test("processInboxActivity rejects Undo Follow for another actor", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: DID, handle: "alice.bsky.social" });
  store.addFollower(DID, {
    actorId: "https://remote.example/users/bob",
    inboxUrl: "https://remote.example/inbox"
  });

  const result = processInboxActivity({
    activity: {
      type: "Undo",
      actor: "https://remote.example/users/bob",
      object: {
        type: "Follow",
        actor: "https://remote.example/users/bob",
        object: "https://bridge.example/ap/actor/did%3Aplc%3Anot-alice"
      }
    },
    targetDid: DID,
    baseUrl: BASE_URL,
    store
  });

  assert.equal(result.status, 400);
  assert.equal(store.listFollowers(DID).length, 1);
});
