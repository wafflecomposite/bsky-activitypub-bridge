import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { createBridgeApplication } from "../app/application.js";
import { getProfile } from "../bsky/public-api.js";
import { blueskyPostUrl, blueskyProfileUrl } from "../bsky/web-url.js";

const DEFAULT_DID = "did:plc:ct7l6fgjtseazmaunhzrbydz";
const DEFAULT_UNFOLLOWED_POST_URL = "https://bsky.app/profile/did:plc:22tkvmk7w562u3vueqeufkoa/post/3mgapjtxh5k2p";
const LIVE_E2E_CONTENT_LABEL = "graphic-media";
const LIVE_E2E_CONTENT_WARNING = "Graphic Media";

export async function runLiveE2EHarness({
  credentials = null,
  credentialsFile = "test_credentials.json",
  credentialsMarkdownFile = "test_credentials.md",
  cloudflaredPath = "./tools/bin/cloudflared",
  mediaFixturePath = "tests/data/example_image.jpg",
  messageSignaturesEnabled = false,
  cleanup = false,
  workDir = null,
  log = () => {}
} = {}) {
  const resolvedCredentials = credentials ?? loadLiveE2ECredentials({
    credentialsFile,
    credentialsMarkdownFile
  });

  const tempDir = workDir ?? mkdtempSync(join(tmpdir(), "bridge-live-e2e-"));
  const port = await getFreePort();

  let tunnel = null;
  let app = null;

  try {
    tunnel = await startQuickTunnel({
      cloudflaredPath,
      port,
      log
    });

    const tunnelUrl = tunnel.url;
    const did = await resolveDidFromHandle(resolvedCredentials.blueskyIdentifier);
    const expectedBlueskyProfileUrl = blueskyProfileUrl({
      did,
      handle: resolvedCredentials.blueskyIdentifier
    });

    app = createBridgeApplication({
      baseUrl: tunnelUrl,
      dataDir: tempDir,
      strictInboxSignatures: false,
      postVisibility: "unlisted",
      jetstream: {
        enabled: false
      },
      delivery: {
        drainIntervalMs: 500,
        drainBatchSize: 100,
        messageSignaturesEnabled,
        onTransportResult: (event) => {
          if (event.status === null || event.status >= 400) {
            log(`delivery-failure destination=${event.destination} status=${event.status} body=${event.responseBody ?? ""}`);
          }
        }
      }
    });

    app.store.upsertActor({ did, handle: resolvedCredentials.blueskyIdentifier });
    app.keyManager.ensureKeyPair(did);
    await app.start({ host: "127.0.0.1", port });

    await waitForBridgeReady({ port, did, timeoutMs: 90_000 });
    const localBaseUrl = `http://127.0.0.1:${port}`;
    const bridgeActorProfile = await verifyBridgeActorProfile({
      tunnelUrl,
      port,
      did,
      blueskyIdentifier: resolvedCredentials.blueskyIdentifier,
      expectedProfileUrl: expectedBlueskyProfileUrl
    });

    const resolverActor = await verifyResolverActorTarget({
      resolverBaseUrl: localBaseUrl,
      query: resolvedCredentials.blueskyIdentifier
    });
    const resolverUnfollowedPost = await verifyResolverPostTargetFromQuery({
      resolverBaseUrl: localBaseUrl,
      publicBaseUrl: tunnelUrl,
      query: resolvedCredentials.blueskyUnfollowedPostUrl
    });
    const resolverUnfollowedPostSearch = await waitForStatusSearchByUrl({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      targetUrl: resolverUnfollowedPost.target,
      marker: null,
      timeoutMs: 180_000,
      log
    });
    const remoteAcct = resolverActor.target;
    const discovered = await discoverRemoteAccountWithRetry({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      remoteAcct,
      timeoutMs: 180_000,
      log
    });
    const remoteAccountProfile = await waitForRemoteAccountBotProfile({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      accountId: discovered.id,
      timeoutMs: 60_000,
      log
    });

    const followState = await followAndWait({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      accountId: discovered.id,
      timeoutMs: 180_000,
      log
    });

    await app.stop();
    app = null;

    app = createBridgeApplication({
      baseUrl: tunnelUrl,
      dataDir: tempDir,
      strictInboxSignatures: false,
      postVisibility: "unlisted",
      jetstream: {
        enabled: true,
        autoFollowedDids: false,
        wantedDids: [did],
        wantedCollections: ["app.bsky.feed.post", "app.bsky.feed.repost"],
        wantedDidsRefreshMs: 0
      },
      delivery: {
        drainIntervalMs: 500,
        drainBatchSize: 100,
        messageSignaturesEnabled,
        onTransportResult: (event) => {
          if (event.status === null || event.status >= 400) {
            log(`delivery-failure destination=${event.destination} status=${event.status} body=${event.responseBody ?? ""}`);
          }
        }
      }
    });

    app.store.upsertActor({ did, handle: resolvedCredentials.blueskyIdentifier });
    await app.start({ host: "127.0.0.1", port });

    const postedThread = await createBlueskyThread({
      identifier: resolvedCredentials.blueskyIdentifier,
      appPassword: resolvedCredentials.blueskyAppPassword,
      textPrefix: "Bridge automated live e2e"
    });

    const timelineThread = await waitForTimelineThread({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      rootMarker: postedThread.root.marker,
      replyMarker: postedThread.reply.marker,
      timeoutMs: 180_000,
      log
    });

    const rootRkey = extractPostRkeyFromAtUri(postedThread.root.uri);
    const replyRkey = extractPostRkeyFromAtUri(postedThread.reply.uri);
    const expectedRootBlueskyPostUrl = blueskyPostUrl({ did, rkey: rootRkey });
    const resolverPost = await verifyResolverPostTarget({
      resolverBaseUrl: localBaseUrl,
      publicBaseUrl: tunnelUrl,
      handle: resolvedCredentials.blueskyIdentifier,
      rkey: rootRkey
    });
    const resolverPostSearch = await waitForStatusSearchByUrl({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      targetUrl: resolverPost.target,
      marker: postedThread.root.marker,
      timeoutMs: 180_000,
      log
    });
    const bridgeReadSurface = await waitForBridgeThreadReadSurface({
      localBaseUrl,
      publicBaseUrl: tunnelUrl,
      did,
      rootRkey,
      replyRkey,
      rootMarker: postedThread.root.marker,
      replyMarker: postedThread.reply.marker,
      timeoutMs: 90_000,
      log
    });

    const postedMedia = await createBlueskyImagePost({
      identifier: resolvedCredentials.blueskyIdentifier,
      appPassword: resolvedCredentials.blueskyAppPassword,
      textPrefix: "Bridge automated live e2e media",
      imagePath: mediaFixturePath
    });

    const timelineMedia = await waitForTimelineMediaPost({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      marker: postedMedia.marker,
      timeoutMs: 180_000,
      log
    });

    const mediaRkey = extractPostRkeyFromAtUri(postedMedia.uri);
    const bridgeMediaObject = await waitForBridgeMediaObject({
      localBaseUrl,
      did,
      rkey: mediaRkey,
      marker: postedMedia.marker,
      timeoutMs: 90_000,
      log
    });

    const postedLabeledMedia = await createBlueskyImagePost({
      identifier: resolvedCredentials.blueskyIdentifier,
      appPassword: resolvedCredentials.blueskyAppPassword,
      textPrefix: "Bridge automated live e2e labeled media",
      imagePath: mediaFixturePath,
      labels: [{ val: LIVE_E2E_CONTENT_LABEL }]
    });

    const timelineLabeledMedia = await waitForTimelineMediaPost({
      instanceUrl: resolvedCredentials.gtsInstanceUrl,
      accessToken: resolvedCredentials.gtsAccessToken,
      marker: postedLabeledMedia.marker,
      timeoutMs: 180_000,
      expectedSensitive: true,
      expectedSpoilerText: LIVE_E2E_CONTENT_WARNING,
      log
    });

    const labeledMediaRkey = extractPostRkeyFromAtUri(postedLabeledMedia.uri);
    const bridgeLabeledMediaObject = await waitForBridgeMediaObject({
      localBaseUrl,
      did,
      rkey: labeledMediaRkey,
      marker: postedLabeledMedia.marker,
      timeoutMs: 90_000,
      expectedSensitive: true,
      expectedSummary: LIVE_E2E_CONTENT_WARNING,
      log
    });
    const postedRepost = await createBlueskyRepost({
      identifier: resolvedCredentials.blueskyIdentifier,
      appPassword: resolvedCredentials.blueskyAppPassword,
      subjectUri: postedThread.root.uri,
      subjectCid: postedThread.root.cid
    });

    const bridgeRepost = await waitForBridgeRepostActivity({
      localBaseUrl,
      publicBaseUrl: tunnelUrl,
      did,
      rootDid: did,
      rootRkey: rootRkey,
      timeoutMs: 90_000,
      log
    });
    await waitForQueueDepthZero({
      runtime: app.getRuntime(),
      timeoutMs: 90_000,
      log
    });
    const runtimeMetrics = app.getRuntime()?.getMetrics() ?? null;

    const summary = {
      ok: followState.following === true
        && bridgeActorProfile.serviceActor === true
        && bridgeActorProfile.bot === true
        && bridgeActorProfile.profileUrlMatches === true
        && remoteAccountProfile.bot === true
        && remoteAccountProfile.url === expectedBlueskyProfileUrl
        && bridgeActorProfile.featuredCollection === true
        && bridgeActorProfile.summaryHasBridgeNotice === true
        && bridgeActorProfile.avatarMatches === true
        && bridgeActorProfile.bannerMatches === true
        && bridgeActorProfile.summaryContainsDescription === true
        && resolverActor.ok === true
        && resolverUnfollowedPost.ok === true
        && resolverUnfollowedPostSearch.found === true
        && resolverPost.ok === true
        && resolverPostSearch.found === true
        && resolverPostSearch.url === expectedRootBlueskyPostUrl
        && timelineThread.threadLinked === true
        && bridgeReadSurface.ok === true
        && timelineMedia.hasMediaAttachment === true
        && bridgeMediaObject.hasAttachment === true
        && timelineLabeledMedia.hasMediaAttachment === true
        && timelineLabeledMedia.sensitive === true
        && timelineLabeledMedia.spoilerText === LIVE_E2E_CONTENT_WARNING
        && bridgeLabeledMediaObject.hasAttachment === true
        && bridgeLabeledMediaObject.noteSensitive === true
        && bridgeLabeledMediaObject.attachmentSensitive === true
        && bridgeLabeledMediaObject.summary === LIVE_E2E_CONTENT_WARNING
        && bridgeRepost.found === true
        && (runtimeMetrics?.delivery?.delivered ?? 0) >= 3,
      tunnelUrl,
      dataDir: tempDir,
      remoteAcct,
      did,
      expectedBlueskyProfileUrl,
      expectedRootBlueskyPostUrl,
      discovered,
      remoteAccountProfile,
      followState,
      bridgeActorProfile,
      resolverActor,
      resolverUnfollowedPost,
      resolverUnfollowedPostSearch,
      postedThread,
      resolverPost,
      resolverPostSearch,
      timelineThread,
      bridgeReadSurface,
      postedMedia,
      timelineMedia,
      bridgeMediaObject,
      postedLabeledMedia,
      timelineLabeledMedia,
      bridgeLabeledMediaObject,
      postedRepost,
      bridgeRepost,
      runtimeMetrics
    };

    return summary;
  } finally {
    await safeStopApp(app);
    await safeStopTunnel(tunnel);

    if (!workDir && cleanup) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

export function loadLiveE2ECredentials({
  credentialsFile = "test_credentials.json",
  credentialsMarkdownFile = "test_credentials.md",
  env = process.env
} = {}) {
  const jsonCredentials = credentialsFile ? readJsonSafe(credentialsFile) : null;
  const fileText = credentialsMarkdownFile ? readFileSafe(credentialsMarkdownFile) : null;

  const gtsInstanceUrl = env.GTS_INSTANCE_URL
    ?? pickFirstString([
      jsonCredentials?.gtsInstanceUrl,
      jsonCredentials?.gts?.instanceUrl
    ])
    ?? extractLabeledValue(fileText, "Instance URL");
  const gtsAccessToken = env.GTS_ACCESS_TOKEN
    ?? pickFirstString([
      jsonCredentials?.gtsAccessToken,
      jsonCredentials?.gts?.accessToken
    ])
    ?? extractLabeledValue(fileText, "Access Token");
  const blueskyIdentifier = env.BLUESKY_IDENTIFIER
    ?? pickFirstString([
      jsonCredentials?.blueskyIdentifier,
      jsonCredentials?.bluesky?.identifier
    ])
    ?? extractLabeledValue(fileText, "User");
  const blueskyAppPassword = env.BLUESKY_APP_PASSWORD
    ?? pickFirstString([
      jsonCredentials?.blueskyAppPassword,
      jsonCredentials?.bluesky?.appPassword
    ])
    ?? extractLabeledValue(fileText, "App password");
  const blueskyUnfollowedPostUrl = env.BLUESKY_UNFOLLOWED_POST_URL
    ?? pickFirstString([
      jsonCredentials?.blueskyUnfollowedPostUrl,
      jsonCredentials?.bluesky?.unfollowedPostUrl
    ])
    ?? extractLabeledValue(fileText, "Unfollowed Post URL")
    ?? DEFAULT_UNFOLLOWED_POST_URL;

  const missing = [];
  if (!gtsInstanceUrl) {
    missing.push("GTS_INSTANCE_URL or 'Instance URL' in credentials file");
  }
  if (!gtsAccessToken) {
    missing.push("GTS_ACCESS_TOKEN or 'Access Token' in credentials file");
  }
  if (!blueskyIdentifier) {
    missing.push("BLUESKY_IDENTIFIER or 'User' in credentials file");
  }
  if (!blueskyAppPassword) {
    missing.push("BLUESKY_APP_PASSWORD or 'App password' in credentials file");
  }

  if (missing.length > 0) {
    throw new Error(`Missing live E2E credentials: ${missing.join(", ")}`);
  }

  return {
    gtsInstanceUrl,
    gtsAccessToken,
    blueskyIdentifier,
    blueskyAppPassword,
    blueskyUnfollowedPostUrl
  };
}

export function extractTunnelUrlFromLine(line) {
  const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
  return match ? match[0] : null;
}

async function startQuickTunnel({ cloudflaredPath, port, log }) {
  const maxAttempts = 3;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const args = ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
    const child = spawn(cloudflaredPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    let url = null;
    const lines = [];

    const onData = (chunk) => {
      const text = chunk.toString("utf8");
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) {
          continue;
        }

        lines.push(line);
        const parsed = extractTunnelUrlFromLine(line);
        if (parsed && !url) {
          url = parsed;
        }
      }
    };

    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    try {
      await waitForCondition(() => url !== null, 45_000, 250);
      log(`tunnel-url=${url}`);
      return { child, url, lines };
    } catch (error) {
      lastError = error;
      log(`tunnel-attempt=${attempt} failed: ${error instanceof Error ? error.message : String(error)}`);
      await safeStopTunnel({ child });
    }
  }

  throw lastError ?? new Error("Unable to establish a quick tunnel");
}

