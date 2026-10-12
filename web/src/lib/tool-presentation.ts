import type { ChatMessage, ContentPart } from "./api.ts";
import { findToolResultForCall, getParts } from "./api.ts";
import { formatWorkDuration, messageTimestamp } from "./work-section.ts";

type JsonObject = Record<string, unknown>;

export type BuiltinToolPresentation = {
  title: string;
  path: string;
  meta?: string;
  args: string;
  argsLabel: string;
  argsKind?: "code" | "diff";
  result: string;
  resultLabel: string;
  resultKind: "code" | "diff";
  resultLang?: string;
};

export type BashOutputPresentation = {
  label: "diff" | "output";
  kind: "diff" | "code";
  lang: "diff" | "bash";
};

function object(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function stringArg(args: JsonObject, ...keys: string[]): string {
  for (const key of keys) {
    if (typeof args[key] === "string") return args[key];
  }
  return "";
}

function editPreview(args: JsonObject, path: string): string {
  const edits = Array.isArray(args.edits)
    ? args.edits
    : [{ oldText: args.oldText, newText: args.newText }];
  const chunks: string[] = [];

  for (const candidate of edits) {
    const edit = object(candidate);
    if (!edit || typeof edit.oldText !== "string" || typeof edit.newText !== "string") {
      continue;
    }
    if (chunks.length === 0) chunks.push(`--- ${path}`, `+++ ${path}`);
    chunks.push("@@");
    chunks.push(...edit.oldText.split("\n").map((line) => `-${line}`));
    chunks.push(...edit.newText.split("\n").map((line) => `+${line}`));
  }

  return chunks.join("\n");
}

function readTitle(path: string, args: JsonObject): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return `read ${path}`.trim();
  const start = offset ?? 1;
  const end = limit === undefined ? "" : `-${start + limit - 1}`;
  return `read ${path}:${start}${end}`.trim();
}

