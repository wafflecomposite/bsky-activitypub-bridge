import { assertDid, assertHandle } from "../domain/identifiers.js";

const DEFAULT_OBJECT_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_TOMBSTONE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_OBJECT_CACHE_MAX_RECORDS = 50_000;
const DEFAULT_PROFILE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export class InMemoryBridgeStore {
  #actorsByDid = new Map();
  #didByHandle = new Map();
  #followersByDid = new Map();
  #recordsByDid = new Map();
  #objectCacheTtlMs;
  #tombstoneCacheTtlMs;
  #objectCacheMaxRecords;
  #profileCacheTtlMs;
  #now;

  constructor({
    objectCacheTtlMs = DEFAULT_OBJECT_CACHE_TTL_MS,
    tombstoneCacheTtlMs = DEFAULT_TOMBSTONE_CACHE_TTL_MS,
    objectCacheMaxRecords = DEFAULT_OBJECT_CACHE_MAX_RECORDS,
    profileCacheTtlMs = DEFAULT_PROFILE_CACHE_TTL_MS,
    now = () => Date.now()
  } = {}) {
    this.#objectCacheTtlMs = normalizeDurationMs(objectCacheTtlMs, DEFAULT_OBJECT_CACHE_TTL_MS);
    this.#tombstoneCacheTtlMs = normalizeDurationMs(tombstoneCacheTtlMs, DEFAULT_TOMBSTONE_CACHE_TTL_MS);
    this.#objectCacheMaxRecords = normalizeMaxRecords(objectCacheMaxRecords, DEFAULT_OBJECT_CACHE_MAX_RECORDS);
    this.#profileCacheTtlMs = normalizeDurationMs(profileCacheTtlMs, DEFAULT_PROFILE_CACHE_TTL_MS);
    this.#now = typeof now === "function" ? now : () => Date.now();
  }

  upsertActor(actor) {
    const did = assertDid(actor.did);
    const handle = assertHandle(actor.handle);
    const existing = this.#actorsByDid.get(did) ?? null;
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(actor, key);
    const nowIso = this.#nowIso();
    const hasProfileFields = actorHasProfileFields(actor) || hasOwn("profileFetchedAt");

    const normalized = {
      did,
      handle,
      displayName: hasOwn("displayName") ? actor.displayName ?? null : existing?.displayName ?? null,
      summary: hasOwn("summary") ? actor.summary ?? null : existing?.summary ?? null,
      avatarUrl: hasOwn("avatarUrl") ? actor.avatarUrl ?? null : existing?.avatarUrl ?? null,
      bannerUrl: hasOwn("bannerUrl") ? actor.bannerUrl ?? null : existing?.bannerUrl ?? null,
      pinnedPostUri: hasOwn("pinnedPostUri") ? actor.pinnedPostUri ?? null : existing?.pinnedPostUri ?? null,
      profileFetchedAt: hasOwn("profileFetchedAt")
        ? normalizeOptionalIsoString(actor.profileFetchedAt)
        : existing?.profileFetchedAt ?? null,
      profileLastAccessedAt: hasProfileFields ? nowIso : existing?.profileLastAccessedAt ?? null,
      updatedAt: nowIso
    };

    if (existing?.handle && existing.handle !== handle) {
      this.#didByHandle.delete(existing.handle);
    }

    this.#actorsByDid.set(did, normalized);
    this.#didByHandle.set(handle, did);

    return normalized;
  }

  getActorByDid(did) {
    const actor = this.#actorsByDid.get(assertDid(did)) ?? null;
    if (actor) {
      this.#touchActor(actor);
    }

    return actor;
  }

  resolveDidByHandle(handle) {
    return this.#didByHandle.get(assertHandle(handle)) ?? null;
  }

  addFollower(did, follower) {
    const actorDid = assertDid(did);
    const followerActorId = normalizeActorRef(follower.actorId);

    let followers = this.#followersByDid.get(actorDid);
    if (!followers) {
      followers = new Map();
      this.#followersByDid.set(actorDid, followers);
    }

    const existing = followers.get(followerActorId);

    const normalized = {
      actorId: followerActorId,
      inboxUrl: follower.inboxUrl ?? existing?.inboxUrl ?? null,
      sharedInboxUrl: follower.sharedInboxUrl ?? existing?.sharedInboxUrl ?? null,
      followedAt: existing?.followedAt ?? this.#nowIso(),
      updatedAt: this.#nowIso(),
      lastFollowActivityId: follower.followActivityId ?? existing?.lastFollowActivityId ?? null
    };

    followers.set(followerActorId, normalized);

    return normalized;
  }

  removeFollower(did, actorId) {
    const actorDid = assertDid(did);
    const followerActorId = normalizeActorRef(actorId);
    const followers = this.#followersByDid.get(actorDid);

    if (!followers) {
      return null;
    }

    const removed = followers.get(followerActorId) ?? null;
    if (!removed) {
      return null;
    }

    followers.delete(followerActorId);
    if (followers.size === 0) {
      this.#followersByDid.delete(actorDid);
    }

    return removed;
  }

  listFollowers(did) {
    const actorDid = assertDid(did);
    const followers = this.#followersByDid.get(actorDid);

    if (!followers) {
      return [];
    }

    return Array.from(followers.values());
  }

  listFollowedDids() {
    const dids = [];

    for (const [did, followers] of this.#followersByDid.entries()) {
      if (followers.size > 0) {
        dids.push(did);
      }
    }

    return dids.sort();
  }

  upsertObjectActivity({ did, rkey, operation, object = null, activity = null, cursor = null }) {
    const actorDid = assertDid(did);
    const normalizedRkey = normalizeRkey(rkey);
    const normalizedOperation = normalizeOperation(operation);
    const existing = this.getObjectByRkey(actorDid, normalizedRkey);

    let records = this.#recordsByDid.get(actorDid);
    if (!records) {
      records = new Map();
      this.#recordsByDid.set(actorDid, records);
    }

    const nowMs = this.#now();
    const nowIso = isoFromMs(nowMs);
    const next = {
      rkey: normalizedRkey,
      operation: normalizedOperation,
      object: object ?? existing?.object ?? null,
      activity: activity ?? existing?.activity ?? null,
      deleted: normalizedOperation === "delete",
      cursor: typeof cursor === "number" && Number.isFinite(cursor)
        ? cursor
        : existing?.cursor ?? null,
      publishedAt: readPublishedAt(object, activity) ?? existing?.publishedAt ?? nowIso,
      cachedAt: existing?.cachedAt ?? nowIso,
      lastAccessedAt: nowIso,
      deletedAt: normalizedOperation === "delete" ? existing?.deletedAt ?? nowIso : null,
      updatedAt: nowIso
    };

    records.set(normalizedRkey, next);
    this.#pruneObjectCache(nowMs);
    return next;
  }

  getObjectByRkey(did, rkey) {
    const actorDid = assertDid(did);
    const normalizedRkey = normalizeRkey(rkey);
    const records = this.#recordsByDid.get(actorDid);

    if (!records) {
      return null;
    }

    const record = records.get(normalizedRkey) ?? null;
    if (!record) {
      return null;
    }

    const nowMs = this.#now();
    if (isObjectExpired(record, nowMs, {
      objectCacheTtlMs: this.#objectCacheTtlMs,
      tombstoneCacheTtlMs: this.#tombstoneCacheTtlMs
    })) {
      records.delete(normalizedRkey);
      this.#deleteEmptyRecordMap(actorDid, records);
      return null;
    }

    record.lastAccessedAt = isoFromMs(nowMs);
    return record;
  }

  listOutboxActivities(did, { limit = 20 } = {}) {
    const actorDid = assertDid(did);
    const records = this.#recordsByDid.get(actorDid);
    if (!records) {
      return [];
    }

    const nowMs = this.#now();
    this.#pruneObjectCache(nowMs);

    const items = Array.from(records.values())
      .filter((entry) => entry.activity && typeof entry.activity === "object")
      .sort((a, b) => compareIsoDatesDesc(a.publishedAt, b.publishedAt))
      .slice(0, normalizeLimit(limit));

    const nowIso = isoFromMs(nowMs);
    for (const entry of items) {
      entry.lastAccessedAt = nowIso;
    }

    return items.map((entry) => entry.activity);
  }

  countOutboxActivities(did) {
    const actorDid = assertDid(did);
    const records = this.#recordsByDid.get(actorDid);
    if (!records) {
      return 0;
    }

    this.#pruneObjectCache(this.#now());

    let total = 0;
    for (const entry of records.values()) {
      if (entry.activity && typeof entry.activity === "object") {
        total += 1;
      }
    }
    return total;
  }

  pruneCache({
    objectCacheTtlMs = this.#objectCacheTtlMs,
    tombstoneCacheTtlMs = this.#tombstoneCacheTtlMs,
    objectCacheMaxRecords = this.#objectCacheMaxRecords,
    profileCacheTtlMs = this.#profileCacheTtlMs
  } = {}) {
    const objectPolicy = {
      objectCacheTtlMs: normalizeDurationMs(objectCacheTtlMs, this.#objectCacheTtlMs),
      tombstoneCacheTtlMs: normalizeDurationMs(tombstoneCacheTtlMs, this.#tombstoneCacheTtlMs),
      objectCacheMaxRecords: normalizeMaxRecords(objectCacheMaxRecords, this.#objectCacheMaxRecords)
    };
    const profileTtlMs = normalizeDurationMs(profileCacheTtlMs, this.#profileCacheTtlMs);
    const nowMs = this.#now();
    const objectResult = this.#pruneObjectCache(nowMs, objectPolicy);
    const actorResult = this.#pruneActorCache(nowMs, profileTtlMs);

    return {
      objectsRemoved: objectResult.objectsRemoved,
      profilesCleared: actorResult.profilesCleared,
      actorsRemoved: actorResult.actorsRemoved
    };
  }

  #pruneObjectCache(nowMs, {
    objectCacheTtlMs = this.#objectCacheTtlMs,
    tombstoneCacheTtlMs = this.#tombstoneCacheTtlMs,
    objectCacheMaxRecords = this.#objectCacheMaxRecords
  } = {}) {
    let objectsRemoved = 0;

    for (const [did, records] of this.#recordsByDid.entries()) {
      for (const [rkey, record] of records.entries()) {
        if (isObjectExpired(record, nowMs, { objectCacheTtlMs, tombstoneCacheTtlMs })) {
          records.delete(rkey);
          objectsRemoved += 1;
        }
      }
      this.#deleteEmptyRecordMap(did, records);
    }

    const allRecords = [];
    for (const [did, records] of this.#recordsByDid.entries()) {
      for (const [rkey, record] of records.entries()) {
        allRecords.push({
          did,
          rkey,
          record,
          lastAccessedMs: recordAccessTime(record)
        });
      }
    }

    if (allRecords.length > objectCacheMaxRecords) {
      allRecords.sort((a, b) => a.lastAccessedMs - b.lastAccessedMs);
      const removeCount = allRecords.length - objectCacheMaxRecords;
      for (const entry of allRecords.slice(0, removeCount)) {
        const records = this.#recordsByDid.get(entry.did);
        if (records?.delete(entry.rkey)) {
          objectsRemoved += 1;
          this.#deleteEmptyRecordMap(entry.did, records);
        }
      }
    }

    return { objectsRemoved };
  }

  #pruneActorCache(nowMs, profileCacheTtlMs) {
    let profilesCleared = 0;
    let actorsRemoved = 0;

    for (const [did, actor] of [...this.#actorsByDid.entries()]) {
      if (hasCachedProfile(actor) && isProfileExpired(actor, nowMs, profileCacheTtlMs)) {
        clearCachedProfile(actor);
        actor.updatedAt = isoFromMs(nowMs);
        profilesCleared += 1;
      }

      const hasFollowers = (this.#followersByDid.get(did)?.size ?? 0) > 0;
      const hasRecords = (this.#recordsByDid.get(did)?.size ?? 0) > 0;
      if (!hasFollowers && !hasRecords && !hasCachedProfile(actor) && isActorIdentityExpired(actor, nowMs, profileCacheTtlMs)) {
        this.#actorsByDid.delete(did);
        if (actor.handle) {
          this.#didByHandle.delete(actor.handle);
        }
        actorsRemoved += 1;
      }
    }

    return { profilesCleared, actorsRemoved };
  }

  #touchActor(actor) {
    if (hasCachedProfile(actor)) {
      actor.profileLastAccessedAt = this.#nowIso();
    }
  }

  #deleteEmptyRecordMap(did, records) {
    if (records.size === 0) {
      this.#recordsByDid.delete(did);
    }
  }

  #nowIso() {
    return isoFromMs(this.#now());
  }
}

function normalizeActorRef(value) {
  if (typeof value !== "string") {
    throw new Error("Follower actor ID must be a string");
  }

  const trimmed = value.trim();
  if (!trimmed || !trimmed.startsWith("http")) {
    throw new Error(`Invalid follower actor ID: ${value}`);
  }

  return trimmed;
}

function normalizeRkey(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Record rkey must be a non-empty string");
  }

  return value.trim();
}

function normalizeOperation(value) {
  if (value === "create" || value === "update" || value === "delete") {
    return value;
  }

  throw new Error(`Unsupported operation: ${value}`);
}

function readPublishedAt(object, activity) {
  if (typeof object?.published === "string" && object.published) {
    return object.published;
  }

  if (typeof activity?.published === "string" && activity.published) {
    return activity.published;
  }

  return null;
}

function compareIsoDatesDesc(left, right) {
  const leftTime = Date.parse(left ?? "");
  const rightTime = Date.parse(right ?? "");

  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return rightTime - leftTime;
  }

  if (Number.isFinite(leftTime)) {
    return -1;
  }

  if (Number.isFinite(rightTime)) {
    return 1;
  }

  return 0;
}

