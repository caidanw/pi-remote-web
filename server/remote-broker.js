import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  REMOTE_PROTOCOL_VERSION,
  createFrameParser,
  encodeFrame,
  isRecord,
} from "../remote/protocol.js";

/** @typedef {{ socket: import("node:net").Socket; runtimeId: string | null }} Peer */

function sessionIdentity(frame) {
  const session = isRecord(frame?.session) ? frame.session : {};
  return String(session.path || session.id || "");
}

function snapshotKey(frame) {
  return createHash("sha256").update(JSON.stringify(frame)).digest("base64url");
}

const DEFAULT_RECONNECT_GRACE_MS = 30_000;

export class RemoteBroker {
  /** @param {{ socketPath: string; reconnectGraceMs?: number; requestTakeover?: (sessionPath: string) => Promise<unknown> }} options */
  constructor({
    socketPath,
    reconnectGraceMs = DEFAULT_RECONNECT_GRACE_MS,
    requestTakeover,
  }) {
    this.socketPath = socketPath;
    this.reconnectGraceMs = reconnectGraceMs;
    this.requestTakeover = requestTakeover;
    this.server = null;
    this.closing = false;
    /** @type {Map<string, { runtimeId: string; connected: boolean; registration?: Record<string, unknown>; snapshot?: Record<string, unknown>; lastEvent?: unknown; peer?: Peer; seq: number; ring: { seq: number, event: unknown }[]; listeners: Set<(event: unknown, seq: number) => void> }>} */
    this.sessions = new Map();
    /** @type {Set<() => void>} */
    this.listeners = new Set();
    /** @type {Set<import("node:net").Socket>} */
    this.sockets = new Set();
    /** @type {Map<string, { runtimeId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>} */
    this.pendingCommands = new Map();
    /** @type {Map<string, Promise<unknown>>} */
    this.commandTails = new Map();
  }

  async listen() {
    if (this.server) return;
    this.closing = false;
    await mkdir(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.socketPath), 0o700);
    await this.#removeStaleSocket();

