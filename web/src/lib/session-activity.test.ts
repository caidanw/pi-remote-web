import assert from "node:assert/strict";
import { it } from "node:test";
import { activityMs, newestActivityFirst } from "./session-activity.ts";

it("sorts sessions by latest activity without mutating the source", () => {
  const sessions = [
    { modified: "2026-08-20T12:00:00Z" },
    { created: "2026-08-20T14:00:00Z" },
    { modified: "2026-08-20T13:00:00Z" },
  ];

  const sorted = [...sessions].sort(newestActivityFirst);

  assert.deepEqual(sorted, [sessions[1], sessions[2], sessions[0]]);
  assert.equal(activityMs({ modified: "invalid", created: "2026-08-20T15:00:00Z" }), Date.parse("2026-08-20T15:00:00Z"));
  assert.deepEqual(sessions.map(activityMs), [
    Date.parse("2026-08-20T12:00:00Z"),
    Date.parse("2026-08-20T14:00:00Z"),
    Date.parse("2026-08-20T13:00:00Z"),
  ]);
});
