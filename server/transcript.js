import { readFile } from "node:fs/promises";
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
 * @param {string} sessionPath
 * @param {string} [sessionsDir]
 */
export async function readTranscript(sessionPath, sessionsDir = path.join(getAgentDir(), "sessions")) {
  const resolved = path.resolve(String(sessionPath || ""));
  const root = path.resolve(sessionsDir) + path.sep;
  // Trust boundary: only Pi session files, never arbitrary paths.
  if (!resolved.startsWith(root) || !resolved.endsWith(".jsonl")) {
    const error = new Error("Not a Pi session file");
    // @ts-expect-error - transported to the browser
    error.status = 400;
    throw error;
  }
  const content = await readFile(resolved, "utf8").catch((error) => {
    if (error?.code === "ENOENT") error.status = 404;
    throw error;
  });
  const entries = parseSessionEntries(content);
  migrateSessionEntries(entries); // in memory only
  const body = entries.filter((entry) => entry.type !== "session");
  const leafId = body.at(-1)?.id ?? null;
  return { messages: buildSessionContext(body, leafId).messages };
}
