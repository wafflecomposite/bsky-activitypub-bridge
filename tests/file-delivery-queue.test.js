import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileDeliveryQueue } from "../src/delivery/file-delivery-queue.js";

test("FileDeliveryQueue persists enqueued items across instances", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-queue-"));
  const filePath = join(dir, "queue.json");

  try {
    const q1 = new FileDeliveryQueue({ filePath });
    q1.enqueue({ id: 1 });
    q1.enqueue({ id: 2 });
    assert.equal(q1.size(), 2);

    const q2 = new FileDeliveryQueue({ filePath });
    assert.equal(q2.size(), 2);
    assert.deepEqual(q2.dequeue(), { id: 1 });
    assert.equal(q2.size(), 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
