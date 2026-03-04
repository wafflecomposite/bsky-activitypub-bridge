import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { verifyInboxRequestSignature } from "../src/federation/inbox-signature-verifier.js";
import { createSignedPostHeaders } from "../src/federation/http-signature.js";

test("verifyInboxRequestSignature accepts valid signed request", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const keyId = "https://remote.example/users/bob#main-key";
  const body = JSON.stringify({ type: "Follow", actor: "https://remote.example/users/bob" });
  const headers = createSignedPostHeaders({
    destination: "https://bridge.example/ap/actor/did%3Aplc%3Aalice/inbox",
    body,
    keyId,
    privateKeyPem: privateKey,
    date: new Date("2026-03-04T00:00:00.000Z")
  });

  const result = await verifyInboxRequestSignature({
    method: "POST",
    requestTarget: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers,
    body,
    now: () => Date.parse("2026-03-04T00:00:30.000Z"),
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        id: "https://remote.example/users/bob",
        publicKey: {
          id: keyId,
          owner: "https://remote.example/users/bob",
          publicKeyPem: publicKey
        }
      })
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.actorId, "https://remote.example/users/bob");
});

test("verifyInboxRequestSignature rejects invalid digest", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const keyId = "https://remote.example/users/bob#main-key";
  const body = JSON.stringify({ type: "Follow", actor: "https://remote.example/users/bob" });
  const headers = createSignedPostHeaders({
    destination: "https://bridge.example/ap/actor/did%3Aplc%3Aalice/inbox",
    body,
    keyId,
    privateKeyPem: privateKey,
    date: new Date("2026-03-04T00:00:00.000Z")
  });

  headers.digest = "SHA-256=bogus";

  const result = await verifyInboxRequestSignature({
    method: "POST",
    requestTarget: "/ap/actor/did%3Aplc%3Aalice/inbox",
    headers,
    body,
    now: () => Date.parse("2026-03-04T00:00:30.000Z"),
    fetchImpl: async () => ({
      status: 200,
      json: async () => ({
        id: "https://remote.example/users/bob",
        publicKey: {
          id: keyId,
          owner: "https://remote.example/users/bob",
          publicKeyPem: publicKey
        }
      })
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.error, "Invalid Digest header");
});
