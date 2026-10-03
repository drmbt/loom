import { describe, expect, it } from "vitest";

import type { FrameEvaluationInput } from "../types/frame.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { flattenComponents } from "../../compiler/flatten.ts";
import { componentNodeType, createComponentSystem } from "../components/index.ts";
import { hasAnimatedParameters } from "../channels/graph-channels.ts";
import { resolveParameters } from "../parameters/resolve.ts";
import { MORPH_CURVES, type MorphSpec, type Preset } from "./bank.ts";
import { serializeCueList, type Cue } from "./cue-list.ts";
import { easeMorph } from "./morph.ts";
import { buildMorphIndex } from "./morph-index.ts";
import { presetBankNode, presetSession } from "./test-support.ts";
import { planTimelineCues, timelineCuePosition } from "./timeline-cues.ts";

/**
 * T1508b — A CUE LIST THAT FOLLOWS THE TIMELINE, as the resolver reads it: values that are
 * a pure function of the playhead, applied as drivers, never written.
 *
 * Every value is what `resolveParameters` hands a consumer at a frame, through the ONE
 * index (`buildMorphIndex`) the compile, the flattening and the Dawn harness all build —
 * so a claim here is the claim the picture rests on. The expected numbers are the fold
 * written out (`mix` exactly as the resolver blends), never a tolerance band.
 *
 * THE SHOW most tests run, at 30 fps (the design doc §2.5): a Level stored at 0.2; cue A at
 * 1.0 s goes to 0.8 over 1 s, linear; cue B at 2.5 s cuts to 0.4.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const FPS = 30;
const LINEAR_1S: MorphSpec = { seconds: 1, curve: "linear" };
const CUT: MorphSpec = { seconds: 0, curve: "linear" };

/** The resolver's blend, verbatim (`resolve.ts`), so an expected value is the same double. */
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;

