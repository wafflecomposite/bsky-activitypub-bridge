import test from "node:test";
import assert from "node:assert/strict";
import { isDebugLogEnabled, parseDebugLogTokens } from "../src/config/debug-logs.js";

test("parseDebugLogTokens normalizes comma and whitespace separated values", () => {
  assert.deepEqual(parseDebugLogTokens(" follow,Jetstream  delivery "), ["follow", "jetstream", "delivery"]);
});

test("isDebugLogEnabled is disabled by default", () => {
  assert.equal(isDebugLogEnabled(undefined, "follow"), false);
  assert.equal(isDebugLogEnabled("", "follow"), false);
  assert.equal(isDebugLogEnabled("0", "follow"), false);
  assert.equal(isDebugLogEnabled("false", "follow"), false);
});

test("isDebugLogEnabled accepts explicit categories", () => {
  assert.equal(isDebugLogEnabled("follow", "follow"), true);
  assert.equal(isDebugLogEnabled("jetstream,follow", "follow"), true);
  assert.equal(isDebugLogEnabled("jetstream", "follow"), false);
});

test("isDebugLogEnabled accepts all-debug aliases", () => {
  assert.equal(isDebugLogEnabled("all", "follow"), true);
  assert.equal(isDebugLogEnabled("*", "follow"), true);
  assert.equal(isDebugLogEnabled("1", "follow"), true);
  assert.equal(isDebugLogEnabled("true", "follow"), true);
});
