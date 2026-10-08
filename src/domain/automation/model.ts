/**
 * VN61 — AUTOMATION LANES: THE STORED SHAPE, ITS INVARIANTS, ITS IDS.
 *
 * A lane is a dumb, labelled value (Vincent, 2026-10-06): the playhead (or the node's
 * index) looked up against a curve and published as `op('<node>').chan.<lane name>`. It
 * knows nothing about who reads it; parameters REFERENCE it, TD's sense, and nothing here
 * keeps a list of them.
 *
 * Stored as ONE JSON text parameter on the `automation` node (the `cueList.cues`
 * precedent): an edit is an ordinary `setParameters`, so undo, autosave, copy, the agent
 * surface and the JSON editor all come for free, and no parameter type is added.
 *
 *     { "version": 1, "range"?: [startTicks, endTicks], "lanes": [ {
 *         "id", "name", "color", "min", "max", "clamp", "pre", "post", "stepped", "mute", "lock", "mutedValue"?,
 *         "keys": [ { "id", "t", "v", "interp", "power"?, "handle", "in": [dt, dv], "out": [dt, dv] } ] } ] }
 *
 * - `t` is integer TICKS (240 000/s, `src/domain/time/ticks.ts`), relative to the lane's
 *   container; the container starts at 0 until VN72 places regions in SMPTE time.
 * - `v` is NORMALIZED, 0..1. The lane's `min`/`max` map it to the published number
 *   (`min + v·(max − min)`), so a 0..1 opacity and a −360..360 rotation edit the same way
 *   and changing the range rescales the curve rather than clipping it.
 * - Handles are `(Δticks, Δvalue)` in those same normalized units, so a handle's feel does
 *   not change with the range (Keyframer's accel is in frame × value units and does).
 * - A key's `interp` governs the segment LEAVING it.
 * - `range` is the span the node's `fraction` index addresses; absent, it is derived (the
 *   earliest key to the latest across ALL lanes, `nodeSpan`).
 *
 * Invariants, enforced by `parseAutomation` (which REFUSES, naming what is wrong, rather
 * than repairing): at least one key per lane; keys strictly increasing in `t`; every
 * number finite; `v` in 0..1; `t` a whole tick; an out handle's Δt ≥ 0 and an in handle's
 * ≤ 0; lane names are identifiers and unique (they are channel names); lane ids unique in
 * the node and key ids unique in the lane. One thing is CLAMPED rather than refused: a
 * handle longer than its segment, because moving a neighbouring key legitimately shortens
 * the segment under it (Keyframer's rule); `evaluate.ts` scales it back along its own
 * direction so x(u) stays monotone.
 */

export const AUTOMATION_VERSION = 1;

/** TD's set (Animation COMP / Keyframer). */
export const TD_INTERPOLATIONS = [
  "constant",
  "linear",
  "ease",
  "easein",
  "easeout",
  "easep",
  "easeinp",
  "easeoutp",
  "cubic",
  "bezier",
] as const;

/** Robert Penner's families, each in / out / inOut (Blender's set). */
export const PENNER_FAMILIES = ["Sine", "Quad", "Cubic", "Quart", "Quint", "Expo", "Circ", "Back", "Elastic", "Bounce"] as const;
export type PennerFamily = (typeof PENNER_FAMILIES)[number];
export type PennerInterpolation = `${"in" | "out" | "inOut"}${PennerFamily}`;

export const PENNER_INTERPOLATIONS: readonly PennerInterpolation[] = PENNER_FAMILIES.flatMap((family) => [
  `in${family}` as const,
  `out${family}` as const,
  `inOut${family}` as const,
]);

export type Interpolation = (typeof TD_INTERPOLATIONS)[number] | PennerInterpolation;

export const INTERPOLATIONS: readonly Interpolation[] = [...TD_INTERPOLATIONS, ...PENNER_INTERPOLATIONS];

/** Free / Aligned are as stored; Vector / Auto / Auto-Clamped are derived from the neighbours. */
export const HANDLE_TYPES = ["free", "aligned", "vector", "auto", "autoClamped"] as const;
export type HandleType = (typeof HANDLE_TYPES)[number];

export const EXTRAPOLATIONS = ["constant", "linear", "cycle", "cycleOffset", "mirror"] as const;
export type Extrapolation = (typeof EXTRAPOLATIONS)[number];

/** `(Δticks, Δvalue)`, normalized value units. */
export type Handle = readonly [dt: number, dv: number];