function normalizeLimit(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(Math.trunc(value), 1), 80);
  }

  return 20;
}

function normalizeDurationMs(value, fallback) {
  if (value === null) {
    return Number.POSITIVE_INFINITY;
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(Math.trunc(value), 0);
  }

  return fallback;
}

function normalizeMaxRecords(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(Math.trunc(value), 0);
  }

  return fallback;
}

function isObjectExpired(record, nowMs, { objectCacheTtlMs, tombstoneCacheTtlMs }) {
  const ttlMs = record?.deleted ? tombstoneCacheTtlMs : objectCacheTtlMs;
  if (!Number.isFinite(ttlMs)) {
    return false;
  }

  const anchorMs = recordAccessTime(record);
  return Number.isFinite(anchorMs) && nowMs - anchorMs > ttlMs;
}

function recordAccessTime(record) {
  return parseIsoMs(record?.lastAccessedAt)
    ?? parseIsoMs(record?.updatedAt)
    ?? parseIsoMs(record?.publishedAt)
    ?? parseIsoMs(record?.cachedAt)
    ?? 0;
}

function actorHasProfileFields(actor) {
  return Object.prototype.hasOwnProperty.call(actor, "displayName")
    || Object.prototype.hasOwnProperty.call(actor, "summary")
    || Object.prototype.hasOwnProperty.call(actor, "avatarUrl")
    || Object.prototype.hasOwnProperty.call(actor, "bannerUrl")
    || Object.prototype.hasOwnProperty.call(actor, "pinnedPostUri");
}

