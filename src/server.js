import http from "node:http";
import { URL } from "node:url";
import { buildActorDocument } from "./ap/actor.js";
import { processInboxActivity } from "./ap/follow.js";
import { resolveFollowerEndpoints } from "./ap/remote-actor.js";
import { resolveWebFingerResource } from "./ap/webfinger.js";
import { getPostRecord, getProfile, getRepostRecord, resolveHandleToDid } from "./bsky/public-api.js";
import { blueskyPostUrl, blueskyProfileUrl } from "./bsky/web-url.js";
import { mapBskyPostToActivityPub, mapBskyRepostToActivityPub, parseAtPostUri } from "./bridge/post-mapper.js";
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
  quoteAuthorizationId,
  webfingerSubject
} from "./domain/identifiers.js";
import { InMemoryBridgeStore } from "./storage/in-memory-store.js";

const DISCOVERY_EXAMPLES = [
  {
    label: "@bsky.app",
    query: "@bsky.app"
  },
  {
    label: "bsky.app profile",
    query: "https://bsky.app/profile/bsky.app"
  },
  {
    label: "bsky.app post",
    query: "https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l"
  }
];

export function createBridgeServer({
  baseUrl = null,
  store = new InMemoryBridgeStore(),
  keyManager = new InMemoryKeyManager(),
  fetchImpl = fetch,
  deliveryQueue = null,
  actorCache = null,
  inboxSignatureVerifier = null,
  profileCacheMaxAgeMs = 60_000,
  followLogger = null
} = {}) {
  let publicBaseUrl = baseUrl;

  const server = http.createServer((req, res) => {
    void handleIncomingRequest({
      req,
      res,
      getPublicBaseUrl: () => publicBaseUrl,
      store,
      keyManager,
      fetchImpl,
      deliveryQueue,
      actorCache,
      inboxSignatureVerifier,
      profileCacheMaxAgeMs,
      followLogger
    }).catch((error) => {
      if (isClientAbortError(error) || req.destroyed || res.destroyed) {
        return;
      }

      sendJsonResponseIfPossible(res, {
        status: 500,
        contentType: "application/json",
        body: {
          error: "Internal server error",
          detail: error instanceof Error ? error.message : String(error)
        }
      });
    });
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

async function handleIncomingRequest({
  req,
  res,
  getPublicBaseUrl,
  store,
  keyManager,
  fetchImpl,
  deliveryQueue,
  actorCache,
  inboxSignatureVerifier,
  profileCacheMaxAgeMs,
  followLogger
}) {
  const bodyText = shouldReadRequestBody(req)
    ? await readRawBody(req)
    : "";

  let response;
  try {
    response = await dispatchBridgeRequest({
      method: req.method,
      rawUrl: req.url,
      headers: req.headers,
      bodyText,
      store,
      keyManager,
      baseUrl: getPublicBaseUrl(),
      fetchImpl,
      deliveryQueue,
      actorCache,
      inboxSignatureVerifier,
      profileCacheMaxAgeMs,
      followLogger
    });
  } catch (error) {
    response = {
      status: 500,
      contentType: "application/json",
      body: {
        error: "Internal server error",
        detail: error instanceof Error ? error.message : String(error)
      }
    };
  }

  sendJsonResponse(res, response);
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
  profileCacheMaxAgeMs = 60_000,
  followLogger = null
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

    return handleGetActor({ url, headers, store, keyManager, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
  }

  if (method === "GET" && url.pathname.includes("/quote-authorization/")) {
    return handleGetQuoteAuthorization({ url, publicBaseUrl: baseUrl });
  }

  if (method === "GET" && url.pathname.startsWith("/ap/object/")) {
    return handleGetObject({ url, headers, store, publicBaseUrl: baseUrl, fetchImpl, profileCacheMaxAgeMs });
  }

  if (method === "POST" && url.pathname.startsWith("/ap/actor/") && url.pathname.endsWith("/inbox")) {
    return handlePostInbox({ method, url, headers, store, keyManager, publicBaseUrl: baseUrl, bodyText, fetchImpl, deliveryQueue, actorCache, inboxSignatureVerifier, profileCacheMaxAgeMs, followLogger });
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

async function handleGetActor({ url, headers, store, keyManager, publicBaseUrl, fetchImpl, profileCacheMaxAgeMs }) {
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

  if (prefersHtml(headers)) {
    const profile = store.getActorByDid(did);
    return redirectToOriginal(blueskyProfileUrl({ did, handle: profile?.handle }));
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

async function handleGetObject({ url, headers, store, publicBaseUrl, fetchImpl }) {
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

  if (prefersHtml(headers)) {
    return redirectToOriginal(blueskyPostUrl({ did, rkey }));
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

function handleGetQuoteAuthorization({ url, publicBaseUrl }) {
  const match = /^\/ap\/object\/([^/]+)\/([^/]+)\/quote-authorization\/([^/]+)\/([^/]+)$/.exec(url.pathname);
  if (!match) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: "Invalid quote authorization path" }
    };
  }

  let quotedDid;
  let quotedRkey;
  let quotingDid;
  let quotingRkey;
  try {
    quotedDid = decodeDidFromPath(match[1]);
    quotedRkey = decodeURIComponent(match[2]);
    quotingDid = decodeDidFromPath(match[3]);
    quotingRkey = decodeURIComponent(match[4]);
  } catch (error) {
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  return {
    status: 200,
    contentType: "application/activity+json",
    body: buildQuoteAuthorizationDocument({
      publicBaseUrl,
      quotedDid,
      quotedRkey,
      quotingDid,
      quotingRkey
    })
  };
}

function buildQuoteAuthorizationDocument({ publicBaseUrl, quotedDid, quotedRkey, quotingDid, quotingRkey }) {
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      {
        QuoteAuthorization: "https://w3id.org/fep/044f#QuoteAuthorization",
        gts: "https://gotosocial.org/ns#",
        interactingObject: {
          "@id": "gts:interactingObject",
          "@type": "@id"
        },
        interactionTarget: {
          "@id": "gts:interactionTarget",
          "@type": "@id"
        }
      }
    ],
    id: quoteAuthorizationId(publicBaseUrl, quotedDid, quotedRkey, quotingDid, quotingRkey),
    type: "QuoteAuthorization",
    attributedTo: actorId(publicBaseUrl, quotedDid),
    interactingObject: objectId(publicBaseUrl, quotingDid, quotingRkey),
    interactionTarget: objectId(publicBaseUrl, quotedDid, quotedRkey)
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

    if (rkey.startsWith("repost:")) {
      const legacyCached = store.getObjectByRkey(did, `app.bsky.feed.repost:${rkey.slice("repost:".length)}`);
      if (legacyCached) {
        return legacyCached.object
          ? legacyCached
          : {
              ...legacyCached,
              object: legacyCached.activity?.type === "Announce" ? legacyCached.activity : null
            };
      }
    }
  }

  if (rkey.startsWith("repost:")) {
    return ensureRepostRecord({
      store,
      fetchImpl,
      baseUrl,
      did,
      rkey: rkey.slice("repost:".length)
    });
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
    resolveReplyObjectId: (replyDid, replyRkey) => objectId(baseUrl, replyDid, replyRkey)
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

async function ensureRepostRecord({ store, fetchImpl, baseUrl, did, rkey }) {
  let record;
  try {
    record = await getRepostRecord({ did, rkey, fetchImpl });
  } catch {
    return null;
  }

  const mapped = mapBskyRepostToActivityPub({
    baseUrl,
    did,
    rkey,
    record: record.value,
    visibility: "unlisted"
  });

  if (typeof store.upsertObjectActivity !== "function") {
    return {
      object: mapped.announce,
      activity: mapped.announce,
      deleted: false
    };
  }

  return store.upsertObjectActivity({
    did,
    rkey: `repost:${rkey}`,
    operation: "create",
    object: mapped.announce,
    activity: mapped.announce,
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
    const author = await resolvePostAuthorReference({
      parsed,
      store,
      fetchImpl,
      cacheMaxAgeMs: profileCacheMaxAgeMs
    });

    const record = await ensurePostRecord({
      store,
      fetchImpl,
      baseUrl: publicBaseUrl,
      did: author.did,
      rkey: parsed.rkey
    });

    if (!record?.object) {
      throw new Error("Unable to resolve post");
    }

    return {
      kind: "post",
      did: author.did,
      handle: author.handle,
      rkey: parsed.rkey,
      postUrl: objectId(publicBaseUrl, author.did, parsed.rkey),
      actorUrl: actorId(publicBaseUrl, author.did),
      acct: author.handle ? `${author.handle}@${bridgeHost}` : null,
      webfinger: author.handle ? webfingerSubject(author.handle, bridgeHost) : null
    };
  }

  throw new Error("Unsupported discovery target");
}

async function resolvePostAuthorReference({ parsed, store, fetchImpl, cacheMaxAgeMs }) {
  const actorProfile = parsed.did
    ? await ensureActorProfile({
      store,
      fetchImpl,
      did: parsed.did,
      cacheMaxAgeMs
    })
    : await ensureActorProfile({
      store,
      fetchImpl,
      handle: parsed.handle,
      cacheMaxAgeMs
    });

  if (actorProfile?.did) {
    return {
      did: actorProfile.did,
      handle: actorProfile.handle ?? parsed.handle ?? null
    };
  }

  if (parsed.did) {
    return {
      did: parsed.did,
      handle: parsed.handle ?? null
    };
  }

  let did = null;
  try {
    did = await resolveHandleToDid({ handle: parsed.handle, fetchImpl });
  } catch {
    did = null;
  }

  if (!did) {
    throw new Error("Unable to resolve post author");
  }

  if (typeof store.upsertActor === "function") {
    try {
      store.upsertActor({
        did,
        handle: parsed.handle
      });
    } catch {
      // Best-effort cache warm-up only.
    }
  }

  return {
    did,
    handle: parsed.handle
  };
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
    .examples { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .examples a { border: 1px solid #cbd5e1; border-radius: 8px; color: #0f172a; display: inline-flex; padding: 6px 8px; text-decoration: none; }
    .examples a:hover { background: #f8fafc; border-color: #94a3b8; }
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
        <input type="text" name="q" value="${escapedInput}" placeholder="@bsky.app or https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l" autocomplete="off">
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
    return `<p class="hint">Examples from Bluesky:</p>
<div class="examples">
${DISCOVERY_EXAMPLES.map(renderDiscoveryExample).join("\n")}
</div>`;
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

function renderDiscoveryExample(example) {
  const href = `/?q=${encodeURIComponent(example.query)}`;
  return `<a href="${escapeHtml(href)}"><code>${escapeHtml(example.label)}</code></a>`;
}

async function handlePostInbox({ method, url, headers, store, keyManager, publicBaseUrl, bodyText, fetchImpl, deliveryQueue, actorCache, inboxSignatureVerifier, profileCacheMaxAgeMs, followLogger }) {
  let did;
  try {
    const didPath = url.pathname.slice("/ap/actor/".length, -"/inbox".length);
    did = decodeDidFromPath(didPath);
  } catch (error) {
    logFollowEvent(followLogger, {
      event: "inbox.decode_failed",
      path: url.pathname,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  let targetActorProfile = store.getActorByDid(did);
  if (!targetActorProfile) {
    logFollowEvent(followLogger, {
      event: "inbox.actor_materialize.start",
      did,
      path: url.pathname
    });
    targetActorProfile = await ensureActorProfile({
      store,
      fetchImpl,
      did,
      cacheMaxAgeMs: profileCacheMaxAgeMs
    });
  }

  if (!targetActorProfile) {
    logFollowEvent(followLogger, {
      event: "inbox.actor_missing",
      did,
      path: url.pathname
    });
    return {
      status: 404,
      contentType: "application/json",
      body: { error: "Bridge actor not found" }
    };
  }

  logFollowEvent(followLogger, {
    event: "inbox.actor.ok",
    did,
    path: url.pathname,
    handle: targetActorProfile.handle ?? null
  });

  if (inboxSignatureVerifier) {
    logFollowEvent(followLogger, {
      event: "inbox.signature.start",
      did,
      path: url.pathname
    });
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
      logFollowEvent(followLogger, {
        event: "inbox.signature.error",
        did,
        path: url.pathname,
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        status: 401,
        contentType: "application/json",
        body: { error: error.message }
      };
    }

    if (!verification.ok) {
      logFollowEvent(followLogger, {
        event: "inbox.signature.failed",
        did,
        path: url.pathname,
        error: verification.error ?? "Signature verification failed"
      });
      return {
        status: 401,
        contentType: "application/json",
        body: { error: verification.error ?? "Signature verification failed" }
      };
    }

    logFollowEvent(followLogger, {
      event: "inbox.signature.ok",
      did,
      path: url.pathname
    });
  }

  let activity;
  try {
    activity = parseJsonBody(bodyText);
  } catch (error) {
    logFollowEvent(followLogger, {
      event: "inbox.parse_failed",
      did,
      path: url.pathname,
      bodyLength: bodyText.length,
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  logFollowEvent(followLogger, {
    event: "inbox.activity",
    did,
    path: url.pathname,
    activity: summarizeInboxActivity(activity)
  });

  let result;
  try {
    let resolvedFollower = null;
    if (activity.type === "Follow") {
      logFollowEvent(followLogger, {
        event: "follow.resolve.start",
        did,
        activity: summarizeInboxActivity(activity)
      });
      resolvedFollower = await resolveFollowerEndpoints({
        activity,
        targetDid: did,
        baseUrl: publicBaseUrl,
        keyManager,
        fetchImpl,
        actorCache
      });
      logFollowEvent(followLogger, {
        event: "follow.resolve.ok",
        did,
        actorId: resolvedFollower.actorId,
        inboxUrl: resolvedFollower.inboxUrl,
        sharedInboxUrl: resolvedFollower.sharedInboxUrl,
        source: resolvedFollower.source ?? "unknown"
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
    logFollowEvent(followLogger, {
      event: "inbox.process_failed",
      did,
      activity: summarizeInboxActivity(activity),
      error: error instanceof Error ? error.message : String(error)
    });
    return {
      status: 400,
      contentType: "application/json",
      body: { error: error.message }
    };
  }

  logFollowEvent(followLogger, {
    event: "inbox.processed",
    did,
    activity: summarizeInboxActivity(activity),
    status: result.status,
    resultStatus: result.body?.status ?? null,
    followerActorId: result.body?.follower?.actorId ?? result.body?.actorId ?? null,
    followerInboxUrl: result.body?.follower?.inboxUrl ?? null,
    removed: typeof result.body?.removed === "boolean" ? result.body.removed : null
  });

  if (result.status === 202 && deliveryQueue && result.body.follower?.inboxUrl && result.body.accept) {
    deliveryQueue.enqueue({
      did,
      destination: result.body.follower.inboxUrl,
      recipientActorIds: [result.body.follower.actorId],
      operation: "follow-accept",
      activity: result.body.accept
    });
    logFollowEvent(followLogger, {
      event: "follow.accept.enqueued",
      did,
      followerActorId: result.body.follower.actorId,
      destination: result.body.follower.inboxUrl,
      acceptId: result.body.accept.id ?? null
    });
  } else if (activity.type === "Follow") {
    logFollowEvent(followLogger, {
      event: "follow.accept.not_enqueued",
      did,
      status: result.status,
      reason: deliveryQueue
        ? (result.body?.follower?.inboxUrl ? "missing-accept" : "missing-inbox")
        : "missing-delivery-queue"
    });
  }

  return {
    status: result.status,
    contentType: "application/activity+json",
    body: result.body
  };
}

function logFollowEvent(followLogger, event) {
  if (typeof followLogger !== "function") {
    return;
  }

  try {
    followLogger({
      at: new Date().toISOString(),
      ...event
    });
  } catch {
    // Diagnostics must never affect federation handling.
  }
}

function summarizeInboxActivity(activity) {
  if (!activity || typeof activity !== "object") {
    return null;
  }

  const summary = {
    id: typeof activity.id === "string" ? activity.id : null,
    type: typeof activity.type === "string" ? activity.type : null,
    actor: summarizeActivityReference(activity.actor),
    object: summarizeActivityReference(activity.object)
  };

  if (activity.object && typeof activity.object === "object") {
    summary.objectType = typeof activity.object.type === "string" ? activity.object.type : null;
    summary.objectActor = summarizeActivityReference(activity.object.actor);
    summary.objectObject = summarizeActivityReference(activity.object.object);
  }

  return summary;
}

function summarizeActivityReference(value) {
  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object" && typeof value.id === "string") {
    return value.id;
  }

  return null;
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
  const headers = {
    "content-type": `${response.contentType}; charset=utf-8`,
    "content-length": Buffer.byteLength(data),
    ...(response.headers ?? {})
  };
  res.writeHead(response.status, {
    ...headers
  });
  res.end(data);
}

function sendJsonResponseIfPossible(res, response) {
  if (res.destroyed || res.headersSent) {
    return;
  }

  try {
    sendJsonResponse(res, response);
  } catch {
    // The only thing left to do after a socket-level write failure is stop.
  }
}

function isClientAbortError(error) {
  if (!error || typeof error !== "object") {
    return false;
  }

  return error.code === "ECONNRESET"
    || error.name === "AbortError"
    || error.message === "aborted";
}

function redirectToOriginal(location) {
  return {
    status: 302,
    contentType: "text/plain",
    headers: {
      location
    },
    body: `Redirecting to ${location}`
  };
}

function prefersHtml(headers = {}) {
  const accept = readHeader(headers, "accept");
  if (!accept) {
    return false;
  }

  const mediaTypes = accept
    .split(",")
    .map((part) => part.split(";")[0].trim().toLowerCase())
    .filter(Boolean);

  if (!mediaTypes.includes("text/html")) {
    return false;
  }

  return !mediaTypes.some((type) => {
    return type === "application/activity+json"
      || type === "application/ld+json"
      || type === "application/json";
  });
}

function readHeader(headers, name) {
  const direct = headers[name];
  if (typeof direct === "string") {
    return direct;
  }

  const lowerName = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName && typeof value === "string") {
      return value;
    }
  }

  return null;
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
