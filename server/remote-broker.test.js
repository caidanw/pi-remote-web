import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { RemoteClient } from "../remote/client.js";
import { RemoteBroker } from "./remote-broker.js";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

function makeClient(socketPath, runtimeId, onCommand) {
  return new RemoteClient({
    socketPath,
    runtimeId,
    maxBackoffMs: 20,
    random: () => 0.5,
    onCommand,
    getRegistration: () => ({
      session: { id: `session-${runtimeId}`, cwd: `/tmp/${runtimeId}` },
    }),
    getSnapshot: () => ({ messages: [{ role: "user", content: runtimeId }] }),
  });
}

describe("remote broker", () => {
  it("discovers clients that started before the daemon", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    const first = makeClient(socketPath, "first");
    const second = makeClient(socketPath, "second");
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => first.stop());
    cleanup.push(async () => second.stop());

    first.start();
    second.start();
    await broker.listen();

    const sessions = await waitFor(() => {
      const rows = broker.listSessions();
      return rows.length === 2 && rows.every((row) => row.snapshot) ? rows : null;
    });
    assert.deepEqual(
      sessions.map((row) => row.runtimeId).sort(),
      ["first", "second"],
    );
    assert.ok(sessions.every((row) => row.connected));
  });

  it("round-trips commands through the owning client", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    const client = makeClient(socketPath, "terminal", (frame) => ({
      command: frame.command,
      payload: frame.payload,
    }));
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => client.stop());

    await broker.listen();
    client.start();
    await waitFor(() => broker.listSessions()[0]?.connected);

    assert.deepEqual(
      await broker.command("terminal", "prompt", { message: "hello" }),
      { command: "prompt", payload: { message: "hello" } },
    );
  });

  it("marks a terminal disconnected without deleting its snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    const client = makeClient(socketPath, "terminal");
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => client.stop());

    await broker.listen();
    client.start();
    await waitFor(() => broker.listSessions()[0]?.snapshot);
    client.stop();

    const row = await waitFor(() => {
      const current = broker.listSessions()[0];
      return current && !current.connected ? current : null;
    });
    assert.equal(row.runtimeId, "terminal");
    assert.ok(row.snapshot);
  });
});
