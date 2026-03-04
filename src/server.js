import http from "node:http";
import { URL } from "node:url";
import { buildActorDocument } from "./ap/actor.js";
import { processInboxActivity } from "./ap/follow.js";
import { resolveWebFingerResource } from "./ap/webfinger.js";
import { InMemoryKeyManager } from "./crypto/key-manager.js";
import { decodeDidFromPath } from "./domain/identifiers.js";
import { InMemoryBridgeStore } from "./storage/in-memory-store.js";

export function createBridgeServer({ baseUrl = null, store = new InMemoryBridgeStore(), keyManager = new InMemoryKeyManager() } = {}) {
  let publicBaseUrl = baseUrl;

  const server = http.createServer(async (req, res) => {
    const bodyText = await readRawBody(req);

    try {
      const response = await dispatchBridgeRequest({
        method: req.method,
        rawUrl: req.url,
        headers: req.headers,
        bodyText,
        store,
        keyManager,
        baseUrl: publicBaseUrl
      });

      sendJsonResponse(res, response);
    } catch (error) {
      sendJsonResponse(res, {
        status: 500,
        contentType: "application/json",
        body: {
          error: "Internal server error",
          detail: error instanceof Error ? error.message : String(error)
        }
      });
    }
  });

  async function start({ port = 0, host = "127.0.0.1" } = {}) {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, resolve);
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine server address");
    }

    if (!publicBaseUrl) {
      publicBaseUrl = `http://${host}:${address.port}`;
    }

    return {
      host,
      port: address.port,
      baseUrl: publicBaseUrl
    };
  }

  async function stop() {
    if (!server.listening) {
      return;
    }

    await new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }

  return {
    start,
    stop,
    store,
    keyManager,
    server,
    getBaseUrl: () => publicBaseUrl
  };
}

export async function dispatchBridgeRequest({ method, rawUrl, headers = {}, bodyText = "", store, keyManager, baseUrl }) {
  if (!baseUrl) {
    throw new Error("Public base URL is not configured");
  }

  const host = headers.host ?? new URL(baseUrl).host;
  const url = new URL(rawUrl, `http://${host}`);

  if (method === "GET" && url.pathname === "/.well-known/webfinger") {
    return handleWebFinger({ url, store, publicBaseUrl: baseUrl });
  }

  if (method === "GET" && url.pathname.startsWith("/ap/actor/")) {
    return handleGetActor({ url, store, keyManager, publicBaseUrl: baseUrl });
  }

  if (method === "POST" && url.pathname.startsWith("/ap/actor/") && url.pathname.endsWith("/inbox")) {
    return handlePostInbox({ url, store, publicBaseUrl: baseUrl, bodyText });
  }

  return {
    status: 404,
    contentType: "application/json",
    body: { error: "Not found" }
  };
}

function handleWebFinger({ url, store, publicBaseUrl }) {
  const resource = url.searchParams.get("resource");
  if (!resource) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: "Missing resource query parameter" }
    };
  }

  const bridgeHost = new URL(publicBaseUrl).host;

  let response;
  try {
    response = resolveWebFingerResource({
      resource,
      bridgeHost,
      baseUrl: publicBaseUrl,
      store
    });
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  if (!response) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Bridge actor not found" }
    };
  }

  return {
    status: 200,
    contentType: "application/jrd+json",
    body: response
  };
}

function handleGetActor({ url, store, keyManager, publicBaseUrl }) {
  let did;
  try {
    const didPath = url.pathname.slice("/ap/actor/".length);
    did = decodeDidFromPath(didPath);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  const profile = store.getActorByDid(did);

  if (!profile) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Bridge actor not found" }
    };
  }

  const keys = keyManager.ensureKeyPair(did);
  const actor = buildActorDocument({
    baseUrl: publicBaseUrl,
    profile,
    publicKeyPem: keys.publicKeyPem
  });

  return {
    status: 200,
    contentType: "application/activity+json",
    body: actor
  };
}

function handlePostInbox({ url, store, publicBaseUrl, bodyText }) {
  let did;
  try {
    const didPath = url.pathname.slice("/ap/actor/".length, -"/inbox".length);
    did = decodeDidFromPath(didPath);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  if (!store.getActorByDid(did)) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Bridge actor not found" }
    };
  }

  let activity;
  try {
    activity = parseJsonBody(bodyText);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  let result;
  try {
    result = processInboxActivity({
      activity,
      targetDid: did,
      baseUrl: publicBaseUrl,
      store
    });
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  return {
    status: result.status,
    contentType: "application/activity+json",
    body: result.body
  };
}

function parseJsonBody(bodyText) {
  if (!bodyText || !bodyText.trim()) {
    throw new Error("Request body cannot be empty");
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf-8");
}

function sendJsonResponse(res, response) {
  const data = JSON.stringify(response.body);
  res.writeHead(response.status, {
    "content-type": `${response.contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}