    const server = net.createServer((socket) => this.#accept(socket));
    this.server = server;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve(undefined);
      });
    });
    await chmod(this.socketPath, 0o600);
  }

  async close() {
    const server = this.server;
    if (!server) return;
    this.closing = true;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const session of this.sessions.values()) {
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
    }
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("remote broker stopped"));
    }
    this.pendingCommands.clear();
    this.commandTails.clear();
    if (server) {
      await new Promise((resolve) => server.close(() => resolve(undefined)));
    }
    await unlink(this.socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }

  listSessions() {
    return [...this.sessions.values()].map((session) => this.#publicSession(session));
  }

  /** @param {string} runtimeId */
  hasSession(runtimeId) {
    return this.sessions.has(runtimeId);
  }

  /** @param {string} sessionPath */
  findByPath(sessionPath) {
    for (const session of this.sessions.values()) {
      if (session.registration?.session?.path === sessionPath) return session.runtimeId;
    }
    return null;
  }

  /** @param {string} runtimeId */
  getSession(runtimeId) {
    const session = this.sessions.get(runtimeId);
    if (!session) throw new Error(`Remote session not found: ${runtimeId}`);
    return this.#publicSession(session);
  }

  /** Existing browser SessionRow contract for a terminal-owned runtime. */
  getSessionRow(runtimeId) {
    const session = this.sessions.get(runtimeId);
    if (!session) throw new Error(`Remote session not found: ${runtimeId}`);
    const registered = isRecord(session.registration?.session)
      ? session.registration.session
      : {};
    const snap = isRecord(session.snapshot?.session) ? session.snapshot.session : {};
    const current = { ...registered, ...snap };
    const messages = Array.isArray(session.snapshot?.messages)
      ? session.snapshot.messages
      : [];
    return {
      id: runtimeId,
      runtimeId,
      remote: true,
      bound: true,
      running: session.connected,
      connected: session.connected,
      path: current.path,
      cwd: current.cwd,
      name: current.name,
      sessionName: current.name,
      streaming: Boolean(current.streaming),
      thinkingLevel: current.thinkingLevel,
      messageCount: messages.length,
      modified: session.updatedAt,
      model: current.model,
    };
  }

  /** @param {string} runtimeId */
  getMessages(runtimeId) {
    const session = this.sessions.get(runtimeId);
    if (!session) throw new Error(`Remote session not found: ${runtimeId}`);
    return Array.isArray(session.snapshot?.messages) ? session.snapshot.messages : [];
  }

  /** @param {string} runtimeId */
  ringInfo(runtimeId) {
    const session = this.sessions.get(runtimeId);
    if (!session) throw new Error(`Remote session not found: ${runtimeId}`);
    return {
      seq: session.seq,
      ringStart: session.ring[0]?.seq ?? (session.seq > 0 ? session.seq + 1 : 1),
    };
  }

  /** @param {string} runtimeId @param {number} after */
  eventsAfter(runtimeId, after) {
    const session = this.sessions.get(runtimeId);
    if (!session) throw new Error(`Remote session not found: ${runtimeId}`);
    return session.ring.filter((item) => item.seq > after);
  }

  /**
   * @param {string} runtimeId
   * @param {(event: unknown, seq: number) => void} listener
   */
  subscribeSession(runtimeId, listener) {
    const session = this.sessions.get(runtimeId);
    if (!session) throw new Error(`Remote session not found: ${runtimeId}`);
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  }

  /**
   * @param {string} runtimeId
   * @param {string} command
   * @param {unknown} [payload]
   * @param {number} [timeoutMs]
   */
  command(runtimeId, command, payload, timeoutMs = 10_000) {
    const previous = this.commandTails.get(runtimeId) ?? Promise.resolve();
    const result = previous.catch(() => {}).then(() =>
      this.#sendCommand(runtimeId, command, payload, timeoutMs),
    );
    this.commandTails.set(runtimeId, result);
    result.finally(() => {
      if (this.commandTails.get(runtimeId) === result) this.commandTails.delete(runtimeId);
    }).catch(() => {});
    return result;
  }

  #sendCommand(runtimeId, command, payload, timeoutMs) {
    const session = this.sessions.get(runtimeId);
    if (!session?.connected || !session.peer) {
      return Promise.reject(new Error(`Remote session is not connected: ${runtimeId}`));
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(requestId);
        reject(new Error(`Remote command timed out: ${command}`));
      }, timeoutMs);
      this.pendingCommands.set(requestId, { runtimeId, resolve, reject, timer });
      try {
        session.peer.socket.write(encodeFrame({
          protocol: REMOTE_PROTOCOL_VERSION,
          type: "command",
          runtimeId,
          requestId,
          command,
          payload,
        }));
      } catch (error) {
        clearTimeout(timer);
        this.pendingCommands.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** @param {() => void} listener */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  #notify() {
    for (const listener of this.listeners) listener();
  }

  /** @param {import("node:net").Socket} socket */
  #accept(socket) {
    this.sockets.add(socket);
    socket.setEncoding("utf8");
    /** @type {Peer} */
    const peer = { socket, runtimeId: null };
    const parser = createFrameParser({
      onFrame: (frame) => this.#handleFrame(peer, frame),
      onError: (error) => {
        socket.write(encodeFrame({
          protocol: REMOTE_PROTOCOL_VERSION,
          type: "error",
          error: error.message,
        }));
        socket.destroy();
      },
    });
    socket.on("data", (chunk) => parser.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      if (!peer.runtimeId) return;
      const session = this.sessions.get(peer.runtimeId);
      if (session?.peer !== peer) return;
      session.connected = false;
      delete session.peer;
      if (this.closing) return;
      this.#emit(session, { type: "remote_connection", connected: false });
      this.#rejectCommands(peer.runtimeId, "Remote session disconnected");
      if (session.disconnectTimer) clearTimeout(session.disconnectTimer);
      session.disconnectTimer = setTimeout(() => {
        if (this.sessions.get(peer.runtimeId) !== session || session.connected) return;
        this.sessions.delete(peer.runtimeId);
        this.commandTails.delete(peer.runtimeId);
        this.#notify();
      }, this.reconnectGraceMs);
      session.disconnectTimer.unref?.();
      this.#notify();
    });
  }

  /** @param {Peer} peer @param {unknown} frame */
  #handleFrame(peer, frame) {
    if (!isRecord(frame)) return;
    if (frame.protocol !== REMOTE_PROTOCOL_VERSION) {
      peer.socket.write(encodeFrame({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "error",
        error: `unsupported remote protocol: ${String(frame.protocol)}`,
      }));
      peer.socket.destroy();
      return;
    }
    if (typeof frame.runtimeId !== "string" || !frame.runtimeId) return;

    if (
      frame.type === "takeover_request" &&
      typeof frame.requestId === "string" &&
      typeof frame.sessionPath === "string"
    ) {
      Promise.resolve()
        .then(() => {
          if (!this.requestTakeover) throw new Error("Browser takeover unavailable");
          return this.requestTakeover(frame.sessionPath);
        })
        .then((result) => {
          peer.socket.write(encodeFrame({
            protocol: REMOTE_PROTOCOL_VERSION,
            type: "takeover_result",
            runtimeId: frame.runtimeId,
            requestId: frame.requestId,
            ok: true,
            result,
          }));
        })
        .catch((error) => {
          peer.socket.write(encodeFrame({
            protocol: REMOTE_PROTOCOL_VERSION,
            type: "takeover_result",
            runtimeId: frame.runtimeId,
            requestId: frame.requestId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
            code: error?.code,
          }));
        });
      return;
    }

    if (frame.type === "register") {
      const previous = this.sessions.get(frame.runtimeId);
      const reconnecting = Boolean(previous && !previous.connected);
      if (previous?.disconnectTimer) clearTimeout(previous.disconnectTimer);
      if (previous?.peer && previous.peer !== peer) previous.peer.socket.destroy();
      peer.runtimeId = frame.runtimeId;
      const replacement = previous &&
        sessionIdentity(previous.registration) &&
        sessionIdentity(previous.registration) !== sessionIdentity(frame);
      const next = {
        runtimeId: frame.runtimeId,
        connected: true,
        registration: frame,
        snapshot: replacement ? undefined : previous?.snapshot,
        lastEvent: previous?.lastEvent,
        seq: previous?.seq ?? 0,
        ring: previous?.ring ?? [],
        listeners: previous?.listeners ?? new Set(),
        peer,
        snapshotKey: replacement ? undefined : previous?.snapshotKey,
        updatedAt: new Date().toISOString(),
      };
      this.sessions.set(frame.runtimeId, next);
      if (replacement) {
        this.#emit(next, {
          type: "session_replaced",
          previousSession: previous.registration?.session,
          session: frame.session,
        });
      } else if (reconnecting) {
        this.#emit(next, { type: "remote_connection", connected: true });
      }
      peer.socket.write(encodeFrame({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "registered",
        runtimeId: frame.runtimeId,
      }));
      this.#notify();
      return;
    }

    const session = this.sessions.get(frame.runtimeId);
    if (!session || session.peer !== peer) return;
    if (frame.type === "command_result" && typeof frame.requestId === "string") {
      const pending = this.pendingCommands.get(frame.requestId);
      if (!pending || pending.runtimeId !== frame.runtimeId) return;
      clearTimeout(pending.timer);
      this.pendingCommands.delete(frame.requestId);
      if (frame.ok) pending.resolve(frame.result);
      else pending.reject(new Error(String(frame.error ?? "Remote command failed")));
      return;
    }
    if (frame.type === "snapshot") {
      const key = snapshotKey(frame);
      session.snapshot = frame;
      session.updatedAt = new Date().toISOString();
      if (key !== session.snapshotKey) {
        session.snapshotKey = key;
        this.#emit(session, {
          type: "snapshot_available",
          session: frame.session,
          truncated: Boolean(frame.truncated),
          droppedMessages: frame.droppedMessages,
        });
      }
    }
    if (frame.type === "event") {
      session.lastEvent = frame.event;
      session.updatedAt = new Date().toISOString();
      this.#projectEvent(session, frame.event);
      this.#emit(session, frame.event);
    }
    if (frame.type === "resync_required") {
      this.#emit(session, {
        type: "resync_required",
        reason: frame.reason,
      });
    }
    this.#notify();
  }

  #emit(session, event) {
    session.seq += 1;
    session.ring.push({ seq: session.seq, event });
    if (session.ring.length > 500) session.ring.splice(0, session.ring.length - 500);
    for (const listener of session.listeners) listener(event, session.seq);
  }

  #projectEvent(session, event) {
    if (!isRecord(event)) return;
    if (!isRecord(session.snapshot)) session.snapshot = { messages: [] };
    if (!isRecord(session.snapshot.session)) session.snapshot.session = {};
    const meta = session.snapshot.session;
    if (event.type === "agent_start") meta.streaming = true;
    if (event.type === "agent_settled") meta.streaming = false;
    if (event.type === "model_select" && isRecord(event.model)) {
      meta.model = {
        provider: event.model.provider,
        id: event.model.id,
        name: event.model.name,
      };
    }
    if (event.type === "thinking_level_select") meta.thinkingLevel = event.level;
    if (event.type === "session_info_changed") meta.name = event.name;
  }

  #publicSession(session) {
    return {
      runtimeId: session.runtimeId,
      connected: session.connected,
      registration: session.registration,
      snapshot: session.snapshot,
      lastEvent: session.lastEvent,
      seq: session.seq,
    };
  }

  /** @param {string} runtimeId @param {string} message */
  #rejectCommands(runtimeId, message) {
    for (const [requestId, pending] of this.pendingCommands) {
      if (pending.runtimeId !== runtimeId) continue;
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
      this.pendingCommands.delete(requestId);
    }
  }

  async #removeStaleSocket() {
    const active = await new Promise((resolve) => {
      const probe = net.createConnection(this.socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
    });
    if (active) throw new Error(`remote broker already listening at ${this.socketPath}`);
    await unlink(this.socketPath).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}
