import { buildActorDocument } from "../ap/actor.js";
import { blueskyBlobUrl } from "../bsky/web-url.js";
import { InMemoryKeyManager } from "../crypto/key-manager.js";
import { actorId, objectId } from "../domain/identifiers.js";
import { buildAudience, mapBskyPostToActivityPub, mapBskyRepostToActivityPub } from "../bridge/post-mapper.js";
import { planDeliveryTargets } from "../delivery/recipient-planner.js";

export class JetstreamProcessor {
  #state;
  #queue;
  #store;
  #baseUrl;
  #shardId;
  #postVisibility;
  #keyManager;

  constructor({ state, queue, store, baseUrl, keyManager = new InMemoryKeyManager(), shardId = "default", postVisibility = "unlisted" }) {
    this.#state = state;
    this.#queue = queue;
    this.#store = store;
    this.#baseUrl = baseUrl;
    this.#keyManager = keyManager;
    this.#shardId = shardId;
    this.#postVisibility = postVisibility;
  }

  process(event) {
    let parsed;
    try {
      parsed = normalizeJetstreamEvent(event);
    } catch (error) {
      return {
        status: "invalid-event",
        enqueued: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    const note = this.#state.noteEvent(this.#shardId, parsed.eventKey, parsed.timeUs);

    if (note.duplicate) {
      return {
        status: "duplicate",
        cursor: note.cursor,
        enqueued: 0
      };
    }

    if (!isSupportedCommit(parsed)) {
      return {
        status: "ignored",
        cursor: note.cursor,
        enqueued: 0
      };
    }

    if (parsed.collection === "app.bsky.actor.profile") {
      return this.#processProfileCommit({ parsed, cursor: note.cursor });
    }

    let activity;
    try {
      activity = mapEventToActivity({
        baseUrl: this.#baseUrl,
        store: this.#store,
        did: parsed.did,
        rkey: parsed.rkey,
        collection: parsed.collection,
        operation: parsed.operation,
        record: parsed.record,
        visibility: this.#postVisibility
      });
    } catch (error) {
      return {
        status: "invalid-event",
        cursor: note.cursor,
        enqueued: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    persistMappedActivity({
      store: this.#store,
      did: parsed.did,
      rkey: parsed.rkey,
      collection: parsed.collection,
      operation: parsed.operation,
      activity,
      cursor: note.cursor
    });

    const followers = this.#store.listFollowers(parsed.did);
    if (followers.length === 0) {
      return {
        status: "no-followers",
        cursor: note.cursor,
        enqueued: 0
      };
    }

    const deliveryPlan = planDeliveryTargets(followers);

    if (deliveryPlan.deliveries.length === 0) {
      return {
        status: "no-delivery-targets",
        cursor: note.cursor,
        enqueued: 0,
        skipped: deliveryPlan.skipped
      };
    }

    let enqueued = 0;
    for (const delivery of deliveryPlan.deliveries) {
      this.#queue.enqueue({
        did: parsed.did,
        rkey: parsed.rkey,
        destination: delivery.destination,
        recipientActorIds: delivery.recipients,
        activity,
        cursor: note.cursor,
        operation: parsed.operation
      });
      enqueued += 1;
    }

    return {
      status: "enqueued",
      cursor: note.cursor,
      enqueued,
      skipped: deliveryPlan.skipped
    };
  }

  #processProfileCommit({ parsed, cursor }) {
    const existing = this.#store.getActorByDid(parsed.did);
    if (!existing) {
      return {
        status: "profile-no-actor",
        cursor,
        enqueued: 0
      };
    }

    let nextActor;
    try {
      nextActor = mapProfileCommitToActor({
        did: parsed.did,
        operation: parsed.operation,
        record: parsed.record,
        existing
      });
    } catch (error) {
      return {
        status: "invalid-event",
        cursor,
        enqueued: 0,
        error: error instanceof Error ? error.message : String(error)
      };
    }

    const changed = hasActorProfileChanged(existing, nextActor);
    const updatedActor = this.#store.upsertActor({
      ...nextActor,
      profileFetchedAt: new Date().toISOString()
    });

    if (!changed) {
      return {
        status: "profile-unchanged",
        cursor,
        enqueued: 0
      };
    }

