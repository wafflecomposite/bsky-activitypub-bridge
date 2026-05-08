import { join } from "node:path";
import { RemoteActorCache } from "../ap/remote-actor-cache.js";
import { BridgeRuntime } from "../bridge/runtime.js";
import { FileKeyManager } from "../crypto/file-key-manager.js";
import { InMemoryKeyManager } from "../crypto/key-manager.js";
import { FileDeliveryQueue } from "../delivery/file-delivery-queue.js";
import { verifyInboxRequestSignature } from "../federation/inbox-signature-verifier.js";
import { FileJetstreamState } from "../ingest/file-jetstream-state.js";
import { InMemoryJetstreamState } from "../ingest/in-memory-jetstream-state.js";
import { InMemoryDeliveryQueue } from "../ingest/jetstream-processor.js";
import { createBridgeServer } from "../server.js";
import { FileBridgeStore } from "../storage/file-bridge-store.js";
import { InMemoryBridgeStore } from "../storage/in-memory-store.js";

export function createBridgeApplication({
  baseUrl = null,
  dataDir = null,
  store = null,
  state = null,
  queue = null,
  keyManager = null,
  actorCache = null,
  strictInboxSignatures = false,
  postVisibility = "unlisted",
  profileCacheMaxAgeMs = 60_000,
  signatureMaxAgeSeconds = 300,
  fetchImpl = fetch,
  shardId = "default",
  timers = globalThis,
  jetstream = {},
  delivery = {},
  cache = {},
  createServer = createBridgeServer,
  followLogger = null
} = {}) {
  const resolvedStore = store ?? (dataDir
    ? new FileBridgeStore({
      filePath: join(dataDir, "store.json"),
      persistMode: "async",
      objectCacheTtlMs: cache.objectCacheTtlMs,
      tombstoneCacheTtlMs: cache.tombstoneCacheTtlMs,
      objectCacheMaxRecords: cache.objectCacheMaxRecords,
      profileCacheTtlMs: cache.profileCacheTtlMs
    })
    : new InMemoryBridgeStore({
      objectCacheTtlMs: cache.objectCacheTtlMs,
      tombstoneCacheTtlMs: cache.tombstoneCacheTtlMs,
      objectCacheMaxRecords: cache.objectCacheMaxRecords,
      profileCacheTtlMs: cache.profileCacheTtlMs
    }));

  const resolvedState = state ?? (dataDir
    ? new FileJetstreamState({
      filePath: join(dataDir, "state.json"),
      persistMode: "async"
    })
    : new InMemoryJetstreamState());

  const resolvedQueue = queue ?? (dataDir
    ? new FileDeliveryQueue({
      filePath: join(dataDir, "queue.json"),
      persistMode: "async"
    })
    : new InMemoryDeliveryQueue());

  const resolvedKeyManager = keyManager ?? (dataDir
    ? new FileKeyManager({ filePath: join(dataDir, "keys.json") })
    : new InMemoryKeyManager());
  const resolvedActorCache = actorCache ?? new RemoteActorCache();

  const inboxSignatureVerifier = strictInboxSignatures
    ? ({ method, requestTarget, headers, body }) => verifyInboxRequestSignature({
      method,
      requestTarget,
      headers,
      body,
      fetchImpl,
      maxAgeSeconds: signatureMaxAgeSeconds
    })
    : null;

  const server = createServer({
    baseUrl,
    store: resolvedStore,
    keyManager: resolvedKeyManager,
    fetchImpl,
    profileCacheMaxAgeMs,
    deliveryQueue: resolvedQueue,
    actorCache: resolvedActorCache,
    inboxSignatureVerifier,
    followLogger
  });

  let runtime = null;
  let deliveryInterval = null;
  let cachePruneInterval = null;

  async function start({ host = "127.0.0.1", port = 3000 } = {}) {
    const address = await server.start({ host, port });

    runtime = new BridgeRuntime({
      baseUrl: address.baseUrl,
      store: resolvedStore,
      state: resolvedState,
      queue: resolvedQueue,
      keyManager: resolvedKeyManager,
      fetchImpl,
      shardId,
      postVisibility,
      onTransportAttempt: delivery.onTransportAttempt ?? null,
      onTransportResult: wrapTransportResultLogger({
        onTransportResult: delivery.onTransportResult ?? null,
        followLogger
      }),
      messageSignaturesEnabled: delivery.messageSignaturesEnabled ?? false
    });

    if (jetstream.enabled) {
      runtime.startJetstream({
        wantedDids: jetstream.wantedDids ?? [],
        wantedDidsProvider: jetstream.autoFollowedDids
          ? () => resolvedStore.listFollowedDids?.() ?? []
          : null,
        wantedDidsRefreshMs: jetstream.wantedDidsRefreshMs ?? 30_000,
        wantedCollections: jetstream.wantedCollections ?? ["app.bsky.feed.post", "app.bsky.feed.repost", "app.bsky.actor.profile"],
        allowUnfiltered: jetstream.allowUnfiltered ?? false,
        jetstreamUrl: jetstream.url,
        reconnectDelayMs: jetstream.reconnectDelayMs ?? 1000,
        rewindSeconds: jetstream.rewindSeconds ?? 5,
        maxDidsPerStream: jetstream.maxDidsPerStream ?? 8000,
        WebSocketImpl: jetstream.WebSocketImpl ?? WebSocket,
        timers
      });
    }

    if (typeof resolvedStore.pruneCache === "function") {
      resolvedStore.pruneCache();
    }

    const pruneIntervalMs = cache.pruneIntervalMs ?? 5 * 60 * 1000;
    if (pruneIntervalMs > 0 && typeof timers.setInterval === "function" && typeof resolvedStore.pruneCache === "function") {
      cachePruneInterval = timers.setInterval(() => {
        try {
          resolvedStore.pruneCache();
        } catch {
          // Best effort cache cleanup.
        }
      }, pruneIntervalMs);
    }

    const drainIntervalMs = delivery.drainIntervalMs ?? 1000;
    if (drainIntervalMs > 0 && typeof timers.setInterval === "function") {
      deliveryInterval = timers.setInterval(() => {
        runtime.drainDeliveries({ max: delivery.drainBatchSize ?? 100 }).catch((error) => {
          if (delivery.onDrainError) {
            delivery.onDrainError(error);
          }
        });
      }, drainIntervalMs);
    }

    return address;
  }

  async function stop() {
    if (deliveryInterval) {
      timers.clearInterval(deliveryInterval);
      deliveryInterval = null;
    }

    if (cachePruneInterval) {
      timers.clearInterval(cachePruneInterval);
      cachePruneInterval = null;
    }

    if (runtime) {
      runtime.stopJetstream({ timers });
      runtime = null;
    }

    await flushIfSupported(resolvedQueue);
    await flushIfSupported(resolvedState);
    await flushIfSupported(resolvedStore);

    await server.stop();
  }

  return {
    start,
    stop,
    getRuntime: () => runtime,
    getMetrics: () => (runtime
      ? runtime.getMetrics()
      : {
          queueDepth: typeof resolvedQueue?.size === "function" ? resolvedQueue.size() : null,
          delivery: {
            delivered: 0,
            retryScheduled: 0,
            permanentFailure: 0,
            deferred: 0,
            failed: 0,
            lastResult: null
          },
          jetstream: {
            running: false
          }
        }),
    store: resolvedStore,
    state: resolvedState,
    queue: resolvedQueue,
    keyManager: resolvedKeyManager,
    actorCache: resolvedActorCache,
    server,
    inboxSignatureVerifier
  };
}

function wrapTransportResultLogger({ onTransportResult, followLogger }) {
  if (!onTransportResult && typeof followLogger !== "function") {
    return null;
  }

  return (event) => {
    if (event?.metadata?.operation === "follow-accept") {
      logFollowDeliveryResult(followLogger, event);
    }

    if (onTransportResult) {
      onTransportResult(event);
    }
  };
}

function logFollowDeliveryResult(followLogger, event) {
  if (typeof followLogger !== "function") {
    return;
  }

  try {
    followLogger({
      at: new Date().toISOString(),
      event: "follow.accept.delivery",
      did: event.metadata?.did ?? null,
      destination: event.destination ?? null,
      status: event.status ?? null,
      durationMs: event.durationMs ?? null,
      attempt: event.metadata?.attempt ?? null,
      ok: typeof event.status === "number" && event.status >= 200 && event.status < 300,
      error: event.error ?? null,
      responseBody: event.responseBody ?? null
    });
  } catch {
    // Diagnostics must never affect delivery.
  }
}

async function flushIfSupported(component) {
  if (!component || typeof component.flush !== "function") {
    return;
  }

  try {
    await component.flush();
  } catch {
    // Best effort during shutdown.
  }
}
