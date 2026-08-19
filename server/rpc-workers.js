import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  acquireSessionLock,
  releaseSessionLock,
  updateSessionLockPid,
} from "../remote/session-lock.js";

const RING_MAX = 500;
const REQUEST_TIMEOUT_MS = 30_000;
const RPC_ENTRY = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent/rpc-entry"));

function defaultSessionDir(cwd) {
  const resolved = path.resolve(cwd);
  return path.join(
    getAgentDir(),
    "sessions",
    `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`,
  );
}

function freshSession(cwd, sessionDir = defaultSessionDir(cwd)) {
  const id = randomUUID();
  const now = new Date();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return {
    id,
    path: path.join(sessionDir, `${stamp}_${id}.jsonl`),
    header: `${JSON.stringify({
      type: "session",
      version: 3,
      id,
      timestamp: now.toISOString(),
      cwd: path.resolve(cwd),
    })}\n`,
  };
}

function busyState(state, bashRunning = false) {
  return Boolean(
    state?.isStreaming ||
      state?.isCompacting ||
      state?.pendingMessageCount > 0 ||
      bashRunning,
  );
}

/** One isolated `pi --mode rpc` child per browser-owned session. */
export class RpcWorkerManager {
  /**
   * @param {{ lockDir?: string; rpcEntry?: string; spawnProcess?: typeof spawn; env?: NodeJS.ProcessEnv; sessionDir?: (cwd: string) => string }} [options]
   */
  constructor(options = {}) {
    this.lockDir = options.lockDir ?? path.join(getAgentDir(), "remote", "locks");
    this.rpcEntry = options.rpcEntry ?? RPC_ENTRY;
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.env = options.env;
    this.sessionDir = options.sessionDir;
    /** @type {Map<string, any>} */
    this.workers = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.pathTails = new Map();
    this.closing = false;
  }

  hasSession(id) {
    return this.workers.has(id);
  }

  findByPath(sessionPath) {
    const resolved = path.resolve(sessionPath);
    for (const worker of this.workers.values()) {
      if (worker.path === resolved) return worker.id;
    }
    return null;
  }