    const followers = this.#store.listFollowers(parsed.did);
    if (followers.length === 0) {
      return {
        status: "no-followers",
        cursor,
        enqueued: 0
      };
    }

    const deliveryPlan = planDeliveryTargets(followers);
    if (deliveryPlan.deliveries.length === 0) {
      return {
        status: "no-delivery-targets",
        cursor,
        enqueued: 0,
        skipped: deliveryPlan.skipped
      };
    }

    const actor = actorId(this.#baseUrl, parsed.did);
    const audience = buildAudience({ baseUrl: this.#baseUrl, did: parsed.did, visibility: this.#postVisibility });
    const keys = this.#keyManager.ensureKeyPair(parsed.did);
    const activity = {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actor}/activity/update/${encodeURIComponent(String(parsed.timeUs ?? Date.now()))}`,
      type: "Update",
      actor,
      to: audience.to,
      cc: audience.cc,
      object: buildActorDocument({
        baseUrl: this.#baseUrl,
        profile: updatedActor,
        publicKeyPem: keys.publicKeyPem
      })
    };

    let enqueued = 0;
    for (const delivery of deliveryPlan.deliveries) {
      this.#queue.enqueue({
        did: parsed.did,
        rkey: `profile:${parsed.rkey}`,
        destination: delivery.destination,
        recipientActorIds: delivery.recipients,
        activity,
        cursor,
        operation: "profile-update"
      });
      enqueued += 1;
    }

    return {
      status: "enqueued",
      cursor,
      enqueued,
      skipped: deliveryPlan.skipped
    };
  }
}

export class InMemoryDeliveryQueue {
  #items = [];

  enqueue(item) {
    this.#items.push(item);
  }

  dequeue() {
    if (this.#items.length === 0) {
      return null;
    }

    return this.#items.shift();
  }

  size() {
    return this.#items.length;
  }

  list() {
    return [...this.#items];
  }

  clear() {
    this.#items = [];
  }
}

function normalizeJetstreamEvent(event) {
  if (!event || typeof event !== "object") {
    throw new Error("Jetstream event must be an object");
  }

  const did = event.did;
  if (typeof did !== "string") {
    throw new Error("Jetstream event missing did");
  }

  const commit = event.commit;
  if (!commit || typeof commit !== "object") {
    throw new Error("Jetstream event missing commit object");
  }

  const collection = commit.collection;
  const operation = commit.operation;
  const rkey = commit.rkey;

  if (typeof collection !== "string" || typeof operation !== "string" || typeof rkey !== "string") {
    throw new Error("Jetstream commit missing required fields");
  }

  const timeUs = normalizeTimeUs(event.time_us);

  return {
    did,
    operation,
    collection,
    rkey,
    record: commit.record,
    timeUs,
    eventKey: `${did}|${collection}|${rkey}|${operation}|${event.time_us ?? "none"}`
  };
}

function isSupportedCommit(parsed) {
  if (parsed.collection === "app.bsky.actor.profile") {
    return ["create", "update", "delete"].includes(parsed.operation);
  }

  if (!["app.bsky.feed.post", "app.bsky.feed.repost"].includes(parsed.collection)) {
    return false;
  }

  return ["create", "update", "delete"].includes(parsed.operation);
}

function mapEventToActivity({ baseUrl, store, did, rkey, collection, operation, record, visibility }) {
  if (collection === "app.bsky.feed.repost") {
    return mapRepostEventToActivity({
      baseUrl,
      did,
      rkey,
      operation,
      record,
      visibility
    });
  }

  if (operation === "delete") {
    const actor = actorId(baseUrl, did);
    const id = objectId(baseUrl, did, rkey);
    const audience = buildAudience({ baseUrl, did, visibility });

    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${id}/activity/delete`,
      type: "Delete",
      actor,
      object: id,
      to: audience.to,
      cc: audience.cc
    };
  }

  if (!record || typeof record !== "object") {
    throw new Error(`Jetstream ${operation} missing record`);
  }

  const mapped = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey,
    record,
    visibility,
    resolveReplyObjectId: (replyDid, replyRkey) => resolveBridgedReplyObjectId({
      baseUrl,
      store,
      replyDid,
      replyRkey
    })
  });

  if (operation === "update") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${mapped.note.id}/activity/update`,
      type: "Update",
      actor: mapped.create.actor,
      to: mapped.create.to,
      cc: mapped.create.cc,
      object: mapped.note
    };
  }

  return mapped.create;
}

function normalizeTimeUs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function persistMappedActivity({ store, did, rkey, collection, operation, activity, cursor }) {
  if (!["app.bsky.feed.post", "app.bsky.feed.repost"].includes(collection)) {
    return;
  }

  if (typeof store?.upsertObjectActivity !== "function") {
    return;
  }

  const cacheKey = collection === "app.bsky.feed.post"
    ? rkey
    : `repost:${rkey}`;
  const object = collection === "app.bsky.feed.repost" && activity?.type === "Announce"
    ? activity
    : activity?.object && typeof activity.object === "object"
    ? activity.object
    : null;

  store.upsertObjectActivity({
    did,
    rkey: cacheKey,
    operation,
    object,
    activity,
    cursor
  });
}

function mapProfileCommitToActor({ did, operation, record, existing }) {
  if (operation !== "delete" && (!record || typeof record !== "object")) {
    throw new Error(`Jetstream ${operation} missing profile record`);
  }

  const profile = operation === "delete" ? {} : record;

  return {
    did,
    handle: existing.handle,
    displayName: readOptionalString(profile.displayName),
    summary: readOptionalString(profile.description),
    avatarUrl: profileBlobUrl({ did, blob: profile.avatar }),
    bannerUrl: profileBlobUrl({ did, blob: profile.banner }),
    pinnedPostUri: extractPinnedPostUri(profile)
  };
}

function hasActorProfileChanged(existing, nextActor) {
  return existing.displayName !== nextActor.displayName
    || existing.summary !== nextActor.summary
    || existing.avatarUrl !== nextActor.avatarUrl
    || existing.bannerUrl !== nextActor.bannerUrl
    || existing.pinnedPostUri !== nextActor.pinnedPostUri;
}

function readOptionalString(value) {
  return typeof value === "string" && value ? value : null;
}

function profileBlobUrl({ did, blob }) {
  const cid = extractBlobCid(blob);
  return cid ? blueskyBlobUrl({ did, cid }) : null;
}

function extractBlobCid(blob) {
  if (!blob || typeof blob !== "object") {
    return null;
  }

  if (typeof blob?.ref?.$link === "string") {
    return blob.ref.$link;
  }

  if (typeof blob.ref === "string") {
    return blob.ref;
  }

  if (typeof blob.cid === "string") {
    return blob.cid;
  }

  return null;
}

function extractPinnedPostUri(profile) {
  const direct = profile?.pinnedPost?.uri;
  if (typeof direct === "string" && direct) {
    return direct;
  }

  return null;
}

function resolveBridgedReplyObjectId({ baseUrl, store, replyDid, replyRkey }) {
  if (typeof store?.getObjectByRkey !== "function") {
    return null;
  }

  try {
    const cached = store.getObjectByRkey(replyDid, replyRkey);
    if (!cached || cached.deleted) {
      return null;
    }

    return objectId(baseUrl, replyDid, replyRkey);
  } catch {
    return null;
  }
}

function mapRepostEventToActivity({ baseUrl, did, rkey, operation, record, visibility }) {
  const actor = actorId(baseUrl, did);
  const announceObjectId = objectId(baseUrl, did, `repost:${rkey}`);
  const audience = buildAudience({ baseUrl, did, visibility });

  if (operation === "delete") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${announceObjectId}/activity/delete`,
      type: "Delete",
      actor,
      object: announceObjectId,
      to: audience.to,
      cc: audience.cc
    };
  }

  const mapped = mapBskyRepostToActivityPub({
    baseUrl,
    did,
    rkey,
    record,
    visibility
  });

  if (operation === "update") {
    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${announceObjectId}/activity/update`,
      type: "Update",
      actor,
      to: audience.to,
      cc: audience.cc,
      object: {
        id: announceObjectId,
        type: "Announce",
        actor,
        published: typeof record?.createdAt === "string" ? record.createdAt : undefined,
        object: mapped.announce.object
      }
    };
  }

  return mapped.announce;
}
