import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertDid, assertHandle } from "../domain/identifiers.js";

export class FileBridgeStore {
  #filePath;
  #actorsByDid = new Map();
  #didByHandle = new Map();
  #followersByDid = new Map();

  constructor({ filePath }) {
    if (!filePath) {
      throw new Error("FileBridgeStore requires filePath");
    }

    this.#filePath = filePath;
    this.#load();
  }

  upsertActor(actor) {
    const did = assertDid(actor.did);
    const handle = assertHandle(actor.handle);

    const normalized = {
      did,
      handle,
      displayName: actor.displayName ?? null,
      summary: actor.summary ?? null,
      avatarUrl: actor.avatarUrl ?? null,
      bannerUrl: actor.bannerUrl ?? null,
      updatedAt: new Date().toISOString()
    };

    this.#actorsByDid.set(did, normalized);
    this.#didByHandle.set(handle, did);
    this.#persist();

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
    this.#persist();

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

  #load() {
    if (!existsSync(this.#filePath)) {
      return;
    }

    const raw = readFileSync(this.#filePath, "utf8");
    if (!raw.trim()) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    for (const actor of parsed.actors ?? []) {
      if (!actor?.did || !actor?.handle) {
        continue;
      }

      const did = assertDid(actor.did);
      const handle = assertHandle(actor.handle);
      this.#actorsByDid.set(did, actor);
      this.#didByHandle.set(handle, did);
    }

    for (const [did, followers] of Object.entries(parsed.followersByDid ?? {})) {
      const map = new Map();
      for (const follower of followers ?? []) {
        if (typeof follower?.actorId !== "string") {
          continue;
        }

        map.set(follower.actorId, follower);
      }

      this.#followersByDid.set(did, map);
    }
  }

  #persist() {
    const actors = Array.from(this.#actorsByDid.values());
    const followersByDid = {};

    for (const [did, followers] of this.#followersByDid.entries()) {
      followersByDid[did] = Array.from(followers.values());
    }

    mkdirSync(dirname(this.#filePath), { recursive: true });
    writeFileSync(this.#filePath, JSON.stringify({
      actors,
      followersByDid
    }, null, 2));
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
