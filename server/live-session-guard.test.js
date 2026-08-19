import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assertNoUnregisteredWriter, detectUnregisteredWriter } from "./live-session-guard.js";

const now = () => 1_000_000;
const fakeStat = (mtimeMs) => async () => ({ mtimeMs });

describe("unregistered live-session detection", () => {
  it("suspects a session written moments ago", async () => {
    const suspect = await detectUnregisteredWriter("/s.jsonl", {
      now,
      stat: fakeStat(now() - 5_000),
    });
    assert.deepEqual(suspect, { modifiedAgoMs: 5_000 });
  });

  it("ignores idle sessions, missing files, and clock skew", async () => {
    assert.equal(
      await detectUnregisteredWriter("/s.jsonl", { now, stat: fakeStat(now() - 10 * 60_000) }),
      null,
    );
    assert.equal(
      await detectUnregisteredWriter("/s.jsonl", {
        now,
        stat: async () => {
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      }),
      null,
    );
    assert.deepEqual(
      await detectUnregisteredWriter("/s.jsonl", { now, stat: fakeStat(now() + 30_000) }),
      { modifiedAgoMs: 0 },
      "a timestamp ahead of the clock must not silently disable the guard",
    );
  });

  it("can be disabled outright", async () => {
    assert.equal(
      await detectUnregisteredWriter("/s.jsonl", {
        now,
        recentWriteMs: 0,
        stat: fakeStat(now()),
      }),
      null,
    );
  });

  it("blocks an open with an actionable code unless forced", async () => {
    const options = { now, stat: fakeStat(now() - 3_000) };
    await assert.rejects(
      () => assertNoUnregisteredWriter("/s.jsonl", options),
      (error) => {
        assert.equal(error.code, "SESSION_MAYBE_LIVE");
        assert.equal(error.status, 409);
        assert.match(error.message, /pi install/);
        return true;
      },
    );
    await assertNoUnregisteredWriter("/s.jsonl", { ...options, force: true });
  });
});
