import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { alice, bob, contextFor, patch } from "../../domain/commands/test-support.ts";
import { componentNodeType, createComponentSystem } from "../../domain/components/index.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import { parseMorphRecords } from "../../domain/presets/morph.ts";
import { serializeCueList } from "../../domain/presets/cue-list.ts";
import { presetBankNode, presetSession, type PresetSession } from "../../domain/presets/test-support.ts";
import type { MorphSpec } from "../../domain/presets/bank.ts";
import { loadProject, serializeProjectDocument } from "../../domain/project/index.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeComponents } from "./pixel-compare.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T1497b (§T1398b S2) — A PRESET MORPH, ON PIXELS, THROUGH THE REAL STACK.
 *
 * The recall is the real command on the real bus; the render is the headless harness —
 * the same `compileGraph`, the same vgpu backend, the same `FrameDriver.step()` — on Dawn.
 * Every expected value is exact or analytically derived (§V147): a white Solid through a
 * Level in an `rgba16float` working format puts the Level's brightness straight into the
 * pixel, so 0.5 is the binary16 0.5, and every other fade value is held byte-for-byte
 * against a render of the SAME graph with that number set statically — no colour-space
 * arithmetic is restated here to know which number reached the shader.
 *
 * Time is the transport's absolute clock at 60 fps: frame N is `N / 60` s. The recall is
 * stamped at absolute time 0 (frame 0 on screen), so a one-second morph is half done at
 * frame 30. A fade exists only for frames of the record's own epoch, so the renders that
 * stand where the live session stands name it (`absEpoch`); the EXPORT renders name none,
 * exactly as an export does.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
};

const registry = createNodeRegistry(allNodeDefinitions).view();

const settings: ProjectSettings = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 8,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const FPS = 60;
const EPOCH = "session-1";
const LINEAR_1S: MorphSpec = { seconds: 1, curve: "linear" };

const node = (id: string, type: string, label: string, parameters: Record<string, unknown>): GraphNode =>
  ({ id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as GraphNode;

/** white Solid → Level → Output, and a bank holding the brightnesses the tests move between. */
function levelGraph(brightness: number): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: node("solid", "solid", "solid1", { color: [1, 1, 1, 1] }),
      grade: node("grade", "level", "level1", { brightness }),
      out: node("out", "output", "out1", {}),
      bank: presetBankNode("bank", "looks", "level1", [
        { name: "mid", values: { level1: { brightness: 0.4 } } },
        { name: "bright", values: { level1: { brightness: 0.8 } } },
      ]),
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "grade", portId: "input" } },
      e1: { id: "e1", source: { nodeId: "grade", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

/** One step of the fold, written as the resolver writes it so the static twin gets the same double. */
const mix = (a: number, b: number, t: number): number => a * (1 - t) + b * t;

interface Shot {
  readonly bytes: Buffer;
  /** The first pixel, decoded: [r, g, b, a]. */
  readonly pixel: readonly number[];
}

/** Frames `capture` of `graph`, rendered animated as the app renders; `epoch` absent = an export. */
async function render(graph: GraphDocument, capture: readonly number[], epoch?: string): Promise<Shot[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    fps: FPS,
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    ...(epoch === undefined ? {} : { absEpoch: epoch }),
  });
  expect(result.frames.map((frame) => frame.frameIndex)).toEqual([...capture]);
  return result.frames.map((frame) => ({
    bytes: Buffer.from(frame.bytes),
    pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)],
  }));
}

const shot = async (graph: GraphDocument, frame: number, epoch?: string): Promise<Shot> => {
  const [only] = await render(graph, [frame], epoch);
  if (only === undefined) throw new Error("no frame captured");
  return only;
};

/** A session with the Level at 0.2 and a one-second linear morph to 0.8 recalled on frame 0. */
async function fading(): Promise<PresetSession> {
  const session = presetSession(levelGraph(0.2), registry);
  session.at({ epoch: EPOCH, absTimeSeconds: 0 });
  await session.recall("bank", "bright", LINEAR_1S);
  return session;
}

