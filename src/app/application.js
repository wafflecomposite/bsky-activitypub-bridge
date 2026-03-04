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
  signatureMaxAgeSeconds = 300,
  fetchImpl = fetch,
  shardId = "default",
  timers = globalThis,
  jetstream = {},
  delivery = {},
  createServer = createBridgeServer
} = {}) {
  const resolvedStore = store ?? (dataDir
    ? new FileBridgeStore({ filePath: join(dataDir, "store.json") })
    : new InMemoryBridgeStore());

  const resolvedState = state ?? (dataDir
    ? new FileJetstreamState({ filePath: join(dataDir, "state.json") })
    : new InMemoryJetstreamState());

  const resolvedQueue = queue ?? (dataDir
    ? new FileDeliveryQueue({ filePath: join(dataDir, "queue.json") })
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
    deliveryQueue: resolvedQueue,
    actorCache: resolvedActorCache,
    inboxSignatureVerifier
  });

  let runtime = null;
  let deliveryInterval = null;

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
      onTransportResult: delivery.onTransportResult ?? null
    });

    if (jetstream.enabled) {
      runtime.startJetstream({
        wantedDids: jetstream.wantedDids ?? [],
        wantedDidsProvider: jetstream.autoFollowedDids
          ? () => resolvedStore.listFollowedDids?.() ?? []
          : null,
        wantedDidsRefreshMs: jetstream.wantedDidsRefreshMs ?? 30_000,
        wantedCollections: jetstream.wantedCollections ?? ["app.bsky.feed.post"],
        jetstreamUrl: jetstream.url,
        reconnectDelayMs: jetstream.reconnectDelayMs ?? 1000,
        rewindSeconds: jetstream.rewindSeconds ?? 5,
        WebSocketImpl: jetstream.WebSocketImpl ?? WebSocket,
        timers
      });
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

    if (runtime) {
      runtime.stopJetstream({ timers });
      runtime = null;
    }

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
