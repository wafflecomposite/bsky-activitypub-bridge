import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { RemoteActorCache } from "../src/ap/remote-actor-cache.js";
import { verifyInboxRequestSignature } from "../src/federation/inbox-signature-verifier.js";
import { createSignedPostHeaders } from "../src/federation/http-signature.js";
import { dispatchBridgeRequest, shouldReadRequestBody } from "../src/server.js";
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
  assert.equal(actorRes.body.bot, true);
  assert.equal(typeof actorRes.body.summary, "string");
  assert.equal(actorRes.body.summary.includes("Bridged by https://bridge.example"), true);
  assert.equal(actorRes.body.following, "https://bridge.example/ap/actor/did%3Aplc%3Aalice/following");
  assert.equal(actorRes.body.featured, "https://bridge.example/ap/actor/did%3Aplc%3Aalice/featured");

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
  assert.equal(outboxRes.body.totalItems, 0);

  const followingRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/following",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });
  assert.equal(followingRes.status, 200);
  assert.equal(followingRes.body.totalItems, 0);

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

test("dispatchBridgeRequest serves object and outbox from cached activities", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social"
  });

  store.upsertObjectActivity({
    did: "did:plc:alice",
    rkey: "root1",
    operation: "create",
    object: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1",
      type: "Note",
      published: "2026-03-04T00:00:01.000Z",
      content: "root"
    },
    activity: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1/activity/create",
      type: "Create",
      published: "2026-03-04T00:00:01.000Z",
      object: {
        id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1",
        type: "Note"
      }
    }
  });

  store.upsertObjectActivity({
    did: "did:plc:alice",
    rkey: "reply1",
    operation: "create",
    object: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/reply1",
      type: "Note",
      published: "2026-03-04T00:00:02.000Z",
      content: "reply",
      inReplyTo: "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1"
    },
    activity: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/reply1/activity/create",
      type: "Create",
      published: "2026-03-04T00:00:02.000Z",
      object: {
        id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/reply1",
        type: "Note"
      }
    }
  });

  const objectRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/object/did%3Aplc%3Aalice/reply1",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });

  assert.equal(objectRes.status, 200);
  assert.equal(objectRes.body.type, "Note");
  assert.equal(objectRes.body.inReplyTo, "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1");

  const outboxRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/outbox?limit=1",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });

  assert.equal(outboxRes.status, 200);
  assert.equal(outboxRes.body.type, "OrderedCollection");
  assert.equal(outboxRes.body.totalItems, 2);
  assert.equal(outboxRes.body.orderedItems[0].id, "https://bridge.example/ap/object/did%3Aplc%3Aalice/reply1/activity/create");

  store.upsertObjectActivity({
    did: "did:plc:alice",
    rkey: "root1",
    operation: "delete",
    activity: {
      id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1/activity/delete",
      type: "Delete",
      object: "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1"
    }
  });

  const deletedRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/object/did%3Aplc%3Aalice/root1",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl
  });

  assert.equal(deletedRes.status, 410);
  assert.equal(deletedRes.body.type, "Tombstone");
});

test("dispatchBridgeRequest can materialize uncached object on demand", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  const objectRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/object/did%3Aplc%3Aalice/late1",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aalice&collection=app.bsky.feed.post&rkey=late1"
      );
      return {
        status: 200,
        ok: true,
        json: async () => ({
          uri: "at://did:plc:alice/app.bsky.feed.post/late1",
          cid: "cid-late",
          value: {
            $type: "app.bsky.feed.post",
            text: "late fetched",
            createdAt: "2026-03-04T00:00:00.000Z"
          }
        })
      };
    }
  });

  assert.equal(objectRes.status, 200);
  assert.equal(objectRes.body.content, "late fetched");
  const cached = store.getObjectByRkey("did:plc:alice", "late1");
  assert.equal(cached?.object?.content, "late fetched");
});

test("dispatchBridgeRequest materializes uncached object even when actor profile is unavailable", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  const objectRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/object/did%3Aplc%3Aalice/late2",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      if (url.includes("/app.bsky.actor.getProfile")) {
        throw new Error("Object fetch must not depend on profile lookup");
      }

      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aalice&collection=app.bsky.feed.post&rkey=late2"
      );
      return {
        status: 200,
        ok: true,
        json: async () => ({
          uri: "at://did:plc:alice/app.bsky.feed.post/late2",
          cid: "cid-late-2",
          value: {
            $type: "app.bsky.feed.post",
            text: "late fetched without profile",
            createdAt: "2026-03-04T00:00:01.000Z"
          }
        })
      };
    }
  });

  assert.equal(objectRes.status, 200);
  assert.equal(objectRes.body.content, "late fetched without profile");
  const cached = store.getObjectByRkey("did:plc:alice", "late2");
  assert.equal(cached?.object?.content, "late fetched without profile");
});