export interface AutomationKey {
  readonly id: string;
  /** Whole ticks, relative to the lane's container. */
  readonly t: number;
  /** Normalized, 0..1. */
  readonly v: number;
  /** Governs the segment leaving this key. */
  readonly interp: Interpolation;
  /** The exponent of `easep` / `easeinp` / `easeoutp`. */
  readonly power: number;
  readonly handle: HandleType;
  readonly in: Handle;
  readonly out: Handle;
}

export interface AutomationLane {
  readonly id: string;
  /** The channel name: `op('<node>').chan.<name>`. An identifier, unique in the node. */
  readonly name: string;
  /** A colour TOKEN name (`accent`, `series-3`), never a literal (§V17). */
  readonly color: string;
  readonly min: number;
  readonly max: number;
  /** Hold the output inside min..max when an ease overshoots (back, elastic). Default on. */
  readonly clamp: boolean;
  readonly pre: Extrapolation;
  readonly post: Extrapolation;
  /** Every segment holds (constant), for integer and menu parameters. */
  readonly stepped: boolean;
  /**
   * A muted lane holds `mutedValue`: the value it had when it was muted (`mute.ts`
   * `setLaneMute` writes both), stored in the DOCUMENT so muting stays stateless and one
   * undo restores it (Vincent, 2026-10-07). It still publishes, so references resolve.
   */
  readonly mute: boolean;
  /**
   * Normalized, like `v`; absent (a hand-written or older text) falls back to the first
   * key's value. Outside 0..1 only when the lane does not clamp and was muted mid-overshoot.
   */
  readonly mutedValue?: number;
  /** Editor-only: the lane's keys refuse edits. Evaluation ignores it. */
  readonly lock: boolean;
  readonly keys: readonly AutomationKey[];
}

export interface AutomationDocument {
  readonly version: typeof AUTOMATION_VERSION;
  /** The span `fraction` addresses, in ticks; absent = derived from the keys (`nodeSpan`). */
  readonly range?: readonly [number, number];
  readonly lanes: readonly AutomationLane[];
}

export const EMPTY_AUTOMATION: AutomationDocument = { version: AUTOMATION_VERSION, lanes: [] };
export const EMPTY_AUTOMATION_JSON = serializeAutomation(EMPTY_AUTOMATION);

export type AutomationParse = { readonly ok: true; readonly document: AutomationDocument } | { readonly ok: false; readonly reason: string };

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Is `name` usable as a lane (channel) name: `op('x').chan.<name>` must parse. */
export function isLaneName(name: unknown): name is string {
  return typeof name === "string" && IDENTIFIER.test(name);
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Absent means the default; `null` (what JSON makes of NaN and Infinity) is a value, and is refused. */
const orDefault = (value: unknown, fallback: unknown): unknown => (value === undefined ? fallback : value);

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T, what: string): T | string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) return value as T;
  return `${what} must be one of ${allowed.join(", ")}; got ${JSON.stringify(value)}`;
}

function flag(value: unknown, fallback: boolean, what: string): boolean | string {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return `${what} must be true or false; got ${JSON.stringify(value)}`;
}

function handleOf(value: unknown, sign: 1 | -1, what: string): Handle | string {
  if (value === undefined) return [0, 0];
  if (!Array.isArray(value) || value.length !== 2 || !finite(value[0]) || !finite(value[1])) {
    return `${what} must be [Δticks, Δvalue], two finite numbers`;
  }
  if (value[0] * sign < 0) return `${what}'s Δticks must be ${sign > 0 ? "≥ 0 (an out handle points forward)" : "≤ 0 (an in handle points back)"}; got ${value[0]}`;
  return [value[0], value[1]];
}

function parseKey(entry: unknown, where: string): AutomationKey | string {
  if (!plainObject(entry)) return `${where} is not an object`;
  const { id, t, v } = entry;
  if (typeof id !== "string" || id === "") return `${where} needs an id`;
  const at = `${where} ("${id}")`;
  if (!finite(t) || !Number.isInteger(t)) return `${at}: t must be a whole number of ticks; got ${JSON.stringify(t)}`;
  if (!finite(v) || v < 0 || v > 1) return `${at}: v must be a normalized value in 0..1; got ${JSON.stringify(v)}`;
  const interp = oneOf(entry["interp"], INTERPOLATIONS, "bezier", `${at}: interp`);
  if (!(INTERPOLATIONS as readonly string[]).includes(interp)) return interp;
  const handle = oneOf(entry["handle"], HANDLE_TYPES, "autoClamped", `${at}: handle`);
  if (!(HANDLE_TYPES as readonly string[]).includes(handle)) return handle;
  const power = orDefault(entry["power"], 2);
  if (!finite(power) || power <= 0) return `${at}: power must be a positive number; got ${JSON.stringify(power)}`;
  const inHandle = handleOf(entry["in"], -1, `${at}: in`);
  if (typeof inHandle === "string") return inHandle;
  const outHandle = handleOf(entry["out"], 1, `${at}: out`);
  if (typeof outHandle === "string") return outHandle;
  return { id, t, v, interp: interp as Interpolation, power, handle: handle as HandleType, in: inHandle, out: outHandle };
}

