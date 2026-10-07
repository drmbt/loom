import { Buffer } from "node:buffer";

import { beforeAll, describe, expect, it } from "vitest";

import { alice, contextFor } from "../../domain/commands/test-support.ts";
import { componentNodeType, createComponentSystem, openComponentSession } from "../../domain/components/index.ts";
import { presetSession } from "../../domain/presets/test-support.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeComponents } from "./pixel-compare.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * B238 ON DAWN — A DETACHED LOOK RENDERS WHAT THE INSTANCE RENDERED.
 *
 * `component.detach` used to give the copies the definition's values, so a look whose knob
 * the instance had turned rendered differently the moment it was detached. The detach is
 * the real command on a real bus with the catalogue attached; both renders are the headless
 * harness — the same `compileGraph`, vgpu backend and `FrameDriver.step()` — on Dawn, and
 * the claim is byte equality (§V147): the instance and its detached graph are one picture.
 *
 * THE LOOK: white Solid → Level `grade` (brightness ← published `bright`, a fan-out) →
 * Level `trim` (brightness READS `parent.gain`, published with no targets). The definition
 * holds 1 and 1; the instance holds 0.5 and 0.8, so its picture is 0.4 and a copy left at
 * the definition's values would draw 1.0 — the exact bug, on pixels.
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

const node = (id: string, type: string, label: string, parameters: Record<string, unknown>): GraphNode =>
  ({ id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters }) as GraphNode;

const graphOf = (nodes: Record<string, GraphNode>, edges: Record<string, unknown>): GraphDocument =>
  ({ revision: 1, groups: {}, nodes, edges }) as unknown as GraphDocument;

const edge = (id: string, from: string, to: string) => ({
  id,
  source: { nodeId: from, portId: "out" },
  target: { nodeId: to, portId: "input" },
});

const lookDefinition = {
  componentId: "look",
  version: 1,
  name: "Look",
  graph: graphOf(
    {
      src: node("src", "solid", "src", { color: [1, 1, 1, 1] }),
      grade: node("grade", "level", "grade", { brightness: 1 }),
      trim: node("trim", "level", "trim", {
        brightness: { mode: "bind", bindings: { bind: { kind: "bind", ref: "parent.gain" }, static: { kind: "static", value: 1 } } },
      }),
    },
    { e0: edge("e0", "src", "grade"), e1: edge("e1", "grade", "trim") },
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "trim", portId: "out" }],
  parameters: [
    { key: "bright", definition: { type: "number", label: "Bright", default: 1, min: 0, max: 8, range: "floor" }, targets: [{ nodeId: "grade", key: "brightness" }] },
    { key: "gain", definition: { type: "number", label: "Gain", default: 1, min: 0, max: 8, range: "floor" }, targets: [] },
  ],
} as unknown as GraphComponentDefinition;

const looks = createComponentSystem(registry, [lookDefinition]);

/** The look's instance → Output. */
function lookGraph(page: Record<string, unknown>): GraphDocument {
  return graphOf(
    { city: node("city", componentNodeType("look", 1), "city", page), out: node("out", "output", "out1", {}) },
    { e9: { id: "e9", source: { nodeId: "city", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
  );
}

async function render(graph: GraphDocument, capture: readonly number[]): Promise<Array<{ bytes: Buffer; pixel: number[] }>> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    fps: FPS,
    frames: Math.max(...capture) + 1,
    capture: [...capture],
    animate: true,
    components: looks.components.view(),
  });
  expect(result.frames.map((frame) => frame.frameIndex)).toEqual([...capture]);
  return result.frames.map((frame) => ({ bytes: Buffer.from(frame.bytes), pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)] }));
}

/** `graph` after the real `component.detach` on `city`. */
async function detached(graph: GraphDocument): Promise<GraphDocument> {
  const session = presetSession(graph, looks.nodes, looks.components);
  const result = await session.bus.execute("component.detach", { nodeId: "city" }, contextFor(alice));
  expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  const after = session.graph();
  expect(after.nodes["city"]).toBeUndefined();
  return after;
}

