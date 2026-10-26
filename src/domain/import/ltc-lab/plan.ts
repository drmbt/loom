/**
 * VN100 — ONE LTC-LAB TRACK → A LOOM GRAPH PATCH PLUS A REPORT.
 *
 * Pure and headless: it builds operations, it applies nothing. The caller dispatches
 * `operations` as one `graph.applyPatch`, applies `settings` through `project.setSettings`,
 * and binds `audio.bytes` to the audio node's `file` (the `attach_asset` path, or the
 * retained-files path in the app); the importer never mints a URL.
 *
 * What it builds (node names are `kind_role`, the role from the track id):
 *  - `audiofile_reference` (the timeline's reference media, VN64) when the document has
 *    none, else `audiofile_<track>`: Audio File In locked to the timeline, its tempo DECLARED from the
 *    track grid (`bpm`, `beatOffset` = the grid anchor, `beatsPerBar`). Audio second 0 is
 *    timeline second 0.
 *  - `automation_<track>`: one lane per ltc-lab lane. Manual lanes keep their keys: seconds
 *    → ticks as `round(t × 240 000)`, the same normalized values, bezier handles converted
 *    `{dt s, dv}` → `[Δticks, dv]` with `handle: "free"`, each handle's Δt held inside its
 *    segment the way ltc-lab clamps it (dv kept), so Loom's own hold never rescales it. Lane
 *    min/max kept. Generated lanes (onsets, level, figure) are BAKED (`lane-eval.ts`).
 *    The lane name comes from the OSC address; the address itself is in the report.
 *  - `presets_<track>` and `cuelist_<track>`: a cue per marker at its time, following the
 *    timeline. A cue must name a bank and a preset (`parseCueList`), so each points at an
 *    EMPTY preset `ltc_<marker>` in the bank, and its note begins "ltc-lab marker".
 *  - `note_<track>`: an Annotate holding the start timecode, fps, source and what was not
 *    imported, until the project has a start timecode of its own (VN72).
 */

import { newKey, newLane, serializeAutomation, AUTOMATION_VERSION, type AutomationKey, type AutomationLane } from "../../automation/model.ts";
import { freeRoleName } from "../../graph/names.ts";
import { serializeCueList, CUE_FOLLOW_TIMELINE, type Cue } from "../../presets/cue-list.ts";
import { serializePresetBank, type Preset } from "../../presets/bank.ts";
import { TICKS_PER_SECOND } from "../../time/ticks.ts";
import type { GraphPatchOperation, TempId } from "../../types/patch.ts";
import { bakeGenerated, gridSourceOf, isGenerated } from "./lane-eval.ts";
import type { LtcKeyframe, LtcLane, LtcMarker, LtcTrack } from "./ltc-types.ts";
import { audioEntry, waveformEntry, type LtcLabSource } from "./source.ts";

export interface LtcLabImportOptions {
  readonly trackId: string;
  /** Where the first node lands; the rest follow to the right. */
  readonly origin?: { readonly x: number; readonly y: number };
  /**
   * Every node name already in the document: the new names are chosen free of them, and
   * whether the timeline already has its reference media is read off them.
   */
  readonly existingNames?: Iterable<string>;
  /** Generated-lane bake rate. Default 240 Hz (1000 ticks a sample). */
  readonly bakeRateHz?: number;
  /** Generated-lane bake tolerance, normalized. Default 0.002. */
  readonly bakeTolerance?: number;
}

export interface ImportedLane {
  readonly name: string;
  readonly address: string;
  readonly source: "manual" | "onsets" | "level" | "figure";
  readonly keys: number;
  readonly baked: boolean;
  readonly muted: boolean;
}

export interface ImportedCue {
  readonly name: string;
  readonly at: number;
  readonly preset: string;
}

export interface NotImported {
  readonly what: string;
  readonly count: number;
  readonly names: readonly string[];
  readonly why: string;
}

export interface LtcLabImportReport {
  readonly track: {
    readonly id: string;
    readonly title: string;
    readonly fileName: string;
    readonly startTC: string;
    readonly fps: number;
    readonly durationSec: number;
  };
  readonly tempo: { readonly bpm: number; readonly beatOffset: number; readonly beatsPerBar: number } | null;
  /**
   * The audio node's name, and why: `audiofile_reference` (the timeline's reference media,
   * VN64) when the document had none, else `audiofile_<track>` beside the one it has.
   */
  readonly audioNode: { readonly name: string; readonly reference: boolean; readonly why: string };
  readonly lanes: readonly ImportedLane[];
  readonly cues: readonly ImportedCue[];
  readonly notImported: readonly NotImported[];
  readonly warnings: readonly string[];
}