describe("T1497b on Dawn — the fade is on the pixels, at its analytic value", () => {
  it("a 1 s linear morph of Level brightness 0.2 → 0.8 reads 0.5 at frame 30 of 60 fps", async () => {
    requireDawn();
    const session = await fading();
    const graph = session.graph();
    // The document holds the destination; only the picture is still on its way.
    expect(graph.nodes["grade"]?.parameters["brightness"]).toBe(0.8);

    const [start, half, end, after] = await render(graph, [0, 30, 60, 90], EPOCH);
    expect(half?.pixel).toEqual([0.5, 0.5, 0.5, 1]);
    // No jump on the frame of the recall, exact arrival, and it stays.
    expect(Buffer.compare(start?.bytes ?? Buffer.alloc(0), (await shot(levelGraph(0.2), 0)).bytes)).toBe(0);
    expect(Buffer.compare(end?.bytes ?? Buffer.alloc(0), (await shot(levelGraph(0.8), 60)).bytes)).toBe(0);
    expect(Buffer.compare(after?.bytes ?? Buffer.alloc(0), end?.bytes ?? Buffer.alloc(1))).toBe(0);
    // And the static twin at 0.5 is the same bytes — the twin comparison the later tests lean on.
    expect(Buffer.compare(half?.bytes ?? Buffer.alloc(0), (await shot(levelGraph(0.5), 30)).bytes)).toBe(0);
    expect(Buffer.compare(half?.bytes ?? Buffer.alloc(0), end?.bytes ?? Buffer.alloc(0))).not.toBe(0);
  }, 120_000);

  it("a second recall at half-time continues from the on-screen value — no jump at the frame of the recall", async () => {
    requireDawn();
    const session = await fading();
    const before = await shot(session.graph(), 30, EPOCH);
    expect(before.pixel).toEqual([0.5, 0.5, 0.5, 1]);

    // Frame 30 is on screen: its absolute clock is what the second recall is stamped with.
    session.at({ epoch: EPOCH, absTimeSeconds: 30 / FPS });
    await session.recall("bank", "mid", LINEAR_1S);
    const graph = session.graph();
    expect(graph.nodes["grade"]?.parameters["brightness"]).toBe(0.4);
    expect(parseMorphRecords(graph.nodes["bank"]?.parameters["morphs"])).toHaveLength(2);

    const [same, later, landed] = await render(graph, [30, 45, 90], EPOCH);
    // The SAME frame, the new document: byte-identical to what was on screen before it.
    expect(Buffer.compare(same?.bytes ?? Buffer.alloc(0), before.bytes)).toBe(0);
    // Frame 45: the first fade is at 0.75, the second a quarter in — the fold, analytically.
    const folded = mix(mix(0.2, 0.8, 45 / FPS), 0.4, 45 / FPS - 30 / FPS);
    expect(folded).toBeCloseTo(0.5875, 12);
    expect(Buffer.compare(later?.bytes ?? Buffer.alloc(0), (await shot(levelGraph(folded), 45)).bytes)).toBe(0);
    expect(Buffer.compare(landed?.bytes ?? Buffer.alloc(0), (await shot(levelGraph(0.4), 90)).bytes)).toBe(0);
  }, 120_000);

  it("a slider edit mid-morph wins at once", async () => {
    requireDawn();
    const session = await fading();
    const edited = await session.bus.execute(
      "graph.applyPatch",
      patch(session.store.view.getRevision(), [{ op: "setParameters", nodeId: "grade", parameters: { brightness: 0.6 } }]),
      contextFor(bob),
    );
    expect(edited.status).toBe("applied");
    // The record is still in the bank; the edit needed no extra write to take the key over.
    expect(parseMorphRecords(session.graph().nodes["bank"]?.parameters["morphs"])).toHaveLength(1);
    const twin = await render(levelGraph(0.6), [30, 31]);
    const frames = await render(session.graph(), [30, 31], EPOCH);
    expect(Buffer.compare(frames[0]?.bytes ?? Buffer.alloc(0), twin[0]?.bytes ?? Buffer.alloc(1))).toBe(0);
    expect(Buffer.compare(frames[1]?.bytes ?? Buffer.alloc(0), twin[1]?.bytes ?? Buffer.alloc(1))).toBe(0);
  }, 120_000);

  it("undo mid-morph restores the old value at the next frame", async () => {
    requireDawn();
    const session = await fading();
    expect((await shot(session.graph(), 30, EPOCH)).pixel[0]).toBe(0.5);
    const undone = await session.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    const next = await shot(session.graph(), 31, EPOCH);
    expect(Buffer.compare(next.bytes, (await shot(levelGraph(0.2), 31)).bytes)).toBe(0);
  }, 120_000);
});

