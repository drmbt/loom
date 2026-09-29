/**
 * A QR CODE ENCODER, ISO/IEC 18004, WRITTEN HERE (T1396b).
 *
 * ## Why this is a file and not a dependency
 *
 * The phone door shows a QR code carrying its pairing link (`https://<lan ip>:<port>/?t=<token>`)
 * so a phone on the same wifi can open it by pointing its camera at the editor. The owner
 * ruled no new npm dependency for that, and the encoder is small: one mode, one bit stream,
 * Reed–Solomon over GF(256), a fixed placement walk and eight masks. It is pure — no DOM,
 * no Node API, no clock — so it runs in the page and in a headless test alike.
 *
 * ## WHAT IS ENCODED, STATED RATHER THAN DISCOVERED
 *
 *  - BYTE MODE ONLY, the text as UTF-8, no ECI header. A pairing URL is lowercase ASCII and
 *    byte mode is what every phone camera reads it as; numeric/alphanumeric/kanji segments
 *    would make shorter symbols for other inputs and are not needed for this one.
 *  - Error correction L/M/Q/H, M by default (15 % of codewords recoverable — a screen
 *    photographed at an angle, with a glare stripe, still reads).
 *  - The SMALLEST version 1..40 that holds the bytes at the chosen level. The level is never
 *    raised to fill spare capacity: the caller asked for one, and gets that one.
 *  - Mask: the one with the lowest ISO penalty (N1..N4), evaluated with the format and
 *    version areas (and the dark module) still LIGHT — ISO/IEC 18004:2015 §7.8 masks and
 *    scores the symbol before format information is added. That is the convention of both
 *    reference encoders the tests compare against (segno, python-qrcode); an encoder that
 *    scores with the format bits drawn can choose a different, equally valid mask.
 *
 * Too-long text is an error that names the limit — never a silently truncated link.
 */

export type QrErrorCorrectionLevel = "L" | "M" | "Q" | "H";

export interface QrOptions {
  /** Error correction level; M when omitted. */
  readonly level?: QrErrorCorrectionLevel;
  /** Force a mask pattern 0..7 instead of choosing by penalty. For reference comparison. */
  readonly mask?: number;
}

export interface QrCode {
  /** Modules per side: 17 + 4 × version. */
  readonly size: number;
  /** `modules[row][column]`; true = dark. No quiet zone — that is the renderer's to add. */
  readonly modules: boolean[][];
  readonly version: number;
  readonly level: QrErrorCorrectionLevel;
  readonly mask: number;
}

const MIN_VERSION = 1;
const MAX_VERSION = 40;

/** Format-information value of each level (ISO Table 12) — not alphabetical, on purpose. */
const LEVEL_FORMAT_BITS: Readonly<Record<QrErrorCorrectionLevel, number>> = { L: 1, M: 0, Q: 3, H: 2 };
const LEVEL_INDEX: Readonly<Record<QrErrorCorrectionLevel, number>> = { L: 0, M: 1, Q: 2, H: 3 };

// ISO Table 9, per level [L, M, Q, H], indexed by version (index 0 unused).
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
const ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

/** Modules available to codewords (and remainder bits) once every function pattern is placed. */
function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2;
    result -= (25 * alignments - 10) * alignments - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

function dataCodewords(version: number, level: QrErrorCorrectionLevel): number {
  const index = LEVEL_INDEX[level];
  return (
    Math.floor(rawDataModules(version) / 8) -
    ECC_CODEWORDS_PER_BLOCK[index]![version]! * ERROR_CORRECTION_BLOCKS[index]![version]!
  );
}

/** Byte-mode character count indicator width (ISO Table 3). */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Most bytes a version holds at a level in byte mode: 4 mode bits + count bits + 8 per byte. */
function byteCapacity(version: number, level: QrErrorCorrectionLevel): number {
  return Math.floor((dataCodewords(version, level) * 8 - 4 - countBits(version)) / 8);
}

// --- GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11D) ---------------------

function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> bit) & 1) * x;
  }
  return z & 0xff;
}

