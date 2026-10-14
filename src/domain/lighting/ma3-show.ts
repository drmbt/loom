/**
 * VN131 — a grandMA3 show, played on the timeline and written out as DMX.
 *
 * The input is a `loom-ma3-show` file (`tools/ma3/package_show.py` packages it from a
 * read-only onPC dump): the patch, a DMX profile per fixture type, and the cue data and
 * timecode events of one song. Nothing in it is pre-rendered. `createMa3Playback` turns it
 * into a function of timeline time that answers with every universe's 512 slots, which is
 * exactly what an Art-Net or sACN receiver hands over. Whatever reads the DMX texture
 * downstream (the fixture decode in the stage previz) cannot tell a show file from a console.
 *
 * The playback model is a deliberately small part of MA3's engine:
 * - timecode events: Goto a cue and Go+ (next cue, wrapping only when the sequence wraps);
 * - a cue's fade (`CueInFade`) from what the sequence showed before, or from whatever lay under
 *   it for attributes the sequence did not hold;
 * - tracking (a tracking sequence's cue carries forward every value the earlier cues set);
 * - `Off Sequence N` cue commands, faded out over that sequence's OffCue fade (how a hit flashes);
 * - latest-takes-precedence between sequences, ordered by when each last fired;
 * - phasers: steps with speed (cycles per second), phase, width and transition.
 * Not modelled: MAtricks, preset resolution at playback (the cues carry the values the show
 * already cooked), cue delays, rates and speed masters, effects on non-dimmer attributes beyond
 * the step model above.
 *
 * Evaluation is a pure function of time: every call replays the events up to `t` from the top,
 * so scrubbing, looping and offline renders all agree with live playback.
 */

/** One fixture in the patch. `position` is in previz metres, Blender frame (Z up, audience -Y). */
export interface ShowFixture {
  readonly fid: number;
  readonly name: string;
  readonly layer: string;
  readonly type: string;
  readonly kind: string;
  readonly universe: number;
  readonly address: number;
  readonly position: readonly [number, number, number];
  /** The fixture's local basis (MVR u, v, w). Its beam leaves along -w. */
  readonly axes: readonly [readonly number[], readonly number[], readonly number[]];
}

export interface ProfileChannel {
  /** 1-based DMX offsets within the fixture's footprint: coarse, then fine for 16-bit. */
  readonly offset: readonly number[];
  /** MA3 sub-fixture path below the fixture ("" = the fixture itself, "1.5" = sub 1, cell 5). */
  readonly sub: string;
  readonly attr: string;
  /** Present for a physical attribute: values are in these units (degrees, Hz), not percent. */
  readonly physFrom?: number;
  readonly physTo?: number;
  /** Percent (or physical) value when nothing programs it. */
  readonly default?: number;
  /** Always the default, whatever the show programs (a shutter held open). */
  readonly fixed?: boolean;
  /** Read this attribute instead of `attr` (a CMY slot fed by the show's virtual RGB). */
  readonly source?: string;
  /** Write 100 % minus the value (RGB to CMY). */
  readonly invert?: boolean;
}

export interface FixtureProfile {
  readonly footprint: number;
  readonly kind: string;
  readonly source?: string;
  readonly confidence?: string;
  /** Sub-fixtures whose Dimmer has no DMX slot: MA multiplies them into what sits below them. */
  readonly virtualDimmers?: readonly string[];
  readonly channels: readonly ProfileChannel[];
  readonly [extra: string]: unknown;
}

type SetEntry = readonly [channel: number, value: number, phys?: number];
type PhaserEntry = readonly [channel: number, hz: number, phase: number, values: readonly number[], widths: readonly number[], transitions: readonly number[]];

export interface ShowCue {
  readonly no: number;
  readonly name: string;
  readonly fade: number;
  readonly off: readonly number[];
  readonly set: readonly SetEntry[];
  readonly release: readonly number[];
  readonly phasers: readonly PhaserEntry[];
}

