export function blueskyProfileUrl({ did, handle = null }) {
  const profileId = typeof handle === "string" && handle.trim()
    ? handle.trim()
    : did;

  return `https://bsky.app/profile/${profileId}`;
}

export function blueskyPostUrl({ did, rkey, handle = null }) {
  return `${blueskyProfileUrl({ did, handle })}/post/${rkey}`;
}
