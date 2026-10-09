import { regionRate } from "@domain/regions/evaluate.ts";
import { parseFileReference } from "@domain/media/file-reference.ts";
import { regionEnd, type ClipTrack, type Region } from "@domain/regions/model.ts";

/**
 * VN106 — EDITING A CLIP TRACK'S REGIONS, as pure functions of the track a gesture STARTED
 * from (the key editor's rule, `timeline-edits.ts`): each returns a whole new track, so a
 * drag writes `edit(origin, pointer)` every move and one commit closes it.
 *
 * Every result keeps the model's invariants (`parseClipTrack`): whole ticks, `length > 0`,
 * `0 ≤ sourceIn < sourceOut`, fades inside the length, regions sorted and NOT OVERLAPPING.
 * A move or a trim that would overlap a neighbour CLAMPS against it, as a key move clamps
 * against its neighbours; nothing ever jumps over another region.
 *
 * The gestures, Ableton's arrangement view:
 *  - MOVE (the body): `timelineStart`, between the neighbours.
 *  - LEFT EDGE: trims the start and SLIPS the source with it, so what plays under the rest
 *    of the region stays where it was (`sourceIn += Δ · rate`; reverse moves `sourceOut`
 *    down instead). It cannot reach before the source's start (`sourceIn ≥ 0`), nor past the
 *    original source end of a reverse region (the file's length is not known here).
 *  - RIGHT EDGE: the length. Up to one pass of the source (the lap) by default, so a plain
 *    drag trims and never invents media; ALT extends past it so the play mode fills the rest
 *    (loop repeats, bounce, hold, clear). A region that already runs past its lap is
 *    already extended and keeps extending.
 *
 * BPM sync: the rate is fixed by the span and the beats, so a left-edge slip rescales the
 * beats with the span (`beats · span′ / span`): the remaining material keeps its speed.
 */

/** Timeline ticks one pass of the source takes at `tempoBpm`. Infinity for a freeze (speed 0). */
export function lapTicks(region: Region, tempoBpm: number): number {
  const rate = regionRate(region, tempoBpm);
  return rate > 0 ? (region.sourceOut - region.sourceIn) / rate : Infinity;
}

/** The free span around region `index`: the previous region's end (or 0) and the next one's start (or ∞). */
export function freeSpan(track: ClipTrack, index: number): { low: number; high: number } {
  const previous = track.regions[index - 1];
  const next = track.regions[index + 1];
  return { low: previous === undefined ? 0 : regionEnd(previous), high: next === undefined ? Infinity : next.timelineStart };
}

const replace = (track: ClipTrack, index: number, region: Region): ClipTrack => ({
  ...track,
  regions: track.regions.map((each, at) => (at === index ? region : each)),
});

