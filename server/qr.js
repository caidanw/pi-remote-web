/**
 * Minimal byte-mode QR encoder (versions 1-10, ISO/IEC 18004) for terminal pairing codes.
 * Vendored instead of adding a dependency; capacity is ample for pairing URLs.
 */

const ECC_CODEWORDS_PER_BLOCK = {
  L: [7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [10, 16, 26, 18, 24, 16, 18, 22, 22, 26],
  Q: [13, 22, 18, 26, 18, 24, 18, 22, 20, 24],
  H: [17, 28, 22, 16, 22, 28, 26, 26, 24, 28],
};
const ECC_BLOCKS = {
  L: [1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [1, 1, 1, 2, 2, 4, 4, 4, 5, 5],
  Q: [1, 1, 2, 2, 4, 4, 6, 6, 8, 8],
  H: [1, 1, 2, 4, 4, 4, 5, 6, 8, 8],
};
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346];
const ALIGNMENT = [
  [], [6, 18], [6, 22], [6, 26], [6, 30],
  [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50],
];
const ECC_FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

function gfMultiply(a, b) {
  let result = 0;
  for (let i = 7; i >= 0; i -= 1) {
    result = (result << 1) ^ ((result >>> 7) * 0x11d);
    result ^= ((b >>> i) & 1) * a;
  }
  return result & 0xff;
}

function generatorPolynomial(degree) {
  let poly = [1];
  for (let i = 0, root = 1; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMultiply(poly[j], root);
    }
    poly = next;
    root = gfMultiply(root, 2);
  }
  return poly.slice(1);
}

function eccCodewords(data, degree) {
  const generator = generatorPolynomial(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) result[i] ^= gfMultiply(generator[i], factor);
  }
  return result;
}

function dataCodewordCount(version, ecc) {
  return (
    TOTAL_CODEWORDS[version - 1] -
    ECC_CODEWORDS_PER_BLOCK[ecc][version - 1] * ECC_BLOCKS[ecc][version - 1]
  );
}

function chooseVersion(byteLength, ecc) {
  for (let version = 1; version <= 10; version += 1) {
    const headerBits = 4 + (version < 10 ? 8 : 16);
    if (dataCodewordCount(version, ecc) * 8 >= headerBits + byteLength * 8) return version;
  }
  throw new Error("Text is too long for a version 10 QR code");
}

function encodeCodewords(bytes, version, ecc) {
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);

  const capacityBits = dataCodewordCount(version, ecc) * 8;
  push(0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));
  }
  for (let pad = 0xec; data.length < capacityBits / 8; pad ^= 0xec ^ 0x11) data.push(pad);

  // Split into blocks, then interleave data and ECC codewords per the spec.
  const blockCount = ECC_BLOCKS[ecc][version - 1];
  const eccPerBlock = ECC_CODEWORDS_PER_BLOCK[ecc][version - 1];
  const shortBlockLength = Math.floor(data.length / blockCount);
  const longBlocks = data.length % blockCount;
  const dataBlocks = [];
  const eccBlocks = [];
  for (let i = 0, offset = 0; i < blockCount; i += 1) {
    const length = shortBlockLength + (i >= blockCount - longBlocks ? 1 : 0);
    const block = data.slice(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    eccBlocks.push(eccCodewords(block, eccPerBlock));
  }
  const result = [];
  for (let i = 0; i < shortBlockLength + 1; i += 1) {
    for (const block of dataBlocks) if (i < block.length) result.push(block[i]);
  }
  for (let i = 0; i < eccPerBlock; i += 1) {
    for (const block of eccBlocks) result.push(block[i]);
  }
  return result;
}

function bchRemainder(value, generator, bitLength) {
  let result = value;
  for (let i = bitLength - 1; i >= 0; i -= 1) {
    if ((result >>> (i + generatorDegree(generator))) & 1) {
      result ^= generator << i;
    }
  }
  return result;
}

function generatorDegree(generator) {
  return 31 - Math.clz32(generator);
}

function newMatrix(size) {
  return Array.from({ length: size }, () => new Array(size).fill(null));
}

function placeFunctionPatterns(matrix, version) {
  const size = matrix.length;
  const setFinder = (row, column) => {
    for (let r = -1; r <= 7; r += 1) {
      for (let c = -1; c <= 7; c += 1) {
        const y = row + r;
        const x = column + c;
        if (y < 0 || y >= size || x < 0 || x >= size) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        matrix[y][x] = inRing || inCore;
      }
    }
  };
  setFinder(0, 0);
  setFinder(0, size - 7);
  setFinder(size - 7, 0);

  for (let i = 8; i < size - 8; i += 1) {
    matrix[6][i] = i % 2 === 0;
    matrix[i][6] = i % 2 === 0;
  }

  // Alignment patterns cover every center pair except the three that collide with finders.
  const centers = ALIGNMENT[version - 1];
  const last = centers.length - 1;
  for (const [i, row] of centers.entries()) {
    for (const [j, column] of centers.entries()) {
      const finderCorner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0);
      if (finderCorner) continue;
      for (let r = -2; r <= 2; r += 1) {
        for (let c = -2; c <= 2; c += 1) {
          matrix[row + r][column + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1;
        }
      }
    }
  }

  // Format-info area is reserved here and written after masking.
  for (let i = 0; i < 9; i += 1) {
    if (matrix[8][i] === null) matrix[8][i] = false;
    if (matrix[i][8] === null) matrix[i][8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    if (matrix[8][size - 1 - i] === null) matrix[8][size - 1 - i] = false;
    if (matrix[size - 1 - i][8] === null) matrix[size - 1 - i][8] = false;
  }
  matrix[size - 8][8] = true;

  if (version >= 7) {
    const bits = (version << 12) | bchRemainder(version << 12, 0x1f25, 12);
    for (let i = 0; i < 18; i += 1) {
      const bit = ((bits >>> i) & 1) === 1;
      matrix[Math.floor(i / 3)][size - 11 + (i % 3)] = bit;
      matrix[size - 11 + (i % 3)][Math.floor(i / 3)] = bit;
    }
  }
}

function placeData(matrix, codewords, reserved) {
  const size = matrix.length;
  let bitIndex = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let column = 0; column < 2; column += 1) {
        const x = right - column;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (reserved[y][x]) continue;
        const byte = codewords[bitIndex >>> 3];
        matrix[y][x] = byte !== undefined && ((byte >>> (7 - (bitIndex & 7))) & 1) === 1;
        bitIndex += 1;
      }
    }
  }
}

