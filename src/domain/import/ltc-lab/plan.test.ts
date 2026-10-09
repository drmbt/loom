import { describe, expect, it } from "vitest";

import { compileAutomation, evaluateLane } from "../../automation/evaluate.ts";
import { parseAutomation, serializeAutomation, type AutomationLane } from "../../automation/model.ts";
import { parsePresetBank } from "../../presets/bank.ts";
import { parseCueList } from "../../presets/cue-list.ts";
import type { GraphPatchOperation } from "../../types/patch.ts";
import { figureValue, onsetValue } from "./lane-eval.ts";
import type { LtcFigureSource, LtcKeyframe, LtcLane, LtcProject, LtcTrack } from "./ltc-types.ts";
import { planLtcLabImport, timecodeFrame, type LtcLabImportPlan } from "./plan.ts";
import { sourceFromJson, sourceFromTar } from "./source.ts";
import { bytesReader, writeUstar, type RangeReader } from "./tar.ts";

/*
 * ltc-lab `src/lib/automation.ts` `evaluateLane`, its keyframe branch, as the REFERENCE the
 * imported Loom lane must reproduce: bezier between keys, each handle's dt clamped into its
 * segment (dv kept), the result clamped to 0..1, constant outside the keys.
 */
function ltcManualValue(keyframes: readonly LtcKeyframe[], t: number): number {
  const sorted = [...keyframes].sort((a, b) => a.time - b.time);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  if (t <= first.time) return first.value;
  if (t >= last.time) return last.value;
  let seg = 0;
  while (sorted[seg + 1]!.time < t) seg += 1;
  const k0 = sorted[seg]!;
  const k1 = sorted[seg + 1]!;
  const span = k1.time - k0.time;
  const bez = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
    const mu = 1 - u;
    return mu * mu * mu * p0 + 3 * mu * mu * u * p1 + 3 * mu * u * u * p2 + u * u * u * p3;
  };
  const p1x = k0.time + Math.min(Math.max(k0.out?.dt ?? 0, 0), span);
  const p2x = k1.time + Math.min(Math.max(k1.in?.dt ?? 0, -span), 0);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bez(k0.time, p1x, p2x, k1.time, mid) < t) lo = mid;
    else hi = mid;
  }
  const u = (lo + hi) / 2;
  const y = bez(k0.value, k0.value + (k0.out?.dv ?? 0), k1.value + (k1.in?.dv ?? 0), k1.value, u);
  return Math.min(1, Math.max(0, y));
}

const key = (time: number, value: number, out = { dt: 0, dv: 0 }, inHandle = { dt: 0, dv: 0 }): LtcKeyframe => ({ time, value, out, in: inHandle });

const MANUAL: LtcLane = {
  id: "l1",
  address: "/composition/layers/4/video/opacity",
  min: 0,
  max: 1,
  color: "#FFFFFF",
  enabled: true,
  keyframes: [
    key(1.23456, 0, { dt: 0.5, dv: 0.3 }),
    key(2.5, 0.9, { dt: 3, dv: 0 }, { dt: -0.4, dv: -0.2 }), // out handle longer than its segment
    key(4, 0.2, { dt: 0, dv: 0 }, { dt: -0.2, dv: 0.5 }),
    key(4, 0.7), // the same instant: a step
  ],
  midi: { channel: 1, cc: 20 },
};

const FIGURE: LtcFigureSource = { kind: "figure", shape: "pulse", beats: 0.5, phase: 0, low: 0, high: 1, width: 0.15, swing: 0, range: { start: 2, end: 6 }, seed: 1 };

