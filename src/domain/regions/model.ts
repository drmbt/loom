import { TICKS_PER_SECOND } from "../time/ticks.ts";

/**
 * VN101 — REGIONS: MEDIA PLACED ON A CLIP TRACK, IN TICKS.
 *
 * A region is a piece of a media file laid on the timeline (Ableton's clip, Resolume's
 * clip with its transport): which part of the source (`sourceIn` .. `sourceOut`), where it
 * starts on the timeline (`timelineStart`) and for how long (`length`). The region's length
 * is independent of the source span: a 2-second loop can fill 30 seconds of timeline, and
 * a once-clip can be cut short. How the span fills the length is the play mode (loop,
 * bounce, play once and hold, play once and clear), the speed and the direction, or a BPM
 * sync that fits the span to a number of beats at the grid tempo.
 *
 * Every time is integer TICKS (240 000/s, `src/domain/time/ticks.ts`), timeline times
 * relative to the track's container (0 until VN72 places containers in SMPTE time). Source
 * times are ticks too: a 29.97 fps source's frame N sits at N · 8 008 exactly.
 *
 * A track is stored as ONE JSON text parameter on the `clipTrack` node (the `automation`
 * and `cueList` precedent): an edit is one `setParameters`, so undo, autosave, the agent
 * surface and the JSON editor come for free.
 *
 *     { "version": 1, "id", "name", "regions": [ {
 *         "id", "media", "sourceIn", "sourceOut", "timelineStart", "length",
 *         "playMode", "speed", "direction", "bpmSync"?: { "beats" }, "fadeIn", "fadeOut" } ] }
 *
 * Invariants, enforced by `parseClipTrack` (which REFUSES, naming what is wrong, rather than
 * repairing): every number finite; `timelineStart`, `length`, `sourceIn`, `sourceOut`,
 * `fadeIn`, `fadeOut` whole ticks; `length > 0`; `0 ≤ sourceIn < sourceOut`; `speed ≥ 0`
 * (reverse is the direction, not a negative speed); `beats > 0`; the fades fit inside the
 * region; region ids unique; regions sorted by `timelineStart` and NOT OVERLAPPING (a region
 * may start exactly where the previous one ends).
 */

export const CLIP_TRACK_VERSION = 1;

export const PLAY_MODES = ["loop", "bounce", "onceHold", "onceClear"] as const;
export type PlayMode = (typeof PLAY_MODES)[number];

