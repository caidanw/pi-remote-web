import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import { createServer } from "./http.js";
import { RpcWorkerManager } from "./rpc-workers.js";

function fakeSource() {
  const listeners = new Set();
  const add = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };
  return {
    listeners,
    subscribe: add, // broker's catalogue subscription
    subscribeChanges: add, // RpcWorkerManager's (its subscribe() streams one session)
    fire() {
      for (const listener of listeners) listener();
    },
    async closeAll() {},
  };
}

describe("GET /api/sessions/changes", () => {
  it("pings once per burst of session-list changes and unsubscribes on close", async () => {
    const broker = fakeSource();
    // The real manager: its subscribe(id, …) streams one session, so a name mix-up must fail here.
    const workers = new RpcWorkerManager({ rpcEntry: "/nonexistent-pi-rpc.js" });
    const app = createServer({ port: 0, auth: false, remoteBroker: broker, workers });
    await new Promise((resolve) => app.listen(resolve));
    try {
      const port = app.server.address().port;
      let body = "";
      const req = http.get({ host: "127.0.0.1", port, path: "/api/sessions/changes" });
      const res = await new Promise((resolve) => req.on("response", resolve));
      assert.equal(res.headers["content-type"], "text/event-stream");
      res.setEncoding("utf8");
      res.on("data", (chunk) => (body += chunk));
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(broker.listeners.size, 1);
      assert.equal(workers.changeListeners.size, 1);

      broker.fire();
      broker.fire(); // same burst: one event
      // Wait for the batch (250 ms) without a fixed sleep: under a loaded test run it lands late.
      for (let i = 0; i < 100 && !body.includes("event: changed"); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(body.match(/event: changed/g)?.length, 1);

      req.destroy();
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(broker.listeners.size, 0);
      assert.equal(workers.changeListeners.size, 0);
    } finally {
      app.close();
    }
  });
});
