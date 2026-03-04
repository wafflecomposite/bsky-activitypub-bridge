import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGtsRequest,
  extractTunnelUrlFromLine,
  loadLiveE2ECredentials
} from "../src/e2e/live-harness.js";

test("extractTunnelUrlFromLine parses trycloudflare url", () => {
  const line = "Your quick Tunnel has been created! Visit it at https://abc-def.trycloudflare.com";
  assert.equal(extractTunnelUrlFromLine(line), "https://abc-def.trycloudflare.com");
});

test("loadLiveE2ECredentials loads values from json file", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-live-e2e-creds-"));
  const jsonPath = join(dir, "test_credentials.json");

  try {
    writeFileSync(jsonPath, JSON.stringify({
      gts: {
        instanceUrl: "https://gts.example",
        accessToken: "token123"
      },
      bluesky: {
        identifier: "handle.bsky.social",
        appPassword: "app-pass"
      }
    }, null, 2));

    const credentials = loadLiveE2ECredentials({
      credentialsFile: jsonPath,
      credentialsMarkdownFile: null,
      env: {}
    });

    assert.equal(credentials.gtsInstanceUrl, "https://gts.example");
    assert.equal(credentials.gtsAccessToken, "token123");
    assert.equal(credentials.blueskyIdentifier, "handle.bsky.social");
    assert.equal(credentials.blueskyAppPassword, "app-pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLiveE2ECredentials falls back to markdown labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-live-e2e-creds-"));
  const markdownPath = join(dir, "test_credentials.md");

  try {
    writeFileSync(markdownPath, [
      "Instance URL: https://gts.md.example",
      "Access Token: md-token",
      "User: md-handle.bsky.social",
      "App password: md-app-pass"
    ].join("\n"));

    const credentials = loadLiveE2ECredentials({
      credentialsFile: join(dir, "missing.json"),
      credentialsMarkdownFile: markdownPath,
      env: {}
    });

    assert.equal(credentials.gtsInstanceUrl, "https://gts.md.example");
    assert.equal(credentials.gtsAccessToken, "md-token");
    assert.equal(credentials.blueskyIdentifier, "md-handle.bsky.social");
    assert.equal(credentials.blueskyAppPassword, "md-app-pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadLiveE2ECredentials gives env priority over file values", () => {
  const credentials = loadLiveE2ECredentials({
    credentialsFile: null,
    credentialsMarkdownFile: null,
    env: {
      GTS_INSTANCE_URL: "https://gts.env.example",
      GTS_ACCESS_TOKEN: "env-token",
      BLUESKY_IDENTIFIER: "env-handle.bsky.social",
      BLUESKY_APP_PASSWORD: "env-app-pass"
    }
  });

  assert.equal(credentials.gtsInstanceUrl, "https://gts.env.example");
  assert.equal(credentials.gtsAccessToken, "env-token");
  assert.equal(credentials.blueskyIdentifier, "env-handle.bsky.social");
  assert.equal(credentials.blueskyAppPassword, "env-app-pass");
});

test("loadLiveE2ECredentials fails when nothing is provided", () => {
  assert.throws(() => {
    loadLiveE2ECredentials({
      credentialsFile: null,
      credentialsMarkdownFile: null,
      env: {}
    });
  }, /Missing live E2E credentials/);
});

test("buildGtsRequest omits content-type for empty body requests", () => {
  const req = buildGtsRequest({
    accessToken: "abc",
    method: "POST",
    body: null
  });

  assert.equal(req.method, "POST");
  assert.equal(req.headers.authorization, "Bearer abc");
  assert.equal("content-type" in req.headers, false);
  assert.equal(req.body, null);
});

test("buildGtsRequest sets json body and content-type when body exists", () => {
  const req = buildGtsRequest({
    accessToken: "abc",
    method: "POST",
    body: { resolve: true }
  });

  assert.equal(req.headers["content-type"], "application/json");
  assert.equal(req.body, "{\"resolve\":true}");
});