function hasCachedProfile(actor) {
  return actor?.displayName != null
    || actor?.summary != null
    || actor?.avatarUrl != null
    || actor?.bannerUrl != null
    || actor?.pinnedPostUri != null
    || actor?.profileFetchedAt != null;
}

function isProfileExpired(actor, nowMs, ttlMs) {
  if (!Number.isFinite(ttlMs)) {
    return false;
  }

  const anchorMs = parseIsoMs(actor?.profileLastAccessedAt)
    ?? parseIsoMs(actor?.profileFetchedAt)
    ?? parseIsoMs(actor?.updatedAt);
  return Number.isFinite(anchorMs) && nowMs - anchorMs > ttlMs;
}

function isActorIdentityExpired(actor, nowMs, ttlMs) {
  if (!Number.isFinite(ttlMs)) {
    return false;
  }

  const anchorMs = parseIsoMs(actor?.updatedAt);
  return Number.isFinite(anchorMs) && nowMs - anchorMs > ttlMs;
}

function clearCachedProfile(actor) {
  actor.displayName = null;
  actor.summary = null;
  actor.avatarUrl = null;
  actor.bannerUrl = null;
  actor.pinnedPostUri = null;
  actor.profileFetchedAt = null;
  actor.profileLastAccessedAt = null;
}

function isoFromMs(value) {
  return new Date(value).toISOString();
}

function parseIsoMs(value) {
  if (typeof value !== "string" || !value) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeOptionalIsoString(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return new Date(parsed).toISOString();
}
