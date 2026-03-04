import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createBridgeApplication } from "../app/application.js";

const DEFAULT_DID = "did:plc:ct7l6fgjtseazmaunhzrbydz";

export async function runLiveE2EHarness({
  credentials = null,
  credentialsFile = "test_credentials.json",
  credentialsMarkdownFile = "test_credentials.md",
  cloudflaredPath = "./tools/bin/cloudflared",
  cleanup = false,
  workDir = null,
  log = () => {}
} = {}) {
  const resolvedCredentials = credentials ?? loadLiveE2ECredentials({
    credentialsFile,
    credentialsMarkdownFile
  });

  const tempDir = workDir ?? mkdtempSync(join(tmpdir(), "bridge-live-e2e-"));
  const port = await getFreePort();

  let tunnel = null;
  let app = null;

  try {
    tunnel = await startQuickTunnel({
      cloudflaredPath,
      port,
      log
    });

    const tunnelUrl = tunnel.url;
    const did = await resolveDidFromHandle(resolvedCredentials.blueskyIdentifier);

    app = createBridgeApplication({
      baseUrl: tunnelUrl,
      dataDir: tempDir,
      strictInboxSignatures: false,
      postVisibility: "unlisted",
      jetstream: {
        enabled: false
      },
      delivery: {
        drainIntervalMs: 500,
        drainBatchSize: 100,
        onTransportResult: (event) => {
          if (event.status === null || event.status >= 400) {
            log(`delivery-failure destination=${event.destination} status=${event.status} body=${event.responseBody ?? ""}`);
          }
        }
      }
    });

    app.store.upsertActor({ did, handle: resolvedCredentials.blueskyIdentifier });
    app.keyManager.ensureKeyPair(did);
    await app.start({ host: "127.0.0.1", port });

    await waitForBridgeReady({ port, did, timeoutMs: 90_000 });

    const remoteAcct = `${resolvedCredentials.blueskyIdentifier}@${new URL(tunnelUrl).host}`;
    const discovered = await discoverRemoteAccountWithRetry({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      remoteAcct,
      timeoutMs: 180_000,
      log
    });

    const followState = await followAndWait({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      accountId: discovered.id,
      timeoutMs: 180_000,
      log
    });

    await app.stop();
    app = null;

    app = createBridgeApplication({
      baseUrl: tunnelUrl,
      dataDir: tempDir,
      strictInboxSignatures: false,
      postVisibility: "unlisted",
      jetstream: {
        enabled: true,
        autoFollowedDids: false,
        wantedDids: [did],
        wantedDidsRefreshMs: 0
      },
      delivery: {
        drainIntervalMs: 500,
        drainBatchSize: 100,
        onTransportResult: (event) => {
          if (event.status === null || event.status >= 400) {
            log(`delivery-failure destination=${event.destination} status=${event.status} body=${event.responseBody ?? ""}`);
          }
        }
      }
    });

    app.store.upsertActor({ did, handle: resolvedCredentials.blueskyIdentifier });
    await app.start({ host: "127.0.0.1", port });

    const posted = await createBlueskyPost({
      identifier: resolvedCredentials.blueskyIdentifier,
      appPassword: resolvedCredentials.blueskyAppPassword,
      textPrefix: "Bridge automated live e2e"
    });

    const timelineMatch = await waitForTimelinePost({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      marker: posted.marker,
      timeoutMs: 180_000,
      log
    });

    const summary = {
      ok: followState.following === true && timelineMatch.found === true,
      tunnelUrl,
      dataDir: tempDir,
      remoteAcct,
      did,
      discovered,
      followState,
      posted,
      timelineMatch
    };

    return summary;
  } finally {
    await safeStopApp(app);
    await safeStopTunnel(tunnel);

    if (!workDir && cleanup) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export function loadLiveE2ECredentials({
  credentialsFile = "test_credentials.json",
  credentialsMarkdownFile = "test_credentials.md",
  env = process.env
} = {}) {
  const jsonCredentials = credentialsFile ? readJsonSafe(credentialsFile) : null;
  const fileText = credentialsMarkdownFile ? readFileSafe(credentialsMarkdownFile) : null;

  const gtsInstanceUrl = env.GTS_INSTANCE_URL
    ?? pickFirstString([
      jsonCredentials?.gtsInstanceUrl,
      jsonCredentials?.gts?.instanceUrl
    ])
    ?? extractLabeledValue(fileText, "Instance URL");
  const gtsAccessToken = env.GTS_ACCESS_TOKEN
    ?? pickFirstString([
      jsonCredentials?.gtsAccessToken,
      jsonCredentials?.gts?.accessToken
    ])
    ?? extractLabeledValue(fileText, "Access Token");
  const blueskyIdentifier = env.BLUESKY_IDENTIFIER
    ?? pickFirstString([
      jsonCredentials?.blueskyIdentifier,
      jsonCredentials?.bluesky?.identifier
    ])
    ?? extractLabeledValue(fileText, "User");
  const blueskyAppPassword = env.BLUESKY_APP_PASSWORD
    ?? pickFirstString([
      jsonCredentials?.blueskyAppPassword,
      jsonCredentials?.bluesky?.appPassword
    ])
    ?? extractLabeledValue(fileText, "App password");

  const missing = [];
  if (!gtsInstanceUrl) {
    missing.push("GTS_INSTANCE_URL or 'Instance URL' in credentials file");
  }
  if (!gtsAccessToken) {
    missing.push("GTS_ACCESS_TOKEN or 'Access Token' in credentials file");
  }
  if (!blueskyIdentifier) {
    missing.push("BLUESKY_IDENTIFIER or 'User' in credentials file");
  }
  if (!blueskyAppPassword) {
    missing.push("BLUESKY_APP_PASSWORD or 'App password' in credentials file");
  }

  if (missing.length > 0) {
    throw new Error(`Missing live E2E credentials: ${missing.join(", ")}`);
  }

  return {
    gtsInstanceUrl,
    gtsAccessToken,
    blueskyIdentifier,
    blueskyAppPassword
  };
}

export function extractTunnelUrlFromLine(line) {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
  return match ? match[0] : null;
}

async function startQuickTunnel({ cloudflaredPath, port, log }) {
  const args = ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
  const child = spawn(cloudflaredPath, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  let url = null;
  const lines = [];

  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }

      lines.push(line);
      const parsed = extractTunnelUrlFromLine(line);
      if (parsed && !url) {
        url = parsed;
      }
    }
  };

  child.stdout.on("data", onData);
  child.stderr.on("data", onData);

  await waitForCondition(() => url !== null, 45_000, 250);

  log(`tunnel-url=${url}`);

  return { child, url, lines };
}

