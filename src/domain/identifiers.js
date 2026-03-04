const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const HANDLE_PATTERN = /^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ACCT_PREFIX = "acct:";

export function assertDid(value) {
  if (!DID_PATTERN.test(value)) {
    throw new Error(`Invalid DID: ${value}`);
  }

  return value;
}

export function assertHandle(value) {
  const normalized = value.toLowerCase();

  if (!HANDLE_PATTERN.test(normalized)) {
    throw new Error(`Invalid handle: ${value}`);
  }

  return normalized;
}

export function parseAcctResource(resource, bridgeHost) {
  if (!resource || typeof resource !== "string" || !resource.startsWith(ACCT_PREFIX)) {
    throw new Error("WebFinger resource must be an acct URI");
  }

  const accountPart = resource.slice(ACCT_PREFIX.length);
  const separator = accountPart.lastIndexOf("@");

  if (separator <= 0) {
    throw new Error("Malformed acct URI");
  }

  const handle = assertHandle(accountPart.slice(0, separator));
  const host = accountPart.slice(separator + 1).toLowerCase();
  const expectedHost = bridgeHost.toLowerCase();

  if (host !== expectedHost) {
    throw new Error(`WebFinger host mismatch: expected ${expectedHost} but got ${host}`);
  }

  return { handle, host };
}

export function encodeDidForPath(did) {
  return encodeURIComponent(assertDid(did));
}

export function decodeDidFromPath(pathValue) {
  return assertDid(decodeURIComponent(pathValue));
}

export function actorId(baseUrl, did) {
  return `${baseUrl}/ap/actor/${encodeDidForPath(did)}`;
}

export function actorInboxId(baseUrl, did) {
  return `${actorId(baseUrl, did)}/inbox`;
}

export function actorOutboxId(baseUrl, did) {
  return `${actorId(baseUrl, did)}/outbox`;
}

export function actorFollowersId(baseUrl, did) {
  return `${actorId(baseUrl, did)}/followers`;
}

export function actorFeaturedId(baseUrl, did) {
  return `${actorId(baseUrl, did)}/featured`;
}

export function objectId(baseUrl, did, rkey) {
  return `${baseUrl}/ap/object/${encodeDidForPath(did)}/${encodeURIComponent(rkey)}`;
}

export function webfingerSubject(handle, bridgeHost) {
  return `${ACCT_PREFIX}${assertHandle(handle)}@${bridgeHost.toLowerCase()}`;
}
