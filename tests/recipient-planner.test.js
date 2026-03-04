import test from "node:test";
import assert from "node:assert/strict";
import { planDeliveryTargets } from "../src/delivery/recipient-planner.js";

test("planDeliveryTargets groups recipients by sharedInbox and inbox fallback", () => {
  const result = planDeliveryTargets([
    {
      actorId: "https://remote-a.example/users/a1",
      inboxUrl: "https://remote-a.example/users/a1/inbox",
      sharedInboxUrl: "https://remote-a.example/inbox"
    },
    {
      actorId: "https://remote-a.example/users/a2",
      inboxUrl: "https://remote-a.example/users/a2/inbox",
      sharedInboxUrl: "https://remote-a.example/inbox"
    },
    {
      actorId: "https://remote-b.example/users/b1",
      inboxUrl: "https://remote-b.example/users/b1/inbox"
    }
  ]);

  assert.equal(result.deliveries.length, 2);

  const shared = result.deliveries.find((entry) => entry.destination === "https://remote-a.example/inbox");
  assert.deepEqual(shared.recipients, [
    "https://remote-a.example/users/a1",
    "https://remote-a.example/users/a2"
  ]);

  const single = result.deliveries.find((entry) => entry.destination === "https://remote-b.example/users/b1/inbox");
  assert.deepEqual(single.recipients, ["https://remote-b.example/users/b1"]);
  assert.equal(result.skipped.length, 0);
});

test("planDeliveryTargets skips followers without inbox information", () => {
  const result = planDeliveryTargets([
    {
      actorId: "https://remote.example/users/no-inbox"
    }
  ]);

  assert.equal(result.deliveries.length, 0);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0].reason, "missing-inbox");
});
