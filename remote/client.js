import net from "node:net";
import {
  REMOTE_PROTOCOL_VERSION,
  createFrameParser,
  encodeFrame,
  isRecord,
} from "./protocol.js";

const DEFAULT_MAX_BACKOFF_MS = 10_000;
const DEFAULT_MAX_QUEUE_BYTES = 1024 * 1024;

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
      this.options.onState?.("connected");
      this.#send({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "register",
        runtimeId: this.options.runtimeId,
        ...this.options.getRegistration(),
      });
      this.#send({
        protocol: REMOTE_PROTOCOL_VERSION,
        type: "snapshot",
        runtimeId: this.options.runtimeId,
        ...this.options.getSnapshot(),
      });
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
    const encoded = encodeFrame(frame);
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
      if (this.resyncQueued) this.resyncQueued = false;
      this.blocked = !this.socket.write(encoded);
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