test("dispatchBridgeRequest can auto-materialize actor on WebFinger lookup", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  const requestedUrls = [];
  const webfingerRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/.well-known/webfinger?resource=acct:autoalice.bsky.social@bridge.example",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url.includes("/com.atproto.identity.resolveHandle")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:autoalice123"
          })
        };
      }

      if (url.includes("/app.bsky.actor.getProfile")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:autoalice123",
            handle: "autoalice.bsky.social",
            displayName: "Auto Alice",
            description: "bridged profile",
            avatar: "https://cdn.example/avatar.jpg",
            banner: "https://cdn.example/banner.jpg"
          })
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(requestedUrls.some((url) => url.includes("/com.atproto.identity.resolveHandle")), true);
  assert.equal(requestedUrls.some((url) => url.includes("/app.bsky.actor.getProfile")), true);
  assert.equal(webfingerRes.status, 200);
  assert.equal(webfingerRes.body.subject, "acct:autoalice.bsky.social@bridge.example");
  assert.equal(store.resolveDidByHandle("autoalice.bsky.social"), "did:plc:autoalice123");
  const actor = store.getActorByDid("did:plc:autoalice123");
  assert.equal(actor.displayName, "Auto Alice");
  assert.equal(actor.avatarUrl, "https://cdn.example/avatar.jpg");
  assert.equal(actor.bannerUrl, "https://cdn.example/banner.jpg");
});

test("dispatchBridgeRequest serves discovery frontpage", async () => {
  const response = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/",
    headers: { host: "bridge.example" },
    store: new InMemoryBridgeStore(),
    keyManager: new InMemoryKeyManager(),
    baseUrl: "https://bridge.example"
  });

  assert.equal(response.status, 200);
  assert.equal(response.contentType, "text/html");
  assert.equal(typeof response.body, "string");
  assert.equal(response.body.includes("Bluesky Bridge Resolver"), true);
  assert.equal(response.body.includes("<form"), true);
});

test("dispatchBridgeRequest resolves actor discovery query and materializes actor", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();
  const requestedUrls = [];

  const response = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/?q=%40autoalice.bsky.social",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      requestedUrls.push(url);
      if (url.includes("/com.atproto.identity.resolveHandle")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:autoalice123"
          })
        };
      }

      if (url.includes("/app.bsky.actor.getProfile")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:autoalice123",
            handle: "autoalice.bsky.social"
          })
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.contentType, "text/html");
  assert.equal(response.body.includes("autoalice.bsky.social@bridge.example"), true);
  assert.equal(response.body.includes("Copy"), true);
  assert.equal(response.body.includes("ap/actor/did%3Aplc%3Aautoalice123"), false);
  assert.equal(response.body.includes("resolved-target"), true);
  assert.equal(requestedUrls.some((url) => url.includes("/com.atproto.identity.resolveHandle")), true);
  assert.equal(requestedUrls.some((url) => url.includes("/app.bsky.actor.getProfile")), true);
});

test("dispatchBridgeRequest resolves post discovery query and materializes object", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  const response = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/?q=https%3A%2F%2Fbsky.app%2Fprofile%2Fautoalice.bsky.social%2Fpost%2Flate1",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      if (url.includes("/com.atproto.identity.resolveHandle")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:autoalice123"
          })
        };
      }

      if (url.includes("/app.bsky.actor.getProfile")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:autoalice123",
            handle: "autoalice.bsky.social"
          })
        };
      }

      if (url.includes("/com.atproto.repo.getRecord")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            uri: "at://did:plc:autoalice123/app.bsky.feed.post/late1",
            cid: "cid-late",
            value: {
              $type: "app.bsky.feed.post",
              text: "late fetched via frontpage",
              createdAt: "2026-03-04T00:00:00.000Z"
            }
          })
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.contentType, "text/html");
  assert.equal(response.body.includes("https://bridge.example/ap/object/did%3Aplc%3Aautoalice123/late1"), true);
  assert.equal(response.body.includes("autoalice.bsky.social@bridge.example"), false);
  const cached = store.getObjectByRkey("did:plc:autoalice123", "late1");
  assert.equal(cached?.object?.content, "late fetched via frontpage");
});

test("dispatchBridgeRequest resolves post discovery query when profile lookup is unavailable", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  const response = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/?q=https%3A%2F%2Fbsky.app%2Fprofile%2Fautoalice.bsky.social%2Fpost%2Flate2",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      if (url.includes("/com.atproto.identity.resolveHandle")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:autoalice123"
          })
        };
      }

      if (url.includes("/app.bsky.actor.getProfile")) {
        return {
          status: 503,
          ok: false,
          json: async () => ({})
        };
      }

      if (url.includes("/com.atproto.repo.getRecord")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            uri: "at://did:plc:autoalice123/app.bsky.feed.post/late2",
            cid: "cid-late2",
            value: {
              $type: "app.bsky.feed.post",
              text: "late fetched with resolve fallback",
              createdAt: "2026-03-04T00:00:02.000Z"
            }
          })
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.contentType, "text/html");
  assert.equal(response.body.includes("https://bridge.example/ap/object/did%3Aplc%3Aautoalice123/late2"), true);

  const cached = store.getObjectByRkey("did:plc:autoalice123", "late2");
  assert.equal(cached?.object?.content, "late fetched with resolve fallback");
});

