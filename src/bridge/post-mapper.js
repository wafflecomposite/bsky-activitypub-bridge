import {
  actorFollowersId,
  actorId,
  objectId
} from "../domain/identifiers.js";

const PUBLIC_AUDIENCE = "https://www.w3.org/ns/activitystreams#Public";
const DEFAULT_VISIBILITY = "unlisted";

export function mapBskyPostToActivityPub({ baseUrl, did, rkey, record, visibility = DEFAULT_VISIBILITY }) {
  validateRecord(record);

  const attributedTo = actorId(baseUrl, did);
  const noteId = objectId(baseUrl, did, rkey);
  const audience = buildAudience({ baseUrl, did, visibility });

  const rendered = renderContentWithFacets({
    text: record.text,
    facets: record.facets,
    baseUrl
  });

  const note = {
    id: noteId,
    type: "Note",
    attributedTo,
    content: rendered.content,
    published: record.createdAt,
    to: audience.to,
    cc: audience.cc,
    tag: rendered.tags
  };

  const replyUri = record.reply?.parent?.uri;
  if (typeof replyUri === "string") {
    const inReplyTo = mapReplyUriToActivityPubReference({
      uri: replyUri,
      baseUrl,
      currentDid: did
    });

    if (inReplyTo) {
      note.inReplyTo = inReplyTo;
    }
  }

  const rootUri = record.reply?.root?.uri;
  if (typeof rootUri === "string") {
    const rootContext = mapReplyUriToActivityPubReference({
      uri: rootUri,
      baseUrl,
      currentDid: did
    });

    if (rootContext) {
      note.context = rootContext;
    }
  }

  const labelValues = extractLabelValues(record.labels);
  if (labelValues.length > 0) {
    note.sensitive = true;
    note.summary = `Content warning: ${labelValues.join(", ")}`;
  }

  const create = {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${noteId}/activity/create`,
    type: "Create",
    actor: attributedTo,
    published: record.createdAt,
    to: audience.to,
    cc: audience.cc,
    object: note
  };

  return { note, create };
}

export function buildAudience({ baseUrl, did, visibility = DEFAULT_VISIBILITY }) {
  const followers = actorFollowersId(baseUrl, did);

  if (visibility === "public") {
    return {
      to: [PUBLIC_AUDIENCE],
      cc: [followers]
    };
  }

  if (visibility === "followers") {
    return {
      to: [followers],
      cc: []
    };
  }

  if (visibility === "unlisted") {
    return {
      to: [followers],
      cc: [PUBLIC_AUDIENCE]
    };
  }

  throw new Error(`Unsupported visibility: ${visibility}`);
}

function renderContentWithFacets({ text, facets = [], baseUrl }) {
  const boundaryMap = createUtf8BoundaryMap(text);
  const totalBytes = utf8ByteLength(text);

  const normalizedFacets = (Array.isArray(facets) ? facets : [])
    .map((facet) => normalizeFacet(facet, totalBytes))
    .filter(Boolean)
    .sort((a, b) => a.byteStart - b.byteStart || a.byteEnd - b.byteEnd);

  let cursorByte = 0;
  let content = "";
  const tags = [];

  for (const facet of normalizedFacets) {
    if (facet.byteStart < cursorByte) {
      continue;
    }

    content += escapeHtml(sliceByBytes(text, boundaryMap, cursorByte, facet.byteStart));

    const rawText = sliceByBytes(text, boundaryMap, facet.byteStart, facet.byteEnd);
    const renderedFacet = renderFacet(rawText, facet, baseUrl);
    content += renderedFacet.html;

    if (renderedFacet.tag) {
      tags.push(renderedFacet.tag);
    }

    cursorByte = facet.byteEnd;
  }

  content += escapeHtml(sliceByBytes(text, boundaryMap, cursorByte, totalBytes));

  return { content, tags };
}

function renderFacet(rawText, facet, baseUrl) {
  const escapedText = escapeHtml(rawText);

  if (facet.kind === "link") {
    return {
      html: `<a href="${escapeAttribute(facet.uri)}">${escapedText}</a>`
    };
  }

  if (facet.kind === "mention") {
    const href = actorId(baseUrl, facet.did);
    return {
      html: `<a href="${escapeAttribute(href)}">${escapedText}</a>`,
      tag: {
        type: "Mention",
        href,
        name: rawText
      }
    };
  }

  if (facet.kind === "tag") {
    const normalizedTag = facet.tag.replace(/^#/, "");
    return {
      html: `<a href="${escapeAttribute(`${baseUrl}/tags/${encodeURIComponent(normalizedTag)}`)}">${escapedText}</a>`,
      tag: {
        type: "Hashtag",
        href: `${baseUrl}/tags/${encodeURIComponent(normalizedTag)}`,
        name: rawText.startsWith("#") ? rawText : `#${normalizedTag}`
      }
    };
  }

  return { html: escapedText };
}