describe("T1497b on Dawn — an export of a document saved mid-morph renders the END state", () => {
  it("saved, reopened and rendered twice: byte-identical, and the destination on every frame", async () => {
    requireDawn();
    const session = await fading();
    // Mid-fade in the live session …
    expect((await shot(session.graph(), 30, EPOCH)).pixel[0]).toBe(0.5);

    // … saved through the real serializer and reopened through the real loader.
    const text = serializeProjectDocument({
      schemaVersion: SCHEMA_VERSION,
      projectId: "morph",
      name: "saved mid-morph",
      graph: session.graph(),
      settings,
      assets: [],
      createdAt: "2026-10-02T00:00:00.000Z",
      updatedAt: "2026-10-02T00:00:00.000Z",
    });
    const loaded = loadProject(text, { nodes: registry });
    expect(loaded.ok, loaded.ok ? "" : loaded.reason).toBe(true);
    if (!loaded.ok) return;
    const reopened = loaded.document.graph;
    // The record survived the file — this is not a document that merely lost its fade.
    expect(parseMorphRecords(reopened.nodes["bank"]?.parameters["morphs"])).toHaveLength(1);

    // Frames 0, 30 and 59 are start, middle and last frame of the saved fade.
    const frames = [0, 30, 59];
    const first = await render(reopened, frames);
    const second = await render(reopened, frames);
    const destination = await render(levelGraph(0.8), frames);
    for (let index = 0; index < frames.length; index += 1) {
      const a = first[index]?.bytes ?? Buffer.alloc(0);
      expect(Buffer.compare(a, second[index]?.bytes ?? Buffer.alloc(1)), `export 1 vs 2, frame ${String(frames[index])}`).toBe(0);
      expect(Buffer.compare(a, destination[index]?.bytes ?? Buffer.alloc(1)), `end state, frame ${String(frames[index])}`).toBe(0);
    }
    // Not vacuous: the destination is not what the live session showed mid-fade.
    expect(first[1]?.pixel[0]).not.toBe(0.5);
    // A take in the app counts in a NEW epoch (the render zeroes the clock): the same.
    const take = await render(reopened, frames, "take-1");
    for (let index = 0; index < frames.length; index += 1) {
      expect(Buffer.compare(take[index]?.bytes ?? Buffer.alloc(0), destination[index]?.bytes ?? Buffer.alloc(1))).toBe(0);
    }
  }, 180_000);
});

/* ------------------------------------------------------------------------------------ */
/* T1524b: inside a component, on pixels                                                  */
/* ------------------------------------------------------------------------------------ */

/**
 * A look is usually a component instance, and flattening dissolves it. T1497b carried a
 * fade down a published FAN-OUT; these are the other two ways a published value reaches
 * the inside, which used to cut: a `parent.<key>` read (§V81) and a compound the instance
 * sets per component (§V113). Same harness, same twin comparison — and the harness hands
 * flattening a PLAIN node registry, so this also holds the index to not needing the
 * component-aware one.
 */
const componentGraph = (nodes: Record<string, GraphNode>, edges: Record<string, unknown> = {}): GraphDocument =>
  ({ revision: 1, groups: {}, nodes, edges }) as unknown as GraphDocument;

