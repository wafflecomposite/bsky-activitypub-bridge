import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { HttpDeliveryTransport } from "../src/delivery/http-delivery-transport.js";

test("HttpDeliveryTransport reports attempt and result hooks", async () => {
  const events = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const transport = new HttpDeliveryTransport({
    fetchImpl: async () => ({ status: 202 }),
    now: (() => {
      let t = 1000;
      return () => {
        t += 25;
        return t;
      };
    })(),
    onAttempt: (event) => events.push({ type: "attempt", ...event }),
    onResult: (event) => events.push({ type: "result", ...event })
  });

  await transport.sendSignedActivity({
    destination: "https://remote.example/inbox",
    body: JSON.stringify({ type: "Create", id: "x" }),
    keyId: "https://bridge.example/ap/actor/did%3Aplc%3Aalice#main-key",
    privateKeyPem: privateKey,
    metadata: { did: "did:plc:alice" }
  });

  assert.equal(events.length, 2);
  assert.equal(events[0].type, "attempt");
  assert.equal(events[1].type, "result");
  assert.equal(events[1].status, 202);
});

test("HttpDeliveryTransport includes error response body for non-2xx", async () => {
  const events = [];
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const transport = new HttpDeliveryTransport({
    fetchImpl: async () => ({
      status: 401,
      text: async () => "{\"error\":\"invalid signature\"}"
    }),
    onResult: (event) => events.push(event)
  });

  await transport.sendSignedActivity({
    destination: "https://remote.example/inbox",
    body: JSON.stringify({ type: "Create", id: "x" }),
    keyId: "https://bridge.example/ap/actor/did%3Aplc%3Aalice#main-key",
    privateKeyPem: privateKey
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].status, 401);
  assert.equal(events[0].responseBody, "{\"error\":\"invalid signature\"}");
});
