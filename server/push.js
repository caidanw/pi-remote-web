import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";

const b64u = (bytes) => Buffer.from(bytes).toString("base64url");
const unb64u = (text) => Buffer.from(String(text), "base64url");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();

/**
 * RFC 8291 Web Push payload encryption (aes128gcm, single record).
 * `ecdh` and `salt` are injectable only so tests can replay the RFC vector.
 * @param {string | Buffer} plaintext
 * @param {{ p256dh: string; auth: string }} keys subscription keys (base64url)
 */
export function encryptPayload(plaintext, keys, { ecdh, salt = randomBytes(16) } = {}) {
  const server = ecdh ?? createECDH("prime256v1");
  if (!ecdh) server.generateKeys();
  const uaPublic = unb64u(keys.p256dh);
  const asPublic = server.getPublicKey();
  // computeSecret rejects points that are not on P-256 (RFC 8291 section 7).
  const prkKey = hmac(unb64u(keys.auth), server.computeSecret(uaPublic));
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = hmac(prkKey, Buffer.concat([keyInfo, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, record]);
}

/** RFC 8292 VAPID `Authorization` header for one push endpoint. */
export function vapidAuthorization(endpoint, vapid, subject, now = Date.now()) {
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u(
    JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject }),
  );
  const key = createPrivateKey({ key: vapid.jwk, format: "jwk" });
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), { key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${header}.${claims}.${b64u(signature)}, k=${vapid.publicKey}`;
}

// Trust boundary: the server POSTs to subscription endpoints, so only accept
// the browser push services rather than arbitrary (possibly internal) URLs.
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^web\.push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /\.notify\.windows\.com$/,
];

/** @param {unknown} value */
export function validSubscription(value) {
  const sub = /** @type {any} */ (value);
  if (!sub || typeof sub.endpoint !== "string") return null;
  let url;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || !PUSH_HOSTS.some((host) => host.test(url.hostname))) return null;
  const { p256dh, auth } = sub.keys ?? {};
  if (typeof p256dh !== "string" || typeof auth !== "string") return null;
  if (unb64u(p256dh).length !== 65 || unb64u(auth).length !== 16) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Notification for a finished turn.
 * @param {{ id: string; name?: string; startedAt?: number; message?: any; now?: number }} turn
 */
export function turnNotification({ id, name, startedAt, message, now = Date.now() }) {
  const took = typeof startedAt === "number" ? ` in ${formatDuration(now - startedAt)}` : "";
  const text = (Array.isArray(message?.content) ? message.content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join(" ")
    .replace(/[#*_`>]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
  const status = failed
    ? `Stopped${took}${message?.errorMessage ? `: ${message.errorMessage}` : ""}`
    : `Done${took}`;
  const body = text && !failed ? `${status} \u00b7 ${text}` : status;
  return {
    title: name || "Pi",
    body: body.length > 160 ? `${body.slice(0, 159)}\u2026` : body,
    url: `/sessions/${encodeURIComponent(id)}`,
    tag: id,
  };
}

/** VAPID identity plus the browsers subscribed to turn notifications. */
export class PushNotifier {
  /** @param {{ file: string; subject: string; fetchImpl?: typeof fetch }} options */
  constructor({ file, subject, fetchImpl = fetch }) {
    this.file = file;
    this.subject = subject;
    this.fetch = fetchImpl;
    /** @type {{ vapid: { publicKey: string; jwk: import("node:crypto").JsonWebKey }; subscriptions: { endpoint: string; keys: { p256dh: string; auth: string } }[] }} */
    this.state = { vapid: { publicKey: "", jwk: {} }, subscriptions: [] };
  }

  async init() {
    try {
      this.state = JSON.parse(await readFile(this.file, "utf8"));
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== "ENOENT") throw error;
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = privateKey.export({ format: "jwk" });
      const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
      this.state = { vapid: { publicKey, jwk }, subscriptions: [] };
      await this.#save();
    }
    return this;
  }

  get publicKey() {
    return this.state.vapid.publicKey;
  }

  /** @param {unknown} value */
  async subscribe(value) {
    const sub = validSubscription(value);
    if (!sub) {
      const error = new Error("Unsupported push subscription");
      // @ts-expect-error - transported to the browser
      error.status = 400;
      throw error;
    }
    this.state.subscriptions = [...this.state.subscriptions.filter((s) => s.endpoint !== sub.endpoint), sub];
    await this.#save();
  }

  /** @param {string} endpoint */
  async unsubscribe(endpoint) {
    this.state.subscriptions = this.state.subscriptions.filter((s) => s.endpoint !== endpoint);
    await this.#save();
  }

  /** @param {Record<string, unknown>} payload */
  async send(payload) {
    const body = JSON.stringify(payload);
    const gone = [];
    await Promise.all(
      this.state.subscriptions.map(async (sub) => {
        try {
          const res = await this.fetch(sub.endpoint, {
            method: "POST",
            headers: {
              TTL: "86400",
              Urgency: "normal",
              "Content-Encoding": "aes128gcm",
              "Content-Type": "application/octet-stream",
              Authorization: vapidAuthorization(sub.endpoint, this.state.vapid, this.subject),
            },
            body: encryptPayload(body, sub.keys),
          });
          // 404/410: the browser dropped this subscription.
          if (res.status === 404 || res.status === 410) gone.push(sub.endpoint);
          else if (!res.ok) console.error(`[pi-remote-web] push ${res.status}: ${await res.text()}`);
        } catch (error) {
          console.error("[pi-remote-web] push failed", error instanceof Error ? error.message : error);
        }
      }),
    );
    if (gone.length) {
      this.state.subscriptions = this.state.subscriptions.filter((s) => !gone.includes(s.endpoint));
      await this.#save();
    }
  }

  async #save() {
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(this.state), { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.file);
  }
}
