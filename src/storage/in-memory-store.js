import { assertDid, assertHandle } from "../domain/identifiers.js";

export class InMemoryBridgeStore {
  #actorsByDid = new Map();
  #didByHandle = new Map();
  #followersByDid = new Map();
  #recordsByDid = new Map();

  upsertActor(actor) {
    const did = assertDid(actor.did);
    const handle = assertHandle(actor.handle);
    const existing = this.#actorsByDid.get(did) ?? null;
    const hasOwn = (key) => Object.prototype.hasOwnProperty.call(actor, key);

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
      updatedAt: new Date().toISOString()
    };

    if (existing?.handle && existing.handle !== handle) {
      this.#didByHandle.delete(existing.handle);
    }

    this.#actorsByDid.set(did, normalized);
    this.#didByHandle.set(handle, did);

    return normalized;
  }

  getActorByDid(did) {
    return this.#actorsByDid.get(assertDid(did)) ?? null;
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
      followedAt: existing?.followedAt ?? new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastFollowActivityId: follower.followActivityId ?? existing?.lastFollowActivityId ?? null
    };

    followers.set(followerActorId, normalized);

    return normalized;
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

    const nowIso = new Date().toISOString();
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
      updatedAt: nowIso
    };

    records.set(normalizedRkey, next);
    return next;
  }

  getObjectByRkey(did, rkey) {
    const actorDid = assertDid(did);
    const normalizedRkey = normalizeRkey(rkey);
    const records = this.#recordsByDid.get(actorDid);

    if (!records) {
      return null;
    }

    return records.get(normalizedRkey) ?? null;
  }

  listOutboxActivities(did, { limit = 20 } = {}) {
    const actorDid = assertDid(did);
    const records = this.#recordsByDid.get(actorDid);
    if (!records) {
      return [];
    }

    return Array.from(records.values())
      .filter((entry) => entry.activity && typeof entry.activity === "object")
      .sort((a, b) => compareIsoDatesDesc(a.publishedAt, b.publishedAt))
      .slice(0, normalizeLimit(limit))
      .map((entry) => entry.activity);
  }

  countOutboxActivities(did) {
    const actorDid = assertDid(did);
    const records = this.#recordsByDid.get(actorDid);
    if (!records) {
      return 0;
    }

    let total = 0;
    for (const entry of records.values()) {
      if (entry.activity && typeof entry.activity === "object") {
        total += 1;
      }
    }
    return total;
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
