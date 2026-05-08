import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildGtsRequest,
  evaluateTimelineThread,
  extractResolvedTargetFromHtml,
  extractPostRkeyFromAtUri,
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
      mastodon: {
        instanceUrl: "https://mastodon.example",
        accessToken: "mastodon-token"
      },
      bluesky: {
        identifier: "handle.bsky.social",
        appPassword: "app-pass",
        unfollowedPostUrl: "https://bsky.app/profile/did:plc:abc/post/3xyz"
      }
    }, null, 2));

    const credentials = loadLiveE2ECredentials({
      credentialsFile: jsonPath,
      credentialsMarkdownFile: null,
      env: {}
    });

    assert.equal(credentials.gtsInstanceUrl, "https://gts.example");
    assert.equal(credentials.gtsAccessToken, "token123");
    assert.equal(credentials.mastodonInstanceUrl, "https://mastodon.example");
    assert.equal(credentials.mastodonAccessToken, "mastodon-token");
    assert.deepEqual(credentials.receivers.map((receiver) => receiver.name), ["gts", "mastodon"]);
    assert.equal(credentials.blueskyIdentifier, "handle.bsky.social");
    assert.equal(credentials.blueskyAppPassword, "app-pass");
    assert.equal(credentials.blueskyUnfollowedPostUrl, "https://bsky.app/profile/did:plc:abc/post/3xyz");
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
      "App password: md-app-pass",
      "Unfollowed Post URL: https://bsky.app/profile/did:plc:md/post/3md"
    ].join("\n"));

    const credentials = loadLiveE2ECredentials({
      credentialsFile: join(dir, "missing.json"),
      credentialsMarkdownFile: markdownPath,
      env: {}
    });

    assert.equal(credentials.gtsInstanceUrl, "https://gts.md.example");
    assert.equal(credentials.gtsAccessToken, "md-token");
    assert.deepEqual(credentials.receivers.map((receiver) => receiver.name), ["gts"]);
    assert.equal(credentials.blueskyIdentifier, "md-handle.bsky.social");
    assert.equal(credentials.blueskyAppPassword, "md-app-pass");
    assert.equal(credentials.blueskyUnfollowedPostUrl, "https://bsky.app/profile/did:plc:md/post/3md");
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
      MASTODON_INSTANCE_URL: "https://mastodon.env.example",
      MASTODON_ACCESS_TOKEN: "mastodon-env-token",
      BLUESKY_IDENTIFIER: "env-handle.bsky.social",
      BLUESKY_APP_PASSWORD: "env-app-pass",
      BLUESKY_UNFOLLOWED_POST_URL: "https://bsky.app/profile/did:plc:env/post/3env"
    }
  });

  assert.equal(credentials.gtsInstanceUrl, "https://gts.env.example");
  assert.equal(credentials.gtsAccessToken, "env-token");
  assert.deepEqual(credentials.receivers.map((receiver) => receiver.name), ["gts", "mastodon"]);
  assert.equal(credentials.blueskyIdentifier, "env-handle.bsky.social");
  assert.equal(credentials.blueskyAppPassword, "env-app-pass");
  assert.equal(credentials.blueskyUnfollowedPostUrl, "https://bsky.app/profile/did:plc:env/post/3env");
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

test("evaluateTimelineThread detects linked reply by status id", () => {
  const result = evaluateTimelineThread({
    statuses: [
      {
        id: "099",
        content: "<p>Bridge automated live e2e root 2026-03-04T00:00:00.000Z</p>",
        uri: "https://old-bridge.example/ap/object/did%3Aplc%3Aalice/post1",
        visibility: "public",
        account: {
          acct: "alice.bsky.social@old-bridge.example"
        }
      },
      {
        id: "100",
        content: "<p>Bridge automated live e2e root 2026-03-04T00:00:00.000Z</p>",
        uri: "https://gts.example/users/a/statuses/100",
        visibility: "unlisted",
        account: {
          acct: "alice.bsky.social@bridge.example"
        }
      },
      {
        id: "101",
        content: "<p>Bridge automated live e2e reply 2026-03-04T00:00:00.000Z</p>",
        in_reply_to_id: "100",
        uri: "https://gts.example/users/a/statuses/101",
        visibility: "unlisted",
        account: {
          acct: "alice.bsky.social@bridge.example"
        }
      }
    ],
    rootMarker: "Bridge automated live e2e root 2026-03-04T00:00:00.000Z",
    replyMarker: "Bridge automated live e2e reply 2026-03-04T00:00:00.000Z",
    expectedRemoteAcct: "alice.bsky.social@bridge.example",
    expectedVisibility: "unlisted"
  });

  assert.equal(result.rootFound, true);
  assert.equal(result.replyFound, true);
  assert.equal(result.threadLinked, true);
  assert.equal(result.rootStatusId, "100");
  assert.equal(result.replyStatusId, "101");
  assert.equal(result.rootVisibility, "unlisted");
  assert.equal(result.replyVisibility, "unlisted");
  assert.equal(result.rootVisibilityMatches, true);
  assert.equal(result.replyVisibilityMatches, true);
});

test("evaluateTimelineThread reports unlinked markers when reply relation missing", () => {
  const result = evaluateTimelineThread({
    statuses: [
      {
        id: "100",
        text: "root marker"
      },
      {
        id: "101",
        text: "reply marker",
        in_reply_to_id: null
      }
    ],
    rootMarker: "root marker",
    replyMarker: "reply marker"
  });

  assert.equal(result.rootFound, true);
  assert.equal(result.replyFound, true);
  assert.equal(result.threadLinked, false);
});

test("extractPostRkeyFromAtUri extracts rkey", () => {
  assert.equal(
    extractPostRkeyFromAtUri("at://did:plc:alice/app.bsky.feed.post/3mgam4k7asq2g"),
    "3mgam4k7asq2g"
  );
});

test("extractPostRkeyFromAtUri rejects non-post at uri", () => {
  assert.throws(() => {
    extractPostRkeyFromAtUri("at://did:plc:alice/app.bsky.actor.profile/self");
  }, /Invalid AT URI for post/);
});

test("extractResolvedTargetFromHtml reads resolver target code block", () => {
  const html = `
    <div class="copy-row">
      <code id="resolved-target">alice.bsky.social@bridge.example</code>
      <button type="button">Copy</button>
    </div>
  `;

  assert.equal(extractResolvedTargetFromHtml(html), "alice.bsky.social@bridge.example");
});

test("extractResolvedTargetFromHtml decodes escaped entities", () => {
  const html = `<code id="resolved-target">https://bridge.example/ap/object/did%3Aplc%3Aalice/root1&amp;x=1</code>`;
  assert.equal(
    extractResolvedTargetFromHtml(html),
    "https://bridge.example/ap/object/did%3Aplc%3Aalice/root1&x=1"
  );
});
