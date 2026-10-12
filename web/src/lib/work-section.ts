import type { ChatMessage, ContentPart } from "./api.ts";
import { getParts, messageKey } from "./api.ts";

export function isComposerCommand(message: ChatMessage): boolean {
  return (
    message.role === "command" ||
    message.role === "bashExecution"
  );
}

/** Messages initiated directly from the composer must not join prior agent work. */
export function startsTopLevelTurn(message: ChatMessage): boolean {
  return message.role === "user" || isComposerCommand(message);
}

export function messageTimestamp(message: ChatMessage | undefined): number | null {
  const value = message?.timestamp;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string" || !value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function hasAssistantText(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  return getParts(message).some(
    (part) =>
      part.type !== "thinking" &&
      part.type !== "reasoning" &&
      part.type !== "toolCall" &&
      part.type !== "tool_use" &&
      typeof part.text === "string" &&
      Boolean(part.text.trim()),
  );
}

export function hasAssistantWork(message: ChatMessage): boolean {
  if (message.role !== "assistant") return false;
  if (typeof message.thinking === "string" && message.thinking.trim()) return true;
  return getParts(message).some(
    (part) =>
      part.type === "thinking" ||
      part.type === "reasoning" ||
      part.type === "toolCall" ||
      part.type === "tool_use",
  );
}

/**
 * A terminal model response, as opposed to an assistant tool-use step.
 * A still-streaming message has no terminal stop reason yet, but its text is
 * the answer being written, so it must render instead of hiding inside work.
 */
export function isFinalAssistantResponse(message: ChatMessage): boolean {
  if (!hasAssistantText(message)) return false;
  const stopReason = message.stopReason;
  return (
    stopReason === "stop" ||
    stopReason === "length" ||
    stopReason === "pending" ||
    stopReason == null
  );
}

export function workSectionOpen(preference: boolean | undefined, completed: boolean): boolean {
  return preference ?? !completed;
}

export function formatWorkDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

/** Read-only exploration tools; runs of these collapse into one "Explored …" row. */
const EXPLORE_TOOLS = new Set(["read", "grep", "ffgrep", "fffind", "find", "ls", "glob"]);
const READ_ONLY_COMMAND =
  /^(cat|head|tail|rg|grep|ls|find|wc|tree|pwd|stat|file|which|awk|sort|uniq|cut|tr|jq|nl|diff|du|column|echo|printf|basename|dirname|realpath|date|sed\s+-n|git\s+(status|log|diff|show|grep|ls-files|blame))\b/;

/**
 * Shell commands that only look: every segment starts with a read-only
 * program and nothing writes via redirection or find -delete/-exec.
 */
