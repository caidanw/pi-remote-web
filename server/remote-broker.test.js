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
      session: {
        id: `session-${runtimeId}`,
        path: `/tmp/${runtimeId}.jsonl`,
        cwd: `/tmp/${runtimeId}`,
      },
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

  it("builds the transcript from streamed messages without full snapshots", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    const client = makeClient(socketPath, "terminal");
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => client.stop());

    await broker.listen();
    client.start();
    await waitFor(() => broker.listSessions()[0]?.connected);

    client.publish({
      type: "message_start",
      message: { role: "assistant", timestamp: 100, stopReason: "pending", content: [] },
    });
    await waitFor(() => broker.getMessages("terminal").length === 1);

    client.publish({
      type: "message_update",
      message: {
        role: "assistant",
        timestamp: 100,
        responseId: "response-1",
        stopReason: "pending",
        content: [{ type: "text", text: "partial" }],
      },
    });
    client.publish({
      type: "message_end",
      message: {
        role: "assistant",
        timestamp: 100,
        responseId: "response-1",
        stopReason: "stop",
        content: [{ type: "text", text: "final answer" }],
      },
    });
    await waitFor(() => broker.getMessages("terminal").at(-1)?.stopReason === "stop");

    let transcript = broker.getMessages("terminal");
    const streamed = transcript.filter((message) => message.timestamp === 100);
    assert.equal(streamed.length, 1, "a completed message replaces its id-less streaming copy");
    assert.equal(streamed[0].content[0].text, "final answer");

    client.publish({
      type: "message_start",
      message: { role: "user", timestamp: 200, content: [{ type: "text", text: "next" }] },
    });
    client.publish({
      type: "message_end",
      message: { role: "user", timestamp: 200, content: [{ type: "text", text: "next" }] },
    });
    await waitFor(() => broker.getMessages("terminal").at(-1)?.role === "user");
    transcript = broker.getMessages("terminal");
    assert.equal(
      transcript.filter((message) => message.timestamp === 200).length,
      1,
      "message_start and message_end share one transcript row",
    );

    client.publish({
      type: "message_start",
      message: { role: "toolResult", toolCallId: "call-1", timestamp: 300, content: [] },
    });
    client.publish({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        timestamp: 300,
        content: [{ type: "text", text: "done" }],
      },
    });
    await waitFor(() => broker.getMessages("terminal").at(-1)?.toolCallId === "call-1");
    transcript = broker.getMessages("terminal");
    assert.equal(
      transcript.filter((message) => message.toolCallId === "call-1").length,
      1,
      "tool result start and end share one transcript row",
    );
  });

  it("keeps a runtime-following stream across terminal /new while old paths unpin", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    let active = { id: "old-session", path: "/tmp/old.jsonl", messages: [{ role: "user", content: "old" }] };
    const client = new RemoteClient({
      socketPath,
      runtimeId: "terminal",
      maxBackoffMs: 20,
      random: () => 0.5,
      getRegistration: () => ({ session: { id: active.id, path: active.path, cwd: "/tmp" } }),
      getSnapshot: () => ({
        session: { id: active.id, path: active.path, cwd: "/tmp" },
        messages: active.messages,
      }),
    });
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => client.stop());

    await broker.listen();
    client.start();
    await waitFor(() => broker.hasSession("terminal") && broker.getMessages("terminal")[0]);
    const events = [];
    broker.subscribeSession("terminal", (event) => events.push(event));

    client.stop();
    active = { id: "new-session", path: "/tmp/new.jsonl", messages: [{ role: "user", content: "new" }] };
    client.start();

    await waitFor(() =>
      broker.hasSession("terminal") && broker.getMessages("terminal")[0]?.content === "new",
    );
    assert.equal(broker.getSessionRow("terminal").path, "/tmp/new.jsonl");
    assert.equal(broker.findByPath("/tmp/old.jsonl"), null);
    assert.equal(broker.findByPath("/tmp/new.jsonl"), "terminal");
    assert.deepEqual(
      events.filter((event) => event.type === "session_replaced")[0],
      {
        type: "session_replaced",
        previousSession: { id: "old-session", path: "/tmp/old.jsonl", cwd: "/tmp" },
        session: { id: "new-session", path: "/tmp/new.jsonl", cwd: "/tmp" },
      },
    );
    assert.ok(events.some((event) => event.type === "snapshot_available"));
    assert.ok(events.every((event) => event.type !== "snapshot"));
  });

  it("bounds oversize snapshots, requests resync, and deduplicates replay", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    const client = new RemoteClient({
      socketPath,
      runtimeId: "terminal",
      maxFrameBytes: 512,
      getRegistration: () => ({ session: { id: "large", cwd: "/tmp" } }),
      getSnapshot: () => ({
        session: { id: "large", cwd: "/tmp" },
        messages: [{ role: "user", content: "x".repeat(2048) }],
      }),
    });
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => client.stop());

    await broker.listen();
    client.start();
    const snapshot = await waitFor(() => broker.hasSession("terminal") && broker.getSession("terminal").snapshot);
    assert.equal(snapshot.truncated, true);
    assert.equal(snapshot.droppedMessages, 1);
    assert.deepEqual(broker.getMessages("terminal"), []);
    const ring = broker.eventsAfter("terminal", 0);
    assert.ok(ring.some(({ event }) => event.type === "resync_required"));
    assert.ok(ring.some(({ event }) => event.type === "snapshot_available"));
    assert.ok(ring.every(({ event }) => !Array.isArray(event.messages)));

    const before = broker.ringInfo("terminal").seq;
    client.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(broker.ringInfo("terminal").seq, before);
  });

  it("repairs a backpressure overflow with a fresh authoritative snapshot", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    let transcript = [{ role: "user", content: "initial" }];
    const client = new RemoteClient({
      socketPath,
      runtimeId: "terminal",
      maxQueueBytes: 128,
      getRegistration: () => ({ session: { id: "backpressure", cwd: "/tmp" } }),
      getSnapshot: () => ({
        session: { id: "backpressure", cwd: "/tmp" },
        messages: transcript,
      }),
    });
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => client.stop());

    await broker.listen();
    client.start();
    await waitFor(() =>
      broker.hasSession("terminal") && broker.getMessages("terminal")[0]?.content === "initial",
    );
    transcript = [{ role: "user", content: "repaired" }];

    const socket = client.socket;
    assert.ok(socket);
    const write = socket.write;
    socket.write = () => false;
    client.publish({ type: "message_update", message: { role: "assistant", content: "blocked" } });
    client.publish({ type: "message_update", data: "x".repeat(1024) });
    socket.write = write;
    socket.emit("drain");

    await waitFor(() => broker.getMessages("terminal")[0]?.content === "repaired");
    assert.ok(
      broker.eventsAfter("terminal", 0).some(({ event }) => event.type === "resync_required"),
    );
  });

  it("serializes commands per terminal runtime", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    let active = 0;
    let maxActive = 0;
    const client = makeClient(socketPath, "terminal", async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { accepted: true };
    });
    const broker = new RemoteBroker({ socketPath });
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    cleanup.push(() => broker.close());
    cleanup.push(async () => client.stop());

    await broker.listen();
    client.start();
    await waitFor(() => broker.listSessions()[0]?.connected);
    await Promise.all([
      broker.command("terminal", "prompt", { message: "one" }),
      broker.command("terminal", "prompt", { message: "two" }),
    ]);
    assert.equal(maxActive, 1);
  });

  it("keeps a disconnected terminal through grace, then removes its catalogue claim", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-remote-web-remote-"));
    const socketPath = path.join(dir, "broker.sock");
    const client = makeClient(socketPath, "terminal");
    const broker = new RemoteBroker({ socketPath, reconnectGraceMs: 40 });
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
    assert.equal(broker.getSessionRow("terminal").running, false);
    await waitFor(() => !broker.hasSession("terminal"));
    assert.equal(broker.findByPath("/tmp/terminal.jsonl"), null);
  });
});
