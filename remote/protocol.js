export const REMOTE_PROTOCOL_VERSION = 1;
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** @param {unknown} frame */
export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * Parse newline-delimited JSON without letting an unbounded peer fill memory.
 * @param {{ onFrame: (frame: unknown) => void; onError: (error: Error) => void; maxFrameBytes?: number }} options
 */
export function createFrameParser({
  onFrame,
  onError,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
}) {
  let buffer = "";

  return {
    /** @param {Buffer | string} chunk */
    push(chunk) {
      buffer += chunk.toString();
      if (Buffer.byteLength(buffer) > maxFrameBytes && !buffer.includes("\n")) {
        buffer = "";
        onError(new Error("remote frame exceeds size limit"));
        return;
      }

      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (Buffer.byteLength(line) > maxFrameBytes) {
          onError(new Error("remote frame exceeds size limit"));
          continue;
        }
        try {
          onFrame(JSON.parse(line));
        } catch (error) {
          onError(new Error("invalid remote frame", { cause: error }));
        }
      }
    },
  };
}

/** @param {unknown} value */
export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
