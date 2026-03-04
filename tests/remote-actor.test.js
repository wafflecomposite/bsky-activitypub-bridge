import test from "node:test";
import assert from "node:assert/strict";
import { resolveFollowerEndpoints } from "../src/ap/remote-actor.js";
import { InMemoryKeyManager } from "../src/crypto/key-manager.js";

test("resolveFollowerEndpoints uses embedded actor inbox when present", async () => {
  const result = await resolveFollowerEndpoints({
    activity: {
      type: "Follow",
      actor: {
        id: "https://remote.example/users/bob",
        inbox: "https://remote.example/users/bob/inbox",
        endpoints: {
          sharedInbox: "https://remote.example/inbox"
        }
      }
    },
    targetDid: "did:plc:alice",
    baseUrl: "https://bridge.example",
    keyManager: new InMemoryKeyManager(),
    fetchImpl: async () => {
      throw new Error("should-not-fetch");
    }
  });

  assert.equal(result.actorId, "https://remote.example/users/bob");
  assert.equal(result.inboxUrl, "https://remote.example/users/bob/inbox");
  assert.equal(result.sharedInboxUrl, "https://remote.example/inbox");
});

test("resolveFollowerEndpoints fetches actor when activity only has actor ID", async () => {
  const keyManager = new InMemoryKeyManager();
  let request;

  const result = await resolveFollowerEndpoints({
    activity: {
      type: "Follow",
      actor: "https://remote.example/users/bob"
    },
    targetDid: "did:plc:alice",
    baseUrl: "https://bridge.example",
    keyManager,
    fetchImpl: async (url, init) => {
      request = { url, init };
      return {
        status: 200,
        json: async () => ({
          id: "https://remote.example/users/bob",
          inbox: "https://remote.example/users/bob/inbox",
          endpoints: {
            sharedInbox: "https://remote.example/inbox"
          }
        })
      };
    }
  });

  assert.equal(request.url, "https://remote.example/users/bob");
  assert.equal(request.init.method, "GET");
  assert.ok(request.init.headers.signature);
  assert.equal(result.inboxUrl, "https://remote.example/users/bob/inbox");
  assert.equal(result.sharedInboxUrl, "https://remote.example/inbox");
});
