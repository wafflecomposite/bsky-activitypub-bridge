import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile as writeFileAsync, mkdir as mkdirAsync } from "node:fs/promises";
import { dirname } from "node:path";

export class FileJetstreamState {
  #filePath;
  #persistMode;
  #persistDebounceMs;
  #cursorByShard = new Map();
  #seenByShard = new Map();
  #maxSeenPerShard;
  #persistTimer = null;
  #persistDirty = false;
  #persistWriteQueued = false;
  #persistWritePromise = null;

  constructor({ filePath, maxSeenPerShard = 5000, persistMode = "sync", persistDebounceMs = 50 } = {}) {
    if (!filePath) {
      throw new Error("FileJetstreamState requires filePath");
    }

    this.#filePath = filePath;
    this.#maxSeenPerShard = maxSeenPerShard;
    this.#persistMode = persistMode === "async" ? "async" : "sync";
    this.#persistDebounceMs = normalizePersistDebounceMs(persistDebounceMs);
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

  async flush() {
    if (this.#persistMode === "sync") {
      return;
    }

    if (this.#persistTimer) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = null;
    }

    this.#triggerAsyncPersist();

    while (this.#persistWritePromise || this.#persistDirty || this.#persistTimer) {
      if (this.#persistWritePromise) {
        await this.#persistWritePromise;
        continue;
      }

      if (this.#persistTimer) {
        clearTimeout(this.#persistTimer);
        this.#persistTimer = null;
      }
      this.#triggerAsyncPersist();
    }
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
    if (this.#persistMode === "sync") {
      this.#persistSync();
      return;
    }

    this.#persistDirty = true;
    if (this.#persistTimer) {
      return;
    }

    this.#persistTimer = setTimeout(() => {
      this.#persistTimer = null;
      this.#triggerAsyncPersist();
    }, this.#persistDebounceMs);
  }

  #persistSync() {
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

  #triggerAsyncPersist() {
    if (this.#persistWritePromise) {
      this.#persistWriteQueued = true;
      return;
    }

    if (!this.#persistDirty) {
      return;
    }

    this.#persistDirty = false;
    const payload = JSON.stringify(this.#buildSnapshot(), null, 2);

    this.#persistWritePromise = persistSnapshotAsync(this.#filePath, payload)
      .catch(() => {
        // Best effort persistence.
      })
      .finally(() => {
        this.#persistWritePromise = null;
        if (this.#persistWriteQueued || this.#persistDirty) {
          this.#persistWriteQueued = false;
          this.#triggerAsyncPersist();
        }
      });
  }

  #buildSnapshot() {
    const cursorByShard = Object.fromEntries(this.#cursorByShard.entries());
    const seenByShard = {};

    for (const [shardId, seen] of this.#seenByShard.entries()) {
      seenByShard[shardId] = [...seen.order];
    }

    return {
      cursorByShard,
      seenByShard
    };
  }
}

function normalizePersistDebounceMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.min(Math.max(Math.trunc(value), 0), 5000);
  }

  return 50;
}

async function persistSnapshotAsync(filePath, payload) {
  await mkdirAsync(dirname(filePath), { recursive: true });
  await writeFileAsync(filePath, payload);
}
