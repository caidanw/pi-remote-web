/**
 * HTTP + SSE wire contracts (node --test).
 * Locks REST/SSE shapes the web client depends on before any host migration.
 *
 * Run: node --test server/http.contract.test.js
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, mergeRemoteSessions } from "./http.js";
import { hub } from "./hub.js";
import { acquireSessionLock, releaseSessionLock } from "../remote/session-lock.js";
import { makeTestCwd, cleanupTestCwd } from "./test-temp.js";

/** @param {string} base @param {string} path @param {RequestInit} [init] */
async function api(base, path, init) {
  const res = await fetch(`${base}${path}`, init);
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { res, body, text };
}

/**
 * Read SSE frames until predicate or timeout.
 * @param {string} url
 * @param {(frames: {id?: number, data: unknown, raw: string}[]) => boolean} done
 * @param {number} [ms]
 */
async function readSseUntil(url, done, ms = 5000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  /** @type {{id?: number, data: unknown, raw: string}[]} */
  const frames = [];
  try {
    const res = await fetch(url, {
      headers: { Accept: "text/event-stream" },
      signal: ac.signal,
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
    const reader = res.body?.getReader();
    assert.ok(reader);
    const dec = new TextDecoder();
    let buf = "";
    while (!done(frames)) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += dec.decode(value, { stream: true });
      // split on blank line (SSE event boundary)
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (!chunk.trim() || chunk.startsWith(":")) continue; // comment/ping
        /** @type {{id?: number, data: unknown, raw: string}} */
        const frame = { raw: chunk, data: null };
        for (const line of chunk.split("\n")) {
          if (line.startsWith("id:")) {
            frame.id = Number(line.slice(3).trim());
          } else if (line.startsWith("data:")) {
            const raw = line.slice(5).trim();
            try {
              frame.data = JSON.parse(raw);
            } catch {
              frame.data = raw;
            }
          }
        }
        frames.push(frame);
        if (done(frames)) break;
      }
    }
    reader.cancel().catch(() => {});
  } finally {
    clearTimeout(t);
  }
  return frames;
}

