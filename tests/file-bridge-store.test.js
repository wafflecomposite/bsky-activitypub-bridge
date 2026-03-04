import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileBridgeStore } from "../src/storage/file-bridge-store.js";

test("FileBridgeStore persists actors and followers", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-store-"));
  const filePath = join(dir, "store.json");

  try {
    const store1 = new FileBridgeStore({ filePath });
    store1.upsertActor({
      did: "did:plc:alice",
      handle: "alice.bsky.social",
      pinnedPostUri: "at://did:plc:alice/app.bsky.feed.post/pin1"
    });
    store1.addFollower("did:plc:alice", {
      actorId: "https://remote.example/users/bob",
      inboxUrl: "https://remote.example/users/bob/inbox"
    });

    const store2 = new FileBridgeStore({ filePath });
    assert.equal(store2.resolveDidByHandle("alice.bsky.social"), "did:plc:alice");
    assert.equal(
      store2.getActorByDid("did:plc:alice").pinnedPostUri,
      "at://did:plc:alice/app.bsky.feed.post/pin1"
    );
    assert.equal(store2.listFollowers("did:plc:alice").length, 1);
    assert.deepEqual(store2.listFollowedDids(), ["did:plc:alice"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileBridgeStore persists object cache and outbox activity list", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-store-"));
  const filePath = join(dir, "store.json");

  try {
    const store1 = new FileBridgeStore({ filePath });
    store1.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
    store1.upsertObjectActivity({
      did: "did:plc:alice",
      rkey: "post-1",
      operation: "create",
      object: {
        id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/post-1",
        type: "Note",
        published: "2026-03-04T00:00:01.000Z"
      },
      activity: {
        id: "https://bridge.example/ap/object/did%3Aplc%3Aalice/post-1/activity/create",
        type: "Create",
        published: "2026-03-04T00:00:01.000Z"
      }
    });

    const store2 = new FileBridgeStore({ filePath });
    const object = store2.getObjectByRkey("did:plc:alice", "post-1");
    assert.equal(object.deleted, false);
    assert.equal(object.object.type, "Note");
    assert.equal(store2.listOutboxActivities("did:plc:alice").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileBridgeStore preserves profile fields on partial actor upsert", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-store-"));
  const filePath = join(dir, "store.json");

  try {
    const store = new FileBridgeStore({ filePath });
    store.upsertActor({
      did: "did:plc:alice",
      handle: "alice.bsky.social",
      displayName: "Alice",
      avatarUrl: "https://cdn.bsky.app/avatar/alice.jpg",
      profileFetchedAt: "2026-03-04T00:00:00.000Z"
    });
    store.upsertActor({
      did: "did:plc:alice",
      handle: "alice.bsky.social"
    });

    const reloaded = new FileBridgeStore({ filePath });
    const actor = reloaded.getActorByDid("did:plc:alice");
    assert.equal(actor.displayName, "Alice");
    assert.equal(actor.avatarUrl, "https://cdn.bsky.app/avatar/alice.jpg");
    assert.equal(actor.profileFetchedAt, "2026-03-04T00:00:00.000Z");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
