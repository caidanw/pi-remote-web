import assert from "node:assert/strict";
import { readFile, rm, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawn as spawnChild } from "node:child_process";
import { afterEach, describe, it } from "node:test";
import { acquireSessionLock, releaseSessionLock } from "../remote/session-lock.js";
import { RpcWorkerManager } from "./rpc-workers.js";
import { createServer } from "./http.js";

const fixtureRpc = fileURLToPath(new URL("./fixtures/fake-pi-rpc.js", import.meta.url));
const parentHarness = fileURLToPath(new URL("./fixtures/rpc-worker-parent.js", import.meta.url));
const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-rpc-worker-"));
  const manager = new RpcWorkerManager({
    rpcEntry: fixtureRpc,
    lockDir: path.join(root, "locks"),
    sessionDir: () => path.join(root, "sessions"),
    ...options,
  });
  cleanups.push(async () => {
    await manager.closeAll();
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager };
}

async function savedSession(root, id = `session-${Date.now()}`) {
  const sessionPath = path.join(root, `${id}.jsonl`);
  await mkdir(path.dirname(sessionPath), { recursive: true });
  await writeFile(
    sessionPath,
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: root })}\n`,
  );
  return sessionPath;
}

async function waitFor(check, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition was not met before timeout");
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

  it("serializes concurrent commands per worker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-rpc-serial-"));
    const auditFile = path.join(root, "audit.txt");
    const manager = new RpcWorkerManager({
      rpcEntry: fixtureRpc,
      lockDir: path.join(root, "locks"),
      sessionDir: () => path.join(root, "sessions"),
      env: { PI_TEST_AUDIT_FILE: auditFile },
    });
    cleanups.push(async () => {
      await manager.closeAll();
      await rm(root, { recursive: true, force: true });
    });
    const row = await manager.open({ cwd: root, fresh: true });
    const first = manager.prompt(row.id, "slow first");
    const second = manager.prompt(row.id, "second");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await readFile(auditFile, "utf8"), "slow first\n");
    await Promise.all([first, second]);
    assert.equal(await readFile(auditFile, "utf8"), "slow first\nsecond\n");
  });

  it("treats malformed and oversized stdout as protocol-fatal", async () => {
    for (const mode of ["malformed", "oversize", "missing-lf"]) {
      const root = await mkdtemp(path.join(os.tmpdir(), `pi-remote-rpc-${mode}-`));
      const manager = new RpcWorkerManager({
        rpcEntry: fixtureRpc,
        lockDir: path.join(root, "locks"),
        env: {
          PI_TEST_BAD_OUTPUT: mode,
          PI_TEST_OVERSIZE_BYTES: "2048",
        },
        maxFrameBytes: 1024,
        // Fixture files are written moments earlier; the live-writer heuristic is tested separately.
        guardOptions: { recentWriteMs: 0 },
      });
      cleanups.push(async () => {
        await manager.closeAll();
        await rm(root, { recursive: true, force: true });
      });
      const sessionPath = await savedSession(root, `bad-${mode}`);
      await assert.rejects(
        manager.open({ cwd: root, path: sessionPath }),
        /Invalid Pi RPC frame|exceeds size limit|without LF/,
      );
      const terminal = await acquireSessionLock({
        baseDir: path.join(root, "locks"),
        sessionPath,
        ownerKind: "terminal",
        runtimeId: `after-${mode}`,
      });
      assert.equal(terminal.ok, true);
      if (terminal.ok) await releaseSessionLock(terminal.lock);
    }
  });

  it("decodes fragmented UTF-8 RPC frames", async () => {
    const { root, manager } = await fixture({ env: { PI_TEST_FRAGMENT_UTF8: "1" } });
    const row = await manager.open({ cwd: root, fresh: true });
    assert.equal(row.name, "Fixture 🐴");
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

    await assert.rejects(manager.takeover(row.path), (error) => {
      assert.equal(error.code, "SESSION_BUSY");
      return true;
    });
    await manager.abort(row.id);
    const releasing = manager.takeover(row.path);
    assert.throws(
      () => manager.prompt(row.id, "race release"),
      /releasing|not running/,
    );
    const released = await releasing;
    assert.equal(released.ok, true);
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

  it("waits for slow graceful disposal before releasing the JSONL", async () => {
    const { root, manager } = await fixture({
      env: { PI_TEST_SLOW_DISPOSE_MS: "150", PI_TEST_DISPOSE_MARKER: "1" },
      shutdownTimeoutMs: 1000,
    });
    const row = await manager.open({ cwd: root, fresh: true });
    const child = manager.require(row.id).child;
    const started = Date.now();
    await manager.release(row.id);
    assert.ok(Date.now() - started >= 130);
    assert.equal(child.exitCode, 0);
    const entries = (await readFile(row.path, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(entries.at(-1).name, "disposed");
  });

  it("routes create and release through the existing HTTP session contract", async () => {
    const { root, manager } = await fixture();
    const app = createServer({ port: 0, workers: manager, auth: false });
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
    const busyDelete = await fetch(`${base}/api/sessions/${opened.id}`, {
      method: "DELETE",
    });
    assert.equal(busyDelete.status, 409);
    assert.equal((await busyDelete.json()).code, "SESSION_BUSY");
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

    const deleteOpened = await fetch(`${base}/api/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: root, fresh: true }),
    }).then((response) => response.json());
    const deleted = await fetch(`${base}/api/sessions/${deleteOpened.id}`, {
      method: "DELETE",
    });
    assert.equal(deleted.status, 200);
    const terminal = await acquireSessionLock({
      baseDir: path.join(root, "locks"),
      sessionPath: deleteOpened.path,
      ownerKind: "terminal",
      runtimeId: "after-delete",
    });
    assert.equal(terminal.ok, true);
    if (terminal.ok) await releaseSessionLock(terminal.lock);
  });

  it("runs the real Pi RPC entry through idle release and resume", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-real-rpc-"));
    const manager = new RpcWorkerManager({
      lockDir: path.join(root, "locks"),
      sessionDir: () => path.join(root, "sessions"),
      env: {
        PI_CODING_AGENT_DIR: path.join(root, "agent"),
        PI_OFFLINE: "1",
      },
    });
    cleanups.push(async () => {
      await manager.closeAll();
      await rm(root, { recursive: true, force: true });
    });
    const row = await manager.open({ cwd: root, fresh: true });
    assert.equal(row.browserOwned, true);
    await manager.release(row.id);
    const reopened = await manager.open({ cwd: root, path: row.path });
    assert.equal(reopened.id, row.id);
    await manager.release(reopened.id);
    const lines = (await readFile(row.path, "utf8")).trim().split("\n");
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
  });

  it("lets an orphan worker exit on parent crash and preserves recoverable ownership", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-parent-crash-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const parent = spawnChild(process.execPath, [parentHarness], {
      env: {
        ...process.env,
        PI_TEST_ROOT: root,
        PI_TEST_RPC_ENTRY: fixtureRpc,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    parent.stdout.setEncoding("utf8");
    const [chunk] = await once(parent.stdout, "data");
    const info = JSON.parse(String(chunk).trim().split("\n")[0]);
    parent.kill("SIGKILL");
    await once(parent, "exit");
    await waitFor(() => {
      try {
        process.kill(info.workerPid, 0);
        return false;
      } catch {
        return true;
      }
    });
    const terminal = await acquireSessionLock({
      baseDir: path.join(root, "locks"),
      sessionPath: info.path,
      ownerKind: "terminal",
      runtimeId: "after-parent-crash",
    });
    assert.equal(terminal.ok, true);
    if (terminal.ok) await releaseSessionLock(terminal.lock);
    const entries = (await readFile(info.path, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(entries.at(-1).name, "disposed");
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

    // Fresh manager = daemon restart; the live-writer heuristic must not block a resume.
    const resumed = new RpcWorkerManager({
      rpcEntry: fixtureRpc,
      lockDir: path.join(root, "locks"),
      guardOptions: { recentWriteMs: 0 },
    });
    cleanups.push(() => resumed.closeAll());
    const reopened = await resumed.open({ cwd: root, path: row.path });
    assert.equal(reopened.id, row.id);
    assert.equal(reopened.path, row.path);
  });
});
