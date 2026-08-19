#!/usr/bin/env node
import path from "node:path";
import { RpcWorkerManager } from "../rpc-workers.js";

const root = process.env.PI_TEST_ROOT;
const rpcEntry = process.env.PI_TEST_RPC_ENTRY;
if (!root || !rpcEntry) process.exit(2);

const manager = new RpcWorkerManager({
  rpcEntry,
  lockDir: path.join(root, "locks"),
  sessionDir: () => path.join(root, "sessions"),
  env: { PI_TEST_DISPOSE_MARKER: "1" },
});
const row = await manager.open({ cwd: root, fresh: true });
const workerPid = manager.require(row.id).child.pid;
process.stdout.write(`${JSON.stringify({ ...row, workerPid })}\n`);
setInterval(() => {}, 60_000);
