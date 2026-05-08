import test from "node:test";
import assert from "node:assert/strict";
import { runLocalE2EHarness } from "../src/e2e/local-harness.js";

test("runLocalE2EHarness completes retry-then-deliver scenario", async () => {
  const summary = await runLocalE2EHarness();

  assert.equal(summary.ok, true);
  assert.equal(summary.removedFollower, "https://remote.example/users/bob");
  assert.equal(summary.unfollowedIngestStatus, "no-followers");
  assert.equal(summary.queueSizeAfterUnfollowedIngest, 0);
  assert.equal(summary.ingestStatus, "enqueued");
  assert.equal(summary.queueSize, 0);
  assert.equal(summary.cursor, 1_000_000);
  assert.equal(summary.firstDrain.some((entry) => entry.status === "retry-scheduled"), true);
  assert.equal(summary.secondDrain.some((entry) => entry.status === "delivered"), true);
});