async function safeStopTunnel(tunnel) {
  if (!tunnel?.child || tunnel.child.killed) {
    return;
  }

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      tunnel.child.kill("SIGKILL");
    }, 2_000);

    tunnel.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    tunnel.child.kill("SIGINT");
  });
}

async function safeStopApp(app) {
  if (!app) {
    return;
  }

  try {
    await app.stop();
  } catch {
    // best effort
  }
}

async function resolveDidFromHandle(handle) {
  const response = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
  if (!response.ok) {
    throw new Error(`Failed to resolve Bluesky handle: ${handle} (${response.status})`);
  }

  const body = await response.json();
  return body.did ?? DEFAULT_DID;
}

async function waitForBridgeReady({ port, did, timeoutMs }) {
  const actorUrl = `http://127.0.0.1:${port}/ap/actor/${encodeURIComponent(did)}`;

  await waitForCondition(async () => {
    const response = await fetch(actorUrl);
    return response.ok;
  }, timeoutMs, 1_000);
}

async function verifyBridgeActorProfile({ tunnelUrl, port, did, blueskyIdentifier, expectedProfileUrl }) {
  const localBaseUrl = `http://127.0.0.1:${port}`;
  const actorUrl = `${localBaseUrl}/ap/actor/${encodeURIComponent(did)}`;
  const featuredUrl = `${localBaseUrl}/ap/actor/${encodeURIComponent(did)}/featured`;

  const actorResponse = await retryFetch(() => fetch(actorUrl), 15, 500);
  if (!actorResponse.ok) {
    throw new Error(`Bridge actor endpoint not available: ${actorResponse.status}`);
  }

  const actor = await actorResponse.json();
  const featuredResponse = await retryFetch(() => fetch(featuredUrl), 15, 500);
  if (!featuredResponse.ok) {
    throw new Error(`Bridge featured endpoint not available: ${featuredResponse.status}`);
  }

  const featured = await featuredResponse.json();
  const upstream = await retryFetch(
    () => getProfile({ actor: blueskyIdentifier }),
    6,
    1000
  );

  const avatarMatches = upstream.avatarUrl
    ? areEquivalentMediaUrls(actor?.icon?.url, upstream.avatarUrl)
    : true;
  const bannerMatches = upstream.bannerUrl
    ? areEquivalentMediaUrls(actor?.image?.url, upstream.bannerUrl)
    : true;
  const summaryContainsDescription = upstream.description
    ? String(actor?.summary ?? "").includes(upstream.description)
    : true;

  return {
    serviceActor: actor?.type === "Service",
    bot: actor?.bot === true,
    actorType: actor?.type ?? null,
    profileUrl: actor?.url ?? null,
    profileUrlMatches: actor?.url === expectedProfileUrl,
    featuredCollection: featured?.type === "OrderedCollection",
    summaryHasBridgeNotice: String(actor?.summary ?? "").includes(`Bridged by ${tunnelUrl}`),
    avatarMatches,
    bannerMatches,
    summaryContainsDescription
  };
}

