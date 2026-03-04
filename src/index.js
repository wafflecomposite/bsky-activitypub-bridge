import { createBridgeServer } from "./server.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = process.env.PORT ? Number.parseInt(process.env.PORT, 10) : 3000;
const baseUrl = process.env.BASE_URL ?? null;

const bridge = createBridgeServer({ baseUrl });

seedActorsFromEnv(bridge.store);

const address = await bridge.start({ host, port });

console.log(`Bridge server listening at ${address.baseUrl}`);

process.on("SIGINT", async () => {
  await bridge.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await bridge.stop();
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
