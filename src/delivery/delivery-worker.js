import { actorId } from "../domain/identifiers.js";
import { createSignedPostHeaders } from "../federation/http-signature.js";

export class DeliveryWorker {
  #queue;
  #keyManager;
  #fetch;
  #baseUrl;
  #maxAttempts;

  constructor({ queue, keyManager, fetchImpl = fetch, baseUrl, maxAttempts = 4 }) {
    this.#queue = queue;
    this.#keyManager = keyManager;
    this.#fetch = fetchImpl;
    this.#baseUrl = baseUrl;
    this.#maxAttempts = maxAttempts;
  }

  async drainOnce({ now = Date.now() } = {}) {
    const item = this.#queue.dequeue();
    if (!item) {
      return { status: "empty" };
    }

    if (item.nextAttemptAt && item.nextAttemptAt > now) {
      this.#queue.enqueue(item);
      return { status: "deferred" };
    }

    const body = JSON.stringify(item.activity);
    const actor = actorId(this.#baseUrl, item.did);
    const key = this.#keyManager.ensureKeyPair(item.did);

    const headers = createSignedPostHeaders({
      destination: item.destination,
      body,
      keyId: `${actor}#main-key`,
      privateKeyPem: key.privateKeyPem
    });

    let response;
    try {
      response = await this.#fetch(item.destination, {
        method: "POST",
        headers,
        body
      });
    } catch (error) {
      return this.#handleRetry(item, {
        reason: "network-error",
        detail: error instanceof Error ? error.message : String(error)
      }, now);
    }

    if (response.status >= 200 && response.status < 300) {
      return {
        status: "delivered",
        destination: item.destination,
        code: response.status
      };
    }

    if (response.status === 404 || response.status === 410) {
      return {
        status: "permanent-failure",
        destination: item.destination,
        code: response.status
      };
    }

    return this.#handleRetry(item, {
      reason: "http-error",
      code: response.status
    }, now);
  }

  #handleRetry(item, failure, now) {
    const attempts = (item.attempts ?? 0) + 1;

    if (attempts >= this.#maxAttempts) {
      return {
        status: "max-attempts-exceeded",
        destination: item.destination,
        attempts,
        failure
      };
    }

    const delayMs = computeExponentialBackoffMs(attempts);
    this.#queue.enqueue({
      ...item,
      attempts,
      nextAttemptAt: now + delayMs
    });

    return {
      status: "retry-scheduled",
      destination: item.destination,
      attempts,
      retryInMs: delayMs,
      failure
    };
  }
}

export function computeExponentialBackoffMs(attempt) {
  const base = 1000;
  const max = 60_000;
  return Math.min(max, base * (2 ** (attempt - 1)));
}