describe("B238 on Dawn — an instance and its detached graph are one picture", () => {
  it("nested published colour channels keep moving and match ordinary Solid parameters on pixels", async () => {
    requireDawn();
    const tint: GraphComponentDefinition = {
      componentId: "tint", version: 1, name: "Tint",
      graph: graphOf({ src: node("src", "solid", "solid_inner", { color: [1, 1, 1, 1] }) }, {}),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "src", portId: "out" }],
      parameters: [{ key: "tint", definition: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" }, targets: [{ nodeId: "src", key: "color" }] }],
    };
    const wrapped: GraphComponentDefinition = {
      componentId: "wrappedTint", version: 1, name: "Wrapped Tint",
      graph: graphOf({ inner: node("inner", componentNodeType("tint", 1), "tint_inner", {}) }, {}),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [{ key: "color", definition: { type: "color", label: "Color", default: [1, 1, 1, 1], space: "display" }, targets: [{ nodeId: "inner", key: "tint" }] }],
    };
    const system = catalogue([tint, wrapped]);
    const moving = (source: string) => ({ mode: "expression", bindings: { expression: { kind: "expression", source }, static: { kind: "static", value: 0.9 } } });
    const page = { color: [0.2, 0.3, 0.75, 1], "color.r": moving("0.25 + time * 0.5"), "color.g": moving("0.5 - time * 0.5") };
    const makeGraph = (type: string, label: string) => graphOf({
      paint: node("paint", type, label, page),
      out: node("out", "output", "output1", { toneMap: "none" }),
    }, { painted: edge("painted", "paint", "out") });
    const capture = async (graph: GraphDocument) => {
      const result = await renderHeadless({ host: nodeGpuHost(), graph, settings, fps: FPS, frames: 31, capture: [0, 30], animate: true, components: system.components.view() });
      expect(result.frames.map(frame => frame.frameIndex)).toEqual([0, 30]);
      return result.frames.map(frame => ({ bytes: Buffer.from(frame.bytes), pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)] }));
    };
    const before = await capture(makeGraph(componentNodeType("wrappedTint", 1), "wrappedtint1"));
    const ordinary = await capture(makeGraph("solid", "solid_ordinary"));
    for (let index = 0; index < before.length; index += 1) expect(Buffer.compare(before[index]!.bytes, ordinary[index]!.bytes)).toBe(0);
    // Both animated channels move in opposite directions; equality cannot be two
    // pictures stuck at the same retained colour or decoded at each nesting level.
    expect(before[0]!.pixel[0]).toBeLessThan(before[1]!.pixel[0]!);
    expect(before[0]!.pixel[1]).toBeGreaterThan(before[1]!.pixel[1]!);
    expect(before[0]!.pixel[2]).toBe(before[1]!.pixel[2]);
    expect(before[0]!.pixel[3]).toBe(1);
  }, 120_000);

  it("bright 0.5 (a fan-out) × gain 0.8 (a parent.<key> read): byte-identical before and after detach, and not the definition's 1.0", async () => {
    requireDawn();
    const instance = lookGraph({ bright: 0.5, gain: 0.8 });
    const copy = await detached(instance);
    const [before] = await render(instance, [0]);
    const [after] = await render(copy, [0]);
    expect(Buffer.compare(after!.bytes, before!.bytes)).toBe(0);
    // The knob is on the picture: 0.5 × 0.8, in binary16. A copy at the definition's 1 × 1
    // would draw white — which is what the instance at its defaults draws.
    expect(before!.pixel).toEqual([0.39990234375, 0.39990234375, 0.39990234375, 1]);
    const [defaults] = await render(lookGraph({ bright: 1, gain: 1 }), [0]);
    expect(Buffer.compare(after!.bytes, defaults!.bytes)).not.toBe(0);
  }, 120_000);

  it("an EXPRESSION on the knob keeps moving after detach: frames 0 and 30 match the instance's, byte for byte", async () => {
    requireDawn();
    const moving = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.25 + time * 0.5" }, static: { kind: "static", value: 1 } } };
    const instance = lookGraph({ bright: moving, gain: 1 });
    const copy = await detached(instance);
    const before = await render(instance, [0, 30]);
    const after = await render(copy, [0, 30]);
    expect(Buffer.compare(after[0]!.bytes, before[0]!.bytes)).toBe(0);
    expect(Buffer.compare(after[1]!.bytes, before[1]!.bytes)).toBe(0);
    // It moves: 0.25 at frame 0, 0.5 at frame 30 (0.5 s).
    expect(before[0]!.pixel).toEqual([0.25, 0.25, 0.25, 1]);
    expect(before[1]!.pixel).toEqual([0.5, 0.5, 0.5, 1]);
  }, 120_000);
});

