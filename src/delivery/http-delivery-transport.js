import { createSignedPostHeaders } from "../federation/http-signature.js";
import { createMessageSignatureHeaders } from "../federation/http-message-signature.js";

export class HttpDeliveryTransport {
  #fetch;
  #now;
  #onAttempt;
  #onResult;
  #messageSignaturesEnabled;

  constructor({ fetchImpl = fetch, now = () => Date.now(), onAttempt = null, onResult = null, messageSignaturesEnabled = false } = {}) {
    this.#fetch = fetchImpl;
    this.#now = now;
    this.#onAttempt = onAttempt;
    this.#onResult = onResult;
    this.#messageSignaturesEnabled = messageSignaturesEnabled;
  }

  async sendSignedActivity({ destination, body, keyId, privateKeyPem, metadata = {} }) {
    const startedAt = this.#now();
    const headers = createSignedPostHeaders({
      destination,
      body,
      keyId,
      privateKeyPem
    });

    if (this.#messageSignaturesEnabled) {
      const cavageSignature = headers.signature;
      Object.assign(headers, createMessageSignatureHeaders({
        method: "POST",
        destination,
        body,
        keyId,
        privateKeyPem
      }));
      headers.authorization = `Signature ${cavageSignature}`;
    }

    if (this.#onAttempt) {
      this.#onAttempt({
        destination,
        startedAt,
        metadata
      });
    }

    try {
      const response = await this.#fetch(destination, {
        method: "POST",
        headers,
        body
      });

      let responseBody = null;
      if (response.status >= 400) {
        try {
          responseBody = await response.text();
          if (responseBody.length > 400) {
            responseBody = `${responseBody.slice(0, 400)}...`;
          }
        } catch {
          responseBody = null;
        }
      }

      if (this.#onResult) {
        this.#onResult({
          destination,
          status: response.status,
          durationMs: this.#now() - startedAt,
          metadata,
          responseBody
        });
      }

      return response;
    } catch (error) {
      if (this.#onResult) {
        this.#onResult({
          destination,
          status: null,
          durationMs: this.#now() - startedAt,
          metadata,
          error: error instanceof Error ? error.message : String(error)
        });
      }

      throw error;
    }
  }
}
