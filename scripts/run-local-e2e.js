import { runLocalE2EHarness } from "../src/e2e/local-harness.js";

const summary = await runLocalE2EHarness();

console.log(JSON.stringify(summary, null, 2));

if (!summary.ok) {
  process.exitCode = 1;
}
