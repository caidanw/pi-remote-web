import assert from "node:assert/strict";
import { createECDH, createPublicKey, verify } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  PushNotifier,
  encryptPayload,
  turnNotification,
  validSubscription,
  vapidAuthorization,
} from "./push.js";

// RFC 8291 section 5 / appendix A.
const RFC = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  uaPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml" +
    "mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT" +
    "pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

const keys = { p256dh: RFC.uaPublic, auth: RFC.auth };

describe("web push", () => {
  it("encrypts exactly like the RFC 8291 example", () => {
    const ecdh = createECDH("prime256v1");
    ecdh.setPrivateKey(Buffer.from(RFC.asPrivate, "base64url"));
    const body = encryptPayload(RFC.plaintext, keys, { ecdh, salt: Buffer.from(RFC.salt, "base64url") });
    assert.equal(body.toString("base64url"), RFC.body);
  });

  it("signs a VAPID token the public key verifies, and stores keys privately", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "prw-push-"));
    try {
      const sent = [];
      const notifier = await new PushNotifier({
        file: path.join(dir, "push.json"),
        subject: "https://mac.example.ts.net",
        fetchImpl: async (url, init) => {
          sent.push({ url, init });
          return new Response("", { status: url.includes("gone") ? 410 : 201 });
        },
      }).init();
      assert.equal((await stat(path.join(dir, "push.json"))).mode & 0o777, 0o600);

      const endpoint = "https://web.push.apple.com/QAbc";
      const header = vapidAuthorization(endpoint, notifier.state.vapid, notifier.subject);
      const [, token, k] = header.match(/^vapid t=(\S+), k=(\S+)$/);
      const [h, c, s] = token.split(".");
      const claims = JSON.parse(Buffer.from(c, "base64url").toString());
      assert.equal(claims.aud, "https://web.push.apple.com");
      assert.equal(claims.sub, "https://mac.example.ts.net");
      const { d, ...publicJwk } = notifier.state.vapid.jwk;
      const ok = verify("sha256", Buffer.from(`${h}.${c}`), {
        key: createPublicKey({ key: publicJwk, format: "jwk" }),
        dsaEncoding: "ieee-p1363",
      }, Buffer.from(s, "base64url"));
      assert.equal(ok, true);
      assert.equal(k, notifier.publicKey);

      await notifier.subscribe({ endpoint, keys });
      await notifier.subscribe({ endpoint: "https://fcm.googleapis.com/fcm/send/gone", keys });
      await notifier.send({ title: "t" });
      assert.equal(sent.length, 2);
      assert.equal(sent[0].init.headers["Content-Encoding"], "aes128gcm");
      // 410 Gone drops the subscription; the live one stays.
      assert.deepEqual(notifier.state.subscriptions.map((sub) => sub.endpoint), [endpoint]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("only accepts browser push services with well-formed keys", () => {
    assert.ok(validSubscription({ endpoint: "https://fcm.googleapis.com/fcm/send/x", keys }));
    assert.equal(validSubscription({ endpoint: "https://127.0.0.1/x", keys }), null);
    assert.equal(validSubscription({ endpoint: "http://web.push.apple.com/x", keys }), null);
    assert.equal(validSubscription({ endpoint: "https://web.push.apple.com/x", keys: { p256dh: "AA", auth: RFC.auth } }), null);
  });

  it("describes a finished or failed turn", () => {
    const done = turnNotification({
      id: "s1",
      name: "Fix login",
      startedAt: 0,
      now: 252_000,
      message: { content: [{ type: "thinking", thinking: "x" }, { type: "text", text: "**All** tests pass." }] },
    });
    assert.deepEqual(done, { title: "Fix login", body: "Done in 4m 12s \u00b7 All tests pass.", url: "/sessions/s1", tag: "s1" });
    const failed = turnNotification({ id: "s2", message: { stopReason: "error", errorMessage: "rate limited" } });
    assert.equal(failed.title, "Pi");
    assert.equal(failed.body, "Stopped: rate limited");
  });
});
