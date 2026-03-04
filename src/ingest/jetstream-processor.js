import { actorId, objectId } from "../domain/identifiers.js";
import { mapBskyPostToActivityPub } from "../bridge/post-mapper.js";
import { planDeliveryTargets } from "../delivery/recipient-planner.js";

export class JetstreamProcessor {
  #state;
  #queue;
  #store;
  #baseUrl;
  #shardId;

  constructor({ state, queue, store, baseUrl, shardId = "default" }) {
    this.#state = state;
    this.#queue = queue;
    this.#store = store;
    this.#baseUrl = baseUrl;
    this.#shardId = shardId;
  }

  process(event) {
    const parsed = normalizeJetstreamEvent(event);
    const note = this.#state.noteEvent(this.#shardId, parsed.eventKey, parsed.timeUs);

    if (note.duplicate) {
      return {
        status: "duplicate",
        cursor: note.cursor,
        enqueued: 0
      };
    }

    if (!isPostCommit(parsed)) {
      return {
        status: "ignored",
        cursor: note.cursor,
        enqueued: 0
      };
    }

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

    const activity = mapEventToActivity({
      baseUrl: this.#baseUrl,
      did: parsed.did,
      rkey: parsed.rkey,
      operation: parsed.operation,
      record: parsed.record
    });

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

function isPostCommit(parsed) {
  if (parsed.collection !== "app.bsky.feed.post") {
    return false;
  }

  return ["create", "update", "delete"].includes(parsed.operation);
}

function mapEventToActivity({ baseUrl, did, rkey, operation, record }) {
  if (operation === "delete") {
    const actor = actorId(baseUrl, did);
    const id = objectId(baseUrl, did, rkey);

    return {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${id}/activity/delete`,
      type: "Delete",
      actor,
      object: id,
      to: ["https://www.w3.org/ns/activitystreams#Public"]
    };
  }

  if (!record || typeof record !== "object") {
    throw new Error(`Jetstream ${operation} missing record`);
  }

  const mapped = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey,
    record
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
