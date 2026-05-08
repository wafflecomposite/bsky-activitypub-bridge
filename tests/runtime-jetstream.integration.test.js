import test from "node:test";
import assert from "node:assert/strict";
import { BridgeRuntime } from "../src/bridge/runtime.js";

class FakeWebSocket {
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.OPEN;
    this.sent = [];
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    FakeWebSocket.instances.push(this);
  }

  send(data) {
    this.sent.push(data);
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code: 1000 });
    }
  }

  emitMessage(payload) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(payload) });
    }
  }

  static reset() {
    FakeWebSocket.instances = [];
  }
}

test("BridgeRuntime can ingest from Jetstream client and deliver", async () => {
  FakeWebSocket.reset();

  const runtime = new BridgeRuntime({
    baseUrl: "https://bridge.example",
    fetchImpl: async () => ({ status: 202 })
  });

  runtime.store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  runtime.store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/bob",
    inboxUrl: "https://remote.example/users/bob/inbox"
  });

  runtime.startJetstream({
    WebSocketImpl: FakeWebSocket,
    jetstreamUrl: "wss://jetstream.example/subscribe",
    wantedDids: ["did:plc:alice"]
  });

  assert.equal(FakeWebSocket.instances.length, 1);

  FakeWebSocket.instances[0].emitMessage({
    did: "did:plc:alice",
    time_us: 123,
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

  FakeWebSocket.instances[0].emitMessage({
    did: "did:plc:mallory",
    time_us: 124,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "ignored",
      record: {
        text: "should be ignored",
        createdAt: "2026-03-04T00:00:01.000Z"
      }
    }
  });

  assert.equal(runtime.queue.size(), 1);
  assert.equal(runtime.store.getObjectByRkey("did:plc:mallory", "ignored"), null);

  const delivery = await runtime.drainDeliveries({ max: 1 });
  assert.equal(delivery.length, 1);
  assert.equal(delivery[0].status, "delivered");

  runtime.stopJetstream();
});

test("BridgeRuntime ingests from all Jetstream shards and keeps shard cursors separate", () => {
  FakeWebSocket.reset();

  const runtime = new BridgeRuntime({
    baseUrl: "https://bridge.example",
    fetchImpl: async () => ({ status: 202 })
  });
  const dids = ["did:plc:alice", "did:plc:bob", "did:plc:carol"];

  for (const did of dids) {
    runtime.store.upsertActor({ did, handle: `${did.split(":").at(-1)}.bsky.social` });
    runtime.store.addFollower(did, {
      actorId: "https://remote.example/users/bob",
      inboxUrl: "https://remote.example/users/bob/inbox"
    });
  }

  runtime.startJetstream({
    WebSocketImpl: FakeWebSocket,
    jetstreamUrl: "wss://jetstream.example/subscribe",
    wantedDids: dids,
    maxDidsPerStream: 1
  });

  assert.equal(FakeWebSocket.instances.length, 3);
  for (const [index, did] of dids.entries()) {
    const ws = FakeWebSocket.instances.find((instance) => {
      return new URL(instance.url).searchParams.getAll("wantedDids").includes(did);
    });
    assert.ok(ws);
    ws.emitMessage({
      did,
      time_us: 200 + index,
      commit: {
        collection: "app.bsky.feed.post",
        operation: "create",
        rkey: `post-${index}`,
        record: {
          text: `hello ${index}`,
          createdAt: "2026-03-04T00:00:00.000Z"
        }
      }
    });
  }

  FakeWebSocket.instances[0].emitMessage({
    did: "did:plc:mallory",
    time_us: 999,
    commit: {
      collection: "app.bsky.feed.post",
      operation: "create",
      rkey: "ignored",
      record: {
        text: "ignored",
        createdAt: "2026-03-04T00:00:00.000Z"
      }
    }
  });

  assert.equal(runtime.queue.size(), 3);
  assert.equal(runtime.state.getCursor("default"), 200);
  assert.equal(runtime.state.getCursor("default:1"), 201);
  assert.equal(runtime.state.getCursor("default:2"), 202);
  assert.equal(runtime.store.getObjectByRkey("did:plc:mallory", "ignored"), null);

  runtime.stopJetstream();
});
