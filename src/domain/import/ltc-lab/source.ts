/**
 * VN100 — READING AN LTC-LAB SHOW: a `.ltcshow.tar` (ltc-lab `server/package.mjs`) or a
 * `project.json` plus its `tours/<slug>.json`.
 *
 * The archive is walked header by header (`scanUstar`) and only what one track's import
 * needs is read: `manifest.json`, `project.json`, `tour.json`, that track's
 * `cache/waveforms/<id>.json` and its `media/audio/<fileName>`. Stems, video, analysis
 * caches and other tracks' audio are listed (for the report) and never read.
 *
 * Validation is structural and REFUSES with the first thing wrong, naming it.
 */

import type { LtcGrid, LtcProject, LtcTour, LtcTrack } from "./ltc-types.ts";
import { scanUstar, type RangeReader, type TarListing } from "./tar.ts";

export interface LtcLabSource {
  readonly project: LtcProject;
  readonly tour: LtcTour | null;
  /** The archive's `manifest.json`; null for a project.json source. */
  readonly manifest: Record<string, unknown> | null;
  /** Every file in the archive, read or not; empty for a project.json source. */
  readonly listing: readonly TarListing[];
  /** Files read from the archive, by archive path. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export type SourceRead = { readonly ok: true; readonly source: LtcLabSource } | { readonly ok: false; readonly reason: string };

const plainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function grid(value: unknown): LtcGrid | null {
  if (!plainObject(value)) return null;
  const { bpm, anchor, beatsPerBar } = value;
  if (!finite(bpm) || bpm <= 0 || !finite(anchor) || !finite(beatsPerBar) || beatsPerBar < 1) return null;
  return value as unknown as LtcGrid;
}

function checkLane(lane: unknown, where: string): string | null {
  if (!plainObject(lane)) return `${where} is not an object`;
  if (typeof lane["address"] !== "string") return `${where} has no OSC address`;
  if (!finite(lane["min"]) || !finite(lane["max"])) return `${where} ("${lane["address"]}") needs finite min and max`;
  const keyframes = lane["keyframes"];
  if (!Array.isArray(keyframes)) return `${where} ("${lane["address"]}") has no keyframes list`;
  for (const [index, key] of keyframes.entries()) {
    if (!plainObject(key) || !finite(key["time"]) || !finite(key["value"])) {
      return `${where} ("${lane["address"]}"), keyframe ${index + 1}: time and value must be finite numbers`;
    }
  }
  return null;
}

function checkTrack(track: unknown, index: number): string | null {
  const where = `track ${index + 1}`;
  if (!plainObject(track)) return `${where} is not an object`;
  if (typeof track["id"] !== "string" || track["id"] === "") return `${where} has no id`;
  const at = `track "${track["id"]}"`;
  if (typeof track["fileName"] !== "string") return `${at} has no fileName`;
  if (typeof track["startTC"] !== "string") return `${at} has no startTC`;
  if (!Array.isArray(track["lanes"])) return `${at} has no lanes list`;
  if (!Array.isArray(track["markers"])) return `${at} has no markers list`;
  for (const [laneIndex, lane] of (track["lanes"] as unknown[]).entries()) {
    const problem = checkLane(lane, `${at}, lane ${laneIndex + 1}`);
    if (problem !== null) return problem;
  }
  for (const [markerIndex, marker] of (track["markers"] as unknown[]).entries()) {
    if (!plainObject(marker) || !finite(marker["time"])) return `${at}, marker ${markerIndex + 1} needs a finite time`;
  }
  if (track["grid"] != null && grid(track["grid"]) === null) return `${at} has a grid without a positive bpm, an anchor and beatsPerBar`;
  return null;
}

/** A parsed `project.json` (object or text) → the project, or the first thing wrong. */
export function parseLtcProject(input: unknown): { ok: true; project: LtcProject } | { ok: false; reason: string } {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return { ok: false, reason: "project.json is not valid JSON" };
    }
  }
  if (!plainObject(raw)) return { ok: false, reason: "project.json must be an object with fps and tracks" };
  if (!finite(raw["fps"]) || raw["fps"] <= 0) return { ok: false, reason: "project.json has no positive fps" };
  if (!Array.isArray(raw["tracks"])) return { ok: false, reason: "project.json has no tracks list" };
  for (const [index, track] of (raw["tracks"] as unknown[]).entries()) {
    const problem = checkTrack(track, index);
    if (problem !== null) return { ok: false, reason: `project.json: ${problem}` };
  }
  return { ok: true, project: raw as unknown as LtcProject };
}

