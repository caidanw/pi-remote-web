import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hub } from "./hub.js";

const realListAll = SessionManager.listAll;
const realNow = Date.now;
afterEach(() => {
  SessionManager.listAll = realListAll;
  Date.now = realNow;
});

describe("hub.listDisk cache", () => {
  it("serves the last scan, throttles rescans, and refreshes behind it", async () => {
    let now = 1_000_000;
    Date.now = () => now;
    let scans = 0;
    let rows = [{ id: "a", path: "/s/a.jsonl" }];
    SessionManager.listAll = async () => {
      scans += 1;
      return rows;
    };
    assert.deepEqual(await hub.listDisk(), rows); // cold: waits
    rows = [...rows, { id: "b", path: "/s/b.jsonl" }];
    assert.equal((await hub.listDisk()).length, 1); // within 10s: cached, no rescan
    assert.equal(scans, 1);
    now += 11_000;
    assert.equal((await hub.listDisk()).length, 1); // stale: served, rescan kicked off
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(scans, 2);
    assert.equal((await hub.listDisk()).length, 2); // background rescan landed
    rows = [...rows, { id: "c", path: "/s/c.jsonl" }];
    assert.equal((await hub.listDisk(undefined, { fresh: true })).length, 3); // fresh skips the throttle
  });
});
