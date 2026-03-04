import test from "node:test";
import assert from "node:assert/strict";
import { DeliveryWorker, computeExponentialBackoffMs } from "../src/delivery/delivery-worker.js";
import { InMemoryKeyManager } from "../src/crypto/key-manager.js";
import { InMemoryDeliveryQueue } from "../src/ingest/jetstream-processor.js";

test("DeliveryWorker sends signed POST and marks success", async () => {
  const queue = new InMemoryDeliveryQueue();
  const keyManager = new InMemoryKeyManager();

  let request;
  const fetchImpl = async (url, init) => {
    request = { url, init };
    return { status: 202 };
  };

  queue.enqueue({
    did: "did:plc:alice",
    destination: "https://remote.example/inbox",
    activity: { type: "Create", id: "x" }
  });

  const worker = new DeliveryWorker({
    queue,
    keyManager,
    fetchImpl,
    baseUrl: "https://bridge.example"
  });

  const result = await worker.drainOnce();

  assert.equal(result.status, "delivered");
  assert.equal(queue.size(), 0);
  assert.equal(request.url, "https://remote.example/inbox");
  assert.equal(request.init.method, "POST");
  assert.ok(request.init.headers.signature);
  assert.ok(request.init.headers.digest);
});

test("DeliveryWorker retries transient failures with backoff", async () => {
  const queue = new InMemoryDeliveryQueue();
  const keyManager = new InMemoryKeyManager();

  const fetchImpl = async () => ({ status: 503 });

  queue.enqueue({
    did: "did:plc:alice",
    destination: "https://remote.example/inbox",
    activity: { type: "Create", id: "x" }
  });

  const worker = new DeliveryWorker({
    queue,
    keyManager,
    fetchImpl,
    baseUrl: "https://bridge.example",
    maxAttempts: 3
  });

  const result = await worker.drainOnce();

  assert.equal(result.status, "retry-scheduled");
  assert.equal(result.attempts, 1);
  assert.equal(result.retryInMs, 1000);
  assert.equal(queue.size(), 1);
});

test("DeliveryWorker stops retrying on permanent failures", async () => {
  const queue = new InMemoryDeliveryQueue();
  const keyManager = new InMemoryKeyManager();

  const fetchImpl = async () => ({ status: 410 });

  queue.enqueue({
    did: "did:plc:alice",
    destination: "https://remote.example/inbox",
    activity: { type: "Create", id: "x" }
  });

  const worker = new DeliveryWorker({
    queue,
    keyManager,
    fetchImpl,
    baseUrl: "https://bridge.example"
  });

  const result = await worker.drainOnce();

  assert.equal(result.status, "permanent-failure");
  assert.equal(queue.size(), 0);
});

test("computeExponentialBackoffMs grows and caps", () => {
  assert.equal(computeExponentialBackoffMs(1), 1000);
  assert.equal(computeExponentialBackoffMs(2), 2000);
  assert.equal(computeExponentialBackoffMs(3), 4000);
  assert.equal(computeExponentialBackoffMs(10), 60000);
});
