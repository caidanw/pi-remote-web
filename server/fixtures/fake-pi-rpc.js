#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";

const sessionIndex = process.argv.indexOf("--session");
const sessionFile = process.argv[sessionIndex + 1];
const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0]);
let streaming = false;
let messages = [];
let buffer = "";

function send(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function state() {
  return {
    sessionId: header.id,
    sessionFile,
    sessionName: "Fixture session",
    isStreaming: streaming,
    isCompacting: false,
    pendingMessageCount: 0,
    messageCount: messages.length,
    thinkingLevel: "medium",
    model: { provider: "fixture", id: "fixture-model", name: "Fixture" },
  };
}

function response(command, data = {}) {
  send({ type: "response", id: command.id, command: command.type, success: true, data });
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      response(command, state());
      break;
    case "get_messages":
      response(command, { messages });
      break;
    case "prompt": {
      const message = { role: "user", content: command.message };
      messages.push(message);
      appendFileSync(sessionFile, `${JSON.stringify({ type: "message", id: `m-${messages.length}`, parentId: null, timestamp: new Date().toISOString(), message })}\n`);
      streaming = command.message === "stay busy";
      response(command);
      send({ type: "message_end", message });
      send({ type: "agent_start" });
      if (!streaming) send({ type: "agent_settled" });
      break;
    }
    case "abort":
      streaming = false;
      response(command);
      send({ type: "agent_settled" });
      break;
    case "get_available_models":
      response(command, { models: [state().model] });
      break;
    case "set_session_name":
    case "set_model":
    case "set_thinking_level":
    case "steer":
    case "follow_up":
    case "compact":
    case "bash":
    case "abort_bash":
      response(command);
      break;
    case "cycle_model":
      response(command, null);
      break;
    case "cycle_thinking_level":
      response(command, { level: "high" });
      break;
    case "get_tree":
      response(command, { tree: [], leafId: null });
      break;
    case "get_fork_messages":
      response(command, { messages: [] });
      break;
    case "get_commands":
      response(command, { commands: [] });
      break;
    default:
      send({ type: "response", id: command.id, command: command.type, success: false, error: "unsupported" });
  }
}

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