/** Generator polynomial Π (x − α^i), i = 0..degree−1, highest term (always 1) dropped. */
function reedSolomonGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMultiply(result[j]!, root) ^ (j + 1 < degree ? result[j + 1]! : 0);
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}

function reedSolomonRemainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    for (let i = 0; i < generator.length; i += 1) result[i] = result[i]! ^ gfMultiply(generator[i]!, factor);
  }
  return result;
}

// --- bit stream ----------------------------------------------------------------------------

function dataCodewordStream(bytes: Uint8Array, version: number, level: QrErrorCorrectionLevel): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, countBits(version));
  for (const byte of bytes) push(byte, 8);
  const capacityBits = dataCodewords(version, level) * 8;
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  push(0, (8 - (bits.length % 8)) % 8);
  const codewords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j]!;
    codewords.push(byte);
  }
  for (let pad = 0xec; codewords.length < capacityBits / 8; pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** Split into blocks, append each block's ECC, interleave (ISO §7.6). */
function finalCodewords(data: readonly number[], version: number, level: QrErrorCorrectionLevel): number[] {
  const index = LEVEL_INDEX[level];
  const blockCount = ERROR_CORRECTION_BLOCKS[index]![version]!;
  const eccLength = ECC_CODEWORDS_PER_BLOCK[index]![version]!;
  const rawCodewords = Math.floor(rawDataModules(version) / 8);
  const shortBlocks = blockCount - (rawCodewords % blockCount);
  const shortBlockLength = Math.floor(rawCodewords / blockCount);
  const generator = reedSolomonGenerator(eccLength);

  const blocks: number[][] = [];
  let at = 0;
  for (let i = 0; i < blockCount; i += 1) {
    const dataLength = shortBlockLength - eccLength + (i < shortBlocks ? 0 : 1);
    const blockData = data.slice(at, at + dataLength);
    at += dataLength;
    const ecc = reedSolomonRemainder(blockData, generator);
    // Short blocks get a placeholder so every block has one data length for the interleave.
    if (i < shortBlocks) blockData.push(-1);
    blocks.push([...blockData, ...ecc]);
  }
  const result: number[] = [];
  for (let column = 0; column < blocks[0]!.length; column += 1) {
    for (const block of blocks) {
      const value = block[column]!;
      if (value >= 0) result.push(value);
    }
  }
  return result;
}

// --- the matrix ----------------------------------------------------------------------------

function alignmentPositions(version: number): number[] {
  if (version === 1) return [];
  const count = Math.floor(version / 7) + 2;
  const step = Math.floor((version * 8 + count * 3 + 5) / (count * 4 - 4)) * 2;
  const result = [6];
  for (let position = version * 4 + 10; result.length < count; position -= step) result.splice(1, 0, position);
  return result;
}

/** BCH(15,5) format information, masked with 0x5412 (ISO §7.9.1). */
function formatBits(level: QrErrorCorrectionLevel, mask: number): number {
  const data = (LEVEL_FORMAT_BITS[level] << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  return ((data << 10) | remainder) ^ 0x5412;
}

/** BCH(18,6) version information (ISO §7.10). */
function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

const MASKS: readonly ((row: number, column: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

interface Canvas {
  readonly size: number;
  readonly dark: boolean[][];
  /** True where a function pattern (or its reserved area) sits; masking skips these. */
  readonly reserved: boolean[][];
}

function blankCanvas(version: number): Canvas {
  const size = version * 4 + 17;
  const grid = (): boolean[][] => Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  return { size, dark: grid(), reserved: grid() };
}

function setFunction(canvas: Canvas, row: number, column: number, dark: boolean): void {
  canvas.dark[row]![column] = dark;
  canvas.reserved[row]![column] = true;
}

function drawFunctionPatterns(canvas: Canvas, version: number): void {
  const { size } = canvas;
  for (let i = 0; i < size; i += 1) {
    setFunction(canvas, 6, i, i % 2 === 0);
    setFunction(canvas, i, 6, i % 2 === 0);
  }
  // Finders with their separators: Chebyshev distance from the centre 2 or 4 is light.
  for (const [centreRow, centreColumn] of [[3, 3], [3, size - 4], [size - 4, 3]] as const) {
    for (let dr = -4; dr <= 4; dr += 1) {
      for (let dc = -4; dc <= 4; dc += 1) {
        const row = centreRow + dr;
        const column = centreColumn + dc;
        if (row < 0 || row >= size || column < 0 || column >= size) continue;
        const distance = Math.max(Math.abs(dr), Math.abs(dc));
        setFunction(canvas, row, column, distance !== 2 && distance !== 4);
      }
    }
  }
  const positions = alignmentPositions(version);
  const last = positions.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          setFunction(canvas, positions[i]! + dr, positions[j]! + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }
  // Format and version areas are RESERVED LIGHT here and drawn only after the mask is chosen.
  for (let i = 0; i < 9; i += 1) {
    if (i === 6) continue; // the timing patterns cross here
    setFunction(canvas, 8, i, false);
    setFunction(canvas, i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunction(canvas, 8, size - 1 - i, false);
    setFunction(canvas, size - 1 - i, 8, false);
  }
  if (version >= 7) {
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunction(canvas, b, a, false);
      setFunction(canvas, a, b, false);
    }
  }
}

/** The two-column zigzag from the bottom-right corner, skipping the vertical timing column. */
function placeCodewords(canvas: Canvas, codewords: readonly number[]): void {
  const { size } = canvas;
  let bit = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let step = 0; step < size; step += 1) {
      const row = upward ? size - 1 - step : step;
      for (let j = 0; j < 2; j += 1) {
        const column = right - j;
        if (canvas.reserved[row]![column]) continue;
        // Remainder bits past the last codeword stay light (ISO §7.7.3).
        if (bit < codewords.length * 8) {
          canvas.dark[row]![column] = ((codewords[bit >>> 3]! >>> (7 - (bit & 7))) & 1) === 1;
        }
        bit += 1;
      }
    }
  }
}

function applyMask(canvas: Canvas, mask: number): boolean[][] {
  const rule = MASKS[mask]!;
  return canvas.dark.map((line, row) =>
    line.map((dark, column) => (canvas.reserved[row]![column] ? dark : dark !== rule(row, column))),
  );
}

/**
 * 1:1:3:1:1 dark-light-dark-light-dark with four light modules before OR after it. Outside the
 * symbol counts as light (the quiet zone is), and occurrences are counted without overlap:
 * after a counted pattern the scan resumes past its seven modules.
 */
function finderLikeCount(line: readonly boolean[]): number {
  const size = line.length;
  const lightAt = (i: number): boolean => i < 0 || i >= size || !line[i];
  const pattern = [true, false, true, true, true, false, true];
  let count = 0;
  for (let start = 0; start + 7 <= size; ) {
    if (!pattern.every((dark, k) => line[start + k] === dark)) {
      start += 1;
      continue;
    }
    const lightBefore = [1, 2, 3, 4].every((k) => lightAt(start - k));
    const lightAfter = [0, 1, 2, 3].every((k) => lightAt(start + 7 + k));
    if (lightBefore || lightAfter) {
      count += 1;
      start += 7;
    } else {
      start += 1;
    }
  }
  return count;
}

/** ISO §7.8.3.1 penalty: N1 = 3, N2 = 3, N3 = 40, N4 = 10. */
export function penaltyScore(modules: readonly (readonly boolean[])[]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [];
  for (let i = 0; i < size; i += 1) {
    lines.push([...modules[i]!]);
    lines.push(modules.map((line) => line[i]!));
  }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) {
        run += 1;
        continue;
      }
      if (run >= 5) score += 3 + (run - 5);
      run = 1;
    }
    score += 40 * finderLikeCount(line);
  }
  let darkCount = 0;
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      const dark = modules[row]![column]!;
      if (dark) darkCount += 1;
      if (
        row + 1 < size &&
        column + 1 < size &&
        dark === modules[row]![column + 1] &&
        dark === modules[row + 1]![column] &&
        dark === modules[row + 1]![column + 1]
      ) {
        score += 3;
      }
    }
  }
  // N4: 10 per full 5 % the dark share is away from 50 % — |100·dark/total − 50| / 5, in integers.
  const total = size * size;
  score += 10 * Math.floor(Math.abs(20 * darkCount - 10 * total) / total);
  return score;
}

