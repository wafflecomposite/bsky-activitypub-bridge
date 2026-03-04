export class InMemoryJetstreamState {
  #cursorByShard = new Map();
  #seenByShard = new Map();
  #maxSeenPerShard;

  constructor({ maxSeenPerShard = 5000 } = {}) {
    this.#maxSeenPerShard = maxSeenPerShard;
  }

  getCursor(shardId = "default") {
    return this.#cursorByShard.get(shardId) ?? null;
  }

  hasSeen(shardId, eventKey) {
    const shard = this.#seenByShard.get(shardId);
    return shard ? shard.keys.has(eventKey) : false;
  }

  noteEvent(shardId, eventKey, timeUs) {
    const shard = this.#ensureShard(shardId);

    const duplicate = shard.keys.has(eventKey);
    if (!duplicate) {
      shard.keys.add(eventKey);
      shard.order.push(eventKey);

      if (shard.order.length > this.#maxSeenPerShard) {
        const oldest = shard.order.shift();
        shard.keys.delete(oldest);
      }
    }

    if (typeof timeUs === "number" && Number.isFinite(timeUs)) {
      const current = this.#cursorByShard.get(shardId);
      if (current === undefined || timeUs > current) {
        this.#cursorByShard.set(shardId, timeUs);
      }
    }

    return { duplicate, cursor: this.getCursor(shardId) };
  }

  #ensureShard(shardId) {
    let shard = this.#seenByShard.get(shardId);
    if (!shard) {
      shard = {
        keys: new Set(),
        order: []
      };
      this.#seenByShard.set(shardId, shard);
    }

    return shard;
  }
}
