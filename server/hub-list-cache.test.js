import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { hub } from "./hub.js";

const realListAll = SessionManager.listAll;
const realNow = Date.now;
const realAgentDir = process.env.PI_CODING_AGENT_DIR;
afterEach(() => {
  SessionManager.listAll = realListAll;
  Date.now = realNow;
  if (realAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = realAgentDir;
});

describe("hub.listDisk cache", () => {
  it("throttles rescans and re-reads only session directories whose files changed", async () => {
    const agentDir = await mkdtemp(path.join(tmpdir(), "pi-remote-list-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const dirA = path.join(agentDir, "sessions", "--a--");
    const dirB = path.join(agentDir, "sessions", "--b--");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(path.join(dirA, "a.jsonl"), "a\n");
    await writeFile(path.join(dirB, "b.jsonl"), "b\n");

    let now = 1_000_000;
    Date.now = () => now;
    /** @type {string[]} */
    const listed = [];
    SessionManager.listAll = async (dir) => {
      listed.push(path.basename(String(dir)));
      const modified = new Date(listed.length);
      return [{ id: path.basename(String(dir)), path: `${dir}/x.jsonl`, modified, allMessagesText: "big" }];
    };
    try {
      const first = await hub.listDisk(undefined, { fresh: true });
      assert.deepEqual(listed.sort(), ["--a--", "--b--"]);
      assert.equal("allMessagesText" in first[0], false);

      // Within 10 s the last scan is served as is.
      await writeFile(path.join(dirB, "b.jsonl"), "b grew\n");
      await hub.listDisk();
      assert.equal(listed.length, 2);

      // A stale list is served at once and refreshed behind it: only --b-- changed.
      now += 11_000;
      await hub.listDisk();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.deepEqual(listed.slice(2), ["--b--"]);

      // Same size, different mtime still counts as a change.
      const later = new Date(realNow() + 60_000);
      await utimes(path.join(dirA, "a.jsonl"), later, later);
      const fresh = await hub.listDisk(undefined, { fresh: true });
      assert.deepEqual(listed.slice(3), ["--a--"]);
      assert.deepEqual(fresh.map((row) => row.id), ["--a--", "--b--"]); // newest first
    } finally {
      await rm(agentDir, { recursive: true, force: true });
    }
  });
});