/** white Solid → Level whose brightness READS `parent.gain`; `gain` is published with no targets. */
const boundLook = {
  componentId: "bound",
  version: 1,
  name: "Bound",
  graph: componentGraph(
    {
      src: node("src", "solid", "src", { color: [1, 1, 1, 1] }),
      grade: node("grade", "level", "grade", {
        brightness: { mode: "bind", bindings: { bind: { kind: "bind", ref: "parent.gain" }, static: { kind: "static", value: 1 } } },
      }),
    },
    { e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "grade", portId: "input" } } },
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
  parameters: [{ key: "gain", definition: { type: "number", label: "Gain", default: 1, min: 0, max: 8, range: "floor" }, targets: [] }],
} as unknown as GraphComponentDefinition;

/** A Solid whose colour is published as `tint`, so the instance may set it per channel. */
const tintLook = {
  componentId: "tint",
  version: 1,
  name: "Tint",
  graph: componentGraph({ src: node("src", "solid", "src", { color: [1, 1, 1, 1] }) }),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "src", portId: "out" }],
  parameters: [
    {
      key: "tint",
      definition: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" },
      targets: [{ nodeId: "src", key: "color" }],
    },
  ],
} as unknown as GraphComponentDefinition;

const looks = createComponentSystem(registry, [boundLook, tintLook]);

/** `city` (an instance holding `stored`) → Output, and a bank whose `go` preset writes `recalled` onto it. */
function cityGraph(componentId: string, stored: Record<string, unknown>, recalled: Record<string, unknown> = {}): GraphDocument {
  return componentGraph(
    {
      city: node("city", componentNodeType(componentId, 1), "city", stored),
      out: node("out", "output", "out1", {}),
      bank: presetBankNode("bank", "looks", "city", [{ name: "go", values: { city: recalled as never } }]),
    },
    { e1: { id: "e1", source: { nodeId: "city", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
  );
}

async function renderLook(graph: GraphDocument, capture: readonly number[], epoch?: string): Promise<Shot[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    fps: FPS,
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    components: looks.components.view(),
    ...(epoch === undefined ? {} : { absEpoch: epoch }),
  });
  expect(result.frames.map((frame) => frame.frameIndex)).toEqual([...capture]);
  return result.frames.map((frame) => ({
    bytes: Buffer.from(frame.bytes),
    pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)],
  }));
}

const lookShot = async (graph: GraphDocument, frame: number): Promise<Buffer> => {
  const [only] = await renderLook(graph, [frame]);
  if (only === undefined) throw new Error("no frame captured");
  return only.bytes;
};

/** The document after `go` is recalled with a one-second linear morph on frame 0. */
async function fadingLook(graph: GraphDocument): Promise<GraphDocument> {
  const session = presetSession(graph, looks.nodes);
  session.at({ epoch: EPOCH, absTimeSeconds: 0 });
  await session.recall("bank", "go", LINEAR_1S);
  return session.graph();
}

