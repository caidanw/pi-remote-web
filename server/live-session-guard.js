import { stat } from "node:fs/promises";

/**
 * A terminal Pi writing this session seconds ago is probably still live.
 * Kept short so a daemon restart followed by a normal resume is not flagged.
 */
export const RECENT_WRITE_MS = 30_000;

/**
 * Pi appends and closes its session file per write, so no file lock or open
 * handle exists to detect. Recent writes are the only cheap signal that a Pi
 * process is using a session that never registered with the daemon.
 *
 * @param {string} sessionPath
 * @param {{ now?: () => number; recentWriteMs?: number; stat?: typeof stat }} [options]
 * @returns {Promise<null | { modifiedAgoMs: number }>} null when no foreign writer is suspected
 */
export async function detectUnregisteredWriter(sessionPath, options = {}) {
  const now = options.now ?? Date.now;
  const recentWriteMs = options.recentWriteMs ?? RECENT_WRITE_MS;
  const statFile = options.stat ?? stat;
  if (recentWriteMs <= 0) return null; // explicitly disabled
  let info;
  try {
    info = await statFile(sessionPath);
  } catch {
    return null;
  }
  // Filesystem timestamps can round ahead of the clock; clamp so the result is deterministic.
  const modifiedAgoMs = Math.max(0, now() - info.mtimeMs);
  if (modifiedAgoMs > recentWriteMs) return null;
  return { modifiedAgoMs };
}

/**
 * @param {string} sessionPath
 * @param {{ force?: boolean } & Parameters<typeof detectUnregisteredWriter>[1]} [options]
 */
export async function assertNoUnregisteredWriter(sessionPath, options = {}) {
  if (options.force) return;
  const suspect = await detectUnregisteredWriter(sessionPath, options);
  if (!suspect) return;
  const seconds = Math.max(1, Math.round(suspect.modifiedAgoMs / 1000));
  const error = new Error(
    `This session was written ${seconds}s ago and may still be open in a terminal that is not ` +
      `connected to the daemon. Install the adapter with "pi install ~/Projects/pi-remote-web" and ` +
      `restart that Pi session, or open it anyway to take over the file.`,
  );
  // @ts-expect-error - transported to the browser as an actionable code
  error.code = "SESSION_MAYBE_LIVE";
  // @ts-expect-error
  error.status = 409;
  throw error;
}
