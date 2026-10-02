import { beforeAll, describe, expect, it } from "vitest";

import { alice, contextFor } from "../../domain/commands/test-support.ts";
import { presetBankNode, presetSession } from "../../domain/presets/test-support.ts";
import type { GraphDocument, GraphEdge, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu`
// import is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import type { HeadlessRenderResult } from "../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";

/**
 * T1498b — the `layer` node on a real device (§V147: every expectation below is exact or
 * derived by arithmetic a reader can check; no tolerance band).
 *
 * What the performer relies on, and what each case proves:
 *
 *  - OFF IS FREE. A bypassed layer shows the stack below bit for bit, AND the plan holds no
 *    pass for the picture's chain. The second half is the point of the ruling (a look
 *    switched off must cost nothing); the first half alone would pass for a layer that
 *    rendered its look at opacity 0.
 *  - THE FADE IS ANALYTIC in every blend at a known pair of colours, and Over and Replace
 *    disagree at opacity 0.5 (a picture with coverage 0.5 is the case that tells them apart).
 *  - BY NAME, ONLY THE NAMED LOOK COOKS: its passes are in the plan and the other look's
 *    are not, and swapping the name swaps both the passes and the picture.
 *  - A DRIVEN OPACITY moves the picture per frame, off a retained static the render would
 *    show if the expression were not reaching the GPU.
 *  - A PRESET SWITCHES IT (T1499b, S3's last acceptance line): a bank's `on`, recalled
 *    through the real bus, is the same bypass — after the recall's one patch the picture's
 *    chain has no pass, and one undo brings it back.
 *
 * ## Why these colours, and why rgba16float
 *
 * `solid` decodes its colour from display space, and the sRGB decode is the identity at
 * exactly 0 and 1, so every colour component here is 0 or 1 and no decode error enters.
 * Alpha is coverage, not colour, and is not decoded: the picture's 0.5 arrives as 0.5 (the
 * premise case pins it). Every result is then a multiple of 1/8, exact in half float, so the
 * working format is rgba16float (8-bit unorm would round 0.5 to 127 or 128). Display
 * transform off, so nothing sits between the blend and the bytes.
 */

const SIZE = 8;

const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

/** The stack below: opaque yellow. */
const BELOW = [1, 1, 0, 1];
/** The picture: cyan at coverage 0.5 — Over and Replace differ only where coverage is partial. */
const PICTURE = [0, 1, 1, 0.5];

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

function requireDawn(): void {
  // Never skipped (§C): a machine without a GPU must not turn this into a green tick.
  if (dawnError !== undefined) throw new Error(`Dawn unavailable, so the layer is unverified: ${dawnError}`);
}

const node = (id: string, type: string, parameters: GraphNode["parameters"] = {}, label?: string): GraphNode => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  ...(label === undefined ? {} : { label }),
});

const edge = (id: string, from: string, to: string, port: string): GraphEdge => ({
  id,
  source: { nodeId: from, portId: "out" },
  target: { nodeId: to, portId: port },
});

/** A look: a solid through a Flip, so the "chain" is two nodes with a pass each. */
function look(prefix: string, color: readonly number[]): Record<string, GraphNode> {
  return {
    [`${prefix}Src`]: node(`${prefix}Src`, "solid", { color: [...color] }),
    [prefix]: node(prefix, "flip", {}, prefix),
  };
}

interface LayerSetup {
  readonly below?: GraphNode;
  readonly layer?: GraphNode["parameters"];
  readonly bypassed?: boolean;
  /** Wire this look into `picture` instead of naming it. */
  readonly wired?: string;
}

/**
 * `base` → layer.below; two looks, `city` and `smoke`, which the layer may name; → out.
 * Both looks are always in the document, so "only the named one cooks" is a claim about
 * the plan, not about what exists.
 */
function layerGraph(setup: LayerSetup): GraphDocument {
  const nodes: Record<string, GraphNode> = {
    base: setup.below ?? node("base", "solid", { color: [...BELOW] }, "base"),
    ...look("city", PICTURE),
    ...look("smoke", [1, 0, 1, 1]),
    layer: {
      ...node("layer", "layer", setup.layer ?? {}, "layer1"),
      ...(setup.bypassed === true ? { ui: { bypassed: true } } : {}),
    },
    out: node("out", "output"),
  };
  const edges: Record<string, GraphEdge> = {
    eCity: edge("eCity", "citySrc", "city", "input"),
    eSmoke: edge("eSmoke", "smokeSrc", "smoke", "input"),
    eBelow: edge("eBelow", "base", "layer", "below"),
    eOut: edge("eOut", "layer", "out", "input"),
    ...(setup.wired === undefined ? {} : { eWire: edge("eWire", setup.wired, "layer", "picture") }),
  };
  return { revision: 1, nodes, edges, groups: {} } as GraphDocument;
}

async function render(
  graph: GraphDocument,
  outputNodeId: string,
  options: { readonly frames?: number; readonly capture?: number[]; readonly animate?: boolean } = {},
): Promise<HeadlessRenderResult> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings,
    frames: options.frames ?? 1,
    capture: options.capture ?? [0],
    outputNodeId,
    ...(options.animate === true ? { animate: true } : {}),
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result;
}

/** The centre texel of a captured frame, decoded. */
function centre(result: HeadlessRenderResult, index = 0): number[] {
  const frame = result.frames[index]!;
  expect(frame.format).toBe("rgba16float");
  const pixels = decodeComponents(frame.bytes, frame.format);
  const at = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
  return Array.from(pixels.slice(at, at + 4));
}

/** Every node that owns at least one pass in the plan. */
function cooked(result: HeadlessRenderResult): Set<string> {
  return new Set(result.plan.passes.flatMap((pass) => ("nodeId" in pass && typeof pass.nodeId === "string" ? [pass.nodeId] : [])));
}

/** out = mix(below, blend(picture, below), opacity), per the arithmetic in `layer.wgsl.ts`. */
const mix = (a: readonly number[], b: readonly number[], t: number): number[] => a.map((value, i) => value * (1 - t) + b[i]! * t);

describe("T1498b — Layer on Dawn", () => {
  it("premise: the picture's coverage arrives as 0.5 and its colour undecoded", async () => {
    requireDawn();
    const graph = layerGraph({ layer: { picture: "city" } });
    expect(centre(await render(graph, "city"))).toEqual(PICTURE);
    expect(centre(await render(graph, "base"))).toEqual(BELOW);
  }, 120_000);

  it("bypassed, shows the stack below bit for bit and cooks nothing of the picture's chain", async () => {
    requireDawn();
    // A ramp below, so "bit for bit" covers every texel of a picture that varies, not one colour.
    const ramp = node("base", "ramp", {
      type: "horizontal",
      stops: [
        { position: 0, color: [1, 0, 0, 1] },
        { position: 1, color: [0, 0, 1, 1] },
      ],
    });
    const plain: GraphDocument = {
      revision: 1,
      nodes: { base: ramp, out: node("out", "output") },
      edges: { eOut: edge("eOut", "base", "out", "input") },
      groups: {},
    } as GraphDocument;
    const expected = await render(plain, "out");

    for (const [how, setup] of [
      ["by name", { layer: { picture: "city", opacity: 0.5 } }],
      ["by wire", { layer: { opacity: 0.5 }, wired: "city" }],
    ] as const) {
      const off = await render(layerGraph({ ...setup, below: ramp, bypassed: true }), "out");
      expect(Array.from(off.frames[0]!.bytes), how).toEqual(Array.from(expected.frames[0]!.bytes));
      const passes = cooked(off);
      for (const nodeId of ["citySrc", "city", "layer", "smokeSrc", "smoke"]) {
        expect(passes.has(nodeId), `${how}: ${nodeId} has a pass while the layer is off`).toBe(false);
      }
      expect(passes.has("base"), how).toBe(true);

      // Non-vacuity: switched ON, the same graph cooks the picture's chain and the picture shows.
      const on = await render(layerGraph({ ...setup, below: ramp }), "out");
      expect(Array.from(on.frames[0]!.bytes), how).not.toEqual(Array.from(expected.frames[0]!.bytes));
      for (const nodeId of ["citySrc", "city", "layer"]) expect(cooked(on).has(nodeId), `${how}: ${nodeId}`).toBe(true);
    }
  }, 120_000);

  it("over and replace at opacity 0.5 give the analytic pixel, and differ where coverage is partial", async () => {
    requireDawn();
    // Over: Porter-Duff source-over of cyan@0.5 on opaque yellow = (0.5, 1, 0.5, 1);
    // mixed halfway back to yellow = (0.75, 1, 0.25, 1).
    const over = centre(await render(layerGraph({ layer: { picture: "city", opacity: 0.5, blend: "over" } }), "layer"));
    expect(over).toEqual([0.75, 1, 0.25, 1]);
    expect(over).toEqual(mix(BELOW, [0.5, 1, 0.5, 1], 0.5));
    // Replace: the picture itself, mixed halfway = (0.5, 1, 0.5, 0.75) — alpha too, so wet/dry.
    const replace = centre(await render(layerGraph({ layer: { picture: "city", opacity: 0.5, blend: "replace" } }), "layer"));
    expect(replace).toEqual([0.5, 1, 0.5, 0.75]);
    expect(replace).toEqual(mix(BELOW, PICTURE, 0.5));
  }, 120_000);

  it("add, screen and multiply at a known pair of colours, full and at half opacity", async () => {
    requireDawn();
    // Per channel across RGBA, as Composite does (§V140): yellow (1,1,0,1) with cyan@0.5.
    const cases = [
      ["add", [1, 2, 1, 1.5]],
      ["screen", [1, 1, 1, 1]],
      ["multiply", [0, 1, 0, 0.5]],
    ] as const;
    for (const [blend, full] of cases) {
      const atOne = centre(await render(layerGraph({ layer: { picture: "city", opacity: 1, blend } }), "layer"));
      expect(atOne, `${blend} at 1`).toEqual(full);
      const atHalf = centre(await render(layerGraph({ layer: { picture: "city", opacity: 0.5, blend } }), "layer"));
      expect(atHalf, `${blend} at 0.5`).toEqual(mix(BELOW, full, 0.5));
    }
    // Opacity 0 is the stack below in every mode — the fade Composite's opacity cannot give
    // Multiply, where scaling the front by 0 multiplies the stack by black.
    for (const [blend] of cases) {
      expect(centre(await render(layerGraph({ layer: { picture: "city", opacity: 0, blend } }), "layer")), blend).toEqual(BELOW);
    }
  }, 120_000);

  it("by name, cooks only the named look — and swapping the name swaps the passes and the picture", async () => {
    requireDawn();
    const city = await render(layerGraph({ layer: { picture: "city" } }), "layer");
    const smoke = await render(layerGraph({ layer: { picture: "smoke" } }), "layer");

    expect(["citySrc", "city"].every((id) => cooked(city).has(id))).toBe(true);
    expect(["smokeSrc", "smoke"].some((id) => cooked(city).has(id))).toBe(false);
    expect(["smokeSrc", "smoke"].every((id) => cooked(smoke).has(id))).toBe(true);
    expect(["citySrc", "city"].some((id) => cooked(smoke).has(id))).toBe(false);

    // Over at opacity 1: cyan@0.5 over yellow, and opaque magenta over anything, is magenta.
    expect(centre(city)).toEqual([0.5, 1, 0.5, 1]);
    expect(centre(smoke)).toEqual([1, 0, 1, 1]);

    // A named picture and a wired one are the same plan by construction (T350): same bytes.
    const wired = await render(layerGraph({ wired: "city" }), "layer");
    expect(Array.from(wired.frames[0]!.bytes)).toEqual(Array.from(city.frames[0]!.bytes));
  }, 120_000);

  it("a driven opacity moves the picture per frame, off the retained static", async () => {
    requireDawn();
    // `frame * 0.25`, retaining a static 1: frames 1 and 2 are opacity 0.25 and 0.5. Had the
    // expression not reached the GPU, both frames would show opacity 1 — the picture itself.
    const opacity = {
      mode: "expression",
      bindings: { static: { kind: "static", value: 1 }, expression: { kind: "expression", source: "frame * 0.25" } },
    } as unknown as GraphNode["parameters"][string];
    const driven = await render(layerGraph({ layer: { picture: "city", opacity, blend: "replace" } }), "layer", {
      frames: 3,
      capture: [1, 2],
      animate: true,
    });
    const first = centre(driven, 0);
    const second = centre(driven, 1);
    expect(first).toEqual(mix(BELOW, PICTURE, 0.25));
    expect(second).toEqual(mix(BELOW, PICTURE, 0.5));
    expect(first).not.toEqual(second);
    expect(first).not.toEqual(PICTURE);
  }, 120_000);

  it("a preset's `on` bypasses the layer in its one patch: after the recall the picture's chain has no pass", async () => {
    requireDawn();
    // The bank rides in the document like any node. `dark` also moves the layer's opacity,
    // so the on/off is seen to land WITH a value, in the same revision.
    const graph = layerGraph({ layer: { picture: "city", blend: "replace" } });
    const withBank = {
      ...graph,
      nodes: {
        ...graph.nodes,
        bank: presetBankNode("bank", "looks", "layer1", [
          { name: "dark", values: { layer1: { opacity: 0.5 } }, on: { layer1: false } },
          { name: "lit", values: {}, on: { layer1: true } },
        ]),
      },
    } as GraphDocument;
    const session = presetSession(withBank, createNodeRegistry(allNodeDefinitions).view());
    const chain = ["citySrc", "city", "layer"];

    // Premise: before the recall the layer is on, its picture cooks and shows.
    const before = await render(session.graph(), "out");
    for (const nodeId of chain) expect(cooked(before).has(nodeId), `before: ${nodeId}`).toBe(true);
    expect(centre(before)).toEqual(PICTURE);

    const revision = session.store.view.getRevision();
    await session.recall("bank", "dark");
    // ONE patch: the bypass and the opacity arrived in the same revision.
    expect(session.store.view.getRevision()).toBe(revision + 1);
    expect(session.graph().nodes["layer"]?.ui?.bypassed).toBe(true);
    expect(session.graph().nodes["layer"]?.parameters["opacity"]).toBe(0.5);

    const off = await render(session.graph(), "out");
    for (const nodeId of [...chain, "smokeSrc", "smoke"]) {
      expect(cooked(off).has(nodeId), `after the recall: ${nodeId} still has a pass`).toBe(false);
    }
    expect(cooked(off).has("base")).toBe(true);
    // Off, not faded: at opacity 0.5 a layer still ON would show the half-mix.
    expect(centre(off)).toEqual(BELOW);
    expect(centre(off)).not.toEqual(mix(BELOW, PICTURE, 0.5));

    // One undo takes the bypass back with the value: the chain cooks and the picture shows.
    const undone = await session.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    const again = await render(session.graph(), "out");
    for (const nodeId of chain) expect(cooked(again).has(nodeId), `after undo: ${nodeId}`).toBe(true);
    expect(centre(again)).toEqual(PICTURE);

    // And `on: true` is the way back a performer uses: off by one preset, on by another.
    await session.recall("bank", "dark");
    await session.recall("bank", "lit");
    const lit = await render(session.graph(), "out");
    for (const nodeId of chain) expect(cooked(lit).has(nodeId), `lit: ${nodeId}`).toBe(true);
    expect(centre(lit)).toEqual(mix(BELOW, PICTURE, 0.5));
  }, 120_000);
});

describe("B233 — a wire into `picture`, made through the bus", () => {
  /**
   * The owner's ruling 11 is "by wire OR by name", and until B233 the bus refused the wire
   * (`port.sourceReference`), so the wired cases above could only be reached by a document
   * written by hand. Here the wire is the app's own `connect`, laid over a layer that
   * already NAMES a look — the case that needs a rule. The rule: the wire wins and the
   * name is dormant, so the picture is the wired look's to the bit, the named look has no
   * pass, and taking the wire away returns the layer to the look it names.
   */
  it("wins over the name bit for bit, cooks only the wired look, and disconnecting returns to the name", async () => {
    requireDawn();
    const session = presetSession(
      layerGraph({ layer: { picture: "smoke" } }),
      createNodeRegistry(allNodeDefinitions).view(),
    );
    const apply = (operations: GraphPatchOperation[]) =>
      session.bus.execute(
        "graph.applyPatch",
        { baseRevision: session.store.view.getRevision(), operations },
        contextFor(alice),
      );

    // Premise: by name the layer shows smoke (opaque magenta over anything is magenta).
    const named = await render(session.graph(), "layer");
    expect(centre(named)).toEqual([1, 0, 1, 1]);
    expect(["smokeSrc", "smoke"].every((id) => cooked(named).has(id))).toBe(true);

    const connected = await apply([
      { op: "connect", ref: "$wire", source: { nodeId: "city", portId: "out" }, target: { nodeId: "layer", portId: "picture" } },
    ]);
    expect(connected.diagnostics).toEqual([]);
    expect(connected.status).toBe("applied");
    // The name is still written: it is what the layer returns to.
    expect(session.graph().nodes["layer"]?.parameters["picture"]).toBe("smoke");

    // Cyan at coverage 0.5 over opaque yellow — city's picture, not smoke's magenta.
    const wired = await render(session.graph(), "layer");
    expect(centre(wired)).toEqual([0.5, 1, 0.5, 1]);
    expect(centre(wired)).not.toEqual(centre(named));
    // The same bytes as a layer that was only ever wired: the dormant name changes nothing.
    const wireOnly = await render(layerGraph({ wired: "city" }), "layer");
    expect(Array.from(wired.frames[0]!.bytes)).toEqual(Array.from(wireOnly.frames[0]!.bytes));
    expect(["citySrc", "city"].every((id) => cooked(wired).has(id))).toBe(true);
    // Dormant means free: the named look has no pass while the wire is there.
    expect(["smokeSrc", "smoke"].some((id) => cooked(wired).has(id))).toBe(false);

    const disconnected = await apply([{ op: "disconnect", edgeIds: [connected.output.createdIds["$wire"] as string] }]);
    expect(disconnected.status).toBe("applied");
    const back = await render(session.graph(), "layer");
    expect(Array.from(back.frames[0]!.bytes)).toEqual(Array.from(named.frames[0]!.bytes));
    expect(["smokeSrc", "smoke"].every((id) => cooked(back).has(id))).toBe(true);
    expect(["citySrc", "city"].some((id) => cooked(back).has(id))).toBe(false);
  }, 120_000);
});