function parseLane(entry: unknown, index: number): AutomationLane | string {
  if (!plainObject(entry)) return `lane ${index + 1} is not an object`;
  const { id, name } = entry;
  if (typeof id !== "string" || id === "") return `lane ${index + 1} needs an id`;
  if (!isLaneName(name)) {
    return `lane ${index + 1} ("${id}") needs a name that is an identifier (letters, digits and _, not starting with a digit): it is the channel name read as op('<node>').chan.<name>`;
  }
  const where = `lane "${name}"`;
  const color = orDefault(entry["color"], "accent");
  if (typeof color !== "string" || color === "") return `${where}: color must be a colour token name`;
  const min = orDefault(entry["min"], 0);
  const max = orDefault(entry["max"], 1);
  if (!finite(min) || !finite(max)) return `${where}: min and max must be finite numbers`;
  const pre = oneOf(entry["pre"], EXTRAPOLATIONS, "constant", `${where}: pre`);
  if (!(EXTRAPOLATIONS as readonly string[]).includes(pre)) return pre;
  const post = oneOf(entry["post"], EXTRAPOLATIONS, "constant", `${where}: post`);
  if (!(EXTRAPOLATIONS as readonly string[]).includes(post)) return post;
  const flags: Record<"clamp" | "stepped" | "mute" | "lock", boolean> = { clamp: true, stepped: false, mute: false, lock: false };
  for (const key of Object.keys(flags) as (keyof typeof flags)[]) {
    const parsed = flag(entry[key], flags[key], `${where}: ${key}`);
    if (typeof parsed === "string") return parsed;
    flags[key] = parsed;
  }
  const mutedValue = entry["mutedValue"];
  if (mutedValue !== undefined && !finite(mutedValue)) return `${where}: mutedValue must be a finite normalized value; got ${JSON.stringify(mutedValue)}`;
  const rawKeys = entry["keys"];
  if (!Array.isArray(rawKeys) || rawKeys.length === 0) return `${where} needs at least one key`;
  const keys: AutomationKey[] = [];
  const ids = new Set<string>();
  for (const [keyIndex, rawKey] of rawKeys.entries()) {
    const key = parseKey(rawKey, `${where}, key ${keyIndex + 1}`);
    if (typeof key === "string") return key;
    if (ids.has(key.id)) return `${where}: two keys have the id "${key.id}"`;
    ids.add(key.id);
    const previous = keys[keys.length - 1];
    if (previous !== undefined && key.t <= previous.t) {
      return `${where}: keys must be strictly increasing in time; key "${key.id}" at ${key.t} ticks does not follow "${previous.id}" at ${previous.t}`;
    }
    keys.push(key);
  }
  return { id, name, color, min, max, ...flags, ...(mutedValue === undefined ? {} : { mutedValue }), pre: pre as Extrapolation, post: post as Extrapolation, keys };
}

/**
 * The lanes text → a document, or the first thing wrong with it. Empty text is the empty
 * document (a fresh node has no lanes yet).
 */
export function parseAutomation(text: unknown): AutomationParse {
  if (typeof text !== "string" || text.trim() === "") return { ok: true, document: EMPTY_AUTOMATION };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the lanes field is not valid JSON" };
  }
  if (!plainObject(raw)) return { ok: false, reason: "the lanes field must be an object with version and lanes" };
  if (raw["version"] !== AUTOMATION_VERSION) return { ok: false, reason: `the lanes field has an unknown version (this build reads version ${AUTOMATION_VERSION})` };
  const rawLanes = raw["lanes"];
  if (!Array.isArray(rawLanes)) return { ok: false, reason: "the lanes field has no lanes list" };
  let range: readonly [number, number] | undefined;
  if (raw["range"] !== undefined) {
    const value = raw["range"];
    if (!Array.isArray(value) || value.length !== 2 || !Number.isInteger(value[0]) || !Number.isInteger(value[1]) || value[1] <= value[0]) {
      return { ok: false, reason: "range must be [startTicks, endTicks], whole ticks with end after start" };
    }
    range = [value[0] as number, value[1] as number];
  }
  const lanes: AutomationLane[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, entry] of rawLanes.entries()) {
    const lane = parseLane(entry, index);
    if (typeof lane === "string") return { ok: false, reason: lane };
    if (ids.has(lane.id)) return { ok: false, reason: `two lanes have the id "${lane.id}"` };
    if (names.has(lane.name)) return { ok: false, reason: `two lanes are named "${lane.name}": a name is a channel, so it must be unique in the node` };
    ids.add(lane.id);
    names.add(lane.name);
    lanes.push(lane);
  }
  return { ok: true, document: { version: AUTOMATION_VERSION, ...(range === undefined ? {} : { range }), lanes } };
}

