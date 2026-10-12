import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import http from "node:http";
import { after, describe, it } from "node:test";
import zlib from "node:zlib";
import { createServer, pickEncoding } from "./http.js";

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
}

describe("static files", () => {
  const app = createServer({ port: 0, auth: false });
  after(() => app.close());

  it("picks the best accepted encoding", () => {
    assert.equal(pickEncoding("gzip, deflate, br"), "br");
    assert.equal(pickEncoding("gzip, br;q=0"), "gzip");
    assert.equal(pickEncoding("identity"), null);
    assert.equal(pickEncoding(undefined), null);
  });

  it("compresses text, caches hashed assets forever, and revalidates the shell", async () => {
    await new Promise((resolve) => app.listen(resolve));
    const port = app.server.address().port;
    const shell = await get(port, "/", { "Accept-Encoding": "br" });
    assert.equal(shell.headers["content-encoding"], "br");
    assert.equal(shell.headers["cache-control"], "no-cache");
    assert.match(zlib.brotliDecompressSync(shell.body).toString(), /<div id="app">/);

    const asset = readdirSync(new URL("../dist/assets/", import.meta.url)).find((name) => name.endsWith(".js"));
    const js = await get(port, `/assets/${asset}`, { "Accept-Encoding": "gzip" });
    assert.equal(js.headers["content-encoding"], "gzip");
    assert.equal(js.headers["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(js.headers.vary, "Accept-Encoding");

    const plain = await get(port, `/assets/${asset}`);
    assert.equal(plain.headers["content-encoding"], undefined);
    assert.equal(plain.body.length, zlib.gunzipSync(js.body).length);
  });
});
