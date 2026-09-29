import { describe, expect, it } from "vitest";

import { encodeQr, penaltyScore, qrToSvgPath, type QrErrorCorrectionLevel } from "./qr.ts";
import { QR_PAIRING_URL_ALL_MASKS, QR_REFERENCE_SYMBOLS } from "./qr.fixtures.ts";

/**
 * THE PHONE DOOR'S QR CODE (T1396b).
 *
 * What the consumer reads back is a phone camera decoding the pairing link, so the bar is:
 * the symbol is the one a reference encoder draws for the same text, level and mask, module
 * for module. The references in `qr.fixtures.ts` were produced OUTSIDE this repo (python-qrcode
 * for matrices, segno for the ISO penalty) and each was decoded back to its text by zxing-cpp
 * before it was written down — an encoder checked against itself agrees with itself.
 *
 * The structural checks below read the symbol the way a DECODER does (finders, timing,
 * BCH-checked format and version words), so a placement mistake that happened to agree with
 * nothing still has somewhere to fail.
 */

function hexRows(modules: readonly (readonly boolean[])[]): string[] {
  return modules.map((row) => {
    const bits = row.map((dark) => (dark ? "1" : "0")).join("");
    const padded = bits.padEnd(Math.ceil(bits.length / 4) * 4, "0");
    let hex = "";
    for (let i = 0; i < padded.length; i += 4) hex += parseInt(padded.slice(i, i + 4), 2).toString(16);
    return hex;
  });
}

function fromHexRows(rows: readonly string[], size: number): boolean[][] {
  return rows.map((hex) =>
    [...hex]
      .flatMap((digit) => parseInt(digit, 16).toString(2).padStart(4, "0").split(""))
      .slice(0, size)
      .map((bit) => bit === "1"),
  );
}

/** The symbol as the mask was scored: format words, version words and the dark module light. */
function withFormatAreasLight(modules: readonly (readonly boolean[])[], version: number): boolean[][] {
  const size = modules.length;
  const grid = modules.map((row) => [...row]);
  for (let i = 0; i < 9; i += 1) {
    if (i === 6) continue;
    grid[8]![i] = false;
    grid[i]![8] = false;
  }
  for (let i = 0; i < 8; i += 1) {
    grid[8]![size - 1 - i] = false;
    grid[size - 1 - i]![8] = false;
  }
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = size - 11; j < size - 8; j += 1) {
        grid[i]![j] = false;
        grid[j]![i] = false;
      }
    }
  }
  return grid;
}

/** Remainder of `value` (a polynomial over GF(2)) divided by `generator`. */
function gf2Remainder(value: number, generator: number): number {
  const degree = 31 - Math.clz32(generator);
  let remainder = value;
  while (remainder !== 0 && 31 - Math.clz32(remainder) >= degree) {
    remainder ^= generator << (31 - Math.clz32(remainder) - degree);
  }
  return remainder;
}

const LEVEL_OF_FORMAT_BITS: Readonly<Record<number, QrErrorCorrectionLevel>> = { 1: "L", 0: "M", 3: "Q", 2: "H" };

/** Both copies of the 15-bit format word as a decoder reads them (ISO §7.9.1, Figure 25). */
function readFormatWords(modules: readonly (readonly boolean[])[]): [number, number] {
  const size = modules.length;
  const at = (row: number, column: number): number => (modules[row]![column] ? 1 : 0);
  const aroundTopLeft = [
    ...[0, 1, 2, 3, 4, 5].map((row) => at(row, 8)),
    at(7, 8),
    at(8, 8),
    at(8, 7),
    ...[5, 4, 3, 2, 1, 0].map((column) => at(8, column)),
  ];
  const split = [
    ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => at(8, size - 1 - i)),
    ...[6, 5, 4, 3, 2, 1, 0].map((i) => at(size - 1 - i, 8)),
  ];
  const word = (bits: number[]): number => bits.reduce((value, bit, i) => value | (bit << i), 0);
  return [word(aroundTopLeft), word(split)];
}