/** Canonical text: every field written, fixed key order, so equal documents are equal strings. */
export function serializeAutomation(document: AutomationDocument): string {
  return JSON.stringify({
    version: document.version,
    ...(document.range === undefined ? {} : { range: [document.range[0], document.range[1]] }),
    lanes: document.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      color: lane.color,
      min: lane.min,
      max: lane.max,
      clamp: lane.clamp,
      pre: lane.pre,
      post: lane.post,
      stepped: lane.stepped,
      mute: lane.mute,
      lock: lane.lock,
      ...(lane.mutedValue === undefined ? {} : { mutedValue: lane.mutedValue }),
      keys: lane.keys.map((key) => ({
        id: key.id,
        t: key.t,
        v: key.v,
        interp: key.interp,
        ...(key.power === 2 ? {} : { power: key.power }),
        handle: key.handle,
        in: [key.in[0], key.in[1]],
        out: [key.out[0], key.out[1]],
      })),
    })),
  });
}

/**
 * A free id: `prefix` plus the smallest number not taken. Deterministic, so the same edit
 * on the same document mints the same id (§V44's spirit: no randomness in the document).
 */
export function freshId(prefix: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  for (let ordinal = 1; ; ordinal += 1) {
    const candidate = `${prefix}${ordinal}`;
    if (!used.has(candidate)) return candidate;
  }
}

export const freshLaneId = (document: AutomationDocument): string => freshId("lane", document.lanes.map((lane) => lane.id));
export const freshKeyId = (lane: AutomationLane): string => freshId("key", lane.keys.map((key) => key.id));

/** A key with the defaults the editor inserts: bezier, auto-clamped, handles derived. */
export function newKey(id: string, t: number, v: number, overrides: Partial<Omit<AutomationKey, "id" | "t" | "v">> = {}): AutomationKey {
  return { id, t, v, interp: "bezier", power: 2, handle: "autoClamped", in: [0, 0], out: [0, 0], ...overrides };
}

export function newLane(
  id: string,
  name: string,
  keys: readonly AutomationKey[],
  overrides: Partial<Omit<AutomationLane, "id" | "name" | "keys">> = {},
): AutomationLane {
  return { id, name, color: "accent", min: 0, max: 1, clamp: true, pre: "constant", post: "constant", stepped: false, mute: false, lock: false, ...overrides, keys };
}

/** A parameter's value → the lane's normalized 0..1 (a lane made from a parameter inherits its range). */
export function normalizeValue(lane: Pick<AutomationLane, "min" | "max">, value: number): number {
  const width = lane.max - lane.min;
  return width === 0 ? 0 : (value - lane.min) / width;
}

/** Normalized → what the channel publishes: `min + v·(max − min)`. */
export function denormalizeValue(lane: Pick<AutomationLane, "min" | "max">, v: number): number {
  return lane.min + v * (lane.max - lane.min);
}

/**
 * The span the `fraction` index addresses: the document's explicit `range`, else the
 * earliest key to the latest ACROSS ALL LANES. One span for the node, not one per lane
 * (orchestrator, 2026-10-07; TD's Animation COMP addresses its whole range): per-lane
 * spans would put lanes whose first and last keys differ at different times for the same
 * fraction, and a cue across them would come apart. Null when there is nothing to span.
 */
export function nodeSpan(document: AutomationDocument): readonly [number, number] | null {
  if (document.range !== undefined) return document.range;
  let start = Infinity;
  let end = -Infinity;
  for (const lane of document.lanes) {
    const first = lane.keys[0];
    const last = lane.keys[lane.keys.length - 1];
    if (first !== undefined) start = Math.min(start, first.t);
    if (last !== undefined) end = Math.max(end, last.t);
  }
  return Number.isFinite(start) && Number.isFinite(end) ? [start, end] : null;
}
