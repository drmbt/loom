import { CLIP_TRACK_VERSION, type ClipTrack, type Direction, type PlayMode, type Region } from "../../regions/model.ts";
import { TICKS_PER_SECOND } from "../../time/ticks.ts";
import { child, childrenOf, find, named, parseXml, path, type XmlElement } from "./xml.ts";

/**
 * VN102 — A RESOLUME COMPOSITION (`.avc`) AS CLIP-TRACK PROPOSALS. Headless and pure: text in,
 * proposals and a report out. Nothing is written; the caller decides what to build.
 *
 * ## What a `.avc` holds (Arena 7.28, surveyed 2026-10-08)
 *
 * `<Composition>` > `<Deck deckIndex>` > `<Clip layerIndex columnIndex>` (0-based), most of
 * them empty. A file-backed clip names its media in `PreloadData/VideoFile@value` (and again
 * in `VideoTrack … VideoFormatReaderSource@fileName`). Its transport is
 * `Clip/Params/ParamChoice[TransportType]` (0 Timeline, 1 BPM Sync, 2/3 SMPTE 1/2) and, under
 * `Transport/Params/ParamRange[Position]`:
 *   - `ValueRange[minMax]`: 0 .. the file's duration in ms (checked against ffprobe);
 *   - `ValueRange[startStop]`: the in and out points in ms, when trimmed (0..0: never
 *     trimmed, the whole file);
 *   - `DurationSource@defaultDuration`: `"108.447s"`, or `"128b"` for BPM sync;
 *   - `PhaseSourceTransportTimeline/Params`: `Speed`, `PlayMode` (0 loop, 1 bounce, 2 random,
 *     3 play once and clear, 4 play once and hold), `PlayDirection` (0 reverse, 1 pause,
 *     2 forward — the UI's `<  ||  >`, 2 being the default), `BeatLoop`, `TempoSynced`, and
 *     `Beats_d@numManualBeats` (the beats one pass takes under BPM sync);
 *   - `PhaseSourceSMPTE/Params/Param[Offset]`: ms of timecode the clip is placed at.
 * A parameter at its default is OMITTED, so every read here has a default.
 * The composition's tempo is `TempoController/Params/ParamRange[Tempo]@value`.
 *
 * ## Clips are not on a timeline in Resolume
 *
 * They sit in a grid and are triggered. Laying them out in time is a choice, `layout`:
 *   - `sequence` (default): each layer's clips in column order, back to back, each at its
 *     NATURAL length (one pass: (out − in) / speed; a bounce there and back; BPM sync its
 *     beats at the tempo);
 *   - `columns`: a column is a scene, so every layer's clip in column N starts at the same
 *     time, and the column lasts as long as its longest clip.
 *
 * ## What is not imported, and is reported
 *
 * Generator, router, feedback, capture and audio-only clips (no media file); SMPTE clips
 * (with their offset, as milliseconds and timecode, for VN72 to place); random play mode;
 * `PersistentClip`s; and, on clips that ARE imported, settings regions cannot carry: BeatLoop,
 * a paused direction (imported as speed 0), the BPM-sync speed multiplier, autopilot.
 */

export type ResolumeLayout = "sequence" | "columns";

export interface ResolumeImportOptions {
  readonly layout?: ResolumeLayout;
  /** Only these decks (0-based `deckIndex`); all when absent. */
  readonly decks?: readonly number[];
  /** Ticks left empty between consecutive regions (sequence) or columns (columns). Default 0. */
  readonly gapTicks?: number;
  /** BPM for BPM-synced regions' lengths; the composition's own tempo when absent. */
  readonly tempo?: number;
}

export type NotImportedKind =
  | "generator" | "router" | "feedback" | "capture" | "audio" | "noSource"
  | "smpte" | "random" | "persistent" | "badTiming";

export interface NotImported {
  readonly deck: number;
  readonly deckName: string;
  readonly layer: number;
  readonly column: number;
  readonly clip: string;
  readonly kind: NotImportedKind;
  readonly detail: string;
  /** SMPTE clips: where the clip is placed, ms of timecode. */
  readonly smpteOffsetMs?: number;
  readonly media?: string;
}

export type DroppedSetting = "beatLoop" | "pausedDirection" | "bpmSyncSpeed" | "autopilot";

export interface Dropped {
  readonly deck: number;
  readonly layer: number;
  readonly column: number;
  readonly regionId: string;
  readonly setting: DroppedSetting;
  readonly detail: string;
}

