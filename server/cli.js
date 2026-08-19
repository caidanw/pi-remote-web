#!/usr/bin/env node
/**
 * Persistent daemon: node server/cli.js [--port 3847]
 */
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createServer } from "./http.js";
import { RemoteBroker } from "./remote-broker.js";
import { RpcWorkerManager } from "./rpc-workers.js";
import { WorktreeManager } from "./worktrees.js";

const args = process.argv.slice(2);
let port = Number(process.env.PI_REMOTE_WEB_PORT || 3847);
const i = args.indexOf("--port");
if (i >= 0 && args[i + 1]) port = Number(args[i + 1]);

const socketPath =
  process.env.PI_REMOTE_WEB_SOCKET ??
  join(getAgentDir(), "remote", "pi-remote-web.sock");
const workers = new RpcWorkerManager();
const worktrees = new WorktreeManager();
const broker = new RemoteBroker({
  socketPath,
  requestTakeover: (sessionPath) => workers.takeover(sessionPath),
});
await broker.listen();
console.log(`[pi-remote-web] remote broker ${socketPath}`);

const app = createServer({ port, remoteBroker: broker, workers, worktrees });
app.listen();

// Last-resort log; static/API handlers must not throw uncaught (see http.js sendFile).
process.on("uncaughtException", (err) => {
  console.error("[pi-remote-web] uncaughtException", err?.message || err);
});
process.on("unhandledRejection", (err) => {
  console.error("[pi-remote-web] unhandledRejection", err);
});

async function close() {
  await Promise.allSettled([app.close(), broker.close()]);
}

process.on("SIGINT", async () => {
  await close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await close();
  process.exit(0);
});
