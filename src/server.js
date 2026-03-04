import http from "node:http";
import { URL } from "node:url";
import { buildActorDocument } from "./ap/actor.js";
import { processInboxActivity } from "./ap/follow.js";
import { resolveFollowerEndpoints } from "./ap/remote-actor.js";
import { resolveWebFingerResource } from "./ap/webfinger.js";
import { getPostRecord, getProfile, resolveHandleToDid } from "./bsky/public-api.js";
import { mapBskyPostToActivityPub, parseAtPostUri } from "./bridge/post-mapper.js";
import { InMemoryKeyManager } from "./crypto/key-manager.js";
import { parseDiscoveryInput } from "./discovery/input-parser.js";
import {
  actorId,
  actorFeaturedId,
  actorFollowersId,
  actorFollowingId,
  actorOutboxId,
  decodeDidFromPath,
  objectId,
  parseAcctResource,
  webfingerSubject
} from "./domain/identifiers.js";
import { InMemoryBridgeStore } from "./storage/in-memory-store.js";

export function createBridgeServer({
  baseUrl = null,
  store = new InMemoryBridgeStore(),
  keyManager = new InMemoryKeyManager(),
  fetchImpl = fetch,
  deliveryQueue = null,
  actorCache = null,
  inboxSignatureVerifier = null,
  profileCacheMaxAgeMs = 60_000
} = {}) {
  let publicBaseUrl = baseUrl;

  const server = http.createServer(async (req, res) => {
    const bodyText = shouldReadRequestBody(req)
      ? await readRawBody(req)
      : "";

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
        inboxSignatureVerifier,
        profileCacheMaxAgeMs
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

export async function dispatchBridgeRequest({
  method,
  rawUrl,
  headers = {},
  bodyText = "",
  store,
  keyManager,
  baseUrl,
  fetchImpl = fetch,
  deliveryQueue = null,
  actorCache = null,
  inboxSignatureVerifier = null,
  profileCacheMaxAgeMs = 60_000
}) {
  if (!baseUrl) {
    throw new Error("Public base URL is not configured");
  }

  const host = headers.host ?? new URL(baseUrl).host;
  const url = new URL(rawUrl, `http://${host}`);

  if (method === "GET" && url.pathname === "/") {
    return handleDiscoveryFrontpage({
      url,
      store,
      publicBaseUrl: baseUrl,
      fetchImpl,
      profileCacheMaxAgeMs
    });
  }

  if (method === "GET" && url.pathname === "/api/resolve") {
    return handleDiscoveryResolveApi({
      url,
      store,
      publicBaseUrl: baseUrl,
      fetchImpl,
      profileCacheMaxAgeMs
    });
  }

  if (method === "GET" && url.pathname === "/.well-known/webfinger") {
    return handleWebFinger({ url, store, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
  }

  if (method === "GET" && url.pathname.startsWith("/ap/actor/")) {
    if (url.pathname.endsWith("/followers")) {
      return handleGetFollowers({ url, store, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
    }

    if (url.pathname.endsWith("/following")) {
      return handleGetFollowing({ url, store, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
    }

    if (url.pathname.endsWith("/outbox")) {
      return handleGetOutbox({ url, store, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
    }

    if (url.pathname.endsWith("/featured")) {
      return handleGetFeatured({ url, store, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
    }

    return handleGetActor({ url, store, keyManager, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
  }

  if (method === "GET" && url.pathname.startsWith("/ap/object/")) {
    return handleGetObject({ url, store, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
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

async function handleDiscoveryFrontpage({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
  const query = url.searchParams.get("q") ?? "";
  const trimmed = query.trim();

  if (!trimmed) {
    return {
      status: 200,
      contentType: "text/html",
      body: renderDiscoveryFrontpage({
        publicBaseUrl,
        input: "",
        result: null,
        error: null
      })
    };
  }

  try {
    const result = await resolveDiscoveryQuery({
      query: trimmed,
      store,
      publicBaseUrl,
      fetchImpl,
      profileCacheMaxAgeMs
    });

    return {
      status: 200,
      contentType: "text/html",
      body: renderDiscoveryFrontpage({
        publicBaseUrl,
        input: trimmed,
        result,
        error: null
      })
    };
  } catch (error) {
    return {
      status: 400,
      contentType: "text/html",
      body: renderDiscoveryFrontpage({
        publicBaseUrl,
        input: trimmed,
        result: null,
        error: error instanceof Error ? error.message : String(error)
      })
    };
  }
}

async function handleDiscoveryResolveApi({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
  const query = url.searchParams.get("q") ?? "";
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      status: 400,
      contentType: "application/json",
      body: {
        ok: false,
        error: "Missing q query parameter"
      }
    };
  }

  try {
    const result = await resolveDiscoveryQuery({
      query: trimmed,
      store,
      publicBaseUrl,
      fetchImpl,
      profileCacheMaxAgeMs
    });

    return {
      status: 200,
      contentType: "application/json",
      body: {
        ok: true,
        result
      }
    };
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      }
    };
  }
}

async function handleWebFinger({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
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

  await ensureActorProfile({
    store,
    fetchImpl,
    handle: parsed.handle,
    cacheMaxAgeMs: profileCacheMaxAgeMs
  });

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

async function handleGetActor({ url, store, keyManager, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
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

  const profile = await ensureActorProfile({
    store,
    fetchImpl,
    did,
    cacheMaxAgeMs: profileCacheMaxAgeMs
  });

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

async function handleGetFollowers({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
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

  const actor = await ensureActorProfile({
    store,
    fetchImpl,
    did,
    cacheMaxAgeMs: profileCacheMaxAgeMs
  });

  if (!actor) {
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

async function handleGetFollowing({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
  let did;
  try {
    const didPath = url.pathname.slice("/ap/actor/".length, -"/following".length);
    did = decodeDidFromPath(didPath);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  const actor = await ensureActorProfile({
    store,
    fetchImpl,
    did,
    cacheMaxAgeMs: profileCacheMaxAgeMs
  });

  if (!actor) {
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
      id: actorFollowingId(publicBaseUrl, did),
      type: "OrderedCollection",
      totalItems: 0,
      orderedItems: []
    }
  };
}

async function handleGetOutbox({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
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

  const actor = await ensureActorProfile({
    store,
    fetchImpl,
    did,
    cacheMaxAgeMs: profileCacheMaxAgeMs
  });

  if (!actor) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Bridge actor not found" }
    };
  }

  const limit = parseCollectionLimit(url.searchParams.get("limit"), 20);
  const totalItems = typeof store.countOutboxActivities === "function"
    ? store.countOutboxActivities(did)
    : null;
  const items = typeof store.listOutboxActivities === "function"
    ? store.listOutboxActivities(did, { limit })
    : [];

  return {
    status: 200,
    contentType: "application/activity+json",
    body: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: actorOutboxId(publicBaseUrl, did),
      type: "OrderedCollection",
      totalItems: typeof totalItems === "number" ? totalItems : items.length,
      orderedItems: items
    }
  };
}

async function handleGetFeatured({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
  let did;
  try {
    const didPath = url.pathname.slice("/ap/actor/".length, -"/featured".length);
    did = decodeDidFromPath(didPath);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  const actor = await ensureActorProfile({
    store,
    fetchImpl,
    did,
    cacheMaxAgeMs: profileCacheMaxAgeMs
  });

  if (!actor) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Bridge actor not found" }
    };
  }

  const featuredItems = [];
  const pinned = parseAtPostUri(actor.pinnedPostUri);
  if (pinned) {
    const record = await ensurePostRecord({
      store,
      fetchImpl,
      baseUrl: publicBaseUrl,
      did: pinned.did,
      rkey: pinned.rkey
    });

    if (record?.object) {
      featuredItems.push(record.object);
    }
  }

  return {
    status: 200,
    contentType: "application/activity+json",
    body: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: actorFeaturedId(publicBaseUrl, did),
      type: "OrderedCollection",
      totalItems: featuredItems.length,
      orderedItems: featuredItems
    }
  };
}

async function handleGetObject({ url, store, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
  const match = /^\/ap\/object\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: "Invalid object path" }
    };
  }

  let did;
  let rkey;
  try {
    did = decodeDidFromPath(match[1]);
    rkey = decodeURIComponent(match[2]);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  const actor = await ensureActorProfile({
    store,
    fetchImpl,
    did,
    cacheMaxAgeMs: profileCacheMaxAgeMs
  });

  if (!actor) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Bridge actor not found" }
    };
  }

  let record = typeof store.getObjectByRkey === "function"
    ? store.getObjectByRkey(did, rkey)
    : null;

  if (!record) {
    record = await ensurePostRecord({
      store,
      fetchImpl,
      baseUrl: publicBaseUrl,
      did,
      rkey
    });
  }

  if (!record) {
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Object not found" }
    };
  }

  if (record.deleted) {
    const id = record?.activity?.object ?? record?.object?.id ?? objectId(publicBaseUrl, did, rkey);
    return {
      status: 410,
      contentType: "application/activity+json",
      body: {
        "@context": "https://www.w3.org/ns/activitystreams",
        id,
        type: "Tombstone"
      }
    };
  }

  return {
    status: 200,
    contentType: "application/activity+json",
    body: record.object
  };
}

async function ensureActorProfile({ store, fetchImpl, did = null, handle = null, cacheMaxAgeMs = 60_000 }) {
  const now = Date.now();
  let existing = null;

  if (did) {
    existing = store.getActorByDid(did);
  } else if (handle) {
    const resolvedDid = store.resolveDidByHandle(handle);
    existing = resolvedDid ? store.getActorByDid(resolvedDid) : null;
  }

  if (existing && !isActorStale(existing, now, cacheMaxAgeMs)) {
    return existing;
  }

  let actorRefDid = did;
  try {
    if (!actorRefDid && handle) {
      actorRefDid = await resolveHandleToDid({ handle, fetchImpl });
    }
  } catch {
    return existing;
  }

  if (!actorRefDid && existing?.did) {
    actorRefDid = existing.did;
  }

  if (!actorRefDid) {
    return existing;
  }

  let profile;
  try {
    profile = await getProfile({ actor: actorRefDid, fetchImpl });
  } catch {
    return existing;
  }

  try {
    return store.upsertActor({
      did: profile.did,
      handle: profile.handle ?? handle ?? existing?.handle,
      displayName: profile.displayName,
      summary: profile.description,
      avatarUrl: profile.avatarUrl,
      bannerUrl: profile.bannerUrl,
      pinnedPostUri: profile.pinnedPostUri,
      profileFetchedAt: new Date().toISOString()
    });
  } catch {
    return existing;
  }
}

async function ensurePostRecord({ store, fetchImpl, baseUrl, did, rkey }) {
  if (typeof store.getObjectByRkey === "function") {
    const cached = store.getObjectByRkey(did, rkey);
    if (cached) {
      return cached;
    }
  }

  let record;
  try {
    record = await getPostRecord({ did, rkey, fetchImpl });
  } catch {
    return null;
  }

  const mapped = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey,
    record: record.value,
    visibility: "unlisted",
    resolveReplyObjectId: (replyDid, replyRkey) => {
      const cached = typeof store.getObjectByRkey === "function"
        ? store.getObjectByRkey(replyDid, replyRkey)
        : null;

      return cached && !cached.deleted ? objectId(baseUrl, replyDid, replyRkey) : null;
    }
  });

  if (typeof store.upsertObjectActivity !== "function") {
    return {
      object: mapped.note,
      activity: mapped.create,
      deleted: false
    };
  }

  return store.upsertObjectActivity({
    did,
    rkey,
    operation: "create",
    object: mapped.note,
    activity: mapped.create,
    cursor: null
  });
}

async function resolveDiscoveryQuery({
  query,
  store,
  publicBaseUrl,
  fetchImpl,
  profileCacheMaxAgeMs
}) {
  const parsed = parseDiscoveryInput(query);
  const bridgeHost = new URL(publicBaseUrl).host;

  if (parsed.kind === "actor") {
    const profile = await ensureActorProfile({
      store,
      fetchImpl,
      did: parsed.did ?? null,
      handle: parsed.handle ?? null,
      cacheMaxAgeMs: profileCacheMaxAgeMs
    });

    if (!profile) {
      throw new Error("Unable to resolve actor");
    }

    return {
      kind: "actor",
      did: profile.did,
      handle: profile.handle,
      actorUrl: actorId(publicBaseUrl, profile.did),
      acct: `${profile.handle}@${bridgeHost}`,
      webfinger: webfingerSubject(profile.handle, bridgeHost)
    };
  }

  if (parsed.kind === "post") {
    const actorProfile = parsed.did
      ? await ensureActorProfile({
        store,
        fetchImpl,
        did: parsed.did,
        cacheMaxAgeMs: profileCacheMaxAgeMs
      })
      : await ensureActorProfile({
        store,
        fetchImpl,
        handle: parsed.handle,
        cacheMaxAgeMs: profileCacheMaxAgeMs
      });

    if (!actorProfile) {
      throw new Error("Unable to resolve post author");
    }

    const record = await ensurePostRecord({
      store,
      fetchImpl,
      baseUrl: publicBaseUrl,
      did: actorProfile.did,
      rkey: parsed.rkey
    });

    if (!record?.object) {
      throw new Error("Unable to resolve post");
    }

    return {
      kind: "post",
      did: actorProfile.did,
      handle: actorProfile.handle,
      rkey: parsed.rkey,
      postUrl: objectId(publicBaseUrl, actorProfile.did, parsed.rkey),
      actorUrl: actorId(publicBaseUrl, actorProfile.did),
      acct: `${actorProfile.handle}@${bridgeHost}`,
      webfinger: webfingerSubject(actorProfile.handle, bridgeHost)
    };
  }

  throw new Error("Unsupported discovery target");
}

function isActorStale(actor, nowMs, maxAgeMs) {
  const profileFreshnessIso = readProfileFreshnessTimestamp(actor);
  if (!profileFreshnessIso) {
    return true;
  }

  const updatedAt = Date.parse(profileFreshnessIso);
  if (!Number.isFinite(updatedAt)) {
    return true;
  }

  return (nowMs - updatedAt) > maxAgeMs;
}

function readProfileFreshnessTimestamp(actor) {
  if (!actor || typeof actor !== "object") {
    return null;
  }

  if (typeof actor.profileFetchedAt === "string" && actor.profileFetchedAt) {
    return actor.profileFetchedAt;
  }

  const hasProfileSignals = actor.displayName != null
    || actor.summary != null
    || actor.avatarUrl != null
    || actor.bannerUrl != null
    || actor.pinnedPostUri != null;

  if (hasProfileSignals && typeof actor.updatedAt === "string" && actor.updatedAt) {
    return actor.updatedAt;
  }

  return null;
}

function renderDiscoveryFrontpage({ publicBaseUrl, input, result, error }) {
  const escapedInput = escapeHtml(input ?? "");
  const resultHtml = renderDiscoveryResult(result, error);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bluesky Bridge Resolver</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #f8fafc; color: #0f172a; }
    main { max-width: 760px; margin: 0 auto; padding: 24px 16px 40px; }
    h1 { margin: 0 0 8px; font-size: 1.35rem; }
    p { margin: 0 0 12px; line-height: 1.4; }
    .box { background: #ffffff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 14px; }
    form { display: flex; gap: 8px; margin-bottom: 10px; }
    input[type="text"] { flex: 1; border: 1px solid #94a3b8; border-radius: 8px; font: inherit; padding: 10px 12px; }
    button { border: 1px solid #0f172a; background: #0f172a; color: #fff; border-radius: 8px; font: inherit; padding: 10px 14px; cursor: pointer; }
    .copy-row { display: flex; gap: 8px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
    .copy-btn { border-color: #334155; background: #334155; }
    code { background: #f1f5f9; padding: 2px 6px; border-radius: 6px; }
    ul { margin: 10px 0 0; padding-left: 18px; }
    li { margin: 6px 0; }
    .error { color: #b91c1c; margin-top: 10px; }
    .hint { color: #475569; margin-top: 10px; }
  </style>
</head>
<body>
  <main>
    <h1>Bluesky Bridge Resolver</h1>
    <p>Paste a Bluesky user or post and copy the single search target for Mastodon/GtS.</p>
    <div class="box">
      <form method="get" action="/">
        <input type="text" name="q" value="${escapedInput}" placeholder="mouseu.bsky.social or https://bsky.app/profile/.../post/..." autocomplete="off">
        <button type="submit">Resolve</button>
      </form>
      ${resultHtml}
    </div>
  </main>
</body>
</html>`;
}

function renderDiscoveryResult(result, error) {
  if (error) {
    return `<p class="error">Unable to resolve input: ${escapeHtml(error)}</p>`;
  }

  if (!result) {
    return `<p class="hint">Supported examples: <code>mouseu.bsky.social</code>, <code>@mouseu.bsky.social</code>, <code>https://bsky.app/profile/<id>/post/<rkey></code></p>`;
  }

  const target = result.kind === "post"
    ? result.postUrl
    : result.acct;
  const label = result.kind === "post"
    ? "Search this post URL in your fediverse server:"
    : "Search this account address in your fediverse server:";
  const escapedTarget = escapeHtml(target);

  return `<p>${label}</p>
<div class="copy-row">
  <code id="resolved-target">${escapedTarget}</code>
  <button class="copy-btn" type="button" onclick="navigator.clipboard?.writeText(document.getElementById('resolved-target')?.textContent ?? '')">Copy</button>
</div>`;
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

export function shouldReadRequestBody(req) {
  const method = String(req?.method ?? "").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return false;
  }

  return true;
}

function sendJsonResponse(res, response) {
  const data = typeof response.body === "string"
    ? response.body
    : JSON.stringify(response.body);
  res.writeHead(response.status, {
    "content-type": `${response.contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(data)
  });
  res.end(data);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function parseCollectionLimit(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, 1), 80);
}