async function verifyResolverActorTarget({ resolverBaseUrl, query }) {
  const jsonResult = await resolveDiscoveryTargetViaApi({ resolverBaseUrl, query });
  const htmlTarget = await resolveDiscoveryTargetViaHtml({ resolverBaseUrl, query });

  return {
    ok: jsonResult.kind === "actor" && jsonResult.target === htmlTarget,
    kind: jsonResult.kind,
    target: jsonResult.target,
    htmlTarget
  };
}

async function verifyResolverPostTarget({ resolverBaseUrl, publicBaseUrl, handle, rkey }) {
  const query = `https://bsky.app/profile/${handle}/post/${rkey}`;
  return verifyResolverPostTargetFromQuery({
    resolverBaseUrl,
    publicBaseUrl,
    query,
    expectedRkey: rkey
  });
}

async function verifyResolverPostTargetFromQuery({ resolverBaseUrl, publicBaseUrl, query, expectedRkey = null }) {
  const jsonResult = await resolveDiscoveryTargetViaApi({ resolverBaseUrl, query });
  const htmlTarget = await resolveDiscoveryTargetViaHtml({ resolverBaseUrl, query });
  const expectedPostUrl = `${publicBaseUrl}/ap/object/${encodeURIComponent(jsonResult.did)}/${encodeURIComponent(jsonResult.rkey)}`;
  const rkeyMatches = expectedRkey === null || expectedRkey === jsonResult.rkey;

  return {
    ok: jsonResult.kind === "post" && jsonResult.target === htmlTarget && jsonResult.target === expectedPostUrl && rkeyMatches,
    kind: jsonResult.kind,
    did: jsonResult.did,
    rkey: jsonResult.rkey,
    target: jsonResult.target,
    htmlTarget,
    query
  };
}

