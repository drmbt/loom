import type { GraphDocument } from "@domain/types/graph.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { mediaPlayhead, mediaTransportFrom } from "@domain/media/transport.ts";
import type { TimelineReference } from "@domain/media/timeline-reference.ts";
import { TICKS_PER_SECOND } from "@domain/time/ticks.ts";

/**
 * VN68 — THE BEAT GRID, read from the reference track's DECLARED tempo (T1228).
 *
 * An Audio File In with Tempo = Declared counts beats along the FILE: beat `b` is at
 * `beatOffset + b · 60 / bpm` seconds into the file, and the file position under the
 * timeline lock is the transport's (`mediaPlayhead` at an unknown duration, which is
 * exactly what the node's `declaredTempo` reads, so trim and speed move the grid with the
 * sound and a loop wrap is not counted). That makes the grid the SAME beat clock the
 * node's `beat` / `bar` channels publish: a key snapped to a bar line lands on the frame
 * those channels say the bar starts.
 *
 * Under the lock with no cue held that clock is LINEAR in timeline time, so the grid is a
 * line (`beatsAt(t) = origin + slope·t`) and a snap is solved in closed form. A held cue
 * stops it (slope 0): no grid, nothing to snap to.
 *
 * No reference, a movie reference, or Tempo on Auto: no grid. (Auto claims no tempo, and a
 * grid drawn from a guess would be confidently wrong, the node's own rule.)
 */

export interface BeatGrid {
  readonly bpm: number;
  readonly beatsPerBar: number;
  /** Beats counted at timeline tick 0 (negative before beat one). */
  readonly originBeats: number;
  /** Beats per tick: `speed · bpm / 60 / TICKS_PER_SECOND`. Always > 0. */
  readonly beatsPerTick: number;
}

/** What a snap rounds to, in beats. */
export type BeatDivision = "bars" | "beats" | "eighths" | "sixteenths";

const numberOr = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** The grid of the timeline's reference, or null when it declares no tempo. */
export function beatGridOf(graph: GraphDocument, reference: TimelineReference | null): BeatGrid | null {
  if (reference === null || reference.type !== "audioFileIn") return null;
  const parameters = graph.nodes[reference.nodeId]?.parameters ?? {};
  const read = (key: string) => storedStaticValue(parameters[key]);
  if (read("tempoMode") !== "declared") return null;
  const bpm = Math.max(0, numberOr(read("bpm"), 120));
  const beatOffset = numberOr(read("beatOffset"), 0);
  const beatsPerBar = Math.max(1, Math.floor(numberOr(read("beatsPerBar"), 4)));
  if (!(bpm > 0)) return null;
  const transport = mediaTransportFrom(read);
  // The node's own clock: the file position at an unknown duration (no wrap), per second.
  const beatsAtSecond = (seconds: number): number => ((mediaPlayhead(transport, seconds, 0).position - beatOffset) * bpm) / 60;
  // A held cue stops the clock; otherwise it runs at speed × bpm / 60 beats a second.
  const perSecond = transport.cue ? 0 : (transport.speed * bpm) / 60;
  if (!(perSecond > 0)) return null;
  const originBeats = beatsAtSecond(0);
  return { bpm, beatsPerBar, originBeats, beatsPerTick: perSecond / TICKS_PER_SECOND };
}

/** Beats counted at a tick. */
export const beatsAt = (grid: BeatGrid, ticks: number): number => grid.originBeats + grid.beatsPerTick * ticks;

/** The tick a beat count falls on. */
export const tickOfBeat = (grid: BeatGrid, beats: number): number => (beats - grid.originBeats) / grid.beatsPerTick;

/** A division's length in beats: a bar, a beat, an eighth (half a beat), a sixteenth. */
export function divisionBeats(grid: BeatGrid, division: BeatDivision): number {
  return division === "bars" ? grid.beatsPerBar : division === "beats" ? 1 : division === "eighths" ? 0.5 : 0.25;
}

/** A POSITION snapped to the nearest division line, in whole ticks. */
export function snapToGrid(ticks: number, grid: BeatGrid, division: BeatDivision): number {
  const step = divisionBeats(grid, division);
  return Math.round(tickOfBeat(grid, Math.round(beatsAt(grid, ticks) / step) * step));
}

/** A DELTA (a drag) snapped to a whole number of divisions, in whole ticks. */
export function snapDeltaToGrid(ticks: number, grid: BeatGrid, division: BeatDivision): number {
  const stepTicks = divisionBeats(grid, division) / grid.beatsPerTick;
  return Math.round(Math.round(ticks / stepTicks) * stepTicks);
}
