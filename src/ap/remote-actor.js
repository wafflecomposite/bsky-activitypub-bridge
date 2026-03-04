import { actorId } from "../domain/identifiers.js";
import { createSignedGetHeaders } from "../federation/http-signature.js";

export async function resolveFollowerEndpoints({ activity, targetDid, baseUrl, keyManager, fetchImpl = fetch }) {
  const actorRef = normalizeActorId(activity.actor);
  const embeddedInbox = extractOptionalInbox(activity.actor);
  const embeddedSharedInbox = extractOptionalSharedInbox(activity.actor);

  if (embeddedInbox) {
    return {
      actorId: actorRef,
      inboxUrl: embeddedInbox,
      sharedInboxUrl: embeddedSharedInbox
    };
  }

  const remoteActor = await fetchRemoteActor({
    actorUrl: actorRef,
    signerDid: targetDid,
    baseUrl,
    keyManager,
    fetchImpl
  });

  return {
    actorId: actorRef,
    inboxUrl: remoteActor.inboxUrl,
    sharedInboxUrl: remoteActor.sharedInboxUrl
  };
}

async function fetchRemoteActor({ actorUrl, signerDid, baseUrl, keyManager, fetchImpl }) {
  const key = keyManager.ensureKeyPair(signerDid);
  const keyId = `${actorId(baseUrl, signerDid)}#main-key`;

  const signedHeaders = createSignedGetHeaders({
    destination: actorUrl,
    keyId,
    privateKeyPem: key.privateKeyPem
  });

  const response = await fetchImpl(actorUrl, {
    method: "GET",
    headers: {
      ...signedHeaders,
      accept: "application/activity+json, application/ld+json"
    }
  });

  if (!response || response.status < 200 || response.status >= 300) {
    const status = response?.status ?? "network-error";
    throw new Error(`Unable to fetch remote actor: ${actorUrl} (${status})`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Remote actor payload is not valid JSON: ${actorUrl}`);
  }

  const inboxUrl = ensureOptionalHttpUrl(body?.inbox, "actor.inbox");
  if (!inboxUrl) {
    throw new Error(`Remote actor is missing inbox: ${actorUrl}`);
  }

  const sharedInboxUrl = ensureOptionalHttpUrl(body?.endpoints?.sharedInbox, "actor.endpoints.sharedInbox");

  return {
    inboxUrl,
    sharedInboxUrl
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

function extractOptionalInbox(actorField) {
  if (!actorField || typeof actorField !== "object") {
    return null;
  }

  return ensureOptionalHttpUrl(actorField.inbox, "actor.inbox");
}

function extractOptionalSharedInbox(actorField) {
  if (!actorField || typeof actorField !== "object") {
    return null;
  }

  return ensureOptionalHttpUrl(actorField.endpoints?.sharedInbox, "actor.endpoints.sharedInbox");
}

function ensureOptionalHttpUrl(value, fieldName) {
  if (typeof value !== "string") {
    return null;
  }

  return ensureHttpUrl(value, fieldName);
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
