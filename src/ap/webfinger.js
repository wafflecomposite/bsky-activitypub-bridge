import { actorId, parseAcctResource, webfingerSubject } from "../domain/identifiers.js";

export function resolveWebFingerResource({ resource, bridgeHost, baseUrl, store }) {
  const { handle } = parseAcctResource(resource, bridgeHost);
  const did = store.resolveDidByHandle(handle);

  if (!did) {
    return null;
  }

  const href = actorId(baseUrl, did);

  return {
    subject: webfingerSubject(handle, bridgeHost),
    aliases: [`${baseUrl}/@${handle}`],
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href
      }
    ]
  };
}
