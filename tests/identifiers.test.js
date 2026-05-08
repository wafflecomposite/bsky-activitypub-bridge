import test from "node:test";
import assert from "node:assert/strict";
import {
  actorFeaturedId,
  actorFollowingId,
  actorId,
  decodeDidFromPath,
  encodeDidForPath,
  parseAcctResource,
  quoteAuthorizationId,
  webfingerSubject
} from "../src/domain/identifiers.js";

test("parseAcctResource returns normalized handle and host", () => {
  const parsed = parseAcctResource("acct:Alice.BSKY.Social@Bridge.Example", "bridge.example");

  assert.deepEqual(parsed, {
    handle: "alice.bsky.social",
    host: "bridge.example"
  });
});

test("parseAcctResource rejects host mismatch", () => {
  assert.throws(
    () => parseAcctResource("acct:alice.bsky.social@wrong.example", "bridge.example"),
    /host mismatch/
  );
});

test("DID path encoding and decoding round-trips", () => {
  const did = "did:plc:abc123";
  const encoded = encodeDidForPath(did);

  assert.equal(encoded, "did%3Aplc%3Aabc123");
  assert.equal(decodeDidFromPath(encoded), did);
});

test("actorId and webfingerSubject are deterministic", () => {
  const did = "did:plc:abc123";

  assert.equal(actorId("https://bridge.example", did), "https://bridge.example/ap/actor/did%3Aplc%3Aabc123");
  assert.equal(actorFollowingId("https://bridge.example", did), "https://bridge.example/ap/actor/did%3Aplc%3Aabc123/following");
  assert.equal(actorFeaturedId("https://bridge.example", did), "https://bridge.example/ap/actor/did%3Aplc%3Aabc123/featured");
  assert.equal(
    quoteAuthorizationId("https://bridge.example", "did:plc:quoted", "root", "did:plc:quoting", "quote"),
    "https://bridge.example/ap/object/did%3Aplc%3Aquoted/root/quote-authorization/did%3Aplc%3Aquoting/quote"
  );
  assert.equal(webfingerSubject("alice.bsky.social", "bridge.example"), "acct:alice.bsky.social@bridge.example");
});