  listSessions() {
    return [...this.workers.values()].map((worker) => this.#row(worker));
  }

  /** @param {{ path?: string; cwd?: string; fresh?: boolean }} options */
  async open(options = {}) {
    if (this.closing) throw new Error("RPC worker manager is stopping");
    const cwd = path.resolve(options.cwd || process.cwd());
    let sessionPath = options.path ? path.resolve(options.path) : "";
    let created;
    if (!sessionPath) {
      created = freshSession(cwd, this.sessionDir?.(cwd));
      sessionPath = created.path;
    }
    return this.#withPath(sessionPath, async () => {
      const existingId = this.findByPath(sessionPath);
      const existing = existingId ? this.workers.get(existingId) : null;
      if (existing?.running) return this.#row(existing);
      if (existing) {
        await this.#stop(existing);
        this.workers.delete(existing.id);
      }

      const runtimeId = `browser-${randomUUID()}`;
      const acquired = await acquireSessionLock({
        baseDir: this.lockDir,
        sessionPath,
        ownerKind: "browser",
        runtimeId,
      });
      if (!acquired.ok) {
        const owner = acquired.owner?.runtimeId ?? "another Pi process";
        const error = new Error(`Session is already owned by ${owner}`);
        error.code = "SESSION_OWNED";
        throw error;
      }

      let worker;
      try {
        if (created) {
          await mkdir(path.dirname(sessionPath), { recursive: true });
          await writeFile(sessionPath, created.header, { flag: "wx", mode: 0o600 });
        }
        worker = this.#spawn({
          id: created?.id ?? runtimeId,
          runtimeId,
          path: sessionPath,
          cwd,
          lock: acquired.lock,
        });
        const workerLock = await updateSessionLockPid(acquired.lock, worker.child.pid);
        if (!workerLock) throw new Error("Browser session ownership changed during startup");
        worker.lock = workerLock;
        const state = await this.#request(worker, { type: "get_state" });
        worker.id = state.sessionId;
        worker.state = state;
        worker.messages = await this.#request(worker, { type: "get_messages" }).then(
          (data) => data.messages ?? [],
        );
        this.workers.set(worker.id, worker);
        return this.#row(worker);
      } catch (error) {
        if (worker) await this.#stop(worker);
        else await releaseSessionLock(acquired.lock);
        throw error;
      }
    });
  }

  ensure(id) {
    return Promise.resolve(this.require(id));
  }

  require(id) {
    const worker = this.workers.get(id);
    if (!worker) {
      const error = new Error(`Session not open: ${id}`);
      error.code = "SESSION_NOT_OPEN";
      throw error;
    }
    return worker;
  }

  get(id) {
    return this.#row(this.require(id));
  }

  getMessages(id) {
    const worker = this.require(id);
    return worker.streamingMessage
      ? [...worker.messages, worker.streamingMessage]
      : worker.messages;
  }

  ringInfo(id) {
    const worker = this.require(id);
    return {
      seq: worker.seq,
      ringStart: worker.ring[0]?.seq ?? (worker.seq ? worker.seq + 1 : 1),
    };
  }

  eventsAfter(id, after) {
    return this.require(id).ring.filter((item) => item.seq > after);
  }

  subscribe(id, listener) {
    const worker = this.require(id);
    worker.listeners.add(listener);
    return () => worker.listeners.delete(listener);
  }

  prompt(id, message, images) {
    return this.#operation(id, (worker) =>
      this.#request(worker, {
        type: "prompt",
        message,
        images,
        ...(worker.state?.isStreaming ? { streamingBehavior: "steer" } : {}),
      }),
    );
  }

  command(id, text) {
    return this.#operation(id, async (worker) => {
      await this.#request(worker, { type: "prompt", message: text });
      return { ok: true, id, notifications: [] };
    });
  }

  abort(id) {
    return this.#operation(id, (worker) => this.#request(worker, { type: "abort" }));
  }

  steer(id, message, images) {
    return this.#operation(id, (worker) =>
      this.#request(worker, { type: "steer", message, images }),
    );
  }

  followUp(id, message, images) {
    return this.#operation(id, (worker) =>
      this.#request(worker, { type: "follow_up", message, images }),
    );
  }

  setName(id, name) {
    return this.#operation(id, async (worker) => {
      await this.#request(worker, { type: "set_session_name", name });
      worker.state.sessionName = name;
      return this.#row(worker);
    });
  }

  listModels(id) {
    return this.#operation(id, async (worker) => {
      const data = await this.#request(worker, { type: "get_available_models" });
      return data.models ?? [];
    });
  }

  setModel(id, body) {
    return this.#operation(id, async (worker) => {
      const data = body.cycle
        ? await this.#request(worker, { type: "cycle_model" })
        : await this.#request(worker, {
            type: "set_model",
            provider: body.provider,
            modelId: body.id,
          });
      await this.#refreshState(worker);
      return { ...this.#row(worker), ...(body.cycle ? { cycled: data } : {}) };
    });
  }

  getThinking(id) {
    const worker = this.require(id);
    return {
      level: worker.state?.thinkingLevel,
      available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      supports: Boolean(worker.state?.model?.reasoning),
    };
  }

  setThinking(id, body) {
    return this.#operation(id, async (worker) => {
      await this.#request(
        worker,
        body.cycle
          ? { type: "cycle_thinking_level" }
          : { type: "set_thinking_level", level: body.level },
      );
      await this.#refreshState(worker);
      return this.getThinking(id);
    });
  }

  compact(id, instructions) {
    return this.#operation(id, async (worker) => {
      const result = await this.#request(worker, {
        type: "compact",
        customInstructions: instructions,
      });
      return { ok: true, result, ...this.#row(worker) };
    });
  }

  bash(id, command, options = {}) {
    return this.#operation(id, (worker) =>
      this.#request(worker, {
        type: "bash",
        command,
        excludeFromContext: Boolean(options.excludeFromContext),
      }),
    );
  }

  abortBash(id) {
    return this.#operation(id, (worker) =>
      this.#request(worker, { type: "abort_bash" }),
    );
  }

  getTree(id) {
    return this.#operation(id, (worker) => this.#request(worker, { type: "get_tree" }));
  }

  getForkCandidates(id) {
    return this.#operation(id, async (worker) => {
      const data = await this.#request(worker, { type: "get_fork_messages" });
      return { messages: data.messages ?? [] };
    });
  }

  getCommands(id) {
    return this.#operation(id, async (worker) => {
      const data = await this.#request(worker, { type: "get_commands" });
      return { commands: data.commands ?? [] };
    });
  }

  /** Stop and relinquish an idle browser owner. */
  async release(id) {
    const worker = this.require(id);
    if (!worker.running) {
      if (worker.lock) await releaseSessionLock(worker.lock);
      if (worker.lockRelease) await worker.lockRelease;
      this.workers.delete(worker.id);
      return { ok: true, path: worker.path };
    }
    worker.releasing = true;
    if (worker.activeOps > 0) {
      worker.releasing = false;
      const error = new Error("Wait for browser commands to finish before release");
      error.code = "SESSION_BUSY";
      throw error;
    }
    try {
      await this.#refreshState(worker);
    } catch (error) {
      if (worker.running) {
        worker.releasing = false;
        throw error;
      }
      await this.#stop(worker);
      this.workers.delete(worker.id);
      return { ok: true, path: worker.path };
    }
    if (busyState(worker.state, worker.bashRunning)) {
      worker.releasing = false;
      const error = new Error("Wait for the browser session to become idle before release");
      error.code = "SESSION_BUSY";
      throw error;
    }
    await this.#stop(worker);
    this.workers.delete(worker.id);
    return { ok: true, path: worker.path };
  }

  async closeAll() {
    this.closing = true;
    await Promise.allSettled([...this.workers.values()].map((worker) => this.#stop(worker)));
    this.workers.clear();
  }

  async #withPath(key, fn) {
    const previous = this.pathTails.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    this.pathTails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.pathTails.get(key) === next) this.pathTails.delete(key);
    }
  }

  #spawn(options) {
    const child = this.spawnProcess(
      process.execPath,
      [this.rpcEntry, "--session", options.path],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          ...this.env,
          PI_REMOTE_WEB_DISABLED: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const worker = {
      ...options,
      child,
      running: true,
      state: {},
      messages: [],
      streamingMessage: null,
      bashRunning: false,
      requests: new Map(),
      requestId: 0,
      listeners: new Set(),
      seq: 0,
      ring: [],
      stderr: "",
      stopping: null,
      lockRelease: null,
      releasing: false,
      activeOps: 0,
    };
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) this.#line(worker, line);
      }
    });
    child.stderr.on("data", (chunk) => {
      worker.stderr = (worker.stderr + chunk.toString()).slice(-16_384);
    });
    child.once("error", (error) => this.#exited(worker, error));
    child.once("exit", (code, signal) => {
      this.#exited(worker, new Error(`Pi RPC worker exited (${code ?? signal ?? "unknown"})`));
    });
    return worker;
  }

  #line(worker, line) {
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (frame.type === "response" && frame.id) {
      const pending = worker.requests.get(frame.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      worker.requests.delete(frame.id);
      if (frame.success) pending.resolve("data" in frame ? frame.data : {});
      else pending.reject(new Error(frame.error || `RPC ${frame.command} failed`));
      return;
    }
    this.#project(worker, frame);
    this.#emit(worker, frame);
  }

  #project(worker, event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "agent_start") worker.state.isStreaming = true;
    if (event.type === "agent_settled") {
      worker.state.isStreaming = false;
      void this.#refreshMessages(worker);
    }
    if (event.type === "message_start" || event.type === "message_update") {
      if (event.message?.role === "assistant") worker.streamingMessage = event.message;
    }
    if (event.type === "message_end") {
      worker.streamingMessage = null;
      void this.#refreshMessages(worker);
    }
    if (event.type === "bash_start") worker.bashRunning = true;
    if (event.type === "bash_end") worker.bashRunning = false;
    if (event.type === "model_select") worker.state.model = event.model;
    if (event.type === "thinking_level_select") worker.state.thinkingLevel = event.level;
    if (event.type === "session_info_changed") worker.state.sessionName = event.name;
  }

  #emit(worker, event) {
    const seq = ++worker.seq;
    worker.ring.push({ seq, event });
    if (worker.ring.length > RING_MAX) worker.ring.splice(0, worker.ring.length - RING_MAX);
    for (const listener of worker.listeners) {
      try {
        listener(event, seq);
      } catch {
        /* isolate browser stream listeners from the worker process */
      }
    }
  }

  async #operation(id, fn) {
    const worker = this.#running(id);
    worker.activeOps += 1;
    try {
      return await fn(worker);
    } finally {
      worker.activeOps -= 1;
    }
  }

  #request(worker, command) {
    if (!worker.running || !worker.child.stdin?.writable) {
      return Promise.reject(new Error(`Browser session is not running: ${worker.id}`));
    }
    const id = `rpc-${++worker.requestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        worker.requests.delete(id);
        reject(new Error(`Pi RPC command timed out: ${command.type}`));
      }, REQUEST_TIMEOUT_MS);
      worker.requests.set(id, { resolve, reject, timer });
      worker.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`, (error) => {
        if (!error) return;
        const pending = worker.requests.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        worker.requests.delete(id);
        reject(error);
      });
    });
  }

  #running(id) {
    const worker = this.require(id);
    if (!worker.running) throw new Error(`Browser session is not running: ${id}`);
    if (worker.releasing) throw new Error(`Browser session is releasing: ${id}`);
    return worker;
  }

  async #refreshState(worker) {
    worker.state = await this.#request(worker, { type: "get_state" });
  }

  async #refreshMessages(worker) {
    if (!worker.running) return;
    try {
      const data = await this.#request(worker, { type: "get_messages" });
      worker.messages = data.messages ?? [];
    } catch {
      /* worker exit path owns cleanup */
    }
  }

  #exited(worker, error) {
    if (!worker.running) return;
    worker.running = false;
    worker.state && (worker.state.isStreaming = false);
    for (const pending of worker.requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    worker.requests.clear();
    this.#emit(worker, { type: "worker_exit", error: error.message });
    const lock = worker.lock;
    worker.lock = null;
    if (lock) worker.lockRelease = releaseSessionLock(lock);
  }

  async #stop(worker) {
    if (worker.stopping) return worker.stopping;
    worker.stopping = new Promise((resolve) => {
      if (!worker.running || worker.child.exitCode !== null) return resolve();
      const kill = setTimeout(() => worker.child.kill("SIGTERM"), 2_000);
      const hardKill = setTimeout(() => worker.child.kill("SIGKILL"), 4_000);
      const done = () => {
        clearTimeout(kill);
        clearTimeout(hardKill);
        resolve();
      };
      worker.child.once("exit", done);
      worker.child.stdin.end();
    }).then(async () => {
      if (worker.lock) {
        await releaseSessionLock(worker.lock);
        worker.lock = null;
      }
      if (worker.lockRelease) await worker.lockRelease;
    });
    return worker.stopping;
  }

  #row(worker) {
    const state = worker.state ?? {};
    return {
      id: worker.id,
      path: worker.path,
      cwd: worker.cwd,
      running: worker.running,
      connected: worker.running,
      owner: worker.running ? "browser" : "offline",
      browserOwned: worker.running,
      releasing: worker.releasing,
      streaming: Boolean(state.isStreaming),
      isCompacting: Boolean(state.isCompacting),
      pendingMessageCount: state.pendingMessageCount ?? 0,
      messageCount: state.messageCount ?? worker.messages.length,
      name: state.sessionName,
      sessionName: state.sessionName,
      thinkingLevel: state.thinkingLevel,
      model: state.model,
      busy: busyState(state, worker.bashRunning),
    };
  }
}
