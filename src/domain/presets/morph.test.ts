import { describe, expect, it } from "vitest";

import type { FrameClock } from "../types/frame.ts";
import {
  EMPTY_MORPH_RECORDS_JSON,
  MAX_MORPH_RECORDS,
  easeMorph,
  morphProgress,
  morphRunning,
  nextMorphRecords,
  parseMorphRecords,
  sameStored,
  serializeMorphRecords,
  type MorphRecord,
} from "./morph.ts";

/**
 * T1497b (§T1398b S2) — the morph record as DATA: its curves, its parser, and what a
 * recall does to the records already in the document.
 *
 * The bookkeeping tests are written against the PICTURE each rule protects — which keys
 * a record may still fade afterwards — because every rule here exists to stop a fade that
 * has ended from coming back: that is what "the older record simply stops mattering once
 * the newer one reaches p = 1" (the design doc §5.3) has to survive a tidy-up to mean.
 */

const EPOCH = "session-1";
const at = (absTimeSeconds: number): FrameClock => ({ epoch: EPOCH, absTimeSeconds });

function record(preset: string, start: number, seconds: number, keys: Record<string, readonly [number, number]>, epoch = EPOCH): MorphRecord {
  const from: Record<string, number> = {};
  const to: Record<string, number> = {};
  for (const [key, [before, after]] of Object.entries(keys)) {
    from[key] = before;
    to[key] = after;
  }
  return { epoch, start, seconds, curve: "linear", preset, from: { level1: from }, to: { level1: to } };
}

const keysOf = (records: readonly MorphRecord[]): string[][] => records.map((each) => Object.keys(each.to["level1"] ?? {}));

describe("the curves of the design doc §5.1", () => {
  it("are the four stated functions of progress, pinned at both ends", () => {
    expect(easeMorph("linear", 0.25)).toBe(0.25);
    // 3p² − 2p³
    expect(easeMorph("smooth", 0.25)).toBe(0.25 * 0.25 * (3 - 2 * 0.25));
    expect(easeMorph("smooth", 0.5)).toBe(0.5);
    expect(easeMorph("in", 0.5)).toBe(0.25);
    // 1 − (1 − p)²
    expect(easeMorph("out", 0.5)).toBe(0.75);
    for (const curve of ["linear", "smooth", "in", "out"] as const) {
      expect(easeMorph(curve, 0)).toBe(0);
      expect(easeMorph(curve, 1)).toBe(1);
      // Outside 0..1 is clamped: a frame before the recall, a frame long after it.
      expect(easeMorph(curve, -3)).toBe(0);
      expect(easeMorph(curve, 7)).toBe(1);
    }
  });

  it("measure progress on the absolute clock, and another epoch is finished", () => {
    const fade = record("riot", 2, 4, { brightness: [0.2, 0.8] });
    expect(morphProgress(fade, 2)).toBe(0);
    expect(morphProgress(fade, 3)).toBe(0.25);
    expect(morphProgress(fade, 6)).toBe(1);
    expect(morphRunning(fade, at(5.99))).toBe(true);
    expect(morphRunning(fade, at(6))).toBe(false);
    // The render that zeroed the clock reads 3 s too — and must NOT replay this fade.
    expect(morphRunning(fade, { epoch: "a-render", absTimeSeconds: 3 })).toBe(false);
  });
});

describe("the `morphs` parameter", () => {
  it("round-trips, and reads blank text as nothing fading", () => {
    const fade = record("riot", 2, 4, { brightness: [0.2, 0.8] });
    expect(parseMorphRecords(serializeMorphRecords([fade]))).toEqual([fade]);
    expect(parseMorphRecords(EMPTY_MORPH_RECORDS_JSON)).toEqual([]);
    expect(parseMorphRecords("")).toEqual([]);
    expect(parseMorphRecords(undefined)).toEqual([]);
  });

  it("drops what it cannot read instead of refusing: a broken record is a fade that does not run", () => {
    const fade = record("riot", 2, 4, { brightness: [0.2, 0.8] });
    const text = JSON.stringify({ version: 1, records: [{ ...fade, curve: "bouncy" }, fade, { epoch: 7 }, "nonsense"] });
    expect(parseMorphRecords(text)).toEqual([fade]);
    expect(parseMorphRecords("{ not json")).toEqual([]);
    expect(parseMorphRecords(JSON.stringify({ version: 2, records: [fade] }))).toEqual([]);
  });

  it("compares stored forms by structure, so a slot that went through JSON still matches", () => {
    const slot = { mode: "expression", bindings: { static: { kind: "static", value: 0.5 }, expression: { kind: "expression", source: "time" } } };
    const reordered = JSON.parse(JSON.stringify({ bindings: { expression: slot.bindings.expression, static: slot.bindings.static }, mode: "expression" })) as unknown;
    expect(sameStored(slot, reordered)).toBe(true);
    expect(sameStored([1, 0.5, 0, 1], [1, 0.5, 0, 1])).toBe(true);
    expect(sameStored([1, 0.5, 0, 1], [1, 0.5, 0])).toBe(false);
    expect(sameStored(0.8, 0.8)).toBe(true);
    expect(sameStored(0.8, { mode: "static", bindings: { static: { kind: "static", value: 0.8 } } })).toBe(false);
  });
});

