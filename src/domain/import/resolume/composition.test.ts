import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseClipTrack, serializeClipTrack } from "../../regions/model.ts";
import { sourceTimeAt } from "../../regions/evaluate.ts";
import { TICKS_PER_SECOND as S } from "../../time/ticks.ts";
import { importResolumeComposition } from "./composition.ts";
import { parseXml, path } from "./xml.ts";

/** One file clip, with only what the test names written (Arena omits defaults the same way). */
function fileClip(layer: number, column: number, media: string, options: {
  transportType?: number;
  durationMs?: number;
  startStop?: [number, number];
  speed?: number;
  playMode?: number;
  playDirection?: number;
  beats?: number;
  beatLoop?: number;
  smpteOffset?: number;
} = {}): string {
  const duration = options.durationMs ?? 4000;
  const timelineParams = [
    options.speed === undefined ? "" : `<ParamRange name="Speed" T="DOUBLE" default="1" value="${options.speed}"/>`,
    options.playMode === undefined ? "" : `<ParamChoice name="PlayMode" default="0" value="${options.playMode}"/>`,
    options.playDirection === undefined ? "" : `<ParamChoice name="PlayDirection" default="2" value="${options.playDirection}"/>`,
    options.beatLoop === undefined ? "" : `<ParamChoice name="BeatLoop" default="0" value="${options.beatLoop}"/>`,
  ].join("");
  const phase = options.transportType === 2
    ? `<PhaseSourceSMPTE name="PhaseSourceSMPTE"><Params name="Params"><Param name="Offset" T="DOUBLE" default="0" value="${options.smpteOffset ?? 0}"/></Params></PhaseSourceSMPTE>`
    : `<PhaseSourceTransportTimeline name="PhaseSourceTransportTimeline"><Params name="Params">${timelineParams}</Params>${
      options.beats === undefined ? "" : `<Beats_d name="Beats_d" numManualBeats="${options.beats}"/>`}</PhaseSourceTransportTimeline>`;
  return `<Clip name="Clip" uniqueId="1" layerIndex="${layer}" columnIndex="${column}">
    <PreloadData><VideoFile value="${media}"/></PreloadData>
    <Params name="Params"><Param name="Name" T="STRING" value="clip ${layer}.${column}"/>${
      options.transportType === undefined ? "" : `<ParamChoice name="TransportType" default="0" value="${options.transportType}"/>`}</Params>
    <Transport name="Transport"><Params name="Params"><ParamRange name="Position" T="DOUBLE" default="0" value="0">
      <DurationSource defaultDuration="${options.beats === undefined ? `${duration / 1000}s` : `${options.beats}b`}"/>
      ${phase}
      <ValueRange name="minMax" min="0" max="${duration}"/>
      ${options.startStop === undefined ? "" : `<ValueRange name="startStop" min="${options.startStop[0]}" max="${options.startStop[1]}"/>`}
    </ParamRange></Params></Transport>
    <VideoTrack name="VideoTrack"><RenderPass name="RenderPassChain"><PrimarySource><VideoSource name="VideoSource" type="VideoFormatReaderSource"><VideoFormatReaderSource fileName="${media}"/></VideoSource></PrimarySource></RenderPass></VideoTrack>
  </Clip>`;
}

const sourceClip = (layer: number, column: number, type: string) =>
  `<Clip name="Clip" uniqueId="2" layerIndex="${layer}" columnIndex="${column}"><Params name="Params"><Param name="Name" value="${type}"/></Params><VideoTrack name="VideoTrack"><VideoSource name="VideoSource" type="${type}"/></VideoTrack></Clip>`;

function composition(clips: string[], tempo = 120, extra = ""): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- synthesized -->
<Composition name="Composition" numDecks="1">
  <CompositionInfo name="Test Comp" width="1920" height="1080"><DeckInfo name="Main" id="1"/></CompositionInfo>
  <TempoController name="TempoController"><Params name="Params"><ParamRange name="Tempo" T="DOUBLE" default="120" value="${tempo}"/></Params></TempoController>
  <Layer name="Layer" layerIndex="0"><Params name="Params"><Param name="Name" value="L# Backdrop"/></Params>${extra}</Layer>
  <Layer name="Layer" layerIndex="1"><Params name="Params"><Param name="Name" value="Top"/></Params></Layer>
  <Deck name="Deck" deckIndex="0">
    ${clips.join("\n")}
    <Clip name="Clip" uniqueId="9" layerIndex="1" columnIndex="9"/>
  </Deck>