describe("HTTP wire contract", () => {
  /** @type {ReturnType<typeof createServer>} */
  let app;
  /** @type {string} */
  let base;
  /** @type {string} */
  let cwd;
  /** @type {string} */
  let sessionId;
  /** @type {string | undefined} */
  let previousLockDir;
  const remoteCommands = [];

  before(async () => {
    cwd = makeTestCwd("pi-remote-web-http-");
    previousLockDir = process.env.PI_REMOTE_WEB_LOCK_DIR;
    process.env.PI_REMOTE_WEB_LOCK_DIR = `${cwd}/locks`;
    app = createServer({
      port: 0,
      remoteBroker: {
        listSessions: () => [
          {
            runtimeId: "terminal-one",
            connected: true,
            registration: {
              session: {
                id: "terminal-session-one",
                path: "/tmp/terminal-one.jsonl",
                cwd: "/tmp/project-one",
                name: "Terminal one",
                thinkingLevel: "medium",
                model: { provider: "test", id: "one", name: "One" },
              },
            },
          },
          { runtimeId: "terminal-two", connected: false },
        ],
        hasSession: (runtimeId) => runtimeId === "terminal-one" || runtimeId === "terminal-two",
        findByPath: (sessionPath) => sessionPath === "/tmp/terminal-one.jsonl" ? "terminal-one" : null,
        getSessionRow: (runtimeId) => ({
          id: runtimeId,
          runtimeId,
          remote: true,
          bound: true,
          running: true,
          connected: runtimeId === "terminal-one",
          path: runtimeId === "terminal-one" ? "/tmp/terminal-one.jsonl" : undefined,
          cwd: runtimeId === "terminal-one" ? "/tmp/project-one" : undefined,
          name: runtimeId === "terminal-one" ? "Terminal one" : undefined,
          thinkingLevel: "medium",
          model: { provider: "test", id: "one", name: "One", reasoning: true },
        }),
        getMessages: (runtimeId) => [
          { role: "user", content: `messages for ${runtimeId}` },
        ],
        ringInfo: () => ({ seq: 2, ringStart: 1 }),
        eventsAfter: (_runtimeId, after) =>
          after < 2
            ? [{ seq: 2, event: { type: "message_start", message: { role: "assistant", content: "live" } } }]
            : [],
        subscribeSession: () => () => {},
        command: async (runtimeId, command, payload) => {
          remoteCommands.push({ runtimeId, command, payload });
          if (command === "list_models") {
            return { models: [{ provider: "test", id: "one", name: "One" }] };
          }
          if (command === "get_thinking") {
            return { level: "medium", available: ["off", "medium"], supports: true };
          }
          return { accepted: command };
        },
      },
    });
    await new Promise((resolve) => app.listen(resolve));
    const addr = app.server.address();
    assert.ok(addr && typeof addr === "object");
    assert.equal(addr.address, "127.0.0.1");
    base = `http://127.0.0.1:${addr.port}`;

    const { res, body } = await api(base, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, fresh: true }),
    });
    assert.equal(res.status, 200);
    assert.ok(body.id);
    sessionId = body.id;
  });

  after(async () => {
    try {
      await hub.disposeAll();
    } catch {
      /* ignore */
    }
    try {
      await app.close();
    } catch {
      /* ignore */
    }
    cleanupTestCwd(cwd);
    if (previousLockDir === undefined) delete process.env.PI_REMOTE_WEB_LOCK_DIR;
    else process.env.PI_REMOTE_WEB_LOCK_DIR = previousLockDir;
  });

  it("keeps saved history rows pinned beside a runtime-following terminal row", () => {
    const broker = {
      listSessions: () => [
        {
          runtimeId: "runtime",
          connected: true,
          registration: { session: { id: "current", path: "/tmp/current.jsonl" } },
        },
      ],
    };
    const rows = mergeRemoteSessions(
      [
        { id: "previous", path: "/tmp/previous.jsonl", running: false },
        { id: "current", path: "/tmp/current.jsonl", running: false },
      ],
      broker,
    );
    assert.deepEqual(rows.map((row) => row.id), ["runtime", "previous"]);
  });

  it("GET /api/health", async () => {
    const { res, body } = await api(base, "/api/health");
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(typeof body.open, "number");
    assert.ok(body.open >= 1);
    assert.equal(body.remote, 2);
  });

  it("GET /api/remote/sessions lists registered terminals", async () => {
    const { res, body } = await api(base, "/api/remote/sessions");
    assert.equal(res.status, 200);
    assert.deepEqual(
      body.sessions.map((session) => [session.runtimeId, session.connected]),
      [
        ["terminal-one", true],
        ["terminal-two", false],
      ],
    );
  });

  it("reads and prompts a registered terminal", async () => {
    const messages = await api(base, "/api/remote/sessions/terminal-one/messages");
    assert.equal(messages.res.status, 200);
    assert.equal(messages.body.messages[0].content, "messages for terminal-one");

    const prompted = await api(base, "/api/remote/sessions/terminal-one/prompt", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    });
    assert.equal(prompted.res.status, 202);
    assert.deepEqual(prompted.body, { accepted: "prompt" });
  });

  it("GET /api/customization returns safe defaults", async () => {
    const { res, body } = await api(base, "/api/customization");
    assert.equal(res.status, 200);
    assert.equal(body.config.version, 1);
    assert.ok(Array.isArray(body.warnings));
    assert.equal(typeof body.trustedProject, "boolean");
  });

  it("routes the existing session contract to terminal owners", async () => {
    const listed = await api(base, "/api/sessions");
    const live = listed.body.sessions.find((row) => row.id === "terminal-one");
    assert.equal(live.remote, true);
    assert.equal(live.bound, true);
    assert.equal(live.name, "Terminal one");

    const detail = await api(base, "/api/sessions/terminal-one");
    assert.equal(detail.body.path, "/tmp/terminal-one.jsonl");
    const messages = await api(base, "/api/sessions/terminal-one/messages");
    assert.equal(messages.body.messages[0].content, "messages for terminal-one");
    const attached = await api(base, "/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "/tmp/terminal-one.jsonl" }),
    });
    assert.equal(attached.body.id, "terminal-one");

    const frames = await readSseUntil(
      `${base}/api/sessions/terminal-one/events?after=1`,
      (items) => items.some((frame) => frame.id === 2),
    );
    assert.equal(frames.find((frame) => frame.id === 2)?.data.type, "message_start");

    const calls = [
      ["prompt", { message: "hello" }],
      ["steer", { message: "redirect" }],
      ["follow-up", { message: "later" }],
      ["abort", undefined],
      ["model", { provider: "test", id: "one" }],
      ["thinking", { level: "high" }],
      ["compact", {}],
    ];
    for (const [route, body] of calls) {
      const result = await api(base, `/api/sessions/terminal-one/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.ok(result.res.status < 300, `${route}: ${result.text}`);
    }
    const renamed = await api(base, "/api/sessions/terminal-one", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Renamed" }),
    });
    assert.equal(renamed.res.status, 200);
    const routed = remoteCommands.map((call) => call.command);
    for (const command of [
      "prompt",
      "steer",
      "follow_up",
      "abort",
      "set_model",
      "set_thinking",
      "compact",
      "rename",
    ]) assert.ok(routed.includes(command), `missing ${command}`);

    const unsupported = await api(base, "/api/sessions/terminal-one/bash", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: "pwd" }),
    });
    assert.equal(unsupported.res.status, 409);
    assert.equal(unsupported.body.code, "REMOTE_UNSUPPORTED");
  });

  it("GET /api/sessions lists running hub id", async () => {
    const { res, body } = await api(
      base,
      `/api/sessions?cwd=${encodeURIComponent(cwd)}`,
    );
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.sessions), "wire shape is { sessions }");
    const row = body.sessions.find((r) => r.id === sessionId);
    assert.ok(row, "opened session in list");
    assert.equal(row.running, true);
  });

  it("GET /api/sessions/:id meta", async () => {
    const { res, body } = await api(base, `/api/sessions/${sessionId}`);
    assert.equal(res.status, 200);
    assert.equal(body.id, sessionId);
    assert.equal(body.running, true);
    assert.equal(typeof body.streaming, "boolean");
  });

  it("GET /api/sessions/:id/messages shape", async () => {
    const { res, body } = await api(base, `/api/sessions/${sessionId}/messages`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(body.messages));
  });

  it("creates, reads, edits, and reloads a project skill", async () => {
    const content = `---\nname: gui-test-skill\ndescription: Exercise the GUI skill workspace.\n---\n\n# GUI test skill\n`;
    const created = await api(base, `/api/sessions/${sessionId}/skills`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: "project",
        name: "gui-test-skill",
        content,
      }),
    });
    assert.equal(created.res.status, 200);
    assert.equal(created.body.name, "gui-test-skill");
    assert.ok(created.body.workspace.skills.some((s) => s.name === "gui-test-skill"));

    const listed = await api(base, `/api/sessions/${sessionId}/skills`);
    const skill = listed.body.skills.find((s) => s.name === "gui-test-skill");
    assert.equal(skill.editable, true);
    assert.equal(skill.editableScope, "project");

    const detail = await api(
      base,
      `/api/sessions/${sessionId}/skill-file?path=${encodeURIComponent(skill.filePath)}`,
    );
    assert.equal(detail.res.status, 200);
    assert.equal(detail.body.content, content);

    const updated = content.replace("GUI test skill", "Updated GUI test skill");
    const saved = await api(base, `/api/sessions/${sessionId}/skill-file`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filePath: skill.filePath, content: updated }),
    });
    assert.equal(saved.res.status, 200);
    assert.ok(saved.body.workspace.skills.some((s) => s.name === "gui-test-skill"));
  });

  it("returns conflict instead of opening a terminal-owned session", async () => {
    const created = await hub.open({ cwd, fresh: true });
    assert.ok(created.path);
    await hub.close(created.id);
    const external = await acquireSessionLock({
      baseDir: `${cwd}/locks`,
      sessionPath: created.path,
      ownerKind: "terminal",
      runtimeId: "terminal-owner",
      pid: process.pid,
    });
    assert.equal(external.ok, true);
    try {
      const { res, body } = await api(base, "/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: created.path, cwd }),
      });
      assert.equal(res.status, 409);
      assert.equal(body.code, "SESSION_OWNED");
    } finally {
      if (external.ok) await releaseSessionLock(external.lock);
    }
  });

  it("POST /api/sessions/:id/prompt validates body", async () => {
    const empty = await api(base, `/api/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "  " }),
    });
    assert.equal(empty.res.status, 400);

    const missing = await api(base, `/api/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.res.status, 400);
  });

  it("GET /api/sessions/:id/commands exposes extension argument choices", async () => {
    const open = hub.require(sessionId);
    const runner = open.session.extensionRunner;
    const originalCommands = runner.getRegisteredCommands;
    runner.getRegisteredCommands = () => [
      {
        invocationName: "headroom",
        description: "Headroom status",
        getArgumentCompletions: () => [
          { value: "on", label: "on" },
          { value: "off", label: "off" },
          { value: "status", label: "status" },
        ],
      },
    ];
    try {
      const listed = await api(base, `/api/sessions/${sessionId}/commands`);
      assert.equal(listed.res.status, 200);
      assert.equal(listed.body.commands[0].argumentHint, "<on|off|status>");
    } finally {
      runner.getRegisteredCommands = originalCommands;
    }
  });

  it("POST /api/sessions/:id/command executes only registered extension commands", async () => {
    const open = hub.require(sessionId);
    const runner = open.session.extensionRunner;
    const originalCommands = runner.getRegisteredCommands;
    const originalPrompt = open.session.prompt;
    let invoked = "";
    runner.getRegisteredCommands = () => [{ invocationName: "headroom" }];
    open.session.prompt = async (text) => {
      invoked = text;
    };
    try {
      const ran = await api(base, `/api/sessions/${sessionId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "/headroom status" }),
      });
      assert.equal(ran.res.status, 200);
      assert.equal(ran.body.ok, true);
      assert.equal(invoked, "/headroom status");

      const unknown = await api(base, `/api/sessions/${sessionId}/command`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "/not-registered" }),
      });
      assert.equal(unknown.res.status, 400);
      assert.match(unknown.body.error, /Unknown extension command/);
    } finally {
      runner.getRegisteredCommands = originalCommands;
      open.session.prompt = originalPrompt;
    }
  });

  it("POST /api/sessions/:id/prompt returns 202 and SSE error+settled on fail", async () => {
    const open = hub.require(sessionId);
    open.session.prompt = async () => {
      throw new Error("http-prompt-boom");
    };

    // Subscribe SSE first so we don't miss fanout
    const ssePromise = readSseUntil(
      `${base}/api/sessions/${sessionId}/events?after=0`,
      (frames) => {
        const types = frames
          .map((f) => /** @type {{type?: string}} */ (f.data)?.type)
          .filter(Boolean);
        return types.includes("error") && types.includes("agent_settled");
      },
      8000,
    );

    // small delay so SSE connected + subscribed before prompt
    await new Promise((r) => setTimeout(r, 100));

    const { res, body } = await api(base, `/api/sessions/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "boom please" }),
    });
    assert.equal(res.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.id, sessionId);

    const frames = await ssePromise;
    // First frame: connected without id line
    const connected = frames.find(
      (f) => /** @type {{type?: string}} */ (f.data)?.type === "connected",
    );
    assert.ok(connected, "connected frame");
    assert.equal(connected.id, undefined, "connected must not set SSE id");
    assert.equal(
      /** @type {{id?: string}} */ (connected.data).id,
      sessionId,
    );
    assert.equal(typeof /** @type {{seq?: number}} */ (connected.data).seq, "number");
    assert.equal(
      typeof /** @type {{ringStart?: number}} */ (connected.data).ringStart,
      "number",
    );

    const err = frames.find(
      (f) => /** @type {{type?: string}} */ (f.data)?.type === "error",
    );
    assert.ok(err);
    assert.ok(typeof err.id === "number" && err.id > 0, "error has seq id");
    assert.equal(
      /** @type {{error?: string}} */ (err.data).error,
      "http-prompt-boom",
    );

    // slim: message_update partial strip covered elsewhere; ensure format
    const settled = frames.find(
      (f) => /** @type {{type?: string}} */ (f.data)?.type === "agent_settled",
    );
    assert.ok(settled);
    assert.ok(settled.id > err.id);
  });

  it("SSE resume ?after= replays only newer seq", async () => {
    // Ring already has error+settled from previous test
    const info = hub.ringInfo(sessionId);
    assert.ok(info.seq >= 2);
    const after = info.seq - 1;
    const frames = await readSseUntil(
      `${base}/api/sessions/${sessionId}/events?after=${after}`,
      (fs) => {
        const withId = fs.filter((f) => typeof f.id === "number");
        // connected + at least the last event(s)
        return withId.length >= 1 && withId.every((f) => f.id > after);
      },
      5000,
    );
    const withId = frames.filter((f) => typeof f.id === "number");
    assert.ok(withId.length >= 1);
    for (const f of withId) {
      assert.ok(f.id > after, `seq ${f.id} should be > after ${after}`);
    }
    // cold after=0 still sends connected (no id)
    const cold = await readSseUntil(
      `${base}/api/sessions/${sessionId}/events?after=0`,
      (fs) => fs.some((f) => /** @type {{type?: string}} */ (f.data)?.type === "connected"),
      3000,
    );
    const c = cold.find(
      (f) => /** @type {{type?: string}} */ (f.data)?.type === "connected",
    );
    assert.ok(c);
    assert.equal(c.id, undefined);
  });

  it("POST /api/sessions/:id/abort ok", async () => {
    const open = hub.require(sessionId);
    let aborted = false;
    open.session.abort = async () => {
      aborted = true;
    };
    const { res, body } = await api(base, `/api/sessions/${sessionId}/abort`, {
      method: "POST",
    });
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(aborted, true);
  });

  it("OPTIONS allows CORS preflight", async () => {
    const res = await fetch(`${base}/api/health`, { method: "OPTIONS" });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
  });
});
