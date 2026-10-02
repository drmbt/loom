import type { FrameClock } from "../types/frame.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { MORPH_CURVES, isStoredShape, type MorphCurve, type PresetValues } from "./bank.ts";

/**
 * T1497b (§T1398b S2) — THE MORPH RECORD: what a recall with a non-zero morph writes into
 * its bank's `morphs` parameter, in the same patch that commits the END state.
 *
 * ## What it is, and what it is not (the design doc §5.2)
 *
 * The destination is already in the document when this is written: the target parameters
 * hold their end values from the moment of the recall, so the inspector, Store, a save
 * and undo all see the destination. The record only describes the FADE the screen is
 * still to do — where each changed key came from, when the recall happened on the
 * transport's ABSOLUTE clock, and for how long. It is document state for the bank's own
 * reason (ruling 1): one undo removes the record together with the values it fades, and a
 * copy, an autosave and `get_node` carry it with nothing built for them.
 *
 * ## The clock, and the epoch (§5.4, §15 A — ruled: the absolute clock)
 *
 * `start` is `absTimeSeconds` of the last frame produced before the recall. That clock
 * advances only when frames are produced and runs through laps and seeks, so a fade
 * pauses with the transport and neither replays on a lap nor reverses on a scrub. It is
 * also ZEROED by a render, which is why a start time alone is not enough: `epoch` names
 * the run of the clock the stamp belongs to, and a record from any other epoch is
 * FINISHED. That one rule is what makes an export — and a reopened file — render the end
 * state, identically every time.
 *
 * ## This module is data only
 *
 * The shape, the parser, the curves and the bookkeeping a recall does on the list. No
 * graph, no registry, no resolver: `names.ts` imports it for the rename clause, so it
 * may not import anything that reaches back there. Which key fades on screen is
 * `morph-index.ts`; the blend itself is the resolver's (`resolve.ts`, §V61).
 */
export interface MorphRecord {
  /** The absolute clock's epoch at the recall. A record from another epoch is finished. */
  readonly epoch: string;
  /** `absTimeSeconds` of the last frame before the recall. */
  readonly start: number;
  readonly seconds: number;
  readonly curve: MorphCurve;
  /** The preset recalled, for a Panel's "morphing" mark and an agent's listing. */
  readonly preset: string;
  /** node NAME → key → the stored form BEFORE this recall, for every key it fades. */
  readonly from: PresetValues;
  /** node NAME → key → the stored form this recall WROTE; a later edit is one that differs. */
  readonly to: PresetValues;
}

/** A bank keeps at most this many records (the design doc §5.2). */
export const MAX_MORPH_RECORDS = 4;

/** What the `morphs` parameter holds, wrapped like the bank's own JSON so it can migrate. */
interface MorphRecordsFile {
  readonly version: 1;
  readonly records: readonly MorphRecord[];
}

/** The `morphs` parameter as written. Two-space indent: it is inspectable, like the bank. */
export function serializeMorphRecords(records: readonly MorphRecord[]): string {
  const file: MorphRecordsFile = { version: 1, records };
  return `${JSON.stringify(file, null, 2)}\n`;
}

/** What a bank with nothing fading holds. */
export const EMPTY_MORPH_RECORDS_JSON = serializeMorphRecords([]);

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseValues(raw: unknown): PresetValues | null {
  if (!plainObject(raw)) return null;
  const values: Record<string, Record<string, StoredParameter>> = {};
  for (const [nodeName, record] of Object.entries(raw)) {
    if (!plainObject(record)) return null;
    const keys: Record<string, StoredParameter> = {};
    for (const [key, stored] of Object.entries(record)) {
      if (!isStoredShape(stored)) return null;
      keys[key] = stored;
    }
    values[nodeName] = keys;
  }
  return values;
}

