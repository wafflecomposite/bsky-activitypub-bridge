import { randomUUID } from "node:crypto";
import { actorId } from "../domain/identifiers.js";

export function processInboxActivity({ activity, targetDid, baseUrl, store }) {
  if (!activity || typeof activity !== "object") {
    return {
      status: 400,
      body: { error: "Activity body must be a JSON object" }
    };
  }

  if (activity.type !== "Follow") {
    return {
      status: 501,
      body: { error: `Unsupported activity type: ${activity.type ?? "unknown"}` }
    };
  }

  const targetActorId = actorId(baseUrl, targetDid);
  const objectId = normalizeObjectId(activity.object);

  if (objectId !== targetActorId) {
    return {
      status: 400,
      body: {
        error: "Follow object must target this actor",
        expected: targetActorId,
        received: objectId
      }
    };
  }

  const resolvedFollower = normalizeResolvedFollower(activity.resolvedFollower);
  const followerActorId = resolvedFollower?.actorId ?? normalizeActorId(activity.actor);

  const follower = store.addFollower(targetDid, {
    actorId: followerActorId,
    followActivityId: normalizeOptionalString(activity.id),
    inboxUrl: resolvedFollower?.inboxUrl ?? extractOptionalInbox(activity.actor),
    sharedInboxUrl: resolvedFollower?.sharedInboxUrl ?? extractOptionalSharedInbox(activity.actor)
  });

  const accept = buildAcceptActivity({
    targetActorId,
    follow: activity
  });

  return {
    status: 202,
    body: {
      status: "accepted",
      follower,
      accept
    }
  };
}

export function buildAcceptActivity({ targetActorId, follow }) {
  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${targetActorId}/activities/accept/${randomUUID()}`,
    type: "Accept",
    actor: targetActorId,
    to: [normalizeActorId(follow.actor)],
    object: follow
  };
}

function normalizeActorId(actorField) {
  if (typeof actorField === "string") {
    return ensureHttpUrl(actorField, "actor");
  }

  if (actorField && typeof actorField === "object" && typeof actorField.id === "string") {
    return ensureHttpUrl(actorField.id, "actor.id");
  }

  throw new Error("Follow actor must be a string ID or object with id");
}

function normalizeObjectId(objectField) {
  if (typeof objectField === "string") {
    return objectField;
  }

  if (objectField && typeof objectField === "object" && typeof objectField.id === "string") {
    return objectField.id;
  }

  throw new Error("Follow object must be a string ID or object with id");
}

function extractOptionalInbox(actorField) {
  if (!actorField || typeof actorField !== "object") {
    return null;
  }

  if (typeof actorField.inbox !== "string") {
    return null;
  }

  return ensureHttpUrl(actorField.inbox, "actor.inbox");
}

function extractOptionalSharedInbox(actorField) {
  if (!actorField || typeof actorField !== "object") {
    return null;
  }

  const sharedInbox = actorField.endpoints?.sharedInbox;
  if (typeof sharedInbox !== "string") {
    return null;
  }

  return ensureHttpUrl(sharedInbox, "actor.endpoints.sharedInbox");
}

function ensureHttpUrl(value, fieldName) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`Invalid ${fieldName}: ${value}`);
  }

  return parsed.toString();
}

function normalizeOptionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeResolvedFollower(value) {
  if (!value) {
    return null;
  }

  if (typeof value !== "object") {
    throw new Error("resolvedFollower must be an object");
  }

  if (typeof value.actorId !== "string") {
    throw new Error("resolvedFollower.actorId must be a string");
  }

  return {
    actorId: ensureHttpUrl(value.actorId, "resolvedFollower.actorId"),
    inboxUrl: value.inboxUrl ? ensureHttpUrl(value.inboxUrl, "resolvedFollower.inboxUrl") : null,
    sharedInboxUrl: value.sharedInboxUrl ? ensureHttpUrl(value.sharedInboxUrl, "resolvedFollower.sharedInboxUrl") : null
  };
}
