#!/usr/bin/env node
// npm run build && node scripts/check-ui-stability.mjs
// Requires agent-browser on PATH. No model calls, real sessions, or daemon restarts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";

const exec = promisify(execFile);
const temp = await mkdtemp(path.join(tmpdir(), "prw-ui-"));
process.env.PI_CODING_AGENT_DIR = temp;
process.env.PI_REMOTE_WEB_DISABLED = "1";
const { RemoteBroker } = await import("../server/remote-broker.js");
const { RemoteClient } = await import("../remote/client.js");
const { createServer } = await import("../server/http.js");
const name = `prw-ui-${process.pid}`;
const browser = (...args) => exec("agent-browser", ["--session", name, ...args], { timeout: 30_000 });
const counts = new Map();
const broker = new RemoteBroker({ socketPath: path.join(temp, "s.sock") });
const app = createServer({ port: 0, auth: false, remoteBroker: broker });
app.server.on("request", (req) => {
  const route = req.url.split("?")[0];
  counts.set(route, (counts.get(route) ?? 0) + 1);
});
let peer;
let socket;
const pending = new Map();
let commandId = 0;
let failed = false;

async function waitFor(check, label) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await sleep(50);
  }
  throw new Error(`Timed out: ${label}`);
}
function cdp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++commandId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ": " + r.result?.description);
  return r.result?.value;
}
function check(label, actual, predicate) {
  console.log(`${predicate(actual) ? "PASS" : "FAIL"} ${label}: ${JSON.stringify(actual)}`);
  if (!predicate(actual)) failed = true;
}

