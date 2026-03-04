import test from "node:test";
import assert from "node:assert/strict";
import { dispatchBridgeRequest } from "../src/server.js";
import { InMemoryKeyManager } from "../src/crypto/key-manager.js";
import { InMemoryBridgeStore } from "../src/storage/in-memory-store.js";

test("dispatchBridgeRequest handles WebFinger, actor document, and follow inbox", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    displayName: "Alice"
  });

  const webfingerRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/.well-known/webfinger?resource=acct:alice.bsky.social@bridge.example",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });

  assert.equal(webfingerRes.status, 200);
  assert.equal(webfingerRes.body.subject, "acct:alice.bsky.social@bridge.example");

  const actorRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });

  assert.equal(actorRes.status, 200);
  assert.equal(actorRes.body.type, "Person");
  assert.equal(actorRes.body.preferredUsername, "alice.bsky.social");

  const followRes = await dispatchBridgeRequest({
    method: "POST",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers: { host: "bridge.example" },
    bodyText: JSON.stringify({
      id: "https://remote.example/activities/follow-1",
      type: "Follow",
      actor: {
        id: "https://remote.example/users/bob",
        inbox: "https://remote.example/inbox"
      },
      object: actorRes.body.id
    }),
    store,
    keyManager,
    baseUrl
  });

  assert.equal(followRes.status, 202);
  assert.equal(followRes.body.status, "accepted");

  const followers = store.listFollowers("did:plc:alice");
  assert.equal(followers.length, 1);
  assert.equal(followers[0].actorId, "https://remote.example/users/bob");
});
