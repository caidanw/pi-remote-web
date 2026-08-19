import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  RemoteClient,
  requestBrowserTakeover,
} from "../remote/client.js";
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

function messages(ctx: ExtensionContext, streamingMessage?: unknown): unknown[] {
  const transcript = ctx.sessionManager
    .getBranch()
    .filter((entry) => entry.type === "message")
    .map((entry) => entry.message);
  return streamingMessage ? [...transcript, streamingMessage] : transcript;
}

function sessionState(pi: ExtensionAPI, ctx: ExtensionContext, nonce?: string) {
  return {
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
    thinkingLevel: pi.getThinkingLevel(),
    streaming: !ctx.isIdle(),
    ownershipNonce: nonce,
  };
}

function promptContent(message: string, images: unknown) {
  if (!Array.isArray(images) || images.length === 0) return message;
  const valid = images.filter(
    (image): image is { type: "image"; data: string; mimeType: string } =>
      isRecord(image) &&
      image.type === "image" &&
      typeof image.data === "string" &&
      typeof image.mimeType === "string",
  );
  return valid.length
    ? [...(message ? [{ type: "text" as const, text: message }] : []), ...valid]
    : message;
}

export default function remoteExtension(pi: ExtensionAPI): void {
  if (process.env.PI_REMOTE_WEB_DISABLED === "1") return;

  let client: RemoteClient | null = null;
  let currentContext: ExtensionContext | null = null;
  let currentLock: { lockDir: string; nonce: string } | null = null;
  let streamingMessage: unknown;

  function publish(event: unknown, snapshot = false): void {
    client?.publish(event);
    if (snapshot) client?.snapshot();
  }

  async function handleCommand(frame: Record<string, unknown>): Promise<unknown> {
    const ctx = currentContext;
    if (!ctx) throw new Error("Remote session is not active");
    const payload = isRecord(frame.payload) ? frame.payload : {};
    switch (frame.command) {
      case "prompt": {
        if (typeof payload.message !== "string") throw new Error("message required");
        const content = promptContent(payload.message, payload.images);
        if (!payload.message.trim() && typeof content === "string") {
          throw new Error("message required");
        }
        const deliverAs = payload.deliverAs === "followUp" ? "followUp" : "steer";
        pi.sendUserMessage(content, ctx.isIdle() ? undefined : { deliverAs });
        return { accepted: true };
      }
      case "steer":
      case "follow_up": {
        if (typeof payload.message !== "string") throw new Error("message required");
        const content = promptContent(payload.message, payload.images);
        if (!payload.message.trim() && typeof content === "string") {
          throw new Error("message required");
        }
        pi.sendUserMessage(content, {
          deliverAs: frame.command === "steer" ? "steer" : "followUp",
        });
        return { accepted: true };
      }
      case "abort":
        ctx.abort();
        return { accepted: true };
      case "compact":
        ctx.compact(
          typeof payload.instructions === "string"
            ? { customInstructions: payload.instructions }
            : undefined,
        );
        return { accepted: true };
      case "list_models": {
        const available = ctx.modelRegistry.getAvailable();
        const models = available.length ? available : ctx.modelRegistry.getAll();
        return {
          models: models.map((model) => ({
            provider: model.provider,
            id: model.id,
            name: model.name,
            reasoning: model.reasoning,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          })),
        };
      }
      case "set_model": {
        if (typeof payload.provider !== "string" || typeof payload.id !== "string") {
          throw new Error("provider and model id required");
        }
        const model = ctx.modelRegistry.find(payload.provider, payload.id);
        if (!model) throw new Error(`Model not found: ${payload.provider}/${payload.id}`);
        if (!(await pi.setModel(model))) throw new Error("Model authentication unavailable");
        return { accepted: true };
      }
      case "cycle_model": {
        const available = ctx.modelRegistry.getAvailable();
        const models = available.length ? available : ctx.modelRegistry.getAll();
        if (models.length < 2) return { accepted: true };
        const current = models.findIndex(
          (model) => model.provider === ctx.model?.provider && model.id === ctx.model?.id,
        );
        const step = payload.direction === "backward" ? -1 : 1;
        const next = models[(current + step + models.length) % models.length];
        if (!(await pi.setModel(next))) throw new Error("Model authentication unavailable");
        return { accepted: true };
      }
      case "get_thinking":
        return {
          level: pi.getThinkingLevel(),
          available: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
          supports: Boolean(ctx.model?.reasoning),
        };
      case "set_thinking": {
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
        const level = levels.find((candidate) => candidate === payload.level);
        if (!level) throw new Error("invalid thinking level");
        pi.setThinkingLevel(level);
        return { accepted: true };
      }
      case "cycle_thinking": {
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
        const current = levels.indexOf(pi.getThinkingLevel());
        pi.setThinkingLevel(levels[(current + 1) % levels.length]);
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
    streamingMessage = undefined;

    const sessionFile = ctx.sessionManager.getSessionFile();
    if (sessionFile) {
      let acquired = await acquireSessionLock({
        baseDir: lockDir(),
        sessionPath: sessionFile,
        ownerKind: "terminal",
        runtimeId,
      });
      if (!acquired.ok && acquired.owner?.ownerKind === "browser") {
        try {
          await requestBrowserTakeover({
            socketPath: socketPath(),
            runtimeId,
            sessionPath: sessionFile,
          });
          acquired = await acquireSessionLock({
            baseDir: lockDir(),
            sessionPath: sessionFile,
            ownerKind: "terminal",
            runtimeId,
          });
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      }
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
        session: sessionState(pi, ctx, currentLock?.nonce),
      }),
      getSnapshot: () => ({
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(),
        session: sessionState(pi, ctx, currentLock?.nonce),
        messages: messages(ctx, streamingMessage),
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
  pi.on("message_start", (event) => {
    if (event.message?.role === "assistant") streamingMessage = event.message;
    publish({ type: "message_start", ...event });
  });
  pi.on("message_update", (event) => {
    if (event.message?.role === "assistant") streamingMessage = event.message;
    publish({ type: "message_update", ...event });
  });
  pi.on("message_end", (event) => {
    publish({ type: "message_end", ...event });
    streamingMessage = undefined;
    // No snapshot here: a full transcript per message saturates the socket on
    // long sessions and starves the live event stream. The daemon applies deltas.
  });
  pi.on("tool_execution_start", (event) => publish({ type: "tool_execution_start", ...event }));
  pi.on("tool_execution_update", (event) => publish({ type: "tool_execution_update", ...event }));
  pi.on("tool_execution_end", (event) => publish({ type: "tool_execution_end", ...event }));
  pi.on("model_select", (event) => publish({ type: "model_select", ...event }));
  pi.on("thinking_level_select", (event) => publish({ type: "thinking_level_select", ...event }));
  pi.on("session_info_changed", (event) => publish({ type: "session_info_changed", ...event }));
  pi.on("session_compact", (event) => publish({ type: "session_compact", ...event }, true));
  pi.on("session_tree", (event) => publish({ type: "session_tree", ...event }, true));
}
