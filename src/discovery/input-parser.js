import { assertDid, assertHandle } from "../domain/identifiers.js";
import { parseAtPostUri } from "../bridge/post-mapper.js";

export function parseDiscoveryInput(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("Discovery input cannot be empty");
  }

  const raw = unwrapInput(input.trim());
  const acctStripped = stripAcctPrefix(raw);

  const fromAtUri = parseAtUri(acctStripped);
  if (fromAtUri) {
    return fromAtUri;
  }

  const fromUrl = parseUrlLike(acctStripped);
  if (fromUrl) {
    return fromUrl;
  }

  const fromAcct = parseAcctLike(acctStripped);
  if (fromAcct) {
    return fromAcct;
  }

  const actor = parseActorIdentifier(acctStripped);
  if (actor) {
    return actor;
  }

  throw new Error("Unable to parse discovery input");
}

function parseAtUri(value) {
  const post = parseAtPostUri(value);
  if (post) {
    return {
      kind: "post",
      did: post.did,
      rkey: post.rkey
    };
  }

  const actorMatch = /^at:\/\/([^/]+)\/app\.bsky\.actor\.profile\/self$/i.exec(value);
  if (!actorMatch) {
    return null;
  }

  return {
    kind: "actor",
    did: assertDid(actorMatch[1])
  };
}

function parseUrlLike(value) {
  const url = toUrl(value);
  if (!url) {
    return null;
  }

  const fromBridgeObject = parseBridgeObjectUrl(url);
  if (fromBridgeObject) {
    return fromBridgeObject;
  }

  const fromBridgeActor = parseBridgeActorUrl(url);
  if (fromBridgeActor) {
    return fromBridgeActor;
  }

  const fromProfile = parseProfilePath(url);
  if (fromProfile) {
    return fromProfile;
  }

  const fromAtPath = parsePathAsAtUri(url);
  if (fromAtPath) {
    return fromAtPath;
  }

  const pathOnly = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!pathOnly) {
    return {
      kind: "actor",
      handle: assertHandle(url.host.toLowerCase())
    };
  }

  if (pathOnly.startsWith("@")) {
    const actor = parseActorIdentifier(pathOnly);
    if (actor) {
      return actor;
    }
  }

  return null;
}

function parseBridgeObjectUrl(url) {
  const match = /^\/ap\/object\/([^/]+)\/([^/]+)$/i.exec(url.pathname);
  if (!match) {
    return null;
  }

  return {
    kind: "post",
    did: assertDid(decodeURIComponent(match[1])),
    rkey: decodeURIComponent(match[2])
  };
}

function parseBridgeActorUrl(url) {
  const match = /^\/ap\/actor\/([^/]+)$/i.exec(url.pathname);
  if (!match) {
    return null;
  }

  return {
    kind: "actor",
    did: assertDid(decodeURIComponent(match[1]))
  };
}

function parseProfilePath(url) {
  const segments = url.pathname.split("/").filter(Boolean);
  const profileIndex = segments.findIndex((segment) => segment.toLowerCase() === "profile");
  if (profileIndex < 0 || profileIndex + 1 >= segments.length) {
    return null;
  }

  const identifier = decodeURIComponent(segments[profileIndex + 1]);
  const actorRef = parseActorReference(identifier);
  if (!actorRef) {
    return null;
  }

  const postSegment = segments[profileIndex + 2]?.toLowerCase();
  if (postSegment === "post" && profileIndex + 3 < segments.length) {
    const rkey = decodeURIComponent(segments[profileIndex + 3]);
    return {
      kind: "post",
      ...actorRef,
      rkey
    };
  }

  return {
    kind: "actor",
    ...actorRef
  };
}

function parsePathAsAtUri(url) {
  const trimmedPath = url.pathname.replace(/^\/+|\/+$/g, "");
  if (!trimmedPath.startsWith("at/")) {
    return null;
  }

  const candidate = `at://${trimmedPath.slice("at/".length)}`;
  return parseAtUri(candidate);
}

function parseAcctLike(value) {
  const withoutLeadingAt = value.startsWith("@") ? value.slice(1) : value;
  const separator = withoutLeadingAt.lastIndexOf("@");

  if (separator <= 0) {
    return null;
  }

  const localPart = withoutLeadingAt.slice(0, separator);
  const actor = parseActorReference(localPart);
  if (!actor) {
    return null;
  }

  return {
    kind: "actor",
    ...actor
  };
}

function parseActorIdentifier(value) {
  const actor = parseActorReference(value);
  if (!actor) {
    return null;
  }

  return {
    kind: "actor",
    ...actor
  };
}

function parseActorReference(value) {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().replace(/^@+/, "");
  if (!normalized) {
    return null;
  }

  if (/^did:/i.test(normalized)) {
    try {
      return { did: assertDid(normalized) };
    } catch {
      return null;
    }
  }

  try {
    return { handle: assertHandle(normalized) };
  } catch {
    return null;
  }
}

function stripAcctPrefix(value) {
  return value.toLowerCase().startsWith("acct:") ? value.slice("acct:".length) : value;
}

function unwrapInput(value) {
  if (value.startsWith("<") && value.endsWith(">") && value.length > 2) {
    return value.slice(1, -1).trim();
  }

  return value;
}

function toUrl(value) {
  try {
    return new URL(value);
  } catch {
    if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/.*)?$/i.test(value)) {
      try {
        return new URL(`https://${value}`);
      } catch {
        return null;
      }
    }
  }

  return null;
}