async function resolveDiscoveryTargetViaApi({ resolverBaseUrl, query }) {
  const response = await retryFetch(
    () => fetch(`${resolverBaseUrl}/api/resolve?q=${encodeURIComponent(query)}`),
    90,
    1000
  );
  if (!response.ok) {
    throw new Error(`resolver api failed: ${response.status}`);
  }

  const body = await response.json();
  if (!body?.ok || !body?.result || typeof body.result !== "object") {
    throw new Error("resolver api returned invalid payload");
  }

  if (body.result.kind === "post") {
    return {
      kind: "post",
      did: body.result.did,
      rkey: body.result.rkey,
      target: body.result.postUrl
    };
  }

  return {
    kind: "actor",
    did: body.result.did,
    target: body.result.acct
  };
}

async function resolveDiscoveryTargetViaHtml({ resolverBaseUrl, query }) {
  const response = await retryFetch(
    () => fetch(`${resolverBaseUrl}/?q=${encodeURIComponent(query)}`),
    90,
    1000
  );
  if (!response.ok) {
    throw new Error(`resolver html failed: ${response.status}`);
  }

  const html = await response.text();
  const target = extractResolvedTargetFromHtml(html);
  if (!target) {
    throw new Error("resolver html did not include resolved target");
  }

  return target;
}

