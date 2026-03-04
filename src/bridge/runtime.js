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

  constructor({ baseUrl, store = new InMemoryBridgeStore(), state = new InMemoryJetstreamState(), queue = new InMemoryDeliveryQueue(), keyManager = new InMemoryKeyManager(), fetchImpl = fetch, shardId = "default", onTransportAttempt = null, onTransportResult = null }) {
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
      shardId: this.shardId
    });

    this.#worker = new DeliveryWorker({
      queue,
      keyManager,
      fetchImpl,
      baseUrl,
      onTransportAttempt,
      onTransportResult
    });
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
      if (result.status === "deferred") {
        break;
      }
    }

    return results;
  }

  startJetstream({ wantedDids = [], wantedDidsProvider = null, wantedDidsRefreshMs = 0, wantedCollections = ["app.bsky.feed.post"], jetstreamUrl, reconnectDelayMs = 1000, rewindSeconds = 5, WebSocketImpl = WebSocket, timers = globalThis } = {}) {
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
}

function normalizeWantedDids(wantedDids) {
  if (!Array.isArray(wantedDids)) {
    return [];
  }

  return [...new Set(wantedDids.filter((did) => typeof did === "string" && did.trim()).map((did) => did.trim()))].sort();
}
