import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileKeyManager } from "../src/crypto/file-key-manager.js";

test("FileKeyManager persists keys across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-keys-"));
  const filePath = join(dir, "keys.json");

  try {
    const k1 = new FileKeyManager({ filePath });
    const first = k1.ensureKeyPair("did:plc:alice");

    const k2 = new FileKeyManager({ filePath });
    const second = k2.ensureKeyPair("did:plc:alice");

    assert.equal(first.publicKeyPem, second.publicKeyPem);
    assert.equal(first.privateKeyPem, second.privateKeyPem);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
