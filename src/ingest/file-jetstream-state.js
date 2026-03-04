import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class FileJetstreamState {
  #filePath;
  #cursorByShard = new Map();
  #seenByShard = new Map();
  #maxSeenPerShard;

  constructor({ filePath, maxSeenPerShard = 5000 } = {}) {
    if (!filePath) {
      throw new Error("FileJetstreamState requires filePath");
    }

    this.#filePath = filePath;
    this.#maxSeenPerShard = maxSeenPerShard;
    this.#load();
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

    this.#persist();

    return {
      duplicate,
      cursor: this.getCursor(shardId)
    };
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

    for (const [shardId, cursor] of Object.entries(parsed.cursorByShard ?? {})) {
      if (typeof cursor === "number" && Number.isFinite(cursor)) {
        this.#cursorByShard.set(shardId, cursor);
      }
    }

    for (const [shardId, seen] of Object.entries(parsed.seenByShard ?? {})) {
      const order = Array.isArray(seen) ? seen.filter((entry) => typeof entry === "string") : [];
      this.#seenByShard.set(shardId, {
        keys: new Set(order),
        order
      });
    }
  }

  #persist() {
    const cursorByShard = Object.fromEntries(this.#cursorByShard.entries());
    const seenByShard = {};

    for (const [shardId, seen] of this.#seenByShard.entries()) {
      seenByShard[shardId] = [...seen.order];
    }

    mkdirSync(dirname(this.#filePath), { recursive: true });
    writeFileSync(this.#filePath, JSON.stringify({
      cursorByShard,
      seenByShard
    }, null, 2));
  }
}
