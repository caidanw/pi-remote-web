import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { acquireSessionLock, releaseSessionLock } from "./session-lock.js";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function lockFixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-lock-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return {
    baseDir: path.join(dir, "locks"),
    sessionPath: path.join(dir, "session.jsonl"),
  };
}

describe("session ownership lock", () => {
  it("rejects a second live owner", async () => {
    const fixture = await lockFixture();
    const first = await acquireSessionLock({
      ...fixture,
      ownerKind: "terminal",
      runtimeId: "first",
      pid: 101,
      isPidAlive: () => true,
    });
    assert.equal(first.ok, true);

    const second = await acquireSessionLock({
      ...fixture,
      ownerKind: "terminal",
      runtimeId: "second",
      pid: 202,
      isPidAlive: () => true,
    });
    assert.equal(second.ok, false);
    assert.equal(second.owner?.runtimeId, "first");
  });

  it("recovers a lock whose owner exited", async () => {
    const fixture = await lockFixture();
    const stale = await acquireSessionLock({
      ...fixture,
      ownerKind: "browser",
      runtimeId: "stale",
      pid: 101,
      isPidAlive: () => true,
    });
    assert.equal(stale.ok, true);

    const recovered = await acquireSessionLock({
      ...fixture,
      ownerKind: "terminal",
      runtimeId: "next",
      pid: 202,
      isPidAlive: () => false,
    });
    assert.equal(recovered.ok, true);
    assert.equal(recovered.lock.runtimeId, "next");
  });

  it("recovers a prior-boot lock even if its PID was reused", async () => {
    const fixture = await lockFixture();
    const stale = await acquireSessionLock({
      ...fixture,
      ownerKind: "terminal",
      runtimeId: "prior-boot",
      pid: 101,
      bootId: 1,
      isPidAlive: () => true,
    });
    assert.equal(stale.ok, true);

    const recovered = await acquireSessionLock({
      ...fixture,
      ownerKind: "terminal",
      runtimeId: "current-boot",
      pid: 202,
      bootId: 2,
      isPidAlive: () => true,
    });
    assert.equal(recovered.ok, true);
  });

  it("only the matching owner can release the lock", async () => {
    const fixture = await lockFixture();
    const acquired = await acquireSessionLock({
      ...fixture,
      ownerKind: "terminal",
      runtimeId: "owner",
    });
    assert.equal(acquired.ok, true);

    assert.equal(
      await releaseSessionLock({ ...acquired.lock, nonce: "not-the-owner" }),
      false,
    );
    assert.equal(await releaseSessionLock(acquired.lock), true);

    const next = await acquireSessionLock({
      ...fixture,
      ownerKind: "terminal",
      runtimeId: "next",
    });
    assert.equal(next.ok, true);
  });
});
