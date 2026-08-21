import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { it } from "node:test";

const web = new URL("../web/", import.meta.url);

async function pngSize(name) {
  const png = await readFile(new URL(`public/${name}`, web));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  return [png.readUInt32BE(16), png.readUInt32BE(20)];
}

it("ships standalone edge-to-edge PWA metadata and correctly sized icons", async () => {
  const manifest = JSON.parse(await readFile(new URL("public/manifest.webmanifest", web), "utf8"));
  const html = await readFile(new URL("index.html", web), "utf8");

  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.match(html, /viewport-fit=cover/);
  assert.match(html, /apple-mobile-web-app-status-bar-style" content="default/);
  assert.deepEqual(await pngSize("apple-touch-icon.png"), [180, 180]);
  assert.deepEqual(await pngSize("icon-192.png"), [192, 192]);
  assert.deepEqual(await pngSize("icon-512.png"), [512, 512]);
  assert.deepEqual(await pngSize("icon-512-maskable.png"), [512, 512]);
});
