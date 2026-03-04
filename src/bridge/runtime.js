import { InMemoryKeyManager } from "../crypto/key-manager.js";
import { DeliveryWorker } from "../delivery/delivery-worker.js";
import { InMemoryJetstreamState } from "../ingest/in-memory-jetstream-state.js";
import { InMemoryDeliveryQueue, JetstreamProcessor } from "../ingest/jetstream-processor.js";
import { InMemoryBridgeStore } from "../storage/in-memory-store.js";

export class BridgeRuntime {
  #processor;
  #worker;

  constructor({ baseUrl, store = new InMemoryBridgeStore(), state = new InMemoryJetstreamState(), queue = new InMemoryDeliveryQueue(), keyManager = new InMemoryKeyManager(), fetchImpl = fetch, shardId = "default" }) {
    this.store = store;
    this.queue = queue;
    this.state = state;
    this.keyManager = keyManager;

    this.#processor = new JetstreamProcessor({
      state,
      queue,
      store,
      baseUrl,
      shardId
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

  async drainDeliveries({ max = 100 } = {}) {
    const results = [];

    for (let i = 0; i < max; i += 1) {
      const result = await this.#worker.drainOnce();
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
}
