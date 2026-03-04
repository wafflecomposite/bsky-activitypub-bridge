import test from "node:test";
import assert from "node:assert/strict";
import { RemoteActorCache } from "../src/ap/remote-actor-cache.js";

test("RemoteActorCache stores and returns entries before expiry", () => {
  let now = 1000;
  const cache = new RemoteActorCache({
    ttlMs: 500,
    now: () => now
  });

  cache.set("https://remote.example/users/bob", {
    inboxUrl: "https://remote.example/users/bob/inbox",
    sharedInboxUrl: "https://remote.example/inbox"
  });

  const value = cache.get("https://remote.example/users/bob");
  assert.equal(value.inboxUrl, "https://remote.example/users/bob/inbox");
  assert.equal(value.sharedInboxUrl, "https://remote.example/inbox");

  now = 1600;
  assert.equal(cache.get("https://remote.example/users/bob"), null);
});

test("RemoteActorCache invalidate and clear remove entries", () => {
  const cache = new RemoteActorCache();

  cache.set("a", { inboxUrl: "https://a/inbox", sharedInboxUrl: null });
  cache.set("b", { inboxUrl: "https://b/inbox", sharedInboxUrl: null });
  assert.equal(cache.size(), 2);

  cache.invalidate("a");
  assert.equal(cache.get("a"), null);
  assert.equal(cache.size(), 1);

  cache.clear();
  assert.equal(cache.size(), 0);
});