/** How long a finished tool took, from pi's `toolResult.durationMs`; "" when unknown. */
export function toolDuration(result: ChatMessage | undefined): string {
  const ms = result?.durationMs;
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${(ms / 1000).toFixed(1)}s` : formatWorkDuration(ms);
}

/** "+12 \u221213" for a diff (pi's `+ 12 text` lines or unified `+text`); "" when unchanged. */
export function diffCounts(diff: string): string {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;
    if (line.startsWith("+")) added += 1;
    else if (line.startsWith("-")) removed += 1;
  }
  return [added && `+${added}`, removed && `\u2212${removed}`].filter(Boolean).join(" ");
}

const join = (...bits: (string | undefined)[]) => bits.filter(Boolean).join(" \u00b7 ") || undefined;

/**
 * What the agent is doing right now, from the newest assistant message:
 * the title of an unfinished tool call, "Thinking", or "Writing"; "" between steps.
 */
export function liveActivity(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "user") return "";
    if (message.role !== "assistant") continue;
    const parts = getParts(message);
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j]!;
      if (part.type === "toolCall" || part.type === "tool_use") {
        const id = typeof part.id === "string" ? part.id : "";
        if (id && findToolResultForCall(messages, i, id)) return "";
        return (
          builtinToolPresentation(part, undefined, "")?.title ??
          genericToolTitle(part.name ?? "tool", part.arguments ?? part.input)
        );
      }
      if (part.type === "thinking" || part.type === "reasoning") return "Thinking";
      if (typeof part.text === "string" && part.text.trim()) return "Writing";
    }
    return "";
  }
  return "";
}

/** When an assistant message's tool calls began: once the model finished streaming it. */
export function toolStartedAt(assistant: ChatMessage): number | undefined {
  const start = messageTimestamp(assistant);
  const ms = assistant.durationMs;
  return start !== null && typeof ms === "number" && Number.isFinite(ms) ? start + ms : undefined;
}

const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;

/**
 * One-line title for tools without a dedicated renderer: readable name plus
 * the first few short argument values, e.g. "todo update 3 completed" or
 * "linear \u00b7 get_issue DEV-620". Opaque ids are skipped.
 */
export function genericToolTitle(name: string, args: unknown): string {
  const label = name.startsWith("mcp__") ? name.slice(5).split("__").join(" \u00b7 ") : name;
  const values: string[] = [];
  for (const value of Object.values(object(args) ?? {})) {
    if (values.length === 3) break;
    if (typeof value === "number" && Number.isFinite(value)) values.push(String(value));
    else if (typeof value === "string") {
      const text = value.replace(/\s+/g, " ").trim();
      if (text && !UUID_LIKE.test(text)) values.push(text.length > 60 ? `${text.slice(0, 60)}\u2026` : text);
    }
  }
  return [label, ...values].join(" ");
}

/** Inner tool calls made by codemode-style tools, e.g. "read ×2, bash". */
export function nestedCallSummary(result: ChatMessage | undefined): string {
  const calls = object(result?.nestedCalls)?.calls;
  if (!Array.isArray(calls)) return "";
  const counts = new Map<string, number>();
  for (const call of calls) {
    const name = object(call)?.name;
    if (typeof name === "string") counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts].map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(", ");
}

/** Keep standalone bash messages and tool-call bash results visually identical. */
export function bashOutputPresentation(command: string): BashOutputPresentation {
  const gitDiff = command.split(/&&|\|\||;|\n/).some((segment) => {
    const normalized = segment
      .trim()
      .replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*/, "");
    return /^(?:sudo\s+)?(?:\S*\/)?git(?:\s+(?:-C|-c|--git-dir|--work-tree)\s+\S+)*\s+diff(?:\s|$)/.test(
      normalized,
    );
  });
  return gitDiff
    ? { label: "diff", kind: "diff", lang: "diff" }
    : { label: "output", kind: "code", lang: "bash" };
}

/** Presentation for pi's built-in tools; null keeps the generic tool card. */
export function builtinToolPresentation(
  part: ContentPart,
  pairedResult: ChatMessage | undefined,
  resultText: string,
): BuiltinToolPresentation | null {
  const name = (part.name ?? "").toLowerCase();
  if (name !== "bash" && name !== "edit" && name !== "read" && name !== "write") {
    return null;
  }

  const args = object(part.arguments ?? part.input);
  if (!args) return null;

  if (name === "bash") {
    const command = stringArg(args, "command");
    if (!command) return null;
    const timeout = typeof args.timeout === "number" ? args.timeout : undefined;
    const output = bashOutputPresentation(command);
    return {
      title: `$ ${command}`,
      path: "",
      // Finished: how long it took. Running: the limit it may hit.
      meta: pairedResult
        ? toolDuration(pairedResult) || undefined
        : timeout === undefined ? undefined : `timeout ${timeout}s`,
      args: "",
      argsLabel: "args",
      result: resultText,
      resultLabel: output.label,
      resultKind: output.kind,
      resultLang: output.lang,
    };
  }

  const path = stringArg(args, "path", "file_path");
  if (!path) return null;

  if (name === "read") {
    return {
      title: readTitle(path, args),
      path,
      meta: join(toolDuration(pairedResult)),
      args: "",
      argsLabel: "args",
      result: resultText,
      resultLabel: "content",
      resultKind: "code",
    };
  }

  if (name === "write") {
    const content = stringArg(args, "content");
    return {
      title: `write ${path}`,
      path,
      meta: join(content ? `+${content.split("\n").length}` : undefined, toolDuration(pairedResult)),
      args: content,
      argsLabel: "content",
      argsKind: "code",
      result: resultText,
      resultLabel: "result",
      resultKind: "code",
    };
  }

  const details = object(pairedResult?.details);
  const completedDiff = details && typeof details.diff === "string" ? details.diff : "";
  const diff = completedDiff || (pairedResult?.isError ? "" : editPreview(args, path));
  return {
    title: `edit ${path}`,
    path,
    meta: join(diff ? diffCounts(diff) : undefined, toolDuration(pairedResult)),
    args: "",
    argsLabel: "args",
    result: diff || resultText,
    resultLabel: diff ? "diff" : "result",
    resultKind: diff ? "diff" : "code",
  };
}
