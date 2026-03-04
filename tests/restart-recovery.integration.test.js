import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeRuntime } from "../src/bridge/runtime.js";
import { FileDeliveryQueue } from "../src/delivery/file-delivery-queue.js";
import { FileJetstreamState } from "../src/ingest/file-jetstream-state.js";
import { FileBridgeStore } from "../src/storage/file-bridge-store.js";

test("BridgeRuntime recovers queued deliveries and cursor after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-restart-"));
  const storePath = join(dir, "store.json");
  const statePath = join(dir, "state.json");
  const queuePath = join(dir, "queue.json");

  try {
    const store1 = new FileBridgeStore({ filePath: storePath });
    const state1 = new FileJetstreamState({ filePath: statePath });
    const queue1 = new FileDeliveryQueue({ filePath: queuePath });

    const runtime1 = new BridgeRuntime({
      baseUrl: "https://bridge.example",
      store: store1,
      state: state1,
      queue: queue1,
      fetchImpl: async () => ({ status: 202 })
    });

    runtime1.store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
    runtime1.store.addFollower("did:plc:alice", {
      actorId: "https://remote.example/users/bob",
      inboxUrl: "https://remote.example/users/bob/inbox"
    });

    const ingest = runtime1.ingestJetstreamEvent({
      did: "did:plc:alice",
      time_us: 500,
      commit: {
        collection: "app.bsky.feed.post",
        operation: "create",
        rkey: "abc",
        record: {
          text: "hello",
          createdAt: "2026-03-04T00:00:00.000Z"
        }
      }
    });

    assert.equal(ingest.status, "enqueued");
    assert.equal(queue1.size(), 1);
    assert.equal(state1.getCursor("default"), 500);

    const delivered = [];
    const runtime2 = new BridgeRuntime({
      baseUrl: "https://bridge.example",
      store: new FileBridgeStore({ filePath: storePath }),
      state: new FileJetstreamState({ filePath: statePath }),
      queue: new FileDeliveryQueue({ filePath: queuePath }),
      fetchImpl: async (url) => {
        delivered.push(url);
        return { status: 202 };
      }
    });

    assert.equal(runtime2.state.getCursor("default"), 500);
    assert.equal(runtime2.queue.size(), 1);

    const results = await runtime2.drainDeliveries({ max: 2 });
    assert.equal(results.length, 1);
    assert.equal(results[0].status, "delivered");
    assert.equal(delivered.length, 1);
    assert.equal(runtime2.queue.size(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
