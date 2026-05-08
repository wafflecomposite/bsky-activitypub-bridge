import { runLiveE2EHarness } from "../src/e2e/live-harness.js";

const cleanup = process.env.LIVE_E2E_CLEANUP === "1";
const credentialsFile = process.env.LIVE_E2E_CREDENTIALS_FILE ?? "test_credentials.json";
const credentialsMarkdownFile = process.env.LIVE_E2E_CREDENTIALS_MD_FILE ?? "test_credentials.md";
const mediaFixturePath = process.env.LIVE_E2E_MEDIA_FIXTURE ?? "tests/data/example_image.jpg";
const messageSignaturesEnabled = process.env.LIVE_E2E_ENABLE_HTTP_MESSAGE_SIGNATURES === "1";
const jetstreamMaxDidsPerStream = parsePositiveInteger(process.env.JETSTREAM_MAX_DIDS_PER_STREAM, 8000);
const extraWantedDids = parseList(process.env.LIVE_E2E_EXTRA_WANTED_DIDS);

const summary = await runLiveE2EHarness({
  credentialsFile,
  credentialsMarkdownFile,
  mediaFixturePath,
  messageSignaturesEnabled,
  jetstreamMaxDidsPerStream,
  extraWantedDids,
  cleanup,
  log: (line) => console.log(`[live-e2e] ${line}`)
});

console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}

function parsePositiveInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
