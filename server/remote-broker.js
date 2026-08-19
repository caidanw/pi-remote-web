import net from "node:net";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  REMOTE_PROTOCOL_VERSION,
  createFrameParser,
  encodeFrame,
  isRecord,
} from "../remote/protocol.js";

/** @typedef {{ socket: import("node:net").Socket; runtimeId: string | null }} Peer */

export class RemoteBroker {
  /** @param {{ socketPath: string }} options */
  constructor({ socketPath }) {
    this.socketPath = socketPath;
    this.server = null;
    /** @type {Map<string, { runtimeId: string; connected: boolean; registration?: Record<string, unknown>; snapshot?: Record<string, unknown>; lastEvent?: unknown; peer?: Peer; seq: number; ring: { seq: number, event: unknown }[]; listeners: Set<(event: unknown, seq: number) => void> }>} */
    this.sessions = new Map();
    /** @type {Set<() => void>} */
    this.listeners = new Set();
    /** @type {Set<import("node:net").Socket>} */
    this.sockets = new Set();
    /** @type {Map<string, { runtimeId: string; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>} */
    this.pendingCommands = new Map();
  }

  async listen() {
    if (this.server) return;
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
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    for (const pending of this.pendingCommands.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("remote broker stopped"));
    }
    this.pendingCommands.clear();
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
  getSession(runtimeId) {
    const session = this.sessions.get(runtimeId);
    if (!session) throw new Error(`Remote session not found: ${runtimeId}`);
    return this.#publicSession(session);
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
      this.#rejectCommands(peer.runtimeId, "Remote session disconnected");
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

    if (frame.type === "register") {
      const previous = this.sessions.get(frame.runtimeId);
      if (previous?.peer && previous.peer !== peer) previous.peer.socket.destroy();
      peer.runtimeId = frame.runtimeId;
      this.sessions.set(frame.runtimeId, {
        runtimeId: frame.runtimeId,
        connected: true,
        registration: frame,
        snapshot: previous?.snapshot,
        lastEvent: previous?.lastEvent,
        seq: previous?.seq ?? 0,
        ring: previous?.ring ?? [],
        listeners: previous?.listeners ?? new Set(),
        peer,
      });
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
    if (frame.type === "snapshot") session.snapshot = frame;
    if (frame.type === "event") {
      session.lastEvent = frame.event;
      session.seq += 1;
      session.ring.push({ seq: session.seq, event: frame.event });
      if (session.ring.length > 500) session.ring.splice(0, session.ring.length - 500);
      for (const listener of session.listeners) listener(frame.event, session.seq);
    }
    if (frame.type === "resync_required") session.snapshot = undefined;
    this.#notify();
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