try {
  await broker.listen();
  const messages = [];
  const now = Date.now() - 60_000;
  for (let i = 0; i < 15; i++) {
    const t = now + i * 100;
    messages.push(
      { role: "user", timestamp: t, content: `Earlier question ${i}` },
      { role: "assistant", timestamp: t + 1, stopReason: "toolUse", content: [
        { type: "thinking", thinking: "**Checking the file**\n\nHidden reasoning for an earlier step." },
        { type: "toolCall", id: `call-${i}`, name: "read", arguments: { path: `src/file-${i}.ts` } },
      ] },
      { role: "toolResult", timestamp: t + 2, toolName: "read", toolCallId: `call-${i}`, content: [{ type: "text", text: "export const value = 42;\n".repeat(30) }] },
      { role: "assistant", timestamp: t + 3, stopReason: "stop", content: [{ type: "text", text: `Earlier answer ${i}.` }] },
    );
  }
  const session = { id: "ui-check", name: "UI stability fixture", path: path.join(temp, "fixture.jsonl"), cwd: temp };
  peer = new RemoteClient({
    socketPath: broker.socketPath, runtimeId: "ui-check", maxBackoffMs: 20,
    getRegistration: () => ({ session }), getSnapshot: () => ({ session, messages }),
    onCommand: () => ({ commands: [] }),
  });
  peer.start();
  await waitFor(() => broker.listSessions()[0]?.snapshot, "terminal registration");
  await new Promise((resolve) => app.listen(resolve));
  const url = `http://127.0.0.1:${app.server.address().port}/sessions/ui-check`;
  await browser("open", url);
  const { stdout } = await browser("get", "cdp-url");
  const browserUrl = stdout.trim().split("\n").at(-1);
  const origin = new URL(browserUrl).origin.replace(/^ws/, "http");
  const targets = await (await fetch(`${origin}/json/list`)).json();
  const target = targets.find((t) => t.url === url);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  socket.onmessage = ({ data }) => {
    const r = JSON.parse(data);
    const handler = pending.get(r.id);
    if (!handler) return;
    pending.delete(r.id);
    if (r.error) handler.reject(new Error(r.error.message));
    else handler.resolve(r.result);
  };
  await waitFor(() => evaluate('document.querySelectorAll(".message-turn").length >= 15'), "transcript");
  // Let language loading and cold-start requests finish before measurement.
  await sleep(1000);
  counts.clear();
  await evaluate(`(() => {
    window.__stable = document.querySelector('[data-anchor="user:${now}"]');
    window.__mutations = 0;
    const observer = new MutationObserver(records => window.__mutations += records.length);
    observer.observe(window.__stable.closest('.message-turn'), { childList: true, subtree: true, characterData: true });
  })()`);
  const publish = (event) => peer.publish(event);
  publish({ type: "message_end", message: { role: "user", timestamp: now + 2000, content: "Run a simulated turn" } });
  publish({ type: "agent_start" });
  const assistant = (content, stopReason = "pending") => ({ role: "assistant", timestamp: now + 2001, stopReason, content });
  publish({ type: "message_start", message: assistant([]) });
  await waitFor(() => evaluate(`Boolean(document.querySelector('[data-anchor="assistant:${now + 2001}"]'))`), "live row");
  await evaluate(`window.__live = document.querySelector('[data-anchor="assistant:${now + 2001}"]')`);
  let thinking = "**Planning**\n\n";
  for (let i = 0; i < 70; i++) {
    thinking += `Step ${i}. `;
    publish({ type: "message_update", message: assistant([{ type: "thinking", thinking }]) });
    await sleep(40);
  }
  const before = Object.fromEntries(counts);
  console.log("Measured requests:", JSON.stringify(before));
  check("session list fetches during 70 deltas", before["/api/sessions"] ?? 0, n => n <= 3);
  check("customization fetches with unchanged cwd", before["/api/customization"] ?? 0, n => n === 0);
  check("model requests after an empty result", before["/api/models"] ?? 0, n => n === 0);
  check("hidden thinking markdown DOM", await evaluate('document.querySelectorAll("details:not([open]) > div .md-root").length'), n => n === 0);
  check("hidden tool output DOM", await evaluate('document.querySelectorAll("details:not([open]) > div pre").length'), n => n === 0);
  check("live row survives streamed chunks", await evaluate(`window.__live === document.querySelector('[data-anchor="assistant:${now + 2001}"]')`), Boolean);
  check("historical message preserved", await evaluate(`window.__stable === document.querySelector('[data-anchor="user:${now}"]')`), Boolean);
  check("historical turn content mutations", await evaluate("window.__mutations"), n => n === 0);
  await evaluate(`(() => {
    const message = document.querySelector('[data-anchor="assistant:${now + 2001}"]');
    message.querySelector('details > summary').click();
  })()`);
  await waitFor(() => evaluate('document.body.innerText.includes("Step 69.")'), "reasoning expands on demand");
  publish({ type: "message_update", message: assistant([{ type: "thinking", thinking: thinking + "Reasoning continues." }]) });
  await waitFor(() => evaluate('document.body.innerText.includes("Reasoning continues.")'), "opened reasoning still streams");
  console.log("PASS opened reasoning updates live");

  const final = assistant([{ type: "text", text: "The simulated turn is complete." }], "stop");
  publish({ type: "message_end", message: final });
  publish({ type: "agent_end" });
  publish({ type: "agent_settled" });
  await waitFor(() => evaluate('document.body.innerText.includes("The simulated turn is complete.")'), "final answer");
  // Reading hidden content must still work on demand.
  await evaluate(`(() => {
    const work = [...document.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent.includes('Worked'));
    work.querySelector('summary').click();
  })()`);
  await evaluate(`(() => {
    const tool = [...document.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent.includes('read src/file-0.ts'));
    tool.querySelector('summary').click();
  })()`);
  await waitFor(() => evaluate('document.querySelectorAll("details[open] pre").length > 0'), "expanded tool output");
  console.log("PASS expanded tool output remains available");

  await evaluate('window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }))');
  await waitFor(() => evaluate('Boolean(document.querySelector(\'input[placeholder="Type a command or search"]\'))'), "command palette");
  await evaluate(`(() => {
    const input = document.querySelector('input[placeholder="Type a command or search"]');
    input.value = 'model'; input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  publish({ type: "session_info_changed", name: "Renamed fixture" });
  await waitFor(() => evaluate('document.body.textContent.includes("Renamed fixture")'), "session metadata update");
  check("palette search survives metadata refresh", await evaluate('document.querySelector(\'input[placeholder="Type a command or search"]\')?.value'), v => v === "model");
} finally {
  await browser("close").catch(() => {});
  if (socket) socket.close();
  peer?.stop();
  await app.close();
  await broker.close();
  await rm(temp, { recursive: true, force: true });
}
assert.equal(failed, false, "UI stability checks failed (see measurements above)");
