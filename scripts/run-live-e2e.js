import { runLiveE2EHarness } from "../src/e2e/live-harness.js";

const cleanup = process.env.LIVE_E2E_CLEANUP === "1";
const credentialsFile = process.env.LIVE_E2E_CREDENTIALS_FILE ?? "test_credentials.json";
const credentialsMarkdownFile = process.env.LIVE_E2E_CREDENTIALS_MD_FILE ?? "test_credentials.md";

const summary = await runLiveE2EHarness({
  credentialsFile,
  credentialsMarkdownFile,
  cleanup,
  log: (line) => console.log(`[live-e2e] ${line}`)
});

console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}
