import assert from "node:assert/strict";
import { readFile, rm, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import { acquireSessionLock, releaseSessionLock } from "../remote/session-lock.js";
import { RpcWorkerManager } from "./rpc-workers.js";
import { createServer } from "./http.js";

const fixtureRpc = fileURLToPath(new URL("./fixtures/fake-pi-rpc.js", import.meta.url));
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-rpc-worker-"));
  const manager = new RpcWorkerManager({
    rpcEntry: fixtureRpc,
    lockDir: path.join(root, "locks"),
    sessionDir: () => path.join(root, "sessions"),
  });
  cleanups.push(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager };
}

describe("browser-owned Pi RPC workers", () => {
  it("creates isolated persistent workers and locks each JSONL", async () => {
    const { root, manager } = await fixture();
    const one = await manager.open({ cwd: root, fresh: true });
    const two = await manager.open({ cwd: root, fresh: true });

    assert.notEqual(one.id, two.id);
    assert.notEqual(one.path, two.path);
    assert.notEqual(manager.require(one.id).child.pid, manager.require(two.id).child.pid);
    assert.equal(JSON.parse((await readFile(one.path, "utf8")).split("\n")[0]).id, one.id);

    const terminal = await acquireSessionLock({
      baseDir: path.join(root, "locks"),
      sessionPath: one.path,
      ownerKind: "terminal",
      runtimeId: "terminal",
    });
    assert.equal(terminal.ok, false);
    assert.equal(terminal.owner?.ownerKind, "browser");
    assert.equal(terminal.owner?.pid, manager.require(one.id).child.pid);
  });

  it("does not spawn over a terminal-owned JSONL", async () => {
    const { root, manager } = await fixture();
    const sessionPath = path.join(root, "owned.jsonl");
    const terminal = await acquireSessionLock({
      baseDir: path.join(root, "locks"),
      sessionPath,
      ownerKind: "terminal",
      runtimeId: "terminal-live",
    });
    assert.equal(terminal.ok, true);

    await assert.rejects(
      manager.open({ cwd: root, path: sessionPath }),
      /already owned by terminal-live/,
    );
    assert.equal(manager.listSessions().length, 0);
    await releaseSessionLock(terminal.lock);
  });

  it("releases only an idle worker and transfers the ownership lock", async () => {
    const { root, manager } = await fixture();
    const row = await manager.open({ cwd: root, fresh: true });
    await manager.prompt(row.id, "stay busy");

    await assert.rejects(manager.release(row.id), (error) => {
      assert.equal(error.code, "SESSION_BUSY");
      return true;
    });
    assert.equal(manager.hasSession(row.id), true);
    const takeover = await acquireSessionLock({
      baseDir: path.join(root, "locks"),
      sessionPath: row.path,
      ownerKind: "terminal",
      runtimeId: "terminal-too-early",
    });
    assert.equal(takeover.ok, false);

    await manager.abort(row.id);
    const releasing = manager.release(row.id);
    await assert.rejects(manager.prompt(row.id, "race release"), /releasing|not running/);
    const released = await releasing;
    assert.equal(released.path, row.path);
    assert.equal(manager.hasSession(row.id), false);

    const terminal = await acquireSessionLock({
      baseDir: path.join(root, "locks"),
      sessionPath: row.path,
      ownerKind: "terminal",
      runtimeId: "terminal-next",
    });
    assert.equal(terminal.ok, true);
    await releaseSessionLock(terminal.lock);
  });

  it("restarts a crashed worker only after its ownership lock is released", async () => {
    const { root, manager } = await fixture();
    const row = await manager.open({ cwd: root, fresh: true });
    const child = manager.require(row.id).child;
    child.kill("SIGKILL");
    await once(child, "exit");

    const resumed = await manager.open({ cwd: root, path: row.path });
    assert.equal(resumed.id, row.id);
    assert.equal(resumed.running, true);
  });

  it("routes create and release through the existing HTTP session contract", async () => {
    const { root, manager } = await fixture();
    const app = createServer({ port: 0, workers: manager });
    await new Promise((resolve) => app.listen(resolve));
    cleanups.push(() => app.close());
    const address = app.server.address();
    const base = `http://127.0.0.1:${address.port}`;

    const openedResponse = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: root, fresh: true }),
    });
    const opened = await openedResponse.json();
    assert.equal(openedResponse.status, 200);
    assert.equal(opened.browserOwned, true);

    await fetch(`${base}/api/sessions/${opened.id}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "stay busy" }),
    });
    const busyRelease = await fetch(`${base}/api/sessions/${opened.id}/release`, {
      method: "POST",
    });
    assert.equal(busyRelease.status, 409);
    assert.equal((await busyRelease.json()).code, "SESSION_BUSY");

    await fetch(`${base}/api/sessions/${opened.id}/abort`, { method: "POST" });
    const released = await fetch(`${base}/api/sessions/${opened.id}/release`, {
      method: "POST",
    });
    assert.equal(released.status, 200);
    assert.equal((await released.json()).ok, true);
  });

  it("closes worker pipes cleanly and leaves a resumable valid JSONL", async () => {
    const { root, manager } = await fixture();
    const row = await manager.open({ cwd: root, fresh: true });
    const child = manager.require(row.id).child;
    await manager.prompt(row.id, "persist me");
    await manager.closeAll();
    assert.notEqual(child.exitCode, null);

    const lines = (await readFile(row.path, "utf8")).trim().split("\n");
    assert.ok(lines.length >= 2);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));

    const resumed = new RpcWorkerManager({
      rpcEntry: fixtureRpc,
      lockDir: path.join(root, "locks"),
    });
    cleanups.push(() => resumed.closeAll());
    const reopened = await resumed.open({ cwd: root, path: row.path });
    assert.equal(reopened.id, row.id);
    assert.equal(reopened.path, row.path);
  });
});
