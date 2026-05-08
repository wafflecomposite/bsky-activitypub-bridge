import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BridgeRuntime } from "../bridge/runtime.js";
import { FileDeliveryQueue } from "../delivery/file-delivery-queue.js";
import { FileJetstreamState } from "../ingest/file-jetstream-state.js";
import { FileBridgeStore } from "../storage/file-bridge-store.js";

export async function runLocalE2EHarness({ workDir = null, cleanup = true } = {}) {
  const tempDir = workDir ?? mkdtempSync(join(tmpdir(), "bridge-local-e2e-"));
  const storePath = join(tempDir, "store.json");
  const statePath = join(tempDir, "state.json");
  const queuePath = join(tempDir, "queue.json");

  const attemptsByDestination = new Map();

  try {
    const runtime = new BridgeRuntime({
      baseUrl: "https://bridge.example",
      store: new FileBridgeStore({ filePath: storePath }),
      state: new FileJetstreamState({ filePath: statePath }),
      queue: new FileDeliveryQueue({ filePath: queuePath }),
      fetchImpl: async (url) => {
        const attempt = (attemptsByDestination.get(url) ?? 0) + 1;
        attemptsByDestination.set(url, attempt);

        if (attempt === 1) {
          return { status: 503 };
        }

        return { status: 202 };
      }
    });

    runtime.store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
    runtime.store.addFollower("did:plc:alice", {
      actorId: "https://remote.example/users/bob",
      inboxUrl: "https://remote.example/users/bob/inbox"
    });

    const ingest = runtime.ingestJetstreamEvent({
      did: "did:plc:alice",
      time_us: 1_000_000,
      commit: {
        collection: "app.bsky.feed.post",
        operation: "create",
        rkey: "post-1",
        record: {
          text: "Hello from harness",
          createdAt: "2026-03-04T00:00:00.000Z"
        }
      }
    });

    const queuedActivity = runtime.queue.list()[0]?.activity ?? null;
    const queuedUnlisted = Array.isArray(queuedActivity?.to)
      && queuedActivity.to.includes("https://bridge.example/ap/actor/did%3Aplc%3Aalice/followers")
      && Array.isArray(queuedActivity?.cc)
      && queuedActivity.cc.includes("https://www.w3.org/ns/activitystreams#Public");
    const firstDrain = await runtime.drainDeliveries({ max: 5, now: 1_000 });
    const secondDrain = await runtime.drainDeliveries({ max: 5, now: 2_500 });

    const summary = {
      ok: ingest.status === "enqueued"
        && queuedUnlisted
        && firstDrain.some((entry) => entry.status === "retry-scheduled")
        && secondDrain.some((entry) => entry.status === "delivered")
        && runtime.queue.size() === 0,
      ingestStatus: ingest.status,
      queuedUnlisted,
      firstDrain,
      secondDrain,
      queueSize: runtime.queue.size(),
      cursor: runtime.state.getCursor("default"),
      workDir: tempDir
    };

    return summary;
  } finally {
    if (!workDir && cleanup) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}