describe("T1524b on Dawn — a fade on an instance's knob reaches the inside by every road", () => {
  it("a Level that READS parent.gain: a 1 s linear 0.2 → 0.8 on the knob is 0.5 on the pixel at frame 30", async () => {
    requireDawn();
    const graph = await fadingLook(cityGraph("bound", { gain: 0.2 }, { gain: 0.8 }));
    expect(graph.nodes["city"]?.parameters["gain"]).toBe(0.8);

    const [start, half, end, after] = await renderLook(graph, [0, 30, 60, 90], EPOCH);
    expect(half?.pixel).toEqual([0.5, 0.5, 0.5, 1]);
    // No jump on the frame of the recall, exact arrival, and it stays — against static twins.
    expect(Buffer.compare(start?.bytes ?? Buffer.alloc(0), await lookShot(cityGraph("bound", { gain: 0.2 }), 0))).toBe(0);
    expect(Buffer.compare(half?.bytes ?? Buffer.alloc(0), await lookShot(cityGraph("bound", { gain: 0.5 }), 30))).toBe(0);
    expect(Buffer.compare(end?.bytes ?? Buffer.alloc(0), await lookShot(cityGraph("bound", { gain: 0.8 }), 60))).toBe(0);
    expect(Buffer.compare(after?.bytes ?? Buffer.alloc(0), end?.bytes ?? Buffer.alloc(1))).toBe(0);
    expect(Buffer.compare(half?.bytes ?? Buffer.alloc(0), end?.bytes ?? Buffer.alloc(0))).not.toBe(0);
    // An export — no epoch — renders the destination on the frame the live session was half-way.
    const [exported] = await renderLook(graph, [30]);
    expect(Buffer.compare(exported?.bytes ?? Buffer.alloc(0), await lookShot(cityGraph("bound", { gain: 0.8 }), 30))).toBe(0);
  }, 180_000);

  it("a colour published PER COMPONENT: `tint.r` 0.2 → 0.8 moves the red channel alone, half-way at frame 30", async () => {
    requireDawn();
    const tint = [0.25, 0.5, 0.75, 1];
    const twin = (red: number): GraphDocument => cityGraph("tint", { tint, "tint.r": red });
    const graph = await fadingLook(cityGraph("tint", { tint, "tint.r": 0.2 }, { "tint.r": 0.8 }));
    expect(graph.nodes["city"]?.parameters["tint.r"]).toBe(0.8);

    const [start, half, end] = await renderLook(graph, [0, 30, 60], EPOCH);
    // A channel is a NUMBER and fades as one, in the space it is stored in: 0.5 at half-time.
    expect(Buffer.compare(start?.bytes ?? Buffer.alloc(0), await lookShot(twin(0.2), 0))).toBe(0);
    expect(Buffer.compare(half?.bytes ?? Buffer.alloc(0), await lookShot(twin(0.5), 30))).toBe(0);
    expect(Buffer.compare(end?.bytes ?? Buffer.alloc(0), await lookShot(twin(0.8), 60))).toBe(0);
    // Green and blue never moved; red did, and is strictly between its ends.
    expect(half?.pixel.slice(1)).toEqual(end?.pixel.slice(1));
    expect(half?.pixel[0]).toBeGreaterThan(start?.pixel[0] ?? Infinity);
    expect(half?.pixel[0]).toBeLessThan(end?.pixel[0] ?? -Infinity);
  }, 180_000);
});

/* ------------------------------------------------------------------------------------ */
/* T1505b: a look's presets inside its component, on pixels                               */
/* ------------------------------------------------------------------------------------ */

/**
 * A look whose PRESETS live in its definition: white Solid → Level, the Level's brightness
 * published as `bright`, and a page bank `looks` (Targets `parent`) beside them. Two
 * instances, `cityA` and `cityB`, sit at the root; the recall is the real command on a bus
 * with the catalogue attached as the app attaches it. The instance is the bank: the record
 * lives on `cityA` keyed `parent`, and the morph index reads it under `cityA`'s name.
 */
const pageLook = {
  componentId: "page",
  version: 1,
  name: "Page",
  graph: componentGraph(
    {
      src: node("src", "solid", "src", { color: [1, 1, 1, 1] }),
      grade: node("grade", "level", "grade", { brightness: 1 }),
      looks: presetBankNode("looks", "looks", "parent", [
        { name: "up", values: { parent: { bright: 0.8 } } },
        { name: "down", values: { parent: { bright: 0.2 } } },
      ]),
    },
    { e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "grade", portId: "input" } } },
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
  parameters: [
    { key: "bright", definition: { type: "number", label: "Bright", default: 1, min: 0, max: 8, range: "floor" }, targets: [{ nodeId: "grade", key: "brightness" }] },
  ],
} as unknown as GraphComponentDefinition;

const pages = createComponentSystem(registry, [pageLook]);

/** cityA and cityB (each holding `bright`), the Output showing `shown`, and any extra root nodes. */
function pageGraph(a: number, b: number, shown: "a" | "b" = "a", extra: Record<string, GraphNode> = {}): GraphDocument {
  return componentGraph(
    {
      a: node("a", componentNodeType("page", 1), "cityA", { bright: a }),
      b: node("b", componentNodeType("page", 1), "cityB", { bright: b }),
      out: node("out", "output", "out1", {}),
      ...extra,
    },
    { e1: { id: "e1", source: { nodeId: shown, portId: "out" }, target: { nodeId: "out", portId: "input" } } },
  );
}

