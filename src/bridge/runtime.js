import { InMemoryKeyManager } from "../crypto/key-manager.js";
import { DeliveryWorker } from "../delivery/delivery-worker.js";
import { JetstreamClient } from "../ingest/jetstream-client.js";
import { InMemoryJetstreamState } from "../ingest/in-memory-jetstream-state.js";
import { InMemoryDeliveryQueue, JetstreamProcessor } from "../ingest/jetstream-processor.js";
import { InMemoryBridgeStore } from "../storage/in-memory-store.js";

export class BridgeRuntime {
  #processor;
  #worker;
  #jetstreamClient = null;
  #jetstreamDidRefreshTimer = null;
  #metrics;

  constructor({ baseUrl, store = new InMemoryBridgeStore(), state = new InMemoryJetstreamState(), queue = new InMemoryDeliveryQueue(), keyManager = new InMemoryKeyManager(), fetchImpl = fetch, shardId = "default", postVisibility = "unlisted", onTransportAttempt = null, onTransportResult = null, messageSignaturesEnabled = false }) {
    this.store = store;
    this.queue = queue;
    this.state = state;
    this.keyManager = keyManager;
    this.shardId = shardId;

    this.#processor = new JetstreamProcessor({
      state,
      queue,
      store,
      baseUrl,
      shardId: this.shardId,
      postVisibility
    });

    this.#worker = new DeliveryWorker({
      queue,
      keyManager,
      fetchImpl,
      baseUrl,
      onTransportAttempt,
      onTransportResult,
      messageSignaturesEnabled
    });

    this.#metrics = {
      delivered: 0,
      retryScheduled: 0,
      permanentFailure: 0,
      deferred: 0,
      failed: 0,
      lastResult: null
    };
  }

  ingestJetstreamEvent(event) {
    return this.#processor.process(event);
  }

  async drainDeliveries({ max = 100, now = Date.now() } = {}) {
    const results = [];

    for (let i = 0; i < max; i += 1) {
      const result = await this.#worker.drainOnce({ now });
      if (result.status === "empty") {
        break;
      }

      results.push(result);
      this.#recordDeliveryResult(result);
      if (result.status === "deferred") {
        break;
      }
    }

    return results;
  }

  startJetstream({
    wantedDids = [],
    wantedDidsProvider = null,
    wantedDidsRefreshMs = 0,
    wantedCollections = ["app.bsky.feed.post"],
    allowUnfiltered = false,
    jetstreamUrl,
    reconnectDelayMs = 1000,
    rewindSeconds = 5,
    WebSocketImpl = WebSocket,
    timers = globalThis
  } = {}) {
    if (this.#jetstreamClient) {
      this.#jetstreamClient.stop();
    }

    if (this.#jetstreamDidRefreshTimer) {
      timers.clearInterval(this.#jetstreamDidRefreshTimer);
      this.#jetstreamDidRefreshTimer = null;
    }

    const initialWantedDids = wantedDidsProvider
      ? normalizeWantedDids(wantedDidsProvider())
      : normalizeWantedDids(wantedDids);

    this.#jetstreamClient = new JetstreamClient({
      processor: {
        process: (event) => this.ingestJetstreamEvent(event)
      },
      state: this.state,
      shardId: this.shardId,
      wantedDids: initialWantedDids,
      requireWantedDids: !allowUnfiltered,
      wantedCollections,
      jetstreamUrl,
      reconnectDelayMs,
      rewindSeconds,
      WebSocketImpl,
      timers
    });

    this.#jetstreamClient.start();

    if (wantedDidsProvider && wantedDidsRefreshMs > 0 && typeof timers.setInterval === "function") {
      this.#jetstreamDidRefreshTimer = timers.setInterval(() => {
        try {
          this.updateJetstreamWantedDids(normalizeWantedDids(wantedDidsProvider()));
        } catch {
          // Ignore provider failures so the existing stream remains active.
        }
      }, wantedDidsRefreshMs);
    }
  }

  stopJetstream({ timers = globalThis } = {}) {
    if (this.#jetstreamDidRefreshTimer) {
      timers.clearInterval(this.#jetstreamDidRefreshTimer);
      this.#jetstreamDidRefreshTimer = null;
    }

    if (!this.#jetstreamClient) {
      return;
    }

    this.#jetstreamClient.stop();
    this.#jetstreamClient = null;
  }

  updateJetstreamWantedDids(wantedDids) {
    if (!this.#jetstreamClient) {
      return;
    }

    this.#jetstreamClient.setWantedDids(wantedDids);
  }

  getMetrics() {
    return {
      queueDepth: typeof this.queue?.size === "function" ? this.queue.size() : null,
      delivery: {
        delivered: this.#metrics.delivered,
        retryScheduled: this.#metrics.retryScheduled,
        permanentFailure: this.#metrics.permanentFailure,
        deferred: this.#metrics.deferred,
        failed: this.#metrics.failed,
        lastResult: this.#metrics.lastResult
      },
      jetstream: {
        running: this.#jetstreamClient !== null,
        wantedDidCount: this.#jetstreamClient?.getWantedDidCount?.() ?? 0
      }
    };
  }

  #recordDeliveryResult(result) {
    if (!result || typeof result !== "object") {
      return;
    }

    if (result.status === "delivered") {
      this.#metrics.delivered += 1;
    } else if (result.status === "retry-scheduled") {
      this.#metrics.retryScheduled += 1;
    } else if (result.status === "permanent-failure") {
      this.#metrics.permanentFailure += 1;
    } else if (result.status === "deferred") {
      this.#metrics.deferred += 1;
    } else if (result.status === "failed") {
      this.#metrics.failed += 1;
    }

    this.#metrics.lastResult = {
      status: result.status ?? "unknown",
      destination: result.destination ?? null,
      at: new Date().toISOString()
    };
  }
}

function normalizeWantedDids(wantedDids) {
  if (!Array.isArray(wantedDids)) {
    return [];
  }

  return [...new Set(wantedDids.filter((did) => typeof did === "string" && did.trim()).map((did) => did.trim()))].sort();
}
