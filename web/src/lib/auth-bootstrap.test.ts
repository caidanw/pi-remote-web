import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAuthenticatedStartup } from "./auth-bootstrap.ts";

describe("authenticated startup", () => {
  it("never starts protected loads while pairing is unresolved or rejected", async () => {
    let resolveAuth!: (authenticated: boolean) => void;
    const authentication = new Promise<boolean>((resolve) => (resolveAuth = resolve));
    let protectedLoads = 0;
    const startup = runAuthenticatedStartup(
      () => authentication,
      async () => { protectedLoads += 1; },
    );

    await Promise.resolve();
    assert.equal(protectedLoads, 0);
    resolveAuth(false);
    assert.equal(await startup, false);
    assert.equal(protectedLoads, 0);
  });

  it("starts protected loads only after successful pairing", async () => {
    const order: string[] = [];
    const authenticated = await runAuthenticatedStartup(
      async () => { order.push("authenticated"); return true; },
      async () => { order.push("protected"); },
    );
    assert.equal(authenticated, true);
    assert.deepEqual(order, ["authenticated", "protected"]);
  });
});
