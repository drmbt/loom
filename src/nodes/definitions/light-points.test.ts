import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { compileGraph, compiledWithoutCatalogue } from "../../compiler/index.ts";
import { flattenComponents } from "../../compiler/flatten.ts";
import { prepareFrameCompiler, structuralParameterKeys } from "../../compiler/frame-compile.ts";
import { graphChannelResolver } from "../../domain/channels/graph-channels.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { loadProject } from "../../domain/project/index.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { prepareMesh } from "../../points/mesh.ts";
import { renderPassRuns } from "../../runtime/backend/plan.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { forgetGeneratedText, generatedTextCounts } from "../../runtime/backend/wgsl.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { LAMP_ATTRIBUTES, SCATTERED_LAMPS, lampsScene, mapped, type LampsScene } from "./light-points.fixture.ts";
import { LIGHT_GRID_SLICES, MAX_LIGHT_SLOTS, MAX_POINT_LIGHTS, lightGridDimensions, lightTableStorage } from "./light-records.ts";
import { lightTableRowAt } from "../shaders/scene-lights.wgsl.ts";
import { lightNode } from "./scene.ts";
import { CASTERS_GLB } from "./shadow-casters.fixture.ts";
import { planFingerprint } from "./test-support.ts";

/**
 * T1589b, slice 1 — LIGHTS FROM A POINTSET, at the plan (no GPU).
 *
 * A Light in Points mode is one light at every point of a pointset; a Render culls such
 * lights on the GPU instead of unrolling a block of shader for each. What the pictures look
 * like is `light-points.gpu.test.ts`'s claim, on Dawn, over the same scenes
 * (`light-points.fixture.ts`). Here: what is refused and how it is said, what a lit draw
 * binds, what the device is asked for, that a frame of driven values builds no text, and
 * that a Render with no such Light is the Render it was.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 128, height: 128 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const compile = (graph: GraphDocument) => compileGraph({ graph, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
const errorsOf = (options: LampsScene) => compile(lampsScene(options)).diagnostics.filter((entry) => entry.severity === "error");
const compiled = (options: LampsScene = {}) => {
  const plan = compile(lampsScene(options));
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
};
type AnyPass = { readonly id: string; readonly kind: string; readonly shader?: string; readonly buffers?: ReadonlyArray<{ readonly binding: string }>; readonly uniforms?: Readonly<Record<string, unknown>> };
const passesOf = (plan: { readonly passes: ReadonlyArray<unknown> }): ReadonlyArray<AnyPass> => plan.passes as unknown as ReadonlyArray<AnyPass>;
/** A pass's id as its node wrote it: the plan puts the node's id and a `#` in front. */
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);
const pass = (plan: { readonly passes: ReadonlyArray<unknown> }, id: string): AnyPass => {
  const found = passesOf(plan).find((entry) => bare(entry.id) === id);
  if (found === undefined) throw new Error(`the plan has no pass "${id}"; it has ${passesOf(plan).map((entry) => bare(entry.id)).join(", ")}`);
  return found;
};

