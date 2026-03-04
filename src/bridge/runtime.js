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

  constructor({ baseUrl, store = new InMemoryBridgeStore(), state = new InMemoryJetstreamState(), queue = new InMemoryDeliveryQueue(), keyManager = new InMemoryKeyManager(), fetchImpl = fetch, shardId = "default" }) {
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
      baseUrl
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

  startJetstream({ wantedDids = [], wantedCollections = ["app.bsky.feed.post"], jetstreamUrl, reconnectDelayMs = 1000, rewindSeconds = 5, WebSocketImpl = WebSocket, timers = globalThis } = {}) {
    if (this.#jetstreamClient) {
      this.#jetstreamClient.stop();
    }

    this.#jetstreamClient = new JetstreamClient({
      processor: {
        process: (event) => this.ingestJetstreamEvent(event)
      },
      state: this.state,
      shardId: this.shardId,
      wantedDids,
      wantedCollections,
      jetstreamUrl,
      reconnectDelayMs,
      rewindSeconds,
      WebSocketImpl,
      timers
    });

    this.#jetstreamClient.start();
  }

  stopJetstream() {
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
