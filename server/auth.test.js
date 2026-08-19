import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { AUTH_COOKIE, AuthManager, PAIRING_TTL_MS, authDisabledByEnv } from "./auth.js";
import { createServer } from "./http.js";

const cleanups = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

async function authFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-auth-"));
  const auth = await new AuthManager({
    configDir: path.join(root, "auth"),
    publicUrl: "https://mac.example.ts.net",
    ...options,
  }).init();
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return { root, auth };
}

function request(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: pathname,
      method: options.method ?? "GET",
      headers: {
        ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}),
        ...options.headers,
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          body: res.headers["content-type"]?.includes("json") ? JSON.parse(text) : null,
        });
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function serverFixture(appOptions = {}) {
  const { auth } = await authFixture({ port: 0 });
  const app = createServer({ port: 0, auth, ...appOptions });
  await new Promise((resolve) => app.listen(resolve));
  cleanups.push(() => app.close());
  const port = app.server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  auth.allowedHosts.add(`127.0.0.1:${port}`);
  auth.allowedOrigins.add(origin);
  return { auth, app, port, origin };
}

function slowBodyRequest(port, origin, delayMs = 100) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/auth/exchange",
      method: "POST",
      headers: {
        Origin: origin,
        "Content-Type": "application/json",
        "Content-Length": "100",
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.write("{");
    setTimeout(() => req.end("}"), delayMs);
  });
}