const track = (overrides: Partial<LtcTrack> = {}): LtcTrack => ({
  id: "cloud-9",
  fileName: "03 CLOUD 9.wav",
  title: "CLOUD 9",
  startTC: "01:04:42:08",
  durationSec: 8,
  lanes: [
    MANUAL,
    { id: "l2", address: "/composition/layers/4/video/opacity", min: 0, max: 1, enabled: false, keyframes: [], source: FIGURE, range: { start: 2, end: 6 } },
    {
      id: "l3",
      address: "/composition/tempocontroller/tempo",
      min: 20,
      max: 500,
      keyframes: [],
      source: { kind: "onsets", adsr: { attackMs: 0, decayMs: 200, sustain: 0, releaseMs: 0 }, hits: [[1, 1], [3, 0.5]], curve: "linear" },
    },
    { id: "l4", address: "/composition/master", min: -1, max: 1, keyframes: [], source: { kind: "level", samples: { rate: 4, values: [0, 1, 0.5, 0.25, 0] } } },
  ],
  markers: [
    { id: "m2", time: 3.5, text: "verse", notes: "", actions: [{ kind: "column", label: "column VERSE #" }] },
    { id: "m1", time: 0, text: "INTRO", notes: "white only", actions: [{ kind: "bpm", label: "tempo 148" }] },
    { id: "m3", time: 5, text: "verse", notes: "" },
    { id: "m4", time: 6, text: "", notes: "" },
  ],
  grid: { bpm: 148, anchor: 0.029, beatsPerBar: 4, locked: false },
  songs: [{ id: "s1", title: "Cloud 9", offset: 0 }],
  segments: [{ id: "g1", label: "intro", start: 0, end: 3 }],
  autoColumn: { enabled: true, pattern: "CLOUD*" },
  autoBpm: { enabled: true, bpm: 148 },
  ...overrides,
});

const project = (tracks: LtcTrack[] = [track()]): LtcProject => ({ fps: 30, tracks });

function planOf(tracks?: LtcTrack[], existingNames: readonly string[] = ["movie_reference"]): LtcLabImportPlan {
  const read = sourceFromJson(project(tracks), { name: "TOUR", audioDir: "/audio" });
  if (!read.ok) throw new Error(read.reason);
  const result = planLtcLabImport(read.source, { trackId: "cloud-9", existingNames });
  if (!result.ok) throw new Error(result.reason);
  return result.plan;
}

type AddNode = Extract<GraphPatchOperation, { op: "addNode" }>;
const added = (plan: LtcLabImportPlan, type: string): AddNode => {
  const op = plan.operations.find((candidate): candidate is AddNode => candidate.op === "addNode" && candidate.type === type);
  if (op === undefined) throw new Error(`no ${type}`);
  return op;
};

function lanesOf(plan: LtcLabImportPlan): readonly AutomationLane[] {
  const parsed = parseAutomation(added(plan, "automation").parameters?.["lanes"]);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.document.lanes;
}

/** What the lane's curve reads at `seconds`, muted or not (a muted lane holds; the curve is what was imported). */
function loomValue(plan: LtcLabImportPlan, laneName: string, seconds: number): number {
  const unmuted = { version: 1 as const, lanes: lanesOf(plan).map((lane) => ({ ...lane, mute: false })) };
  const compiled = compileAutomation(serializeAutomation(unmuted));
  if (!compiled.ok) throw new Error(compiled.reason);
  const lane = compiled.compiled.lanes.find((candidate) => candidate.lane.name === laneName)!;
  return evaluateLane(lane, Math.round(seconds * 240_000));
}

