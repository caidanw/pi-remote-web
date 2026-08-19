import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { encodeQr, renderQr } from "./qr.js";

/** Fixtures were verified module-for-module against the `qrcode` npm package in byte mode. */
const PAIR_42_L = [
  "#######..#.##.#######",
  "#.....#..###..#.....#",
  "#.###.#.##.##.#.###.#",
  "#.###.#..#.#..#.###.#",
  "#.###.#...#.#.#.###.#",
  "#.....#.....#.#.....#",
  "#######.#.#.#.#######",
  "........##.##........",
  "###.########.##...#..",
  "##.##..##.....##.#.#.",
  "#.#.#.##....#...#####",
  ".##..#.##.....###..#.",
  "...#..##..#.#.#.#.#.#",
  "........##.#.#..###..",
  "#######.#..#.##.#####",
  "#.....#.#..###.#....#",
  "#.###.#.##.#.########",
  "#.###.#..#....#.##.#.",
  "#.###.#.#.#.#...#...#",
  "#.....#.##....#..#.#.",
  "#######.#...#.##...##",
];

const DIGESTS = [
  { text: "TEST123", ecc: "M", size: 21, digest: "d55ae4da5cf8062e" },
  {
    text: "https://caidans-macbook-pro-2023.skate-danio.ts.net/#pair=tX5b0x6oHe1w1_c2dBt_BbK3B7DRmclWZ-YgPTFFX8Y",
    ecc: "M",
    size: 41,
    digest: "b34c4203d49b18eb",
  },
  { text: "1234567890", ecc: "H", size: 25, digest: "56686dd5b4109053" },
  { text: "x".repeat(200), ecc: "L", size: 53, digest: "774c400e94c89f08" },
];

function render(matrix) {
  return matrix.map((row) => row.map((cell) => (cell ? "#" : ".")).join(""));
}

describe("qr encoder", () => {
  it("matches a reference byte-mode symbol module for module", () => {
    assert.deepEqual(render(encodeQr("PAIR-42", { ecc: "L" })), PAIR_42_L);
  });

  it("matches reference symbols across versions, ECC levels, and block layouts", () => {
    for (const { text, ecc, size, digest } of DIGESTS) {
      const rows = render(encodeQr(text, { ecc }));
      assert.equal(rows.length, size, text.slice(0, 16));
      assert.equal(
        createHash("sha256").update(rows.join("\n")).digest("hex").slice(0, 16),
        digest,
        text.slice(0, 16),
      );
    }
  });

  it("keeps finder, timing, and dark-module structure for every ECC level", () => {
    for (const ecc of ["L", "M", "Q", "H"]) {
      const matrix = encodeQr("pairing structure check", { ecc });
      const size = matrix.length;
      for (const [row, column] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        assert.equal(matrix[row][column], true);
        assert.equal(matrix[row + 1][column + 1], false);
        assert.equal(matrix[row + 3][column + 3], true);
      }
      for (let i = 8; i < size - 8; i += 1) {
        assert.equal(matrix[6][i], i % 2 === 0);
        assert.equal(matrix[i][6], i % 2 === 0);
      }
      assert.equal(matrix[size - 8][8], true, "dark module");
    }
  });

  it("encodes multi-byte text and rejects oversized input", () => {
    assert.equal(encodeQr("ünïcødé ✓ pairing", { ecc: "Q" }).length, 29);
    assert.throws(() => encodeQr("x".repeat(300), { ecc: "H" }), /too long/);
    assert.throws(() => encodeQr("x", { ecc: "Z" }), /Unsupported ECC/);
  });

  it("renders half-block rows with a quiet zone", () => {
    const lines = renderQr(encodeQr("PAIR-42", { ecc: "L" }), 2).split("\n");
    assert.equal(lines.length, Math.ceil((21 + 4) / 2));
    assert.ok(lines.every((line) => [...line].length === 25));
    assert.equal(lines[0].trim(), "");
    assert.ok(lines.some((line) => line.includes("█")));
  });

  it("forces black-on-white so dark terminal themes stay scannable", () => {
    const [first] = renderQr(encodeQr("PAIR-42", { ecc: "L" }), 2, { ansi: true }).split("\n");
    assert.ok(first.startsWith("\u001b[30;47m"));
    assert.ok(first.endsWith("\u001b[0m"));
  });
});
