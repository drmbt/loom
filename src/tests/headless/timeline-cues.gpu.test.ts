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
 * T1508b — A CUE LIST THAT FOLLOWS THE TIMELINE, ON PIXELS, THROUGH THE REAL STACK.
 *
 * The headless harness — the same `compileGraph`, the same vgpu backend, the same
 * `FrameDriver.step()` the app runs — on Dawn, with `animate` on as the app renders. A white
 * Solid through a Level in `rgba16float` puts the Level's brightness straight into the
 * pixel (`preset-morph.gpu.test.ts`'s rig), so 0.5 is binary16 0.5, and every other value
 * is held BYTE FOR BYTE against a render of the same graph with that number stored
 * statically (§V147): no colour arithmetic is restated here.
 *
 * THE SHOW (the design doc §2.5): 30 fps; Level stored at 0.2; cue A at 1.0 s goes to 0.8
 * over 1 s, linear; cue B at 2.5 s cuts to 0.4. So frames 30 / 45 / 60 / 75 are 0.2 / 0.5 /
 * 0.8 / 0.4.
 *
 * Renders WITHOUT an epoch are what an export renders (`render-range.ts` names none to the
 * offline transport — every live recall is finished); renders WITH one stand where the live
 * session stands. A timeline cue is a function of the playhead alone, so the two agree.
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
const LINEAR_1S: MorphSpec = { seconds: 1, curve: "linear" };
const CUT: MorphSpec = { seconds: 0, curve: "linear" };

const node = (id: string, type: string, label: string, parameters: Record<string, unknown>): GraphNode =>
  ({ id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as GraphNode;

const LOOKS: readonly Preset[] = [
  { name: "bright", values: { level1: { brightness: 0.8 } } },
  { name: "mid", values: { level1: { brightness: 0.4 } } },
];

const SHOW: readonly Cue[] = [
  { name: "A", bank: "looks", preset: "bright", morph: LINEAR_1S, at: 1 },
  { name: "B", bank: "looks", preset: "mid", morph: CUT, at: 2.5 },
];

/** white Solid → Level → Output; with `follow`, the bank and the list of THE SHOW beside it. */
function levelGraph(brightness: number, follow?: "live" | "timeline"): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: node("solid", "solid", "solid1", { color: [1, 1, 1, 1] }),
      grade: node("grade", "level", "level1", { brightness }),
      out: node("out", "output", "out1", {}),
      ...(follow === undefined
        ? {}
        : {
            bank: presetBankNode("bank", "looks", "level1", LOOKS),
            show: node("show", "cueList", "show", { follow, cues: serializeCueList({ version: 1, cues: SHOW }) }),
          }),
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "grade", portId: "input" } },
      e1: { id: "e1", source: { nodeId: "grade", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

interface Shot {
  readonly bytes: Buffer;
  /** The first pixel, decoded: [r, g, b, a]. */
  readonly pixel: readonly number[];
}

interface RenderOptions {
  readonly epoch?: string;
  readonly startFrame?: number;
  readonly frames?: number;
  readonly betweenFrames?: (control: HarnessControl, frameIndex: number) => void;
}

/** Loop indices `capture` of `graph`, rendered animated as the app renders. */
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

/** The static twin: the same graph with `brightness` stored and nothing timed. */
const twin = (brightness: number, frame: number): Promise<Shot> => one(levelGraph(brightness), frame);

const same = (a: Shot | undefined, b: Shot | undefined): number => Buffer.compare(a?.bytes ?? Buffer.alloc(0), b?.bytes ?? Buffer.alloc(1));

describe("T1508b on Dawn — the timeline's values, exact, at frames 30 / 45 / 60 / 75", () => {
  it("0.2 / 0.5 / 0.8 / 0.4: before A, half-way through A, A's end, B's cut", async () => {
    requireDawn();
    const [f30, f45, f60, f75] = await render(levelGraph(0.2, "timeline"), [30, 45, 60, 75]);
    expect(f45?.pixel).toEqual([0.5, 0.5, 0.5, 1]);
    expect(same(f30, await twin(0.2, 30))).toBe(0);
    expect(same(f45, await twin(0.5, 45))).toBe(0);
    expect(same(f60, await twin(0.8, 60))).toBe(0);
    expect(same(f75, await twin(0.4, 75))).toBe(0);
    // Not vacuous: four different pictures.
    expect(new Set([f30, f45, f60, f75].map((shot) => shot?.bytes.toString("hex"))).size).toBe(4);
  }, 180_000);
});

describe("T1508b on Dawn — a pure function of the playhead: seek, lap and play-through agree", () => {
  it("frame 45 after a cold seek, and frame 45 on the second lap, are byte-identical to frame 45 of a play-through", async () => {
    requireDawn();
    const graph = levelGraph(0.2, "timeline");
    const played = await one(graph, 45, { epoch: LIVE_EPOCH });
    // A cold seek: the transport starts AT 45 — nothing before it was rendered.
    const seeked = await one(graph, 0, { epoch: LIVE_EPOCH, startFrame: 45, frames: 1 });
    expect(same(seeked, played)).toBe(0);
    // A lap: 0..90, wrap to 0 (the clock only — T464), and on to 45 again: loop index 136.
    const lapped = await one(graph, 136, {
      epoch: LIVE_EPOCH,
      betweenFrames: (control, index) => {
        if (index === 90) control.wrapTo(0);
      },
    });
    expect(same(lapped, played)).toBe(0);
    expect(played.pixel).toEqual([0.5, 0.5, 0.5, 1]);
  }, 180_000);

  it("two exports of frames 0–90 are byte-identical, equal live playback, and leave the document as it was", async () => {
    requireDawn();
    const graph = levelGraph(0.2, "timeline");
    const before = JSON.stringify(graph);
    const frames = [0, 15, 30, 45, 52, 60, 74, 75, 90];
    const first = await render(graph, frames);
    const second = await render(graph, frames);
    const live = await render(graph, frames, { epoch: LIVE_EPOCH });
    for (let index = 0; index < frames.length; index += 1) {
      const at = `frame ${String(frames[index])}`;
      expect(same(first[index], second[index]), `export 1 vs 2, ${at}`).toBe(0);
      expect(same(first[index], live[index]), `export vs live, ${at}`).toBe(0);
    }
    // Not a still document agreeing with itself: the export moves, through A's fade and B's cut.
    expect(first[3]?.pixel).toEqual([0.5, 0.5, 0.5, 1]);
    expect(same(first[7], first[6])).not.toBe(0);
    // Nothing was written: no revision, no value — the timeline is a driver.
    expect(JSON.stringify(graph)).toBe(before);
    expect(graph.revision).toBe(1);
  }, 240_000);
});

describe("T1508b on Dawn — owner ruling 1: while it follows, the list wins on what it covers", () => {
  it("a fader moved on the covered key shows before cue A, and not once the timeline has it", async () => {
    requireDawn();
    const moved = levelGraph(0.6, "timeline");
    const [early, f60, f75] = await render(moved, [15, 60, 75]);
    expect(same(early, await twin(0.6, 15))).toBe(0);
    const [show60, show75] = await render(levelGraph(0.2, "timeline"), [60, 75]);
    expect(same(f60, show60)).toBe(0);
    expect(same(f75, show75)).toBe(0);
  }, 180_000);

  it("switched back to live, the document's stored value is what shows — on every frame, at once", async () => {
    requireDawn();
    const live = levelGraph(0.6, "live");
    const [f45, f75] = await render(live, [45, 75]);
    expect(same(f45, await twin(0.6, 45))).toBe(0);
    expect(same(f75, await twin(0.6, 75))).toBe(0);
  }, 180_000);
});
