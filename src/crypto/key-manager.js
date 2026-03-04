import { generateKeyPairSync } from "node:crypto";
import { assertDid } from "../domain/identifiers.js";

export class InMemoryKeyManager {
  #keysByDid = new Map();

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

    return pair;
  }
}
