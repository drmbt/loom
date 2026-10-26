import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseAutomation } from "../../automation/model.ts";
import { parseCueList } from "../../presets/cue-list.ts";
import type { GraphPatchOperation } from "../../types/patch.ts";
import { planLtcLabImport, type LtcLabImportPlan } from "./plan.ts";
import { listLtcLabTracks, sourceFromJson, type LtcLabSource } from "./source.ts";

/*
 * VN100 against a REAL ltc-lab show: the Tinashe tour in a sibling ltc-lab checkout
 * (`../ltc-lab` beside this repository, or `$LTC_LAB_DIR`). It is local data that is not
 * in this repository, so the suite SKIPS, saying why, on a machine without it. Its numbers
 * were read off that project.json on 2026-10-08; a re-edited show fails here by name.
 */
const LTC_LAB_DIR = process.env["LTC_LAB_DIR"] ?? fileURLToPath(new URL("../../../../../ltc-lab", import.meta.url));
const PROJECT = `${LTC_LAB_DIR}/data/tinashe-popstar-2026/project.json`;
const TOUR = `${LTC_LAB_DIR}/tours/tinashe-popstar-2026.json`;
const present = existsSync(PROJECT);
if (!present) console.info(`VN100 real-show test skipped: no ltc-lab show at ${PROJECT} (local data; set LTC_LAB_DIR to run it)`);

type AddNode = Extract<GraphPatchOperation, { op: "addNode" }>;

describe.skipIf(!present)("VN100 import of a real ltc-lab track (Tinashe tour)", () => {
  const source = (): LtcLabSource => {
    const read = sourceFromJson(readFileSync(PROJECT, "utf-8"), existsSync(TOUR) ? readFileSync(TOUR, "utf-8") : undefined);
    if (!read.ok) throw new Error(read.reason);
    return read.source;
  };
  const plan = (trackId: string): LtcLabImportPlan => {
    const result = planLtcLabImport(source(), { trackId });
    if (!result.ok) throw new Error(result.reason);
    return result.plan;
  };
  const node = (p: LtcLabImportPlan, type: string): AddNode =>
    p.operations.find((op): op is AddNode => op.op === "addNode" && op.type === type) as AddNode;

  it("lists the show's 26 tracks at 30 fps", () => {
    const tracks = listLtcLabTracks(source());
    expect(source().project.fps).toBe(30);
    expect(tracks).toHaveLength(26);
    expect(tracks[0]).toMatchObject({ id: "intro-popstar", startTC: "01:00:00:00", lanes: 1, markers: 27, bpm: 140 });
  });

  it("INTRO + POPSTAR: one manual lane of 46 keys at exact ticks, 27 marker cues, 140 BPM", () => {
    const p = plan("intro-popstar");
    expect(node(p, "audioFileIn").parameters).toEqual({ playMode: "timeline", tempoMode: "declared", bpm: 140, beatOffset: 1.1474, beatsPerBar: 4 });
    const lanes = parseAutomation(node(p, "automation").parameters?.["lanes"]);
    if (!lanes.ok) throw new Error(lanes.reason);
    expect(lanes.document.lanes).toHaveLength(1);
    const lane = lanes.document.lanes[0]!;
    expect(lane).toMatchObject({ name: "layers_4_video_opacity", min: 0, max: 1, mute: true });
    expect(lane.keys).toHaveLength(46);
    // 100.5 s, 102.2597 s, 102.2607 s, 102.3407 s … 128.2077 s, as round(t × 240 000).
    expect(lane.keys.slice(0, 4).map((key) => [key.t, key.v])).toEqual([
      [24_120_000, 0],
      [24_542_328, 0],
      [24_542_568, 0.892],
      [24_561_768, 0],
    ]);
    expect(lane.keys[45]!.t).toBe(30_769_848);
    const cues = parseCueList(node(p, "cueList").parameters?.["cues"]);
    if (!cues.ok) throw new Error(cues.reason);
    expect(cues.list.cues).toHaveLength(27);
    expect(cues.list.cues[0]).toMatchObject({ name: "INTRO", at: 0 });
    expect(p.report.notImported.find((item) => item.what === "cue actions")?.count).toBe(4);
    expect(p.report.notImported.find((item) => item.what === "segments")?.count).toBe(13);
    expect(p.startTimecode).toEqual({ text: "01:00:00:00", fps: 30, frame: 108_000 });
  });

  it("CLOUD 9: two figure lanes baked, seven cues, 147.99 BPM", () => {
    const p = plan("cloud-9");
    const lanes = parseAutomation(node(p, "automation").parameters?.["lanes"]);
    if (!lanes.ok) throw new Error(lanes.reason);
    expect(lanes.document.lanes.map((lane) => lane.name)).toEqual(["layers_4_video_opacity", "layers_4_video_opacity_2"]);
    expect(p.report.lanes.every((lane) => lane.baked && lane.source === "figure")).toBe(true);
    expect(p.report.cues).toHaveLength(7);
    expect(p.report.tempo).toEqual({ bpm: 147.99, beatOffset: 0.029, beatsPerBar: 4 });
  });

  it("plans every track without refusal", () => {
    for (const track of listLtcLabTracks(source())) expect(planLtcLabImport(source(), { trackId: track.id }).ok).toBe(true);
  });
});
