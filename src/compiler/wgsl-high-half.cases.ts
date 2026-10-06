/**
 * B263 — THE MEASURED TABLE: which integer divides and remainders an Apple GPU gets wrong.
 *
 * One list, three readers, so they cannot drift:
 *
 *  - `wgsl-high-half.test.ts`: the detector's verdict on each line's text must be the verdict
 *    measured on the device. Every "right" line is a legitimate way to write the thing, and
 *    a warning on one would teach authors to ignore the warning;
 *  - `tools/apple-gpu-divide-canary.mjs`: runs every line on the device again and says which
 *    verdicts still hold, for after an OS, driver or browser bump;
 *  - `docs/apple-gpu-divide-high-half-2026-10-06.md`: the two lists in prose.
 *
 * Each line is a WGSL expression of type u32 over `x`, a u32 the shader cannot know (read
 * from a buffer), and `d`, a u32 from a buffer whose value is 97. `cpu` is the same line on
 * the CPU. `measured` is what Dawn on Metal returned on an Apple M3 Max, macOS 26.3.1, on
 * 2026-10-06, over 512 values of `x` of every size: "wrong" where any value differed from
 * the CPU (about 500 of 512 did, on every wrong line), "right" where none did.
 *
 * Plain data and plain functions, with no import: the canary loads this file as it is.
 */
export interface HighHalfCase {
  readonly wgsl: string;
  readonly cpu: (x: number) => number;
  readonly measured: "wrong" | "right";
  /** What the line shows, where its text does not say. */
  readonly note?: string;
  /**
   * Wrong on the device with nothing in the text to show it: the compiler finds the constant
   * by itself. The detector reads text and does not flag it; listed so that nobody takes the
   * detector's silence for a measurement.
   */
  readonly unseen?: true;
}

const hi = (x: number): number => x >>> 16;
const div = (a: number, b: number): number => Math.floor(a / b);

