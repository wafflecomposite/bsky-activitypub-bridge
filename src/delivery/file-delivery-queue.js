import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile as writeFileAsync, mkdir as mkdirAsync } from "node:fs/promises";
import { dirname } from "node:path";

export class FileDeliveryQueue {
  #filePath;
  #persistMode;
  #persistDebounceMs;
  #items;
  #persistTimer = null;
  #persistDirty = false;
  #persistWriteQueued = false;
  #persistWritePromise = null;

  constructor({ filePath, persistMode = "sync", persistDebounceMs = 50 }) {
    if (!filePath) {
      throw new Error("FileDeliveryQueue requires filePath");
    }

    this.#filePath = filePath;
    this.#persistMode = persistMode === "async" ? "async" : "sync";
    this.#persistDebounceMs = normalizePersistDebounceMs(persistDebounceMs);
    this.#items = loadSnapshot(filePath).items;
  }

  enqueue(item) {
    this.#items.push(item);
    this.#persist();
  }

  dequeue() {
    if (this.#items.length === 0) {
      return null;
    }

    const item = this.#items.shift();
    this.#persist();
    return item;
  }

  size() {
    return this.#items.length;
  }

  list() {
    return [...this.#items];
  }

  clear() {
    this.#items = [];
    this.#persist();
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

  #persist() {
    if (this.#persistMode === "sync") {
      persistSnapshot(this.#filePath, {
        items: this.#items
      });
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

  #triggerAsyncPersist() {
    if (this.#persistWritePromise) {
      this.#persistWriteQueued = true;
      return;
    }

    if (!this.#persistDirty) {
      return;
    }

    this.#persistDirty = false;
    const payload = JSON.stringify({
      items: this.#items
    }, null, 2);

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
}

function loadSnapshot(filePath) {
  if (!existsSync(filePath)) {
    return { items: [] };
  }

  const raw = readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    return { items: [] };
  }

  try {
    const parsed = JSON.parse(raw);
    return {
      items: Array.isArray(parsed.items) ? parsed.items : []
    };
  } catch {
    return { items: [] };
  }
}

function persistSnapshot(filePath, data) {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2));
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