describe("VN100 ltc-lab track → Loom plan", () => {
  it("makes a timeline-locked Audio File In with the grid as its declared tempo", () => {
    const plan = planOf();
    const audio = added(plan, "audioFileIn");
    expect(audio.label).toBe("audiofile_cloud_9");
    expect(audio.parameters).toEqual({ playMode: "timeline", tempoMode: "declared", bpm: 148, beatOffset: 0.029, beatsPerBar: 4 });
    expect(plan.audio).toEqual({ fileName: "03 CLOUD 9.wav", mimeType: "audio/wav", bytes: null, audioDir: "/audio" });
    expect(plan.settings).toEqual({ fps: 30, frameRange: { start: 0, end: 239 } });
    expect(plan.startTimecode).toEqual({ text: "01:04:42:08", fps: 30, frame: timecodeFrame("01:04:42:08", 30) });
    expect(plan.startTimecode.frame).toBe(((1 * 60 + 4) * 60 + 42) * 30 + 8);
  });

  it("keeps manual keys exactly: ticks rounded, handles in ticks held in their segment, a shared instant one tick on", () => {
    const lanes = lanesOf(planOf());
    const manual = lanes[0]!;
    expect(manual.name).toBe("layers_4_video_opacity");
    expect(manual.keys.map((k) => k.t)).toEqual([296_294, 600_000, 960_000, 960_001]);
    expect(manual.keys.map((k) => k.v)).toEqual([0, 0.9, 0.2, 0.7]);
    expect(manual.keys[0]!.out).toEqual([120_000, 0.3]);
    // 3 s out handle, 1.5 s segment: Δt held at the segment, dv kept (ltc-lab's clamp).
    expect(manual.keys[1]!.out).toEqual([360_000, 0]);
    expect(manual.keys[1]!.in).toEqual([-96_000, -0.2]);
    expect(manual.keys.every((k) => k.interp === "bezier" && k.handle === "free")).toBe(true);
  });

  it("evaluates in Loom as ltc-lab evaluates it", () => {
    const plan = planOf();
    for (let t = 0; t <= 5; t += 0.05) {
      expect(loomValue(plan, "layers_4_video_opacity", t)).toBeCloseTo(ltcManualValue(MANUAL.keyframes, t), 3);
    }
  });

  it("bakes a figure lane without dropping a 30 ms pulse, on the grid ltc-lab locks it to", () => {
    const plan = planOf();
    const lanes = lanesOf(plan);
    const figure = lanes[1]!;
    expect(figure.name).toBe("layers_4_video_opacity_2");
    expect(figure.mute).toBe(true);
    expect(figure.keys.every((k) => k.interp === "linear")).toBe(true);
    const grid = { bpm: 148, anchor: 0.029, beatsPerBar: 4 };
    // Every pulse inside the range is a rise in the baked keys: count them both ways.
    let expected = 0;
    let previous = 0;
    for (let t = 0; t <= 8; t += 0.001) {
      const v = figureValue(FIGURE, t, grid);
      if (v > 0.5 && previous <= 0.5) expected += 1;
      previous = v;
    }
    let rises = 0;
    for (let i = 1; i < figure.keys.length; i++) if (figure.keys[i]!.v > 0.5 && figure.keys[i - 1]!.v <= 0.5) rises += 1;
    expect(expected).toBeGreaterThan(15);
    expect(rises).toBe(expected);
    // Off the edges (more than one bake sample, 1/240 s, away), Loom reads the figure.
    for (let t = 0; t <= 8; t += 0.0137) {
      const near = [-1 / 240, 1 / 240].some((d) => figureValue(FIGURE, t + d, grid) !== figureValue(FIGURE, t, grid));
      if (!near) expect(loomValue(plan, "layers_4_video_opacity_2", t)).toBeCloseTo(figureValue(FIGURE, t, grid), 2);
    }
  });

  it("bakes onsets and level lanes into the lane's own range", () => {
    const plan = planOf();
    const adsr = { attackMs: 0, decayMs: 200, sustain: 0, releaseMs: 0 };
    const hits: [number, number][] = [[1, 1], [3, 0.5]];
    for (const t of [0.5, 1, 1.05, 1.1, 1.19, 3, 3.1, 4]) {
      expect(loomValue(plan, "tempocontroller_tempo", t)).toBeCloseTo(20 + onsetValue(hits, adsr, t, "linear") * 480, 0);
    }
    expect(loomValue(plan, "tempocontroller_tempo", 1)).toBe(500);
    // level: linear between 4 Hz samples; min..max is -1..1.
    expect(loomValue(plan, "master", 0.25)).toBeCloseTo(1, 6);
    expect(loomValue(plan, "master", 0.375)).toBeCloseTo(0.5, 6);
    expect(loomValue(plan, "master", 0.75)).toBeCloseTo(-0.5, 6);
  });

  it("puts each marker on a timeline cue list, pointing at an empty, recognisable preset", () => {
    const plan = planOf();
    const list = added(plan, "cueList");
    expect(list.label).toBe("cuelist_cloud_9");
    expect(list.parameters?.["follow"]).toBe("timeline");
    const cues = parseCueList(list.parameters?.["cues"]);
    expect(cues.ok).toBe(true);
    if (!cues.ok) return;
    expect(cues.list.cues.map((cue) => [cue.name, cue.at, cue.bank, cue.preset])).toEqual([
      ["INTRO", 0, "presets_cloud_9", "ltc_intro"],
      ["verse", 3.5, "presets_cloud_9", "ltc_verse"],
      ["verse #2", 5, "presets_cloud_9", "ltc_verse_2"],
      ["marker 4", 6, "presets_cloud_9", "ltc_m4"],
    ]);
    expect(cues.list.cues[0]!.note).toBe("ltc-lab marker. white only");
    expect(cues.list.cues[1]!.note).toBe("ltc-lab marker");
    const bank = parsePresetBank(added(plan, "presets").parameters?.["presets"]);
    expect(bank.ok).toBe(true);
    if (bank.ok) expect(bank.bank.presets.map((preset) => [preset.name, preset.values])).toEqual([
      ["ltc_intro", {}],
      ["ltc_verse", {}],
      ["ltc_verse_2", {}],
      ["ltc_m4", {}],
    ]);
  });

  it("reports everything it leaves behind, by name and count, and writes the start timecode into the note", () => {
    const plan = planOf();
    const byWhat = Object.fromEntries(plan.report.notImported.map((item) => [item.what, item]));
    expect(byWhat["songs"]?.names).toEqual(["Cloud 9 @ 0s"]);
    expect(byWhat["segments"]?.names).toEqual(["intro"]);
    expect(byWhat["cue actions"]?.names).toEqual(["INTRO: tempo 148", "verse: column VERSE #"]);
    expect(byWhat["autoColumn"]?.names).toEqual(["CLOUD*"]);
    expect(byWhat["autoBpm"]?.names).toEqual(["148"]);
    expect(byWhat["MIDI"]?.names).toEqual(["layers_4_video_opacity: ch 1 cc 20"]);
    expect(byWhat["lane ranges"]?.count).toBe(1);
    expect(plan.report.lanes.map((lane) => [lane.name, lane.address, lane.source, lane.baked])).toEqual([
      ["layers_4_video_opacity", "/composition/layers/4/video/opacity", "manual", false],
      ["layers_4_video_opacity_2", "/composition/layers/4/video/opacity", "figure", true],
      ["tempocontroller_tempo", "/composition/tempocontroller/tempo", "onsets", true],
      ["master", "/composition/master", "level", true],
    ]);
    const note = added(plan, "annotate");
    expect(note.label).toBe("note_cloud_9");
    expect(String(note.parameters?.["body"])).toContain("Start timecode 01:04:42:08 at 30 fps");
    expect(String(note.parameters?.["body"])).toContain("cue actions (2)");
    expect(plan.report.warnings.some((warning) => warning.includes("moved one tick later"))).toBe(true);
  });

  it("takes names the document already holds into account", () => {
    const plan = planOf(undefined, ["movie_reference", "audiofile_cloud_9", "note_cloud_9"]);
    // The house numbering rule (`renumberedName`): trailing digits are the counter.
    expect(plan.names.audio).toBe("audiofile_cloud_1");
    expect(plan.names.note).toBe("note_cloud_1");
    expect(plan.names.automation).toBe("automation_cloud_9");
  });

  it("makes the audio the timeline's reference media when the document has none, and says so", () => {
    const fresh = planOf(undefined, ["blur1"]);
    expect(fresh.names.audio).toBe("audiofile_reference");
    expect(added(fresh, "audioFileIn").label).toBe("audiofile_reference");
    expect(fresh.report.audioNode).toMatchObject({ name: "audiofile_reference", reference: true });
    const beside = planOf(undefined, ["audiofile_reference"]);
    expect(beside.names.audio).toBe("audiofile_cloud_9");
    expect(beside.report.audioNode).toMatchObject({ name: "audiofile_cloud_9", reference: false });
  });

  it("adds no automation or cue list for a track that has neither, and keeps Tempo on Auto with no grid", () => {
    const plan = planOf([track({ lanes: [], markers: [], grid: null })]);
    expect(plan.operations.map((op) => (op.op === "addNode" ? op.type : op.op))).toEqual(["audioFileIn", "annotate"]);
    expect(added(plan, "audioFileIn").parameters).toEqual({ playMode: "timeline" });
    expect(plan.refs.automation).toBeNull();
  });

  it("refuses a track the show does not have, listing the ones it does", () => {
    const read = sourceFromJson(project());
    if (!read.ok) throw new Error(read.reason);
    expect(planLtcLabImport(read.source, { trackId: "nope" })).toEqual({ ok: false, reason: 'the show has no track "nope"; it has "cloud-9"' });
  });

  it("refuses a malformed project.json by the first thing wrong", () => {
    expect(sourceFromJson({ fps: 30, tracks: [{ id: "a", fileName: "a.wav", startTC: "00:00:00:00", lanes: [{ address: "/x", min: 0, max: 1, keyframes: [{ time: "1", value: 0 }] }], markers: [] }] })).toEqual({
      ok: false,
      reason: 'project.json: track "a", lane 1 ("/x"), keyframe 1: time and value must be finite numbers',
    });
  });
});

