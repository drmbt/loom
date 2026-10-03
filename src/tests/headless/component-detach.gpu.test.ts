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

describe("B239 on Dawn — detach inside a component edit session draws what the instance drew", () => {
  /**
   * FRAME holds `inner`, an instance of THE LOOK, exposed as FRAME's output, and `spare`, a
   * Level nothing draws — a target that keeps a knob read only through `parent.` published
   * across the session's write-back. The root draws an instance of FRAME. The session
   * detaches `inner` inside FRAME; the root document never changes, only the catalogue.
   * FRAME's output exposure names `inner`, so it must move onto the copy too, or the root
   * would draw nothing at all.
   */
  function frame(inner: Partial<GraphNode>, parameters: readonly unknown[]): GraphComponentDefinition {
    return {
      componentId: "frame",
      version: 1,
      name: "Frame",
      graph: graphOf(
        {
          inner: { ...node("inner", componentNodeType("look", 1), "inner", { bright: 1, gain: 1 }), ...inner } as GraphNode,
          spare: node("spare", "level", "spare", { brightness: 1 }),
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
      frame({ parameters: { bright: 1, gain: 0.8 }, state: { parentBindings: { bright: "parent.glow" } } }, [knob("glow", [{ nodeId: "spare", key: "brightness" }])]),
      { glow: 0.5 },
    );
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(before.pixel).toEqual([0.39990234375, 0.39990234375, 0.39990234375, 1]);
  }, 120_000);

  it("a sibling bind chaining to parent. (bright → gain → parent.glow 0.5) resolves like flattening: 0.5 × 0.5, byte-identical", async () => {
    requireDawn();
    const bind = (ref: string) => ({ mode: "bind", bindings: { bind: { kind: "bind", ref }, static: { kind: "static", value: 1 } } }) as const;
    const { before, after } = await beforeAndAfter(
      frame({ parameters: { bright: bind("gain"), gain: bind("parent.glow") } }, [knob("glow", [{ nodeId: "spare", key: "brightness" }])]),
      { glow: 0.5 },
    );
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(before.pixel).toEqual([0.25, 0.25, 0.25, 1]);
  }, 120_000);

  it("FRAME's knobs on the instance's keys move onto the copies (level → bright 0.5, glow → gain 0.25, read by parent.gain): byte-identical", async () => {
    requireDawn();
    const { before, after } = await beforeAndAfter(
      frame({}, [knob("level", [{ nodeId: "inner", key: "bright" }]), knob("glow", [{ nodeId: "inner", key: "gain" }, { nodeId: "spare", key: "brightness" }])]),
      { level: 0.5, glow: 0.25 },
    );
    expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
    expect(before.pixel).toEqual([0.125, 0.125, 0.125, 1]);
  }, 120_000);
});
