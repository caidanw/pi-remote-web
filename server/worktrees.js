import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const MAX_GIT_OUTPUT = 4 * 1024 * 1024;

function worktreeError(message, code = "WORKTREE_INVALID") {
  const error = new Error(message);
  error.code = code;
  return error;
}

/** Run Git without a shell and with stable, English output. */
export function runGit(cwd, args, exec = execFile) {
  return new Promise((resolve, reject) => {
    exec(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = typeof stderr === "string" ? stderr.trim() : "";
          reject(worktreeError(detail || "Git command failed", "GIT_FAILED"));
          return;
        }
        resolve(typeof stdout === "string" ? stdout : "");
      },
    );
  });
}

/** Parse NUL-delimited `git worktree list --porcelain -z`. */
export function parseWorktreePorcelain(output) {
  const records = [];
  let current = null;
  for (const line of output.split("\0")) {
    if (!line) {
      if (current) records.push(current);
      current = null;
      continue;
    }
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? true : line.slice(space + 1);
    if (key === "worktree") {
      if (current) records.push(current);
      current = { path: value };
    } else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") {
      current.ref = value;
      current.branch = String(value).replace(/^refs\/heads\//, "");
    } else if (current && key === "detached") current.detached = true;
    else if (current && key === "bare") current.bare = true;
    else if (current && key === "locked") current.locked = value === true ? true : value;
    else if (current && key === "prunable") current.prunable = value === true ? true : value;
  }
  if (current) records.push(current);
  return records;
}

async function exists(target) {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Resolve symlinks in every existing ancestor while retaining a missing tail. */
export async function canonicalCandidate(target) {
  const absolute = path.resolve(target);
  let ancestor = absolute;
  const tail = [];
  while (!(await exists(ancestor))) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    tail.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const canonicalAncestor = await realpath(ancestor);
  return path.resolve(canonicalAncestor, ...tail);
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(".." + path.sep) && relative !== "..");
}

function branchLeaf(branch) {
  return branch.split("/").filter(Boolean).at(-1) || "worktree";
}

function gitDirName(worktree) {
  return path.basename(worktree.path.replace(/[\\/]$/, "")) || "repository";
}

export class WorktreeManager {
  /**
   * @param {{ workspaceRoots?: string[]; execFile?: typeof execFile }} [options]
   */
  constructor(options = {}) {
    const envRoots = process.env.PI_REMOTE_WEB_WORKSPACE_ROOTS
      ?.split(path.delimiter)
      .map((root) => root.trim())
      .filter(Boolean);
    this.workspaceRoots = (options.workspaceRoots?.length
      ? options.workspaceRoots
      : envRoots?.length
        ? envRoots
        : [path.join(os.homedir(), "Projects")]
    ).map((root) => path.resolve(root));
    this.execFile = options.execFile ?? execFile;
  }

  git(cwd, args) {
    return runGit(cwd, args, this.execFile);
  }

  async roots() {
    return Promise.all(this.workspaceRoots.map((root) => canonicalCandidate(root)));
  }

  async assertInRoots(target) {
    const canonical = await canonicalCandidate(target);
    const roots = await this.roots();
    if (!roots.some((root) => isWithin(root, canonical))) {
      throw worktreeError("Destination must be inside a configured workspace root", "WORKSPACE_ESCAPE");
    }
    return canonical;
  }

  async list(repository, branch = "worktree") {
    if (typeof repository !== "string" || !repository.trim()) {
      throw worktreeError("repository required");
    }
    const cwd = path.resolve(repository);
    const output = await this.git(cwd, ["worktree", "list", "--porcelain", "-z"]);
    const worktrees = parseWorktreePorcelain(output);
    if (!worktrees.length) throw worktreeError("Git returned no worktrees", "GIT_FAILED");
    const main = worktrees[0];
    const linked = worktrees.slice(1).filter((item) => !item.bare);
    const parent = linked.length
      ? path.dirname(linked[0].path)
      : path.dirname(main.path);
    const name = linked.length ? branchLeaf(branch) : `${gitDirName(main)}-${branchLeaf(branch)}`;
    return {
      repository: cwd,
      roots: this.workspaceRoots,
      worktrees,
      suggestedDestination: path.join(parent, name),
    };
  }

