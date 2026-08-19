import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const AUTH_COOKIE = "__Host-pi_remote_web";
export const PAIRING_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

function authError(message, code, status = 401) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function safeEqual(left, right) {
  const a = createHash("sha256").update(String(left)).digest();
  const b = createHash("sha256").update(String(right)).digest();
  return timingSafeEqual(a, b);
}

function tokenKey(token) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(header) {
  const cookies = new Map();
  for (const part of String(header || "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    cookies.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  return cookies;
}

function normalizeUrl(value, name, allowHttpLoopback = false) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be an absolute URL`);
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(allowHttpLoopback && loopback && url.protocol === "http:")) {
    throw new Error(`${name} must use HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must contain only an origin and optional path`);
  }
  return url;
}

/**
 * Authentication is disabled only by its own explicit opt-in, never as a
 * side effect of running the Vite dev server.
 * @param {Record<string, string | undefined>} env
 */
export function authDisabledByEnv(env) {
  return env.PI_REMOTE_WEB_INSECURE_NO_AUTH === "1";
}

export class AuthManager {
  /**
   * @param {{ configDir?: string; publicUrl?: string; port?: number; now?: () => number; pairingTtlMs?: number; sessionTtlMs?: number; allowHttpLoopback?: boolean; uid?: number; secretUid?: number }} [options]
   */
  constructor(options = {}) {
    this.configDir = path.resolve(options.configDir ?? path.join(getAgentDir(), "remote", "auth"));
    this.tokenDir = path.join(this.configDir, "pairing");
    this.secretPath = path.join(this.configDir, "signing-secret");
    this.port = options.port ?? 3847;
    this.now = options.now ?? Date.now;
    this.pairingTtlMs = options.pairingTtlMs ?? PAIRING_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? SESSION_TTL_MS;
    this.uid = options.uid ?? process.getuid?.();
    this.secretUid = options.secretUid ?? this.uid;
    this.publicUrl = normalizeUrl(options.publicUrl, "PI_REMOTE_WEB_PUBLIC_URL", options.allowHttpLoopback);
    const loopbackOrigins = [
      `http://127.0.0.1:${this.port}`,
      `http://localhost:${this.port}`,
    ];
    this.allowedOrigins = new Set(loopbackOrigins);
    this.allowedHosts = new Set(loopbackOrigins.map((origin) => new URL(origin).host.toLowerCase()));
    if (this.publicUrl) {
      this.allowedOrigins.add(this.publicUrl.origin);
      this.allowedHosts.add(this.publicUrl.host.toLowerCase());
    }
  }

  async init() {
    if (this.uid == null) throw new Error("Cannot verify authentication file ownership on this platform");
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const configInfo = await lstat(this.configDir);
    if (!configInfo.isDirectory() || configInfo.isSymbolicLink() || configInfo.uid !== this.uid) {
      throw new Error("Authentication directory must be a user-owned real directory");
    }
    await chmod(this.configDir, 0o700);
    await mkdir(this.tokenDir, { recursive: true, mode: 0o700 });
    const tokenInfo = await lstat(this.tokenDir);
    if (!tokenInfo.isDirectory() || tokenInfo.isSymbolicLink() || tokenInfo.uid !== this.uid) {
      throw new Error("Pairing token directory must be a user-owned real directory");
    }
    await chmod(this.tokenDir, 0o700);
    try {
      await writeFile(this.secretPath, randomBytes(32).toString("base64url"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    const secretInfo = await lstat(this.secretPath);
    const unsafeSecret =
      !secretInfo.isFile() ||
      secretInfo.isSymbolicLink() ||
      (secretInfo.mode & 0o777) !== 0o600 ||
      (this.secretUid != null && secretInfo.uid !== this.secretUid);
    if (unsafeSecret) {
      throw new Error("Authentication signing secret has unsafe type, owner, or permissions");
    }
    await this.#secret();
    return this;
  }

  pairingUrl(token) {
    if (!this.publicUrl) {
      throw new Error("Set PI_REMOTE_WEB_PUBLIC_URL to the HTTPS Tailscale Serve URL before pairing");
    }
    const url = new URL(this.publicUrl.href);
    url.hash = `pair=${encodeURIComponent(token)}`;
    return url.href;
  }

  async issuePairingToken() {
    const token = randomBytes(32).toString("base64url");
    const file = path.join(this.tokenDir, tokenKey(token));
    await writeFile(file, JSON.stringify({ expiresAt: this.now() + this.pairingTtlMs }), {
      flag: "wx",
      mode: 0o600,
    });
    await chmod(file, 0o600);
    return token;
  }

  async exchangePairingToken(token) {
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw authError("Invalid pairing token", "PAIRING_INVALID", 400);
    }
    const source = path.join(this.tokenDir, tokenKey(token));
    const consumed = `${source}.used-${randomBytes(8).toString("hex")}`;
    try {
      await rename(source, consumed);
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw authError("Pairing token is invalid or already used", "PAIRING_INVALID", 400);
      }
      throw error;
    }
    let record;
    try {
      record = JSON.parse(await readFile(consumed, "utf8"));
    } finally {
      await unlink(consumed).catch(() => {});
    }
    if (!Number.isFinite(record?.expiresAt) || record.expiresAt <= this.now()) {
      throw authError("Pairing token expired", "PAIRING_EXPIRED", 400);
    }
    return this.issueSession();
  }

  async issueSession() {
    const now = this.now();
    const session = {
      iat: now,
      exp: now + this.sessionTtlMs,
      csrf: randomBytes(24).toString("base64url"),
      nonce: randomBytes(16).toString("base64url"),
    };
    const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
    const signature = createHmac("sha256", await this.#secret()).update(payload).digest("base64url");
    return {
      cookie: `${payload}.${signature}`,
      csrf: session.csrf,
      expiresAt: session.exp,
    };
  }

  async sessionFromRequest(req) {
    const cookie = parseCookies(req.headers.cookie).get(AUTH_COOKIE);
    if (!cookie) return null;
    const separator = cookie.lastIndexOf(".");
    if (separator < 1) return null;
    const payload = cookie.slice(0, separator);
    const signature = cookie.slice(separator + 1);
    const expected = createHmac("sha256", await this.#secret()).update(payload).digest("base64url");
    if (!safeEqual(signature, expected)) return null;
    try {
      const session = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      if (!Number.isFinite(session?.exp) || session.exp <= this.now()) return null;
      if (typeof session.csrf !== "string" || !session.csrf) return null;
      return session;
    } catch {
      return null;
    }
  }

  cookieHeader(value, maxAge = Math.floor(this.sessionTtlMs / 1000)) {
    return `${AUTH_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
  }

  clearCookieHeader() {
    return this.cookieHeader("", 0);
  }

  validateHostOrigin(req, { requireOrigin = false } = {}) {
    const host = String(req.headers.host || "").toLowerCase();
    if (!this.allowedHosts.has(host)) {
      throw authError("Host not allowed", "HOST_INVALID", 421);
    }
    const origin = req.headers.origin;
    if (!origin) {
      if (requireOrigin) throw authError("Origin required", "ORIGIN_INVALID", 403);
      return;
    }
    let normalized;
    try {
      normalized = new URL(String(origin)).origin;
    } catch {
      throw authError("Origin not allowed", "ORIGIN_INVALID", 403);
    }
    if (!this.allowedOrigins.has(normalized)) {
      throw authError("Origin not allowed", "ORIGIN_INVALID", 403);
    }
  }

  async requireSession(req, { csrf = false } = {}) {
    const session = await this.sessionFromRequest(req);
    if (!session) throw authError("Pair this browser to continue", "AUTH_REQUIRED", 401);
    if (csrf && !safeEqual(req.headers["x-csrf-token"] || "", session.csrf)) {
      throw authError("CSRF token invalid", "CSRF_INVALID", 403);
    }
    return session;
  }

  async rotateSigningSecret() {
    await mkdir(this.configDir, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.configDir, `.signing-secret-${process.pid}-${randomBytes(8).toString("hex")}`);
    await writeFile(temporary, randomBytes(32).toString("base64url"), { flag: "wx", mode: 0o600 });
    await rename(temporary, this.secretPath);
    await chmod(this.secretPath, 0o600);
    const tokens = await readdir(this.tokenDir).catch(() => []);
    await Promise.all(tokens.map((name) => unlink(path.join(this.tokenDir, name)).catch(() => {})));
  }

  async permissions() {
    const [directory, secret] = await Promise.all([stat(this.configDir), stat(this.secretPath)]);
    return { directory: directory.mode & 0o777, secret: secret.mode & 0o777 };
  }

  async #secret() {
    const handle = await open(this.secretPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        (info.mode & 0o777) !== 0o600 ||
        (this.secretUid != null && info.uid !== this.secretUid)
      ) {
        throw new Error("Authentication signing secret has unsafe type, owner, or permissions");
      }
      const encoded = (await handle.readFile("utf8")).trim();
      const secret = Buffer.from(encoded, "base64url");
      if (secret.length !== 32) throw new Error("Authentication signing secret is invalid");
      return secret;
    } finally {
      await handle.close();
    }
  }
}