export function isReadOnlyCommand(command: string): boolean {
  // Checked on the raw text: a quoted `>` (awk print > file) must reject too.
  // Substitutions ($(...), backticks, <(...)) can run anything, so they reject as well.
  if (/(^|[^0-9&])>|\$\(|`|<\(/.test(command) || /\s-(delete|exec)\b/.test(command)) return false;
  return shellSegments(command)
    .map((segment) => segment.trim())
    .every((segment) => !segment || /^cd(\s|$)/.test(segment) || READ_ONLY_COMMAND.test(segment));
}

/** Split on | ; && || and newlines outside quotes, so `rg 'a|b'` stays one segment. */
function shellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (quote) {
      if (char === "\\" && quote === '"') current += char + (command[++i] ?? "");
      else {
        if (char === quote) quote = "";
        current += char;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
      current += char;
    } else if (char === "\\") {
      current += char + (command[++i] ?? "");
    } else if (char === "|" || char === ";" || char === "\n" || (char === "&" && command[i + 1] === "&")) {
      segments.push(current);
      current = "";
      if ((char === "|" || char === "&") && command[i + 1] === char) i++;
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

function isToolCall(part: ContentPart): boolean {
  return part.type === "toolCall" || part.type === "tool_use";
}

function exploresOnly(call: ContentPart): boolean {
  const name = (call.name ?? "").toLowerCase();
  if (EXPLORE_TOOLS.has(name)) return true;
  const command = ((call.arguments ?? call.input ?? {}) as Record<string, unknown>).command;
  return name === "bash" && typeof command === "string" && isReadOnlyCommand(command);
}

/** Tool calls of an assistant step that only explores (thinking allowed, no answer text). */
function explorationCalls(message: ChatMessage): ContentPart[] | null {
  if (message.role !== "assistant") return null;
  const parts = getParts(message);
  const calls = parts.filter(isToolCall);
  const speaks = parts.some(
    (part) =>
      !isToolCall(part) &&
      part.type !== "thinking" &&
      part.type !== "reasoning" &&
      typeof part.text === "string" &&
      Boolean(part.text.trim()),
  );
  if (!calls.length || speaks) return null;
  return calls.every(exploresOnly) ? calls : null;
}

function explorationLabel(calls: ContentPart[]): string {
  const files = new Set<string>();
  let searches = 0;
  let commands = 0;
  for (const call of calls) {
    const name = (call.name ?? "").toLowerCase();
    const args = (call.arguments ?? call.input ?? {}) as Record<string, unknown>;
    const path = args.path ?? args.file_path;
    if (name === "read" && typeof path === "string") files.add(path);
    else if (name === "bash") commands += 1;
    else searches += 1;
  }
  const count = (n: number, word: string, plural = `${word}s`) => n && `${n} ${n === 1 ? word : plural}`;
  const bits = [count(files.size, "file"), count(searches, "search", "searches"), count(commands, "command")];
  return `Explored ${bits.filter(Boolean).join(", ")}`;
}

export type WorkEntry<T> =
  | { kind: "item"; item: T }
  | { kind: "explore"; items: T[]; label: string };

/** Collapse runs of 2+ exploration steps (with their tool results) into one entry. */
export function groupExploration<T extends { m: ChatMessage }>(items: T[]): WorkEntry<T>[] {
  const out: WorkEntry<T>[] = [];
  let run: T[] = [];
  let calls: ContentPart[] = [];
  const flush = () => {
    const steps = run.filter((item) => item.m.role === "assistant").length;
    if (steps >= 2) out.push({ kind: "explore", items: run, label: explorationLabel(calls) });
    else for (const item of run) out.push({ kind: "item", item });
    run = [];
    calls = [];
  };
  for (const item of items) {
    const stepCalls = explorationCalls(item.m);
    if (stepCalls) {
      run.push(item);
      calls.push(...stepCalls);
    } else if (run.length && item.m.role === "toolResult") {
      // Results follow their own calls, so inside a run they belong to it.
      run.push(item);
    } else {
      flush();
      out.push({ kind: "item", item });
    }
  }
  flush();
  return out;
}

/**
 * One key per message, stable when older history is prepended, and unique so
 * keyed {#each} blocks never collide (rare same-timestamp twins get a suffix).
 */
export function uniqueMessageKeys(messages: ChatMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((message, index) => {
    const key = messageKey(message, index);
    const count = seen.get(key) ?? 0;
    seen.set(key, count + 1);
    return count ? `${key}~${count}` : key;
  });
}

/*
 * History windowing works in absolute transcript indexes (`pageStart` is the
 * absolute index of messages[0]). Only whole turns are shown: a turn cut off by
 * the window would regroup, and shift on screen, as its older half loads.
 */

/** First turn start at or after `fromAbs`; `fromAbs` when the window holds none. */
export function wholeTurnStart(messages: ChatMessage[], pageStart: number, fromAbs: number): number {
  for (let i = Math.max(0, fromAbs - pageStart); i < messages.length; i++) {
    if (startsTopLevelTurn(messages[i]!)) return pageStart + i;
  }
  return fromAbs;
}

/** Last turn start at or before `targetAbs` within the loaded window, or null. */
export function turnStartAtOrBefore(messages: ChatMessage[], pageStart: number, targetAbs: number): number | null {
  for (let i = Math.min(messages.length - 1, targetAbs - pageStart); i >= 0; i--) {
    if (startsTopLevelTurn(messages[i]!)) return pageStart + i;
  }
  return null;
}