function isFinderAt(modules: readonly (readonly boolean[])[], top: number, left: number): boolean {
  for (let dr = 0; dr < 7; dr += 1) {
    for (let dc = 0; dc < 7; dc += 1) {
      const ring = Math.max(Math.abs(dr - 3), Math.abs(dc - 3));
      if (modules[top + dr]![left + dc] !== (ring !== 2)) return false;
    }
  }
  return true;
}

const PAIRING_URL = QR_REFERENCE_SYMBOLS[0]!;

describe("the encoder draws the reference symbol, module for module", () => {
  for (const reference of QR_REFERENCE_SYMBOLS) {
    it(`${reference.name} (version ${reference.version}, mask ${reference.mask})`, () => {
      const qr = encodeQr(reference.text, {
        level: reference.level,
        ...(reference.forcedMask ? { mask: reference.mask } : {}),
      });
      expect(qr.version).toBe(reference.version);
      expect(qr.size).toBe(17 + 4 * reference.version);
      expect(qr.mask).toBe(reference.mask);
      expect(hexRows(qr.modules)).toEqual(reference.rows);
    });
  }

  it("draws the pairing URL under each of the eight masks exactly as the reference does", () => {
    for (let mask = 0; mask < 8; mask += 1) {
      const qr = encodeQr(PAIRING_URL.text, { level: PAIRING_URL.level, mask });
      expect({ mask, rows: hexRows(qr.modules) }).toEqual({ mask, rows: QR_PAIRING_URL_ALL_MASKS[mask] });
    }
  });
});

describe("the mask is the one with the lowest ISO penalty", () => {
  it("scores each of the pairing URL's eight masked symbols as the reference scorer does", () => {
    const size = 17 + 4 * PAIRING_URL.version;
    const scores = QR_PAIRING_URL_ALL_MASKS.map((rows) =>
      penaltyScore(withFormatAreasLight(fromHexRows(rows, size), PAIRING_URL.version)),
    );
    expect(scores).toEqual(PAIRING_URL.penalties);
  });

  it("picks the lowest-penalty mask — not mask 0, not the first it tried — for every auto symbol", () => {
    const auto = QR_REFERENCE_SYMBOLS.filter((reference) => !reference.forcedMask);
    expect(auto.length).toBeGreaterThanOrEqual(3);
    for (const reference of auto) {
      const penalties = reference.penalties!;
      const lowest = penalties.indexOf(Math.min(...penalties));
      // The fixture set is only a test of choice if the best mask varies and is not 0.
      expect(lowest).not.toBe(0);
      expect(encodeQr(reference.text, { level: reference.level }).mask).toBe(lowest);
    }
    const chosen = new Set(auto.map((reference) => reference.mask));
    expect(chosen.size).toBeGreaterThan(1);
  });
});

