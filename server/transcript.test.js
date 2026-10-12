import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readTranscript } from "./transcript.js";

describe("readTranscript", () => {
  it("reads messages without touching the file and rejects non-session paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "prw-transcript-"));
    try {
      const sessions = path.join(root, "sessions");
      await mkdir(path.join(sessions, "--proj--"), { recursive: true });
      const file = path.join(sessions, "--proj--", "s.jsonl");
      const lines = [
        { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00Z", cwd: "/proj" },
        { type: "message", id: "a", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "hi", timestamp: 1 } },
        { type: "message", id: "b", parentId: "a", timestamp: "2026-01-01T00:00:02Z", message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: 2 } },
      ];
      const original = lines.map((line) => JSON.stringify(line)).join("\n") + "\n";
      await writeFile(file, original);

      const { messages, version } = await readTranscript(file, sessions);
      assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
      assert.equal(await readFile(file, "utf8"), original);

      // Same version: answered from a stat. New content: re-read.
      assert.equal((await readTranscript(file, sessions, version)).unchanged, true);
      await appendFile(file, `${JSON.stringify({ type: "message", id: "c", parentId: "b", timestamp: "2026-01-01T00:00:03Z", message: { role: "user", content: "more", timestamp: 3 } })}\n`);
      const next = await readTranscript(file, sessions, version);
      assert.equal(next.unchanged, false);
      assert.equal(next.messages.length, 3);

      await assert.rejects(readTranscript(path.join(root, "outside.jsonl"), sessions), /Not a Pi session file/);
      await assert.rejects(readTranscript(path.join(sessions, "--proj--", "s.txt"), sessions), /Not a Pi session file/);
      await assert.rejects(readTranscript(path.join(sessions, "missing.jsonl"), sessions), (error) => error.status === 404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