function normalizeFacet(facet, totalBytes) {
  const index = facet?.index;
  if (!index || typeof index.byteStart !== "number" || typeof index.byteEnd !== "number") {
    return null;
  }

  if (index.byteStart < 0 || index.byteEnd <= index.byteStart || index.byteEnd > totalBytes) {
    return null;
  }

  const features = Array.isArray(facet.features) ? facet.features : [];
  for (const feature of features) {
    if (feature?.$type === "app.bsky.richtext.facet#link" && typeof feature.uri === "string") {
      return {
        kind: "link",
        byteStart: index.byteStart,
        byteEnd: index.byteEnd,
        uri: feature.uri
      };
    }

    if (feature?.$type === "app.bsky.richtext.facet#mention" && typeof feature.did === "string") {
      return {
        kind: "mention",
        byteStart: index.byteStart,
        byteEnd: index.byteEnd,
        did: feature.did
      };
    }

    if (feature?.$type === "app.bsky.richtext.facet#tag" && typeof feature.tag === "string") {
      return {
        kind: "tag",
        byteStart: index.byteStart,
        byteEnd: index.byteEnd,
        tag: feature.tag
      };
    }
  }

  return null;
}

function createUtf8BoundaryMap(text) {
  const map = new Map();
  map.set(0, 0);

  let codeUnitIndex = 0;
  let byteCount = 0;

  for (const char of text) {
    codeUnitIndex += char.length;
    byteCount += utf8ByteLength(char);
    map.set(byteCount, codeUnitIndex);
  }

  return map;
}

function sliceByBytes(text, boundaryMap, byteStart, byteEnd) {
  const startIndex = boundaryMap.get(byteStart);
  const endIndex = boundaryMap.get(byteEnd);

  if (startIndex === undefined || endIndex === undefined) {
    throw new Error(`Facet byte range does not align with UTF-8 boundaries: ${byteStart}-${byteEnd}`);
  }

  return text.slice(startIndex, endIndex);
}

function atUriToBskyWebUrl(uri) {
  const parsed = parseAtPostUri(uri);
  if (!parsed) {
    return null;
  }

  return `https://bsky.app/profile/${parsed.did}/post/${parsed.rkey}`;
}

function mapReplyUriToActivityPubReference({ uri, baseUrl, currentDid }) {
  const parsed = parseAtPostUri(uri);
  if (parsed && parsed.did === currentDid) {
    return objectId(baseUrl, parsed.did, parsed.rkey);
  }

  const fallback = atUriToBskyWebUrl(uri);
  if (fallback) {
    return fallback;
  }

  return uri;
}

function parseAtPostUri(uri) {
  if (typeof uri !== "string") {
    return null;
  }

  const match = /^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)$/.exec(uri);
  if (!match) {
    return null;
  }

  return {
    did: match[1],
    rkey: match[2]
  };
}

function extractLabelValues(labels) {
  if (!Array.isArray(labels)) {
    return [];
  }

  return labels
    .map((label) => label?.val)
    .filter((value) => typeof value === "string" && value.length > 0);
}

function validateRecord(record) {
  if (!record || typeof record !== "object") {
    throw new Error("Post record must be an object");
  }

  if (typeof record.text !== "string") {
    throw new Error("Post record text must be a string");
  }

  if (typeof record.createdAt !== "string") {
    throw new Error("Post record createdAt must be a string");
  }
}

function utf8ByteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