function maskBit(mask, row, column) {
  switch (mask) {
    case 0: return (row + column) % 2 === 0;
    case 1: return row % 2 === 0;
    case 2: return column % 3 === 0;
    case 3: return (row + column) % 3 === 0;
    case 4: return (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0;
    case 5: return ((row * column) % 2) + ((row * column) % 3) === 0;
    case 6: return (((row * column) % 2) + ((row * column) % 3)) % 2 === 0;
    default: return (((row + column) % 2) + ((row * column) % 3)) % 2 === 0;
  }
}

function writeFormatInfo(matrix, ecc, mask) {
  const size = matrix.length;
  const value = (ECC_FORMAT_BITS[ecc] << 3) | mask;
  const bits = (((value << 10) | bchRemainder(value << 10, 0x537, 10)) ^ 0x5412) & 0x7fff;
  const bit = (index) => ((bits >>> index) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) matrix[i][8] = bit(i);
  matrix[7][8] = bit(6);
  matrix[8][8] = bit(7);
  matrix[8][7] = bit(8);
  for (let i = 9; i < 15; i += 1) matrix[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i += 1) matrix[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i += 1) matrix[size - 15 + i][8] = bit(i);
  matrix[size - 8][8] = true;
}

function penalty(matrix) {
  const size = matrix.length;
  let score = 0;
  const FINDER = [true, false, true, true, true, false, true, false, false, false, false];
  const line = (get) => {
    for (let a = 0; a < size; a += 1) {
      // Rule 2: runs of five or more same-coloured modules.
      let run = 1;
      for (let b = 1; b < size; b += 1) {
        if (get(a, b) === get(a, b - 1)) {
          run += 1;
        } else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
      // Rule 3: finder-like 1:1:3:1:1 pattern with four light modules on either side.
      for (let b = 0; b + FINDER.length <= size; b += 1) {
        const forward = FINDER.every((value, offset) => get(a, b + offset) === value);
        const backward = FINDER.every((value, offset) => get(a, b + FINDER.length - 1 - offset) === value);
        if (forward || backward) score += 40;
      }
    }
  };
  line((row, column) => matrix[row][column]);
  line((column, row) => matrix[row][column]);

  for (let row = 0; row < size - 1; row += 1) {
    for (let column = 0; column < size - 1; column += 1) {
      const value = matrix[row][column];
      if (
        value === matrix[row][column + 1] &&
        value === matrix[row + 1][column] &&
        value === matrix[row + 1][column + 1]
      ) score += 3;
    }
  }

  const dark = matrix.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return score;
}

/**
 * @param {string} text
 * @param {{ ecc?: "L" | "M" | "Q" | "H" }} [options]
 * @returns {boolean[][]} true = dark module
 */
export function encodeQr(text, options = {}) {
  const ecc = options.ecc ?? "M";
  if (!ECC_CODEWORDS_PER_BLOCK[ecc]) throw new Error(`Unsupported ECC level: ${ecc}`);
  const bytes = [...Buffer.from(String(text), "utf8")];
  const version = chooseVersion(bytes.length, ecc);
  const codewords = encodeCodewords(bytes, version, ecc);

  const size = 17 + version * 4;
  const base = newMatrix(size);
  placeFunctionPatterns(base, version);
  const reserved = base.map((row) => row.map((cell) => cell !== null));
  placeData(base, codewords, reserved);

  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = base.map((row, y) =>
      row.map((cell, x) => (reserved[y][x] ? cell : cell !== maskBit(mask, y, x))),
    );
    writeFormatInfo(candidate, ecc, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, matrix: candidate };
  }
  return best.matrix.map((row) => row.map(Boolean));
}

/**
 * Render with half-block characters so the code stays square in a terminal.
 * `ansi` forces black-on-white, which scanners need on dark terminal themes.
 * @param {boolean[][]} matrix
 * @param {number} [quietZone]
 * @param {{ ansi?: boolean }} [options]
 */
export function renderQr(matrix, quietZone = 2, options = {}) {
  const size = matrix.length + quietZone * 2;
  const at = (row, column) =>
    row >= quietZone &&
    column >= quietZone &&
    row < size - quietZone &&
    column < size - quietZone &&
    matrix[row - quietZone][column - quietZone];
  const lines = [];
  for (let row = 0; row < size; row += 2) {
    let line = "";
    for (let column = 0; column < size; column += 1) {
      const top = at(row, column);
      const bottom = at(row + 1, column);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    lines.push(options.ansi ? `\u001b[30;47m${line}\u001b[0m` : line);
  }
  return lines.join("\n");
}
