import { createVerify } from "node:crypto";
import { buildDigestHeader } from "./http-signature.js";

export async function verifyInboxRequestSignature({ method, requestTarget, headers, body, fetchImpl = fetch, now = () => Date.now(), maxAgeSeconds = 300 }) {
  const normalizedHeaders = normalizeHeaders(headers);
  const signatureHeader = normalizedHeaders.signature;

  if (!signatureHeader) {
    return { ok: false, error: "Missing Signature header" };
  }

  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed.keyId || !parsed.signature) {
    return { ok: false, error: "Signature header missing keyId or signature" };
  }

  const dateHeader = normalizedHeaders.date;
  if (!dateHeader) {
    return { ok: false, error: "Missing Date header" };
  }

  const dateMs = Date.parse(dateHeader);
  if (!Number.isFinite(dateMs)) {
    return { ok: false, error: "Invalid Date header" };
  }

  const ageMs = Math.abs(now() - dateMs);
  if (ageMs > maxAgeSeconds * 1000) {
    return { ok: false, error: "Date header outside allowed skew" };
  }

  if (!verifyDigest(normalizedHeaders.digest, body)) {
    return { ok: false, error: "Invalid Digest header" };
  }

  const publicKeyPem = await fetchPublicKeyPem({ keyId: parsed.keyId, fetchImpl });
  if (!publicKeyPem) {
    return { ok: false, error: "Unable to resolve public key" };
  }

  const signedHeaders = (parsed.headers ?? "(request-target) host date digest").split(/\s+/).filter(Boolean);
  const signingString = buildSigningString({
    signedHeaders,
    method,
    requestTarget,
    headers: normalizedHeaders
  });

  const valid = createVerify("RSA-SHA256").update(signingString).verify(publicKeyPem, parsed.signature, "base64");

  return {
    ok: valid,
    keyId: parsed.keyId,
    actorId: parsed.keyId.split("#")[0],
    error: valid ? null : "Signature verification failed"
  };
}

async function fetchPublicKeyPem({ keyId, fetchImpl }) {
  const actorUrl = keyId.split("#")[0];

  const response = await fetchImpl(actorUrl, {
    method: "GET",
    headers: {
      accept: "application/activity+json, application/ld+json"
    }
  });

  if (!response || response.status < 200 || response.status >= 300) {
    return null;
  }

  let actor;
  try {
    actor = await response.json();
  } catch {
    return null;
  }

  if (actor?.publicKey?.id === keyId && typeof actor.publicKey.publicKeyPem === "string") {
    return actor.publicKey.publicKeyPem;
  }

  if (typeof actor?.publicKey?.publicKeyPem === "string") {
    return actor.publicKey.publicKeyPem;
  }

  return null;
}

function verifyDigest(digestHeader, body) {
  if (!digestHeader) {
    return false;
  }

  const expected = buildDigestHeader(body);
  return digestHeader === expected;
}

function buildSigningString({ signedHeaders, method, requestTarget, headers }) {
  return signedHeaders
    .map((name) => {
      if (name === "(request-target)") {
        return `(request-target): ${method.toLowerCase()} ${requestTarget}`;
      }

      const value = headers[name];
      if (!value) {
        throw new Error(`Signed header missing from request: ${name}`);
      }

      return `${name}: ${value}`;
    })
    .join("\n");
}

function parseSignatureHeader(value) {
  const result = {};

  for (const part of value.split(",")) {
    const idx = part.indexOf("=");
    if (idx < 0) {
      continue;
    }

    const key = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    result[key] = rawValue.replace(/^"/, "").replace(/"$/, "");
  }

  return result;
}

function normalizeHeaders(headers) {
  const normalized = {};

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value === "string") {
      normalized[key.toLowerCase()] = value;
      continue;
    }

    if (Array.isArray(value) && value.length > 0) {
      normalized[key.toLowerCase()] = value.join(", ");
    }
  }

  return normalized;
}
