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
  turnPlacement,
  turnStartAtOrBefore,
  wholeTurnStart,
  uniqueMessageKeys,
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

describe("stable message keys", () => {
  it("keeps timestamped row keys stable while content grows or changes kind", () => {
    const at = 1234;
    const key = (content) => uniqueMessageKeys([{ role: "assistant", timestamp: at, content }])[0];
    const original = key([]);
    assert.equal(key([{ type: "text", text: "First chunk" }]), original);
    assert.equal(key([{ type: "text", text: "First chunk and more" }]), original);
    assert.equal(key([{ type: "toolCall", id: "t", name: "bash", arguments: { command: "npm test" } }]), original);
  });

  it("survive prepended history and never collide", () => {
    const a = { role: "assistant", timestamp: 5, content: [{ type: "text", text: "hi" }] };
    const u = { role: "user", timestamp: 4, content: "go" };
    const before = uniqueMessageKeys([u, a]);
    const after = uniqueMessageKeys([{ role: "user", timestamp: 1, content: "old" }, u, a]);
    assert.deepEqual(after.slice(1), before);
    const twins = uniqueMessageKeys([a, { ...a }]);
    assert.notEqual(twins[0], twins[1]);
  });
});

describe("whole-turn windowing", () => {
  // Absolute indexes 100..105: a cut-off turn tail, then two whole turns.
  const window = [
    { role: "assistant" }, { role: "toolResult" },
    { role: "user" }, { role: "assistant" },
    { role: "user" }, { role: "assistant" },
  ];
  it("starts at the first whole turn and snaps reveals to turn starts", () => {
    assert.equal(wholeTurnStart(window, 100, 100), 102);
    assert.equal(turnStartAtOrBefore(window, 100, 105), 104);
    assert.equal(turnStartAtOrBefore(window, 100, 103), 102);
    assert.equal(turnStartAtOrBefore(window, 100, 101), null); // needs an older page
    assert.equal(turnStartAtOrBefore(window, 100, 90), null);
  });
});

describe("subagent turns", () => {
  const wake = {
    role: "user",
    timestamp: 5,
    content: [{ type: "text", text: "Inspect subagent updates above. Answer pending supervisor requests within your authority." }],
  };
  const notice = (customType: string, display: boolean, timestamp: number) => ({
    role: "custom", customType, display, timestamp, content: `${customType} body`,
  });

  it("opens a turn with visible notices and folds the wake into it", () => {
    const messages = [
      { role: "user", timestamp: 1, content: "Run the workers" },
      { role: "assistant", timestamp: 2, stopReason: "stop", content: [{ type: "text", text: "Started." }] },
      notice("subagent-incremental-child-notify", false, 3),
      notice("subagent_supervisor_request", true, 4),
      wake,
      { role: "assistant", timestamp: 6, stopReason: "stop", content: [{ type: "text", text: "Answered." }] },
      notice("subagent-notify", false, 7),
      { ...wake, timestamp: 8 },
    ];
    const turns: number[][] = [];
    messages.forEach((message, i) => {
      const current = turns.at(-1)?.map((j) => messages[j]!) ?? null;
      const placement = turnPlacement(current, message);
      if (placement === "start") turns.push([i]);
      else if (placement === "append") turns.at(-1)!.push(i);
    });
    // Hidden notices are dropped; a wake with no visible notice still starts its own turn.
    assert.deepEqual(turns, [[0, 1], [3, 4, 5], [7]]);
  });
});
