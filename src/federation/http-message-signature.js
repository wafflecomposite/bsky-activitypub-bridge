import { createHash, createSign } from "node:crypto";

export function buildContentDigestHeader(body) {
  const hash = createHash("sha256").update(body, "utf8").digest("base64");
  return `sha-256=:${hash}:`;
}

export function createMessageSignatureHeaders({
  method = "POST",
  destination,
  body,
  keyId,
  privateKeyPem,
  date = new Date(),
  label = "sig1"
}) {
  const normalizedMethod = method.toLowerCase();
  const targetUri = new URL(destination).toString();
  const dateHeader = date.toUTCString();
  const contentDigest = buildContentDigestHeader(body);
  const created = Math.floor(date.getTime() / 1000);

  const signatureInput = buildMessageSignatureInput({
    method: normalizedMethod,
    targetUri,
    date: dateHeader,
    contentDigest,
    keyId,
    created
  });

  const signatureBase = buildMessageSignatureBase({
    method: normalizedMethod,
    targetUri,
    date: dateHeader,
    contentDigest,
    signatureInput
  });

  const signature = createSign("RSA-SHA256").update(signatureBase).sign(privateKeyPem, "base64");

  return {
    date: dateHeader,
    "content-digest": contentDigest,
    "signature-input": `${label}=${signatureInput}`,
    signature: `${label}=:${signature}:`
  };
}

export function buildMessageSignatureInput({ keyId, created }) {
  const components = ["\"@method\"", "\"@target-uri\"", "\"date\"", "\"content-digest\""];
  return `(${components.join(" ")});created=${created};keyid="${escapeStructuredValue(keyId)}";alg="rsa-v1_5-sha256"`;
}

export function buildMessageSignatureBase({ method, targetUri, date, contentDigest, signatureInput }) {
  const lines = [
    `"@method": ${method}`,
    `"@target-uri": ${targetUri}`,
    `"date": ${date}`,
    `"content-digest": ${contentDigest}`,
    `"@signature-params": ${signatureInput}`
  ];

  return lines.join("\n");
}

function escapeStructuredValue(value) {
  return String(value).replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
}