  async validateBranch(repository, branch) {
    if (typeof branch !== "string" || !branch.trim()) {
      throw worktreeError("branch required");
    }
    try {
      const normalized = (await this.git(repository, ["check-ref-format", "--branch", branch])).trim();
      if (normalized !== branch) throw new Error("branch shorthand is not allowed");
    } catch {
      throw worktreeError("Invalid branch name", "INVALID_BRANCH");
    }
  }

  async create(options) {
    if (typeof options?.repository !== "string" || !options.repository.trim()) {
      throw worktreeError("repository required");
    }
    const repository = path.resolve(options.repository);
    const branch = String(options?.branch || "").trim();
    const base = String(options?.base || "HEAD").trim() || "HEAD";
    const listed = await this.list(repository, branch);
    await this.validateBranch(repository, branch);
    if (listed.worktrees.some((item) => item.branch === branch)) {
      throw worktreeError("Branch is already checked out in another worktree", "BRANCH_OCCUPIED");
    }
    const requestedDestination = path.resolve(String(options?.destination || listed.suggestedDestination));
    if (await exists(requestedDestination)) {
      throw worktreeError("Destination already exists", "DESTINATION_OCCUPIED");
    }
    const canonicalDestination = await this.assertInRoots(requestedDestination);
    const branchExists = await this.git(repository, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).then(() => true, (error) => {
      if (error?.code === "GIT_FAILED") return false;
      throw error;
    });
    if (!branchExists) {
      await this.git(repository, ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`]);
    }
    // Re-check after Git validation so a symlink/destination cannot be slipped in unnoticed.
    if (await exists(canonicalDestination)) {
      throw worktreeError("Destination already exists", "DESTINATION_OCCUPIED");
    }
    if (await this.assertInRoots(requestedDestination) !== canonicalDestination) {
      throw worktreeError("Destination changed during validation", "WORKSPACE_ESCAPE");
    }
    const args = branchExists
      ? ["-c", "core.hooksPath=/dev/null", "worktree", "add", "--", canonicalDestination, branch]
      : ["-c", "core.hooksPath=/dev/null", "worktree", "add", "-b", branch, "--", canonicalDestination, base];
    try {
      await this.git(repository, args);
    } catch (error) {
      if (await exists(canonicalDestination)) {
        error.createdPath = canonicalDestination;
        error.recovery = `Git left files at ${canonicalDestination}; inspect them and remove or recover the worktree manually.`;
        error.message = `${error.message}. ${error.recovery}`;
      }
      throw error;
    }
    try {
      const createdPath = await realpath(canonicalDestination);
      if (createdPath !== canonicalDestination) {
        throw worktreeError("Created worktree path changed during creation", "WORKSPACE_ESCAPE");
      }
      await this.assertInRoots(createdPath);
      const refreshed = await this.list(repository, branch);
      let worktree = refreshed.worktrees.find((item) => path.resolve(item.path) === canonicalDestination);
      if (!worktree) {
        for (const item of refreshed.worktrees) {
          if (await realpath(item.path).then((resolved) => resolved === createdPath, () => false)) {
            worktree = item;
            break;
          }
        }
      }
      return { ...refreshed, destination: createdPath, worktree: worktree ?? { path: createdPath, branch } };
    } catch (error) {
      if (error && typeof error === "object") error.createdPath = canonicalDestination;
      throw error;
    }
  }

  async resolveLaunch(repository, worktreePath) {
    if (typeof repository !== "string" || !repository.trim()) {
      throw worktreeError("repository required");
    }
    if (typeof worktreePath !== "string" || !worktreePath.trim()) {
      throw worktreeError("worktree path required");
    }
    const destination = await this.assertInRoots(worktreePath);
    const listed = await this.list(repository);
    for (const item of listed.worktrees) {
      if (!item.bare && await realpath(item.path).then((resolved) => resolved === destination, () => false)) {
        return { ...item, path: destination };
      }
    }
    throw worktreeError("Path is not a worktree in this repository", "WORKTREE_NOT_FOUND");
  }
}