async function safeStopTunnel(tunnel) {
  if (!tunnel?.child || tunnel.child.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      tunnel.child.kill("SIGKILL");
    }, 2_000);

    tunnel.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    tunnel.child.kill("SIGINT");
  });
}

async function safeStopApp(app) {
  if (!app) {
    return;
  }

  try {
    await app.stop();
  } catch {
    // best effort
  }
}

async function resolveDidFromHandle(handle) {
  const response = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
  if (!response.ok) {
    throw new Error(`Failed to resolve Bluesky handle: ${handle} (${response.status})`);
  }

  const body = await response.json();
  return body.did ?? DEFAULT_DID;
}

async function waitForBridgeReady({ port, did, timeoutMs }) {
  const actorUrl = `http://127.0.0.1:${port}/ap/actor/${encodeURIComponent(did)}`;

  await waitForCondition(async () => {
    const response = await fetch(actorUrl);
    return response.ok;
  }, timeoutMs, 1_000);
}

async function discoverRemoteAccountWithRetry({ instanceUrl, accessToken, remoteAcct, timeoutMs, log }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const path = `/api/v2/search?q=${encodeURIComponent(remoteAcct)}&resolve=true&limit=40&type=accounts&offset=0`;
      const body = await gtsApi({ instanceUrl, accessToken, path, timeoutMs: 30_000 });
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];
      const match = accounts.find((account) => account.acct === remoteAcct) ?? accounts[0] ?? null;

      if (match?.id) {
        return {
          id: match.id,
          acct: match.acct,
          url: match.url
        };
      }
    } catch (error) {
      log(`discover-retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  throw new Error(`Unable to discover remote account within timeout: ${remoteAcct}`);
}

async function followAndWait({ instanceUrl, accessToken, accountId, timeoutMs, log }) {
  await gtsApi({
    instanceUrl,
    accessToken,
    path: `/api/v1/accounts/${encodeURIComponent(accountId)}/follow`,
    method: "POST",
    timeoutMs: 30_000
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const rel = await gtsApi({
        instanceUrl,
        accessToken,
        path: `/api/v1/accounts/relationships?id[]=${encodeURIComponent(accountId)}`,
        timeoutMs: 30_000
      });

      const state = Array.isArray(rel) ? rel[0] : rel?.[0];
      if (state?.following === true) {
        return {
          following: true,
          requested: state.requested ?? false
        };
      }

      if (state?.requested === true) {
        log("follow still requested; waiting...");
      }
    } catch (error) {
      log(`follow-state retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  throw new Error("Follow did not reach following=true before timeout");
}

async function createBlueskyPost({ identifier, appPassword, textPrefix }) {
  const marker = `${textPrefix} ${new Date().toISOString()}`;
  const nowIso = new Date().toISOString();

  const sessionResponse = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      identifier,
      password: appPassword
    })
  });

  if (!sessionResponse.ok) {
    throw new Error(`Bluesky session failed: ${sessionResponse.status}`);
  }

  const session = await sessionResponse.json();

  const createResponse = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text: marker,
        createdAt: nowIso
      }
    })
  });

  if (!createResponse.ok) {
    throw new Error(`Bluesky post failed: ${createResponse.status}`);
  }

  const created = await createResponse.json();

  return {
    marker,
    uri: created.uri,
    cid: created.cid
  };
}