function upgrade(port, host, origin) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET /api/events HTTP/1.1\r\nHost: ${host}\r\nOrigin: ${origin}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`,
      );
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (response += chunk));
    socket.on("end", () => resolve(response));
    socket.on("error", reject);
  });
}

async function pair(auth, port, origin) {
  const token = await auth.issuePairingToken();
  const response = await request(port, "/api/auth/exchange", {
    method: "POST",
    headers: { Origin: origin },
    body: { token },
  });
  assert.equal(response.status, 200);
  const cookie = response.headers["set-cookie"][0].split(";", 1)[0];
  return { cookie, csrf: response.body.csrf, token, response };
}

describe("browser authentication", () => {
  it("has no implicit insecure production fallback", () => {
    assert.throws(
      () => new AuthManager({ publicUrl: "http://mac.example.ts.net" }),
      /must use HTTPS/,
    );
    assert.throws(() => createServer({ port: 0 }), /requires auth/);
  });

  it("disables auth only through its own explicit opt-in", () => {
    assert.equal(authDisabledByEnv({}), false);
    assert.equal(authDisabledByEnv({ PI_REMOTE_WEB_DEV: "1" }), false);
    assert.equal(authDisabledByEnv({ PI_REMOTE_WEB_INSECURE_NO_AUTH: "true" }), false);
    assert.equal(authDisabledByEnv({ PI_REMOTE_WEB_INSECURE_NO_AUTH: "1" }), true);
  });

  it("issues five-minute random single-use tokens and rejects expiry and replay", async () => {
    let now = 1_000_000;
    const { auth } = await authFixture({ now: () => now });
    const first = await auth.issuePairingToken();
    const second = await auth.issuePairingToken();
    assert.match(first, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(first, second);
    await auth.exchangePairingToken(first);
    await assert.rejects(auth.exchangePairingToken(first), (error) => error.code === "PAIRING_INVALID");

    const expiring = await auth.issuePairingToken();
    now += PAIRING_TTL_MS;
    await assert.rejects(auth.exchangePairingToken(expiring), (error) => error.code === "PAIRING_EXPIRED");
  });

  it("consumes a token atomically under concurrent exchange", async () => {
    const { auth } = await authFixture();
    const token = await auth.issuePairingToken();
    const settled = await Promise.allSettled([
      auth.exchangePairingToken(token),
      auth.exchangePairingToken(token),
    ]);
    assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
  });

  it("signs bounded sessions, rejects tampering and expiry, and revokes all by rotation", async () => {
    let now = 5_000;
    const { auth } = await authFixture({ now: () => now, sessionTtlMs: 1_000 });
    const issued = await auth.issueSession();
    const req = { headers: { cookie: `${AUTH_COOKIE}=${issued.cookie}` } };
    assert.equal((await auth.sessionFromRequest(req)).csrf, issued.csrf);

    const tampered = `${issued.cookie.slice(0, -1)}${issued.cookie.endsWith("a") ? "b" : "a"}`;
    assert.equal(await auth.sessionFromRequest({ headers: { cookie: `${AUTH_COOKIE}=${tampered}` } }), null);
    const pendingPairing = await auth.issuePairingToken();
    await auth.rotateSigningSecret();
    assert.equal(await auth.sessionFromRequest(req), null);
    await assert.rejects(auth.exchangePairingToken(pendingPairing), (error) => error.code === "PAIRING_INVALID");

    const fresh = await auth.issueSession();
    now += 1_000;
    assert.equal(await auth.sessionFromRequest({ headers: { cookie: `${AUTH_COOKIE}=${fresh.cookie}` } }), null);
  });

  it("stores authentication material with user-only permissions", async () => {
    const { auth } = await authFixture();
    const token = await auth.issuePairingToken();
    const permissions = await auth.permissions();
    assert.equal(permissions.directory, 0o700);
    assert.equal(permissions.secret, 0o600);
    assert.equal((await stat(auth.tokenDir)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(auth.tokenDir, createHash("sha256").update(token).digest("hex")))).mode & 0o777, 0o600);
    assert.equal(Buffer.from((await readFile(auth.secretPath, "utf8")).trim(), "base64url").length, 32);
  });

  it("rejects unsafe pre-existing signing secret modes, owners, types, and symlinks", async () => {
    const { auth } = await authFixture();
    await chmod(auth.secretPath, 0o644);
    await assert.rejects(
      new AuthManager({ configDir: auth.configDir, publicUrl: "https://mac.example.ts.net" }).init(),
      /unsafe type, owner, or permissions/,
    );
    assert.equal((await stat(auth.secretPath)).mode & 0o777, 0o644);

    await chmod(auth.secretPath, 0o600);
    await assert.rejects(
      new AuthManager({
        configDir: auth.configDir,
        publicUrl: "https://mac.example.ts.net",
        secretUid: (process.getuid?.() ?? 0) + 1,
      }).init(),
      /unsafe type, owner, or permissions/,
    );

    await rm(auth.secretPath);
    await mkdir(auth.secretPath);
    await assert.rejects(
      new AuthManager({ configDir: auth.configDir, publicUrl: "https://mac.example.ts.net" }).init(),
      /unsafe type, owner, or permissions/,
    );

    const second = await authFixture();
    await rm(second.auth.secretPath);
    const target = path.join(second.root, "secret-target");
    await writeFile(target, Buffer.alloc(32).toString("base64url"), { mode: 0o600 });
    await symlink(target, second.auth.secretPath);
    await assert.rejects(
      new AuthManager({ configDir: second.auth.configDir, publicUrl: "https://mac.example.ts.net" }).init(),
      /unsafe type, owner, or permissions/,
    );
  });

  it("rejects symlinked authentication directories", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-remote-auth-symlink-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, "target");
    await mkdir(target);
    const configDir = path.join(root, "auth-link");
    await symlink(target, configDir, "dir");
    await assert.rejects(
      new AuthManager({ configDir, publicUrl: "https://mac.example.ts.net" }).init(),
      /real directory/,
    );
  });

  it("puts pairing tokens only in URL fragments", async () => {
    const { auth } = await authFixture();
    const token = await auth.issuePairingToken();
    const url = new URL(auth.pairingUrl(token));
    assert.equal(url.origin, "https://mac.example.ts.net");
    assert.equal(url.search, "");
    assert.equal(url.hash, `#pair=${token}`);
    assert.equal(url.href.split("#")[0].includes(token), false);
  });

  it("bounds headers, requests, auth/control bodies, prompt images, and slow body progress", async () => {
    const { auth, app, port, origin } = await serverFixture({
      bodyIdleTimeoutMs: 30,
      requestTimeoutMs: 30_000,
      headersTimeoutMs: 15_000,
      socketTimeoutMs: 30_000,
    });
    assert.equal(app.server.requestTimeout, 30_000);
    assert.equal(app.server.headersTimeout, 15_000);
    assert.equal(app.server.timeout, 30_000);
    const slow = await slowBodyRequest(port, origin);
    assert.equal(slow.status, 408);

    const authOversize = await request(port, "/api/auth/exchange", {
      method: "POST",
      headers: { Origin: origin },
      body: { padding: "x".repeat(5 * 1024) },
    });
    assert.equal(authOversize.status, 413);

    const { cookie, csrf } = await pair(auth, port, origin);
    const headers = { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf };
    const controlOversize = await request(port, "/api/sessions/id", {
      method: "PATCH",
      headers,
      body: { name: "x".repeat(65 * 1024) },
    });
    assert.equal(controlOversize.status, 413);

    const largerPrompt = await request(port, "/api/sessions/id/prompt", {
      method: "POST",
      headers,
      body: { message: "x".repeat(65 * 1024) },
    });
    assert.equal(largerPrompt.status, 404);

    const oversizedImage = Buffer.alloc(8 * 1024 * 1024 + 1).toString("base64");
    const imageResponse = await request(port, "/api/sessions/id/prompt", {
      method: "POST",
      headers,
      body: { message: "image", images: [{ type: "image", mimeType: "image/png", data: oversizedImage }] },
    });
    assert.equal(imageResponse.status, 400);
  });

  it("keeps an established authenticated SSE stream alive past the normal socket timeout", async () => {
    const remoteBroker = {
      ringInfo: () => ({ seq: 0, ringStart: 1 }),
      eventsAfter: () => [],
      subscribeSession: () => () => {},
    };
    const { auth, app, port, origin } = await serverFixture({
      socketTimeoutMs: 40,
      remoteBroker,
    });
    const { cookie } = await pair(auth, port, origin);
    const { req, res } = await new Promise((resolve, reject) => {
      const req = http.request({
        host: "127.0.0.1",
        port,
        path: "/api/remote/sessions/id/events",
        headers: { Cookie: cookie },
      }, (res) => {
        res.once("data", () => resolve({ req, res }));
      });
      req.on("error", reject);
      req.end();
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal(res.destroyed, false);
    assert.equal(app.server.timeout, 40);
    req.destroy();
    res.destroy();
  });

  it("sets strict cookie flags and rejects token query exchange without consuming it", async () => {
    const { auth, port, origin } = await serverFixture();
    const token = await auth.issuePairingToken();
    const query = await request(port, `/api/auth/exchange?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { Origin: origin },
      body: {},
    });
    assert.equal(query.status, 400);
    assert.equal(query.text.includes(token), false);

    const exchanged = await request(port, "/api/auth/exchange", {
      method: "POST",
      headers: { Origin: origin },
      body: { token },
    });
    assert.equal(exchanged.status, 200);
    const setCookie = exchanged.headers["set-cookie"][0];
    assert.match(setCookie, /; Path=\/;/);
    assert.match(setCookie, /; HttpOnly;/);
    assert.match(setCookie, /; Secure;/);
    assert.match(setCookie, /; SameSite=Strict$/);
    assert.match(setCookie, /; Max-Age=43200;/);
    assert.doesNotMatch(setCookie, /Domain=/i);
    assert.equal(exchanged.headers["cache-control"], "no-store");
  });

  it("strictly validates Host and Origin for loopback and public Tailscale origins", async () => {
    const { port, origin } = await serverFixture();
    assert.equal((await request(port, "/api/auth/status")).status, 200);
    const health = await request(port, "/api/health");
    assert.deepEqual(health.body, { ok: true });
    assert.equal((await request(port, "/api/auth/status", { headers: { Host: "evil.example" } })).status, 421);
    assert.equal((await request(port, "/api/auth/status", { headers: { Origin: "https://evil.example" } })).status, 403);
    assert.equal((await request(port, "/api/auth/status", {
      headers: { Host: "mac.example.ts.net", Origin: "https://mac.example.ts.net" },
    })).status, 200);
    assert.equal((await request(port, "/api/auth/exchange", {
      method: "POST",
      headers: { Origin: origin },
      body: { token: "invalid" },
    })).status, 400);
    assert.match(await upgrade(port, `127.0.0.1:${port}`, origin), /^HTTP\/1\.1 426/);
    assert.match(await upgrade(port, "evil.example", "https://evil.example"), /^HTTP\/1\.1 403/);
  });

  it("requires authentication and CSRF on every mutation route", async () => {
    const { auth, port, origin } = await serverFixture();
    const unauthenticated = await request(port, "/api/sessions");
    assert.equal(unauthenticated.status, 401);
    const { cookie, csrf } = await pair(auth, port, origin);
    const sessions = await request(port, "/api/sessions", { headers: { Cookie: cookie } });
    assert.equal(sessions.status, 200);
    assert.equal(sessions.headers["cache-control"], "no-store");

    const mutations = [
      ["POST", "/api/shutdown"],
      ["POST", "/api/remote/sessions/id/prompt"],
      ["POST", "/api/remote/sessions/id/abort"],
      ["POST", "/api/worktrees"],
      ["POST", "/api/worktrees/launch"],
      ["POST", "/api/sessions"],
      ["POST", "/api/sessions/id/release"],
      ["POST", "/api/sessions/id/prompt"],
      ["POST", "/api/sessions/id/command"],
      ["POST", "/api/sessions/id/abort"],
      ["POST", "/api/sessions/id/model"],
      ["POST", "/api/sessions/id/scoped-models"],
      ["POST", "/api/sessions/id/share"],
      ["POST", "/api/sessions/id/trust"],
      ["POST", "/api/sessions/id/thinking"],
      ["POST", "/api/sessions/id/compact"],
      ["POST", "/api/sessions/id/tree"],
      ["POST", "/api/sessions/id/fork"],
      ["POST", "/api/sessions/id/steer"],
      ["POST", "/api/sessions/id/follow-up"],
      ["POST", "/api/sessions/id/bash"],
      ["POST", "/api/sessions/id/abort-bash"],
      ["POST", "/api/sessions/id/tools"],
      ["POST", "/api/sessions/id/skills"],
      ["POST", "/api/sessions/id/skill-file"],
      ["PATCH", "/api/sessions/id"],
      ["DELETE", "/api/sessions/id"],
      ["POST", "/api/auth/logout"],
    ];
    const crossOrigin = await request(port, "/api/auth/logout", {
      method: "POST",
      headers: { Origin: "https://evil.example", Cookie: cookie, "X-CSRF-Token": csrf },
      body: {},
    });
    assert.equal(crossOrigin.status, 403);

    for (const [method, pathname] of mutations) {
      const missing = await request(port, pathname, {
        method,
        headers: { Origin: origin, Cookie: cookie },
        body: {},
      });
      assert.equal(missing.status, 403, `${method} ${pathname} without CSRF`);
      assert.equal(missing.headers["cache-control"], "no-store");
      const wrong = await request(port, pathname, {
        method,
        headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": `${csrf}x` },
        body: {},
      });
      assert.equal(wrong.status, 403, `${method} ${pathname} with bad CSRF`);
    }

    const logout = await request(port, "/api/auth/logout", {
      method: "POST",
      headers: { Origin: origin, Cookie: cookie, "X-CSRF-Token": csrf },
      body: {},
    });
    assert.equal(logout.status, 200);
    assert.match(logout.headers["set-cookie"][0], /Max-Age=0; HttpOnly; Secure; SameSite=Strict$/);
  });

  it("rejects stale and tampered cookies over HTTP", async () => {
    const { auth, port, origin } = await serverFixture();
    const { cookie } = await pair(auth, port, origin);
    const tampered = `${cookie.slice(0, -1)}x`;
    assert.equal((await request(port, "/api/sessions", { headers: { Cookie: tampered } })).status, 401);
    await auth.rotateSigningSecret();
    assert.equal((await request(port, "/api/sessions", { headers: { Cookie: cookie } })).status, 401);
  });
});