async function discoverRemoteAccountWithRetry({ instanceUrl, accessToken, remoteAcct, timeoutMs, log }) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const path = `/api/v2/search?q=${encodeURIComponent(remoteAcct)}&resolve=true&limit=40&type=accounts&offset=0`;
      const body = await gtsApi({ instanceUrl, accessToken, path, timeoutMs: 30_000 });
      const accounts = Array.isArray(body.accounts) ? body.accounts : [];
      const match = accounts.find((account) => account.acct === remoteAcct) ?? accounts[0] ?? null;

      if (match?.id) {
        return {
          id: match.id,
          acct: match.acct,
          url: match.url,
          bot: match.bot === true
        };
      }
    } catch (error) {
      log(`discover-retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  throw new Error(`Unable to discover remote account within timeout: ${remoteAcct}`);
}

async function waitForRemoteAccountBotProfile({ instanceUrl, accessToken, accountId, timeoutMs, log }) {
  const startedAt = Date.now();
  let last = {
    id: accountId,
    acct: null,
    url: null,
    bot: false,
    rawBot: null
  };

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const account = await gtsApi({
        instanceUrl,
        accessToken,
        path: `/api/v1/accounts/${encodeURIComponent(accountId)}`,
        timeoutMs: 30_000
      });

      last = {
        id: account?.id ?? accountId,
        acct: account?.acct ?? null,
        url: account?.url ?? null,
        bot: account?.bot === true,
        rawBot: account?.bot ?? null
      };

      if (last.bot) {
        return last;
      }

      log(`remote account bot flag not visible yet; bot=${String(last.rawBot)}`);
    } catch (error) {
      log(`remote-account-bot retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  return last;
}

async function followAndWait({ instanceUrl, accessToken, accountId, timeoutMs, log }) {
  await gtsApi({
    instanceUrl,
    accessToken,
    path: `/api/v1/accounts/${encodeURIComponent(accountId)}/follow`,
    method: "POST",
    timeoutMs: 30_000
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const rel = await gtsApi({
        instanceUrl,
        accessToken,
        path: `/api/v1/accounts/relationships?id[]=${encodeURIComponent(accountId)}`,
        timeoutMs: 30_000
      });

      const state = Array.isArray(rel) ? rel[0] : rel?.[0];
      if (state?.following === true) {
        return {
          following: true,
          requested: state.requested ?? false
        };
      }

      if (state?.requested === true) {
        log("follow still requested; waiting...");
      }
    } catch (error) {
      log(`follow-state retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  throw new Error("Follow did not reach following=true before timeout");
}

async function createBlueskySession({ identifier, appPassword }) {
  const sessionResponse = await fetch("https://bsky.social/xrpc/com.atproto.server.createSession", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      identifier,
      password: appPassword
    })
  });

  if (!sessionResponse.ok) {
    throw new Error(`Bluesky session failed: ${sessionResponse.status}`);
  }

  return sessionResponse.json();
}

async function createBlueskyPostRecord({ session, text, reply = null, recordExtra = null }) {
  const nowIso = new Date().toISOString();
  const createResponse = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.post",
      record: {
        $type: "app.bsky.feed.post",
        text,
        createdAt: nowIso,
        ...(reply ? { reply } : {}),
        ...(recordExtra && typeof recordExtra === "object" ? recordExtra : {})
      }
    })
  });

  if (!createResponse.ok) {
    throw new Error(`Bluesky post failed: ${createResponse.status}`);
  }

  return createResponse.json();
}

async function createBlueskyImagePost({ identifier, appPassword, textPrefix, imagePath, labels = null }) {
  if (!imagePath) {
    throw new Error("imagePath is required for media post");
  }

  const marker = `${textPrefix} ${new Date().toISOString()}`;
  const session = await createBlueskySession({ identifier, appPassword });
  const imageBytes = readFileSync(imagePath);

  const uploadResponse = await fetch("https://bsky.social/xrpc/com.atproto.repo.uploadBlob", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      "content-type": inferMediaMimeType(imagePath)
    },
    body: imageBytes
  });

  if (!uploadResponse.ok) {
    throw new Error(`Bluesky blob upload failed: ${uploadResponse.status}`);
  }

  const uploaded = await uploadResponse.json();
  const blob = uploaded?.blob;
  if (!blob || typeof blob !== "object") {
    throw new Error("Bluesky blob upload returned invalid payload");
  }

  const created = await createBlueskyPostRecord({
    session,
    text: marker,
    recordExtra: {
      ...(Array.isArray(labels) && labels.length > 0
        ? {
            labels: {
              $type: "com.atproto.label.defs#selfLabels",
              values: labels
            }
          }
        : {}),
      embed: {
        $type: "app.bsky.embed.images",
        images: [{
          alt: "bridge media fixture",
          image: blob
        }]
      }
    }
  });

  return {
    marker,
    uri: created.uri,
    cid: created.cid
  };
}

async function createBlueskyRepost({ identifier, appPassword, subjectUri, subjectCid }) {
  const session = await createBlueskySession({ identifier, appPassword });
  const nowIso = new Date().toISOString();
  const createResponse = await fetch("https://bsky.social/xrpc/com.atproto.repo.createRecord", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session.accessJwt}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      repo: session.did,
      collection: "app.bsky.feed.repost",
      record: {
        $type: "app.bsky.feed.repost",
        createdAt: nowIso,
        subject: {
          uri: subjectUri,
          cid: subjectCid
        }
      }
    })
  });

  if (!createResponse.ok) {
    throw new Error(`Bluesky repost failed: ${createResponse.status}`);
  }

  const created = await createResponse.json();
  return {
    uri: created.uri,
    cid: created.cid
  };
}

async function createBlueskyThread({ identifier, appPassword, textPrefix }) {
  const nonce = new Date().toISOString();
  const rootMarker = `${textPrefix} root ${nonce}`;
  const replyMarker = `${textPrefix} reply ${nonce}`;
  const session = await createBlueskySession({ identifier, appPassword });

  const rootCreated = await createBlueskyPostRecord({
    session,
    text: rootMarker
  });

  const replyCreated = await createBlueskyPostRecord({
    session,
    text: replyMarker,
    reply: {
      root: {
        uri: rootCreated.uri,
        cid: rootCreated.cid
      },
      parent: {
        uri: rootCreated.uri,
        cid: rootCreated.cid
      }
    }
  });

  return {
    root: {
      marker: rootMarker,
      uri: rootCreated.uri,
      cid: rootCreated.cid
    },
    reply: {
      marker: replyMarker,
      uri: replyCreated.uri,
      cid: replyCreated.cid
    }
  };
}

async function waitForTimelineThread({ instanceUrl, accessToken, rootMarker, replyMarker, timeoutMs, log }) {
  const startedAt = Date.now();
  let lastEvaluation = {
    rootFound: false,
    replyFound: false,
    threadLinked: false,
    rootStatusId: null,
    replyStatusId: null
  };

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const statuses = await gtsApi({
        instanceUrl,
        accessToken,
        path: "/api/v1/timelines/home?limit=80",
        timeoutMs: 30_000
      });

      lastEvaluation = evaluateTimelineThread({
        statuses,
        rootMarker,
        replyMarker
      });

      if (lastEvaluation.threadLinked) {
        return {
          found: true,
          ...lastEvaluation
        };
      }

      if (lastEvaluation.rootFound || lastEvaluation.replyFound) {
        log(`timeline progress rootFound=${lastEvaluation.rootFound} replyFound=${lastEvaluation.replyFound} linked=${lastEvaluation.threadLinked}`);
      }
    } catch (error) {
      log(`timeline retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(3_000);
  }

  return {
    found: false,
    ...lastEvaluation
  };
}

async function waitForTimelineMediaPost({
  instanceUrl,
  accessToken,
  marker,
  timeoutMs,
  log,
  expectedSensitive = null,
  expectedSpoilerText = null
}) {
  const startedAt = Date.now();
  let last = {
    found: false,
    hasMediaAttachment: false,
    statusId: null,
    sensitive: null,
    spoilerText: null
  };

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const statuses = await gtsApi({
        instanceUrl,
        accessToken,
        path: "/api/v1/timelines/home?limit=80",
        timeoutMs: 30_000
      });

      const list = Array.isArray(statuses) ? statuses : [];
      const status = list.find((entry) => statusContainsMarker(entry, marker)) ?? null;
      const hasMediaAttachment = Array.isArray(status?.media_attachments) && status.media_attachments.length > 0;
      const sensitive = typeof status?.sensitive === "boolean" ? status.sensitive : null;
      const spoilerText = typeof status?.spoiler_text === "string" ? status.spoiler_text : "";
      const sensitiveMatches = expectedSensitive === null || sensitive === expectedSensitive;
      const spoilerMatches = expectedSpoilerText === null || spoilerText === expectedSpoilerText;

      last = {
        found: status !== null,
        hasMediaAttachment,
        statusId: status?.id ?? null,
        sensitive,
        spoilerText
      };

      if (last.found && last.hasMediaAttachment && sensitiveMatches && spoilerMatches) {
        return last;
      }

      if (last.found && !last.hasMediaAttachment) {
        log("timeline media post found but media attachments missing yet; waiting...");
      } else if (last.found && (!sensitiveMatches || !spoilerMatches)) {
        log(`timeline media labels waiting; sensitive=${String(sensitive)} spoiler=${JSON.stringify(spoilerText)}`);
      }
    } catch (error) {
      log(`timeline media retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(3_000);
  }

  return last;
}

export function evaluateTimelineThread({ statuses, rootMarker, replyMarker }) {
  const list = Array.isArray(statuses) ? statuses : [];
  const rootStatus = list.find((status) => statusContainsMarker(status, rootMarker)) ?? null;
  const replyStatus = list.find((status) => statusContainsMarker(status, replyMarker)) ?? null;

  const linkedById = rootStatus?.id && replyStatus?.in_reply_to_id
    ? String(replyStatus.in_reply_to_id) === String(rootStatus.id)
    : false;
  const linkedByUri = rootStatus?.uri && replyStatus?.in_reply_to_uri
    ? String(replyStatus.in_reply_to_uri) === String(rootStatus.uri)
    : false;

  return {
    rootFound: rootStatus !== null,
    replyFound: replyStatus !== null,
    threadLinked: Boolean(linkedById || linkedByUri),
    rootStatusId: rootStatus?.id ?? null,
    replyStatusId: replyStatus?.id ?? null
  };
}

export function extractPostRkeyFromAtUri(uri) {
  const match = /^at:\/\/[^/]+\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri ?? "");
  if (!match) {
    throw new Error(`Invalid AT URI for post: ${uri}`);
  }

  return match[1];
}

function statusContainsMarker(status, marker) {
  const content = typeof status?.content === "string" ? status.content : "";
  const text = typeof status?.text === "string" ? status.text : "";
  return content.includes(marker) || text.includes(marker);
}

export function extractResolvedTargetFromHtml(html) {
  if (typeof html !== "string") {
    return null;
  }

  const match = /<code[^>]*id=["']resolved-target["'][^>]*>([^<]+)<\/code>/i.exec(html);
  if (!match) {
    return null;
  }

  return decodeHtmlEntities(match[1].trim());
}

async function waitForStatusSearchByUrl({ instanceUrl, accessToken, targetUrl, marker, timeoutMs, log }) {
  const startedAt = Date.now();
  let last = {
    found: false,
    statusId: null,
    url: null,
    uri: null
  };

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const body = await gtsApi({
        instanceUrl,
        accessToken,
        path: `/api/v2/search?q=${encodeURIComponent(targetUrl)}&resolve=true&limit=20&type=statuses&offset=0`,
        timeoutMs: 30_000
      });

      const statuses = Array.isArray(body?.statuses) ? body.statuses : [];
      const status = typeof marker === "string" && marker
        ? statuses.find((entry) => statusContainsMarker(entry, marker)) ?? null
        : statuses[0] ?? null;
      last = {
        found: status !== null,
        statusId: status?.id ?? null,
        url: status?.url ?? null,
        uri: status?.uri ?? null
      };

      if (last.found) {
        return last;
      }
    } catch (error) {
      log(`resolver post search retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(3_000);
  }

  return last;
}

async function waitForBridgeThreadReadSurface({
  localBaseUrl,
  publicBaseUrl,
  did,
  rootRkey,
  replyRkey,
  rootMarker,
  replyMarker,
  timeoutMs,
  log
}) {
  const startedAt = Date.now();
  let last = {
    outboxHasRoot: false,
    outboxHasReply: false,
    rootObjectFound: false,
    replyObjectFound: false,
    replyLinkedToRoot: false
  };

  const encodedDid = encodeURIComponent(did);
  const rootObjectId = `${publicBaseUrl}/ap/object/${encodedDid}/${encodeURIComponent(rootRkey)}`;
  const replyObjectId = `${publicBaseUrl}/ap/object/${encodedDid}/${encodeURIComponent(replyRkey)}`;
  const rootObjectUrl = `${localBaseUrl}/ap/object/${encodedDid}/${encodeURIComponent(rootRkey)}`;
  const replyObjectUrl = `${localBaseUrl}/ap/object/${encodedDid}/${encodeURIComponent(replyRkey)}`;
  const outboxUrl = `${localBaseUrl}/ap/actor/${encodedDid}/outbox?limit=40`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const outboxResponse = await fetch(outboxUrl);
      const outboxBody = outboxResponse.ok ? await outboxResponse.json() : null;
      const items = Array.isArray(outboxBody?.orderedItems) ? outboxBody.orderedItems : [];

      const outboxHasRoot = items.some((activity) => {
        const content = typeof activity?.object?.content === "string" ? activity.object.content : "";
        return content.includes(rootMarker);
      });

      const outboxHasReply = items.some((activity) => {
        const content = typeof activity?.object?.content === "string" ? activity.object.content : "";
        return content.includes(replyMarker);
      });

      const rootResponse = await fetch(rootObjectUrl);
      const rootObject = rootResponse.ok ? await rootResponse.json() : null;

      const replyResponse = await fetch(replyObjectUrl);
      const replyObject = replyResponse.ok ? await replyResponse.json() : null;

      const rootObjectFound = rootResponse.ok
        && typeof rootObject?.content === "string"
        && rootObject.content.includes(rootMarker);
      const replyObjectFound = replyResponse.ok
        && typeof replyObject?.content === "string"
        && replyObject.content.includes(replyMarker);
      const replyLinkedToRoot = replyObjectFound && replyObject?.inReplyTo === rootObjectId;

      last = {
        outboxHasRoot,
        outboxHasReply,
        rootObjectFound,
        replyObjectFound,
        replyLinkedToRoot
      };

      if (outboxHasRoot && outboxHasReply && rootObjectFound && replyObjectFound && replyLinkedToRoot) {
        return { ok: true, ...last };
      }

      log(`bridge-read progress outboxRoot=${outboxHasRoot} outboxReply=${outboxHasReply} rootObj=${rootObjectFound} replyObj=${replyObjectFound} linked=${replyLinkedToRoot}`);
    } catch (error) {
      log(`bridge-read retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  return { ok: false, ...last };
}

async function waitForBridgeMediaObject({
  localBaseUrl,
  did,
  rkey,
  marker,
  timeoutMs,
  log,
  expectedSensitive = null,
  expectedSummary = null
}) {
  const startedAt = Date.now();
  let last = {
    found: false,
    hasAttachment: false,
    mediaUrl: null,
    noteSensitive: null,
    attachmentSensitive: null,
    summary: null
  };

  const objectUrl = `${localBaseUrl}/ap/object/${encodeURIComponent(did)}/${encodeURIComponent(rkey)}`;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(objectUrl);
      const body = response.ok ? await response.json() : null;
      const attachments = Array.isArray(body?.attachment) ? body.attachment : [];
      const mediaAttachment = attachments.find((entry) => typeof entry?.url === "string") ?? null;
      const content = typeof body?.content === "string" ? body.content : "";
      const noteSensitive = typeof body?.sensitive === "boolean" ? body.sensitive : null;
      const attachmentSensitive = typeof mediaAttachment?.sensitive === "boolean" ? mediaAttachment.sensitive : null;
      const summary = typeof body?.summary === "string" ? body.summary : null;
      const noteSensitiveMatches = expectedSensitive === null || noteSensitive === expectedSensitive;
      const attachmentSensitiveMatches = expectedSensitive === null || attachmentSensitive === expectedSensitive;
      const summaryMatches = expectedSummary === null || summary === expectedSummary;

      last = {
        found: response.ok && content.includes(marker),
        hasAttachment: mediaAttachment !== null,
        mediaUrl: mediaAttachment?.url ?? null,
        noteSensitive,
        attachmentSensitive,
        summary
      };

      if (last.found && last.hasAttachment && noteSensitiveMatches && attachmentSensitiveMatches && summaryMatches) {
        return last;
      }
      if (last.found && last.hasAttachment) {
        log(`bridge media labels waiting; noteSensitive=${String(noteSensitive)} attachmentSensitive=${String(attachmentSensitive)} summary=${JSON.stringify(summary)}`);
      }
    } catch (error) {
      log(`bridge media retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  return last;
}

async function waitForBridgeRepostActivity({ localBaseUrl, publicBaseUrl, did, rootDid, rootRkey, timeoutMs, log }) {
  const startedAt = Date.now();
  let last = {
    found: false,
    activityId: null
  };

  const outboxUrl = `${localBaseUrl}/ap/actor/${encodeURIComponent(did)}/outbox?limit=80`;
  const expectedObject = `${publicBaseUrl}/ap/object/${encodeURIComponent(rootDid)}/${encodeURIComponent(rootRkey)}`;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(outboxUrl);
      const body = response.ok ? await response.json() : null;
      const items = Array.isArray(body?.orderedItems) ? body.orderedItems : [];
      const announce = items.find((activity) => activity?.type === "Announce" && activity?.object === expectedObject) ?? null;

      last = {
        found: announce !== null,
        activityId: announce?.id ?? null
      };

      if (last.found) {
        return last;
      }
    } catch (error) {
      log(`bridge repost retry error=${error instanceof Error ? error.message : String(error)}`);
    }

    await sleep(2_000);
  }

  return last;
}

async function gtsApi({ instanceUrl, accessToken, path, method = "GET", timeoutMs = 30_000, body = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const request = buildGtsRequest({ accessToken, method, body });

  try {
    const response = await fetch(`${stripTrailingSlash(instanceUrl)}${path}`, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      throw new Error(`GTS API ${path} failed: ${response.status} ${errorBody}`);
    }

    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function buildGtsRequest({ accessToken, method = "GET", body = null }) {
  const headers = {
    authorization: `Bearer ${accessToken}`
  };

  if (body !== null && body !== undefined) {
    headers["content-type"] = "application/json";
  }

  return {
    method,
    headers,
    body: body !== null && body !== undefined ? JSON.stringify(body) : null
  };
}

function stripTrailingSlash(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function decodeHtmlEntities(value) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#39;", "'");
}

async function waitForCondition(check, timeoutMs, intervalMs) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const result = await check();
      if (result) {
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(intervalMs);
  }

  if (lastError) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`Condition timeout after ${timeoutMs}ms (last error: ${reason})`);
  }

  throw new Error(`Condition timeout after ${timeoutMs}ms`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        if (!address || typeof address === "string") {
          reject(new Error("Unable to determine free port"));
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function readJsonSafe(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  if (!raw.trim()) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function pickFirstString(values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function extractLabeledValue(text, label) {
  if (!text) {
    return null;
  }

  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped}:\\s*(.+)$`, "im");
  const match = regex.exec(text);
  return match ? match[1].trim() : null;
}

function inferMediaMimeType(path) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image/jpeg";
  }

  if (lower.endsWith(".png")) {
    return "image/png";
  }

  if (lower.endsWith(".webp")) {
    return "image/webp";
  }

  if (lower.endsWith(".mp4")) {
    return "video/mp4";
  }

  return "application/octet-stream";
}

function areEquivalentMediaUrls(left, right) {
  if (typeof right !== "string" || !right) {
    return true;
  }

  if (typeof left !== "string" || !left) {
    return false;
  }

  try {
    const l = new URL(left);
    const r = new URL(right);
    return l.origin === r.origin && l.pathname === r.pathname;
  } catch {
    return left === right;
  }
}

async function waitForQueueDepthZero({ runtime, timeoutMs, log }) {
  if (!runtime || typeof runtime.getMetrics !== "function") {
    return;
  }

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const metrics = runtime.getMetrics();
    if ((metrics?.queueDepth ?? 0) === 0) {
      return;
    }

    log(`waiting for queue drain; depth=${metrics.queueDepth}`);
    await sleep(1000);
  }
}

async function retryFetch(fn, attempts, delayMs) {
  let lastError = null;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i < attempts - 1) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error("retryFetch failed");
}
