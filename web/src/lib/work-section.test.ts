import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  formatWorkDuration,
  groupExploration,
  hasAssistantText,
  hasAssistantWork,
  isComposerCommand,
  isReadOnlyCommand,
  isFinalAssistantResponse,
  messageTimestamp,
  startsTopLevelTurn,
  workSectionOpen,
} from "./work-section.ts";

describe("work section helpers", () => {
  it("separates tool work from a terminal assistant response", () => {
    const work = {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "thinking", thinking: "Inspecting" },
        { type: "toolCall", name: "read", id: "r1", arguments: { path: "a.ts" } },
      ],
    };
    const final = {
      role: "assistant",
      stopReason: "stop",
      content: [
        { type: "thinking", thinking: "Done" },
        { type: "text", text: "Implemented." },
      ],
    };
    assert.equal(hasAssistantWork(work), true);
    assert.equal(isFinalAssistantResponse(work), false);
    assert.equal(hasAssistantWork(final), true);
    assert.equal(hasAssistantText(final), true);
    assert.equal(isFinalAssistantResponse(final), true);
  });

  it("renders streaming answer text before the stop reason lands", () => {
    // Live terminal sessions deliver `pending` until the message ends.
    const streaming = {
      role: "assistant",
      stopReason: "pending",
      content: [{ type: "text", text: "Here is the ans" }],
    };
    const unknownStop = { role: "assistant", content: [{ type: "text", text: "Answer" }] };
    const streamingToolStep = {
      role: "assistant",
      stopReason: "pending",
      content: [{ type: "thinking", thinking: "planning" }],
    };
    assert.equal(isFinalAssistantResponse(streaming), true);
    assert.equal(isFinalAssistantResponse(unknownStop), true);
    assert.equal(isFinalAssistantResponse(streamingToolStep), false);
  });

  it("preserves a user's work-section toggle", () => {
    assert.equal(workSectionOpen(undefined, false), true);
    assert.equal(workSectionOpen(undefined, true), false);
    assert.equal(workSectionOpen(true, true), true);
    assert.equal(workSectionOpen(false, false), false);
  });

  it("formats stored timestamps and elapsed work time", () => {
    assert.equal(messageTimestamp({ role: "user", timestamp: "2026-07-18T10:00:00Z" }), Date.parse("2026-07-18T10:00:00Z"));
    assert.equal(formatWorkDuration(79_000), "1m 19s");
    assert.equal(formatWorkDuration(3_600_000), "1h");
  });

  it("keeps composer commands out of the preceding Worked section", () => {
    assert.equal(startsTopLevelTurn({ role: "user" }), true);
    assert.equal(startsTopLevelTurn({ role: "command" }), true);
    assert.equal(startsTopLevelTurn({ role: "bashExecution" }), true);
    assert.equal(isComposerCommand({ role: "command" }), true);
    assert.equal(isComposerCommand({ role: "bashExecution" }), true);
    assert.equal(isComposerCommand({ role: "user" }), false);
    assert.equal(startsTopLevelTurn({ role: "assistant" }), false);
    assert.equal(startsTopLevelTurn({ role: "toolResult" }), false);
  });
});

describe("exploration grouping", () => {
  const read = (id: string, path: string) => ({
    m: { role: "assistant", content: [{ type: "thinking", thinking: "look" }, { type: "toolCall", id, name: "read", arguments: { path } }] },
  });
  const result = (id: string, toolName = "read") => ({ m: { role: "toolResult", toolCallId: id, toolName } });
  const grep = (id: string) => ({ m: { role: "assistant", content: [{ type: "toolCall", id, name: "ffgrep", arguments: { pattern: "x" } }] } });
  const edit = { m: { role: "assistant", content: [{ type: "toolCall", id: "e", name: "edit", arguments: {} }] } };

  it("collapses 2+ read/search steps with their results, keeping other steps", () => {
    const entries = groupExploration([
      read("a", "x.ts"), result("a"), grep("b"), result("b", "ffgrep"), read("c", "x.ts"), result("c"),
      edit,
    ]);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].kind, "explore");
    assert.equal(entries[0].kind === "explore" && entries[0].label, "Explored 1 file, 1 search");
    assert.equal(entries[0].kind === "explore" && entries[0].items.length, 6);
    assert.equal(entries[1].kind, "item");
  });

  it("leaves a single exploration step and steps with answer text alone", () => {
    const speaking = { m: { role: "assistant", content: [{ type: "text", text: "Found it" }, { type: "toolCall", id: "d", name: "read", arguments: { path: "y" } }] } };
    const entries = groupExploration([read("a", "x.ts"), result("a"), speaking, read("e", "z.ts")]);
    assert.deepEqual(entries.map((entry) => entry.kind), ["item", "item", "item", "item"]);
  });
});

describe("read-only commands", () => {
  it("accepts looking-only shell commands and rejects writes", () => {
    for (const ok of ["rg -n foo src | awk -F: '{print $1}' | sort -u", "cd web && ls -la | head -5", "git diff --stat", "sed -n 1,20p a.ts", "grep x a 2>/dev/null", "rg -n 'func test|defer \\{' Tests | grep -B1 'Store()'"]) {
      assert.equal(isReadOnlyCommand(ok), true, ok);
    }
    for (const bad of ["npm test", "rg foo > out.txt", "sed -i '' s/a/b/ f", "find . -name x -delete", "ls && rm -rf x", "cat a >> b", "awk '{print > \"f\"}' a", "echo 'x' | sh", "echo $(rm -rf x)", "cat `rm x`"]) {
      assert.equal(isReadOnlyCommand(bad), false, bad);
    }
  });

  it("groups bash exploration and labels commands", () => {
    const bash = (id: string, command: string) => ({ m: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] } });
    const entries = groupExploration([bash("a", "rg foo"), { m: { role: "toolResult", toolCallId: "a", toolName: "bash" } }, bash("b", "git log -3")]);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind === "explore" && entries[0].label, "Explored 2 commands");
    assert.equal(groupExploration([bash("a", "rg foo"), bash("b", "npm test")]).length, 2);
  });
});
