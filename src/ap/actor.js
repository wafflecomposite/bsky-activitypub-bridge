import {
  actorFollowersId,
  actorId,
  actorInboxId,
  actorOutboxId
} from "../domain/identifiers.js";

const ACTIVITYSTREAMS_CONTEXT = "https://www.w3.org/ns/activitystreams";
const SECURITY_CONTEXT = "https://w3id.org/security/v1";

export function buildActorDocument({ baseUrl, profile, publicKeyPem }) {
  const id = actorId(baseUrl, profile.did);

  return {
    "@context": [ACTIVITYSTREAMS_CONTEXT, SECURITY_CONTEXT],
    id,
    type: "Person",
    preferredUsername: profile.handle,
    name: profile.displayName ?? profile.handle,
    summary: profile.summary ?? "",
    inbox: actorInboxId(baseUrl, profile.did),
    outbox: actorOutboxId(baseUrl, profile.did),
    followers: actorFollowersId(baseUrl, profile.did),
    icon: profile.avatarUrl
      ? {
          type: "Image",
          url: profile.avatarUrl
        }
      : undefined,
    image: profile.bannerUrl
      ? {
          type: "Image",
          url: profile.bannerUrl
        }
      : undefined,
    publicKey: {
      id: `${id}#main-key`,
      owner: id,
      publicKeyPem
    }
  };
}
