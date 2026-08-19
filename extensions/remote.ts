import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { RemoteClient } from "../remote/client.js";
import { isRecord } from "../remote/protocol.js";
import {
  acquireSessionLock,
  releaseSessionLock,
} from "../remote/session-lock.js";

const RUNTIME_ID_KEY = "__piRemoteWebRuntimeId";
const processState = globalThis as typeof globalThis & {
  [RUNTIME_ID_KEY]?: string;
};
const runtimeId = (processState[RUNTIME_ID_KEY] ??= `${process.pid}-${randomUUID()}`);

function socketPath(): string {
  return (
    process.env.PI_REMOTE_WEB_SOCKET ??
    join(getAgentDir(), "remote", "pi-remote-web.sock")
  );
}

function lockDir(): string {
  return (
    process.env.PI_REMOTE_WEB_LOCK_DIR ??
    join(getAgentDir(), "remote", "locks")
  );
}

function messages(ctx: ExtensionContext): unknown[] {
  return ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
}

export default function remoteExtension(pi: ExtensionAPI): void {
  if (process.env.PI_REMOTE_WEB_DISABLED === "1") return;

  let client: RemoteClient | null = null;
  let currentContext: ExtensionContext | null = null;
  let currentLock: { lockDir: string; nonce: string } | null = null;

  function publish(event: unknown): void {
    client?.publish(event);
  }

  async function handleCommand(frame: Record<string, unknown>): Promise<unknown> {
    const ctx = currentContext;
    if (!ctx) throw new Error("Remote session is not active");
    const payload = isRecord(frame.payload) ? frame.payload : {};
    switch (frame.command) {
      case "prompt": {
        if (typeof payload.message !== "string" || !payload.message.trim()) {
          throw new Error("message required");
        }
        const deliverAs = payload.deliverAs === "followUp" ? "followUp" : "steer";
        pi.sendUserMessage(
          payload.message,
          ctx.isIdle() ? undefined : { deliverAs },
        );
        return { accepted: true };
      }
      case "steer":
      case "follow_up": {
        if (typeof payload.message !== "string" || !payload.message.trim()) {
          throw new Error("message required");
        }
        pi.sendUserMessage(payload.message, {
          deliverAs: frame.command === "steer" ? "steer" : "followUp",
        });
        return { accepted: true };
      }
      case "abort":
        ctx.abort();
        return { accepted: true };
      case "set_model": {
        if (typeof payload.provider !== "string" || typeof payload.id !== "string") {
          throw new Error("provider and model id required");
        }
        const model = ctx.modelRegistry.find(payload.provider, payload.id);
        if (!model) throw new Error(`Model not found: ${payload.provider}/${payload.id}`);
        if (!(await pi.setModel(model))) throw new Error("Model authentication unavailable");
        return { accepted: true };
      }
      case "set_thinking": {
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
        const level = levels.find((candidate) => candidate === payload.level);
        if (!level) throw new Error("invalid thinking level");
        pi.setThinkingLevel(level);
        return { accepted: true };
      }
      case "rename":
        if (typeof payload.name !== "string") throw new Error("name required");
        pi.setSessionName(payload.name);
        return { accepted: true };
      default:
        throw new Error(`Unsupported remote command: ${String(frame.command)}`);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    client?.stop();
    if (currentLock) await releaseSessionLock(currentLock);
    currentLock = null;
    currentContext = ctx;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      const acquired = await acquireSessionLock({
        baseDir: lockDir(),
        sessionPath: sessionFile,
        ownerKind: "terminal",
        runtimeId,
      });
      if (!acquired.ok) {
        const owner = acquired.owner?.runtimeId ?? "another Pi process";
        ctx.ui.setStatus("pi-remote", "remote: ownership conflict");
        ctx.ui.notify(`Session is already owned by ${owner}`, "error");
        ctx.shutdown();
        return;
      }
      currentLock = acquired.lock;
    }

    client = new RemoteClient({
      socketPath: socketPath(),
      runtimeId,
      getRegistration: () => ({
        pid: process.pid,
        session: {
          id: ctx.sessionManager.getSessionId(),
          path: ctx.sessionManager.getSessionFile(),
          cwd: ctx.cwd,
          name: pi.getSessionName(),
          model: ctx.model
            ? {
                provider: ctx.model.provider,
                id: ctx.model.id,
                name: ctx.model.name,
              }
            : undefined,
          thinkingLevel: ctx.thinkingLevel,
          streaming: !ctx.isIdle(),
          ownershipNonce: currentLock?.nonce,
        },
      }),
      getSnapshot: () => ({
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(),
        messages: messages(ctx),
      }),
      onCommand: handleCommand,
      onState: (state) => {
        if (currentContext !== ctx) return;
        const text = state === "connected" ? "remote: connected" : "remote: waiting";
        ctx.ui.setStatus("pi-remote", text);
      },
    });
    client.start();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    client?.stop();
    client = null;
    currentContext = null;
    if (currentLock) await releaseSessionLock(currentLock);
    currentLock = null;
    ctx.ui.setStatus("pi-remote", undefined);
  });

  pi.on("agent_start", (event) => publish({ type: "agent_start", ...event }));
  pi.on("agent_end", (event) => publish({ type: "agent_end", ...event }));
  pi.on("agent_settled", (event) => publish({ type: "agent_settled", ...event }));
  pi.on("turn_start", (event) => publish({ type: "turn_start", ...event }));
  pi.on("turn_end", (event) => publish({ type: "turn_end", ...event }));
  pi.on("message_start", (event) => publish({ type: "message_start", ...event }));
  pi.on("message_update", (event) => publish({ type: "message_update", ...event }));
  pi.on("message_end", (event) => publish({ type: "message_end", ...event }));
  pi.on("tool_execution_start", (event) => publish({ type: "tool_execution_start", ...event }));
  pi.on("tool_execution_update", (event) => publish({ type: "tool_execution_update", ...event }));
  pi.on("tool_execution_end", (event) => publish({ type: "tool_execution_end", ...event }));
  pi.on("model_select", (event) => publish({ type: "model_select", ...event }));
  pi.on("thinking_level_select", (event) => publish({ type: "thinking_level_select", ...event }));
  pi.on("session_info_changed", (event) => publish({ type: "session_info_changed", ...event }));
  pi.on("session_compact", (event) => publish({ type: "session_compact", ...event }));
  pi.on("session_tree", (event) => publish({ type: "session_tree", ...event }));
}