/**
 * B239 ON DAWN — WHAT FLATTENING APPLIES BESIDE THE PAGE, AND WHERE THE PAGE COMES FROM.
 *
 * Each case renders the instance and its detached (or detached-instantiated) graph through
 * the same headless harness and asserts byte equality (§V147), and pins the picture to a
 * value the bug would not have drawn, so the equality cannot be two wrong pictures.
 */

/** A catalogue of its own: a session writes into it, and no other case may see that. */
function catalogue(definitions: readonly GraphComponentDefinition[]) {
  return createComponentSystem(registry, definitions);
}

async function renderWith(system: ReturnType<typeof catalogue>, graph: GraphDocument): Promise<{ bytes: Buffer; pixel: number[] }> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    fps: FPS,
    frames: 1,
    capture: [0],
    animate: true,
    components: system.components.view(),
  });
  const frame = result.frames[0]!;
  return { bytes: Buffer.from(frame.bytes), pixel: [...decodeComponents(frame.bytes, frame.format).slice(0, 4)] };
}

/**
 * A GRADIENT LOOK: horizontal Ramp `src` → Level `grade` (brightness ← published `bright`).
 * A gradient, so a resolution override is on the picture (a 2×2 ramp upsampled is not an
 * 8×8 one); a channel mask on `grade` keeps its input's green and blue.
 */
const rampLook = {
  componentId: "ramplook",
  version: 1,
  name: "Ramp look",
  graph: graphOf(
    {
      src: { ...node("src", "ramp", "src", {}), definitionVersion: 2 } as GraphNode,
      grade: node("grade", "level", "grade", { brightness: 1 }),
    },
    { e0: edge("e0", "src", "grade") },
  ),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
  parameters: [
    { key: "bright", definition: { type: "number", label: "Bright", default: 1, min: 0, max: 8, range: "floor" }, targets: [{ nodeId: "grade", key: "brightness" }] },
  ],
} as unknown as GraphComponentDefinition;

