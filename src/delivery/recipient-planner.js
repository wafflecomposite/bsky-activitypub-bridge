export function planDeliveryTargets(followers) {
  const grouped = new Map();
  const skipped = [];

  for (const follower of followers) {
    const destination = follower.sharedInboxUrl ?? follower.inboxUrl ?? null;

    if (!destination) {
      skipped.push({
        actorId: follower.actorId,
        reason: "missing-inbox"
      });
      continue;
    }

    let group = grouped.get(destination);
    if (!group) {
      group = {
        destination,
        recipients: []
      };
      grouped.set(destination, group);
    }

    group.recipients.push(follower.actorId);
  }

  return {
    deliveries: Array.from(grouped.values()),
    skipped
  };
}
