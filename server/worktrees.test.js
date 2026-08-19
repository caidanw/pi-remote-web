import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, it } from "node:test";
import { promisify } from "node:util";
import { createServer } from "./http.js";
import { RpcWorkerManager } from "./rpc-workers.js";
import {
  WorktreeManager,
  canonicalCandidate,
  parseWorktreePorcelain,
  runGit,
} from "./worktrees.js";

const exec = promisify(execFile);
const apps = [];
const fixtureRpc = fileURLToPath(new URL("./fixtures/fake-pi-rpc.js", import.meta.url));

afterEach(async () => {
  await Promise.allSettled(apps.splice(0).map((app) => app.close()));
});

async function git(cwd, args) {
  return exec("git", args, {
    cwd,
    env: { ...process.env, LANG: "C", LC_ALL: "C" },
    encoding: "utf8",
  });
}

async function repositoryFixture(name = "repo with spaces") {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-worktrees-"));
  const workspace = path.join(root, "workspace root");
  const repository = path.join(workspace, name);
  await mkdir(repository, { recursive: true });
  await git(repository, ["init", "-b", "main"]);
  await git(repository, ["config", "user.email", "test@example.com"]);
  await git(repository, ["config", "user.name", "Test"]);
  await writeFile(path.join(repository, "README.md"), "ok\n");
  await git(repository, ["add", "README.md"]);
  await git(repository, ["commit", "-m", "init"]);
  return { root, workspace, repository, manager: new WorktreeManager({ workspaceRoots: [workspace] }) };
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: options.method ?? "GET",
      headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {},
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({
        status: res.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

describe("Git worktrees", () => {
  it("parses spaces, bare repositories, and detached worktrees", () => {
    assert.deepEqual(
      parseWorktreePorcelain(
        "worktree /tmp/bare repo\0HEAD abc\0bare\0\0" +
        "worktree /tmp/linked\nodd tree\0HEAD def\0detached\0locked reason with spaces\0\0",
      ),
      [
        { path: "/tmp/bare repo", head: "abc", bare: true },
        { path: "/tmp/linked\nodd tree", head: "def", detached: true, locked: "reason with spaces" },
      ],
    );
  });

  it("lists real worktrees and reuses the existing linked-worktree parent", async () => {
    const { workspace, repository, manager } = await repositoryFixture();
    const linkedParent = path.join(workspace, "linked trees");
    const detached = path.join(linkedParent, "detached one");
    await mkdir(linkedParent);
    await git(repository, ["worktree", "add", "--detach", detached]);

    const listed = await manager.list(repository, "feature/topic");
    assert.equal(listed.worktrees.length, 2);
    assert.equal(await realpath(listed.worktrees[1].path), await realpath(detached));
    assert.equal(listed.worktrees[1].detached, true);
    assert.equal(await canonicalCandidate(listed.suggestedDestination), await canonicalCandidate(path.join(linkedParent, "topic")));
  });

  it("creates new and existing branches with argument arrays and paths containing spaces", async () => {
    const { workspace, repository, manager } = await repositoryFixture();
    const fallback = await manager.list(repository, "feature/topic");
    assert.equal(
      await canonicalCandidate(fallback.suggestedDestination),
      await canonicalCandidate(path.join(workspace, "repo with spaces-topic")),
    );
    const marker = path.join(workspace, "hook-ran");
    const hook = path.join(repository, ".git", "hooks", "post-checkout");
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(hook, 0o755);
    const override = path.join(workspace, "override destination with spaces");
    const created = await manager.create({
      repository,
      branch: "feature/with-spaces-path",
      base: "HEAD",
      destination: override,
    });
    assert.equal(created.destination, await realpath(override));
    assert.equal(created.worktree.branch, "feature/with-spaces-path");
    assert.equal((await readFile(path.join(override, "README.md"), "utf8")), "ok\n");
    await assert.rejects(lstat(marker), (error) => error.code === "ENOENT");

    await git(repository, ["branch", "prepared"]);
    const existingDestination = path.join(workspace, "prepared checkout");
    const existing = await manager.create({ repository, branch: "prepared", destination: existingDestination });
    assert.equal(existing.worktree.branch, "prepared");
  });

  it("supports creating a worktree from a bare repository", async () => {
    const { root, workspace, repository } = await repositoryFixture("seed");
    const bare = path.join(workspace, "bare repo.git");
    await git(root, ["clone", "--bare", repository, bare]);
    const manager = new WorktreeManager({ workspaceRoots: [workspace] });
    const listed = await manager.list(bare, "bare-feature");
    assert.equal(listed.worktrees[0].bare, true);
    const created = await manager.create({
      repository: bare,
      branch: "bare-feature",
      destination: path.join(workspace, "bare feature checkout"),
    });
    assert.equal(created.worktree.branch, "bare-feature");
  });

  it("rejects invalid or occupied branches and occupied destinations", async () => {
    const { workspace, repository, manager } = await repositoryFixture();
    await assert.rejects(
      manager.create({ branch: "missing-repository", destination: path.join(workspace, "missing") }),
      (error) => error.code === "WORKTREE_INVALID" && /repository required/.test(error.message),
    );
    await assert.rejects(
      manager.create({ repository, branch: "bad..branch", destination: path.join(workspace, "bad") }),
      (error) => error.code === "INVALID_BRANCH",
    );
    await assert.rejects(
      manager.create({ repository, branch: "@{-1}", destination: path.join(workspace, "shorthand") }),
      (error) => error.code === "INVALID_BRANCH",
    );
    await assert.rejects(
      manager.create({ repository, branch: "main", destination: path.join(workspace, "main again") }),
      (error) => error.code === "BRANCH_OCCUPIED",
    );
    const occupied = path.join(workspace, "occupied");
    await mkdir(occupied);
    await assert.rejects(
      manager.create({ repository, branch: "valid", destination: occupied }),
      (error) => error.code === "DESTINATION_OCCUPIED",
    );
    const failedDestination = path.join(workspace, "failed command leaves nothing");
    await assert.rejects(
      manager.create({ repository, branch: "missing-base", base: "does-not-exist", destination: failedDestination }),
      (error) => error.code === "GIT_FAILED",
    );
    await assert.rejects(lstat(failedDestination), (error) => error.code === "ENOENT");
  });

  it("passes the canonical destination to Git even if a symlink ancestor is swapped", async () => {
    const { root, workspace, repository } = await repositoryFixture();
    const inside = path.join(workspace, "canonical parent");
    const outside = path.join(root, "outside race");
    const alias = path.join(workspace, "parent alias");
    await mkdir(inside);
    await mkdir(outside);
    await symlink(inside, alias, "dir");
    let swapped = false;
    const swappingExec = (file, args, options, callback) => {
      if (!swapped && args.includes("worktree") && args.includes("add")) {
        swapped = true;
        void rm(alias)
          .then(() => symlink(outside, alias, "dir"))
          .then(() => execFile(file, args, options, callback), callback);
        return;
      }
      execFile(file, args, options, callback);
    };
    const manager = new WorktreeManager({ workspaceRoots: [workspace], execFile: swappingExec });
    const created = await manager.create({
      repository,
      branch: "symlink-race",
      destination: path.join(alias, "checkout"),
    });
    assert.equal(created.destination, await realpath(path.join(inside, "checkout")));
    await assert.rejects(lstat(path.join(outside, "checkout")), (error) => error.code === "ENOENT");
  });

  it("canonicalizes existing symlink ancestors and rejects root escapes", async () => {
    const { root, workspace, repository, manager } = await repositoryFixture();
    const outside = path.join(root, "outside");
    await mkdir(outside);
    const link = path.join(workspace, "escape-link");
    await symlink(outside, link, "dir");
    assert.equal(await canonicalCandidate(path.join(link, "new checkout")), await canonicalCandidate(path.join(outside, "new checkout")));
    await assert.rejects(
      manager.create({ repository, branch: "escape", destination: path.join(link, "new checkout") }),
      (error) => error.code === "WORKSPACE_ESCAPE",
    );
    await assert.rejects(
      manager.create({ repository, branch: "escape-two", destination: path.join(workspace, "..", "outside", "two") }),
      (error) => error.code === "WORKSPACE_ESCAPE",
    );
  });

  it("reports a retained path and recovery guidance after a partial worktree-add failure", async () => {
    const { workspace, repository } = await repositoryFixture();
    const destination = path.join(workspace, "partial checkout");
    const partialExec = (file, args, options, callback) => {
      if (args.includes("worktree") && args.includes("add")) {
        void mkdir(destination)
          .then(() => writeFile(path.join(destination, "partial"), "recover me\n"))
          .then(() => {
            const error = Object.assign(new Error("failed"), { code: 128 });
            callback(error, "", "fatal: simulated checkout failure\n");
          }, callback);
        return;
      }
      execFile(file, args, options, callback);
    };
    const manager = new WorktreeManager({ workspaceRoots: [workspace], execFile: partialExec });
    const canonicalDestination = await canonicalCandidate(destination);
    await assert.rejects(
      manager.create({ repository, branch: "partial", destination }),
      (error) =>
        error.code === "GIT_FAILED" &&
        error.createdPath === canonicalDestination &&
        /inspect.*(remove|recover)/i.test(error.recovery),
    );
    assert.equal(await readFile(path.join(destination, "partial"), "utf8"), "recover me\n");
  });

  it("uses LANG=C, never a shell, and surfaces Git command failures", async () => {
    let invocation;
    const fakeExec = (file, args, options, callback) => {
      invocation = { file, args, options };
      const error = Object.assign(new Error("failed"), { code: 128 });
      callback(error, "", "fatal: deliberate failure\n");
    };
    await assert.rejects(
      runGit("/tmp/path with spaces", ["worktree", "list", "--porcelain"], fakeExec),
      (error) => error.code === "GIT_FAILED" && /deliberate failure/.test(error.message),
    );
    assert.equal(invocation.file, "git");
    assert.deepEqual(invocation.args, ["worktree", "list", "--porcelain"]);
    assert.equal(invocation.options.cwd, "/tmp/path with spaces");
    assert.equal(invocation.options.env.LANG, "C");
    assert.equal(invocation.options.env.LC_ALL, "C");
    assert.equal(invocation.options.shell, undefined);
  });

  it("launches a real RPC worker whose persisted session cwd is the canonical created worktree", async () => {
    const { root, workspace, repository, manager } = await repositoryFixture();
    const created = await manager.create({
      repository,
      branch: "rpc-cwd",
      destination: path.join(workspace, "rpc checkout"),
    });
    const workers = new RpcWorkerManager({
      rpcEntry: fixtureRpc,
      lockDir: path.join(root, "locks"),
      sessionDir: () => path.join(root, "sessions"),
    });
    try {
      const session = await workers.open({ cwd: created.destination, fresh: true });
      assert.equal(session.cwd, created.destination);
      const header = JSON.parse((await readFile(session.path, "utf8")).split("\n")[0]);
      assert.equal(header.cwd, created.destination);
    } finally {
      await workers.closeAll();
    }
  });

  it("HTTP lists, creates with an override, launches, and starts sessions in the worktree cwd", async () => {
    const calls = [];
    let failNext = false;
    const fakeWorktrees = {
      list: async (repository, branch) => ({ repository, branch, roots: ["/workspace"], worktrees: [{ path: "/workspace/existing" }], suggestedDestination: "/workspace/suggested" }),
      create: async (body) => ({ destination: body.destination, worktree: { path: body.destination, branch: body.branch } }),
      resolveLaunch: async (_repository, target) => ({ path: target, branch: "existing" }),
    };
    const workers = {
      listSessions: () => [],
      open: async (options) => {
        calls.push(options);
        if (failNext) throw new Error("worker failed");
        return { id: `session-${calls.length}`, cwd: options.cwd, running: true };
      },
    };
    const app = createServer({ port: 0, workers, worktrees: fakeWorktrees, auth: false });
    apps.push(app);
    await new Promise((resolve) => app.listen(resolve));
    const port = app.server.address().port;

    const listed = await request(port, "/api/worktrees?repository=%2Fworkspace%2Frepo&branch=topic");
    assert.equal(listed.status, 200);
    assert.equal(listed.body.suggestedDestination, "/workspace/suggested");

    const created = await request(port, "/api/worktrees", {
      method: "POST",
      body: { repository: "/workspace/repo", branch: "topic", destination: "/workspace/override path" },
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.session.cwd, "/workspace/override path");
    assert.deepEqual(calls[0], { cwd: "/workspace/override path", fresh: true });

    const launched = await request(port, "/api/worktrees/launch", {
      method: "POST",
      body: { repository: "/workspace/repo", path: "/workspace/existing" },
    });
    assert.equal(launched.status, 200);
    assert.deepEqual(calls[1], { cwd: "/workspace/existing", fresh: true });

    failNext = true;
    const failedLaunch = await request(port, "/api/worktrees", {
      method: "POST",
      body: { repository: "/workspace/repo", branch: "preserved", destination: "/workspace/preserved" },
    });
    assert.equal(failedLaunch.status, 422);
    assert.equal(failedLaunch.body.createdPath, "/workspace/preserved");
  });
});
