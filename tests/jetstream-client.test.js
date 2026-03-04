import test from "node:test";
import assert from "node:assert/strict";
import { buildJetstreamSubscribeUrl, JetstreamClient } from "../src/ingest/jetstream-client.js";

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

  emitClose() {
    this.readyState = FakeWebSocket.CLOSED;
    if (this.onclose) {
      this.onclose({ code: 1006 });
    }
  }

  static reset() {
    FakeWebSocket.instances = [];
  }
}

test("buildJetstreamSubscribeUrl adds rewound cursor and filters", () => {
  const url = buildJetstreamSubscribeUrl({
    jetstreamUrl: "wss://jetstream.example/subscribe",
    cursor: 10_000_000,
    rewindSeconds: 5,
    wantedCollections: ["app.bsky.feed.post"],
    wantedDids: ["did:plc:alice"]
  });

  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("cursor"), "5000000");
  assert.equal(parsed.searchParams.get("wantedCollections"), "app.bsky.feed.post");
  assert.equal(parsed.searchParams.get("wantedDids"), "did:plc:alice");
});

test("JetstreamClient processes messages and can update wanted DIDs", () => {
  FakeWebSocket.reset();

  const processed = [];
  const client = new JetstreamClient({
    processor: {
      process: (event) => processed.push(event)
    },
    state: {
      getCursor: () => null
    },
    jetstreamUrl: "wss://jetstream.example/subscribe",
    wantedCollections: ["app.bsky.feed.post"],
    wantedDids: ["did:plc:alice"],
    WebSocketImpl: FakeWebSocket
  });

  client.start();

  assert.equal(FakeWebSocket.instances.length, 1);

  const ws = FakeWebSocket.instances[0];
  ws.emitMessage({ did: "did:plc:alice", commit: { collection: "app.bsky.feed.post", operation: "create", rkey: "x" } });
  ws.emitMessage({ did: "did:plc:mallory", commit: { collection: "app.bsky.feed.post", operation: "create", rkey: "y" } });

  assert.equal(processed.length, 1);

  client.setWantedDids(["did:plc:alice", "did:plc:bob"]);
  assert.equal(ws.sent.length, 1);
  const update = JSON.parse(ws.sent[0]);
  assert.equal(update.type, "options_update");
  assert.deepEqual(update.payload.wantedDids, ["did:plc:alice", "did:plc:bob"]);

  client.stop();
});

test("JetstreamClient reconnects after close", () => {
  FakeWebSocket.reset();

  const scheduled = [];
  const timers = {
    setTimeout: (fn, ms) => {
      scheduled.push({ fn, ms });
      return Symbol("timer");
    },
    clearTimeout: () => {}
  };

  const client = new JetstreamClient({
    processor: { process: () => {} },
    state: { getCursor: () => 2_000_000 },
    jetstreamUrl: "wss://jetstream.example/subscribe",
    wantedDids: ["did:plc:alice"],
    reconnectDelayMs: 250,
    rewindSeconds: 1,
    WebSocketImpl: FakeWebSocket,
    timers
  });

  client.start();
  assert.equal(FakeWebSocket.instances.length, 1);

  FakeWebSocket.instances[0].emitClose();
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 250);

  scheduled[0].fn();
  assert.equal(FakeWebSocket.instances.length, 2);

  const second = new URL(FakeWebSocket.instances[1].url);
  assert.equal(second.searchParams.get("cursor"), "1000000");

  client.stop();
});

test("JetstreamClient does not connect until wanted DIDs are set by default", () => {
  FakeWebSocket.reset();

  const processed = [];
  const client = new JetstreamClient({
    processor: { process: (event) => processed.push(event) },
    state: { getCursor: () => null },
    jetstreamUrl: "wss://jetstream.example/subscribe",
    wantedCollections: ["app.bsky.feed.post"],
    wantedDids: [],
    WebSocketImpl: FakeWebSocket
  });

  client.start();
  assert.equal(FakeWebSocket.instances.length, 0);

  client.setWantedDids(["did:plc:alice"]);
  assert.equal(FakeWebSocket.instances.length, 1);

  const ws = FakeWebSocket.instances[0];
  ws.emitMessage({ did: "did:plc:alice", commit: { collection: "app.bsky.feed.post", operation: "create", rkey: "x" } });
  assert.equal(processed.length, 1);

  client.setWantedDids([]);
  assert.equal(ws.readyState, FakeWebSocket.CLOSED);
  client.stop();
});

test("JetstreamClient can connect unfiltered when explicitly allowed", () => {
  FakeWebSocket.reset();

  const processed = [];
  const client = new JetstreamClient({
    processor: { process: (event) => processed.push(event) },
    state: { getCursor: () => null },
    jetstreamUrl: "wss://jetstream.example/subscribe",
    wantedCollections: ["app.bsky.feed.post"],
    wantedDids: [],
    requireWantedDids: false,
    WebSocketImpl: FakeWebSocket
  });

  client.start();
  assert.equal(FakeWebSocket.instances.length, 1);

  FakeWebSocket.instances[0].emitMessage({
    did: "did:plc:anyone",
    commit: { collection: "app.bsky.feed.post", operation: "create", rkey: "x" }
  });
  assert.equal(processed.length, 1);

  client.stop();
});