async function waitForTimelinePost({ instanceUrl, accessToken, marker, timeoutMs, log }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const statuses = await gtsApi({
        instanceUrl,
        accessToken,
        path: "/api/v1/timelines/home?limit=40",
        timeoutMs: 30_000
      });

      const found = Array.isArray(statuses) && statuses.some((status) => {
        const content = typeof status?.content === "string" ? status.content : "";
        const text = typeof status?.text === "string" ? status.text : "";
        return content.includes(marker) || text.includes(marker);
      });

      if (found) {
        return { found: true };
      }
    } catch (error) {
      log(`timeline retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(3_000);
  }

  return { found: false };
}

async function gtsApi({ instanceUrl, accessToken, path, method = "GET", timeoutMs = 30_000, body = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = buildGtsRequest({ accessToken, method, body });

  try {
    const response = await fetch(`${stripTrailingSlash(instanceUrl)}${path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`GTS API ${path} failed: ${response.status} ${errorBody}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function buildGtsRequest({ accessToken, method = "GET", body = null }) {
  const headers = {
    authorization: `Bearer ${accessToken}`
  };

  if (body !== null && body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : null
  };
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

async function waitForCondition(check, timeoutMs, intervalMs) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  if (lastError) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Condition timeout after ${timeoutMs}ms (last error: ${reason})`);
  }

  throw new Error(`Condition timeout after ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!address || typeof address === "string") {
          reject(new Error("Unable to determine free port"));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pickFirstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractLabeledValue(text, label) {
  if (!text) {
    return null;
  }

  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}:\\s*(.+)$`, "im");
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}