const node = (id: NodeId, type: string, label: string, parameters: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as GraphNode;

const doc = (nodes: readonly GraphNode[]): GraphDocument => ({
  revision: 1,
  nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
  edges: {},
  groups: {},
});

const LOOKS: readonly Preset[] = [
  { name: "bright", values: { level1: { brightness: 0.8 } } },
  { name: "mid", values: { level1: { brightness: 0.4 } } },
  { name: "low", values: { level1: { brightness: 0.1 } } },
];

const SHOW: readonly Cue[] = [
  { name: "A", bank: "looks", preset: "bright", morph: LINEAR_1S, at: 1 },
  { name: "B", bank: "looks", preset: "mid", morph: CUT, at: 2.5 },
];

const list = (id: NodeId, label: string, cues: readonly Cue[], follow: "live" | "timeline" = "timeline"): GraphNode =>
  node(id, "cueList", label, { follow, cues: serializeCueList({ version: 1, cues }) });

function show(options: { brightness?: number; cues?: readonly Cue[]; follow?: "live" | "timeline"; extra?: readonly GraphNode[] } = {}): GraphDocument {
  return doc([
    node("grade", "level", "level1", { brightness: options.brightness ?? 0.2, contrast: 1 }),
    presetBankNode("looks", "looks", "level1", LOOKS),
    list("show", "show", options.cues ?? SHOW, options.follow ?? "timeline"),
    ...(options.extra ?? []),
  ]);
}

/** Frame `n` of a transport at 30 fps: `timeSeconds` divided, never accumulated, as both transports do. */
const frame = (n: number, extra: Partial<FrameEvaluationInput> = {}): FrameEvaluationInput => ({
  timeSeconds: n / FPS,
  deltaSeconds: 1 / FPS,
  frameIndex: n,
  mode: "offline",
  randomSeed: 0,
  fps: FPS,
  subframes: 1,
  ...extra,
});

/** What a consumer reads for `key` of `nodeId` at frame `n`. */
function valueAt(graph: GraphDocument, nodeId: NodeId, key: string, n: number, extra: Partial<FrameEvaluationInput> = {}): unknown {
  const target = graph.nodes[nodeId] as GraphNode;
  const morphs = buildMorphIndex({ document: graph, registry });
  return resolveParameters(target, registry.get(target.type), { frame: frame(n, extra), morphs }).values[key];
}
const brightness = (graph: GraphDocument, n: number, extra: Partial<FrameEvaluationInput> = {}): unknown => valueAt(graph, "grade", "brightness", n, extra);

describe("T1508b — the value at the playhead", () => {
  it("the design's example: stored until cue A, A's fade analytically, B's cut — 0.2 / 0.5 / 0.8 / 0.4 at frames 30 / 45 / 60 / 75", () => {
    const graph = show();
    expect(brightness(graph, 0)).toBe(0.2);
    expect(brightness(graph, 29)).toBe(0.2);
    expect(brightness(graph, 30)).toBe(0.2);
    expect(brightness(graph, 45)).toBe(0.5);
    expect(brightness(graph, 50)).toBe(mix(0.2, 0.8, 50 / FPS - 1));
    expect(brightness(graph, 60)).toBe(0.8);
    expect(brightness(graph, 74)).toBe(0.8);
    expect(brightness(graph, 75)).toBe(0.4);
    expect(brightness(graph, 900)).toBe(0.4);
    // Nothing was written: the document still stores 0.2.
    expect(graph.nodes["grade"]?.parameters["brightness"]).toBe(0.2);
  });

  it("a fade's progress is the curve's, for every curve", () => {
    for (const curve of MORPH_CURVES) {
      const graph = show({ cues: [{ name: "A", bank: "looks", preset: "bright", morph: { seconds: 1, curve }, at: 1 }] });
      for (const n of [33, 40, 51, 57]) {
        expect(brightness(graph, n), `${curve} @ ${String(n)}`).toBe(mix(0.2, 0.8, easeMorph(curve, n / FPS - 1)));
      }
    }
  });

  it("a cue arriving mid-fade continues from what is on screen, and the older fade is dropped once finished", () => {
    const graph = show({
      cues: [
        { name: "A", bank: "looks", preset: "bright", morph: LINEAR_1S, at: 1 },
        { name: "B", bank: "looks", preset: "mid", morph: LINEAR_1S, at: 1.5 },
      ],
    });
    // Frame 45: B arrives with A half done — B starts from 0.5, the value on screen.
    expect(brightness(graph, 45)).toBe(mix(mix(0.2, 0.8, 0.5), 0.4, 0));
    expect(brightness(graph, 45)).toBe(0.5);
    // Frame 54: both moving, B folded over A.
    expect(brightness(graph, 54)).toBe(mix(mix(0.2, 0.8, 54 / FPS - 1), 0.4, 54 / FPS - 1.5));
    // Frame 60: A has finished, so the fold starts from A's end.
    expect(brightness(graph, 60)).toBe(mix(0.8, 0.4, 0.5));
    expect(brightness(graph, 75)).toBe(0.4);
  });

  it("a cue is reached exactly on its frame, decided by frame index — at 0.1 s and 7/30 s at 30 fps, 0.28 s and 1.12 s at 25", () => {
    const graph = show({
      cues: [
        { name: "A", bank: "looks", preset: "bright", morph: CUT, at: 0.1 },
        { name: "B", bank: "looks", preset: "mid", morph: CUT, at: 7 / 30 },
      ],
    });
    expect(brightness(graph, 2)).toBe(0.2);
    expect(brightness(graph, 3)).toBe(0.8);
    expect(brightness(graph, 6)).toBe(0.8);
    expect(brightness(graph, 7)).toBe(0.4);
    // 0.28 × 25 is 7.000000000000001 and 1.12 × 25 is 28.000000000000004: a bare ceil of
    // `at × rate` would put each cue one frame late.
    const at25 = show({
      cues: [
        { name: "A", bank: "looks", preset: "bright", morph: CUT, at: 0.28 },
        { name: "B", bank: "looks", preset: "mid", morph: CUT, at: 1.12 },
      ],
    });
    const f25 = (n: number) => brightness(at25, n, { timeSeconds: n / 25, fps: 25 });
    expect([f25(6), f25(7), f25(27), f25(28)]).toEqual([0.2, 0.8, 0.8, 0.4]);
  });

  it("where the list is — current and next — is reached by the same frame rule", () => {
    const shown = { version: 1 as const, cues: SHOW };
    expect(timelineCuePosition(shown, 29 / FPS, FPS)).toEqual({ current: null, next: "A" });
    expect(timelineCuePosition(shown, 30 / FPS, FPS)).toEqual({ current: "A", next: "B" });
    expect(timelineCuePosition(shown, 74 / FPS, FPS)).toEqual({ current: "A", next: "B" });
    expect(timelineCuePosition(shown, 75 / FPS, FPS)).toEqual({ current: "B", next: null });
    // An untimed cue is not on the timeline at all.
    expect(timelineCuePosition({ version: 1, cues: [{ name: "x", bank: "looks", preset: "low" }, ...SHOW] }, 0, FPS)).toEqual({ current: null, next: "A" });
  });

  it("the playhead is read off timeSeconds at the timeline rate — sub-frames included — not off a rebased frameIndex", () => {
    const graph = show();
    // An offline take at 2 sub-frames steps at 60 per second; frame 90 of it is 1.5 s.
    expect(brightness(graph, 90, { timeSeconds: 90 / 60, frameIndex: 90, fps: 30, subframes: 2 })).toBe(0.5);
    // A live clock after a rate change: frameIndex no longer equals time × rate.
    expect(brightness(graph, 45, { frameIndex: 9_000 })).toBe(0.5);
  });

  it("a key with no in-between cuts at its cue, through the same driver (a Flip's boolean)", () => {
    const graph = doc([
      node("flip", "flip", "flip1", { flipx: false }),
      presetBankNode("fx", "fx", "flip1", [{ name: "flipped", values: { flip1: { flipx: true } } }]),
      list("show", "show", [{ name: "1", bank: "fx", preset: "flipped", morph: LINEAR_1S, at: 1 }]),
    ]);
    expect(valueAt(graph, "flip", "flipx", 29)).toBe(false);
    expect(valueAt(graph, "flip", "flipx", 30)).toBe(true);
    expect(valueAt(graph, "flip", "flipx", 45)).toBe(true);
  });
});

describe("T1508b — what covers a key, and what does not", () => {
  it("a list in live mode contributes nothing — the legitimate case the timeline must not swallow", () => {
    const graph = show({ follow: "live" });
    const morphs = buildMorphIndex({ document: graph, registry });
    expect(morphs.keysOf("grade")).toBeUndefined();
    expect(morphs.stepsAt("grade", "brightness", frame(45))).toBeUndefined();
    expect(morphs.activeAt(frame(45))).toBe(false);
    expect(hasAnimatedParameters(graph)).toBe(false);
    expect(brightness(graph, 75)).toBe(0.2);
  });

  it("a following list animates the document, and every frame is active — the cut at 2.5 s renders even when nothing else moves", () => {
    const graph = show();
    const morphs = buildMorphIndex({ document: graph, registry });
    expect(hasAnimatedParameters(graph)).toBe(true);
    expect(morphs.keysOf("grade")).toEqual(new Set(["brightness"]));
    // Between A's end and B, nothing is fading — and the next frame is B's cut.
    expect(morphs.activeAt(frame(70))).toBe(true);
    expect(morphs.activeAt(frame(0))).toBe(true);
  });

  it("two following lists on one key run as one chain in time order (ties: list name), and each says so", () => {
    const graph = doc([
      node("grade", "level", "level1", { brightness: 0.2 }),
      presetBankNode("looks", "looks", "level1", LOOKS),
      list("la", "a", [
        { name: "1", bank: "looks", preset: "bright", morph: CUT, at: 1 },
        { name: "3", bank: "looks", preset: "low", morph: CUT, at: 3 },
      ]),
      list("lb", "b", [
        { name: "2", bank: "looks", preset: "mid", morph: CUT, at: 2 },
        { name: "3", bank: "looks", preset: "bright", morph: CUT, at: 3 },
      ]),
    ]);
    expect(brightness(graph, 45)).toBe(0.8);
    expect(brightness(graph, 60)).toBe(0.4);
    // Both at 3 s: list "a" first, so "b"'s cue is the later one and holds.
    expect(brightness(graph, 90)).toBe(0.8);
    const overlaps = planTimelineCues(graph, registry).warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.overlap");
    expect(overlaps.map((warning) => warning.list).sort()).toEqual(["la", "lb"]);
    for (const warning of overlaps) {
      expect(warning.diagnostic.message).toContain('"a" and "b"');
      expect(warning.diagnostic.message).toContain('"level1.brightness"');
    }
  });

  it("structural settings in a timed cue are SKIPPED by name — layer on/off, a picture swap, a compile-time blend — and the rest applies", () => {
    const graph = doc([
      node("layer", "layer", "layer1", { opacity: 0, picture: "", blend: "over" }),
      presetBankNode("stage", "stage", "layer1", [
        { name: "in", values: { layer1: { opacity: 1, picture: "other", blend: "add" } }, on: { layer1: false } },
      ]),
      list("show", "show", [{ name: "drop", bank: "stage", preset: "in", morph: CUT, at: 1 }]),
    ]);
    const warnings = planTimelineCues(graph, registry).warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.structural");
    const said = warnings.map((warning) => warning.diagnostic.message).join("\n");
    expect(warnings.every((warning) => warning.cue === "drop" && warning.list === "show")).toBe(true);
    expect(said).toContain('"layer1.picture"');
    expect(said).toContain('"layer1.blend"');
    expect(said).toContain('layer "layer1" on or off');
    expect(warnings).toHaveLength(3);
    // Opacity is a value: it applies. The skipped keys stay as stored.
    expect(valueAt(graph, "layer", "opacity", 30)).toBe(1);
    expect(valueAt(graph, "layer", "picture", 30)).toBe("");
    expect(valueAt(graph, "layer", "blend", 30)).toBe("over");
    expect(buildMorphIndex({ document: graph, registry }).keysOf("layer")).toEqual(new Set(["opacity"]));
  });

  it("a cue with no At is skipped with a warning naming it; the timed ones still play", () => {
    const graph = show({ cues: [...SHOW, { name: "C", bank: "looks", preset: "low" }] });
    const untimed = planTimelineCues(graph, registry).warnings.filter((warning) => warning.diagnostic.code === "cue.timeline.untimed");
    expect(untimed.map((warning) => warning.cue)).toEqual(["C"]);
    expect(untimed[0]?.diagnostic.message).toContain('Cue "C" (show)');
    expect(brightness(graph, 900)).toBe(0.4);
  });
});

describe("T1508b — precedence: the timeline wins on what it covers (owner ruling 1)", () => {
  it("a fader on a covered key shows before the first cue and NOT once the list has it — and it stays stored", () => {
    const moved = show({ brightness: 0.6 });
    // Before cue A the key is not the timeline's: the fader is on screen.
    expect(brightness(moved, 15)).toBe(0.6);
    // From cue A's end on, the timeline holds it: the same values the un-moved show has.
    for (const n of [60, 70, 75, 120]) expect(brightness(moved, n)).toBe(brightness(show(), n));
    expect(moved.nodes["grade"]?.parameters["brightness"]).toBe(0.6);
  });

  it("switching back to live hands the key to the document at once: its stored value, untouched", () => {
    const live = show({ brightness: 0.6, follow: "live" });
    for (const n of [45, 60, 75]) expect(brightness(live, n)).toBe(0.6);
  });

  it("a live recall's fade shows before the first cue and is outranked after it; on an uncovered key it fades as usual", async () => {
    const graph = show({
      extra: [presetBankNode("desk", "desk", "level1", [{ name: "punch", values: { level1: { brightness: 0.9, contrast: 3 } } }])],
    });
    const session = presetSession(graph, registry);
    // Recalled live at absolute second 0.3, with a 2 s linear fade.
    session.at({ epoch: "live", absTimeSeconds: 0.3 });
    await session.recall("desk", "punch", { seconds: 2, curve: "linear" });
    const recalled = session.graph();
    const live = (n: number) => ({ absEpoch: "live", absTimeSeconds: n / FPS });
    // Before cue A: the recall's fade, from 0.2 towards 0.9.
    expect(brightness(recalled, 15, live(15))).toBe(mix(0.2, 0.9, (15 / FPS - 0.3) / 2));
    // From cue A on: the timeline's fold, which starts from the STORED slot (now 0.9).
    expect(brightness(recalled, 45, live(45))).toBe(mix(0.9, 0.8, 0.5));
    expect(brightness(recalled, 75, live(75))).toBe(0.4);
    // Contrast is no cue's: the recall fades it on the absolute clock, untouched.
    expect(valueAt(recalled, "grade", "contrast", 45, live(45))).toBe(mix(1, 3, (45 / FPS - 0.3) / 2));
  });
});

describe("T1508b — inside a component: a timed cue on a look's published knob reaches the Level within", () => {
  const look = {
    componentId: "look",
    version: 1,
    name: "Look",
    graph: doc([node("src", "solid", "src", { color: [1, 1, 1, 1] }), node("grade", "level", "grade", { brightness: 1 })]),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
    parameters: [
      {
        key: "gain",
        definition: { type: "number", label: "Gain", default: 1, min: 0, max: 8, range: "floor" },
        targets: [{ nodeId: "grade", key: "brightness" }],
      },
    ],
  } as unknown as GraphComponentDefinition;

  it("flattened with the PLAIN node registry (as the Dawn harness does), the internal brightness folds on the playhead", () => {
    const system = createComponentSystem(registry, [look]);
    const graph = doc([
      node("city", componentNodeType("look", 1), "city", { gain: 0.2 }),
      presetBankNode("looks", "looks", "city", [{ name: "bright", values: { city: { gain: 0.8 } } }]),
      list("show", "show", [{ name: "A", bank: "looks", preset: "bright", morph: LINEAR_1S, at: 1 }]),
    ]);
    const flattened = flattenComponents({ graph, registry, components: system.components.view() });
    const inner = Object.values(flattened.graph.nodes).find((each) => each?.type === "level") as GraphNode;
    const at = (n: number): unknown =>
      resolveParameters(inner, registry.get("level"), { frame: frame(n), morphs: flattened.morphs }).values["brightness"];
    expect(at(15)).toBe(0.2);
    expect(at(45)).toBe(0.5);
    expect(at(60)).toBe(0.8);
  });
});
