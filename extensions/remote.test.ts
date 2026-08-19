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
    const remotePrompts: { message: unknown; options?: unknown }[] = [];
    const selectedModels: string[] = [];
    const renamed: string[] = [];
    let thinking = "medium";
    let aborted = false;
    let compacted = false;
    const models = [
      { provider: "test", id: "model", name: "Model", reasoning: true },
      { provider: "test", id: "other", name: "Other", reasoning: true },
    ];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, handler);
      },
      getSessionName: () => renamed.at(-1) ?? "Live terminal",
      getThinkingLevel: () => thinking,
      setThinkingLevel: (level: string) => {
        thinking = level;
      },
      setSessionName: (name: string) => renamed.push(name),
      setModel: async (model: { id: string }) => {
        selectedModels.push(model.id);
        return true;
      },
      sendUserMessage: (message: unknown, options?: unknown) =>
        remotePrompts.push({ message, options }),
    };
    const context = {
      mode: "tui",
      cwd: dir,
      model: { provider: "test", id: "model", name: "Model" },
      thinkingLevel: "medium",
      isIdle: () => true,
      abort: () => {
        aborted = true;
      },
      compact: () => {
        compacted = true;
      },
      shutdown: () => assert.fail("session should not be rejected"),
      modelRegistry: {
        find: (provider: string, id: string) =>
          models.find((model) => model.provider === provider && model.id === id),
        getAvailable: () => models,
        getAll: () => models,
      },
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
      assert.deepEqual(remotePrompts, [{ message: "from browser", options: undefined }]);

      await broker.command(registered.runtimeId, "steer", { message: "redirect" });
      await broker.command(registered.runtimeId, "follow_up", { message: "then this" });
      await broker.command(registered.runtimeId, "abort");
      await broker.command(registered.runtimeId, "compact");
      await broker.command(registered.runtimeId, "set_model", {
        provider: "test",
        id: "other",
      });
      await broker.command(registered.runtimeId, "set_thinking", { level: "high" });
      await broker.command(registered.runtimeId, "rename", { name: "Renamed" });
      assert.deepEqual(remotePrompts.slice(1), [
        { message: "redirect", options: { deliverAs: "steer" } },
        { message: "then this", options: { deliverAs: "followUp" } },
      ]);
      assert.equal(aborted, true);
      assert.equal(compacted, true);
      assert.deepEqual(selectedModels, ["other"]);
      assert.equal(thinking, "high");
      assert.deepEqual(renamed, ["Renamed"]);

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

  it("rejects a terminal session when another live runtime owns its file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-conflict-"));
    const lockDir = path.join(dir, "locks");
    const sessionFile = path.join(dir, "session.jsonl");
    const previousLocks = process.env.PI_REMOTE_WEB_LOCK_DIR;
    process.env.PI_REMOTE_WEB_LOCK_DIR = lockDir;
    const foreign = await acquireSessionLock({
      baseDir: lockDir,
      sessionPath: sessionFile,
      ownerKind: "terminal",
      runtimeId: "foreign-runtime",
      pid: process.pid,
    });
    assert.equal(foreign.ok, true);

    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    let shutdown = false;
    const notices: string[] = [];
    const pi = {
      on(name: string, handler: (...args: unknown[]) => unknown) {
        handlers.set(name, handler);
      },
      getSessionName: () => "Conflict",
      getThinkingLevel: () => "off",
    };
    const context = {
      mode: "tui",
      cwd: dir,
      isIdle: () => true,
      shutdown: () => {
        shutdown = true;
      },
      sessionManager: {
        getSessionId: () => "conflict-session",
        getSessionFile: () => sessionFile,
        getLeafId: () => null,
        getBranch: () => [],
      },
      ui: {
        setStatus: () => {},
        notify: (message: string) => notices.push(message),
      },
    };

    try {
      remoteExtension(pi as unknown as ExtensionAPI);
      await handlers.get("session_start")?.({}, context);
      assert.equal(shutdown, true);
      assert.match(notices[0] ?? "", /foreign-runtime/);
    } finally {
      if (foreign.ok) await releaseSessionLock(foreign.lock);
      await rm(dir, { recursive: true, force: true });
      if (previousLocks === undefined) delete process.env.PI_REMOTE_WEB_LOCK_DIR;
      else process.env.PI_REMOTE_WEB_LOCK_DIR = previousLocks;
    }
  });
});
