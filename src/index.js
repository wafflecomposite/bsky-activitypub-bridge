import { createBridgeApplication } from "./app/application.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = parseInteger(process.env.PORT, 3000);
const baseUrl = process.env.BASE_URL ?? null;
const dataDir = process.env.DATA_DIR ?? null;

const app = createBridgeApplication({
  baseUrl,
  dataDir,
  strictInboxSignatures: parseBoolean(process.env.STRICT_INBOX_SIGNATURES, false),
  postVisibility: process.env.BRIDGE_POST_VISIBILITY ?? "unlisted",
  signatureMaxAgeSeconds: parseInteger(process.env.INBOX_SIGNATURE_MAX_AGE_SECONDS, 300),
  jetstream: {
    enabled: parseBoolean(process.env.ENABLE_JETSTREAM, false),
    url: process.env.JETSTREAM_URL,
    wantedCollections: parseList(process.env.JETSTREAM_WANTED_COLLECTIONS, ["app.bsky.feed.post"]),
    wantedDids: parseList(process.env.JETSTREAM_WANTED_DIDS, []),
    autoFollowedDids: parseBoolean(process.env.JETSTREAM_AUTO_FOLLOWED_DIDS, true),
    wantedDidsRefreshMs: parseInteger(process.env.JETSTREAM_WANTED_DIDS_REFRESH_MS, 30_000),
    reconnectDelayMs: parseInteger(process.env.JETSTREAM_RECONNECT_DELAY_MS, 1000),
    rewindSeconds: parseInteger(process.env.JETSTREAM_REWIND_SECONDS, 5)
  },
  delivery: {
    drainIntervalMs: parseInteger(process.env.DELIVERY_DRAIN_INTERVAL_MS, 1000),
    drainBatchSize: parseInteger(process.env.DELIVERY_DRAIN_BATCH_SIZE, 100),
    onDrainError: (error) => {
      console.error("Delivery drain error:", error instanceof Error ? error.message : String(error));
    },
    onTransportResult: (event) => {
      if (event.status === null || event.status >= 400) {
        console.warn("Delivery attempt failed", event);
      }
    }
  }
});

seedActorsFromEnv(app.store);

const address = await app.start({ host, port });

console.log(`Bridge server listening at ${address.baseUrl}`);

process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await app.stop();
  process.exit(0);
});

function seedActorsFromEnv(store) {
  const seed = process.env.SEED_ACTORS;
  if (!seed) {
    return;
  }

  for (const entry of seed.split(",")) {
    const [did, handle] = entry.split("=");
    if (!did || !handle) {
      continue;
    }

    store.upsertActor({ did: did.trim(), handle: handle.trim() });
  }
}

function parseList(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return parsed.length > 0 ? parsed : fallback;
}

function parseBoolean(value, fallback) {
  if (!value) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function parseInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}
