import { createHash, createSign } from "node:crypto";

export function createSignedPostHeaders({ destination, body, keyId, privateKeyPem, date = new Date() }) {
  const url = new URL(destination);
  const digest = buildDigestHeader(body);
  const dateHeader = date.toUTCString();

  const signingLines = [
    `(request-target): post ${url.pathname}${url.search}`,
    `host: ${url.host}`,
    `date: ${dateHeader}`,
    `digest: ${digest}`
  ];
  const signingString = signingLines.join("\n");

  const signature = createSign("RSA-SHA256").update(signingString).sign(privateKeyPem, "base64");

  return {
    host: url.host,
    date: dateHeader,
    digest,
    signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date digest",signature="${signature}"`,
    "content-type": "application/activity+json"
  };
}

export function buildDigestHeader(body) {
  const hash = createHash("sha256").update(body, "utf8").digest("base64");
  return `SHA-256=${hash}`;
}

export function createSignedGetHeaders({ destination, keyId, privateKeyPem, date = new Date() }) {
  const url = new URL(destination);
  const dateHeader = date.toUTCString();

  const signingLines = [
    `(request-target): get ${url.pathname}${url.search}`,
    `host: ${url.host}`,
    `date: ${dateHeader}`
  ];
  const signingString = signingLines.join("\n");

  const signature = createSign("RSA-SHA256").update(signingString).sign(privateKeyPem, "base64");

  return {
    host: url.host,
    date: dateHeader,
    signature: `keyId="${keyId}",algorithm="rsa-sha256",headers="(request-target) host date",signature="${signature}"`
  };
}
