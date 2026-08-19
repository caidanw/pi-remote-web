import net from "node:net";
import {
  DEFAULT_MAX_FRAME_BYTES,
  REMOTE_PROTOCOL_VERSION,
  createFrameParser,
  encodeFrame,
  isRecord,
} from "./protocol.js";

const DEFAULT_MAX_BACKOFF_MS = 10_000;
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;

/** Ask the daemon to release an idle browser worker before terminal lock retry. */
export function requestBrowserTakeover({
  socketPath,
  runtimeId,
  sessionPath,
  timeoutMs = 20_000,
}) {
  const requestId = `${runtimeId}-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let settled = false;
    const done = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(
      () => done(new Error("Browser takeover timed out")),
      timeoutMs,
    );
    const parser = createFrameParser({
      onFrame: (frame) => {
        if (
          !isRecord(frame) ||
          frame.type !== "takeover_result" ||
          frame.requestId !== requestId
        ) return;
        if (!frame.ok) {
          const error = new Error(String(frame.error ?? "Browser takeover failed"));
          error.code = frame.code;
          done(error);
          return;
        }
        if (isRecord(frame.result) && frame.result.ok === false) {
          const error = new Error("Browser owner was not found");
          error.code = frame.result.code;
          done(error);
          return;
        }
        done(null, frame.result);
      },
      onError: done,
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => parser.push(chunk));
    socket.once("error", done);
    socket.once("close", () => {
      if (!settled) done(new Error("Browser takeover connection closed"));
    });
    socket.once("connect", () => {
      socket.write(encodeFrame({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "takeover_request",
        runtimeId,
        requestId,
        sessionPath,
      }));
    });
  });
}

/**
 * Reconnecting adapter transport. Missing daemon is a normal state.
 */
export class RemoteClient {
  /**
   * @param {{
   *   socketPath: string;
   *   runtimeId: string;
   *   getRegistration: () => Record<string, unknown>;
   *   getSnapshot: () => Record<string, unknown>;
   *   onCommand?: (frame: Record<string, unknown>) => unknown | Promise<unknown>;
   *   onState?: (state: "connecting" | "connected" | "disconnected") => void;
   *   maxBackoffMs?: number;
   *   maxQueueBytes?: number;
   *   maxFrameBytes?: number;
   *   random?: () => number;
   * }} options
   */
  constructor(options) {
    this.options = options;
    this.socket = null;
    this.retryTimer = null;
    this.retryMs = 250;
    this.stopped = true;
    this.blocked = false;
    this.queue = [];
    this.queueBytes = 0;
    this.resyncQueued = false;
    this.lastSnapshot = "";
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.#connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.blocked = false;
    this.queue = [];
    this.queueBytes = 0;
    this.resyncQueued = false;
    this.lastSnapshot = "";
    this.socket?.destroy();
    this.socket = null;
  }

  /** @param {unknown} event */
  publish(event) {
    if (!this.socket || this.socket.destroyed) return;
    this.#send({
      protocol: REMOTE_PROTOCOL_VERSION,
      type: "event",
      runtimeId: this.options.runtimeId,
      event,
    });
  }

  /** Send one deduplicated authoritative transcript/metadata replacement. */
  snapshot() {
    if (!this.socket || this.socket.destroyed) return;
    const max = this.options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
    const frame = {
      protocol: REMOTE_PROTOCOL_VERSION,
      type: "snapshot",
      runtimeId: this.options.runtimeId,
      ...this.options.getSnapshot(),
    };
    let encoded = encodeFrame(frame);
    const oversize = Buffer.byteLength(encoded) > max;
    if (oversize) {
      const messages = Array.isArray(frame.messages) ? frame.messages : [];
      let low = 0;
      let high = messages.length;
      while (low < high) {
        const mid = Math.floor((low + high) / 2);
        const candidate = encodeFrame({
          ...frame,
          messages: messages.slice(mid),
          truncated: true,
          droppedMessages: mid,
        });
        if (Buffer.byteLength(candidate) <= max) high = mid;
        else low = mid + 1;
      }
      encoded = encodeFrame({
        ...frame,
        messages: messages.slice(low),
        truncated: true,
        droppedMessages: low,
      });
      if (Buffer.byteLength(encoded) > max) return;
    }
    if (encoded === this.lastSnapshot) return;
    this.lastSnapshot = encoded;
    if (oversize) {
      this.#send({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "resync_required",
        runtimeId: this.options.runtimeId,
        reason: "snapshot_too_large",
      });
    }
    this.#sendEncoded(encoded);
  }

  #connect() {
    if (this.stopped) return;
    this.options.onState?.("connecting");
    const socket = net.createConnection(this.options.socketPath);
    this.socket = socket;
    socket.setEncoding("utf8");

    const parser = createFrameParser({
      onFrame: (frame) => void this.#handleFrame(frame),
      onError: () => socket.destroy(),
    });
    socket.on("data", (chunk) => parser.push(chunk));
    socket.on("connect", () => {
      this.retryMs = 250;
      this.blocked = false;
      this.lastSnapshot = "";
      this.options.onState?.("connected");
      this.#send({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "register",
        runtimeId: this.options.runtimeId,
        ...this.options.getRegistration(),
      });
      this.snapshot();
    });
    socket.on("drain", () => {
      this.blocked = false;
      this.#flush();
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket === socket) this.socket = null;
      this.blocked = false;
      this.queue = [];
      this.queueBytes = 0;
      this.resyncQueued = false;
      if (!this.stopped) {
        this.options.onState?.("disconnected");
        this.#scheduleReconnect();
      }
    });
  }

  #scheduleReconnect() {
    if (this.retryTimer || this.stopped) return;
    const max = this.options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    const random = this.options.random ?? Math.random;
    const jitter = 0.8 + random() * 0.4;
    const delay = Math.round(Math.min(this.retryMs, max) * jitter);
    this.retryMs = Math.min(this.retryMs * 2, max);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.#connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  /** @param {unknown} frame */
  #send(frame) {
    this.#sendEncoded(encodeFrame(frame));
  }

  /** @param {string} encoded */
  #sendEncoded(encoded) {
    if (this.blocked) {
      this.#enqueue(encoded);
      return;
    }
    if (!this.socket || this.socket.destroyed) return;
    this.blocked = !this.socket.write(encoded);
  }

  /** @param {string} encoded */
  #enqueue(encoded) {
    const max = this.options.maxQueueBytes ?? DEFAULT_MAX_QUEUE_BYTES;
    const bytes = Buffer.byteLength(encoded);
    if (this.resyncQueued) return;
    if (this.queueBytes + bytes > max) {
      const resync = encodeFrame({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "resync_required",
        runtimeId: this.options.runtimeId,
      });
      this.queue = [resync];
      this.queueBytes = Buffer.byteLength(resync);
      this.resyncQueued = true;
      return;
    }
    this.queue.push(encoded);
    this.queueBytes += bytes;
  }

  #flush() {
    if (!this.socket || this.socket.destroyed) return;
    while (!this.blocked && this.queue.length > 0) {
      const encoded = this.queue.shift();
      if (!encoded) continue;
      this.queueBytes -= Buffer.byteLength(encoded);
      const resync = this.resyncQueued;
      if (resync) this.resyncQueued = false;
      this.blocked = !this.socket.write(encoded);
      if (resync) {
        this.lastSnapshot = "";
        this.snapshot();
      }
    }
  }

  /** @param {unknown} frame */
  async #handleFrame(frame) {
    if (!isRecord(frame) || frame.protocol !== REMOTE_PROTOCOL_VERSION) return;
    if (frame.type !== "command" || typeof frame.requestId !== "string") return;
    try {
      const result = await this.options.onCommand?.(frame);
      this.#send({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "command_result",
        runtimeId: this.options.runtimeId,
        requestId: frame.requestId,
        ok: true,
        result,
      });
    } catch (error) {
      this.#send({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "command_result",
        runtimeId: this.options.runtimeId,
        requestId: frame.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
