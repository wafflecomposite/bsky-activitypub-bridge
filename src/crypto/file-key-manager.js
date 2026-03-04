import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertDid } from "../domain/identifiers.js";

export class FileKeyManager {
  #filePath;
  #keysByDid = new Map();

  constructor({ filePath }) {
    if (!filePath) {
      throw new Error("FileKeyManager requires filePath");
    }

    this.#filePath = filePath;
    this.#load();
  }

  ensureKeyPair(did) {
    const actorDid = assertDid(did);
    const existing = this.#keysByDid.get(actorDid);

    if (existing) {
      return existing;
    }

    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: {
        type: "spki",
        format: "pem"
      },
      privateKeyEncoding: {
        type: "pkcs8",
        format: "pem"
      }
    });

    const pair = { publicKeyPem: publicKey, privateKeyPem: privateKey };
    this.#keysByDid.set(actorDid, pair);
    this.#persist();

    return pair;
  }

  #load() {
    if (!existsSync(this.#filePath)) {
      return;
    }

    const raw = readFileSync(this.#filePath, "utf8");
    if (!raw.trim()) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    for (const [did, pair] of Object.entries(parsed.keysByDid ?? {})) {
      if (typeof pair?.publicKeyPem !== "string" || typeof pair?.privateKeyPem !== "string") {
        continue;
      }

      this.#keysByDid.set(assertDid(did), {
        publicKeyPem: pair.publicKeyPem,
        privateKeyPem: pair.privateKeyPem
      });
    }
  }

  #persist() {
    const keysByDid = Object.fromEntries(this.#keysByDid.entries());
    mkdirSync(dirname(this.#filePath), { recursive: true });
    writeFileSync(this.#filePath, JSON.stringify({ keysByDid }, null, 2));
  }
}