describe("what a recall does to the records already there (§5.2)", () => {
  it("appends its record and keeps the ones still running", () => {
    const running = record("dawn", 0, 10, { brightness: [0.2, 0.8] });
    const next = record("riot", 4, 2, { brightness: [0.8, 0.4] });
    const book = nextMorphRecords({ own: [running], others: new Map(), clock: at(4), applied: { level1: ["brightness"] }, record: next });
    expect(book.own).toEqual([running, next]);
    expect(book.dropped).toEqual([]);
    expect(book.others.size).toBe(0);
  });

  it("drops a finished record, and a record from another epoch", () => {
    const finished = record("dawn", 0, 1, { brightness: [0.2, 0.8] });
    const stale = record("noon", 0, 60, { contrast: [1, 2] }, "last-week");
    const next = record("riot", 4, 2, { brightness: [0.8, 0.4] });
    const book = nextMorphRecords({ own: [stale, finished], others: new Map(), clock: at(4), applied: { level1: ["brightness"] }, record: next });
    expect(book.own).toEqual([next]);
    expect(book.dropped).toEqual([]);
  });

  /**
   * THE BUG THIS RULE EXISTS FOR. A long fade (10 s) is overtaken on the same key by a
   * short one (1 s) heading to the SAME value — recalling the preset again, in a hurry.
   * The short one finishes and, while it sits in the list, stops the long one mattering.
   * The next recall tidies it away. If that is ALL the tidy-up did, the long record would
   * be the newest one on that key again, its `to` would still equal what is stored, and
   * three seconds after the picture arrived it would jump back to 30 % of the way there.
   */
  it("a finished record takes its keys out of every OLDER record when it goes", () => {
    const long = record("bright", 0, 10, { brightness: [0.2, 0.8], contrast: [1, 2] });
    const hurry = record("bright", 2, 1, { brightness: [0.38, 0.8] });
    const other = record("gamma", 3.5, 2, { gamma1: [1, 2] });
    const book = nextMorphRecords({ own: [long, hurry], others: new Map(), clock: at(3.5), applied: { level1: ["gamma1"] }, record: other });
    // `hurry` is gone; `long` keeps fading contrast and has LOST brightness.
    expect(book.own.map((each) => each.preset)).toEqual(["bright", "gamma"]);
    expect(keysOf(book.own)).toEqual([["contrast"], ["gamma1"]]);
    expect(book.own[0]?.from).toEqual({ level1: { contrast: 1 } });
  });

  it("does the same across banks: a look's long fade loses the key a shot's fade finished on", () => {
    const look = record("bright", 0, 10, { brightness: [0.2, 0.8], contrast: [1, 2] });
    const shot = record("drop", 2, 1, { brightness: [0.38, 0.8] });
    const next = record("intro", 3.5, 2, { gamma1: [1, 2] });
    const book = nextMorphRecords({ own: [shot], others: new Map([["looks", [look]]]), clock: at(3.5), applied: { level1: ["gamma1"] }, record: next });
    expect(book.own).toEqual([next]);
    expect([...book.others.keys()]).toEqual(["looks"]);
    expect(keysOf(book.others.get("looks") ?? [])).toEqual([["contrast"]]);
  });

  it("leaves another bank alone when nothing of its records is superseded", () => {
    const look = record("bright", 0, 10, { contrast: [1, 2] });
    const next = record("intro", 3.5, 2, { gamma1: [1, 2] });
    const book = nextMorphRecords({ own: [], others: new Map([["looks", [look]]]), clock: at(3.5), applied: { level1: ["gamma1"] }, record: next });
    expect(book.others.size).toBe(0);
  });

  it("a CUT ends every fade on the keys it writes, in every bank — even when it changes nothing stored", () => {
    const own = record("bright", 0, 10, { brightness: [0.2, 0.8], contrast: [1, 2] });
    const elsewhere = record("drop", 1, 10, { brightness: [0.26, 0.8] });
    const book = nextMorphRecords({ own: [own], others: new Map([["shots", [elsewhere]]]), clock: at(2), applied: { level1: ["brightness"] }, record: null });
    expect(keysOf(book.own)).toEqual([["contrast"]]);
    // The other bank's record covered only that key, so nothing is left of it.
    expect(book.others.get("shots")).toEqual([]);
  });

  it("a cut with no clock (headless) still ends the fades on its keys", () => {
    const own = record("bright", 0, 10, { brightness: [0.2, 0.8] });
    const book = nextMorphRecords({ own: [own], others: new Map(), clock: undefined, applied: { level1: ["brightness"] }, record: null });
    expect(book.own).toEqual([]);
  });

  it(`keeps at most ${String(MAX_MORPH_RECORDS)}: the oldest running record is dropped and named`, () => {
    const running = [0, 1, 2, 3].map((index) => record(`p${String(index)}`, index, 60, { [`k${String(index)}`]: [0, 1] }));
    const next = record("p4", 4, 60, { k4: [0, 1] });
    const book = nextMorphRecords({ own: running, others: new Map(), clock: at(4), applied: { level1: ["k4"] }, record: next });
    expect(book.own.map((each) => each.preset)).toEqual(["p1", "p2", "p3", "p4"]);
    expect(book.dropped.map((each) => each.preset)).toEqual(["p0"]);
  });
});