/** Fades shrunk to fit a new length: fade in first, then the fade out in what is left. */
function fitFades(region: Region): Region {
  const fadeIn = Math.min(region.fadeIn, region.length);
  const fadeOut = Math.min(region.fadeOut, region.length - fadeIn);
  return fadeIn === region.fadeIn && fadeOut === region.fadeOut ? region : { ...region, fadeIn, fadeOut };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** Move region `id` to start at `start` (whole ticks), clamped between its neighbours. */
export function moveRegion(track: ClipTrack, id: string, start: number): ClipTrack {
  const index = track.regions.findIndex((region) => region.id === id);
  const region = track.regions[index];
  if (region === undefined) return track;
  const { low, high } = freeSpan(track, index);
  const timelineStart = Math.round(clamp(start, low, high - region.length));
  return timelineStart === region.timelineStart ? track : replace(track, index, { ...region, timelineStart });
}

/**
 * Trim region `id`'s START to `start`, slipping its source so the material under the rest
 * stays put. `minLength` (a frame, normally) is the shortest a region gets.
 */
export function trimRegionStart(track: ClipTrack, id: string, start: number, tempoBpm: number, minLength: number): ClipTrack {
  const index = track.regions.findIndex((region) => region.id === id);
  const region = track.regions[index];
  if (region === undefined) return track;
  const { low } = freeSpan(track, index);
  const rate = regionRate(region, tempoBpm);
  const minimum = Math.max(1, Math.round(minLength));
  // Δ in timeline ticks: positive trims in, negative extends out.
  let delta = Math.round(start) - region.timelineStart;
  delta = Math.max(delta, low - region.timelineStart);
  delta = Math.min(delta, region.length - minimum);
  if (rate > 0) {
    const span = region.sourceOut - region.sourceIn;
    // The source may not run out under the slip: keep at least one tick of span, and (going
    // out) not before the file's start / past the reverse region's original end.
    const maxIn = (span - 1) / rate;
    delta = Math.min(delta, Math.floor(maxIn));
    if (region.direction === "forward") delta = Math.max(delta, Math.ceil(-region.sourceIn / rate));
    else delta = Math.max(delta, 0);
  }
  if (delta === 0) return track;
  const slip = rate > 0 ? Math.round(delta * rate) : 0;
  const sourceIn = region.direction === "forward" ? region.sourceIn + slip : region.sourceIn;
  const sourceOut = region.direction === "forward" ? region.sourceOut : region.sourceOut - slip;
  const span = region.sourceOut - region.sourceIn;
  const next: Region = fitFades({
    ...region,
    timelineStart: region.timelineStart + delta,
    length: region.length - delta,
    sourceIn,
    sourceOut,
    ...(region.bpmSync === undefined ? {} : { bpmSync: { beats: (region.bpmSync.beats * (sourceOut - sourceIn)) / span } }),
  });
  return replace(track, index, next);
}

/**
 * Set region `id`'s END to `end`. Without `extend` the length stops at one pass of the
 * source (unless the region already runs past it); with it, the play mode fills the rest.
 */
export function trimRegionEnd(track: ClipTrack, id: string, end: number, options: { extend: boolean; tempoBpm: number; minLength: number }): ClipTrack {
  const index = track.regions.findIndex((region) => region.id === id);
  const region = track.regions[index];
  if (region === undefined) return track;
  const { high } = freeSpan(track, index);
  const minimum = Math.max(1, Math.round(options.minLength));
  const lap = lapTicks(region, options.tempoBpm);
  const cap = options.extend || region.length > lap ? Infinity : Math.floor(lap);
  const length = Math.round(clamp(Math.round(end) - region.timelineStart, minimum, Math.max(minimum, Math.min(cap, high - region.timelineStart))));
  return length === region.length ? track : replace(track, index, fitFades({ ...region, length }));
}

/** Fields a popover edit sets; `bpmSync: undefined` switches sync off. */
export type RegionFields = { readonly [K in keyof Omit<Region, "id">]?: Omit<Region, "id">[K] | undefined };

/** Change some of region `id`'s fields (the popover). The caller validates with `parseClipTrack`. */
export function setRegionFields(track: ClipTrack, id: string, fields: RegionFields): ClipTrack {
  const index = track.regions.findIndex((region) => region.id === id);
  const region = track.regions[index];
  if (region === undefined) return track;
  const next = { ...region, ...fields } as Region;
  if ("bpmSync" in fields && fields.bpmSync === undefined) delete (next as { bpmSync?: unknown }).bpmSync;
  return replace(track, index, fitFades(next));
}

/** Remove region `id`. */
export function deleteRegion(track: ClipTrack, id: string): ClipTrack {
  return { ...track, regions: track.regions.filter((region) => region.id !== id) };
}

/** A region id not used on the track: `region1`, `region2`, … */
export function freshRegionId(track: ClipTrack, taken: ReadonlySet<string> = new Set()): string {
  const used = new Set([...track.regions.map((region) => region.id), ...taken]);
  for (let index = 1; ; index += 1) if (!used.has(`region${index}`)) return `region${index}`;
}

/**
 * Lay `region` on the track at its `timelineStart` without overlapping anything: a start
 * inside an existing region moves to that region's end, and a length that would run into
 * the next region is cut to end where it starts. Null when there is less than `minLength`
 * of room there.
 */
export function placeRegion(track: ClipTrack, region: Region, minLength: number): ClipTrack | null {
  let start = Math.max(0, Math.round(region.timelineStart));
  for (const each of track.regions) {
    if (start >= each.timelineStart && start < regionEnd(each)) start = regionEnd(each);
  }
  const next = track.regions.find((each) => each.timelineStart >= start);
  const room = next === undefined ? Infinity : next.timelineStart - start;
  if (room < Math.max(1, minLength)) return null;
  const placed = fitFades({ ...region, timelineStart: start, length: Math.min(region.length, room) });
  const regions = [...track.regions, placed].sort((a, b) => a.timelineStart - b.timelineStart);
  return { ...track, regions };
}

/**
 * Whether the browser can open this media at all. An imported Resolume clip names a
 * FILESYSTEM PATH (`/Volumes/…/clip.mov`, `C:\…`), which no page can open: such a region
 * is OFFLINE until its media is replaced (or, later, resolved to a transcoded proxy).
 */
export function isOfflineMedia(media: string): boolean {
  if (media === "") return false;
  return !/^(loom-file:|blob:|https?:|data:|file:)/i.test(media) && !media.startsWith("/media/") && !media.startsWith("./");
}

/** What a region's block is captioned with: the file's own name, from any form `media` takes. */
export function mediaLabel(media: string): string {
  if (media === "") return "no media";
  try {
    const reference = parseFileReference(media);
    if (reference !== null) return reference.name;
  } catch {
    return "invalid file reference";
  }
  const hash = media.indexOf("#");
  if (media.startsWith("blob:") && hash >= 0) {
    try {
      return decodeURIComponent(media.slice(hash + 1));
    } catch {
      return media.slice(hash + 1);
    }
  }
  const path = media.split(/[?#]/)[0] ?? media;
  const base = path.split(/[\\/]/).filter((part) => part !== "").pop();
  return base === undefined ? media : decodeURIComponentSafe(base);
}

function decodeURIComponentSafe(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** A play mode in a badge's room. */
export const PLAY_MODE_BADGE: Readonly<Record<Region["playMode"], string>> = { loop: "loop", bounce: "bounce", onceHold: "once·hold", onceClear: "once·clear" };

/** The block's badge: mode, then direction, speed or sync when they are not the defaults. */
export function regionBadge(region: Region): string {
  const parts = [PLAY_MODE_BADGE[region.playMode]];
  if (region.direction === "reverse") parts.push("rev");
  if (region.bpmSync !== undefined) parts.push(`${formatNumber(region.bpmSync.beats)} beats`);
  else if (region.speed !== 1) parts.push(`×${formatNumber(region.speed)}`);
  return parts.join(" ");
}

const formatNumber = (value: number): string => String(Math.round(value * 1000) / 1000);