export interface LtcLabImportPlan {
  readonly operations: readonly GraphPatchOperation[];
  /** Patch-local refs, resolved in the patch result's `createdIds`. */
  readonly refs: { readonly audio: TempId; readonly automation: TempId | null; readonly presets: TempId | null; readonly cueList: TempId | null; readonly note: TempId };
  readonly names: { readonly audio: string; readonly automation: string | null; readonly presets: string | null; readonly cueList: string | null; readonly note: string };
  /** Bind to the audio node's `file`. `bytes` is null when the source carried no audio (a project.json). */
  readonly audio: {
    readonly fileName: string;
    readonly mimeType: string;
    readonly bytes: Uint8Array | null;
    /** For a project.json source: where ltc-lab keeps it (the tour's audioDir). */
    readonly audioDir: string | null;
  };
  /** For `project.setSettings`: the show's rate and a range covering the track. */
  readonly settings: { readonly fps: number; readonly frameRange: { readonly start: number; readonly end: number } };
  /** Until VN72 gives the project a start timecode: the track's, as ltc-lab stores it. */
  readonly startTimecode: { readonly text: string; readonly fps: number; readonly frame: number | null };
  /** The track's waveform cache (50 bins/s) when the archive held it, for VN64 to draw. */
  readonly waveform: unknown;
  readonly report: LtcLabImportReport;
}

export type LtcLabImportResult = { readonly ok: true; readonly plan: LtcLabImportPlan } | { readonly ok: false; readonly reason: string };

const REFS = { audio: "$ltcAudio", automation: "$ltcAutomation", presets: "$ltcPresets", cueList: "$ltcCueList", note: "$ltcNote" } as const;
const NODE_SPACING_X = 280;
/** VN64: the role that marks a node as the timeline's reference media. */
export const REFERENCE_AUDIO_NAME = "audiofile_reference";

export const toTicks = (seconds: number): number => Math.round(seconds * TICKS_PER_SECOND);

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  aif: "audio/aiff",
  aiff: "audio/aiff",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
};

export function audioMimeType(fileName: string): string {
  const extension = fileName.toLowerCase().split(".").pop() ?? "";
  return MIME_BY_EXTENSION[extension] ?? "application/octet-stream";
}

/** "HH:MM:SS:FF" non-drop → a frame count at `fps`; null when it does not read. */
export function timecodeFrame(text: string, fps: number): number | null {
  const match = /^(\d{1,2}):(\d{2}):(\d{2})[:;](\d{2})$/.exec(text.trim());
  if (match === null) return null;
  const [hours, minutes, seconds, frames] = match.slice(1).map(Number) as [number, number, number, number];
  const nominal = Math.round(fps);
  if (minutes > 59 || seconds > 59 || frames >= nominal) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
}