export interface ShowSequence {
  readonly no: number;
  readonly name: string;
  readonly tracking: boolean;
  readonly wrap: boolean;
  readonly offFade: number;
  readonly cues: readonly ShowCue[];
}

/** `[t seconds from the song's start, sequence no, 0 goto | 1 go+, cue no]` */
export type ShowEvent = readonly [t: number, sequence: number, kind: number, cue: number];

export interface Ma3ShowFile {
  readonly format: "loom-ma3-show";
  readonly version: 1;
  readonly fixtures: readonly ShowFixture[];
  readonly types: Readonly<Record<string, FixtureProfile>>;
  readonly channels: readonly (readonly [fid: number, sub: string, attr: string])[];
  readonly sequences: readonly ShowSequence[];
  readonly timecode: { readonly name: string; readonly start: string; readonly events: readonly ShowEvent[] };
}

/** 512 slots per universe; universe N (1-based, as patched) is row N-1. */
export const DMX_SLOTS = 512;
/** The DMX texture's height: universes 1..128. Art-Net input will publish the same layout. */
export const DMX_UNIVERSES = 128;

/** The shortest release an Off gets (one frame at 30 fps). */
export const MIN_RELEASE_SECONDS = 1 / 30;

export class Ma3ShowError extends Error {}

/** Checks the outer shape; the packager is the authority on the rest. */
export function parseMa3Show(text: string): Ma3ShowFile {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Ma3ShowError(`not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const file = value as Partial<Ma3ShowFile> | null;
  if (file === null || typeof file !== "object" || file.format !== "loom-ma3-show") throw new Ma3ShowError("not a loom-ma3-show file (format field)");
  if (file.version !== 1) throw new Ma3ShowError(`unsupported loom-ma3-show version ${String(file.version)}`);
  for (const key of ["fixtures", "channels", "sequences"] as const) {
    if (!Array.isArray(file[key])) throw new Ma3ShowError(`missing ${key}`);
  }
  if (file.types === undefined || file.timecode === undefined || !Array.isArray(file.timecode.events)) throw new Ma3ShowError("missing types or timecode");
  for (const fixture of file.fixtures!) {
    if (file.types[fixture.type] === undefined) throw new Ma3ShowError(`fixture ${fixture.fid} names type "${fixture.type}", which the file does not define`);
  }
  return file as Ma3ShowFile;
}

// ------------------------------------------------------------------ compiled cue states

interface CueState {
  readonly fade: number;
  readonly off: readonly number[];
  /** Static values, tracking applied. */
  readonly channels: Int32Array;
  readonly values: Float32Array;
  /** Phasers, tracking applied. */
  readonly phasers: readonly PhaserEntry[];
}

interface CompiledSequence {
  readonly no: number;
  readonly name: string;
  readonly wrap: boolean;
  readonly offFade: number;
  readonly cueNumbers: readonly number[];
  readonly states: readonly CueState[];
}

function compileSequence(sequence: ShowSequence): CompiledSequence {
  const states: CueState[] = [];
  let tracked = new Map<number, number | PhaserEntry>();
  for (const cue of sequence.cues) {
    const current = sequence.tracking ? new Map(tracked) : new Map<number, number | PhaserEntry>();
    for (const channel of cue.release) current.delete(channel);
    for (const [channel, value] of cue.set) current.set(channel, value);
    for (const phaser of cue.phasers) current.set(phaser[0], phaser);
    tracked = current;
    const statics = [...current].filter((entry): entry is [number, number] => typeof entry[1] === "number");
    states.push({
      fade: cue.fade,
      off: cue.off,
      channels: Int32Array.from(statics, entry => entry[0]),
      values: Float32Array.from(statics, entry => entry[1]),
      phasers: [...current.values()].filter((entry): entry is PhaserEntry => typeof entry !== "number"),
    });
  }
  return { no: sequence.no, name: sequence.name, wrap: sequence.wrap, offFade: sequence.offFade, cueNumbers: sequence.cues.map(cue => cue.no), states };
}

/** One phaser's value `since` seconds after its cue fired. */
export function phaserValue(phaser: PhaserEntry, since: number): number {
  const [, hz, phase, values, widths, transitions] = phaser;
  const n = values.length;
  const u = (((since * hz + phase / 360) % 1) + 1) % 1;
  const position = u * n;
  const k = Math.min(Math.floor(position), n - 1);
  const f = position - k;
  const v0 = values[k]!;
  const v1 = values[(k + 1) % n]!;
  const width = (widths[k] ?? 100) / 100;
  if (width < 0.99) return f < width ? v0 : 0;   // a short step is a flash
  const share = (transitions[k] ?? 100) / 100;
  const cross = share > 0 ? Math.min(Math.max((f - (1 - share)) / share, 0), 1) : 0;
  return v0 + (v1 - v0) * cross;
}

// ------------------------------------------------------------------ DMX encoding

interface EncodedSlot {
  /** Index into the DMX buffer (row-major, universe-1 rows of 512). */
  readonly coarse: number;
  readonly fine: number;
  /** Show channel holding the value, or -1 when nothing programs it. */
  readonly channel: number;
  readonly fallback: number;
  readonly physFrom: number;
  readonly physTo: number;
  readonly physical: boolean;
  readonly invert: boolean;
  /** Show channels of the virtual dimmers that scale this slot (each with its default). */
  readonly dimmers: readonly (readonly [channel: number, fallback: number])[];
}

function defaultFor(attr: string, profileDefault: number | undefined): number {
  if (profileDefault !== undefined) return profileDefault;
  if (attr === "Dimmer") return 0;
  if (attr === "ColorRGB_R" || attr === "ColorRGB_G" || attr === "ColorRGB_B") return 100;
  return 0;
}

/** Group-level virtual dimmers (no "." in the path) default open; cell-level ones closed. */
function virtualDimmerDefault(sub: string): number {
  return sub.includes(".") ? 0 : 100;
}

function ancestors(sub: string): string[] {
  const parts = sub === "" ? [] : sub.split(".");
  const out: string[] = [""];
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join("."));
  return out;
}

const COLOUR = /^(ColorRGB_|ColorSub_|CTO|CTB|CTC|Color)/;

function encodeSlots(file: Ma3ShowFile, channelOf: (fid: number, sub: string, attr: string) => number): EncodedSlot[] {
  const slots: EncodedSlot[] = [];
  for (const fixture of file.fixtures) {
    const profile = file.types[fixture.type]!;
    const virtual = new Set(profile.virtualDimmers ?? []);
    const base = (fixture.universe - 1) * DMX_SLOTS + (fixture.address - 1);
    for (const ch of profile.channels) {
      const coarse = base + ch.offset[0]! - 1;
      const fine = ch.offset.length > 1 ? base + ch.offset[1]! - 1 : -1;
      if (coarse < 0 || coarse >= DMX_SLOTS * DMX_UNIVERSES) continue;
      // A slot is scaled by the virtual dimmers above it, and a colour slot also by its own.
      const scopes = ancestors(ch.sub).filter(scope => virtual.has(scope));
      if (COLOUR.test(ch.attr) && virtual.has(ch.sub)) scopes.push(ch.sub);
      slots.push({
        coarse, fine,
        channel: ch.fixed === true ? -1 : channelOf(fixture.fid, ch.sub, ch.source ?? ch.attr),
        fallback: ch.fixed === true ? (ch.default ?? 0) : defaultFor(ch.source ?? ch.attr, ch.default),
        physFrom: ch.physFrom ?? 0, physTo: ch.physTo ?? 100,
        physical: ch.physFrom !== undefined && ch.physTo !== undefined,
        invert: ch.invert === true,
        dimmers: scopes.map(scope => [channelOf(fixture.fid, scope, "Dimmer"), virtualDimmerDefault(scope)] as const),
      });
    }
  }
  return slots;
}

// ------------------------------------------------------------------ playback

interface SequenceRun {
  active: boolean;
  cue: number;        // index into states
  fired: number;
  previous: { cue: number; fired: number } | null;
  offAt: number | null;
  order: number;
}

export interface Ma3Playback {
  readonly file: Ma3ShowFile;
  /** Universes 1..128 x 512 slots, row-major, each 0..1 (= byte / 255). Reused between calls. */
  evaluate(seconds: number): Float32Array;
  /** Attribute values (percent or physical) per show channel, after the last `evaluate`. */
  readonly values: Float32Array;
  /** Names of the sequences showing anything at the last `evaluate`, in stacking order. */
  active(): readonly string[];
}

export function createMa3Playback(file: Ma3ShowFile): Ma3Playback {
  const sequences = new Map(file.sequences.map(sequence => [sequence.no, compileSequence(sequence)]));
  const index = new Map(file.channels.map(([fid, sub, attr], i) => [`${fid}|${sub}|${attr}`, i]));
  const extra: (readonly [number, string, string])[] = [];
  const channelOf = (fid: number, sub: string, attr: string): number => {
    const key = `${fid}|${sub}|${attr}`;
    let i = index.get(key);
    if (i === undefined) {
      // A slot nothing programs still needs a value to read: give it a channel of its own.
      i = file.channels.length + extra.length;
      index.set(key, i);
      extra.push([fid, sub, attr]);
    }
    return i;
  };
  const slots = encodeSlots(file, channelOf);
  const total = file.channels.length + extra.length;
  const defaults = new Float32Array(total);
  const all = [...file.channels, ...extra];
  const virtualSubs = new Map<string, Set<string>>();
  for (const fixture of file.fixtures) virtualSubs.set(String(fixture.fid), new Set(file.types[fixture.type]!.virtualDimmers ?? []));
  const profileDefault = new Map<string, number>();
  for (const fixture of file.fixtures) {
    for (const ch of file.types[fixture.type]!.channels) {
      if (ch.default !== undefined) profileDefault.set(`${fixture.fid}|${ch.sub}|${ch.attr}`, ch.default);
    }
  }
  all.forEach(([fid, sub, attr], i) => {
    const key = `${fid}|${sub}|${attr}`;
    defaults[i] = attr === "Dimmer" && virtualSubs.get(String(fid))?.has(sub)
      ? virtualDimmerDefault(sub)
      : defaultFor(attr, profileDefault.get(key));
  });

  const values = new Float32Array(total);
  const previousValue = new Float32Array(total);
  const previousStamp = new Int32Array(total);
  let stamp = 0;
  const dmx = new Float32Array(DMX_SLOTS * DMX_UNIVERSES);
  const events = [...file.timecode.events].sort((a, b) => a[0] - b[0]);
  let lastActive: string[] = [];

  function replay(t: number): Map<number, SequenceRun> {
    const runs = new Map<number, SequenceRun>();
    let order = 0;
    const runOf = (no: number): SequenceRun => {
      let run = runs.get(no);
      if (run === undefined) { run = { active: false, cue: -1, fired: 0, previous: null, offAt: null, order: 0 }; runs.set(no, run); }
      return run;
    };
    for (const [time, no, kind, cueNo] of events) {
      if (time > t) break;
      const sequence = sequences.get(no);
      if (sequence === undefined) continue;
      const run = runOf(no);
      let target: number;
      if (kind === 1) {
        const from = run.active && run.offAt === null && run.cue >= 0 ? sequence.cueNumbers[run.cue]! : -Infinity;
        target = sequence.cueNumbers.findIndex(no2 => no2 > from + 1e-6);
        if (target < 0 && sequence.wrap) target = 0;
      } else {
        target = sequence.cueNumbers.findIndex(no2 => Math.abs(no2 - cueNo) < 1e-6);
      }
      if (target < 0) continue;
      const fireAt = Math.max(time, 0);
      run.previous = run.active && run.offAt === null && run.cue >= 0 ? { cue: run.cue, fired: run.fired } : null;
      run.active = true; run.cue = target; run.fired = fireAt; run.offAt = null; run.order = ++order;
      for (const offNo of sequence.states[target]!.off) {
        const off = runs.get(offNo);
        // A cue that turns its own sequence off is a hit: it shows for its fade, then releases.
        // (Approximation: MA runs the command at the cue's start; with a 0 s OffCue fade the
        // hit would never be seen, which is not what the show looks like.)
        if (off !== undefined && off.active) off.offAt = offNo === no ? fireAt + sequence.states[target]!.fade : fireAt;
      }
    }
    return runs;
  }

  function evaluate(seconds: number): Float32Array {
    const runs = replay(seconds);
    values.set(defaults);
    const stack = [...runs].filter(([, run]) => run.active).sort((a, b) => a[1].order - b[1].order);
    lastActive = [];
    for (const [no, run] of stack) {
      const sequence = sequences.get(no)!;
      let weight = 1;
      if (run.offAt !== null) {
        // At least one frame's release, so a hit with a 0 s OffCue fade still shows.
        weight = 1 - Math.min(Math.max((seconds - run.offAt) / Math.max(sequence.offFade, MIN_RELEASE_SECONDS), 0), 1);
        if (weight <= 0) continue;
      }
      lastActive.push(sequence.name);
      const state = sequence.states[run.cue]!;
      const a = state.fade <= 0 ? 1 : Math.min(Math.max((seconds - run.fired) / state.fade, 0), 1);
      stamp++;
      const prev = a < 1 && run.previous !== null ? sequence.states[run.previous.cue]! : null;
      if (prev !== null) {
        for (let i = 0; i < prev.channels.length; i++) { previousValue[prev.channels[i]!] = prev.values[i]!; previousStamp[prev.channels[i]!] = stamp; }
        for (const phaser of prev.phasers) { previousValue[phaser[0]] = phaserValue(phaser, seconds - run.previous!.fired); previousStamp[phaser[0]] = stamp; }
      }
      const apply = (channel: number, target: number): void => {
        const under = values[channel]!;
        const from = previousStamp[channel] === stamp ? previousValue[channel]! : under;
        const shown = from + (target - from) * a;
        values[channel] = under + (shown - under) * weight;
        if (prev !== null) previousStamp[channel] = -stamp;   // handled: not a fade-out
      };
      for (let i = 0; i < state.channels.length; i++) apply(state.channels[i]!, state.values[i]!);
      for (const phaser of state.phasers) apply(phaser[0], phaserValue(phaser, seconds - run.fired));
      if (prev !== null) {
        // Held by the previous cue only (a non-tracking sequence moving on): fade it back out.
        const fadeOut = (channel: number): void => {
          if (previousStamp[channel] !== stamp) return;
          const under = values[channel]!;
          const shown = previousValue[channel]! + (under - previousValue[channel]!) * a;
          values[channel] = under + (shown - under) * weight;
        };
        for (let i = 0; i < prev.channels.length; i++) fadeOut(prev.channels[i]!);
        for (const phaser of prev.phasers) fadeOut(phaser[0]);
      }
    }
    // Encode.
    dmx.fill(0);
    for (const slot of slots) {
      let v = slot.channel >= 0 ? values[slot.channel]! : slot.fallback;
      let x = slot.physical ? (v - slot.physFrom) / (slot.physTo - slot.physFrom) : v / 100;
      if (slot.invert) x = 1 - x;
      for (const [channel, fallback] of slot.dimmers) {
        v = channel >= 0 ? values[channel]! : fallback;
        x *= v / 100;
      }
      x = Math.min(Math.max(x, 0), 1);
      if (slot.fine >= 0) {
        const word = Math.round(x * 65535);
        dmx[slot.coarse] = (word >> 8) / 255;
        dmx[slot.fine] = (word & 255) / 255;
      } else {
        dmx[slot.coarse] = Math.round(x * 255) / 255;
      }
    }
    return dmx;
  }

  return { file, evaluate, values, active: () => lastActive };
}
