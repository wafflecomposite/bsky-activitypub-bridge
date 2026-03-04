import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class FileDeliveryQueue {
  #filePath;
  #items;

  constructor({ filePath }) {
    if (!filePath) {
      throw new Error("FileDeliveryQueue requires filePath");
    }

    this.#filePath = filePath;
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

  #persist() {
    persistSnapshot(this.#filePath, {
      items: this.#items
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
