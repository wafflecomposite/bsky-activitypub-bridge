export function blueskyProfileUrl({ did, handle = null }) {
  const profileId = typeof handle === "string" && handle.trim()
    ? handle.trim()
    : did;

  return `https://bsky.app/profile/${profileId}`;
}

export function blueskyPostUrl({ did, rkey, handle = null }) {
  return `${blueskyProfileUrl({ did, handle })}/post/${rkey}`;
}

export function blueskyBlobUrl({ did, cid }) {
  return `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`;
}
