import { join } from "node:path";

export function shouldRunLiveE2E({ env = process.env } = {}) {
  return parseBooleanFlag(env.RUN_LIVE_E2E, false);
}

export function shouldCleanupSuccessfulRun({ env = process.env } = {}) {
  return parseBooleanFlag(env.LIVE_E2E_CLEANUP, false);
}

export function resolveArtifactsDir({ env = process.env, now = new Date() } = {}) {
  const base = env.LIVE_E2E_ARTIFACTS_BASE_DIR ?? ".data/live-e2e-artifacts";
  const runId = env.LIVE_E2E_RUN_ID ?? formatRunTimestamp(now);
  return join(base, runId);
}

export function buildLiveHarnessOptions({ env = process.env } = {}) {
  return {
    credentialsFile: env.LIVE_E2E_CREDENTIALS_FILE ?? "test_credentials.json",
    credentialsMarkdownFile: env.LIVE_E2E_CREDENTIALS_MD_FILE ?? "test_credentials.md",
    mediaFixturePath: env.LIVE_E2E_MEDIA_FIXTURE ?? "tests/data/example_image.jpg"
  };
}

function parseBooleanFlag(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return fallback;
}

function formatRunTimestamp(date) {
  const iso = date.toISOString();
  return iso
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}
