import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { presetBankNode } from "../../domain/presets/test-support.ts";
import { serializeCueList, type Cue } from "../../domain/presets/cue-list.ts";
import type { MorphSpec, Preset } from "../../domain/presets/bank.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeComponents } from "./pixel-compare.ts";
import { renderHeadless, type HarnessControl } from "./render-harness.ts";

/**
 * §T1537b — A TIMED CUE LIST SWITCHES STRUCTURE ON ITS CUE FRAMES, THROUGH THE REAL STACK.
 *
 * The headless harness — `compileGraph`, the vgpu backend and `FrameDriver.step()` the app
 * runs — on Dawn. A blue Solid is the stack under a Layer whose picture names a red Solid;
 * the Layer is stored OFF (bypassed), so the document shows blue. Blend `replace` at opacity
 * 1 puts the picture itself on screen when the layer is on, so every claim below is a
 * byte-for-byte comparison against a render of a plain document with that structure STORED
 * (§V147) — no colour arithmetic is restated here.
 *
 * THE SHOW: 30 fps; cue "in" at 1.0 s switches the layer on (frame 30); cue "swap" at 2.0 s
 * changes its picture to the green Solid (frame 60). Frames 29 / 30 / 59 / 60 are blue /
 * red / red / green.
 *
 * Renders without an epoch are what an export renders; with one they stand where the live
 * session stands. The structure is a function of the playhead alone, so the two agree.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
};

const settings: ProjectSettings = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 8,
  previewFps: 30,
  fps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const FPS = 30;
const LIVE_EPOCH = "session-1";
const CUT: MorphSpec = { seconds: 0, curve: "linear" };

const node = (id: string, type: string, label: string, parameters: Record<string, unknown>, ui?: Record<string, unknown>): GraphNode =>
  ({ id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(ui === undefined ? {} : { ui }) }) as GraphNode;

const STAGE: readonly Preset[] = [
  { name: "on", values: {}, on: { layer1: true } },
  { name: "green", values: { layer1: { picture: "green" } } },
];

const SHOW: readonly Cue[] = [
  { name: "in", bank: "stage", preset: "on", morph: CUT, at: 1 },
  { name: "swap", bank: "stage", preset: "green", morph: CUT, at: 2 },
];

interface Stored {
  readonly on: boolean;
  readonly picture: "red" | "green";
  /** With the bank and the list beside it, following (`timeline`) or not (`live`). */
  readonly follow?: "live" | "timeline";
}

/** blue Solid → Layer(below) → Output, with red and green Solids the Layer can name. */
function stageGraph(stored: Stored): GraphDocument {
  return {
    revision: 1,
    nodes: {
      blue: node("blue", "solid", "blue", { color: [0, 0, 1, 1] }),
      red: node("red", "solid", "red", { color: [1, 0, 0, 1] }),
      green: node("green", "solid", "green", { color: [0, 1, 0, 1] }),
      layer: node("layer", "layer", "layer1", { picture: stored.picture, opacity: 1, blend: "replace" }, { bypassed: !stored.on }),
      out: node("out", "output", "out1", {}),
      ...(stored.follow === undefined
        ? {}
        : {
            bank: presetBankNode("bank", "stage", "layer1.picture", STAGE),
            show: node("show", "cueList", "show", { follow: stored.follow, cues: serializeCueList({ version: 1, cues: SHOW }) }),
          }),
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "blue", portId: "out" }, target: { nodeId: "layer", portId: "below" } },
      e1: { id: "e1", source: { nodeId: "layer", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

const SHOW_GRAPH = (): GraphDocument => stageGraph({ on: false, picture: "red", follow: "timeline" });

interface Shot {
  readonly bytes: Buffer;
  readonly pixel: readonly number[];
}

interface RenderOptions {
  readonly epoch?: string;
  readonly startFrame?: number;
  readonly frames?: number;
  readonly betweenFrames?: (control: HarnessControl, frameIndex: number) => void;
}

async function render(graph: GraphDocument, capture: readonly number[], options: RenderOptions = {}): Promise<Shot[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    fps: FPS,
    frames: options.frames ?? Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    ...(options.epoch === undefined ? {} : { absEpoch: options.epoch }),
    ...(options.startFrame === undefined ? {} : { startFrame: options.startFrame }),
    ...(options.betweenFrames === undefined ? {} : { betweenFrames: options.betweenFrames }),
  });
  expect(result.frames.map((frame) => frame.frameIndex)).toEqual([...capture]);
  // The timeline drives structure without a warning: nothing it cuts is skipped any more.
  expect(result.diagnostics.filter((entry) => entry.severity !== "info")).toEqual([]);
  return result.frames.map((frame) => ({
    bytes: Buffer.from(frame.bytes),
    pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)],
  }));
}

const one = async (graph: GraphDocument, frame: number, options: RenderOptions = {}): Promise<Shot> => {
  const [only] = await render(graph, [frame], options);
  if (only === undefined) throw new Error("no frame captured");
  return only;
};