describe("T1589b: a Light in Points mode is rows of the Render's table, not a block of its shaders", () => {
  it("resolves in the Light, gathers and sorts in the Render, ahead of everything that draws the colour", () => {
    const ids = passesOf(compiled()).map((entry) => bare(entry.id));
    const at = (id: string): number => ids.indexOf(id);
    // The kernel that makes the points, then the Light's own pass, then the Render's two.
    expect(at("light_lamps:lights:resolve")).toBeGreaterThan(ids.findIndex((id) => id.startsWith("kernel_lamps")));
    expect(at("render_shot:lights:gather")).toBeGreaterThan(at("light_lamps:lights:resolve"));
    expect(at("render_shot:lights:grid")).toBe(at("render_shot:lights:gather") + 1);
    expect(at("render_shot:backdrop")).toBeGreaterThan(at("render_shot:lights:grid"));
    expect(ids.filter((id) => id.includes(":lights:"))).toEqual(["light_lamps:lights:resolve", "render_shot:lights:gather", "render_shot:lights:grid"]);
  });

  it("gives the lit draw one buffer and no block, and holds no count in any text: three lamps, three hundred and a thousand are the same shaders", () => {
    // The same kernel and the same maps at three capacities: one word a cell, ten, and thirty-two.
    const plans = [3, 300, 1000].map((count) => compiled({ count, kernel: SCATTERED_LAMPS }));
    const [few, many, most] = plans.map((plan) => pass(plan, "render_shot:scene:0"));
    for (const lit of [few, many, most]) {
      expect(lit?.buffers?.map((buffer) => buffer.binding)).toEqual(["positions", "lightTable"]);
      // Not one unrolled block: a Light in Single mode would have put `light0Meta` here.
      expect(String(lit?.shader)).not.toContain("light0Meta");
    }
    // ONE string each, not one a count (T1623b's property, for the rows there are so far):
    // the lit draw, the Light's resolve, the Render's gather and the grid's build.
    for (const id of ["render_shot:scene:0", "light_lamps:lights:resolve", "render_shot:lights:gather", "render_shot:lights:grid"]) {
      const texts = plans.map((plan) => String(pass(plan, id).shader));
      expect([id, texts[1] === texts[0], texts[2] === texts[0]]).toEqual([id, true, true]);
    }
    // What a count moves is values: the table's header, as the gather is handed it.
    const header = (plan: (typeof plans)[number]): unknown[] => ["count", "words", "cells"].map((key) => pass(plan, "render_shot:lights:gather").uniforms?.[key]);
    expect(plans.map(header)).toEqual([
      [3, 1, 4 + 3 * 16],
      [300, 10, 4 + 300 * 16],
      [1000, 32, 4 + 1000 * 16],
    ]);
  });

  it("sizes the table as a whole number of four-word elements, which is how the lit draw reads it", () => {
    // The lit draw sees the table as `array<vec4u>`: a last element cut short is out of its
    // reach, and the cell words in it would read as another cell's. The Render's own grids
    // have 24 slices and so always fit; a grid that does not is rounded up, never down.
    for (const [slots, grid] of [[33, [3, 3, 1]], [3, [5, 1, 1]], [1000, [16, 9, 24]]] as const) {
      const table = lightTableStorage("render_shot", slots, grid);
      const needed = table.cellsAt + table.cells * table.words;
      expect([slots, table.scratch.capacity % 4, table.scratch.capacity >= needed, table.scratch.capacity - needed < 4]).toEqual([slots, 0, true, true]);
      // The header and every region of rows start on an element too.
      expect([table.cellsAt % 4, lightTableRowAt("cone", slots) % 4]).toEqual([0, 0]);
    }
    expect((4 + 33 * 16 + 9 * 2) % 4).not.toBe(0);
  });

  it("keeps Type a value in Points mode too: a set of suns and a set of lamps are the same shaders, and a driven Type is a write", () => {
    // Type is a field of every row, so changing it compiles nothing (T1623b), in either mode.
    expect(structuralParameterKeys(lightNode, { mode: "points" }).has("kind")).toBe(false);
    expect(structuralParameterKeys(lightNode, { mode: "single" }).has("kind")).toBe(false);
    const lamps = compiled({ light: { kind: "point" } });
    const suns = compiled({ light: { kind: "directional", direction: [0, -1, 0] } });
    expect(passesOf(suns).map((entry) => String(entry.shader))).toEqual(passesOf(lamps).map((entry) => String(entry.shader)));
    // The difference is one float of the resolve's values, and the way the suns travel beside it.
    const shape = (plan: typeof lamps): number[] => pass(plan, "light_lamps:lights:resolve").uniforms?.["shape"] as number[];
    expect([shape(lamps)[2], shape(suns)[2]]).toEqual([1, 0]);
    expect(pass(suns, "light_lamps:lights:resolve").uniforms?.["aim"]).toEqual([0, -1, 0, 0]);
    // So a document that DRIVES Type stays on the values-only frame path.
    const driven = prepareFrameCompiler({ graph: lampsScene({ light: { kind: expressionSlot("0", 0) } }), settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
    expect(driven.uniformOnly).toBe(true);
  });

  it("stamps every row of a set with its Light's place in the Render's Lights, the Lights in Single mode counted", () => {
    const plan = compiled({
      nodes: [
        { id: "light_key", type: "light", parameters: { kind: "point", position: [0, 3, 0] } },
        { id: "light_more", type: "light", parameters: { mode: "points", kind: "point" } },
      ],
      edges: [["kernel_lamps", "light_more", "points"]],
      lights: "light_lamps light_key light_more",
    });
    const gather = pass(plan, "render_shot:lights:gather");
    // x: the row its records start at. y: how many. z: which Light of the list.
    expect(gather.uniforms?.["source0"]).toEqual([0, 3, 0, 0]);
    expect(gather.uniforms?.["source1"]).toEqual([3, 3, 2, 0]);
  });

  it("runs the lit generator's own light block for a light of the table: one falloff, one lobe", () => {
    const single = String(pass(compiled({ light: { mode: "single" } }), "render_shot:scene:0").shader);
    const points = String(pass(compiled(), "render_shot:scene:0").shader);
    // The block, from its falloff to its closing brace, with its indentation taken off.
    const blockOf = (text: string): string => {
      const from = text.indexOf("var toLight: vec3f;");
      const to = text.indexOf("lit += albedo.rgb * radiance * lambert;", from);
      expect([from > 0, to > from]).toEqual([true, true]);
      return text.slice(from, to).split("\n").map((line) => line.trim()).join("\n");
    };
    expect(blockOf(points)).toBe(blockOf(single));
  });

  it("makes the grid about 144 tiles as near square as the picture, by 24 slices", () => {
    expect(lightGridDimensions([1280, 720])).toEqual([16, 9, LIGHT_GRID_SLICES]);
    expect(lightGridDimensions([128, 128])).toEqual([12, 12, LIGHT_GRID_SLICES]);
    expect(lightGridDimensions([720, 1280])).toEqual([9, 16, LIGHT_GRID_SLICES]);
    // The Render hands the lit draw and the build the same grid, and the draw its own size in pixels.
    const plan = compiled({ render: { antialias: "ssaa" } });
    expect(pass(plan, "render_shot:lights:grid").uniforms?.["grid"]).toEqual([12, 12, 24, 1]);
    expect(pass(plan, "render_shot:scene:0").uniforms?.["lightGrid"]).toEqual([12, 12, 24, 1]);
    // Under SSAA the lit draw renders into a surface twice the size, and finds its tile from its own pixel.
    expect((pass(plan, "render_shot:scene:0").uniforms?.["lightLens"] as number[]).slice(0, 2)).toEqual([256, 256]);
    expect((pass(compiled(), "render_shot:scene:0").uniforms?.["lightLens"] as number[]).slice(0, 2)).toEqual([128, 128]);
  });

  it("leaves a Light in Single mode what it was, beside one in Points mode: its block, and the loop after it", () => {
    const plan = compiled({
      nodes: [{ id: "light_key", type: "light", parameters: { kind: "point", position: [0, 3, 0] } }],
      lights: "light_key light_lamps",
    });
    const lit = pass(plan, "render_shot:scene:0");
    expect(String(lit.shader)).toContain("light0Meta");
    expect(String(lit.shader)).not.toContain("light1Meta");
    expect(lit.buffers?.map((buffer) => buffer.binding)).toEqual(["positions", "lightTable"]);
  });
});

describe("T1589b: what a Light in Points mode refuses, by name (§V288)", () => {
  it("refuses Points with nothing wired, and says what to wire", () => {
    const [error] = errorsOf({ unwired: true });
    expect(error?.code).toBe("node.scene.lightPoints");
    expect(error?.message).toContain("no pointset arrives");
    expect(error?.nodeId).toBe("light_lamps");
  });

  it("refuses no Type: a pointset of directional lights is that many suns, and legal", () => {
    expect(errorsOf({ light: { kind: "directional" } })).toEqual([]);
  });

  it("defaults Range to 10 in Points mode and leaves it unlimited in Single", () => {
    expect((effectiveParameterSchema(lightNode, { mode: "points" })["range"] as { default: number }).default).toBe(10);
    expect((effectiveParameterSchema(lightNode, {})["range"] as { default: number }).default).toBe(0);
    // And that default is what the resolve pass is handed when Range is not stored at all.
    const plan = compile(lampsScene({ light: { range: undefined } }));
    expect((pass(plan, "light_lamps:lights:resolve").uniforms?.["shape"] as number[])[0]).toBe(10);
  });

  it("refuses a map on a parameter that takes none, a map on an absent attribute, and one of the wrong shape", () => {
    const [unhonoured] = errorsOf({ light: { shadowBias: mapped("gain", 0) } });
    expect(unhonoured?.code).toBe("node.parameter.map");
    expect(unhonoured?.message).toContain("shadowBias is in map mode");
    expect(unhonoured?.message).toContain('"color", "intensity", "position", "range"');

    const [absent] = errorsOf({ light: { color: mapped("hue", [1, 1, 1, 1]) } });
    expect(absent?.code).toBe("node.parameter.map");
    expect(absent?.message).toContain('color maps attribute "hue", which the incoming pointset does not carry');
    // It says what there is to map instead.
    expect(absent?.suggestion).toContain("color, gain, pair, place, position, reach");

    // A colour is a whole vec4f, an intensity one number: a vector needs its channel named.
    expect(errorsOf({ light: { color: mapped("gain", [1, 1, 1, 1]) } })[0]?.message).toContain("needs a vec4f attribute");
    expect(errorsOf({ light: { intensity: mapped("pair", 1) } })[0]?.message).toContain("needs a channel (x/y)");
    expect(errorsOf({ light: { position: mapped("color", [0, 0, 0]) } })[0]?.message).toContain("needs a vec3f attribute");
    // And the legitimate cases the refusals could swallow: every map this node honours, at once.
    compiled({ light: { color: mapped("color", [1, 1, 1, 1]), intensity: mapped("gain", 1), range: mapped("pair", 1, "y"), position: mapped("place", [0, 0, 0]) } });
  });

  it("refuses any map on a Light in Single mode: one light has no points to read from", () => {
    const [error] = errorsOf({ light: { mode: "single", intensity: mapped("gain", 1) } });
    expect(error?.code).toBe("node.parameter.map");
    expect(error?.message).toContain("intensity is in map mode, but this Light is one light");
  });
});

describe("T1589b: the Render's limits are numbers known at compile, and going past one is said by name", () => {
  it(`lights from ${MAX_LIGHT_SLOTS} points of capacity and refuses one more, naming each Light and what it holds`, () => {
    compiled({ count: MAX_LIGHT_SLOTS, kernel: SCATTERED_LAMPS });
    const [error] = errorsOf({ count: MAX_LIGHT_SLOTS + 1, kernel: SCATTERED_LAMPS });
    expect(error?.code).toBe("node.scene.lightCapacity");
    expect(error?.message).toContain("1025 points of capacity");
    expect(error?.message).toContain('"light_lamps" 1025');
    expect(error?.nodeId).toBe("render_shot");
    // Two Lights are counted together: every slot of every one.
    const second = { id: "light_more", type: "light", parameters: { mode: "points", kind: "point" } };
    const two: LampsScene = { count: 600, kernel: SCATTERED_LAMPS, nodes: [second], edges: [["kernel_lamps", "light_more", "points"]], lights: "light_lamps light_more" };
    expect(errorsOf(two)[0]?.message).toContain('"light_lamps" 600, "light_more" 600');
    compiled({ ...two, count: 512 });
  });

  it(`gathers ${MAX_POINT_LIGHTS} Lights in Points mode and refuses an eighth`, () => {
    const lights = (count: number): LampsScene => {
      const names = Array.from({ length: count - 1 }, (_, index) => `light_set${index}`);
      return {
        nodes: names.map((id) => ({ id, type: "light", parameters: { mode: "points", kind: "point" } })),
        edges: names.map((id) => ["kernel_lamps", id, "points"] as const),
        lights: ["light_lamps", ...names].join(" "),
      };
    };
    const seven = compiled(lights(MAX_POINT_LIGHTS));
    // One table and seven record buffers: the eight storage buffers a stage is guaranteed.
    expect(pass(seven, "render_shot:lights:gather").buffers).toHaveLength(8);
    const [error] = errorsOf(lights(MAX_POINT_LIGHTS + 1));
    expect(error?.code).toBe("node.scene.lightSources");
    expect(error?.message).toContain("8 Lights in Points mode");
    expect(error?.message).toContain('"light_set6"');
  });

  it("fits a fully attributed mesh Surface in the baseline's eight storage buffers, table included", () => {
    const facts = prepareMesh(CASTERS_GLB, "box")?.facts;
    if (facts === undefined) throw new Error('the fixture has no "box"');
    const plan = compiled({
      nodes: [
        { id: "mesh_box", type: "meshFileIn", parameters: { select: "box", ...facts } },
        { id: "geometry_box", type: "geometry", parameters: { mode: "surface" } },
      ],
      edges: [["mesh_box", "geometry_box", "points"]],
      scenes: "geometry_floor geometry_box",
    });
    // Compiled at the baseline tier, where eight is the limit and a ninth is a compile error
    // (`compiled` has already refused any): every row a mesh carries, and the table.
    const lit = pass(plan, "render_shot:scene:1");
    expect(lit.buffers?.map((buffer) => buffer.binding)).toEqual(["positions", "pointColors", "meshIndices", "meshNormals", "meshUvs", "meshSurface", "meshEmissive", "lightTable"]);
  });

  it("says that primitive instances, points and beams are not lit by these lights yet, rather than drawing them dark", () => {
    const plan = compile(
      lampsScene({
        nodes: [{ id: "geometry_boxes", type: "geometry", parameters: { mode: "instances", shape: "box" } }],
        edges: [["kernel_lamps", "geometry_boxes", "points"]],
        scenes: "geometry_floor geometry_boxes",
      }),
    );
    const warning = plan.diagnostics.find((entry) => entry.code === "node.scene.lightDraw");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('geometry "geometry_boxes" is drawn as primitive instances');
    // The floor, a Surface, is lit and is not warned about; nor is it told it has no lights.
    expect(plan.diagnostics.filter((entry) => entry.code === "node.scene.unlit")).toEqual([
      expect.objectContaining({ message: expect.stringContaining('"geometry_boxes"') }),
    ]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* What the device is asked for                                                          */
/* ------------------------------------------------------------------------------------ */

const input: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [128, 128],
};

/** One frame of a document on the mock device: the compute and render passes it was asked to begin. */
async function deviceCalls(options: LampsScene): Promise<{ computePasses: number; renderPasses: number; dispatches: number }> {
  const plan = compiled(options);
  const host = mockGpuHost({});
  const backend = createVgpuBackend({ host });
  try {
    await backend.initialize({});
    const device = host.device;
    if (device === undefined) throw new Error("the mock host has no device");
    const seen = { computePasses: 0, renderPasses: 0 };
    const createEncoder = device.createCommandEncoder.bind(device);
    vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor) => {
      const encoder = createEncoder(descriptor);
      const beginCompute = encoder.beginComputePass.bind(encoder);
      vi.spyOn(encoder, "beginComputePass").mockImplementation((passDescriptor) => {
        seen.computePasses += 1;
        return beginCompute(passDescriptor);
      });
      const beginRender = encoder.beginRenderPass.bind(encoder);
      vi.spyOn(encoder, "beginRenderPass").mockImplementation((passDescriptor) => {
        seen.renderPasses += 1;
        return beginRender(passDescriptor);
      });
      return encoder;
    });
    const program = await backend.compile(plan);
    backend.render(program, input);
    const before = { ...seen };
    backend.render(program, input);
    return {
      computePasses: seen.computePasses - before.computePasses,
      renderPasses: seen.renderPasses - before.renderPasses,
      dispatches: plan.passes.filter((entry) => entry.kind === "dispatch").length,
    };
  } finally {
    backend.dispose();
    vi.restoreAllMocks();
  }
}

describe("T1589b: what the lights cost the device in passes", () => {
  it("is three compute passes, and not one render pass more: the colour target is still one run", async () => {
    // The same floor under one Light in Single mode: the lamps' kernel is then read by nothing and is not in the plan.
    const single = await deviceCalls({ light: { mode: "single" }, unwired: true });
    const points = await deviceCalls({});
    const kernel = passesOf(compiled()).filter((entry) => entry.kind === "dispatch" && bare(entry.id).startsWith("kernel_lamps")).length;
    expect(kernel).toBeGreaterThan(0);
    // Every dispatch of the plan is a compute pass of the frame, and the Light and the Render add three.
    expect(points.computePasses).toBe(points.dispatches);
    expect(points.dispatches).toBe(single.dispatches + kernel + 3);
    expect(points.renderPasses).toBe(single.renderPasses);

    // And in the plan: the device's render passes are the runs they were under a Light in
    // Single mode, draw for draw. The backdrop's run still reaches the first lit draw: none
    // of the three dispatches stands between them (T1604b).
    const runs = (options: LampsScene): string[][] => renderPassRuns(compiled(options).passes).map((run) => run.passIds.map(bare));
    const two = "geometry_floor geometry_wall";
    expect(runs({ scenes: two })).toEqual(runs({ scenes: two, light: { mode: "single" }, unwired: true }));
    expect(runs({ scenes: two })[0]).toEqual(["render_shot:backdrop", "render_shot:scene:0"]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Values stay values                                                                    */
/* ------------------------------------------------------------------------------------ */

const frameAt = (frameIndex: number): FrameEvaluationInput => ({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 });

describe("T1589b: a driven light and a moving camera are writes, never a rebuild (§V5, T1603b)", () => {
  it("keeps a frame of driven Intensity, Range, Color and camera on the values-only path, and builds no shader text for it", () => {
    const graph = lampsScene({
      light: {
        intensity: expressionSlot("2 + sin(abstime * 3)", 2),
        range: expressionSlot("3 + abstime", 3),
        "color.r": expressionSlot("0.5 + 0.5 * sin(abstime)", 1),
      },
      camera: { ortho: false, eye: [0, 6, 9], "eye.x": expressionSlot("sin(abstime) * 4", 0) },
    });
    const channels = graphChannelResolver(compiledWithoutCatalogue(graph), registry);
    const request = { graph, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES, resolution: { channels } };
    forgetGeneratedText();
    const prepared = prepareFrameCompiler(request);
    expect(prepared.base.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);

    const uniformsOf = (plan: { readonly passes: ReadonlyArray<unknown> }, id: string) => pass(plan, id).uniforms as Record<string, number[]>;
    const first = { resolve: uniformsOf(prepared.base, "light_lamps:lights:resolve"), grid: uniformsOf(prepared.base, "render_shot:lights:grid") };
    for (const frameIndex of [1, 2, 30]) {
      const resolution = { frame: frameAt(frameIndex), channels };
      const before = generatedTextCounts();
      const spliced = prepared.compileFrame(resolution);
      const after = generatedTextCounts();
      expect(spliced, prepared.reason ?? "").not.toBeNull();
      if (spliced === null) return;
      // No generator ran and no template built: the three passes and the lit draw are remembered text.
      const ran = Object.fromEntries(
        Object.entries(after.byGenerator)
          .map(([name, counts]) => [name, counts.generated - (before.byGenerator[name]?.generated ?? 0)] as const)
          .filter(([, count]) => count !== 0),
      );
      expect([frameIndex, ran, after.built - before.built]).toEqual([frameIndex, {}, 0]);
      // They were asked, though, and answered from memory: the Light's pass, the Render's two
      // and the lit draw are each a remembered generator, and the frame re-emitted all four.
      const reused = Object.fromEntries(
        ["lightResolveWgsl", "lightGatherWgsl", "lightGridWgsl", "sceneSurfaceModule"].map((name) => [name, (after.byGenerator[name]?.reused ?? 0) - (before.byGenerator[name]?.reused ?? 0)]),
      );
      expect([frameIndex, reused]).toEqual([frameIndex, { lightResolveWgsl: 1, lightGatherWgsl: 1, lightGridWgsl: 1, sceneSurfaceModule: 1 }]);
      // The values moved: the Light's into its resolve pass, the camera's into the grid's build.
      expect(uniformsOf(spliced, "light_lamps:lights:resolve")["color"]).not.toEqual(first.resolve["color"]);
      expect(uniformsOf(spliced, "light_lamps:lights:resolve")["shape"]).not.toEqual(first.resolve["shape"]);
      expect(uniformsOf(spliced, "render_shot:lights:grid")["viewProjection"]).not.toEqual(first.grid["viewProjection"]);
      // Byte for byte what a full compile produces at this frame with nothing remembered.
      forgetGeneratedText();
      const full = compileGraph({ ...request, resolution });
      expect(spliced.passes).toEqual(full.passes);
    }
  });

  it("gives, after a structural change, the plan a compile with nothing remembered gives", () => {
    forgetGeneratedText();
    const base = passesOf(compiled()).map((entry) => `${entry.id}\u0000${String(entry.shader ?? "")}`);
    const changes: ReadonlyArray<readonly [string, LampsScene]> = [
      ["Color in Map mode", { light: { color: mapped("color", [1, 1, 1, 1]) } }],
      ["Intensity in Map mode", { light: { intensity: mapped("gain", 1) } }],
      ["Intensity on one channel of a vector", { light: { intensity: mapped("pair", 1, "y") } }],
      ["Range in Map mode", { light: { range: mapped("reach", 1) } }],
      ["Position in Map mode", { light: { position: mapped("place", [0, 0, 0]) } }],
      ["a counted pointset", { counted: true, count: 2, kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}" }],
      ["more lamps", { count: 40 }],
      ["a second Light in Points mode", { nodes: [{ id: "light_more", type: "light", parameters: { mode: "points", kind: "point" } }], edges: [["kernel_lamps", "light_more", "points"]], lights: "light_lamps light_more" }],
      ["a surface twice the size", { render: { antialias: "ssaa" } }],
    ];
    const moved: string[] = [];
    for (const [label, options] of changes) {
      const graph = lampsScene(options);
      const warm = compile(graph);
      forgetGeneratedText();
      const cold = compile(graph);
      expect(warm.diagnostics.filter((entry) => entry.severity === "error"), label).toEqual([]);
      expect(warm.passes, label).toEqual(cold.passes);
      const texts = passesOf(cold).map((entry) => `${entry.id}\u0000${String(entry.shader ?? "")}`);
      if (texts.join("\u0001") !== base.join("\u0001")) moved.push(label);
      // And back: the change did not overwrite what the base remembered.
      expect(passesOf(compile(lampsScene())).map((entry) => `${entry.id}\u0000${String(entry.shader ?? "")}`), `${label}, then back`).toEqual(base);
    }
    // Every one of them is a different program: a memory keyed too coarsely would have handed back the base's.
    expect(moved).toEqual(changes.map(([label]) => label));
  });
});

/* ------------------------------------------------------------------------------------ */
/* Nothing else moved                                                                    */
/* ------------------------------------------------------------------------------------ */

/**
 * The plans of five shipped examples that light a Render with Lights in Single mode, as
 * `planFingerprint` reads them: every pass's id, shader text, bindings and uniform values.
 * Taken on main at `7cc69950`, BEFORE this slice touched a generator, and equal after it.
 *
 * A fingerprint here moves when the Render's program for a scene with no pointset Light
 * moves, by any hand. That is this slice's promise (§V309: absent, the text is unchanged),
 * and it is also a tripwire for everything else in the lit path: a change that is meant to
 * move one re-takes it on purpose, and says so.
 */
const UNTOUCHED: ReadonlyArray<readonly [example: string, fingerprint: string]> = [
  ["E13-Prism", "359501820ee04eb2"],
  ["E33-Obol", "3bbe8f637a87f0ca"],
  ["E28-Sundial", "ead2f43368e32c56"],
  ["E69-Burnish", "9277401191f84901"],
  ["E79-Crucible", "e81ee4bea6dbf553"],
];

function examplePlan(name: string) {
  const text = readFileSync(new URL(`../../../examples/${name}.loom.json`, import.meta.url), "utf8");
  const system = createComponentSystem(registry);
  const loaded = loadProject(text, { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`${name} does not load`);
  for (const definition of loaded.components) system.components.register(definition);
  const components = system.components.view();
  const flattened = flattenComponents({ graph: loaded.document.graph, registry: system.nodes, components });
  const channels = graphChannelResolver(flattened.graph, system.nodes);
  return compileGraph({ graph: loaded.document.graph, settings: loaded.document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components, flattened, resolution: { channels } });
}

describe("T1589b: a Render with no Light in Points mode is the Render it was (§V309)", () => {
  for (const [name, fingerprint] of UNTOUCHED) {
    it(`${name}: every pass, its shader text, its bindings and its uniforms are what they were before this slice`, () => {
      const plan = examplePlan(name);
      expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
      // The example does light a Render from Light nodes: the claim is about a path that runs.
      expect(passesOf(plan).some((entry) => /:scene:\d+$/.test(entry.id) && String(entry.shader).includes("light0Meta"))).toBe(true);
      expect(planFingerprint(plan)).toBe(fingerprint);
      // And nothing of the table is in it.
      expect(passesOf(plan).filter((entry) => entry.id.includes(":lights:") || String(entry.shader ?? "").includes("lightTable"))).toEqual([]);
    });
  }

  it("the lamps' attributes are what the fixture says they are", () => {
    // The refusals above list them; a fixture that changed would make those sentences stale.
    expect(LAMP_ATTRIBUTES.map((attribute) => attribute.name).sort()).toEqual(["color", "gain", "pair", "place", "position", "reach"]);
  });
});