describe("VN100 reading a .ltcshow.tar", () => {
  const text = (value: string): Uint8Array => new TextEncoder().encode(value);
  const audio = new Uint8Array(3000).fill(3);
  const archive = writeUstar([
    { name: "manifest.json", bytes: text(JSON.stringify({ format: "ltcshow", version: 1 })) },
    { name: "project.json", bytes: text(JSON.stringify(project([track(), track({ id: "other", fileName: "other.wav" })]))) },
    { name: "tour.json", bytes: text(JSON.stringify({ name: "TOUR", audioDir: "/audio" })) },
    { name: "cache/waveforms/cloud-9.json", bytes: text(JSON.stringify({ version: 2, binsPerSec: 50, durationSec: 8, min: [], max: [] })) },
    { name: "cache/analysis/cloud-9.json", bytes: new Uint8Array(5000) },
    { name: "stems/cloud-9/drums.wav", bytes: new Uint8Array(7000) },
    { name: "media/audio/03 CLOUD 9.wav", bytes: audio },
    { name: "media/audio/other.wav", bytes: new Uint8Array(6000) },
  ]);

  it("reads the track's audio and waveform and nothing it does not import", async () => {
    const lengths: number[] = [];
    const inner = bytesReader(archive);
    const reader: RangeReader = { size: () => inner.size(), read: (offset, length) => (lengths.push(length), inner.read(offset, length)) };
    const read = await sourceFromTar(reader, "cloud-9");
    if (!read.ok) throw new Error(read.reason);
    expect([...read.source.files.keys()]).toEqual(["manifest.json", "project.json", "tour.json", "cache/waveforms/cloud-9.json", "media/audio/03 CLOUD 9.wav"]);
    expect(lengths.some((length) => length === 5000 || length === 7000 || length === 6000)).toBe(false);
    const result = planLtcLabImport(read.source, { trackId: "cloud-9" });
    if (!result.ok) throw new Error(result.reason);
    expect(result.plan.audio.bytes?.length).toBe(3000);
    expect(result.plan.audio.bytes?.every((byte) => byte === 3)).toBe(true);
    expect(result.plan.waveform).toMatchObject({ binsPerSec: 50, durationSec: 8 });
    expect(result.plan.report.notImported.find((item) => item.what === "stems")?.names).toEqual(["drums.wav"]);
  });

  it("refuses an archive that is not an ltc-lab show", async () => {
    const other = writeUstar([
      { name: "manifest.json", bytes: text('{"format":"zip"}') },
      { name: "project.json", bytes: text(JSON.stringify(project())) },
    ]);
    expect(await sourceFromTar(bytesReader(other))).toEqual({ ok: false, reason: 'the archive is not an ltc-lab show package (manifest format "zip")' });
  });
});
