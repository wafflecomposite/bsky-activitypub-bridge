import test from "node:test";
import assert from "node:assert/strict";
import { BridgeRuntime, planJetstreamShards } from "../src/bridge/runtime.js";

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

test("planJetstreamShards splits synthetic large DID lists without real accounts", () => {
  const dids = Array.from({ length: 10_001 }, (_, index) => makeDid(index));
  const shards = planJetstreamShards({
    baseShardId: "jetstream",
    wantedDids: dids,
    maxDidsPerStream: 1000
  });

  assert.equal(shards.length, 11);
  assert.equal(shards[0].shardId, "jetstream");
  assert.equal(shards[10].shardId, "jetstream:10");
  assert.equal(shards.every((shard) => shard.wantedDids.length <= 1000), true);
  assert.equal(new Set(shards.flatMap((shard) => shard.wantedDids)).size, 10_001);
});

test("BridgeRuntime starts one Jetstream client per wanted DID shard", () => {
  FakeWebSocket.reset();

  const runtime = new BridgeRuntime({
    baseUrl: "https://bridge.example"
  });

  runtime.startJetstream({
    wantedDids: [makeDid(0), makeDid(1), makeDid(2), makeDid(3), makeDid(4)],
    maxDidsPerStream: 2,
    WebSocketImpl: FakeWebSocket,
    timers: inertTimers(),
    jetstreamUrl: "wss://jetstream.example/subscribe"
  });

  assert.equal(FakeWebSocket.instances.length, 3);
  assert.deepEqual(FakeWebSocket.instances.map((ws) => wantedDidsFromUrl(ws.url)), [
    [makeDid(0), makeDid(1)],
    [makeDid(2), makeDid(3)],
    [makeDid(4)]
  ]);

  const metrics = runtime.getMetrics().jetstream;
  assert.equal(metrics.running, true);
  assert.equal(metrics.wantedDidCount, 5);
  assert.equal(metrics.shardCount, 3);
  assert.deepEqual(metrics.shards.map((shard) => shard.shardId), ["default", "default:1", "default:2"]);
  assert.equal(metrics.shards.every((shard) => shard.wantedDidCount <= 2), true);

  runtime.stopJetstream({ timers: inertTimers() });
});

test("BridgeRuntime refresh can grow from one stream to multiple shards", () => {
  FakeWebSocket.reset();

  const runtime = new BridgeRuntime({
    baseUrl: "https://bridge.example"
  });
  let currentDids = [makeDid(0)];

  const intervals = [];
  const timers = {
    ...inertTimers(),
    setInterval: (fn, ms) => {
      intervals.push({ fn, ms });
      return Symbol("interval");
    }
  };

  runtime.startJetstream({
    wantedDidsProvider: () => currentDids,
    wantedDidsRefreshMs: 5000,
    maxDidsPerStream: 2,
    WebSocketImpl: FakeWebSocket,
    timers,
    jetstreamUrl: "wss://jetstream.example/subscribe"
  });

  assert.equal(FakeWebSocket.instances.length, 1);
  currentDids = [makeDid(0), makeDid(1), makeDid(2), makeDid(3), makeDid(4)];
  intervals[0].fn();

  assert.equal(FakeWebSocket.instances.length, 3);
  assert.deepEqual(JSON.parse(FakeWebSocket.instances[0].sent[0]).payload.wantedDids, [makeDid(0), makeDid(1)]);
  assert.deepEqual(wantedDidsFromUrl(FakeWebSocket.instances[1].url), [makeDid(2), makeDid(3)]);
  assert.deepEqual(wantedDidsFromUrl(FakeWebSocket.instances[2].url), [makeDid(4)]);

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

function makeDid(index) {
  return `did:plc:scale${String(index).padStart(5, "0")}`;
}

function wantedDidsFromUrl(url) {
  return new URL(url).searchParams.getAll("wantedDids");
}

function inertTimers() {
  return {
    setInterval: () => Symbol("interval"),
    clearInterval: () => {},
    setTimeout: () => Symbol("timeout"),
    clearTimeout: () => {}
  };
}