/** The same document with the Output showing the other instance. Edges carry no preset state. */
const showing = (graph: GraphDocument, shown: "a" | "b"): GraphDocument => ({
  ...graph,
  edges: { e1: { id: "e1", source: { nodeId: shown, portId: "out" }, target: { nodeId: "out", portId: "input" } } },
});

async function renderPage(graph: GraphDocument, capture: readonly number[], epoch?: string): Promise<Shot[]> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    fps: FPS,
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    components: pages.components.view(),
    ...(epoch === undefined ? {} : { absEpoch: epoch }),
  });
  expect(result.frames.map((frame) => frame.frameIndex)).toEqual([...capture]);
  return result.frames.map((frame) => ({
    bytes: Buffer.from(frame.bytes),
    pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)],
  }));
}

const pageShot = async (graph: GraphDocument, frame: number, epoch?: string): Promise<Shot> => {
  const [only] = await renderPage(graph, [frame], epoch);
  if (only === undefined) throw new Error("no frame captured");
  return only;
};

describe("T1505b on Dawn — a look's own preset, recalled on ONE instance, fades that instance alone", () => {
  it("cityA: 1 s linear 0.2 → 0.8 reads exactly 0.5 at frame 30; cityB, never recalled, reads its 0.2 twin", async () => {
    requireDawn();
    const session = presetSession(pageGraph(0.2, 0.2), pages.nodes, pages.components);
    session.at({ epoch: EPOCH, absTimeSeconds: 0 });
    await session.recall("a", "up", LINEAR_1S);
    const graph = session.graph();
    // The instance holds the destination, its own current, and the record keyed `parent`.
    expect(graph.nodes["a"]?.parameters["bright"]).toBe(0.8);
    expect(graph.nodes["a"]?.parameters["presetCurrent"]).toBe("up");
    expect(parseMorphRecords(graph.nodes["a"]?.parameters["presetMorphs"]).map((record) => record.to)).toEqual([{ parent: { bright: 0.8 } }]);
    expect(graph.nodes["b"]?.parameters["presetMorphs"]).toBeUndefined();

    const [start, half, end] = await renderPage(graph, [0, 30, 60], EPOCH);
    expect(half?.pixel).toEqual([0.5, 0.5, 0.5, 1]);
    expect(Buffer.compare(start?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(0.2, 0.2), 0)).bytes)).toBe(0);
    expect(Buffer.compare(end?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(0.8, 0.2), 60)).bytes)).toBe(0);
    expect(Buffer.compare(half?.bytes ?? Buffer.alloc(0), end?.bytes ?? Buffer.alloc(0))).not.toBe(0);

    // cityB on the same frame of the same document: exactly its own stored 0.2.
    const other = await pageShot(showing(graph, "b"), 30, EPOCH);
    expect(Buffer.compare(other.bytes, (await pageShot(pageGraph(0.2, 0.2, "b"), 30)).bytes)).toBe(0);
    expect(Buffer.compare(other.bytes, half?.bytes ?? Buffer.alloc(0))).not.toBe(0);
  }, 180_000);

  it("a shot's record (root bank, keyed cityA) and the look's own record (keyed parent) chain: the second continues from the screen", async () => {
    requireDawn();
    const shots = presetBankNode("shots", "shots", "cityA", [{ name: "drop", values: { cityA: { bright: 0.8 } } }]);
    const session = presetSession(pageGraph(0.2, 0.2, "a", { shots }), pages.nodes, pages.components);
    session.at({ epoch: EPOCH, absTimeSeconds: 0 });
    await session.recall("shots", "drop", LINEAR_1S);
    const before = await pageShot(session.graph(), 30, EPOCH);
    expect(before.pixel).toEqual([0.5, 0.5, 0.5, 1]);

    // Frame 30 is on screen: the look's own preset is recalled on cityA from there.
    session.at({ epoch: EPOCH, absTimeSeconds: 30 / FPS });
    await session.recall("a", "down", LINEAR_1S);
    const graph = session.graph();
    expect(parseMorphRecords(graph.nodes["shots"]?.parameters["morphs"])).toHaveLength(1);
    expect(parseMorphRecords(graph.nodes["a"]?.parameters["presetMorphs"])).toHaveLength(1);

    const [same, later, landed] = await renderPage(graph, [30, 45, 90], EPOCH);
    // No jump on the frame of the recall: byte-identical to what was on screen before it.
    expect(Buffer.compare(same?.bytes ?? Buffer.alloc(0), before.bytes)).toBe(0);
    // Frame 45: the shot's fade at 0.75, the look's a quarter in — one fold across both.
    const folded = mix(mix(0.2, 0.8, 45 / FPS), 0.2, 45 / FPS - 30 / FPS);
    expect(folded).toBeCloseTo(0.5375, 12);
    expect(Buffer.compare(later?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(folded, 0.2), 45)).bytes)).toBe(0);
    expect(Buffer.compare(landed?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(0.2, 0.2), 90)).bytes)).toBe(0);
  }, 180_000);
});

