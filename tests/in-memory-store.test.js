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
