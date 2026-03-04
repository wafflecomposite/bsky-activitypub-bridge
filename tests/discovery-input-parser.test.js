import test from "node:test";
import assert from "node:assert/strict";
import { parseDiscoveryInput } from "../src/discovery/input-parser.js";

test("parseDiscoveryInput accepts common actor forms", () => {
  assert.deepEqual(parseDiscoveryInput("mouseu.bsky.social"), {
    kind: "actor",
    handle: "mouseu.bsky.social"
  });

  assert.deepEqual(parseDiscoveryInput("@mouseu.bsky.social"), {
    kind: "actor",
    handle: "mouseu.bsky.social"
  });

  assert.deepEqual(parseDiscoveryInput("https://bsky.app/profile/mouseu.bsky.social"), {
    kind: "actor",
    handle: "mouseu.bsky.social"
  });

  assert.deepEqual(parseDiscoveryInput("https://bsky.app/profile/did:plc:yn3w4zmt6jm27vakouqe6gqf"), {
    kind: "actor",
    did: "did:plc:yn3w4zmt6jm27vakouqe6gqf"
  });
});

test("parseDiscoveryInput accepts bridged and acct-style actor inputs", () => {
  assert.deepEqual(parseDiscoveryInput("@lnkr.gts.burning.homes.ap.brid.gy"), {
    kind: "actor",
    handle: "lnkr.gts.burning.homes.ap.brid.gy"
  });

  assert.deepEqual(parseDiscoveryInput("@autumnivy.net"), {
    kind: "actor",
    handle: "autumnivy.net"
  });

  assert.deepEqual(parseDiscoveryInput("@bsky.app"), {
    kind: "actor",
    handle: "bsky.app"
  });

  assert.deepEqual(parseDiscoveryInput("acct:mouseu.bsky.social@example.com"), {
    kind: "actor",
    handle: "mouseu.bsky.social"
  });
});

test("parseDiscoveryInput accepts common post URL forms", () => {
  assert.deepEqual(parseDiscoveryInput("https://bsky.app/profile/bsky.app/post/3l6oveex3ii2l"), {
    kind: "post",
    handle: "bsky.app",
    rkey: "3l6oveex3ii2l"
  });

  assert.deepEqual(parseDiscoveryInput("https://example.invalid/profile/bsky.app/post/3l6oveex3ii2l"), {
    kind: "post",
    handle: "bsky.app",
    rkey: "3l6oveex3ii2l"
  });

  assert.deepEqual(parseDiscoveryInput("at://did:plc:yn3w4zmt6jm27vakouqe6gqf/app.bsky.feed.post/3l6oveex3ii2l"), {
    kind: "post",
    did: "did:plc:yn3w4zmt6jm27vakouqe6gqf",
    rkey: "3l6oveex3ii2l"
  });
});

test("parseDiscoveryInput accepts bridged object URLs", () => {
  assert.deepEqual(
    parseDiscoveryInput("https://bridge.example/ap/object/did%3Aplc%3Aalice/3abcxyz"),
    {
      kind: "post",
      did: "did:plc:alice",
      rkey: "3abcxyz"
    }
  );
});

test("parseDiscoveryInput rejects empty input", () => {
  assert.throws(() => parseDiscoveryInput("   "), /cannot be empty/i);
});
