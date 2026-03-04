import test from "node:test";
import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  buildContentDigestHeader,
  buildMessageSignatureBase,
  buildMessageSignatureInput,
  createMessageSignatureHeaders
} from "../src/federation/http-message-signature.js";

test("buildContentDigestHeader creates RFC-style content-digest", () => {
  const digest = buildContentDigestHeader("{\"a\":1}");
  assert.equal(digest, "sha-256=:AVq9f1zFei3ZS3WQ8ErYCEJzkF7jPsXOvq5iJ2qX+GI=:");
});

test("createMessageSignatureHeaders signs expected signature base", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const destination = "https://remote.example/inbox";
  const body = "{\"type\":\"Create\"}";
  const keyId = "https://bridge.example/ap/actor/did%3Aplc%3Aalice#main-key";
  const date = new Date("2026-03-04T00:00:00.000Z");

  const headers = createMessageSignatureHeaders({
    method: "POST",
    destination,
    body,
    keyId,
    privateKeyPem: privateKey,
    date
  });

  assert.ok(headers["content-digest"].startsWith("sha-256=:"));
  assert.ok(headers["signature-input"].startsWith("sig1=("));
  assert.ok(headers.signature.startsWith("sig1=:"));

  const signatureInput = headers["signature-input"].slice("sig1=".length);
  const signatureBase = buildMessageSignatureBase({
    method: "post",
    targetUri: destination,
    date: headers.date,
    contentDigest: headers["content-digest"],
    signatureInput
  });

  const rawSignature = headers.signature.slice("sig1=:".length, -1);
  const verified = createVerify("RSA-SHA256").update(signatureBase).verify(publicKey, rawSignature, "base64");
  assert.equal(verified, true);
});

test("buildMessageSignatureInput includes created and key id", () => {
  const input = buildMessageSignatureInput({
    keyId: "https://bridge.example/key#1",
    created: 1_770_000_000
  });

  assert.ok(input.includes("created=1770000000"));
  assert.ok(input.includes("keyid=\"https://bridge.example/key#1\""));
});
