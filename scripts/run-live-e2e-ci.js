import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runLiveE2EHarness } from "../src/e2e/live-harness.js";
import {
  buildLiveHarnessOptions,
  resolveArtifactsDir,
  shouldCleanupSuccessfulRun,
  shouldRunLiveE2E
} from "../src/e2e/live-ci-runner.js";

if (!shouldRunLiveE2E()) {
  const skipped = {
    ok: true,
    skipped: true,
    reason: "Set RUN_LIVE_E2E=1 to enable live test execution"
  };

  console.log(JSON.stringify(skipped, null, 2));
  process.exit(0);
}

const artifactsDir = resolveArtifactsDir();
const workDir = join(artifactsDir, "workdir");
mkdirSync(workDir, { recursive: true });

const summaryPath = join(artifactsDir, "summary.json");
const errorPath = join(artifactsDir, "error.json");

try {
  const options = buildLiveHarnessOptions();
  const summary = await runLiveE2EHarness({
    ...options,
    cleanup: false,
    workDir,
    log: (line) => console.log(`[live-e2e] ${line}`)
  });

  writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({
    ...summary,
    artifactsDir
  }, null, 2));

  if (!summary.ok) {
    process.exitCode = 1;
  }

  if (summary.ok && shouldCleanupSuccessfulRun()) {
    rmSync(workDir, { recursive: true, force: true });
  }
} catch (error) {
  const payload = {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : null,
    artifactsDir
  };

  writeFileSync(errorPath, JSON.stringify(payload, null, 2));
  console.error(JSON.stringify(payload, null, 2));
  process.exitCode = 1;
}