describe("a decoder can find and read the symbol", () => {
  const symbols = [
    encodeQr(PAIRING_URL.text),
    encodeQr("x".repeat(60), { level: "H", mask: 4 }),
    encodeQr("y".repeat(400), { level: "Q" }),
  ];

  it("has finder patterns in exactly three corners, with light separators", () => {
    for (const qr of symbols) {
      const far = qr.size - 7;
      expect(isFinderAt(qr.modules, 0, 0)).toBe(true);
      expect(isFinderAt(qr.modules, 0, far)).toBe(true);
      expect(isFinderAt(qr.modules, far, 0)).toBe(true);
      expect(isFinderAt(qr.modules, far, far)).toBe(false);
      for (let i = 0; i < 8; i += 1) {
        expect([qr.modules[7]![i], qr.modules[i]![7], qr.modules[7]![qr.size - 1 - i], qr.modules[qr.size - 8]![i]]).toEqual([false, false, false, false]);
      }
    }
  });

  it("has timing patterns alternating dark/light between the finders on row 6 and column 6", () => {
    for (const qr of symbols) {
      for (let i = 8; i < qr.size - 8; i += 1) {
        expect(qr.modules[6]![i]).toBe(i % 2 === 0);
        expect(qr.modules[i]![6]).toBe(i % 2 === 0);
      }
    }
  });

  it("carries two identical format words that pass the BCH check and name the level and mask", () => {
    for (const level of ["L", "M", "Q", "H"] as const) {
      for (let mask = 0; mask < 8; mask += 1) {
        const qr = encodeQr(PAIRING_URL.text, { level, mask });
        const [first, second] = readFormatWords(qr.modules);
        expect(first).toBe(second);
        const unmasked = first ^ 0x5412;
        expect(gf2Remainder(unmasked, 0x537)).toBe(0);
        expect(LEVEL_OF_FORMAT_BITS[unmasked >>> 13]).toBe(level);
        expect((unmasked >>> 10) & 0b111).toBe(mask);
        expect(qr.modules[qr.size - 8]![8]).toBe(true); // the dark module
      }
    }
  });

  it("carries, from version 7, two version words that pass the BCH check and name the version", () => {
    for (const qr of symbols.filter((symbol) => symbol.version >= 7)) {
      let belowTopRight = 0;
      let rightOfBottomLeft = 0;
      for (let i = 0; i < 18; i += 1) {
        const across = qr.size - 11 + (i % 3);
        const down = Math.floor(i / 3);
        belowTopRight |= (qr.modules[down]![across] ? 1 : 0) << i;
        rightOfBottomLeft |= (qr.modules[across]![down] ? 1 : 0) << i;
      }
      expect(belowTopRight).toBe(rightOfBottomLeft);
      expect(gf2Remainder(belowTopRight, 0x1f25)).toBe(0);
      expect(belowTopRight >>> 12).toBe(qr.version);
    }
    expect(symbols.some((symbol) => symbol.version >= 7)).toBe(true);
  });
});

describe("capacity", () => {
  it("fits an ~80-character pairing link at level M in a version a phone camera reads at a glance", () => {
    const link = `https://192.168.100.200:43921/?t=${"Ab3_".repeat(12)}`;
    expect(link.length).toBeGreaterThanOrEqual(80);
    const qr = encodeQr(link);
    expect(qr.level).toBe("M");
    expect(qr.version).toBeLessThanOrEqual(5);
  });

  it("takes the smallest version that holds the text: one byte past a version's capacity moves up one", () => {
    // Version 1 at M holds 14 bytes in byte mode (ISO Table 7).
    expect(encodeQr("x".repeat(14)).version).toBe(1);
    expect(encodeQr("x".repeat(15)).version).toBe(2);
  });

  it("fails loudly, naming the limit, when the text does not fit — counting UTF-8 bytes, not characters", () => {
    expect(encodeQr("x".repeat(2331)).version).toBe(40);
    expect(() => encodeQr("x".repeat(2332))).toThrow(/2332 bytes.*level M holds at most 2331 bytes \(version 40\)/);
    // 1166 characters, 2332 bytes: the limit is on the bytes the phone decodes.
    expect(() => encodeQr("é".repeat(1166))).toThrow(/2332 bytes.*at most 2331 bytes/);
    expect(() => encodeQr("x".repeat(2954), { level: "L" })).toThrow(/level L holds at most 2953 bytes/);
  });

  it("refuses a mask outside 0..7 rather than drawing an unreadable symbol", () => {
    expect(() => encodeQr("a", { mask: 8 })).toThrow(/mask must be an integer 0\.\.7/);
  });
});

describe("qrToSvgPath", () => {
  function paintedCells(d: string): Set<string> {
    const cells = new Set<string>();
    const unmatched = d.replace(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g, (_all, x: string, y: string, run: string, back: string) => {
      expect(back).toBe(run);
      for (let i = 0; i < Number(run); i += 1) cells.add(`${Number(x) + i},${y}`);
      return "";
    });
    expect(unmatched).toBe("");
    return cells;
  }

  it("paints exactly the dark modules, offset by the quiet zone (4 by default)", () => {
    const qr = encodeQr(PAIRING_URL.text);
    for (const [options, quiet] of [[{}, 4], [{ quietZone: 2 }, 2]] as const) {
      const expected = new Set<string>();
      qr.modules.forEach((row, y) =>
        row.forEach((dark, x) => {
          if (dark) expected.add(`${x + quiet},${y + quiet}`);
        }),
      );
      expect(paintedCells(qrToSvgPath(qr, options))).toEqual(expected);
    }
  });
});
