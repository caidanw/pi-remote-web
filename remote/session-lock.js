import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const BOOT_ID = Math.round((Date.now() - os.uptime() * 1000) / 60_000);

function lockName(sessionPath) {
  return createHash("sha256").update(path.resolve(sessionPath)).digest("hex");
}

function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function readOwner(lockDir) {
  try {
    return JSON.parse(await readFile(path.join(lockDir, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Acquire one cross-process writer lock for a Pi session file.
 * @param {{
 *   baseDir: string;
 *   sessionPath: string;
 *   ownerKind: "terminal" | "browser";
 *   runtimeId: string;
 *   pid?: number;
 *   isPidAlive?: (pid: number) => boolean;
 *   bootId?: number;
 * }} options
 * @returns {Promise<{ ok: true; lock: Record<string, unknown> & { lockDir: string; nonce: string } } | { ok: false; owner: Record<string, unknown> | null }>}
 */
export async function acquireSessionLock(options) {
  const sessionPath = path.resolve(options.sessionPath);
  const lockDir = path.join(options.baseDir, lockName(sessionPath));
  const isAlive = options.isPidAlive ?? pidIsAlive;
  const bootId = options.bootId ?? BOOT_ID;
  await mkdir(options.baseDir, { recursive: true, mode: 0o700 });
  await chmod(options.baseDir, 0o700);

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const nonce = randomUUID();
    const tempDir = `${lockDir}.acquire-${process.pid}-${nonce}`;
    const owner = {
      sessionPath,
      ownerKind: options.ownerKind,
      runtimeId: options.runtimeId,
      pid: options.pid ?? process.pid,
      bootId,
      nonce,
      acquiredAt: new Date().toISOString(),
    };
    await mkdir(tempDir, { mode: 0o700 });
    await writeFile(path.join(tempDir, "owner.json"), JSON.stringify(owner), {
      mode: 0o600,
    });
    try {
      await rename(tempDir, lockDir);
      return { ok: true, lock: { ...owner, lockDir } };
    } catch (error) {
      await rm(tempDir, { recursive: true, force: true });
      if (error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") throw error;
    }

    const existing = await readOwner(lockDir);
    if (!existing) return { ok: false, owner: null };
    if (existing.bootId === bootId && isAlive(existing.pid)) {
      return { ok: false, owner: existing };
    }

    const staleDir = `${lockDir}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(lockDir, staleDir);
      await rm(staleDir, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== "ENOENT") return { ok: false, owner: existing };
    }
  }

  return { ok: false, owner: await readOwner(lockDir) };
}

/** @param {{ lockDir: string; nonce: string }} lock */
/** Transfer a held browser lock's liveness marker to its spawned worker PID. */
export async function updateSessionLockPid(lock, pid) {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error("valid worker PID required");
  const owner = await readOwner(lock.lockDir);
  if (!owner || owner.nonce !== lock.nonce) return null;
  const updated = { ...owner, pid };
  const temp = path.join(lock.lockDir, `.owner-${process.pid}-${randomUUID()}.json`);
  await writeFile(temp, JSON.stringify(updated), { mode: 0o600 });
  await rename(temp, path.join(lock.lockDir, "owner.json"));
  return { ...lock, pid };
}

export async function releaseSessionLock(lock) {
  const owner = await readOwner(lock.lockDir);
  if (!owner || owner.nonce !== lock.nonce) return false;
  const releasedDir = `${lock.lockDir}.release-${process.pid}-${randomUUID()}`;
  try {
    await rename(lock.lockDir, releasedDir);
    await rm(releasedDir, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
