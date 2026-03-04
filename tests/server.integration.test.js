import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { RemoteActorCache } from "../src/ap/remote-actor-cache.js";
import { verifyInboxRequestSignature } from "../src/federation/inbox-signature-verifier.js";
import { createSignedPostHeaders } from "../src/federation/http-signature.js";
import { dispatchBridgeRequest } from "../src/server.js";
import { InMemoryKeyManager } from "../src/crypto/key-manager.js";
import { InMemoryDeliveryQueue } from "../src/ingest/jetstream-processor.js";
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

  const outboxRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/outbox",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });
  assert.equal(outboxRes.status, 200);
  assert.equal(outboxRes.body.type, "OrderedCollection");

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

  const followersRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/followers",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });
  assert.equal(followersRes.status, 200);
  assert.equal(followersRes.body.totalItems, 1);
});

test("dispatchBridgeRequest can auto-materialize actor on WebFinger lookup", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  let resolveCalls = 0;
  const webfingerRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/.well-known/webfinger?resource=acct:autoalice.bsky.social@bridge.example",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      resolveCalls += 1;
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=autoalice.bsky.social"
      );

      return {
        status: 200,
        json: async () => ({
          did: "did:plc:autoalice123"
        })
      };
    }
  });

  assert.equal(resolveCalls, 1);
  assert.equal(webfingerRes.status, 200);
  assert.equal(webfingerRes.body.subject, "acct:autoalice.bsky.social@bridge.example");
  assert.equal(store.resolveDidByHandle("autoalice.bsky.social"), "did:plc:autoalice123");
});

test("dispatchBridgeRequest resolves remote actor and queues Accept delivery", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();
  const deliveryQueue = new InMemoryDeliveryQueue();

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    displayName: "Alice"
  });

  let actorFetchCalls = 0;
  const followRes = await dispatchBridgeRequest({
    method: "POST",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers: { host: "bridge.example" },
    bodyText: JSON.stringify({
      id: "https://remote.example/activities/follow-2",
      type: "Follow",
      actor: "https://remote.example/users/bob",
      object: "https://bridge.example/ap/actor/did%3Aplc%3Aalice"
    }),
    store,
    keyManager,
    baseUrl,
    deliveryQueue,
    fetchImpl: async (url, init) => {
      actorFetchCalls += 1;
      assert.equal(url, "https://remote.example/users/bob");
      assert.equal(init.method, "GET");
      assert.ok(init.headers.signature);
      return {
        status: 200,
        json: async () => ({
          id: "https://remote.example/users/bob",
          inbox: "https://remote.example/users/bob/inbox",
          endpoints: {
            sharedInbox: "https://remote.example/inbox"
          }
        })
      };
    }
  });

  assert.equal(actorFetchCalls, 1);
  assert.equal(followRes.status, 202);
  assert.equal(deliveryQueue.size(), 1);
  const queued = deliveryQueue.list()[0];
  assert.equal(queued.operation, "follow-accept");
  assert.equal(queued.destination, "https://remote.example/users/bob/inbox");
  assert.equal(queued.activity.type, "Accept");
});

test("dispatchBridgeRequest reuses remote actor cache across follows", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();
  const actorCache = new RemoteActorCache();

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    displayName: "Alice"
  });

  let actorFetchCalls = 0;
  const fetchImpl = async () => {
    actorFetchCalls += 1;
    return {
      status: 200,
      json: async () => ({
        id: "https://remote.example/users/bob",
        inbox: "https://remote.example/users/bob/inbox"
      })
    };
  };

  const followPayload = JSON.stringify({
    type: "Follow",
    actor: "https://remote.example/users/bob",
    object: "https://bridge.example/ap/actor/did%3Aplc%3Aalice"
  });

  await dispatchBridgeRequest({
    method: "POST",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers: { host: "bridge.example" },
    bodyText: followPayload,
    store,
    keyManager,
    baseUrl,
    fetchImpl,
    actorCache
  });

  await dispatchBridgeRequest({
    method: "POST",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers: { host: "bridge.example" },
    bodyText: followPayload,
    store,
    keyManager,
    baseUrl,
    fetchImpl,
    actorCache
  });

  assert.equal(actorFetchCalls, 1);
});

test("dispatchBridgeRequest can enforce inbox signature verification", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    displayName: "Alice"
  });

  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const body = JSON.stringify({
    id: "https://remote.example/activities/follow-3",
    type: "Follow",
    actor: {
      id: "https://remote.example/users/bob",
      inbox: "https://remote.example/users/bob/inbox"
    },
    object: "https://bridge.example/ap/actor/did%3Aplc%3Aalice"
  });

  const signedHeaders = createSignedPostHeaders({
    destination: "https://bridge.example/ap/actor/did%3Aplc%3Aalice/inbox",
    body,
    keyId: "https://remote.example/users/bob#main-key",
    privateKeyPem: privateKey,
    date: new Date("2026-03-04T00:00:00.000Z")
  });

  const result = await dispatchBridgeRequest({
    method: "POST",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers: {
      host: "bridge.example",
      ...signedHeaders
    },
    bodyText: body,
    store,
    keyManager,
    baseUrl,
    inboxSignatureVerifier: ({ method, requestTarget, headers, body: requestBody }) => verifyInboxRequestSignature({
      method,
      requestTarget,
      headers,
      body: requestBody,
      now: () => Date.parse("2026-03-04T00:00:30.000Z"),
      fetchImpl: async () => ({
        status: 200,
        json: async () => ({
          id: "https://remote.example/users/bob",
          publicKey: {
            id: "https://remote.example/users/bob#main-key",
            owner: "https://remote.example/users/bob",
            publicKeyPem: publicKey
          }
        })
      })
    })
  });

  assert.equal(result.status, 202);
});

test("dispatchBridgeRequest rejects inbox request when signature verification fails", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    displayName: "Alice"
  });

  const result = await dispatchBridgeRequest({
    method: "POST",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers: { host: "bridge.example" },
    bodyText: JSON.stringify({
      type: "Follow",
      actor: "https://remote.example/users/bob",
      object: "https://bridge.example/ap/actor/did%3Aplc%3Aalice"
    }),
    store,
    keyManager,
    baseUrl,
    inboxSignatureVerifier: () => ({ ok: false, error: "bad-signature" })
  });

  assert.equal(result.status, 401);
  assert.equal(result.body.error, "bad-signature");
});
