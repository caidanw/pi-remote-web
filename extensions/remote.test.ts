import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { acquireSessionLock, releaseSessionLock } from "../remote/session-lock.js";
import { RemoteBroker } from "../server/remote-broker.js";
import remoteExtension from "./remote.ts";

async function waitFor<T>(check: () => T | null, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("condition was not met before timeout");
}

describe("remote extension", () => {
  it("registers a TUI session, forwards events, and releases ownership", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-"));
    const socketPath = path.join(dir, "broker.sock");
    const lockDir = path.join(dir, "locks");
    const sessionFile = path.join(dir, "session.jsonl");
    const broker = new RemoteBroker({ socketPath });
    const previousSocket = process.env.PI_REMOTE_WEB_SOCKET;
    const previousLocks = process.env.PI_REMOTE_WEB_LOCK_DIR;
    process.env.PI_REMOTE_WEB_SOCKET = socketPath;
    process.env.PI_REMOTE_WEB_LOCK_DIR = lockDir;

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const statuses: string[] = [];
    const remotePrompts: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, handler);
      },
      getSessionName: () => "Live terminal",
      sendUserMessage: (message: string) => remotePrompts.push(message),
    };
    const context = {
      mode: "tui",
      cwd: dir,
      model: { provider: "test", id: "model", name: "Model" },
      thinkingLevel: "medium",
      isIdle: () => true,
      shutdown: () => assert.fail("session should not be rejected"),
      sessionManager: {
        getSessionId: () => "session-id",
        getSessionFile: () => sessionFile,
        getLeafId: () => "leaf-id",
        getBranch: () => [],
      },
      ui: {
        setStatus: (_key: string, value?: string) => {
          if (value) statuses.push(value);
        },
        notify: () => {},
      },
    };

    try {
      await broker.listen();
      remoteExtension(pi as unknown as ExtensionAPI);
      await handlers.get("session_start")?.({}, context);

      const registered = await waitFor(() => broker.listSessions()[0] ?? null);
      assert.equal(registered.registration?.session.name, "Live terminal");
      assert.equal(registered.snapshot?.sessionId, "session-id");
      assert.ok(statuses.includes("remote: connected"));

      assert.deepEqual(
        await broker.command(registered.runtimeId, "prompt", { message: "from browser" }),
        { accepted: true },
      );
      assert.deepEqual(remotePrompts, ["from browser"]);

      await handlers.get("message_start")?.({ message: { role: "user", content: "hello" } }, context);
      const event = await waitFor(() => broker.listSessions()[0]?.lastEvent ?? null);
      assert.equal(event.type, "message_start");

      await handlers.get("session_shutdown")?.({}, context);
      const reacquired = await acquireSessionLock({
        baseDir: lockDir,
        sessionPath: sessionFile,
        ownerKind: "terminal",
        runtimeId: "next",
      });
      assert.equal(reacquired.ok, true);
      if (reacquired.ok) await releaseSessionLock(reacquired.lock);
    } finally {
      await broker.close();
      await rm(dir, { recursive: true, force: true });
      if (previousSocket === undefined) delete process.env.PI_REMOTE_WEB_SOCKET;
      else process.env.PI_REMOTE_WEB_SOCKET = previousSocket;
      if (previousLocks === undefined) delete process.env.PI_REMOTE_WEB_LOCK_DIR;
      else process.env.PI_REMOTE_WEB_LOCK_DIR = previousLocks;
    }
  });
});
