import { assertDid, assertHandle } from "../domain/identifiers.js";

const PUBLIC_API_BASE = "https://public.api.bsky.app/xrpc";

export async function resolveHandleToDid({ handle, fetchImpl = fetch }) {
  const normalizedHandle = assertHandle(handle);
  const response = await fetchImpl(`${PUBLIC_API_BASE}/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(normalizedHandle)}`, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`resolveHandle failed: ${response.status}`);
  }

  const body = await response.json();
  if (typeof body?.did !== "string") {
    throw new Error("resolveHandle returned invalid DID");
  }

  return assertDid(body.did);
}

export async function getProfile({ actor, fetchImpl = fetch }) {
  const response = await fetchImpl(`${PUBLIC_API_BASE}/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, {
    method: "GET",
    headers: {
      accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`getProfile failed: ${response.status}`);
  }

  const body = await response.json();
  const did = assertDid(body.did);
  const handle = assertHandle(body.handle);

  return {
    did,
    handle,
    displayName: typeof body.displayName === "string" && body.displayName ? body.displayName : null,
    description: typeof body.description === "string" && body.description ? body.description : null,
    avatarUrl: typeof body.avatar === "string" && body.avatar ? body.avatar : null,
    bannerUrl: typeof body.banner === "string" && body.banner ? body.banner : null,
    pinnedPostUri: extractPinnedPostUri(body)
  };
}

export async function getPostRecord({ did, rkey, fetchImpl = fetch }) {
  const actorDid = assertDid(did);
  if (typeof rkey !== "string" || !rkey.trim()) {
    throw new Error("Invalid post rkey");
  }

  const response = await fetchImpl(
    `${PUBLIC_API_BASE}/com.atproto.repo.getRecord?repo=${encodeURIComponent(actorDid)}&collection=app.bsky.feed.post&rkey=${encodeURIComponent(rkey)}`,
    {
      method: "GET",
      headers: {
        accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`getRecord failed: ${response.status}`);
  }

  const body = await response.json();
  const value = body?.value;
  if (!value || typeof value !== "object") {
    throw new Error("getRecord returned invalid value");
  }

  return {
    uri: typeof body?.uri === "string" ? body.uri : null,
    cid: typeof body?.cid === "string" ? body.cid : null,
    value
  };
}

function extractPinnedPostUri(profile) {
  if (typeof profile?.pinnedPost === "string" && profile.pinnedPost) {
    return profile.pinnedPost;
  }

  const direct = profile?.pinnedPost?.uri;
  if (typeof direct === "string" && direct) {
    return direct;
  }

  const byRecord = profile?.pinnedPost?.record?.uri;
  if (typeof byRecord === "string" && byRecord) {
    return byRecord;
  }

  const byValue = profile?.pinnedPost?.value?.uri;
  if (typeof byValue === "string" && byValue) {
    return byValue;
  }

  return null;
}