function parseRecord(raw: unknown): MorphRecord | null {
  if (!plainObject(raw)) return null;
  const { epoch, start, seconds, curve, preset } = raw;
  if (typeof epoch !== "string" || typeof preset !== "string") return null;
  if (typeof start !== "number" || !Number.isFinite(start)) return null;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return null;
  if (!MORPH_CURVES.includes(curve as MorphCurve)) return null;
  const from = parseValues(raw["from"]);
  const to = parseValues(raw["to"]);
  if (from === null || to === null) return null;
  return { epoch, start, seconds, curve: curve as MorphCurve, preset, from, to };
}

/**
 * The records a bank's `morphs` parameter holds. TOLERANT, unlike the bank parser: a
 * record that does not parse is a fade that will not run, and the document already holds
 * its end state — so it is dropped, never a reason to refuse a recall or a compile. The
 * field is "visible and inspectable, but not meant for typing" (the design doc §4.1).
 */
export function parseMorphRecords(text: unknown): MorphRecord[] {
  if (typeof text !== "string" || text.trim() === "") return [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return [];
  }
  if (!plainObject(raw) || raw["version"] !== 1 || !Array.isArray(raw["records"])) return [];
  const records: MorphRecord[] = [];
  for (const entry of raw["records"]) {
    const record = parseRecord(entry);
    if (record !== null) records.push(record);
  }
  return records;
}

/** The curves of the design doc §5.1, over progress 0..1. */
export function easeMorph(curve: MorphCurve, progress: number): number {
  const p = Math.min(1, Math.max(0, progress));
  switch (curve) {
    case "linear":
      return p;
    case "smooth":
      return p * p * (3 - 2 * p);
    case "in":
      return p * p;
    case "out":
      return 1 - (1 - p) * (1 - p);
  }
}

/** Raw progress of a record at an absolute time, 0..1. A zero-length record is finished. */
export function morphProgress(record: MorphRecord, absTimeSeconds: number): number {
  if (!(record.seconds > 0)) return 1;
  return Math.min(1, Math.max(0, (absTimeSeconds - record.start) / record.seconds));
}

/** Whether a record still has a fade to do on this clock. Another epoch never does. */
export function morphRunning(record: MorphRecord, clock: FrameClock): boolean {
  return record.epoch === clock.epoch && morphProgress(record, clock.absTimeSeconds) < 1;
}

/**
 * Two stored forms, compared by STRUCTURE. A record's `to` has been through JSON and the
 * document's slot has not, so key order and object identity mean nothing here; numbers
 * survive that round trip exactly, so `===` on them is the honest comparison.
 */
