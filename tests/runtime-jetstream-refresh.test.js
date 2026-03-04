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

  static reset() {
    FakeWebSocket.instances = [];
  }
}

test("BridgeRuntime refreshes Jetstream wanted DIDs from provider", () => {
  FakeWebSocket.reset();

  const runtime = new BridgeRuntime({
    baseUrl: "https://bridge.example"
  });

  runtime.store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  runtime.store.upsertActor({ did: "did:plc:bob", handle: "bob.bsky.social" });
  runtime.store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/r1",
    inboxUrl: "https://remote.example/users/r1/inbox"
  });

  const intervals = [];
  const timers = {
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return Symbol("interval");
    },
    clearInterval: () => {},
    setTimeout: () => Symbol("timeout"),
    clearTimeout: () => {}
  };

  runtime.startJetstream({
    wantedDidsProvider: () => runtime.store.listFollowedDids(),
    wantedDidsRefreshMs: 5000,
    WebSocketImpl: FakeWebSocket,
    timers,
    jetstreamUrl: "wss://jetstream.example/subscribe"
  });

  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].ms, 5000);

  runtime.store.addFollower("did:plc:bob", {
    actorId: "https://remote.example/users/r2",
    inboxUrl: "https://remote.example/users/r2/inbox"
  });

  intervals[0].fn();

  const ws = FakeWebSocket.instances[0];
  assert.equal(ws.sent.length, 1);

  const update = JSON.parse(ws.sent[0]);
  assert.equal(update.type, "options_update");
  assert.deepEqual(update.payload.wantedDids, ["did:plc:alice", "did:plc:bob"]);

  runtime.stopJetstream({ timers });
});

test("BridgeRuntime keeps jetstream idle when wanted DID set is empty", () => {
  FakeWebSocket.reset();

  const runtime = new BridgeRuntime({
    baseUrl: "https://bridge.example"
  });

  const intervals = [];
  const timers = {
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return Symbol("interval");
    },
    clearInterval: () => {},
    setTimeout: () => Symbol("timeout"),
    clearTimeout: () => {}
  };

  runtime.startJetstream({
    wantedDidsProvider: () => runtime.store.listFollowedDids(),
    wantedDidsRefreshMs: 5000,
    WebSocketImpl: FakeWebSocket,
    timers,
    jetstreamUrl: "wss://jetstream.example/subscribe"
  });

  assert.equal(FakeWebSocket.instances.length, 0);
  assert.equal(intervals.length, 1);

  runtime.store.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
  runtime.store.addFollower("did:plc:alice", {
    actorId: "https://remote.example/users/r1",
    inboxUrl: "https://remote.example/users/r1/inbox"
  });

  intervals[0].fn();
  assert.equal(FakeWebSocket.instances.length, 1);

  runtime.stopJetstream({ timers });
});
