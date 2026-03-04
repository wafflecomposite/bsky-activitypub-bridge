export class RemoteActorCache {
  #entries = new Map();
  #ttlMs;
  #now;

  constructor({ ttlMs = 5 * 60 * 1000, now = () => Date.now() } = {}) {
    this.#ttlMs = ttlMs;
    this.#now = now;
  }

  get(actorId) {
    const entry = this.#entries.get(actorId);
    if (!entry) {
      return null;
    }

    if (entry.expiresAt <= this.#now()) {
      this.#entries.delete(actorId);
      return null;
    }

    return {
      inboxUrl: entry.inboxUrl,
      sharedInboxUrl: entry.sharedInboxUrl
    };
  }

  set(actorId, value) {
    this.#entries.set(actorId, {
      inboxUrl: value.inboxUrl,
      sharedInboxUrl: value.sharedInboxUrl ?? null,
      expiresAt: this.#now() + this.#ttlMs
    });
  }

  invalidate(actorId) {
    this.#entries.delete(actorId);
  }

  clear() {
    this.#entries.clear();
  }

  size() {
    return this.#entries.size;
  }
}
