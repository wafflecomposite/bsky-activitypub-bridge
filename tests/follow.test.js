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
