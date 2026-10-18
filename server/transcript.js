import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  getAgentDir,
  migrateSessionEntries,
  parseSessionEntries,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

/**
 * Every message on the current branch, oldest first, with compaction and branch summaries
 * where they happened: Pi's scrollback, not the compacted context the model sees.
 * @param {any[]} entries session entries after the header; the last one is the leaf
 */
export function branchMessages(entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const branch = [];
  // Bounded: a malformed parent cycle must not hang the daemon.
  for (
    let entry = byId.get(entries.at(-1)?.id);
    entry && branch.length < entries.length;
    entry = byId.get(entry.parentId)
  ) branch.push(entry);
  return branch.reverse().flatMap(sessionEntryToContextMessages);
}

/** @param {string} file */
export async function readBranchMessages(file) {
  const entries = parseSessionEntries(await readFile(file, "utf8"));
  migrateSessionEntries(entries); // in memory only
  return branchMessages(entries.filter((entry) => entry.type !== "session"));
}

/**
 * The newest messages whose JSON fits in `maxChars` (a full history can be 80 MB).
 * @param {unknown[]} messages
 * @param {number} maxChars
 */
export function newestWithin(messages, maxChars) {
  let used = 0;
  let start = messages.length;
  while (start > 0) {
    used += JSON.stringify(messages[start - 1])?.length ?? 0;
    if (used > maxChars) break;
    start -= 1;
  }
  return start ? messages.slice(start) : messages;
}

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
  return { unchanged: false, version, messages: await readBranchMessages(resolved).catch(notFound) };
}