export const DIRECTIONS = ["forward", "reverse"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export interface BpmSync {
  /** How many beats one pass of `sourceIn .. sourceOut` takes at the grid tempo. */
  readonly beats: number;
}

export interface Region {
  readonly id: string;
  /** What `movieFileIn.file` would hold: a `loom-file:` reference, a URL, or (imported) a path. */
  readonly media: string;
  readonly sourceIn: number;
  readonly sourceOut: number;
  readonly timelineStart: number;
  readonly length: number;
  readonly playMode: PlayMode;
  readonly speed: number;
  readonly direction: Direction;
  readonly bpmSync?: BpmSync;
  readonly fadeIn: number;
  readonly fadeOut: number;
}

export interface ClipTrack {
  readonly version: typeof CLIP_TRACK_VERSION;
  readonly id: string;
  readonly name: string;
  /** Sorted by `timelineStart`, non-overlapping. */
  readonly regions: readonly Region[];
}

export type ClipTrackParse = { readonly ok: true; readonly track: ClipTrack } | { readonly ok: false; readonly reason: string };

export const EMPTY_CLIP_TRACK: ClipTrack = { version: CLIP_TRACK_VERSION, id: "track1", name: "track", regions: [] };

/** The timeline tick a region ends at (exclusive). */
export const regionEnd = (region: Pick<Region, "timelineStart" | "length">): number => region.timelineStart + region.length;

/** A region with every optional field at its default. */
export function newRegion(id: string, media: string, fields: Partial<Omit<Region, "id" | "media">> = {}): Region {
  return {
    id,
    media,
    sourceIn: 0,
    sourceOut: TICKS_PER_SECOND,
    timelineStart: 0,
    length: TICKS_PER_SECOND,
    playMode: "loop",
    speed: 1,
    direction: "forward",
    fadeIn: 0,
    fadeOut: 0,
    ...fields,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

class Refusal extends Error {}

function wholeTicks(record: Record<string, unknown>, key: string, where: string, fallback?: number): number {
  const value = record[key] ?? fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Refusal(`${where}: ${key} must be a finite number of ticks.`);
  if (!Number.isInteger(value)) throw new Refusal(`${where}: ${key} must be a whole number of ticks (got ${value}).`);
  return value;
}

function parseRegion(raw: unknown, index: number): Region {
  const where = `region ${index}`;
  if (!isRecord(raw)) throw new Refusal(`${where} is not an object.`);
  const id = raw["id"];
  if (typeof id !== "string" || id === "") throw new Refusal(`${where}: id must be a non-empty string.`);
  const named = `region "${id}"`;
  const media = raw["media"] ?? "";
  if (typeof media !== "string") throw new Refusal(`${named}: media must be a string.`);
  const sourceIn = wholeTicks(raw, "sourceIn", named, 0);
  const sourceOut = wholeTicks(raw, "sourceOut", named);
  const timelineStart = wholeTicks(raw, "timelineStart", named);
  const length = wholeTicks(raw, "length", named);
  const fadeIn = wholeTicks(raw, "fadeIn", named, 0);
  const fadeOut = wholeTicks(raw, "fadeOut", named, 0);
  if (length <= 0) throw new Refusal(`${named}: length must be greater than 0.`);
  if (sourceIn < 0) throw new Refusal(`${named}: sourceIn must not be negative.`);
  if (!(sourceIn < sourceOut)) throw new Refusal(`${named}: sourceIn must be before sourceOut.`);
  if (fadeIn < 0 || fadeOut < 0 || fadeIn + fadeOut > length) {
    throw new Refusal(`${named}: fadeIn and fadeOut must be ≥ 0 and fit inside the region's length together.`);
  }
  const playMode = raw["playMode"] ?? "loop";
  if (!PLAY_MODES.includes(playMode as PlayMode)) throw new Refusal(`${named}: playMode must be one of ${PLAY_MODES.join(", ")}.`);
  const direction = raw["direction"] ?? "forward";
  if (!DIRECTIONS.includes(direction as Direction)) throw new Refusal(`${named}: direction must be forward or reverse.`);
  const speed = raw["speed"] ?? 1;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0) {
    throw new Refusal(`${named}: speed must be a finite number ≥ 0 (reverse is the direction, not a negative speed).`);
  }
  let bpmSync: BpmSync | undefined;
  const sync = raw["bpmSync"];
  if (sync !== undefined && sync !== null) {
    const beats = isRecord(sync) ? sync["beats"] : undefined;
    if (typeof beats !== "number" || !Number.isFinite(beats) || beats <= 0) throw new Refusal(`${named}: bpmSync.beats must be a finite number > 0.`);
    bpmSync = { beats };
  }
  return {
    id, media, sourceIn, sourceOut, timelineStart, length,
    playMode: playMode as PlayMode, speed, direction: direction as Direction,
    ...(bpmSync === undefined ? {} : { bpmSync }),
    fadeIn, fadeOut,
  };
}

/** Parse a track's JSON text (or an already-parsed object), refusing what breaks an invariant. */
export function parseClipTrack(input: unknown): ClipTrackParse {
  try {
    let data: unknown = input;
    if (typeof input === "string") {
      try {
        data = JSON.parse(input);
      } catch (error) {
        throw new Refusal(`Not JSON: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!isRecord(data)) throw new Refusal("A clip track is an object { version, id, name, regions }.");
    if (data["version"] !== CLIP_TRACK_VERSION) throw new Refusal(`Unknown clip track version ${String(data["version"])}; this build reads ${CLIP_TRACK_VERSION}.`);
    const id = data["id"] ?? EMPTY_CLIP_TRACK.id;
    const name = data["name"] ?? EMPTY_CLIP_TRACK.name;
    if (typeof id !== "string" || typeof name !== "string") throw new Refusal("id and name must be strings.");
    const rawRegions = data["regions"];
    if (!Array.isArray(rawRegions)) throw new Refusal("regions must be an array.");
    const regions = rawRegions.map(parseRegion);
    const ids = new Set<string>();
    for (const [index, region] of regions.entries()) {
      if (ids.has(region.id)) throw new Refusal(`Two regions share the id "${region.id}".`);
      ids.add(region.id);
      const previous = regions[index - 1];
      if (previous === undefined) continue;
      if (region.timelineStart < previous.timelineStart) {
        throw new Refusal(`Regions must be sorted by timelineStart: "${region.id}" starts before "${previous.id}".`);
      }
      if (region.timelineStart < regionEnd(previous)) {
        throw new Refusal(`Regions "${previous.id}" and "${region.id}" overlap: a track plays one region at a time.`);
      }
    }
    return { ok: true, track: { version: CLIP_TRACK_VERSION, id, name, regions } };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.message };
    throw error;
  }
}

/** Stable text: fields in a fixed order, defaults written out, so a round trip is byte-identical. */
export function serializeClipTrack(track: ClipTrack): string {
  return JSON.stringify({
    version: track.version,
    id: track.id,
    name: track.name,
    regions: track.regions.map((region) => ({
      id: region.id,
      media: region.media,
      sourceIn: region.sourceIn,
      sourceOut: region.sourceOut,
      timelineStart: region.timelineStart,
      length: region.length,
      playMode: region.playMode,
      speed: region.speed,
      direction: region.direction,
      ...(region.bpmSync === undefined ? {} : { bpmSync: { beats: region.bpmSync.beats } }),
      fadeIn: region.fadeIn,
      fadeOut: region.fadeOut,
    })),
  }, null, 2);
}

export const EMPTY_CLIP_TRACK_JSON = serializeClipTrack(EMPTY_CLIP_TRACK);
