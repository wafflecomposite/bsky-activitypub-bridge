import http from "node:http";
import { URL } from "node:url";
import { buildActorDocument } from "./ap/actor.js";
import { processInboxActivity } from "./ap/follow.js";
import { resolveFollowerEndpoints } from "./ap/remote-actor.js";
import { resolveWebFingerResource } from "./ap/webfinger.js";
import { InMemoryKeyManager } from "./crypto/key-manager.js";
import { actorFollowersId, actorOutboxId, assertDid, decodeDidFromPath, parseAcctResource } from "./domain/identifiers.js";
import { InMemoryBridgeStore } from "./storage/in-memory-store.js";

export function createBridgeServer({ baseUrl = null, store = new InMemoryBridgeStore(), keyManager = new InMemoryKeyManager(), fetchImpl = fetch, deliveryQueue = null, actorCache = null, inboxSignatureVerifier = null } = {}) {
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
        baseUrl: publicBaseUrl,
        fetchImpl,
        deliveryQueue,
        actorCache,
        inboxSignatureVerifier
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
    deliveryQueue,
    actorCache,
    inboxSignatureVerifier,
    server,
    getBaseUrl: () => publicBaseUrl
  };
}

export async function dispatchBridgeRequest({ method, rawUrl, headers = {}, bodyText = "", store, keyManager, baseUrl, fetchImpl = fetch, deliveryQueue = null, actorCache = null, inboxSignatureVerifier = null }) {
  if (!baseUrl) {
    throw new Error("Public base URL is not configured");
  }

  const host = headers.host ?? new URL(baseUrl).host;
  const url = new URL(rawUrl, `http://${host}`);

  if (method === "GET" && url.pathname === "/.well-known/webfinger") {
    return handleWebFinger({ url, store, publicBaseUrl: baseUrl, fetchImpl });
  }

  if (method === "GET" && url.pathname.startsWith("/ap/actor/")) {
    if (url.pathname.endsWith("/followers")) {
      return handleGetFollowers({ url, store, publicBaseUrl: baseUrl });
    }

    if (url.pathname.endsWith("/outbox")) {
      return handleGetOutbox({ url, store, publicBaseUrl: baseUrl });
    }

    return handleGetActor({ url, store, keyManager, publicBaseUrl: baseUrl });
  }

  if (method === "POST" && url.pathname.startsWith("/ap/actor/") && url.pathname.endsWith("/inbox")) {
    return handlePostInbox({ method, url, headers, store, keyManager, publicBaseUrl: baseUrl, bodyText, fetchImpl, deliveryQueue, actorCache, inboxSignatureVerifier });
  }

  return {
    status: 404,
    contentType: "application/json",
    body: { error: "Not found" }
  };
}

async function handleWebFinger({ url, store, publicBaseUrl, fetchImpl }) {
  const resource = url.searchParams.get("resource");
  if (!resource) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: "Missing resource query parameter" }
    };
  }

  const bridgeHost = new URL(publicBaseUrl).host;
  let parsed;
  try {
    parsed = parseAcctResource(resource, bridgeHost);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  if (!store.resolveDidByHandle(parsed.handle)) {
    const resolvedDid = await resolveDidByHandle({
      handle: parsed.handle,
      fetchImpl
    });

    if (resolvedDid) {
      try {
        store.upsertActor({
          did: resolvedDid,
          handle: parsed.handle
        });
      } catch {
        // Ignore malformed upstream data and fall back to unresolved result.
      }
    }
  }

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

async function resolveDidByHandle({ handle, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`, {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    });
  } catch {
    return null;
  }

  if (!response || response.status < 200 || response.status >= 300) {
    return null;
  }

  let body;
  try {
    body = await response.json();
  } catch {
    return null;
  }

  if (typeof body?.did !== "string") {
    return null;
  }

  try {
    return assertDid(body.did);
  } catch {
    return null;
  }
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

function handleGetFollowers({ url, store, publicBaseUrl }) {
  let did;
  try {
    const didPath = url.pathname.slice("/ap/actor/".length, -"/followers".length);
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

  const followers = store.listFollowers(did);
  const id = actorFollowersId(publicBaseUrl, did);

  return {
    status: 200,
    contentType: "application/activity+json",
    body: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id,
      type: "OrderedCollection",
      totalItems: followers.length,
      orderedItems: followers.map((follower) => follower.actorId)
    }
  };
}

function handleGetOutbox({ url, store, publicBaseUrl }) {
  let did;
  try {
    const didPath = url.pathname.slice("/ap/actor/".length, -"/outbox".length);
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

  return {
    status: 200,
    contentType: "application/activity+json",
    body: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: actorOutboxId(publicBaseUrl, did),
      type: "OrderedCollection",
      totalItems: 0,
      orderedItems: []
    }
  };
}

async function handlePostInbox({ method, url, headers, store, keyManager, publicBaseUrl, bodyText, fetchImpl, deliveryQueue, actorCache, inboxSignatureVerifier }) {
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

  if (inboxSignatureVerifier) {
    let verification;
    try {
      verification = await runInboxSignatureVerifier({
        inboxSignatureVerifier,
        method,
        requestTarget: `${url.pathname}${url.search}`,
        headers,
        body: bodyText
      });
    } catch (error) {
      return {
        status: 401,
        contentType: "application/json",
        body: { error: error.message }
      };
    }

    if (!verification.ok) {
      return {
        status: 401,
        contentType: "application/json",
        body: { error: verification.error ?? "Signature verification failed" }
      };
    }
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
    let resolvedFollower = null;
    if (activity.type === "Follow") {
      resolvedFollower = await resolveFollowerEndpoints({
        activity,
        targetDid: did,
        baseUrl: publicBaseUrl,
        keyManager,
        fetchImpl,
        actorCache
      });
    }

    result = processInboxActivity({
      activity: {
        ...activity,
        resolvedFollower
      },
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

  if (result.status === 202 && deliveryQueue && result.body.follower?.inboxUrl && result.body.accept) {
    deliveryQueue.enqueue({
      did,
      destination: result.body.follower.inboxUrl,
      recipientActorIds: [result.body.follower.actorId],
      operation: "follow-accept",
      activity: result.body.accept
    });
  }

  return {
    status: result.status,
    contentType: "application/activity+json",
    body: result.body
  };
}

async function runInboxSignatureVerifier({ inboxSignatureVerifier, method, requestTarget, headers, body }) {
  if (typeof inboxSignatureVerifier === "function") {
    return inboxSignatureVerifier({ method, requestTarget, headers, body });
  }

  if (typeof inboxSignatureVerifier.verify === "function") {
    return inboxSignatureVerifier.verify({ method, requestTarget, headers, body });
  }

  throw new Error("inboxSignatureVerifier must be a function or object with verify()");
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
