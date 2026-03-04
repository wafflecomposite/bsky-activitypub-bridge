import test from "node:test";
import assert from "node:assert/strict";
import { resolveWebFingerResource } from "../src/ap/webfinger.js";
import { InMemoryBridgeStore } from "../src/storage/in-memory-store.js";

test("resolveWebFingerResource returns JRD payload", () => {
  const store = new InMemoryBridgeStore();
  store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });

  const response = resolveWebFingerResource({
    resource: "acct:alice.bsky.social@bridge.example",
    bridgeHost: "bridge.example",
    baseUrl: "https://bridge.example",
    store
  });

  assert.equal(response.subject, "acct:alice.bsky.social@bridge.example");
  assert.equal(response.links[0].rel, "self");
  assert.equal(response.links[0].type, "application/activity+json");
  assert.equal(response.links[0].href, "https://bridge.example/ap/actor/did%3Aplc%3Aalice");
});

test("resolveWebFingerResource returns null for unknown handle", () => {
  const store = new InMemoryBridgeStore();

  const response = resolveWebFingerResource({
    resource: "acct:alice.bsky.social@bridge.example",
    bridgeHost: "bridge.example",
    baseUrl: "https://bridge.example",
    store
  });

  assert.equal(response, null);
});
