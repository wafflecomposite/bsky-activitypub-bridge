import { InMemoryKeyManager } from "../crypto/key-manager.js";
import { DeliveryWorker } from "../delivery/delivery-worker.js";
import { JetstreamClient } from "../ingest/jetstream-client.js";
import { InMemoryJetstreamState } from "../ingest/in-memory-jetstream-state.js";
import { InMemoryDeliveryQueue, JetstreamProcessor } from "../ingest/jetstream-processor.js";
import { InMemoryBridgeStore } from "../storage/in-memory-store.js";

export class BridgeRuntime {
  #processor;
  #worker;
  #jetstreamClients = new Map();
  #jetstreamDidRefreshTimer = null;
  #jetstreamOptions = null;
  #jetstreamTimers = globalThis;
  #baseUrl;
  #postVisibility;
  #metrics;

  constructor({ baseUrl, store = new InMemoryBridgeStore(), state = new InMemoryJetstreamState(), queue = new InMemoryDeliveryQueue(), keyManager = new InMemoryKeyManager(), fetchImpl = fetch, shardId = "default", postVisibility = "unlisted", onTransportAttempt = null, onTransportResult = null, messageSignaturesEnabled = false }) {
    this.store = store;
    this.queue = queue;
    this.state = state;
    this.keyManager = keyManager;
    this.shardId = shardId;
    this.#baseUrl = baseUrl;
    this.#postVisibility = postVisibility;

    this.#processor = new JetstreamProcessor({
      state,
      queue,
      store,
      keyManager,
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
    wantedCollections = ["app.bsky.feed.post", "app.bsky.feed.repost", "app.bsky.actor.profile"],
    allowUnfiltered = false,
    jetstreamUrl,
    reconnectDelayMs = 1000,
    rewindSeconds = 5,
    maxDidsPerStream = 8000,
    WebSocketImpl = WebSocket,
    timers = globalThis
  } = {}) {
    this.stopJetstream({ timers: this.#jetstreamTimers ?? timers });
    this.#jetstreamTimers = timers;
    this.#jetstreamOptions = {
      wantedCollections,
      requireWantedDids: !allowUnfiltered,
      jetstreamUrl,
      reconnectDelayMs,
      rewindSeconds,
      maxDidsPerStream: normalizeMaxDidsPerStream(maxDidsPerStream),
      WebSocketImpl,
      timers
    };

    const initialWantedDids = wantedDidsProvider
      ? normalizeWantedDids(wantedDidsProvider())
      : normalizeWantedDids(wantedDids);

    this.#syncJetstreamClients(initialWantedDids);

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
    const activeTimers = this.#jetstreamTimers ?? timers;
    if (this.#jetstreamDidRefreshTimer) {
      activeTimers.clearInterval(this.#jetstreamDidRefreshTimer);
      this.#jetstreamDidRefreshTimer = null;
    }

    for (const client of this.#jetstreamClients.values()) {
      client.stop();
    }

    this.#jetstreamClients.clear();
    this.#jetstreamOptions = null;
  }

  updateJetstreamWantedDids(wantedDids) {
    if (!this.#jetstreamOptions) {
      return;
    }

    this.#syncJetstreamClients(normalizeWantedDids(wantedDids));
  }

  getMetrics() {
    const jetstreamShards = Array.from(this.#jetstreamClients.entries())
      .map(([shardId, client]) => ({
        shardId,
        wantedDidCount: client.getWantedDidCount?.() ?? 0,
        connectionUrl: client.getCurrentConnectionUrl?.() ?? null
      }));

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
        running: this.#jetstreamClients.size > 0,
        wantedDidCount: jetstreamShards.reduce((sum, shard) => sum + shard.wantedDidCount, 0),
        shardCount: this.#jetstreamClients.size,
        maxDidsPerStream: this.#jetstreamOptions?.maxDidsPerStream ?? null,
        shards: jetstreamShards
      }
    };
  }

  #syncJetstreamClients(wantedDids) {
    if (!this.#jetstreamOptions) {
      return;
    }

    const shardSpecs = planJetstreamShards({
      baseShardId: this.shardId,
      wantedDids,
      maxDidsPerStream: this.#jetstreamOptions.maxDidsPerStream,
      requireWantedDids: this.#jetstreamOptions.requireWantedDids
    });
    const wantedShardIds = new Set(shardSpecs.map((shard) => shard.shardId));

    for (const [shardId, client] of this.#jetstreamClients.entries()) {
      if (!wantedShardIds.has(shardId)) {
        client.stop();
        this.#jetstreamClients.delete(shardId);
      }
    }

    for (const shard of shardSpecs) {
      const existing = this.#jetstreamClients.get(shard.shardId);
      if (existing) {
        existing.setWantedDids(shard.wantedDids);
        continue;
      }

      const processor = new JetstreamProcessor({
        state: this.state,
        queue: this.queue,
        store: this.store,
        keyManager: this.keyManager,
        baseUrl: this.#baseUrl,
        shardId: shard.shardId,
        postVisibility: this.#postVisibility
      });
      const client = new JetstreamClient({
        processor: {
          process: (event) => processor.process(event)
        },
        state: this.state,
        shardId: shard.shardId,
        wantedDids: shard.wantedDids,
        requireWantedDids: this.#jetstreamOptions.requireWantedDids,
        wantedCollections: this.#jetstreamOptions.wantedCollections,
        jetstreamUrl: this.#jetstreamOptions.jetstreamUrl,
        reconnectDelayMs: this.#jetstreamOptions.reconnectDelayMs,
        rewindSeconds: this.#jetstreamOptions.rewindSeconds,
        WebSocketImpl: this.#jetstreamOptions.WebSocketImpl,
        timers: this.#jetstreamOptions.timers
      });

      this.#jetstreamClients.set(shard.shardId, client);
      client.start();
    }
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

export function planJetstreamShards({
  baseShardId = "default",
  wantedDids = [],
  maxDidsPerStream = 8000,
  requireWantedDids = true
} = {}) {
  const normalized = normalizeWantedDids(wantedDids);
  const cap = normalizeMaxDidsPerStream(maxDidsPerStream);

  if (normalized.length === 0) {
    return requireWantedDids
      ? []
      : [{ shardId: baseShardId, wantedDids: [] }];
  }

  const shards = [];
  for (let offset = 0; offset < normalized.length; offset += cap) {
    const index = shards.length;
    shards.push({
      shardId: index === 0 ? baseShardId : `${baseShardId}:${index}`,
      wantedDids: normalized.slice(offset, offset + cap)
    });
  }

  return shards;
}

function normalizeWantedDids(wantedDids) {
  if (!Array.isArray(wantedDids)) {
    return [];
  }

  return [...new Set(wantedDids.filter((did) => typeof did === "string" && did.trim()).map((did) => did.trim()))].sort();
}

function normalizeMaxDidsPerStream(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(1, Math.trunc(value));
  }

  return 8000;
}
