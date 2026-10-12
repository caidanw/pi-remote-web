import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  bashOutputPresentation,
  builtinToolPresentation,
  diffCounts,
  genericToolTitle,
  liveActivity,
  nestedCallSummary,
  toolDuration,
  toolStartedAt,
} from "./tool-presentation.ts";

describe("diff counts and live activity", () => {
  it("counts pi and unified diff lines, ignoring file headers", () => {
    assert.equal(diffCounts("  22 \n- 23 old\n+ 23 new\n+ 24 more"), "+2 \u22121");
    assert.equal(diffCounts("--- a.ts\n+++ a.ts\n@@\n+x"), "+1");
    assert.equal(diffCounts(""), "");
  });

  it("shows edit counts with duration, and write line counts", () => {
    const edit = builtinToolPresentation(
      { type: "toolCall", name: "edit", arguments: { path: "a.ts", oldText: "a", newText: "b\nc" } },
      { role: "toolResult", durationMs: 200, details: { diff: "- 1 a\n+ 1 b\n+ 2 c" } },
      "",
    );
    assert.equal(edit?.meta, "+2 \u22121 \u00b7 0.2s");
    const write = builtinToolPresentation(
      { type: "toolCall", name: "write", arguments: { path: "b.ts", content: "1\n2\n3" } },
      undefined,
      "",
    );
    assert.equal(write?.meta, "+3");
  });

  it("names the step in progress", () => {
    const call = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "npm test" } };
    const user = { role: "user", content: "go" };
    assert.equal(liveActivity([user, { role: "assistant", content: [call] }]), "$ npm test");
    assert.equal(
      liveActivity([user, { role: "assistant", content: [call] }, { role: "toolResult", toolCallId: "t1" }]),
      "",
    );
    assert.equal(liveActivity([user, { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] }]), "Thinking");
    assert.equal(liveActivity([user, { role: "assistant", content: [{ type: "text", text: "Here" }] }]), "Writing");
    assert.equal(liveActivity([user]), "");
  });
});

describe("tool timing and nested calls", () => {
  it("formats durations and summarizes codemode inner calls", () => {
    assert.equal(toolDuration({ role: "toolResult", durationMs: 340 }), "0.3s");
    assert.equal(toolDuration({ role: "toolResult" }), "");
    const result = {
      role: "toolResult",
      nestedCalls: { calls: [{ name: "read" }, { name: "bash" }, { name: "read" }] },
    };
    assert.equal(nestedCallSummary(result), "read \u00d72, bash");
    assert.equal(nestedCallSummary({ role: "toolResult" }), "");
    assert.equal(toolStartedAt({ role: "assistant", timestamp: 1_000, durationMs: 250 }), 1_250);
    assert.equal(toolStartedAt({ role: "assistant", timestamp: 1_000 }), undefined);
  });

  it("titles generic tools from short argument values, skipping opaque ids", () => {
    assert.equal(
      genericToolTitle("todo", { action: "update", id: 3, status: "completed" }),
      "todo update 3 completed",
    );
    assert.equal(genericToolTitle("mcp__linear__get_issue", { id: "DEV-620" }), "linear \u00b7 get_issue DEV-620");
    assert.equal(
      genericToolTitle("act_ui", { stateId: "fef3a211-9893-46df-85db-9c332fe26559", ok: true }),
      "act_ui",
    );
    assert.equal(genericToolTitle("x", { q: "a".repeat(70) }), `x ${"a".repeat(60)}\u2026`);
  });
});

describe("builtinToolPresentation", () => {
  it("shows bash's timeout while running and its duration once done", () => {
    const call = {
      type: "toolCall",
      name: "bash",
      arguments: { command: "npm test", timeout: 120 },
    };
    assert.equal(builtinToolPresentation(call, undefined, "")?.meta, "timeout 120s");
    assert.equal(
      builtinToolPresentation(call, { role: "toolResult" }, "")?.meta,
      undefined,
    );
    const view = builtinToolPresentation(
      call,
      { role: "toolResult", durationMs: 83_000 },
      "42 tests passed",
    );
    assert.equal(view?.title, "$ npm test");
    assert.equal(view?.meta, "1m 23s");
    assert.equal(view?.args, "");
    assert.equal(view?.resultLabel, "output");
    assert.equal(view?.result, "42 tests passed");
    assert.equal(view?.resultLang, "bash");
  });

  it("renders git diff bash output like an edit diff", () => {
    const view = builtinToolPresentation(
      {
        type: "toolCall",
        name: "bash",
        arguments: { command: "git diff --cached" },
      },
      { role: "toolResult" },
      "diff --git a/a.ts b/a.ts\n-old\n+new",
    );
    assert.equal(view?.resultLabel, "diff");
    assert.equal(view?.resultKind, "diff");
    assert.equal(view?.resultLang, "diff");
  });

  it("recognizes git diff with cwd and shell prefixes", () => {
    assert.deepEqual(bashOutputPresentation("FOO=1 git -C repo diff -- src"), {
      label: "diff",
      kind: "diff",
      lang: "diff",
    });
    assert.equal(bashOutputPresentation("npm test").lang, "bash");
  });

  it("turns edit arguments into a readable diff preview", () => {
    const view = builtinToolPresentation(
      {
        type: "toolCall",
        name: "edit",
        arguments: {
          path: "src/app.ts",
          edits: [{ oldText: "const old = 1;", newText: "const next = 2;" }],
        },
      },
      undefined,
      "",
    );
    assert.equal(view?.title, "edit src/app.ts");
    assert.match(view?.result ?? "", /-const old = 1;/);
    assert.match(view?.result ?? "", /\+const next = 2;/);
    assert.equal(view?.resultKind, "diff");
  });

  it("prefers the completed edit diff from result details", () => {
    const view = builtinToolPresentation(
      {
        type: "toolCall",
        name: "edit",
        arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
      },
      { role: "toolResult", details: { diff: "-actual\n+result" } },
      "Applied",
    );
    assert.equal(view?.result, "-actual\n+result");
  });

  it("shows an edit error instead of the proposed preview", () => {
    const view = builtinToolPresentation(
      {
        type: "toolCall",
        name: "edit",
        arguments: { path: "a.ts", edits: [{ oldText: "a", newText: "b" }] },
      },
      { role: "toolResult", isError: true },
      "Old text was not found",
    );
    assert.equal(view?.result, "Old text was not found");
    assert.equal(view?.resultKind, "code");
  });

  it("formats read ranges and keeps file content out of JSON args", () => {
    const view = builtinToolPresentation(
      {
        type: "toolCall",
        name: "read",
        arguments: { path: "src/app.ts", offset: 10, limit: 5 },
      },
      { role: "toolResult" },
      "export const app = true;",
    );
    assert.equal(view?.title, "read src/app.ts:10-14");
    assert.equal(view?.args, "");
    assert.equal(view?.resultKind, "code");
  });

  it("shows write content as highlighted content instead of JSON", () => {
    const view = builtinToolPresentation(
      {
        type: "toolCall",
        name: "write",
        arguments: { path: "src/new.ts", content: "export const value = 1;" },
      },
      { role: "toolResult" },
      "Wrote 23 bytes",
    );
    assert.equal(view?.title, "write src/new.ts");
    assert.equal(view?.argsLabel, "content");
    assert.equal(view?.args, "export const value = 1;");
    assert.equal(view?.argsKind, "code");
    assert.equal(view?.result, "Wrote 23 bytes");
  });
});