export interface TrackProposal {
  readonly deck: number;
  readonly deckName: string;
  readonly layer: number;
  readonly layerName: string;
  readonly track: ClipTrack;
}

export interface ResolumeImport {
  readonly name: string;
  readonly tempo: number;
  readonly decks: ReadonlyArray<{ readonly index: number; readonly name: string }>;
  readonly tracks: readonly TrackProposal[];
  readonly notImported: readonly NotImported[];
  readonly dropped: readonly Dropped[];
  /** Counts, for a summary line and for the gate. */
  readonly counts: {
    readonly clips: number;
    readonly fileClips: number;
    readonly regions: number;
    readonly bpmSync: number;
    readonly byPlayMode: Readonly<Record<PlayMode, number>>;
    readonly reverse: number;
    readonly trimmed: number;
  };
}

const MS = TICKS_PER_SECOND / 1000;

const num = (value: string | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

/** A parameter's stored value, or its stated default, or ours. */
const valueOf = (element: XmlElement | undefined, fallback: number): number =>
  element === undefined ? fallback : num(element.attributes["value"] ?? element.attributes["default"], fallback);

/** Floating noise Resolume writes (0.99999999999994837463) rounded off: nine decimals. */
const tidy = (value: number): number => Math.round(value * 1e9) / 1e9;

function timecode(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(Math.floor(value)).padStart(2, "0");
  const millis = String(Math.round((seconds % 1) * 1000)).padStart(3, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${millis}`;
}

const SOURCE_KINDS: Readonly<Record<string, NotImportedKind>> = {
  GeneratorVideoSource: "generator",
  CompositionRouterVideoSource: "router",
  VideoSourceFeedback: "feedback",
  CaptureDeviceVideoSource: "capture",
};

const PLAY_MODES: Readonly<Record<number, PlayMode | "random">> = { 0: "loop", 1: "bounce", 2: "random", 3: "onceClear", 4: "onceHold" };

function mediaOf(clip: XmlElement): string | null {
  const preload = path(clip, "PreloadData", "VideoFile")?.attributes["value"];
  if (preload !== undefined && preload !== "") return preload;
  const reader = find(child(clip, "VideoTrack"), (entry) => entry.tag === "VideoFormatReaderSource");
  const file = reader?.attributes["fileName"];
  return file !== undefined && file !== "" ? file : null;
}

function sourceKind(clip: XmlElement): NotImportedKind {
  const source = find(child(clip, "VideoTrack"), (entry) => entry.tag === "VideoSource");
  const type = source?.attributes["type"];
  if (type !== undefined && SOURCE_KINDS[type] !== undefined) return SOURCE_KINDS[type];
  if (child(clip, "AudioTrack") !== undefined) return "audio";
  return "noSource";
}

/** Composition tempo: `TempoController/Params/ParamRange[Tempo]`. */
function compositionTempo(root: XmlElement): number {
  const controller = find(root, (entry) => entry.tag === "TempoController");
  const tempo = valueOf(named(child(controller, "Params"), "ParamRange", "Tempo"), 120);
  return tempo > 0 ? tempo : 120;
}

interface Candidate {
  readonly deck: number;
  readonly layer: number;
  readonly column: number;
  readonly region: Omit<Region, "timelineStart">;
}

/** Read a `.avc`'s text into clip-track proposals and a report of everything left behind. */
export function importResolumeComposition(text: string, options: ResolumeImportOptions = {}): ResolumeImport {
  const root = parseXml(text);
  if (root.tag !== "Composition") throw new Error(`Not a Resolume composition: the root is <${root.tag}>, not <Composition>.`);
  const info = child(root, "CompositionInfo");
  const deckNames = childrenOf(info, "DeckInfo").map((entry) => entry.attributes["name"] ?? "");
  const tempo = options.tempo !== undefined && options.tempo > 0 ? options.tempo : compositionTempo(root);
  const layout = options.layout ?? "sequence";
  const gap = Math.max(0, Math.round(options.gapTicks ?? 0));
  const layerNames = new Map<number, string>();
  for (const layer of childrenOf(root, "Layer")) {
    const name = named(child(layer, "Params"), "Param", "Name")?.attributes["value"];
    layerNames.set(num(layer.attributes["layerIndex"], -1), name ?? "");
  }

  const notImported: NotImported[] = [];
  const dropped: Dropped[] = [];
  const candidates: Candidate[] = [];
  const counts = {
    clips: 0, fileClips: 0, regions: 0, bpmSync: 0, reverse: 0, trimmed: 0,
    byPlayMode: { loop: 0, bounce: 0, onceHold: 0, onceClear: 0 } as Record<PlayMode, number>,
  };
  const decks: Array<{ index: number; name: string }> = [];

  for (const deckElement of childrenOf(root, "Deck")) {
    const deck = num(deckElement.attributes["deckIndex"], decks.length);
    const deckName = deckNames[deck] ?? `Deck ${deck + 1}`;
    decks.push({ index: deck, name: deckName });
    if (options.decks !== undefined && !options.decks.includes(deck)) continue;
    for (const clip of childrenOf(deckElement, "Clip")) {
      if (clip.children.length === 0) continue;
      counts.clips += 1;
      const layer = num(clip.attributes["layerIndex"], 0);
      const column = num(clip.attributes["columnIndex"], 0);
      const clipName = named(child(clip, "Params"), "Param", "Name")?.attributes["value"] ?? clip.attributes["name"] ?? "Clip";
      const where = { deck, deckName, layer, column, clip: clipName };
      const media = mediaOf(clip);
      if (media === null) {
        const kind = sourceKind(clip);
        notImported.push({ ...where, kind, detail: kind === "noSource" ? "no media file and no recognised source" : `a ${kind} clip has no media file` });
        continue;
      }
      counts.fileClips += 1;
      const transportType = valueOf(named(child(clip, "Params"), "ParamChoice", "TransportType"), 0);
      const position = path(clip, "Transport", "Params", "ParamRange[Position]");
      if (transportType === 2 || transportType === 3) {
        const offset = valueOf(path(position, "PhaseSourceSMPTE", "Params", "Param[Offset]"), 0);
        notImported.push({
          ...where, media, kind: "smpte", smpteOffsetMs: offset,
          detail: `SMPTE ${transportType === 2 ? 1 : 2} transport, placed at ${timecode(offset)} (offset ${offset} ms); regions are placed by VN72`,
        });
        continue;
      }
      const timeline = child(position, "PhaseSourceTransportTimeline");
      const params = child(timeline, "Params");
      const modeIndex = valueOf(named(params, null, "PlayMode"), 0);
      const mode = PLAY_MODES[modeIndex] ?? "loop";
      if (mode === "random") {
        notImported.push({ ...where, media, kind: "random", detail: "random play mode jumps by chance; a region is a function of the playhead" });
        continue;
      }
      const durationMs = (() => {
        const minMax = named(position, "ValueRange", "minMax");
        if (minMax !== undefined) return num(minMax.attributes["max"], 0);
        const declared = child(position, "DurationSource")?.attributes["defaultDuration"] ?? "";
        return declared.endsWith("s") ? num(declared.slice(0, -1), 0) * 1000 : 0;
      })();
      // `startStop` of 0..0 (Arena writes it for a clip never trimmed) means the whole file.
      const stored = named(position, "ValueRange", "startStop");
      const startStop = stored !== undefined && num(stored.attributes["max"], 0) > num(stored.attributes["min"], 0) ? stored : undefined;
      const inMs = startStop === undefined ? 0 : num(startStop.attributes["min"], 0);
      const outMs = startStop === undefined ? durationMs : Math.min(num(startStop.attributes["max"], durationMs), durationMs > 0 ? durationMs : Infinity);
      const sourceIn = Math.max(0, Math.round(inMs * MS));
      const sourceOut = Math.round(outMs * MS);
      if (!(sourceOut > sourceIn)) {
        notImported.push({ ...where, media, kind: "badTiming", detail: `in ${inMs} ms is not before out ${outMs} ms` });
        continue;
      }
      if (startStop !== undefined) counts.trimmed += 1;
      const regionId = `d${deck}l${layer}c${column}`;
      const drop = (setting: DroppedSetting, detail: string) => dropped.push({ deck, layer, column, regionId, setting, detail });
      const directionIndex = valueOf(named(params, null, "PlayDirection"), 2);
      const direction: Direction = directionIndex === 0 ? "reverse" : "forward";
      let speed = Math.max(0, tidy(valueOf(named(params, "ParamRange", "Speed"), 1)));
      if (directionIndex === 1) {
        drop("pausedDirection", "the clip's direction is paused (||); imported as speed 0, a still on the in point");
        speed = 0;
      }
      if (direction === "reverse") counts.reverse += 1;
      const beatLoop = named(params, null, "BeatLoop");
      if (beatLoop !== undefined && valueOf(beatLoop, 0) !== 0) drop("beatLoop", `BeatLoop ${beatLoop.attributes["value"] ?? ""} is a live loop of the last beats; not a region setting`);
      if (find(clip, (entry) => /autopilot/i.test(entry.tag) || /autopilot/i.test(entry.attributes["name"] ?? "")) !== undefined) {
        drop("autopilot", "autopilot triggers the next clip live; the timeline places regions instead");
      }
      let bpmSync: { beats: number } | undefined;
      if (transportType === 1) {
        const declared = child(position, "DurationSource")?.attributes["defaultDuration"] ?? "";
        const beats = num(child(timeline, "Beats_d")?.attributes["numManualBeats"], declared.endsWith("b") ? num(declared.slice(0, -1), 4) : 4);
        bpmSync = { beats: beats > 0 ? beats : 4 };
        counts.bpmSync += 1;
        if (speed !== 1 && speed !== 0) drop("bpmSyncSpeed", `BPM-sync speed multiplier ×${speed} folded in: the region plays its span in ${bpmSync.beats / speed} beats`);
        if (speed > 0 && speed !== 1) bpmSync = { beats: bpmSync.beats / speed };
      }
      // One natural pass on the timeline, in ticks.
      const span = sourceOut - sourceIn;
      const passTicks = bpmSync !== undefined
        ? (bpmSync.beats * 60 * TICKS_PER_SECOND) / tempo
        : speed > 0 ? span / speed : span;
      const length = Math.max(1, Math.round(mode === "bounce" ? 2 * passTicks : passTicks));
      counts.byPlayMode[mode] += 1;
      counts.regions += 1;
      candidates.push({
        deck, layer, column,
        region: {
          id: regionId, media, sourceIn, sourceOut, length, playMode: mode, speed, direction,
          ...(bpmSync === undefined ? {} : { bpmSync }), fadeIn: 0, fadeOut: 0,
        },
      });
    }
  }
  // A layer's persistent clips sit outside the deck grid, wherever the layer is (a group too).
  const walk = (element: XmlElement) => {
    for (const entry of element.children) {
      if (entry.tag !== "PersistentClip") {
        walk(entry);
        continue;
      }
      notImported.push({
        deck: -1, deckName: "", layer: num(entry.attributes["layerIndex"], -1), column: -1,
        clip: named(child(entry, "Params"), "Param", "Name")?.attributes["value"] ?? "PersistentClip",
        kind: "persistent", detail: "a layer's persistent clip, outside the deck grid",
      });
    }
  };
  walk(root);

  // Lay out, per deck and layer.
  const tracks: TrackProposal[] = [];
  const byDeck = new Map<number, Candidate[]>();
  for (const candidate of candidates) byDeck.set(candidate.deck, [...(byDeck.get(candidate.deck) ?? []), candidate]);
  for (const [deck, list] of [...byDeck].sort((a, b) => a[0] - b[0])) {
    const columnStart = new Map<number, number>();
    if (layout === "columns") {
      const columns = [...new Set(list.map((entry) => entry.column))].sort((a, b) => a - b);
      let at = 0;
      for (const column of columns) {
        columnStart.set(column, at);
        const longest = Math.max(...list.filter((entry) => entry.column === column).map((entry) => entry.region.length));
        at += longest + gap;
      }
    }
    const layers = [...new Set(list.map((entry) => entry.layer))].sort((a, b) => a - b);
    for (const layer of layers) {
      const ordered = list.filter((entry) => entry.layer === layer).sort((a, b) => a.column - b.column);
      let at = 0;
      const regions: Region[] = ordered.map((entry) => {
        const timelineStart = layout === "columns" ? (columnStart.get(entry.column) ?? 0) : at;
        at = timelineStart + entry.region.length + gap;
        return { ...entry.region, timelineStart };
      });
      const deckName = deckNames[deck] ?? `Deck ${deck + 1}`;
      const layerName = layerNames.get(layer) ?? "";
      tracks.push({
        deck, deckName, layer, layerName,
        track: {
          version: CLIP_TRACK_VERSION,
          id: `d${deck}l${layer}`,
          name: `${deckName} / ${layerName === "" ? `Layer ${layer + 1}` : layerName.replace(/#/g, String(layer + 1))}`,
          regions,
        },
      });
    }
  }

  return {
    name: info?.attributes["name"] ?? root.attributes["name"] ?? "Composition",
    tempo,
    decks,
    tracks,
    notImported,
    dropped,
    counts,
  };
}
