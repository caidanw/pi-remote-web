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
import { AuthManager } from "./auth.js";

const args = process.argv.slice(2);
let port = Number(process.env.PI_REMOTE_WEB_PORT || 3847);
const i = args.indexOf("--port");
if (i >= 0 && args[i + 1]) port = Number(args[i + 1]);

const auth = await new AuthManager({
  port,
  publicUrl: process.env.PI_REMOTE_WEB_PUBLIC_URL,
}).init();

if (args[0] === "pair") {
  if (!auth.publicUrl) throw new Error("Set PI_REMOTE_WEB_PUBLIC_URL to the HTTPS Tailscale Serve URL before pairing");
  const token = await auth.issuePairingToken();
  console.log(auth.pairingUrl(token));
  process.exit(0);
}

if (args[0] === "revoke-all") {
  await auth.rotateSigningSecret();
  console.log("[pi-remote-web] revoked all browser sessions");
  process.exit(0);
}

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

const app = createServer({
  port,
  remoteBroker: broker,
  workers,
  worktrees,
  auth: process.env.PI_REMOTE_WEB_DEV === "1" ? false : auth,
});
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