describe("B239 on Dawn — internal resolution overrides and channel masks survive detach", () => {
  it("src at a fixed 2×2 and grade masked to red: byte-identical before and after detach, and not the un-overridden picture", async () => {
    requireDawn();
    const system = catalogue([rampLook]);
    const graphWith = (state: Record<string, unknown> | undefined): GraphDocument =>
      graphOf(
        {
          city: { ...node("city", componentNodeType("ramplook", 1), "city", { bright: 0.5 }), ...(state === undefined ? {} : { state }) } as GraphNode,
          out: node("out", "output", "out1", {}),
        },
        { e9: { id: "e9", source: { nodeId: "city", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
      );
    const overridden = graphWith({
      componentResolutionOverrides: { src: { mode: "fixed", width: 2, height: 2 } },
      componentChannelMaskOverrides: { grade: { r: true, g: false, b: false, a: true } },
    });
    const session = presetSession(overridden, system.nodes, system.components);
    const result = await session.bus.execute("component.detach", { nodeId: "city" }, contextFor(alice));
    expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    const before = await renderWith(system, overridden);
    const after = await renderWith(system, session.graph());
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    // Both overrides are on the picture: without them it is a different picture.
    const plain = await renderWith(system, graphWith(undefined));
    expect(Buffer.compare(before.bytes, plain.bytes)).not.toBe(0);
    const unmasked = await renderWith(system, graphWith({ componentResolutionOverrides: { src: { mode: "fixed", width: 2, height: 2 } } }));
    expect(Buffer.compare(before.bytes, unmasked.bytes)).not.toBe(0);
    const unsized = await renderWith(system, graphWith({ componentChannelMaskOverrides: { grade: { r: true, g: false, b: false, a: true } } }));
    expect(Buffer.compare(before.bytes, unsized.bytes)).not.toBe(0);
  }, 120_000);
});

/**
 * T1545b ON DAWN — THE INSTANCE'S OWN Processing Channels survive detach where they can.
 *
 * Flattening masks an instance's exposed picture output with a compiler-only boundary that
 * keeps the other channels of the instance's first connected input; detach moves the mask
 * onto the node behind the output, whose own mask is the same pass keeping ITS first
 * input's. Two shapes where that is the same picture: a filter fed from outside (Ramp →
 * [Level grade, brightness 0.5]) and a generator with no input ([Ramp src], the rest
 * opaque black). Each masked to R+A, each byte-identical before and after, and each a
 * different picture from the unmasked instance.
 */
describe("T1545b on Dawn — the instance's own channelMask survives detach", () => {
  const red = { r: true, g: false, b: false, a: true };
  const ramp = (id: string): GraphNode => ({ ...node(id, "ramp", id, {}), definitionVersion: 2 }) as GraphNode;
  const gradeLook = {
    componentId: "gradelook",
    version: 1,
    name: "Grade look",
    graph: graphOf({ grade: node("grade", "level", "grade", { brightness: 0.5 }) }, {}),
    inputs: [{ externalId: "in", label: "In", nodeId: "grade", portId: "input" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "grade", portId: "out" }],
    parameters: [],
  } as unknown as GraphComponentDefinition;
  const rampOnly = {
    componentId: "ramponly",
    version: 1,
    name: "Ramp only",
    graph: graphOf({ src: ramp("src") }, {}),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "src", portId: "out" }],
    parameters: [],
  } as unknown as GraphComponentDefinition;

  async function maskedBeforeAndAfter(componentId: string, fed: boolean) {
    const system = catalogue([gradeLook, rampOnly]);
    const graphWith = (mask: typeof red | undefined): GraphDocument =>
      graphOf(
        {
          ...(fed ? { feed: ramp("feed") } : {}),
          city: { ...node("city", componentNodeType(componentId, 1), "city", {}), ...(mask === undefined ? {} : { channelMask: mask }) } as GraphNode,
          out: node("out", "output", "out1", {}),
        },
        {
          ...(fed ? { e8: { id: "e8", source: { nodeId: "feed", portId: "out" }, target: { nodeId: "city", portId: "in" } } } : {}),
          e9: { id: "e9", source: { nodeId: "city", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
      );
    const masked = graphWith(red);
    const session = presetSession(masked, system.nodes, system.components);
    const result = await session.bus.execute("component.detach", { nodeId: "city" }, contextFor(alice));
    expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    expect(result.diagnostics.map((each) => each.code)).not.toContain("component.detach.channelMask");
    const carried = Object.values(session.graph().nodes).filter((each) => each.channelMask !== undefined);
    expect(carried.map((each) => [each.label, each.channelMask])).toEqual([[componentId === "gradelook" ? "grade" : "src", red]]);
    const before = await renderWith(system, masked);
    const after = await renderWith(system, session.graph());
    const unmasked = await renderWith(system, graphWith(undefined));
    return { before, after, unmasked };
  }

  it("a filter fed from outside (Ramp → grade 0.5), masked R+A: byte-identical, and not the unmasked picture", async () => {
    requireDawn();
    const { before, after, unmasked } = await maskedBeforeAndAfter("gradelook", true);
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(Buffer.compare(before.bytes, unmasked.bytes)).not.toBe(0);
  }, 120_000);

  it("a generator with no input (Ramp src), masked R+A — the rest opaque black: byte-identical, and not the unmasked picture", async () => {
    requireDawn();
    const { before, after, unmasked } = await maskedBeforeAndAfter("ramponly", false);
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(Buffer.compare(before.bytes, unmasked.bytes)).not.toBe(0);
    // The first pixel's green and blue are the boundary's opaque black, not the ramp's.
    expect(before.pixel[1]).toBe(0);
    expect(before.pixel[2]).toBe(0);
  }, 120_000);
});

describe("B239 on Dawn — a detached instantiate draws what a fresh linked instance draws", () => {
  it("Bright defaults to 0.5 and Gain to 0.8 while the definition holds 1 and 1: the copies draw 0.4, byte for byte the linked instance", async () => {
    requireDawn();
    const withDefaults = {
      ...lookDefinition,
      parameters: lookDefinition.parameters.map((published) => ({
        ...published,
        definition: { ...published.definition, default: published.key === "bright" ? 0.5 : 0.8 },
      })),
    } as GraphComponentDefinition;
    const system = catalogue([withDefaults]);
    const placed = async (mode: "linked" | "detached"): Promise<GraphDocument> => {
      const session = presetSession(graphOf({ out: node("out", "output", "out1", {}) }, {}), system.nodes, system.components);
      const made = await session.bus.execute("component.instantiate", { componentId: "look", mode }, contextFor(alice));
      expect(made.status, made.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
      const graph = session.graph();
      const source = mode === "linked" ? made.output.nodeId! : made.output.nodeIds.find((id) => graph.nodes[id]?.label === "trim")!;
      const wired = await session.bus.execute(
        "graph.applyPatch",
        { baseRevision: session.store.view.getRevision(), label: "wire", operations: [{ op: "connect", source: { nodeId: source, portId: "out" }, target: { nodeId: "out", portId: "input" } }] },
        contextFor(alice),
      );
      expect(wired.status, wired.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
      return session.graph();
    };
    const linked = await renderWith(system, await placed("linked"));
    const detached = await renderWith(system, await placed("detached"));
    expect(Buffer.compare(detached.bytes, linked.bytes)).toBe(0);
    // 0.5 × 0.8 in binary16; the definition's own 1 × 1 would draw white.
    expect(linked.pixel).toEqual([0.39990234375, 0.39990234375, 0.39990234375, 1]);
  }, 120_000);
});

/**
 * T1545b ON DAWN — A DETACHED INSTANTIATE'S PAGE BANK RECALLS ONTO THE COPIES.
 *
 * THE LOOK with a page bank `looks` (Targets `parent.bright`, preset `dim` = bright 0.5). A
 * linked instance recalls `dim` on itself; a detached copy recalls `dim` on its copied bank.
 * The copied bank used to keep targeting `parent`, which names nothing at the root, so the
 * recall reached nothing and the copies stayed white.
 */
describe("T1545b on Dawn — a detached instantiate's page bank recalls what the linked instance's does", () => {
  it("recall dim: the linked instance and the detached copies both draw bright 0.5, byte for byte", async () => {
    requireDawn();
    const withBank = {
      ...lookDefinition,
      graph: {
        ...lookDefinition.graph,
        nodes: {
          ...lookDefinition.graph.nodes,
          looks: node("looks", "presets", "looks", {
            targets: "parent.bright",
            presets: JSON.stringify({ version: 1, presets: [{ name: "dim", values: { parent: { bright: 0.5 } } }] }),
          }),
        },
      },
    } as GraphComponentDefinition;
    const system = catalogue([withBank]);
    const placed = async (mode: "linked" | "detached"): Promise<GraphDocument> => {
      const session = presetSession(graphOf({ out: node("out", "output", "out1", {}) }, {}), system.nodes, system.components);
      const made = await session.bus.execute("component.instantiate", { componentId: "look", mode }, contextFor(alice));
      expect(made.status, made.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
      const graph = session.graph();
      const labelled = (label: string): string => made.output.nodeIds.find((id) => graph.nodes[id]?.label === label)!;
      const source = mode === "linked" ? made.output.nodeId! : labelled("trim");
      const wired = await session.bus.execute(
        "graph.applyPatch",
        { baseRevision: session.store.view.getRevision(), label: "wire", operations: [
          { op: "connect", source: { nodeId: source, portId: "out" }, target: { nodeId: "out", portId: "input" } },
          // A look's presets reach its page by the instance's name.
          ...(mode === "linked" ? [{ op: "setNodeLabel" as const, nodeId: source, label: "city" }] : []),
        ] },
        contextFor(alice),
      );
      expect(wired.status, wired.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
      await session.recall(mode === "linked" ? made.output.nodeId! : labelled("looks"), "dim");
      return session.graph();
    };
    const linked = await renderWith(system, await placed("linked"));
    const detached = await renderWith(system, await placed("detached"));
    expect(linked.pixel).toEqual([0.5, 0.5, 0.5, 1]);
    expect(Buffer.compare(detached.bytes, linked.bytes)).toBe(0);
  }, 120_000);
});

describe("B239 on Dawn — detach inside a component edit session draws what the instance drew", () => {
  /**
   * FRAME holds `inner`, an instance of THE LOOK, exposed as FRAME's output. Its `glow` is
   * read inside only through `parent.glow` and published with no target there (B240: the
   * session's write-back keeps it, and these cases need no stand-in target to survive).
   * The root draws an instance of FRAME. The session detaches `inner` inside FRAME; the
   * root document never changes, only the catalogue. FRAME's output exposure names
   * `inner`, so it must move onto the copy too, or the root would draw nothing at all.
   */
  function frame(inner: Partial<GraphNode>, parameters: readonly unknown[]): GraphComponentDefinition {
    return {
      componentId: "frame",
      version: 1,
      name: "Frame",
      graph: graphOf(
        {
          inner: { ...node("inner", componentNodeType("look", 1), "inner", { bright: 1, gain: 1 }), ...inner } as GraphNode,
        },
        {},
      ),
      inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters,
    } as unknown as GraphComponentDefinition;
  }
  const knob = (key: string, targets: ReadonlyArray<{ nodeId: string; key: string }>) => ({
    key,
    definition: { type: "number", label: key, default: 1, min: 0, max: 8, range: "floor" },
    targets,
  });

  async function beforeAndAfter(definition: GraphComponentDefinition, page: Record<string, unknown>) {
    const system = catalogue([lookDefinition, definition]);
    const root = graphOf(
      { scene: node("scene", componentNodeType("frame", 1), "scene", page), out: node("out", "output", "out1", {}) },
      { e9: { id: "e9", source: { nodeId: "scene", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
    );
    const before = await renderWith(system, root);
    const session = openComponentSession({ components: system.components, nodes: system.nodes, componentId: "frame", version: 1 });
    const result = await session.bus.execute("component.detach", { nodeId: "inner" }, contextFor(alice));
    session.dispose();
    expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    expect(system.components.get("frame", 1)?.graph.nodes["inner"]).toBeUndefined();
    const after = await renderWith(system, root);
    return { before, after };
  }

  it("the instance's legacy parentBindings (bright ← parent.glow 0.5) are carried: 0.5 × 0.8, byte-identical", async () => {
    requireDawn();
    const { before, after } = await beforeAndAfter(
      frame({ parameters: { bright: 1, gain: 0.8 }, state: { parentBindings: { bright: "parent.glow" } } }, [knob("glow", [])]),
      { glow: 0.5 },
    );
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(before.pixel).toEqual([0.39990234375, 0.39990234375, 0.39990234375, 1]);
  }, 120_000);

  it("a sibling bind chaining to parent. (bright → gain → parent.glow 0.5) resolves like flattening: 0.5 × 0.5, byte-identical", async () => {
    requireDawn();
    const bind = (ref: string) => ({ mode: "bind", bindings: { bind: { kind: "bind", ref }, static: { kind: "static", value: 1 } } }) as const;
    const { before, after } = await beforeAndAfter(
      frame({ parameters: { bright: bind("gain"), gain: bind("parent.glow") } }, [knob("glow", [])]),
      { glow: 0.5 },
    );
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(before.pixel).toEqual([0.25, 0.25, 0.25, 1]);
  }, 120_000);

  it("FRAME's knobs on the instance's keys move onto the copies (level → bright 0.5, glow → gain 0.25, read by parent.gain): byte-identical", async () => {
    requireDawn();
    const { before, after } = await beforeAndAfter(
      frame({}, [knob("level", [{ nodeId: "inner", key: "bright" }]), knob("glow", [{ nodeId: "inner", key: "gain" }])]),
      { level: 0.5, glow: 0.25 },
    );
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(before.pixel).toEqual([0.125, 0.125, 0.125, 1]);
  }, 120_000);

  /**
   * T1545b — UNDO AND REDO OF THAT DETACH. The moved targets and FRAME's output exposure
   * live in the catalogue, not in the session's store; undo used to bring `inner` back with
   * the page and the exposure still aimed at the (gone) copies, which the prune then dropped:
   * FRAME exposed nothing and the root drew no picture. Each state is rendered on Dawn.
   */
  it("T1545b: detach, undo, redo inside FRAME — all three draw 0.5 × 0.25, byte for byte", async () => {
    requireDawn();
    const system = catalogue([lookDefinition, frame({}, [knob("level", [{ nodeId: "inner", key: "bright" }]), knob("glow", [{ nodeId: "inner", key: "gain" }])])]);
    const root = graphOf(
      { scene: node("scene", componentNodeType("frame", 1), "scene", { level: 0.5, glow: 0.25 }), out: node("out", "output", "out1", {}) },
      { e9: { id: "e9", source: { nodeId: "scene", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
    );
    const before = await renderWith(system, root);
    expect(before.pixel).toEqual([0.125, 0.125, 0.125, 1]);
    const session = openComponentSession({ components: system.components, nodes: system.nodes, componentId: "frame", version: 1 });
    const step = async (command: "component.detach" | "graph.undo" | "graph.redo"): Promise<{ bytes: Buffer; pixel: number[] }> => {
      const result = command === "component.detach"
        ? await session.bus.execute(command, { nodeId: "inner" }, contextFor(alice))
        : await session.bus.execute(command, {}, contextFor(alice));
      expect(result.status, `${command}: ${result.diagnostics.map((each) => each.message).join("; ")}`).toBe("applied");
      return renderWith(system, root);
    };
    const detached = await step("component.detach");
    const undone = await step("graph.undo");
    expect(system.components.get("frame", 1)?.graph.nodes["inner"]).toBeDefined();
    const redone = await step("graph.redo");
    session.dispose();
    expect(Buffer.compare(detached.bytes, before.bytes)).toBe(0);
    expect(Buffer.compare(undone.bytes, before.bytes)).toBe(0);
    expect(Buffer.compare(redone.bytes, before.bytes)).toBe(0);
  }, 120_000);

  /**
   * T1545b — A CARRIED READ SKIPS THE PAGE KNOB'S CHECK. Flattening does not clamp what
   * reaches a page knob from outside: the page knob REFUSES it, as an error, and falls back
   * (here the instance's page holds `parent.glow`, and Bright is 0..1 bounded while FRAME's
   * Glow is 0..8 floor). Inside Bright's range the copies draw what the instance drew, byte
   * for byte. At Glow 2 the instance's compile is refused by name ("bright is 2, above its
   * maximum 1"), while the copies read parent.glow straight onto Level's 0..8 brightness and
   * draw 2 × 0.8 — no value on a copy can restate Bright's range, which is why detach says
   * so by name.
   */
  it("T1545b: bright (0..1) carried from parent.glow (0..8): byte-identical at glow 0.25, and said by name because at glow 2 they part", async () => {
    requireDawn();
    const narrow = {
      ...lookDefinition,
      parameters: lookDefinition.parameters.map((published) =>
        published.key === "bright" ? { ...published, definition: { type: "number", label: "Bright", default: 1, min: 0, max: 1, range: "bounded" } } : published,
      ),
    } as GraphComponentDefinition;
    const glowBind = { mode: "bind", bindings: { bind: { kind: "bind", ref: "parent.glow" }, static: { kind: "static", value: 0.5 } } } as const;
    const system = catalogue([narrow, frame({ parameters: { bright: glowBind, gain: 0.8 } }, [knob("glow", [])])]);
    const root = (glow: number): GraphDocument =>
      graphOf(
        { scene: node("scene", componentNodeType("frame", 1), "scene", { glow }), out: node("out", "output", "out1", {}) },
        { e9: { id: "e9", source: { nodeId: "scene", portId: "out" }, target: { nodeId: "out", portId: "input" } } },
      );
    const inRange = await renderWith(system, root(0.25));
    await expect(renderWith(system, root(2))).rejects.toThrow('Parameter "bright" is 2, above its maximum 1.');
    const session = openComponentSession({ components: system.components, nodes: system.nodes, componentId: "frame", version: 1 });
    const result = await session.bus.execute("component.detach", { nodeId: "inner" }, contextFor(alice));
    session.dispose();
    expect(result.status, result.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    const said = result.diagnostics.filter((each) => each.code === "component.detach.inexact").map((each) => each.message);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('"inner"\'s bright takes its value from parent.glow');
    // Inside Bright's range: one picture (0.25 × 0.8 in binary16).
    expect(inRange.pixel).toEqual([0.199951171875, 0.199951171875, 0.199951171875, 1]);
    expect(Buffer.compare((await renderWith(system, root(0.25))).bytes, inRange.bytes)).toBe(0);
    // Outside it the copies accept what the instance refused.
    expect((await renderWith(system, root(2))).pixel).toEqual([1.599609375, 1.599609375, 1.599609375, 1]);
  }, 120_000);
});

/**
 * B240 ON DAWN — A SESSION EDIT KEEPS A KNOB READ ONLY AS `parent.<key>`.
 *
 * THE LOOK's `gain` is published with no targets and read inside only by `trim`'s
 * `parent.gain` bind (§V81). The session's write-back prune used to unpublish every knob
 * with zero targets on every graph edit, so an unrelated move inside THE LOOK took `gain`
 * off the page and `trim` fell back to its retained 1: the instance at gain 0.8 drew 0.5,
 * not 0.4. Here the move is the real `graph.applyPatch` on a real session; the picture is
 * rendered after it, and pinned to 0.5 × 0.8.
 */
describe("B240 on Dawn — an unrelated session edit keeps a parent.<key>-only knob on the picture", () => {
  it("a move inside THE LOOK leaves gain published, and bright 0.5 × gain 0.8 still draws 0.4", async () => {
    requireDawn();
    const system = catalogue([lookDefinition]);
    const instance = lookGraph({ bright: 0.5, gain: 0.8 });
    const before = await renderWith(system, instance);
    const session = openComponentSession({ components: system.components, nodes: system.nodes, componentId: "look", version: 1 });
    const moved = await session.bus.execute(
      "graph.applyPatch",
      { baseRevision: session.store.view.getRevision(), label: "move", operations: [{ op: "moveNodes", positions: { src: { x: 40, y: 40 } } }] },
      contextFor(alice),
    );
    session.dispose();
    expect(moved.status, moved.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
    const written = system.components.get("look", 1)!;
    expect(written.graph.nodes["src"]?.position).toEqual({ x: 40, y: 40 });
    const after = await renderWith(system, instance);
    expect(after.pixel).toEqual([0.39990234375, 0.39990234375, 0.39990234375, 1]);
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(written.parameters.map((published) => [published.key, published.targets.length])).toEqual([["bright", 1], ["gain", 0]]);
  }, 120_000);
});
