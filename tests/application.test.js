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
