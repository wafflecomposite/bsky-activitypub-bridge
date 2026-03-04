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
    store1.upsertActor({ did: "did:plc:alice", handle: "alice.bsky.social" });
    store1.addFollower("did:plc:alice", {
      actorId: "https://remote.example/users/bob",
      inboxUrl: "https://remote.example/users/bob/inbox"
    });

    const store2 = new FileBridgeStore({ filePath });
    assert.equal(store2.resolveDidByHandle("alice.bsky.social"), "did:plc:alice");
    assert.equal(store2.listFollowers("did:plc:alice").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
