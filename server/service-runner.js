#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { mkdir, open, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { serviceExitCode } from "./service-runtime.js";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const stateDir = process.env.PI_REMOTE_WEB_SERVICE_DIR ?? path.join(getAgentDir(), "remote", "service");
const logsDir = path.join(stateDir, "logs");
await mkdir(logsDir, { recursive: true, mode: 0o700 });

function rotatingWriter(name) {
  const file = path.join(logsDir, name);
  let tail = Promise.resolve();
  return (chunk) => {
    tail = tail.then(async () => {
      const size = await stat(file).then((info) => info.size).catch(() => 0);
      if (size + chunk.length > MAX_LOG_BYTES) {
        await unlink(`${file}.1`).catch(() => {});
        await rename(file, `${file}.1`).catch(() => {});
      }
      const handle = await open(
        file,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const info = await handle.stat();
        if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.uid !== process.getuid?.()) {
          throw new Error(`Unsafe log file: ${file}`);
        }
        await handle.write(chunk);
      } finally {
        await handle.close();
      }
    }).catch(() => {});
  };
}

const cli = fileURLToPath(new URL("./cli.js", import.meta.url));
const child = spawn("/usr/bin/caffeinate", ["-s", process.execPath, cli, "daemon"], {
  stdio: ["ignore", "pipe", "pipe"],
  env: process.env,
});
child.stdout.on("data", rotatingWriter("stdout.log"));
child.stderr.on("data", rotatingWriter("stderr.log"));

let intentionalShutdown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    intentionalShutdown = true;
    child.kill(signal);
  });
}
child.on("error", (error) => {
  rotatingWriter("stderr.log")(Buffer.from(`${error.stack ?? error}\n`));
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.exitCode = serviceExitCode(intentionalShutdown, code, signal);
});
