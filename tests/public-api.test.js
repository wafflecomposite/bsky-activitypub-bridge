import test from "node:test";
import assert from "node:assert/strict";
import { getPostRecord, getProfile, resolveHandleToDid } from "../src/bsky/public-api.js";

test("resolveHandleToDid normalizes and returns DID", async () => {
  const did = await resolveHandleToDid({
    handle: "Alice.Bsky.social",
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=alice.bsky.social"
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({ did: "did:plc:alice123" })
      };
    }
  });

  assert.equal(did, "did:plc:alice123");
});

test("getProfile returns normalized actor profile and pinned post uri", async () => {
  const profile = await getProfile({
    actor: "did:plc:alice123",
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=did%3Aplc%3Aalice123"
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          did: "did:plc:alice123",
          handle: "alice.bsky.social",
          displayName: "Alice",
          description: "profile summary",
          avatar: "https://cdn.example/avatar.jpg",
          banner: "https://cdn.example/banner.jpg",
          pinnedPost: {
            uri: "at://did:plc:alice123/app.bsky.feed.post/pin1"
          }
        })
      };
    }
  });

  assert.deepEqual(profile, {
    did: "did:plc:alice123",
    handle: "alice.bsky.social",
    displayName: "Alice",
    description: "profile summary",
    avatarUrl: "https://cdn.example/avatar.jpg",
    bannerUrl: "https://cdn.example/banner.jpg",
    pinnedPostUri: "at://did:plc:alice123/app.bsky.feed.post/pin1"
  });
});

test("getProfile extracts pinned post uri from alternate profile shapes", async () => {
  const profile = await getProfile({
    actor: "did:plc:alice123",
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        did: "did:plc:alice123",
        handle: "alice.bsky.social",
        pinnedPost: {
          record: {
            uri: "at://did:plc:alice123/app.bsky.feed.post/pin2"
          }
        }
      })
    })
  });

  assert.equal(profile.pinnedPostUri, "at://did:plc:alice123/app.bsky.feed.post/pin2");
});

test("getPostRecord returns post record payload", async () => {
  const record = await getPostRecord({
    did: "did:plc:alice123",
    rkey: "abc1",
    fetchImpl: async (url) => {
      assert.equal(
        url,
        "https://public.api.bsky.app/xrpc/com.atproto.repo.getRecord?repo=did%3Aplc%3Aalice123&collection=app.bsky.feed.post&rkey=abc1"
      );
      return {
        ok: true,
        status: 200,
        json: async () => ({
          uri: "at://did:plc:alice123/app.bsky.feed.post/abc1",
          cid: "cid1",
          value: {
            $type: "app.bsky.feed.post",
            text: "hello",
            createdAt: "2026-03-04T00:00:00.000Z"
          }
        })
      };
    }
  });

  assert.equal(record.uri, "at://did:plc:alice123/app.bsky.feed.post/abc1");
  assert.equal(record.value.text, "hello");
});
