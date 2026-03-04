import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileJetstreamState } from "../src/ingest/file-jetstream-state.js";

test("FileJetstreamState persists cursor and dedup keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
  const filePath = join(dir, "state.json");

  try {
    const s1 = new FileJetstreamState({ filePath });
    const first = s1.noteEvent("shard-a", "event-1", 100);
    assert.equal(first.duplicate, false);
    assert.equal(s1.getCursor("shard-a"), 100);

    const s2 = new FileJetstreamState({ filePath });
    assert.equal(s2.getCursor("shard-a"), 100);
    assert.equal(s2.hasSeen("shard-a", "event-1"), true);

    const second = s2.noteEvent("shard-a", "event-1", 100);
    assert.equal(second.duplicate, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FileJetstreamState async persist mode writes on flush", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-state-"));
  const filePath = join(dir, "state.json");

  try {
    const s1 = new FileJetstreamState({
      filePath,
      persistMode: "async",
      persistDebounceMs: 250
    });
    s1.noteEvent("shard-a", "event-1", 100);
    assert.equal(s1.getCursor("shard-a"), 100);

    const beforeFlush = new FileJetstreamState({ filePath });
    assert.equal(beforeFlush.getCursor("shard-a"), null);

    await s1.flush();
    const afterFlush = new FileJetstreamState({ filePath });
    assert.equal(afterFlush.getCursor("shard-a"), 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