export const HIGH_HALF_CASES: ReadonlyArray<HighHalfCase> = [
  /* WRONG: the whole high half, divided by a constant that is not a power of two. */
  { wgsl: "(x >> 16u) / 97u", cpu: (x) => div(hi(x), 97), measured: "wrong" },
  { wgsl: "(x >> 16u) % 97u", cpu: (x) => hi(x) % 97, measured: "wrong" },
  { wgsl: "(x >> 16u) % 100u", cpu: (x) => hi(x) % 100, measured: "wrong" },
  { wgsl: "(x >> 16u) / 3u", cpu: (x) => div(hi(x), 3), measured: "wrong" },
  { wgsl: "(x >> 16u) / 10u", cpu: (x) => div(hi(x), 10), measured: "wrong" },
  { wgsl: "(x >> 16u) / 255u", cpu: (x) => div(hi(x), 255), measured: "wrong" },
  { wgsl: "(x >> 16u) / 1000u", cpu: (x) => div(hi(x), 1000), measured: "wrong" },
  { wgsl: "(x / 65536u) % 97u", cpu: (x) => hi(x) % 97, measured: "wrong", note: "a divide by 65536 is the same shift" },
  { wgsl: "((x >> 8u) >> 8u) % 97u", cpu: (x) => hi(x) % 97, measured: "wrong", note: "two shifts that add to 16" },
  { wgsl: "u32(i32(x >> 16u) % 97)", cpu: (x) => hi(x) % 97, measured: "wrong", note: "signed" },
  { wgsl: "((vec2u(x, x + 1u) >> vec2u(16u)) % vec2u(97u)).x", cpu: (x) => hi(x) % 97, measured: "wrong", note: "a vector" },
  { wgsl: "((x * 2654435761u) >> 16u) % 97u", cpu: (x) => (Math.imul(x, 2654435761) >>> 16) % 97, measured: "wrong", note: "the consumer's line: a multiplicative hash, then the lot" },
  { wgsl: "(x >> 16u) - ((x >> 16u) / 97u) * 97u", cpu: (x) => hi(x) % 97, measured: "wrong", note: "the remainder written out by hand" },
  { wgsl: "(x >> 16u) % (97u | (d & 0u))", cpu: (x) => hi(x) % 97, measured: "wrong", note: "the compiler folds the divisor back to 97", unseen: true },

  /* RIGHT: a power of two, a divisor the shader cannot know, or anything but the bare high half. */
  { wgsl: "(x >> 16u) / 64u", cpu: (x) => div(hi(x), 64), measured: "right", note: "a power of two" },
  { wgsl: "(x >> 16u) / d", cpu: (x) => div(hi(x), 97), measured: "right", note: "a divisor from a buffer" },
  { wgsl: "(x >> 16u) % d", cpu: (x) => hi(x) % 97, measured: "right", note: "a divisor from a buffer" },
  { wgsl: "x / 97u", cpu: (x) => div(x, 97), measured: "right", note: "the whole word" },
  { wgsl: "x % 100u", cpu: (x) => x % 100, measured: "right", note: "the whole word" },
  { wgsl: "(x >> 15u) / 97u", cpu: (x) => div(x >>> 15, 97), measured: "right", note: "17 bits" },
  { wgsl: "(x >> 17u) / 97u", cpu: (x) => div(x >>> 17, 97), measured: "right", note: "15 bits" },
  { wgsl: "(x >> 17u) % 97u", cpu: (x) => (x >>> 17) % 97, measured: "right", note: "15 bits" },
  { wgsl: "(x >> 20u) % 97u", cpu: (x) => (x >>> 20) % 97, measured: "right", note: "12 bits" },
  { wgsl: "(x >> 24u) / 7u", cpu: (x) => div(x >>> 24, 7), measured: "right", note: "8 bits" },
  { wgsl: "(x >> 25u) % 3u", cpu: (x) => (x >>> 25) % 3, measured: "right", note: "7 bits" },
  { wgsl: "(x & 65535u) / 97u", cpu: (x) => div(x & 65535, 97), measured: "right", note: "the low half" },
  { wgsl: "(x & 65535u) % 10u", cpu: (x) => (x & 65535) % 10, measured: "right", note: "the low half" },
  { wgsl: "(x % 65536u) / 97u", cpu: (x) => div(x % 65536, 97), measured: "right", note: "the low half" },
  { wgsl: "min(x, 65535u) / 97u", cpu: (x) => div(Math.min(x, 65535), 97), measured: "right" },
  { wgsl: "(x & 255u) % 10u", cpu: (x) => (x & 255) % 10, measured: "right" },
  { wgsl: "((x >> 16u) & 255u) % 10u", cpu: (x) => (hi(x) & 255) % 10, measured: "right", note: "a byte of the high half" },
  { wgsl: "((x >> 16u) & 4095u) % 97u", cpu: (x) => (hi(x) & 4095) % 97, measured: "right", note: "12 bits of the high half" },
  { wgsl: "((x >> 8u) & 255u) % 10u", cpu: (x) => ((x >>> 8) & 255) % 10, measured: "right" },
  { wgsl: "((x >> 8u) & 65535u) % 97u", cpu: (x) => ((x >>> 8) & 65535) % 97, measured: "right", note: "the middle 16 bits" },
  { wgsl: "((x >> 16u) + 1u) % 97u", cpu: (x) => (hi(x) + 1) % 97, measured: "right", note: "something between the shift and the divide" },
  { wgsl: "((x >> 16u) * 3u) % 97u", cpu: (x) => (hi(x) * 3) % 97, measured: "right", note: "something between the shift and the divide" },
  { wgsl: "extractBits(x, 16u, 16u) % 97u", cpu: (x) => hi(x) % 97, measured: "right", note: "the same bits, taken another way" },
  { wgsl: "u32(i32(x >> 17u) / 97)", cpu: (x) => div(x >>> 17, 97), measured: "right", note: "signed, 15 bits" },
  { wgsl: "u32(i32(x >> 17u) % 97)", cpu: (x) => (x >>> 17) % 97, measured: "right", note: "signed, 15 bits" },
  { wgsl: "u32(floor(f32(x >> 16u) / 97.0))", cpu: (x) => div(hi(x), 97), measured: "right", note: "a float divide" },
  { wgsl: "u32(f32(x >> 16u) - 97.0 * floor(f32(x >> 16u) / 97.0))", cpu: (x) => hi(x) % 97, measured: "right", note: "a float remainder" },
  { wgsl: "((x >> 16u) * 100u) >> 16u", cpu: (x) => (hi(x) * 100) >>> 16, measured: "right", note: "a scale: what hashLot is" },
  { wgsl: "((x >> 16u) * 97u) >> 16u", cpu: (x) => (hi(x) * 97) >>> 16, measured: "right", note: "a scale: what hashLot is" },
];