function parseTour(input: unknown): LtcTour | null {
  let raw = input;
  if (typeof input === "string") {
    try {
      raw = JSON.parse(input);
    } catch {
      return null;
    }
  }
  return plainObject(raw) ? (raw as LtcTour) : null;
}

/** A `project.json` plus (optionally) its tour file, as objects or text. */
export function sourceFromJson(project: unknown, tour?: unknown): SourceRead {
  const parsed = parseLtcProject(project);
  if (!parsed.ok) return parsed;
  return { ok: true, source: { project: parsed.project, tour: tour === undefined ? null : parseTour(tour), manifest: null, listing: [], files: new Map() } };
}

const utf8 = new TextDecoder("utf-8");

export const PROJECT_ENTRY = "project.json";
export const TOUR_ENTRY = "tour.json";
export const MANIFEST_ENTRY = "manifest.json";
export const waveformEntry = (trackId: string): string => `cache/waveforms/${trackId}.json`;
export const audioEntry = (fileName: string): string => `media/audio/${fileName}`;

/**
 * Read a `.ltcshow.tar`. With `trackId`, also read that track's waveform cache and audio;
 * without, only the core files (enough to list the tracks).
 */
export async function sourceFromTar(reader: RangeReader, trackId?: string): Promise<SourceRead> {
  let wantedAudio: string | null | undefined;
  const scan = await scanUstar(reader, (name, readSoFar) => {
    if (name === PROJECT_ENTRY || name === TOUR_ENTRY || name === MANIFEST_ENTRY) return true;
    if (trackId === undefined) return false;
    if (name === waveformEntry(trackId)) return true;
    if (!name.startsWith("media/audio/")) return false;
    if (wantedAudio === undefined) {
      const projectEntry = readSoFar.find((entry) => entry.name === PROJECT_ENTRY);
      const parsed = projectEntry === undefined ? null : parseLtcProject(utf8.decode(projectEntry.bytes));
      const track = parsed?.ok === true ? parsed.project.tracks.find((candidate) => candidate.id === trackId) : undefined;
      wantedAudio = track === undefined ? null : audioEntry(track.fileName);
    }
    return name === wantedAudio;
  });
  if (!scan.ok) return scan;
  const files = new Map(scan.entries.map((entry) => [entry.name, entry.bytes]));
  const projectBytes = files.get(PROJECT_ENTRY);
  if (projectBytes === undefined) return { ok: false, reason: "the archive holds no project.json, so it is not an ltc-lab show package" };
  const parsed = parseLtcProject(utf8.decode(projectBytes));
  if (!parsed.ok) return parsed;
  const tourBytes = files.get(TOUR_ENTRY);
  const manifestBytes = files.get(MANIFEST_ENTRY);
  let manifest: Record<string, unknown> | null = null;
  if (manifestBytes !== undefined) {
    try {
      const raw: unknown = JSON.parse(utf8.decode(manifestBytes));
      if (plainObject(raw)) manifest = raw;
    } catch {
      return { ok: false, reason: "the archive's manifest.json is not valid JSON" };
    }
    if (manifest !== null && manifest["format"] !== "ltcshow") return { ok: false, reason: `the archive is not an ltc-lab show package (manifest format ${JSON.stringify(manifest["format"])})` };
  }
  return {
    ok: true,
    source: {
      project: parsed.project,
      tour: tourBytes === undefined ? null : parseTour(utf8.decode(tourBytes)),
      manifest,
      listing: scan.listing,
      files,
    },
  };
}

/** One line per track, for choosing which to import. */
export interface LtcTrackSummary {
  readonly id: string;
  readonly title: string;
  readonly fileName: string;
  readonly startTC: string;
  readonly durationSec: number | null;
  readonly lanes: number;
  readonly markers: number;
  readonly bpm: number | null;
}

export function listLtcLabTracks(source: LtcLabSource): LtcTrackSummary[] {
  return source.project.tracks.map((track: LtcTrack) => ({
    id: track.id,
    title: track.title,
    fileName: track.fileName,
    startTC: track.startTC,
    durationSec: track.durationSec,
    lanes: track.lanes.length,
    markers: track.markers.length,
    bpm: track.grid?.bpm ?? null,
  }));
}
