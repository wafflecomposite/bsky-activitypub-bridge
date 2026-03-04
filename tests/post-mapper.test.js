import test from "node:test";
import assert from "node:assert/strict";
import { mapBskyPostToActivityPub } from "../src/bridge/post-mapper.js";

const baseUrl = "https://bridge.example";
const did = "did:plc:alice";

test("mapBskyPostToActivityPub maps basic post to Note and Create", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post1",
    record: {
      text: "Hello world",
      createdAt: "2026-03-04T00:00:00.000Z"
    }
  });

  assert.equal(result.note.type, "Note");
  assert.equal(result.note.content, "Hello world");
  assert.equal(result.note.id, "https://bridge.example/ap/object/did%3Aplc%3Aalice/post1");
  assert.deepEqual(result.note.to, ["https://bridge.example/ap/actor/did%3Aplc%3Aalice/followers"]);
  assert.deepEqual(result.note.cc, ["https://www.w3.org/ns/activitystreams#Public"]);
  assert.equal(result.create.type, "Create");
  assert.equal(result.create.object.id, result.note.id);
});

test("mapBskyPostToActivityPub renders UTF-8 facet ranges into links", () => {
  const text = "Hi 💙 @bob";

  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post2",
    record: {
      text,
      createdAt: "2026-03-04T00:00:00.000Z",
      facets: [
        {
          index: {
            byteStart: 8,
            byteEnd: 12
          },
          features: [
            {
              $type: "app.bsky.richtext.facet#mention",
              did: "did:plc:bob"
            }
          ]
        }
      ]
    }
  });

  assert.equal(
    result.note.content,
    'Hi 💙 <a href="https://bridge.example/ap/actor/did%3Aplc%3Abob">@bob</a>'
  );
  assert.equal(result.note.tag[0].type, "Mention");
  assert.equal(result.note.tag[0].href, "https://bridge.example/ap/actor/did%3Aplc%3Abob");
});

test("mapBskyPostToActivityPub drops overlapping facets", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post3",
    record: {
      text: "https://example.com",
      createdAt: "2026-03-04T00:00:00.000Z",
      facets: [
        {
          index: {
            byteStart: 0,
            byteEnd: 19
          },
          features: [
            {
              $type: "app.bsky.richtext.facet#link",
              uri: "https://example.com"
            }
          ]
        },
        {
          index: {
            byteStart: 1,
            byteEnd: 5
          },
          features: [
            {
              $type: "app.bsky.richtext.facet#tag",
              tag: "ignored"
            }
          ]
        }
      ]
    }
  });

  assert.equal(
    result.note.content,
    '<a href="https://example.com">https://example.com</a>'
  );
  assert.equal(result.note.tag.length, 0);
});

test("mapBskyPostToActivityPub maps reply and labels", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post4",
    record: {
      text: "reply",
      createdAt: "2026-03-04T00:00:00.000Z",
      labels: [{ val: "nsfw" }],
      reply: {
        parent: {
          uri: "at://did:plc:bob/app.bsky.feed.post/xyz"
        }
      }
    }
  });

  assert.equal(result.note.inReplyTo, "https://bsky.app/profile/did:plc:bob/post/xyz");
  assert.equal(result.note.sensitive, true);
  assert.equal(result.note.summary, "Content warning: nsfw");
});

test("mapBskyPostToActivityPub maps self-thread replies to bridged object ids", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post6",
    record: {
      text: "thread reply",
      createdAt: "2026-03-04T00:00:00.000Z",
      reply: {
        parent: {
          uri: "at://did:plc:alice/app.bsky.feed.post/post5"
        },
        root: {
          uri: "at://did:plc:alice/app.bsky.feed.post/post1"
        }
      }
    }
  });

  assert.equal(result.note.inReplyTo, "https://bridge.example/ap/object/did%3Aplc%3Aalice/post5");
  assert.equal(result.note.context, "https://bridge.example/ap/object/did%3Aplc%3Aalice/post1");
});

test("mapBskyPostToActivityPub can map non-self replies to bridged object ids when resolver provides one", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post7",
    resolveReplyObjectId: (replyDid, replyRkey) => {
      if (replyDid === "did:plc:bob" && replyRkey === "root9") {
        return "https://bridge.example/ap/object/did%3Aplc%3Abob/root9";
      }

      return null;
    },
    record: {
      text: "reply to bob",
      createdAt: "2026-03-04T00:00:00.000Z",
      reply: {
        parent: {
          uri: "at://did:plc:bob/app.bsky.feed.post/root9"
        }
      }
    }
  });

  assert.equal(result.note.inReplyTo, "https://bridge.example/ap/object/did%3Aplc%3Abob/root9");
});

test("mapBskyPostToActivityPub supports explicit public visibility", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post5",
    visibility: "public",
    record: {
      text: "public",
      createdAt: "2026-03-04T00:00:00.000Z"
    }
  });

  assert.deepEqual(result.note.to, ["https://www.w3.org/ns/activitystreams#Public"]);
  assert.deepEqual(result.note.cc, ["https://bridge.example/ap/actor/did%3Aplc%3Aalice/followers"]);
});

test("mapBskyPostToActivityPub maps image blob embeds to attachments", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post8",
    record: {
      text: "image post",
      createdAt: "2026-03-04T00:00:00.000Z",
      embed: {
        $type: "app.bsky.embed.images",
        images: [
          {
            alt: "bridge image",
            image: {
              $type: "blob",
              ref: {
                $link: "bafkreihabcdef"
              },
              mimeType: "image/jpeg"
            }
          }
        ]
      }
    }
  });

  assert.equal(Array.isArray(result.note.attachment), true);
  assert.equal(result.note.attachment.length, 1);
  assert.deepEqual(result.note.attachment[0], {
    type: "Image",
    url: "https://bsky.social/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aalice&cid=bafkreihabcdef",
    mediaType: "image/jpeg",
    name: "bridge image"
  });
});

test("mapBskyPostToActivityPub maps recordWithMedia embeds", () => {
  const result = mapBskyPostToActivityPub({
    baseUrl,
    did,
    rkey: "post9",
    record: {
      text: "quote + media",
      createdAt: "2026-03-04T00:00:00.000Z",
      embed: {
        $type: "app.bsky.embed.recordWithMedia",
        record: {
          $type: "app.bsky.embed.record",
          record: {
            uri: "at://did:plc:bob/app.bsky.feed.post/root7"
          }
        },
        media: {
          $type: "app.bsky.embed.video",
          alt: "bridge video",
          video: {
            $type: "blob",
            ref: {
              $link: "bafkreivideo123"
            },
            mimeType: "video/mp4"
          }
        }
      }
    }
  });

  assert.equal(result.note.attachment.length, 2);
  assert.deepEqual(result.note.attachment[0], {
    type: "Link",
    url: "https://bridge.example/ap/object/did%3Aplc%3Abob/root7"
  });
  assert.deepEqual(result.note.attachment[1], {
    type: "Document",
    url: "https://bsky.social/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Aalice&cid=bafkreivideo123",
    mediaType: "video/mp4",
    name: "bridge video"
  });
});
