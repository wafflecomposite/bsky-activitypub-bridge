import { actorId, objectId } from "../domain/identifiers.js";
import { buildAudience, mapBskyPostToActivityPub, parseAtPostUri } from "../bridge/post-mapper.js";
import { planDeliveryTargets } from "../delivery/recipient-planner.js";

export class JetstreamProcessor {
  #state;
  #queue;
  #store;
  #baseUrl;
  #shardId;
  #postVisibility;

  constructor({ state, queue, store, baseUrl, shardId = "default", postVisibility = "unlisted" }) {
    this.#state = state;
    this.#queue = queue;
    this.#store = store;
    this.#baseUrl = baseUrl;
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
  if (typeof store?.upsertObjectActivity !== "function") {
    return;
  }

  const cacheKey = collection === "app.bsky.feed.post"
    ? rkey
    : `${collection}:${rkey}`;
  const object = activity?.object && typeof activity.object === "object"
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

  const subjectUri = record?.subject?.uri;
  if (typeof subjectUri !== "string") {
    throw new Error("Jetstream repost missing subject.uri");
  }

  const parsed = parseAtPostUri(subjectUri);
  const objectRef = parsed
    ? objectId(baseUrl, parsed.did, parsed.rkey)
    : subjectUri;

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
        object: objectRef
      }
    };
  }

  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${announceObjectId}/activity/announce`,
    type: "Announce",
    actor,
    published: typeof record?.createdAt === "string" ? record.createdAt : undefined,
    to: audience.to,
    cc: audience.cc,
    object: objectRef
  };
}