/** An identifier from free text: runs of anything else become one `_`; never empty, never leading with a digit. */
function identifierFrom(text: string, fallback: string): string {
  const cleaned = text.replace(/[^A-Za-z0-9_]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (cleaned === "") return fallback;
  return /^[0-9]/.test(cleaned) ? `${fallback}_${cleaned}` : cleaned;
}

function unique(base: string, used: Set<string>, joiner = "_"): string {
  let name = base;
  for (let ordinal = 2; used.has(name); ordinal += 1) name = `${base}${joiner}${ordinal}`;
  used.add(name);
  return name;
}

/** `/composition/layers/4/video/opacity` → `layers_4_video_opacity`. */
export function laneNameFromAddress(address: string): string {
  return identifierFrom(address.replace(/^\/?composition\//, ""), "osc");
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

interface KeyConversion {
  readonly keys: AutomationKey[];
  readonly nudged: number;
  readonly clamped: number;
}

/** A manual lane's keyframes → Loom keys (see the module header). */
export function convertKeyframes(keyframes: readonly LtcKeyframe[]): KeyConversion {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const ticks: number[] = [];
  let nudged = 0;
  let clamped = 0;
  for (const key of sorted) {
    let t = toTicks(key.time);
    const previous = ticks[ticks.length - 1];
    // Two keys on one tick (ltc-lab allows equal times: a step). Keep the step, one tick on.
    if (previous !== undefined && t <= previous) {
      t = previous + 1;
      nudged += 1;
    }
    ticks.push(t);
  }
  const keys = sorted.map((key, index) => {
    const t = ticks[index] as number;
    const before = index > 0 ? t - (ticks[index - 1] as number) : 0;
    const after = index < ticks.length - 1 ? (ticks[index + 1] as number) - t : 0;
    if (key.value < 0 || key.value > 1) clamped += 1;
    const inDt = Math.min(0, Math.max(-before, toTicks(key.in?.dt ?? 0)));
    const outDt = Math.max(0, Math.min(after, toTicks(key.out?.dt ?? 0)));
    return newKey(`key${index + 1}`, t, clamp01(key.value), {
      interp: "bezier",
      handle: "free",
      in: [inDt, key.in?.dv ?? 0],
      out: [outDt, key.out?.dv ?? 0],
    });
  });
  return { keys, nudged, clamped };
}

function sourceKind(lane: LtcLane): ImportedLane["source"] {
  const kind = lane.source?.kind;
  return kind === "onsets" || kind === "level" || kind === "figure" ? kind : "manual";
}

function trackDuration(track: LtcTrack, waveform: unknown): number {
  if (typeof track.durationSec === "number" && track.durationSec > 0) return track.durationSec;
  if (typeof waveform === "object" && waveform !== null) {
    const duration = (waveform as Record<string, unknown>)["durationSec"];
    if (typeof duration === "number" && duration > 0) return duration;
  }
  let last = 0;
  for (const lane of track.lanes) for (const key of lane.keyframes) last = Math.max(last, key.time);
  for (const marker of track.markers) last = Math.max(last, marker.time);
  return last + 1;
}

const listed = (what: string, names: readonly string[], why: string): NotImported => ({ what, count: names.length, names, why });

function actionLabel(marker: LtcMarker, action: { readonly kind: string; readonly label?: string }): string {
  return `${marker.text.trim() || `marker at ${marker.time}s`}: ${action.label ?? action.kind}`;
}

export function planLtcLabImport(source: LtcLabSource, options: LtcLabImportOptions): LtcLabImportResult {
  const { project } = source;
  const track = project.tracks.find((candidate) => candidate.id === options.trackId);
  if (track === undefined) {
    return { ok: false, reason: `the show has no track "${options.trackId}"; it has ${project.tracks.map((candidate) => `"${candidate.id}"`).join(", ") || "none"}` };
  }
  const fps = project.fps;
  const rateHz = options.bakeRateHz ?? 240;
  const tolerance = options.bakeTolerance ?? 0.002;
  if (!(rateHz > 0) || !(tolerance >= 0)) return { ok: false, reason: "bakeRateHz must be positive and bakeTolerance 0 or more" };
  const origin = options.origin ?? { x: 0, y: 0 };
  const warnings: string[] = [];

  const waveformBytes = source.files.get(waveformEntry(track.id));
  let waveform: unknown = null;
  if (waveformBytes !== undefined) {
    try {
      waveform = JSON.parse(new TextDecoder("utf-8").decode(waveformBytes));
    } catch {
      warnings.push(`the waveform cache for "${track.id}" is not valid JSON and was left out`);
    }
  }
  const durationSec = trackDuration(track, waveform);

  // ---- names ----
  const used = new Set<string>();
  const existing = new Set(options.existingNames ?? []);
  const taken = (name: string): boolean => used.has(name) || existing.has(name);
  const role = track.id.toLowerCase();
  const nameFor = (type: string): string => {
    const name = freeRoleName(type, role, taken);
    used.add(name);
    return name;
  };
  // The timeline's reference media is the node whose ROLE is `reference` (VN64). Until VN64's
  // `timelineReferenceOf(graph)` and this land together, this one line duplicates its check;
  // that helper is the source of truth once both are on main.
  const hasReference = [...existing].some((name) => /^(movie|audiofile)_reference$/.test(name));
  const audioName = hasReference ? nameFor("audioFileIn") : REFERENCE_AUDIO_NAME;
  used.add(audioName);

  // ---- lanes ----
  const gridAt = gridSourceOf(track);
  const laneNames = new Set<string>();
  const lanes: AutomationLane[] = [];
  const importedLanes: ImportedLane[] = [];
  for (const [index, lane] of track.lanes.entries()) {
    const name = unique(laneNameFromAddress(lane.address), laneNames);
    const muted = lane.enabled === false;
    let keys: AutomationKey[];
    const baked = isGenerated(lane);
    if (baked) {
      keys = bakeGenerated(lane, durationSec, gridAt, rateHz, tolerance).map((point, keyIndex) =>
        newKey(`key${keyIndex + 1}`, toTicks(point.seconds), point.v, { interp: "linear", handle: "free" }),
      );
    } else if (lane.keyframes.length === 0) {
      keys = [newKey("key1", 0, 0, { interp: "constant", handle: "free" })];
      warnings.push(`lane "${name}" (${lane.address}) has no keyframes; it is imported as one key holding its min, which is what ltc-lab sends`);
    } else {
      const converted = convertKeyframes(lane.keyframes);
      keys = converted.keys;
      if (converted.nudged > 0) warnings.push(`lane "${name}": ${converted.nudged} key(s) shared a time with the one before and moved one tick later, keeping the step`);
      if (converted.clamped > 0) warnings.push(`lane "${name}": ${converted.clamped} key value(s) outside 0..1 were clamped`);
    }
    lanes.push(newLane(`lane${index + 1}`, name, keys, { min: lane.min, max: lane.max, mute: muted }));
    importedLanes.push({ name, address: lane.address, source: sourceKind(lane), keys: keys.length, baked, muted });
  }
  const automationName = lanes.length > 0 ? nameFor("automation") : null;

  // ---- markers → presets + cue list ----
  const markers = [...track.markers].sort((a, b) => a.time - b.time);
  const presetsName = markers.length > 0 ? nameFor("presets") : null;
  const cueListName = markers.length > 0 ? nameFor("cueList") : null;
  const cueNames = new Set<string>();
  const presetNames = new Set<string>();
  const presets: Preset[] = [];
  const cues: Cue[] = [];
  const importedCues: ImportedCue[] = [];
  for (const [index, marker] of markers.entries()) {
    const text = (marker.text ?? "").trim();
    const cueName = unique(text === "" ? `marker ${index + 1}` : text, cueNames, " #");
    const presetName = unique(`ltc_${identifierFrom(text.toLowerCase(), `m${index + 1}`)}`, presetNames);
    presets.push({ name: presetName, values: {} });
    const notes = (marker.notes ?? "").trim();
    const at = Math.max(0, marker.time);
    cues.push({ name: cueName, bank: presetsName as string, preset: presetName, at, note: notes === "" ? "ltc-lab marker" : `ltc-lab marker. ${notes}` });
    importedCues.push({ name: cueName, at, preset: presetName });
  }
  const noteName = nameFor("annotate");

  // ---- not imported ----
  const notImported: NotImported[] = [];
  const songs = track.songs ?? [];
  if (songs.length > 0) notImported.push(listed("songs", songs.map((song) => `${song.title} @ ${song.offset}s`), "Loom has no songs inside a track; Audio File In takes the track grid only"));
  const segments = track.segments ?? [];
  if (segments.length > 0) notImported.push(listed("segments", segments.map((segment) => segment.label), "no regions yet (VN101)"));
  const actions = markers.flatMap((marker) => (marker.actions ?? []).map((action) => actionLabel(marker, action)));
  if (actions.length > 0) notImported.push(listed("cue actions", actions, "Resolume OSC / column / tempo actions have no Loom target; cues are imported as empty presets"));
  const stems = source.listing.filter((entry) => entry.name.startsWith(`stems/${track.id}/`)).map((entry) => entry.name.slice(`stems/${track.id}/`.length));
  if (stems.length > 0) notImported.push(listed("stems", stems, "stems are never read from the archive"));
  if (track.autoColumn?.enabled === true) notImported.push(listed("autoColumn", [track.autoColumn.pattern ?? "(no pattern)"], "Resolume column automation"));
  if (track.autoBpm?.enabled === true) notImported.push(listed("autoBpm", [String(track.autoBpm.bpm ?? "detected")], "Resolume tempo automation"));
  const midi = track.lanes.flatMap((lane, index) => (lane.midi ? [`${importedLanes[index]?.name}: ch ${lane.midi.channel} cc ${lane.midi.cc}`] : []));
  if (midi.length > 0) notImported.push(listed("MIDI", midi, "lane MIDI output has no Loom counterpart"));
  const ranges = track.lanes.flatMap((lane, index) => (lane.range ? [`${importedLanes[index]?.name}: ${lane.range.start}–${lane.range.end}s`] : []));
  if (ranges.length > 0) notImported.push(listed("lane ranges", ranges, "a Loom lane is active over the whole timeline; the curve outside the range was imported as it evaluates"));
  const colours = track.lanes.filter((lane) => typeof lane.color === "string" && lane.color !== "").length;
  if (colours > 0) notImported.push(listed("lane colours", importedLanes.map((lane) => lane.name), "Loom lanes take a colour token, not a literal"));
  if (track.loop?.enabled === true) notImported.push(listed("loop region", [`${track.loop.start}–${track.loop.end}s`], "set the project's frame range by hand"));
  if (track.videoPath) notImported.push(listed("video", [track.videoPath], "not read; add a Movie File In"));
  const addresses = importedLanes.map((lane) => `${lane.name} ← ${lane.address}`);

  // ---- audio ----
  const audioBytes = source.files.get(audioEntry(track.fileName)) ?? null;
  if (audioBytes === null) warnings.push(`the audio "${track.fileName}" is not in the source; bind it to ${audioName} by hand`);

  const startFrame = timecodeFrame(track.startTC, fps);
  if (startFrame === null) warnings.push(`startTC "${track.startTC}" does not read as HH:MM:SS:FF at ${fps} fps`);

  const grid = track.grid ?? null;
  const tempo = grid === null ? null : { bpm: grid.bpm, beatOffset: grid.anchor, beatsPerBar: Math.max(1, Math.round(grid.beatsPerBar)) };
  if (grid === null) warnings.push("the track has no beat grid; Audio File In keeps Tempo on Auto");

  // ---- operations ----
  let column = 0;
  const at = (): { x: number; y: number } => ({ x: origin.x + NODE_SPACING_X * column++, y: origin.y });
  const operations: GraphPatchOperation[] = [];
  operations.push({
    op: "addNode",
    ref: REFS.audio,
    type: "audioFileIn",
    label: audioName,
    position: at(),
    parameters: {
      playMode: "timeline",
      ...(tempo === null ? {} : { tempoMode: "declared", bpm: tempo.bpm, beatOffset: tempo.beatOffset, beatsPerBar: tempo.beatsPerBar }),
    },
  });
  if (automationName !== null) {
    operations.push({
      op: "addNode",
      ref: REFS.automation,
      type: "automation",
      label: automationName,
      position: at(),
      parameters: { lanes: serializeAutomation({ version: AUTOMATION_VERSION, lanes }) },
    });
  }
  if (presetsName !== null && cueListName !== null) {
    operations.push({
      op: "addNode",
      ref: REFS.presets,
      type: "presets",
      label: presetsName,
      position: at(),
      parameters: { presets: serializePresetBank({ version: 1, presets }) },
    });
    operations.push({
      op: "addNode",
      ref: REFS.cueList,
      type: "cueList",
      label: cueListName,
      position: at(),
      parameters: { follow: CUE_FOLLOW_TIMELINE, cues: serializeCueList({ version: 1, cues }) },
    });
  }
  const body = [
    `Imported from ltc-lab${source.tour?.name ? ` (${source.tour.name})` : ""}: track "${track.title}" (${track.id}), ${track.fileName}.`,
    `Start timecode ${track.startTC} at ${fps} fps (non-drop): timeline 0 is that timecode until the project has a start timecode of its own (VN72).`,
    tempo === null ? "No beat grid." : `Grid ${tempo.bpm} BPM, beat one at ${tempo.beatOffset}s, ${tempo.beatsPerBar} beats a bar.`,
    ...(addresses.length > 0 ? ["", "Lanes (Resolume OSC addresses):", ...addresses.map((line) => `- ${line}`)] : []),
    ...(notImported.length > 0 ? ["", "Not imported:", ...notImported.map((item) => `- ${item.what} (${item.count}): ${item.names.join("; ")}`)] : []),
  ].join("\n");
  operations.push({ op: "addNode", ref: REFS.note, type: "annotate", label: noteName, position: { x: origin.x, y: origin.y - 220 }, parameters: { title: `ltc-lab: ${track.title}`, body } });

  return {
    ok: true,
    plan: {
      operations,
      refs: {
        audio: REFS.audio,
        automation: automationName === null ? null : REFS.automation,
        presets: presetsName === null ? null : REFS.presets,
        cueList: cueListName === null ? null : REFS.cueList,
        note: REFS.note,
      },
      names: { audio: audioName, automation: automationName, presets: presetsName, cueList: cueListName, note: noteName },
      audio: { fileName: track.fileName, mimeType: audioMimeType(track.fileName), bytes: audioBytes, audioDir: source.tour?.audioDir ?? null },
      settings: { fps, frameRange: { start: 0, end: Math.max(1, Math.ceil(durationSec * fps) - 1) } },
      startTimecode: { text: track.startTC, fps, frame: startFrame },
      waveform,
      report: {
        track: { id: track.id, title: track.title, fileName: track.fileName, startTC: track.startTC, fps, durationSec },
        tempo,
        audioNode: {
          name: audioName,
          reference: !hasReference,
          why: hasReference
            ? "the document already has its timeline reference media (a movie_ or audiofile_reference), so this track's audio sits beside it"
            : "the document had no timeline reference media, so this track's audio becomes it",
        },
        lanes: importedLanes,
        cues: importedCues,
        notImported,
        warnings,
      },
    },
  };
}
