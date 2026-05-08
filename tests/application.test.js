import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBridgeApplication } from "../src/app/application.js";
import { FileKeyManager } from "../src/crypto/file-key-manager.js";
import { FileBridgeStore } from "../src/storage/file-bridge-store.js";
import { FileDeliveryQueue } from "../src/delivery/file-delivery-queue.js";
import { FileJetstreamState } from "../src/ingest/file-jetstream-state.js";

test("createBridgeApplication enables strict inbox signature verifier", () => {
  const app = createBridgeApplication({
    strictInboxSignatures: true,
    fetchImpl: async () => ({ status: 404, json: async () => ({}) })
  });

  assert.equal(typeof app.inboxSignatureVerifier, "function");
});

test("createBridgeApplication uses file-backed components when dataDir is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-app-"));

  try {
    const app = createBridgeApplication({
      dataDir: dir
    });

    assert.equal(app.store instanceof FileBridgeStore, true);
    assert.equal(app.queue instanceof FileDeliveryQueue, true);
    assert.equal(app.state instanceof FileJetstreamState, true);
    assert.equal(app.keyManager instanceof FileKeyManager, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createBridgeApplication exposes metrics snapshot before runtime starts", () => {
  const app = createBridgeApplication();
  const metrics = app.getMetrics();

  assert.equal(metrics.queueDepth, 0);
  assert.equal(metrics.delivery.delivered, 0);
  assert.equal(metrics.jetstream.running, false);
});

test("createBridgeApplication flushes async file stores on stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-app-"));

  try {
    const app = createBridgeApplication({
      dataDir: dir
    });

    app.store.upsertActor({
      did: "did:plc:alice",
      handle: "alice.bsky.social"
    });

    await app.stop();

    const reloaded = new FileBridgeStore({ filePath: join(dir, "store.json") });
    assert.equal(reloaded.getActorByDid("did:plc:alice")?.handle, "alice.bsky.social");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createBridgeApplication logs follow Accept delivery results", async () => {
  const followEvents = [];
  const app = createBridgeApplication({
    baseUrl: "https://bridge.example",
    followLogger: (event) => followEvents.push(event),
    fetchImpl: async () => ({ status: 202 }),
    createServer: () => ({
      start: async () => ({
        host: "127.0.0.1",
        port: 0,
        baseUrl: "https://bridge.example"
      }),
      stop: async () => {}
    }),
    delivery: {
      drainIntervalMs: 0
    }
  });

  app.store.upsertActor({
    did: "did:plc:alice",
    handle: "alice.bsky.social"
  });
  app.keyManager.ensureKeyPair("did:plc:alice");
  app.queue.enqueue({
    did: "did:plc:alice",
    destination: "https://remote.example/inbox",
    recipientActorIds: ["https://remote.example/users/bob"],
    operation: "follow-accept",
    activity: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: "https://bridge.example/ap/actor/did%3Aplc%3Aalice/activities/accept/test",
      type: "Accept",
      actor: "https://bridge.example/ap/actor/did%3Aplc%3Aalice",
      object: {
        type: "Follow",
        actor: "https://remote.example/users/bob",
        object: "https://bridge.example/ap/actor/did%3Aplc%3Aalice"
      }
    }
  });

  try {
    await app.start({ port: 0 });
    const drain = await app.getRuntime().drainDeliveries({ max: 1 });
    assert.equal(drain[0].status, "delivered");
  } finally {
    await app.stop();
  }

  const deliveryEvent = followEvents.find((event) => event.event === "follow.accept.delivery");
  assert.equal(deliveryEvent?.did, "did:plc:alice");
  assert.equal(deliveryEvent?.destination, "https://remote.example/inbox");
  assert.equal(deliveryEvent?.status, 202);
  assert.equal(deliveryEvent?.ok, true);
});
