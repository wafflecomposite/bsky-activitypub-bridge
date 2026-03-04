import test from "node:test";
import assert from "node:assert/strict";
import { BridgeRuntime } from "../src/bridge/runtime.js";

test("BridgeRuntime processes event and delivers to follower inbox", async () => {
  const delivered = [];
  const fetchImpl = async (url, init) => {
    delivered.push({ url, init });
    return { status: 202 };
  };

  const runtime = new BridgeRuntime({
    baseUrl: "https://bridge.example",
    fetchImpl
  });

  runtime.store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  runtime.store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/bob",
    inboxUrl: "https://remote.example/users/bob/inbox"
  });

  const ingestResult = runtime.ingestJetstreamEvent({
    did: "did:plc:alice",
    time_us: 1234,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "post-1",
      record: {
        text: "Hello from Bluesky",
        createdAt: "2026-03-04T00:00:00.000Z"
      }
    }
  });

  assert.equal(ingestResult.status, "enqueued");
  assert.equal(runtime.queue.size(), 1);

  const deliveryResults = await runtime.drainDeliveries();

  assert.equal(deliveryResults.length, 1);
  assert.equal(deliveryResults[0].status, "delivered");
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].url, "https://remote.example/users/bob/inbox");

  const activity = JSON.parse(delivered[0].init.body);
  assert.equal(activity.type, "Create");
  assert.equal(activity.object.type, "Note");
  assert.equal(activity.object.content, "Hello from Bluesky");
});
