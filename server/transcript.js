import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  buildSessionContext,
  getAgentDir,
  migrateSessionEntries,
  parseSessionEntries,
} from "@earendil-works/pi-coding-agent";

/**
 * Read a session's messages straight from its JSONL file: no lock, no worker,
 * no writes. Used to show a read-only copy of a session another Pi process owns.
 * Pass the `version` from a previous read as `since` to get `{ unchanged: true }`
 * from a single stat instead of re-parsing a large file.
 * @param {string} sessionPath
 * @param {string} [sessionsDir]
 * @param {string} [since]
 */
export async function readTranscript(sessionPath, sessionsDir = path.join(getAgentDir(), "sessions"), since) {
  const resolved = path.resolve(String(sessionPath || ""));
  const root = path.resolve(sessionsDir) + path.sep;
  // Trust boundary: only Pi session files, never arbitrary paths.
  if (!resolved.startsWith(root) || !resolved.endsWith(".jsonl")) {
    const error = new Error("Not a Pi session file");
    // @ts-expect-error - transported to the browser
    error.status = 400;
    throw error;
  }
  const notFound = (error) => {
    if (error?.code === "ENOENT") error.status = 404;
    throw error;
  };
  const info = await stat(resolved).catch(notFound);
  const version = `${info.mtimeMs}:${info.size}`;
  if (since && since === version) return { unchanged: true, version, messages: [] };
  const content = await readFile(resolved, "utf8").catch(notFound);
  const entries = parseSessionEntries(content);
  migrateSessionEntries(entries); // in memory only
  const body = entries.filter((entry) => entry.type !== "session");
  const leafId = body.at(-1)?.id ?? null;
  return { unchanged: false, version, messages: buildSessionContext(body, leafId).messages };
}
