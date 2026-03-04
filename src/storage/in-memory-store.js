import { assertDid, assertHandle } from "../domain/identifiers.js";

export class InMemoryBridgeStore {
  #actorsByDid = new Map();
  #didByHandle = new Map();
  #followersByDid = new Map();

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
