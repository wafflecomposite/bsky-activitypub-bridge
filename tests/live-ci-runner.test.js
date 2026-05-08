import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLiveHarnessOptions,
  resolveArtifactsDir,
  shouldCleanupSuccessfulRun,
  shouldRunLiveE2E
} from "../src/e2e/live-ci-runner.js";

test("shouldRunLiveE2E is disabled by default", () => {
  assert.equal(shouldRunLiveE2E({ env: {} }), false);
});

test("shouldRunLiveE2E accepts boolean-like values", () => {
  assert.equal(shouldRunLiveE2E({ env: { RUN_LIVE_E2E: "1" } }), true);
  assert.equal(shouldRunLiveE2E({ env: { RUN_LIVE_E2E: "true" } }), true);
  assert.equal(shouldRunLiveE2E({ env: { RUN_LIVE_E2E: "0" } }), false);
});

test("shouldCleanupSuccessfulRun follows LIVE_E2E_CLEANUP flag", () => {
  assert.equal(shouldCleanupSuccessfulRun({ env: {} }), false);
  assert.equal(shouldCleanupSuccessfulRun({ env: { LIVE_E2E_CLEANUP: "1" } }), true);
});

test("resolveArtifactsDir uses deterministic timestamp default", () => {
  const dir = resolveArtifactsDir({
    env: {},
    now: new Date("2026-03-04T16:00:01.123Z")
  });

  assert.equal(dir, ".data/live-e2e-artifacts/20260304T160001Z");
});

test("resolveArtifactsDir accepts overrides", () => {
  const dir = resolveArtifactsDir({
    env: {
      LIVE_E2E_ARTIFACTS_BASE_DIR: "/tmp/artifacts",
      LIVE_E2E_RUN_ID: "run-42"
    }
  });

  assert.equal(dir, "/tmp/artifacts/run-42");
});

test("buildLiveHarnessOptions pulls credential and media paths", () => {
  const options = buildLiveHarnessOptions({
    env: {
      LIVE_E2E_CREDENTIALS_FILE: "/tmp/creds.json",
      LIVE_E2E_CREDENTIALS_MD_FILE: "/tmp/creds.md",
      LIVE_E2E_MEDIA_FIXTURE: "/tmp/image.jpg",
      LIVE_E2E_ENABLE_HTTP_MESSAGE_SIGNATURES: "1",
      JETSTREAM_MAX_DIDS_PER_STREAM: "2",
      LIVE_E2E_EXTRA_WANTED_DIDS: "did:plc:extra1,did:plc:extra2"
    }
  });

  assert.deepEqual(options, {
    credentialsFile: "/tmp/creds.json",
    credentialsMarkdownFile: "/tmp/creds.md",
    mediaFixturePath: "/tmp/image.jpg",
    messageSignaturesEnabled: true,
    jetstreamMaxDidsPerStream: 2,
    extraWantedDids: ["did:plc:extra1", "did:plc:extra2"]
  });
});