function drawFormatAndVersion(
  modules: boolean[][],
  version: number,
  level: QrErrorCorrectionLevel,
  mask: number,
): void {
  const size = modules.length;
  const format = formatBits(level, mask);
  const bit = (value: number, i: number): boolean => ((value >>> i) & 1) === 1;
  // Copy 1, around the top-left finder. `modules[row][column]`.
  for (let i = 0; i <= 5; i += 1) modules[i]![8] = bit(format, i);
  modules[7]![8] = bit(format, 6);
  modules[8]![8] = bit(format, 7);
  modules[8]![7] = bit(format, 8);
  for (let i = 9; i < 15; i += 1) modules[8]![14 - i] = bit(format, i);
  // Copy 2, split between the top-right and bottom-left finders.
  for (let i = 0; i < 8; i += 1) modules[8]![size - 1 - i] = bit(format, i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i]![8] = bit(format, i);
  modules[size - 8]![8] = true; // the dark module
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i += 1) {
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      modules[b]![a] = bit(bits, i);
      modules[a]![b] = bit(bits, i);
    }
  }
}

/** Encode `text` (as UTF-8, byte mode) into the smallest QR symbol that holds it. */
export function encodeQr(text: string, options: QrOptions = {}): QrCode {
  const level = options.level ?? "M";
  if (!(level in LEVEL_INDEX)) throw new Error(`encodeQr: unknown error correction level "${String(level)}"`);
  const forcedMask = options.mask;
  if (forcedMask !== undefined && !(Number.isInteger(forcedMask) && forcedMask >= 0 && forcedMask <= 7)) {
    throw new Error(`encodeQr: mask must be an integer 0..7, got ${forcedMask}`);
  }
  const bytes = new TextEncoder().encode(text);
  let version = MIN_VERSION;
  while (version <= MAX_VERSION && byteCapacity(version, level) < bytes.length) version += 1;
  if (version > MAX_VERSION) {
    throw new Error(
      `encodeQr: text is ${bytes.length} bytes of UTF-8; a QR code at error correction level ${level} ` +
        `holds at most ${byteCapacity(MAX_VERSION, level)} bytes (version ${MAX_VERSION})`,
    );
  }

  const canvas = blankCanvas(version);
  drawFunctionPatterns(canvas, version);
  placeCodewords(canvas, finalCodewords(dataCodewordStream(bytes, version, level), version, level));

  let mask = forcedMask ?? 0;
  let modules = applyMask(canvas, mask);
  if (forcedMask === undefined) {
    let best = penaltyScore(modules);
    for (let candidate = 1; candidate < 8; candidate += 1) {
      const masked = applyMask(canvas, candidate);
      const score = penaltyScore(masked);
      if (score < best) {
        best = score;
        mask = candidate;
        modules = masked;
      }
    }
  }
  drawFormatAndVersion(modules, version, level, mask);
  return { size: canvas.size, modules, version, level, mask };
}

/**
 * An SVG path `d` drawing every dark module as a unit square (horizontal runs merged), offset
 * by the quiet zone. The matching `viewBox` is `0 0 N N` with N = size + 2 × quietZone.
 */
export function qrToSvgPath(qr: Pick<QrCode, "size" | "modules">, options: { quietZone?: number } = {}): string {
  const quietZone = options.quietZone ?? 4;
  const parts: string[] = [];
  for (let row = 0; row < qr.size; row += 1) {
    let column = 0;
    while (column < qr.size) {
      if (!qr.modules[row]![column]) {
        column += 1;
        continue;
      }
      const start = column;
      while (column < qr.size && qr.modules[row]![column]) column += 1;
      parts.push(`M${start + quietZone} ${row + quietZone}h${column - start}v1h${start - column}z`);
    }
  }
  return parts.join("");
}