export function sameStored(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => sameStored(entry, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false;
  return keys.every((key) => sameStored(left[key], right[key]));
}

/** `node NAME → keys`, the shape every "which keys" question below is asked in. */
export type MorphKeys = Readonly<Record<string, readonly string[]>>;

/** The keys a record covers. */
export function morphKeysOf(record: MorphRecord): MorphKeys {
  return Object.fromEntries(Object.entries(record.to).map(([nodeName, keys]) => [nodeName, Object.keys(keys)]));
}

/** A record with `keys` removed from both ends, or `null` when nothing is left of it. */
function withoutKeys(record: MorphRecord, keys: MorphKeys): MorphRecord | null {
  const strip = (values: PresetValues): Record<string, Record<string, StoredParameter>> => {
    const next: Record<string, Record<string, StoredParameter>> = {};
    for (const [nodeName, stored] of Object.entries(values)) {
      const gone = new Set(keys[nodeName] ?? []);
      const kept = Object.fromEntries(Object.entries(stored).filter(([key]) => !gone.has(key)));
      if (Object.keys(kept).length > 0) next[nodeName] = kept;
    }
    return next;
  };
  const to = strip(record.to);
  if (Object.keys(to).length === 0) return null;
  return { ...record, from: strip(record.from), to };
}

const coversAny = (record: MorphRecord, keys: MorphKeys): boolean =>
  Object.entries(keys).some(([nodeName, list]) => list.some((key) => record.to[nodeName]?.[key] !== undefined));

export interface MorphBookkeepingInput {
  /** The recalled bank's records, as its `morphs` parameter holds them. */
  readonly own: readonly MorphRecord[];
  /** Every OTHER bank's records, by bank node id. */
  readonly others: ReadonlyMap<string, readonly MorphRecord[]>;
  /** The frame clock at the recall; `undefined` on a bus with no app (headless). */
  readonly clock: FrameClock | undefined;
  /** Every key this recall wrote. */
  readonly applied: MorphKeys;
  /** The record this recall adds, or `null` when it is a cut. */
  readonly record: MorphRecord | null;
}

export interface MorphBookkeeping {
  /** The recalled bank's records after the recall, oldest first. */
  readonly own: readonly MorphRecord[];
  /** The other banks whose records lost keys, by bank node id. Untouched banks are absent. */
  readonly others: ReadonlyMap<string, readonly MorphRecord[]>;
  /** Records of this bank still running that the cap of four pushed out, oldest first. */
  readonly dropped: readonly MorphRecord[];
}

/**
 * What a recall does to the records already in the document (the design doc §5.2), as a
 * pure function — the planner writes the result into the same patch.
 *
 * The four things, in order:
 *
 *  1. THIS BANK'S FINISHED RECORDS GO — and take with them, from every OLDER record in any
 *     bank, the keys they covered. That second half is not housekeeping. A finished record
 *     is what stops an older, longer fade on the same key from mattering (§5.3: "the older
 *     record simply stops mattering once the newer one reaches p = 1"); delete it alone
 *     and the older record is suddenly the newest one on that key again, its `to` may well
 *     equal what is stored, and the picture jumps back into a fade that ended a minute ago.
 *     Another epoch's records are finished by definition and simply go.
 *  2. A CUT ENDS EVERY FADE ON THE KEYS IT WRITES, in every bank. The edit rule (§5.3
 *     rule 2) only sees a cut that CHANGES the stored slot; recalling the preset a fade is
 *     already heading to changes nothing, and without this the "cut" would go on fading.
 *  3. The new record, if any, is appended.
 *  4. At most four stay: the oldest still-running ones are dropped and reported, and the
 *     keys only they covered jump to their end values.
 */
export function nextMorphRecords(input: MorphBookkeepingInput): MorphBookkeeping {
  interface Entry {
    readonly bank: string | null;
    readonly index: number;
    record: MorphRecord | null;
  }
  const { clock } = input;
  const entries: Entry[] = [];
  input.own.forEach((record, index) => {
    // Another epoch's record is finished; with no clock there is no epoch to judge by.
    if (clock === undefined || record.epoch === clock.epoch) entries.push({ bank: null, index, record });
  });
  for (const [bank, records] of input.others) {
    records.forEach((record, index) => entries.push({ bank, index, record }));
  }
  const touched = new Set<string>();
  const strip = (entry: Entry, keys: MorphKeys): void => {
    if (entry.record === null || !coversAny(entry.record, keys)) return;
    entry.record = withoutKeys(entry.record, keys);
    if (entry.bank !== null) touched.add(entry.bank);
  };

  if (clock !== undefined) {
    for (const finished of entries) {
      const record = finished.record;
      if (finished.bank !== null || record === null || morphRunning(record, clock)) continue;
      const keys = morphKeysOf(record);
      for (const older of entries) {
        if (older === finished || older.record === null || older.record.epoch !== record.epoch) continue;
        const before =
          older.record.start < record.start ||
          (older.bank === null && older.index < finished.index && older.record.start <= record.start);
        if (before) strip(older, keys);
      }
      finished.record = null;
    }
  }
  if (input.record === null) {
    for (const entry of entries) strip(entry, input.applied);
  }

  const kept = entries
    .filter((entry): entry is Entry & { record: MorphRecord } => entry.bank === null && entry.record !== null)
    .map((entry) => entry.record);
  if (input.record !== null) kept.push(input.record);
  const dropped = kept.splice(0, Math.max(0, kept.length - MAX_MORPH_RECORDS));

  const others = new Map<string, readonly MorphRecord[]>();
  for (const bank of [...touched].sort()) {
    others.set(
      bank,
      entries.filter((entry) => entry.bank === bank && entry.record !== null).map((entry) => entry.record as MorphRecord),
    );
  }
  return { own: kept, others, dropped };
}
