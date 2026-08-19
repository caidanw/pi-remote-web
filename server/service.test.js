import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  SERVICE_LABEL,
  controlService,
  doctorService,
  installService,
  launchAgentPlist,
  readServiceLogs,
  serviceConfig,
  serviceStatus,
  uninstallService,
} from "./service.js";
import { serviceExitCode } from "./service-runtime.js";

const cleanup = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()();
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-service-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const plistPath = path.join(root, "LaunchAgents", `${SERVICE_LABEL}.plist`);
  const runnerPath = path.join(root, "service runner.js");
  const nodePath = path.join(root, "node & runtime");
  await writeFile(runnerPath, "// runner");
  await writeFile(nodePath, "node");
  return { root, stateDir, plistPath, runnerPath, nodePath, home: root, uid: process.getuid() };
}

function recorder(failBootout = false) {
  const calls = [];
  return {
    calls,
    run: async (file, args) => {
      calls.push([file, args]);
      if (failBootout && args[0] === "bootout") {
        const error = new Error("not loaded");
        error.stderr = "Could not find service";
        throw error;
      }
      return { stdout: "", stderr: "" };
    },
  };
}

describe("macOS service operations", () => {
  it("does not restart after an intentional runner signal", () => {
    assert.equal(serviceExitCode(true, null, "SIGTERM"), 0);
    assert.equal(serviceExitCode(false, null, "SIGTERM"), 1);
    assert.equal(serviceExitCode(false, 7, null), 7);
  });

  it("renders an escaped, argument-array LaunchAgent", async () => {
    const config = serviceConfig({
      ...(await fixture()),
      publicUrl: "https://mac.example.test/a?x=<unsafe>",
    });
    const plist = launchAgentPlist(config);
    assert.match(plist, new RegExp(`<string>${SERVICE_LABEL}</string>`));
    assert.ok(plist.includes("node &amp; runtime"));
    assert.ok(plist.includes("?x=&lt;unsafe&gt;"));
    assert.ok(plist.includes("<key>RunAtLoad</key>"));
    assert.ok(plist.includes("<key>SuccessfulExit</key>"));
    assert.ok(!plist.includes("/bin/sh"));
  });

  it("installs idempotently with modern per-user launchctl commands", async () => {
    const options = await fixture();
    const recorded = recorder(true);
    const config = await installService({ ...options, run: recorded.run });
    assert.equal((await stat(config.plistPath)).mode & 0o777, 0o600);
    assert.deepEqual(
      recorded.calls.map(([, args]) => args[0]),
      ["bootout", "bootstrap", "kickstart"],
    );
    assert.deepEqual(recorded.calls[1], ["/bin/launchctl", ["bootstrap", `gui/${options.uid}`, config.plistPath]]);
    assert.deepEqual(recorded.calls[2], ["/bin/launchctl", ["kickstart", "-k", `gui/${options.uid}/${SERVICE_LABEL}`]]);
  });

  it("atomically replaces a hostile plist symlink without touching its target", async () => {
    const options = await fixture();
    const victim = path.join(options.root, "victim");
    await mkdir(path.dirname(options.plistPath), { recursive: true });
    await writeFile(victim, "keep");
    await symlink(victim, options.plistPath);
    await installService({ ...options, run: recorder(true).run });
    assert.equal(await readFile(victim, "utf8"), "keep");
    assert.match(await readFile(options.plistPath, "utf8"), new RegExp(SERVICE_LABEL));
  });

  it("controls and removes only its own user service", async () => {
    const options = await fixture();
    const recorded = recorder();
    await mkdir(path.dirname(options.plistPath), { recursive: true });
    await writeFile(options.plistPath, "plist");
    await controlService("start", { ...options, run: recorded.run });
    await controlService("restart", { ...options, run: recorded.run });
    await controlService("stop", { ...options, run: recorded.run });
    await uninstallService({ ...options, run: recorded.run });
    assert.deepEqual(recorded.calls.map(([, args]) => args[0]), ["kickstart", "kickstart", "kill", "bootout"]);
    await assert.rejects(readFile(options.plistPath), /ENOENT/);
  });

  it("reports runtime status and bounded log tails", async () => {
    const options = await fixture();
    const config = serviceConfig(options);
    await mkdir(path.dirname(config.plistPath), { recursive: true });
    await mkdir(config.logsDir, { recursive: true });
    await writeFile(config.plistPath, "plist", { mode: 0o600 });
    await writeFile(
      config.statusPath,
      JSON.stringify({
        port: 4999,
        publicUrl: "https://remote.example.test",
        liveSessions: 3,
        terminalSessions: 2,
        browserSessions: 1,
        updatedAt: new Date().toISOString(),
      }),
      { mode: 0o600 },
    );
    await writeFile(config.stdoutPath, "one\ntwo\nthree\n");
    const status = await serviceStatus({
      ...options,
      run: recorder().run,
      fetch: async () => ({ ok: true }),
    });
    assert.equal(status.installed, true);
    assert.equal(status.loaded, true);
    assert.equal(status.healthy, true);
    assert.equal(status.liveSessions, 3);
    assert.equal(status.localUrl, "http://127.0.0.1:4999");
    assert.equal(status.publicUrl, "https://remote.example.test");
    assert.equal(status.stale, false);
    assert.deepEqual(await readServiceLogs({ ...options, lines: 2 }), { stdout: "three\n", stderr: "" });
  });

  it("marks stale or unsafe runtime status instead of reporting counts", async () => {
    const options = await fixture();
    const config = serviceConfig(options);
    await mkdir(config.stateDir, { recursive: true });
    await writeFile(
      config.statusPath,
      JSON.stringify({ liveSessions: 9, updatedAt: new Date(Date.now() - 60_000).toISOString() }),
      { mode: 0o600 },
    );
    const stale = await serviceStatus({ ...options, run: recorder().run, fetch: async () => ({ ok: true }) });
    assert.equal(stale.stale, true);
    assert.equal(stale.liveSessions, null);

    await writeFile(
      config.statusPath,
      JSON.stringify({ liveSessions: 9, updatedAt: new Date().toISOString() }),
    );
    await chmod(config.statusPath, 0o644);
    const unsafe = await serviceStatus({ ...options, run: recorder().run, fetch: async () => ({ ok: true }) });
    assert.equal(unsafe.stale, true);
    assert.equal(unsafe.liveSessions, null);
  });

  it("doctor diagnoses permissions and stale locks without mutating", async () => {
    const options = await fixture();
    const authDir = path.join(options.root, "auth");
    const lockDir = path.join(options.root, "locks");
    await mkdir(authDir, { mode: 0o700 });
    await writeFile(path.join(authDir, "signing-secret"), "secret", { mode: 0o600 });
    await mkdir(path.join(lockDir, "stale"), { recursive: true });
    await writeFile(path.join(lockDir, "stale", "owner.json"), JSON.stringify({ pid: 99999999 }));
    const report = await doctorService({
      ...options,
      authDir,
      lockDir,
      run: recorder().run,
    });
    assert.equal(report.staleLockCount, 1);
    assert.equal(report.ok, false);
    assert.ok(report.checks.some((check) => check.name === "tailscale"));
    assert.equal(await readFile(path.join(lockDir, "stale", "owner.json"), "utf8"), JSON.stringify({ pid: 99999999 }));
  });
});
