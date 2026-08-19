import { execFile as execFileCallback } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const execFile = promisify(execFileCallback);
export const SERVICE_LABEL = "com.caidanw.pi-remote-web";
const BOOT_ID = Math.round((Date.now() - os.uptime() * 1000) / 60_000);

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function envXml(environment) {
  const entries = Object.entries(environment).filter(([, value]) => value != null && value !== "");
  if (entries.length === 0) return "";
  return `\n  <key>EnvironmentVariables</key>\n  <dict>\n${entries
    .map(([key, value]) => `    <key>${xml(key)}</key>\n    <string>${xml(value)}</string>`)
    .join("\n")}\n  </dict>`;
}

export function serviceConfig(options = {}) {
  const home = path.resolve(options.home ?? os.homedir());
  const uid = options.uid ?? process.getuid?.();
  if (!Number.isInteger(uid)) throw new Error("A numeric user id is required");
  const stateDir = path.resolve(
    options.stateDir ??
      process.env.PI_REMOTE_WEB_SERVICE_DIR ??
      path.join(getAgentDir(), "remote", "service"),
  );
  const logsDir = path.join(stateDir, "logs");
  return {
    home,
    uid,
    domain: `gui/${uid}`,
    nodePath: path.resolve(options.nodePath ?? process.execPath),
    runnerPath: path.resolve(
      options.runnerPath ?? fileURLToPath(new URL("./service-runner.js", import.meta.url)),
    ),
    plistPath: path.resolve(
      options.plistPath ?? path.join(home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`),
    ),
    stateDir,
    logsDir,
    statusPath: path.join(stateDir, "status.json"),
    stdoutPath: path.join(logsDir, "stdout.log"),
    stderrPath: path.join(logsDir, "stderr.log"),
    environment: {
      PI_REMOTE_WEB_PORT: String(options.port ?? process.env.PI_REMOTE_WEB_PORT ?? 3847),
      PI_REMOTE_WEB_PUBLIC_URL: options.publicUrl ?? process.env.PI_REMOTE_WEB_PUBLIC_URL,
      PI_REMOTE_WEB_SOCKET: options.socketPath ?? process.env.PI_REMOTE_WEB_SOCKET,
      PI_REMOTE_WEB_SERVICE_DIR: stateDir,
    },
  };
}

export function launchAgentPlist(config) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(config.nodePath)}</string>
    <string>${xml(config.runnerPath)}</string>
  </array>${envXml(config.environment)}
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>/dev/null</string>
  <key>StandardErrorPath</key>
  <string>/dev/null</string>
</dict>
</plist>
`;
}

async function secureDirectory(directory, uid, mode, create = true) {
  if (create) await mkdir(directory, { recursive: true, mode: mode ?? 0o755 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
    throw new Error(`Unsafe service directory: ${directory}`);
  }
  if (mode != null) await chmod(directory, mode);
}

async function secureLogFile(file, uid) {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid) {
      throw new Error(`Unsafe service log: ${file}`);
    }
    await chmod(file, 0o600);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await writeFile(file, "", { flag: "wx", mode: 0o600 });
  }
}

async function defaultRun(file, args) {
  return execFile(file, args, {
    encoding: "utf8",
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
  });
}

// launchctl reports a not-loaded service as EIO/"Boot-out failed: 5", not a distinct code.
async function ignoreMissing(fn) {
  try {
    return await fn();
  } catch (error) {
    const stderr = String(error?.stderr ?? error?.message ?? "");
    if (
      error?.code === "ENOENT" ||
      /Could not find service|No such process|service not found|Boot-out failed|Input\/output error/i.test(stderr)
    ) {
      return null;
    }
    throw error;
  }
}

export async function installService(options = {}) {
  const config = serviceConfig(options);
  const run = options.run ?? defaultRun;
  await secureDirectory(path.dirname(config.plistPath), config.uid, null);
  await secureDirectory(config.stateDir, config.uid, 0o700);
  await secureDirectory(config.logsDir, config.uid, 0o700);
  const temporary = `${config.plistPath}.tmp-${process.pid}`;
  await rm(temporary, { force: true });
  await writeFile(temporary, launchAgentPlist(config), { flag: "wx", mode: 0o600 });
  await chmod(temporary, 0o600);
  await secureLogFile(config.stdoutPath, config.uid);
  await secureLogFile(config.stderrPath, config.uid);
  await rename(temporary, config.plistPath);
  await ignoreMissing(() => run("/bin/launchctl", ["bootout", config.domain, config.plistPath]));
  await run("/bin/launchctl", ["bootstrap", config.domain, config.plistPath]);
  await run("/bin/launchctl", ["kickstart", "-k", `${config.domain}/${SERVICE_LABEL}`]);
  return config;
}

export async function uninstallService(options = {}) {
  const config = serviceConfig(options);
  const run = options.run ?? defaultRun;
  await ignoreMissing(() => run("/bin/launchctl", ["bootout", config.domain, config.plistPath]));
  await rm(config.plistPath, { force: true });
  return config;
}

export async function controlService(command, options = {}) {
  const config = serviceConfig(options);
  const run = options.run ?? defaultRun;
  const target = `${config.domain}/${SERVICE_LABEL}`;
  if (command === "start" || command === "restart") {
    await run("/bin/launchctl", ["kickstart", ...(command === "restart" ? ["-k"] : []), target]);
  } else if (command === "stop") {
    await ignoreMissing(() => run("/bin/launchctl", ["kill", "SIGTERM", target]));
  } else {
    throw new Error(`Unsupported service command: ${command}`);
  }
}

async function fileCheck(file, expectedMode, options = {}) {
  try {
    const info = await lstat(file);
    const expectedType = options.type ?? "file";
    const typeOk = expectedType === "directory" ? info.isDirectory() : info.isFile();
    const ownerOk = options.uid == null || info.uid === options.uid;
    return {
      path: file,
      ok:
        typeOk &&
        ownerOk &&
        !info.isSymbolicLink() &&
        (expectedMode == null || (info.mode & 0o777) === expectedMode),
      mode: (info.mode & 0o777).toString(8),
      uid: info.uid,
      symlink: info.isSymbolicLink(),
      type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
    };
  } catch (error) {
    return { path: file, ok: false, missing: error?.code === "ENOENT", error: error?.message };
  }
}

async function fetchHealth(port, fetchImpl = fetch) {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function readRuntimeStatus(config, now = Date.now) {
  try {
    const info = await lstat(config.statusPath);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.uid !== config.uid ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 64 * 1024
    ) return null;
    const runtime = JSON.parse(await readFile(config.statusPath, "utf8"));
    const updated = Date.parse(runtime.updatedAt);
    if (!Number.isFinite(updated) || now() - updated > 15_000 || updated > now() + 1_000) return null;
    return runtime;
  } catch {
    return null;
  }
}

export async function serviceStatus(options = {}) {
  const config = serviceConfig(options);
  const run = options.run ?? defaultRun;
  let loaded = false;
  try {
    await run("/bin/launchctl", ["print", `${config.domain}/${SERVICE_LABEL}`]);
    loaded = true;
  } catch {}
  const runtime = await readRuntimeStatus(config, options.now);
  const port = Number(runtime?.port ?? config.environment.PI_REMOTE_WEB_PORT);
  const healthy = await fetchHealth(port, options.fetch);
  return {
    installed: (await fileCheck(config.plistPath, 0o600, { uid: config.uid })).ok,
    loaded,
    healthy,
    stale: !runtime,
    localUrl: `http://127.0.0.1:${port}`,
    publicUrl: runtime?.publicUrl ?? config.environment.PI_REMOTE_WEB_PUBLIC_URL ?? null,
    ...(healthy && runtime ? runtime : { liveSessions: null, terminalSessions: null, browserSessions: null }),
  };
}

async function commandExists(file, run) {
  try {
    if (path.isAbsolute(file)) await access(file, constants.X_OK);
    else await run(file, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

async function staleLocks(baseDir) {
  let stale = 0;
  try {
    for (const name of await readdir(baseDir)) {
      try {
        const owner = JSON.parse(await readFile(path.join(baseDir, name, "owner.json"), "utf8"));
        if (!Number.isInteger(owner.pid)) continue;
        if (owner.bootId !== BOOT_ID) {
          stale += 1;
          continue;
        }
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if (error?.code === "ESRCH") stale += 1;
        }
      } catch {}
    }
  } catch {}
  return stale;
}

export async function doctorService(options = {}) {
  const config = serviceConfig(options);
  const run = options.run ?? defaultRun;
  const authDir = path.resolve(options.authDir ?? path.join(getAgentDir(), "remote", "auth"));
  let loaded = false;
  try {
    await run("/bin/launchctl", ["print", `${config.domain}/${SERVICE_LABEL}`]);
    loaded = true;
  } catch {}
  const tailscale = await commandExists(
    options.tailscalePath ?? "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    run,
  );
  // Remote access is configured when either this shell or the running daemon has a public URL.
  const publicUrl =
    config.environment.PI_REMOTE_WEB_PUBLIC_URL ??
    (await readRuntimeStatus(config, options.now))?.publicUrl ??
    null;
  const checks = [
    { name: "node", ok: await commandExists(config.nodePath, run), path: config.nodePath },
    { name: "caffeinate", ok: await commandExists("/usr/bin/caffeinate", run), path: "/usr/bin/caffeinate" },
    { name: "runner", ...(await fileCheck(config.runnerPath, null, { uid: config.uid })) },
    { name: "launch-agent", ...(await fileCheck(config.plistPath, 0o600, { uid: config.uid })) },
    { name: "launch-agent-loaded", ok: loaded },
    { name: "auth-directory", ...(await fileCheck(authDir, 0o700, { type: "directory", uid: config.uid })) },
    { name: "signing-secret", ...(await fileCheck(path.join(authDir, "signing-secret"), 0o600, { uid: config.uid })) },
    { name: "tailscale", ok: tailscale },
  ];
  const staleLockCount = await staleLocks(
    path.resolve(options.lockDir ?? path.join(getAgentDir(), "remote", "locks")),
  );
  return {
    publicUrl,
    ok:
      checks.every((check) => check.ok || (check.name === "tailscale" && !publicUrl)) &&
      staleLockCount === 0,
    checks,
    staleLockCount,
  };
}

export async function readServiceLogs(options = {}) {
  const config = serviceConfig(options);
  const lines = options.lines ?? 100;
  const read = async (file) => {
    try {
      return (await readFile(file, "utf8")).split("\n").slice(-lines).join("\n");
    } catch {
      return "";
    }
  };
  return { stdout: await read(config.stdoutPath), stderr: await read(config.stderrPath) };
}