</Composition>`;
}

describe("VN102 xml reader", () => {
  it("reads elements, attributes and entities; skips comments, declarations and text", () => {
    const root = parseXml(`<?xml version="1.0"?><!-- c --><a x="1 &amp; 2" y='&lt;&#65;&#x42;&gt;'>text<b name="n"/><![CDATA[<no/>]]><c><d k="&quot;v&quot;"/></c></a>`);
    expect(root.tag).toBe("a");
    expect(root.attributes).toEqual({ x: "1 & 2", y: "<AB>" });
    expect(root.children.map((entry) => entry.tag)).toEqual(["b", "c"]);
    expect(path(root, "c", "d")?.attributes["k"]).toBe("\"v\"");
    expect(path(root, "[n]")?.tag).toBe("b");
    expect(parseXml(`<a v="x>y"/>`).attributes["v"]).toBe("x>y");
  });

  it("refuses a malformed document, naming the line", () => {
    expect(() => parseXml("<a>\n<b></a>")).toThrow(/Mismatched <\/a> at line 2/);
    expect(() => parseXml("<a><b/>")).toThrow(/<a> is never closed/);
    expect(() => parseXml("just text")).toThrow(/No root/);
  });
});

describe("VN102 a Resolume composition as clip-track proposals", () => {
  it("reads in/out, mode, speed, direction and BPM sync, filling every omitted default", () => {
    const result = importResolumeComposition(composition([
      fileClip(0, 0, "/media/plain.mov"),
      fileClip(0, 1, "/media/trimmed &amp; fast.mov", { startStop: [1000, 3000], speed: 2, playMode: 1, playDirection: 0 }),
      fileClip(0, 2, "/media/bpm.mov", { transportType: 1, beats: 8, playMode: 4, speed: 0.99999999999994837463 }),
      fileClip(0, 3, "/media/once.mov", { playMode: 3, startStop: [0, 0] }),
    ], 120));
    expect(result.name).toBe("Test Comp");
    expect(result.tempo).toBe(120);
    expect(result.tracks).toHaveLength(1);
    const [track] = result.tracks;
    expect(track?.track.name).toBe("Main / L1 Backdrop");
    const regions = track?.track.regions ?? [];
    expect(regions.map((region) => region.media)).toEqual(["/media/plain.mov", "/media/trimmed & fast.mov", "/media/bpm.mov", "/media/once.mov"]);
    // Defaults: whole file, loop, speed 1, forward, starting at 0.
    expect(regions[0]).toMatchObject({ sourceIn: 0, sourceOut: 4 * S, playMode: "loop", speed: 1, direction: "forward", timelineStart: 0, length: 4 * S });
    // Trimmed 1..3 s at 2×, bounce, reverse: one bounce (there and back) is 2 s of timeline.
    expect(regions[1]).toMatchObject({ sourceIn: S, sourceOut: 3 * S, speed: 2, playMode: "bounce", direction: "reverse", timelineStart: 4 * S, length: 2 * S });
    // BPM sync: 8 beats at 120 bpm is 4 s; Resolume's float noise on speed is tidied to 1.
    expect(regions[2]).toMatchObject({ bpmSync: { beats: 8 }, playMode: "onceHold", speed: 1, timelineStart: 6 * S, length: 4 * S });
    // startStop 0..0 is "never trimmed": the whole file.
    expect(regions[3]).toMatchObject({ playMode: "onceClear", sourceIn: 0, sourceOut: 4 * S, timelineStart: 10 * S });
    expect(parseClipTrack(serializeClipTrack(track!.track)).ok).toBe(true);
    // What a consumer reads back: the reverse bounce starts on its out point.
    expect(sourceTimeAt(regions[1]!, regions[1]!.timelineStart)).toBe(3 * S);
    expect(result.counts).toMatchObject({ clips: 4, fileClips: 4, regions: 4, bpmSync: 1, reverse: 1, trimmed: 1 });
  });

  it("reports what it does not import, by kind, with the SMPTE offset kept", () => {
    const result = importResolumeComposition(composition([
      fileClip(0, 0, "/media/a.mov"),
      fileClip(0, 1, "/media/random.mov", { playMode: 2 }),
      fileClip(0, 2, "/media/smpte.mov", { transportType: 2, smpteOffset: 32_400_000 }),
      fileClip(0, 3, "/media/bad.mov", { durationMs: 0 }),
      sourceClip(1, 0, "GeneratorVideoSource"),
      sourceClip(1, 1, "CompositionRouterVideoSource"),
      sourceClip(1, 2, "VideoSourceFeedback"),
      sourceClip(1, 3, "CaptureDeviceVideoSource"),
    ], 120, `<PersistentClip name="P" layerIndex="0"/>`));
    const kinds = result.notImported.map((entry) => entry.kind).sort();
    expect(kinds).toEqual(["badTiming", "capture", "feedback", "generator", "persistent", "random", "router", "smpte"]);
    const smpte = result.notImported.find((entry) => entry.kind === "smpte");
    expect(smpte).toMatchObject({ smpteOffsetMs: 32_400_000, media: "/media/smpte.mov" });
    expect(smpte?.detail).toMatch(/09:00:00\.000/);
    expect(result.tracks[0]?.track.regions).toHaveLength(1);
  });

  it("reports settings it drops on clips it does import", () => {
    const result = importResolumeComposition(composition([
      fileClip(0, 0, "/media/a.mov", { beatLoop: 3 }),
      fileClip(0, 1, "/media/b.mov", { playDirection: 1 }),
      fileClip(0, 2, "/media/c.mov", { transportType: 1, beats: 4, speed: 2 }),
    ]));
    expect(result.dropped.map((entry) => entry.setting)).toEqual(["beatLoop", "pausedDirection", "bpmSyncSpeed"]);
    const regions = result.tracks[0]?.track.regions ?? [];
    expect(regions[1]).toMatchObject({ speed: 0 });
    // A ×2 multiplier on 4 beats plays the span in 2 beats: 1 s at 120 bpm.
    expect(regions[2]).toMatchObject({ bpmSync: { beats: 2 }, length: S });
  });

  it("layout `columns` starts every layer's column N together, each column as long as its longest clip", () => {
    const text = composition([
      fileClip(0, 0, "/a0.mov", { durationMs: 2000 }),
      fileClip(1, 0, "/b0.mov", { durationMs: 5000 }),
      fileClip(0, 1, "/a1.mov", { durationMs: 1000 }),
      fileClip(1, 2, "/b2.mov", { durationMs: 1000 }),
    ]);
    const sequence = importResolumeComposition(text);
    expect(sequence.tracks.map((track) => track.track.regions.map((region) => region.timelineStart / S))).toEqual([[0, 2], [0, 5]]);
    const columns = importResolumeComposition(text, { layout: "columns", gapTicks: S });
    expect(columns.tracks.map((track) => track.track.regions.map((region) => region.timelineStart / S))).toEqual([[0, 6], [0, 8]]);
    for (const track of columns.tracks) expect(parseClipTrack(serializeClipTrack(track.track)).ok).toBe(true);
  });

  it("takes only the decks asked for, and a tempo override", () => {
    const text = composition([fileClip(0, 0, "/a.mov", { transportType: 1, beats: 4 })], 90);
    expect(importResolumeComposition(text, { decks: [1] }).tracks).toEqual([]);
    expect(importResolumeComposition(text).tracks[0]?.track.regions[0]?.length).toBe(Math.round((4 * 60 * S) / 90));
    expect(importResolumeComposition(text, { tempo: 120 }).tracks[0]?.track.regions[0]?.length).toBe(2 * S);
  });

  it("refuses a document that is not a composition", () => {
    expect(() => importResolumeComposition("<Deck/>")).toThrow(/not <Composition>/);
  });
});

/**
 * The real composition the survey was taken from (Vincent's Tinashe show, 2026-10-08). Not in
 * the repository; skipped by name where it is absent. Counts re-measured against Python's
 * ElementTree over the same file on 2026-10-08: 998 clips with content, 343 file-backed, of
 * which 174 Timeline, 151 BPM Sync, 18 SMPTE; 13 bounce, 1 play-once-and-clear; 6 reverse,
 * 1 paused; 46 startStop ranges, 29 of them the untrimmed 0..0; 470 router, 115 generator,
 * 63 feedback and 7 capture clips; 29 persistent clips. (The brief's 333 / 252 came from an
 * older save of the file.)
 */
const TINASHE = "/Users/vincentnaples/Documents/Resolume Arena/Compositions/TINASHE POPSTAR 2026 v1.avc";

describe.skipIf(!existsSync(TINASHE))("VN102 the Tinashe composition (present only on Vincent's machine)", () => {
  it("imports every file clip that is not SMPTE, reports the rest, and every track parses", () => {
    const started = performance.now();
    const result = importResolumeComposition(readFileSync(TINASHE, "utf8"));
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(result.name).toBe("TINASHE POPSTAR 2026 v1");
    expect(result.counts).toEqual({
      clips: 998, fileClips: 343, regions: 325, bpmSync: 151, reverse: 6, trimmed: 17,
      byPlayMode: { loop: 311, bounce: 13, onceHold: 0, onceClear: 1 },
    });
    const kinds: Record<string, number> = {};
    for (const entry of result.notImported) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
    expect(kinds).toEqual({ router: 470, generator: 115, feedback: 63, capture: 7, smpte: 18, persistent: 29 });
    expect(result.dropped.filter((entry) => entry.setting === "pausedDirection")).toHaveLength(1);
    expect(result.tracks).toHaveLength(22);
    expect(result.tracks.reduce((sum, track) => sum + track.track.regions.length, 0)).toBe(325);
    for (const track of result.tracks) expect(parseClipTrack(serializeClipTrack(track.track))).toMatchObject({ ok: true });
  });
});