/* ------------------------------------------------------------------------------------ */
/* T1541b: a timed cue recalling a look's instance bank, on pixels                         */
/* ------------------------------------------------------------------------------------ */

/**
 * A cue list following the timeline (§T1508b) whose cues name `cityA` — the look's instance,
 * which IS its bank from outside (§T1505b). Until §T1541b the morph index had no catalogue,
 * so it could not read the instance's presets and skipped both cues. Now the flattening hands
 * the index its own catalogue, as recall reads the bus's: at 60 fps, cue A at 1 s fades cityA
 * 0.2 → 0.8 over 1 s (`up`), cue B at 2.5 s cuts to 0.2 (`down`). Frames 30 / 90 / 120 / 150
 * read 0.2 / 0.5 / 0.8 / 0.2, each byte-identical to the static twin; the document is never
 * written, and cityB — on the same frames — keeps its own stored value.
 */
describe("T1541b on Dawn — a timed cue recalls a look's instance bank", () => {
  const timedShow = (): GraphNode =>
    node("show", "cueList", "show", {
      follow: "timeline",
      cues: serializeCueList({
        version: 1,
        cues: [
          { name: "A", bank: "cityA", preset: "up", morph: LINEAR_1S, at: 1 },
          { name: "B", bank: "cityA", preset: "down", morph: { seconds: 0, curve: "linear" }, at: 2.5 },
        ],
      }),
    });

  it("0.2 / 0.5 / 0.8 / 0.2 at frames 30 / 90 / 120 / 150, exact; cityB untouched; nothing written", async () => {
    requireDawn();
    const graph = pageGraph(0.2, 0.3, "a", { show: timedShow() });
    const before = JSON.stringify(graph);

    const [early, half, end, cut] = await renderPage(graph, [30, 90, 120, 150]);
    expect(half?.pixel).toEqual([0.5, 0.5, 0.5, 1]);
    expect(Buffer.compare(early?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(0.2, 0.3), 30)).bytes)).toBe(0);
    expect(Buffer.compare(half?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(0.5, 0.3), 90)).bytes)).toBe(0);
    expect(Buffer.compare(end?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(0.8, 0.3), 120)).bytes)).toBe(0);
    expect(Buffer.compare(cut?.bytes ?? Buffer.alloc(0), (await pageShot(pageGraph(0.2, 0.3), 150)).bytes)).toBe(0);
    // The cue applied: frame 120 is not the stored value.
    expect(Buffer.compare(end?.bytes ?? Buffer.alloc(0), early?.bytes ?? Buffer.alloc(0))).not.toBe(0);

    // cityB on the cue's frame of the same document: exactly its own stored 0.3.
    const other = await pageShot(showing(graph, "b"), 120);
    expect(Buffer.compare(other.bytes, (await pageShot(pageGraph(0.2, 0.3, "b"), 120)).bytes)).toBe(0);
    // A timed cue writes nothing (§V16): the document is as it was.
    expect(JSON.stringify(graph)).toBe(before);
  }, 240_000);
});