/** The static twin: the same stage with this structure STORED and nothing timed. */
const twin = (on: boolean, picture: "red" | "green", frame: number): Promise<Shot> => one(stageGraph({ on, picture }), frame);

const same = (a: Shot | undefined, b: Shot | undefined): number => Buffer.compare(a?.bytes ?? Buffer.alloc(0), b?.bytes ?? Buffer.alloc(1));

describe("§T1537b on Dawn — a layer switched on and a picture swapped, on their cue frames", () => {
  it("frame 29 is the layer off, frame 30 — the crossing — is the layer on, byte-exact against a document with it on", async () => {
    requireDawn();
    const [f29, f30] = await render(SHOW_GRAPH(), [29, 30]);
    expect(f29?.pixel).toEqual([0, 0, 1, 1]);
    expect(f30?.pixel).toEqual([1, 0, 0, 1]);
    expect(same(f29, await twin(false, "red", 29))).toBe(0);
    expect(same(f30, await twin(true, "red", 30))).toBe(0);
  }, 180_000);

  it("the picture swaps on frame 60: 59 shows the red Solid, 60 the green one, each byte-exact", async () => {
    requireDawn();
    const [f59, f60] = await render(SHOW_GRAPH(), [59, 60]);
    expect(f59?.pixel).toEqual([1, 0, 0, 1]);
    expect(f60?.pixel).toEqual([0, 1, 0, 1]);
    expect(same(f59, await twin(true, "red", 59))).toBe(0);
    expect(same(f60, await twin(true, "green", 60))).toBe(0);
  }, 180_000);
});

describe("§T1537b on Dawn — a pure function of the playhead: seek, lap and play-through agree", () => {
  it("a cold seek into the middle of each segment is byte-identical to the play-through", async () => {
    requireDawn();
    const graph = SHOW_GRAPH();
    const played = await render(graph, [15, 45, 75], { epoch: LIVE_EPOCH });
    for (const [index, at] of [15, 45, 75].entries()) {
      // The transport starts AT the frame — nothing before it was rendered, no crossing passed.
      const seeked = await one(graph, 0, { epoch: LIVE_EPOCH, startFrame: at, frames: 1 });
      expect(same(seeked, played[index]), `frame ${String(at)}`).toBe(0);
    }
    expect(played.map((shot) => shot.pixel)).toEqual([
      [0, 0, 1, 1],
      [1, 0, 0, 1],
      [0, 1, 0, 1],
    ]);
  }, 180_000);

  it("a lap back to 0 returns to the document's structure, and the second lap switches again on the same frames", async () => {
    requireDawn();
    const graph = SHOW_GRAPH();
    const [p15, p45, p75] = await render(graph, [15, 45, 75], { epoch: LIVE_EPOCH });
    // 0..90, wrap to 0 (the clock only — T464), on: loop index 91 + n is playhead n.
    const lapped = await render(graph, [106, 136, 166], {
      epoch: LIVE_EPOCH,
      betweenFrames: (control, index) => {
        if (index === 90) control.wrapTo(0);
      },
    });
    expect(same(lapped[0], p15)).toBe(0);
    expect(same(lapped[1], p45)).toBe(0);
    expect(same(lapped[2], p75)).toBe(0);
    // Not vacuous: the three playheads are three structures.
    expect(new Set([p15, p45, p75].map((shot) => shot?.bytes.toString("hex"))).size).toBe(3);
  }, 180_000);

  it("two exports of frames 0–90 are byte-identical, equal live playback, and leave the document as it was", async () => {
    requireDawn();
    const graph = SHOW_GRAPH();
    const before = JSON.stringify(graph);
    const frames = [0, 29, 30, 31, 59, 60, 61, 90];
    const first = await render(graph, frames);
    const second = await render(graph, frames);
    const live = await render(graph, frames, { epoch: LIVE_EPOCH });
    for (let index = 0; index < frames.length; index += 1) {
      const at = `frame ${String(frames[index])}`;
      expect(same(first[index], second[index]), `export 1 vs 2, ${at}`).toBe(0);
      expect(same(first[index], live[index]), `export vs live, ${at}`).toBe(0);
    }
    // Not a still document agreeing with itself: three structures across the take.
    expect(new Set(first.map((shot) => shot.bytes.toString("hex"))).size).toBe(3);
    // Nothing was written: the layer is still stored off, showing red.
    expect(JSON.stringify(graph)).toBe(before);
  }, 240_000);

  it("switched back to live, the document's stored structure is what shows — on every frame, at once", async () => {
    requireDawn();
    const live = stageGraph({ on: false, picture: "red", follow: "live" });
    const [f30, f60] = await render(live, [30, 60]);
    expect(same(f30, await twin(false, "red", 30))).toBe(0);
    expect(same(f60, await twin(false, "red", 60))).toBe(0);
    // The same document following the timeline shows the layer on frame 30 — the list is what differs.
    expect(same(f30, await one(SHOW_GRAPH(), 30))).not.toBe(0);
  }, 180_000);
});
