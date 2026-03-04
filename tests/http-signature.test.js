import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { buildDigestHeader, createSignedPostHeaders } from "../src/federation/http-signature.js";

test("buildDigestHeader produces SHA-256 digest value", () => {
  const digest = buildDigestHeader('{"ok":true}');

  assert.match(digest, /^SHA-256=[A-Za-z0-9+/=]+$/);
});

test("createSignedPostHeaders signs request-target host date digest", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const body = JSON.stringify({ type: "Create", id: "https://bridge.example/activity/1" });
  const date = new Date("2026-03-04T00:00:00.000Z");

  const headers = createSignedPostHeaders({
    destination: "https://remote.example/inbox",
    body,
    keyId: "https://bridge.example/ap/actor/did%3Aplc%3Aalice#main-key",
    privateKeyPem: privateKey,
    date
  });

  const signatureValue = parseSignatureHeader(headers.signature).signature;
  const signingString = [
    "(request-target): post /inbox",
    "host: remote.example",
    `date: ${headers.date}`,
    `digest: ${headers.digest}`
  ].join("\n");

  const verified = createVerify("RSA-SHA256").update(signingString).verify(publicKey, signatureValue, "base64");
  assert.equal(verified, true);
});

function parseSignatureHeader(value) {
  const parts = value.split(",");
  const out = {};

  for (const part of parts) {
    const [k, rawV] = part.split("=");
    out[k.trim()] = rawV.trim().replace(/^"/, "").replace(/"$/, "");
  }

  return out;
}
