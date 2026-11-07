#!/usr/bin/env node
/**
 * pi-remote-web CLI. `daemon` runs the server; no args prints help.
 */
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { createServer } from "./http.js";
import { hub } from "./hub.js";
import { RemoteBroker } from "./remote-broker.js";
import { RpcWorkerManager } from "./rpc-workers.js";
import { WorktreeManager } from "./worktrees.js";
import { AuthManager, authDisabledByEnv } from "./auth.js";
import { encodeQr, renderQr } from "./qr.js";
import { PushNotifier, turnNotification } from "./push.js";
import {
  controlService,
  detectPublicUrl,
  doctorService,
  installService,
  readServiceLogs,
  serviceConfig,
  serviceStatus,
  uninstallService,
} from "./service.js";

const args = process.argv.slice(2);
let port = Number(process.env.PI_REMOTE_WEB_PORT || 3847);
const i = args.indexOf("--port");
if (i >= 0 && args[i + 1]) port = Number(args[i + 1]);

const serviceCommand = args[0];
const COMMANDS = ["daemon", "pair", "revoke-all", "install", "uninstall", "start", "stop", "restart", "status", "doctor", "logs"];
const HELP = `Usage: pi-remote-web <command> [--port <port>]

Commands:
  daemon       run the server in the foreground (127.0.0.1:${port})
  pair         print a QR code + five-minute single-use pairing URL
  revoke-all   invalidate every paired browser

macOS service (LaunchAgent):
  install      install and start the background service
  uninstall    stop and remove the service
  start | stop | restart
  status       health, URLs, socket, and live-session counts
  doctor       check permissions, locks, launchd, and Tailscale
  logs         recent daemon logs

  help         show this help

Env: PI_REMOTE_WEB_PORT, PI_REMOTE_WEB_PUBLIC_URL, PI_REMOTE_WEB_INSECURE_NO_AUTH=1`;
if (!serviceCommand || ["help", "-h", "--help"].includes(serviceCommand)) {
  console.log(HELP);
  process.exit(0);
}
if (!COMMANDS.includes(serviceCommand)) {
  console.error(`Unknown command: ${serviceCommand}\n\n${HELP}`);
  process.exit(1);
}
// Tailscale Serve already knows the HTTPS hostname; only override it explicitly.
const publicUrl = process.env.PI_REMOTE_WEB_PUBLIC_URL ?? (await detectPublicUrl(port));
if (["install", "uninstall", "start", "stop", "restart", "status", "doctor", "logs"].includes(serviceCommand)) {
  if (serviceCommand === "install") {
    const config = await installService({ port, publicUrl });
    console.log(`[pi-remote-web] installed ${config.plistPath}`);
  } else if (serviceCommand === "uninstall") {
    const config = await uninstallService();
    console.log(`[pi-remote-web] uninstalled ${config.plistPath}`);
  } else if (["start", "stop", "restart"].includes(serviceCommand)) {
    await controlService(serviceCommand);
    console.log(`[pi-remote-web] ${serviceCommand} requested`);
  } else if (serviceCommand === "status") {
    console.log(JSON.stringify(await serviceStatus(), null, 2));
  } else if (serviceCommand === "doctor") {
    const report = await doctorService();
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
  } else {
    const logs = await readServiceLogs();
    process.stdout.write(`== stdout ==\n${logs.stdout}\n== stderr ==\n${logs.stderr}\n`);
    if (logs.launchd.trim()) process.stdout.write(`== launchd ==\n${logs.launchd}\n`);
  }
  process.exit();
}

const auth = await new AuthManager({ port, publicUrl }).init();

if (serviceCommand === "pair") {
  if (!auth.publicUrl) {
    throw new Error(
      `No Tailscale Serve route found for port ${port}. Run: tailscale serve --bg --https=443 http://127.0.0.1:${port}`,
    );
  }
  const token = await auth.issuePairingToken();
  const url = auth.pairingUrl(token);
  if (process.stdout.isTTY) {
    console.log(renderQr(encodeQr(url, { ecc: "L" }), 2, { ansi: true }));
  }
  console.log(url);
  process.exit(0);
}

if (serviceCommand === "revoke-all") {
  await auth.rotateSigningSecret();
  console.log("[pi-remote-web] revoked all browser sessions");
  process.exit(0);
}

const insecure = authDisabledByEnv(process.env);
if (insecure) {
  console.warn(
    `[pi-remote-web] WARNING: authentication disabled (PI_REMOTE_WEB_INSECURE_NO_AUTH=1); 127.0.0.1:${port} is unprotected`,
  );
}

const socketPath =
  process.env.PI_REMOTE_WEB_SOCKET ??
  join(getAgentDir(), "remote", "pi-remote-web.sock");
// Apple rejects VAPID subjects it can't reach; prefer the public HTTPS origin.
const push = await new PushNotifier({
  file: join(auth.configDir, "push.json"),
  subject: auth.publicUrl?.origin ?? "mailto:pi-remote-web@users.noreply.github.com",
}).init();
// A run only pi-subagents started (its wake message) isn't one you're waiting on.
const onTurnEnd = (turn) => {
  if (!turn.subagentWake) void push.send(turnNotification(turn));
};
const workers = new RpcWorkerManager({ onTurnEnd });
console.log(`[pi-remote-web] workers run ${workers.command.join(" ")}`);
const worktrees = new WorktreeManager();
const broker = new RemoteBroker({
  socketPath,
  requestTakeover: (sessionPath) => workers.takeover(sessionPath),
  onTurnEnd,
});
await broker.listen();
console.log(`[pi-remote-web] remote broker ${socketPath}`);

const app = createServer({
  port,
  remoteBroker: broker,
  workers,
  worktrees,
  push,
  auth: insecure ? false : auth,
});
app.listen();
// Warm the session list so the first page load doesn't wait for a full disk scan.
void hub.listDisk().catch(() => {});

const service = serviceConfig({ port, publicUrl });
let statusTimer;
async function writeStatus() {
  await mkdir(service.stateDir, { recursive: true, mode: 0o700 });
  const terminalSessions = broker.listSessions().filter((session) => session.connected).length;
  const browserSessions = workers.listSessions().filter((row) => row.running).length;
  const temporary = `${service.statusPath}.${randomBytes(8).toString("hex")}`;
  await writeFile(temporary, JSON.stringify({
    pid: process.pid,
    port,
    publicUrl: auth.publicUrl?.href ?? null,
    socketPath,
    terminalSessions,
    browserSessions,
    liveSessions: terminalSessions + browserSessions,
    updatedAt: new Date().toISOString(),
  }), { flag: "wx", mode: 0o600 });
  await rename(temporary, service.statusPath);
}
await writeStatus().catch(() => {});
statusTimer = setInterval(() => void writeStatus().catch(() => {}), 5_000);
statusTimer.unref?.();

// Fatal errors must exit nonzero so launchd KeepAlive can restart a broken daemon.
let exiting = false;
async function fatal(label, err) {
  console.error(`[pi-remote-web] ${label}`, err?.stack || err?.message || err);
  if (exiting) return;
  exiting = true;
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 5_000);
  await close().catch(() => {});
  process.exit(1);
}
process.on("uncaughtException", (err) => void fatal("uncaughtException", err));
process.on("unhandledRejection", (err) => void fatal("unhandledRejection", err));

async function close() {
  if (statusTimer) clearInterval(statusTimer);
  await Promise.allSettled([app.close(), broker.close()]);
  await rm(service.statusPath, { force: true }).catch(() => {});
}

process.on("SIGINT", async () => {
  await close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await close();
  process.exit(0);
});