test("dispatchBridgeRequest exposes discovery resolver JSON API", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  const response = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/api/resolve?q=mouseu.bsky.social",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      if (url.includes("/com.atproto.identity.resolveHandle")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:mouseu123"
          })
        };
      }

      if (url.includes("/app.bsky.actor.getProfile")) {
        return {
          status: 200,
          ok: true,
          json: async () => ({
            did: "did:plc:mouseu123",
            handle: "mouseu.bsky.social"
          })
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    }
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.result.kind, "actor");
  assert.equal(response.body.result.acct, "mouseu.bsky.social@bridge.example");
  assert.equal(response.body.result.actorUrl, "https://bridge.example/ap/actor/did%3Aplc%3Amouseu123");
});

test("dispatchBridgeRequest discovery resolver JSON API validates missing query", async () => {
  const response = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/api/resolve",
    headers: { host: "bridge.example" },
    store: new InMemoryBridgeStore(),
    keyManager: new InMemoryKeyManager(),
    baseUrl: "https://bridge.example"
  });

  assert.equal(response.status, 400);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error, "Missing q query parameter");
});

test("dispatchBridgeRequest can auto-materialize actor by DID on actor endpoint", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  const actorRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aautodid123",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Aautodid123"
      );
      return {
        status: 200,
        ok: true,
        json: async () => ({
          did: "did:plc:autodid123",
          handle: "autodid.bsky.social",
          description: "auto did profile"
        })
      };
    }
  });

  assert.equal(actorRes.status, 200);
  assert.equal(actorRes.body.preferredUsername, "autodid.bsky.social");
  assert.equal(store.resolveDidByHandle("autodid.bsky.social"), "did:plc:autodid123");
});

test("dispatchBridgeRequest hydrates seeded actor profile on first actor read", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  store.upsertActor({
    did: "did:plc:seeded123",
    handle: "seeded.bsky.social"
  });

  const actorRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aseeded123",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Aseeded123"
      );
      return {
        status: 200,
        ok: true,
        json: async () => ({
          did: "did:plc:seeded123",
          handle: "seeded.bsky.social",
          displayName: "Seeded User",
          avatar: "https://cdn.example/seeded-avatar.jpg"
        })
      };
    }
  });

  assert.equal(actorRes.status, 200);
  assert.equal(actorRes.body.name, "Seeded User");
  assert.equal(actorRes.body.icon.url, "https://cdn.example/seeded-avatar.jpg");
  const updatedActor = store.getActorByDid("did:plc:seeded123");
  assert.equal(typeof updatedActor.profileFetchedAt, "string");
});

test("dispatchBridgeRequest serves featured collection from pinned post", async () => {
  const baseUrl = "https://bridge.example";
  const store = new InMemoryBridgeStore();
  const keyManager = new InMemoryKeyManager();

  store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social",
    pinnedPostUri: "at://did:plc:alice/app.bsky.feed.post/pinned1"
  });

  const featuredRes = await dispatchBridgeRequest({
    method: "GET",
    rawUrl: "/ap/actor/did%3Aplc%3Aalice/featured",
    headers: { host: "bridge.example" },
    store,
    keyManager,
    baseUrl,
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aalice&collection=app.bsky.feed.post&rkey=pinned1"
      );
      return {
        status: 200,
        ok: true,
        json: async () => ({
          uri: "at://did:plc:alice/app.bsky.feed.post/pinned1",
          cid: "cid1",
          value: {
            $type: "app.bsky.feed.post",
            text: "pinned post",
            createdAt: "2026-03-04T00:00:00.000Z"
          }
        })
      };
    }
  });

  assert.equal(featuredRes.status, 200);
  assert.equal(featuredRes.body.totalItems, 1);
  assert.equal(featuredRes.body.orderedItems[0].content, "pinned post");
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

test("shouldReadRequestBody skips non-body methods", () => {
  assert.equal(shouldReadRequestBody({ method: "GET" }), false);
  assert.equal(shouldReadRequestBody({ method: "HEAD" }), false);
  assert.equal(shouldReadRequestBody({ method: "OPTIONS" }), false);
});

test("shouldReadRequestBody keeps reading POST-like methods", () => {
  assert.equal(shouldReadRequestBody({ method: "POST" }), true);
  assert.equal(shouldReadRequestBody({ method: "PUT" }), true);
  assert.equal(shouldReadRequestBody({ method: "PATCH" }), true);
});
