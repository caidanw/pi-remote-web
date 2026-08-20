import assert from "node:assert/strict";
import { it } from "node:test";
import { exchangePairingToken, listModels } from "./api.ts";

it("ignores unauthenticated responses from requests started before pairing completed", async () => {
  const previousFetch = globalThis.fetch;
  const previousWindow = globalThis.window;
  const events = new EventTarget();
  let authRequired = 0;
  events.addEventListener("pi-remote-web:auth-required", () => authRequired += 1);
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });

  let resolveModels!: (response: Response) => void;
  globalThis.fetch = ((input: string | URL | Request) => {
    if (String(input).includes("/api/models")) {
      return new Promise<Response>((resolve) => { resolveModels = resolve; });
    }
    return Promise.resolve(Response.json({ authenticated: true, csrf: "new", expiresAt: Date.now() + 1000 }));
  }) as typeof fetch;

  try {
    const staleRequest = listModels().catch(() => null);
    await exchangePairingToken("token");
    resolveModels(Response.json({ error: "Pair this browser" }, { status: 401 }));
    await staleRequest;
    assert.equal(authRequired, 0);
  } finally {
    globalThis.fetch = previousFetch;
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
