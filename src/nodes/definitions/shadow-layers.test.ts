import { describe, expect, it, vi } from "vitest";

import { compileGraph, isUniformOnlyChange } from "../../compiler/index.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { estimateResourceBytes, renderPassRuns, resourceStructureKey } from "../../runtime/backend/plan.ts";
import { countBuildsAndWrites } from "../../runtime/backend/vgpu/device-calls.test-support.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { sceneInstancesWgsl, sceneSurfaceWgsl } from "../shaders/scene-render.wgsl.ts";
import { allNodeDefinitions } from "./index.ts";
import { shadowLayerStep, shadowLayers } from "./scene.ts";
import { castingLamp, castingSun, shadowLayersScene } from "./shadow-layers.fixture.ts";

/**
 * T1623b, slice 4 — A RENDER'S SHADOW MAPS ARE LAYERS, at the plan (no GPU).
 *
 * Before this slice every casting light had a shadow target of its own, with a depth buffer
 * of its own. Now a Render has two layered targets, one for its directional lights' maps
 * and one for its point lights' cube atlases, a layer a light and one depth buffer a kind;
 * a sweep draws into its light's layer. What the pictures are is
 * `vgpu/shadow-layers.gpu.test.ts`'s, on Dawn. Here: which layer is whose, what a draw
 * binds, how the layers are allocated, and what carried over (the runs of draws, the matte,
 * the other generator, the bound on casting lights).
 *
 * WHAT A LIT DRAW BINDS DID NOT CHANGE IN KIND: a texture a casting light, `shadowMap{s}`,
 * a plain `texture_2d`. It is a VIEW of that light's one layer. The lit text is therefore
 * the text it was, and that is the point: one `texture_2d_array` binding for all of them
 * was built first and measured, and reading it costs the lit draw 73 to 85 % more at four
 * and eight casting lights (docs/light-cost-investigation-2026-10-06.md, section 15).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const settingsAt = (width: number, height: number) =>
  ({
    outputResolution: { width, height },
    workingFormat: "rgba16float",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 20,
    limits: { maxResolution: 8192, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
  }) as never;
const compile = (graph: GraphDocument, size: readonly [number, number] = [64, 64]) => compileGraph({ graph, settings: settingsAt(size[0], size[1]), registry, capabilities: TIER_B_CAPABILITIES });
const compiled = (lights: ReadonlyArray<Record<string, unknown>>, render: Record<string, unknown> = {}, size: readonly [number, number] = [64, 64]) => {
  const plan = compile(shadowLayersScene(lights, render), size);
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
};
type AnyPass = { readonly id: string; readonly kind: string; readonly target?: string; readonly layer?: number; readonly shader?: string; readonly clear?: boolean; readonly textures?: ReadonlyArray<Record<string, unknown>> };
const passesOf = (plan: { readonly passes: ReadonlyArray<unknown> }): ReadonlyArray<AnyPass> => plan.passes as unknown as ReadonlyArray<AnyPass>;
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);
const layered = (plan: { readonly resources: ReadonlyArray<unknown> }) =>
  (plan.resources as unknown as Array<Record<string, unknown>>).filter((resource) => resource["kind"] === "layers").map((resource) => ({ id: resource["id"], size: resource["size"], layers: resource["layers"], format: resource["format"], depth: resource["depth"] }));

const SUN = castingSun([1, -1, 0], 1);
const LAMP = castingLamp([-2, 3, 0], 4);
/** `count` casting lights, their kinds taken in turn from `mix`. */
const lightsOf = (count: number, mix: ReadonlyArray<Record<string, unknown>>) => Array.from({ length: count }, (_, index) => mix[index % mix.length] as Record<string, unknown>);

describe("T1623b slice 4: a casting light's map is a layer of one of two layered targets", () => {
  it("gives a slot its layer by its place among the slots of its own kind", () => {
    // Slots 0 to 4: a sun, a lamp, a lamp, a sun, a lamp.
    expect(shadowLayers(5, [1, 2, 4])).toEqual({ layerOf: [0, 0, 1, 1, 2], directional: 2, point: 3 });
    expect(shadowLayers(0)).toEqual({ layerOf: [], directional: 0, point: 0 });
    expect(shadowLayers(3)).toEqual({ layerOf: [0, 1, 2], directional: 3, point: 0 });
  });

  it("declares the two arrays, each with a layer a light of its kind at that kind's size, and no target a light", () => {
    // In list order: a sun, a lamp, a lamp, a sun, a lamp. 64 x 64 out: maps at twice, cubes at one and a half times.
    const plan = compiled([SUN, LAMP, LAMP, SUN, LAMP]);
    expect(layered(plan)).toEqual([
      { id: "scratch:render_shot:shadowMaps", size: [128, 128], layers: 2, format: "r32float", depth: true },
      { id: "scratch:render_shot:shadowCubes", size: [96, 96], layers: 4, format: "r32float", depth: true },
    ]);
    expect((plan.resources as unknown as Array<{ id: string }>).filter((resource) => /:shadow\d+$/.test(resource.id))).toEqual([]);
    // One kind alone declares one array.
    expect(layered(compiled([SUN, SUN])).map((entry) => entry.id)).toEqual(["scratch:render_shot:shadowMaps"]);
    expect(layered(compiled([LAMP])).map((entry) => entry.id)).toEqual(["scratch:render_shot:shadowCubes"]);
    // A layer more than the lights need is a step's spare (three lamps, four layers): no sweep draws into it.
    // And a Render with no casting light declares none, and binds none.
    const dark = compiled([{ ...SUN, shadows: false }]);
    expect(layered(dark)).toEqual([]);
    expect(passesOf(dark).flatMap((pass) => pass.textures ?? []).filter((texture) => String(texture["binding"]).startsWith("shadow"))).toEqual([]);
  });

  it("draws each light's sweep into its own layer, every pass of it, named for the light as before", () => {
    const plan = compiled([SUN, LAMP, LAMP, SUN, LAMP]);
    const sweeps = passesOf(plan).filter((pass) => /:shadow:\d+:/.test(pass.id));
    // By the light's place in the list: where its passes go.
    const where = new Map<string, Set<string>>();
    for (const pass of sweeps) {
      const light = /:shadow:(\d+):/.exec(pass.id)?.[1] ?? "?";
      where.set(light, (where.get(light) ?? new Set()).add(`${String(pass.target).replace("scratch:render_shot:", "")}@${String(pass.layer)}`));
    }
    expect([...where].map(([light, targets]) => [light, [...targets]])).toEqual([
      ["0", ["shadowMaps@0"]],
      ["1", ["shadowCubes@0"]],
      ["2", ["shadowCubes@1"]],
      ["3", ["shadowMaps@1"]],
      ["4", ["shadowCubes@2"]],
    ]);
    // A sun's sweep is its clear and a draw a caster; a lamp's is one clear and six faces of a draw a caster.
    const count = (light: number): number => sweeps.filter((pass) => pass.id.includes(`:shadow:${light}:`)).length;
    expect([count(0), count(1)]).toEqual([1 + 2, 1 + 6 * 2]);
    // No other draw of the Render names a layer.
    expect(passesOf(plan).filter((pass) => pass.layer !== undefined && !/:shadow:\d+:/.test(pass.id))).toEqual([]);
  });

  it("binds a lit draw a texture a casting light, as it always did, and that texture is the light's own layer", () => {
    const shadowsOf = (plan: ReturnType<typeof compiled>, id: string) => (passesOf(plan).find((pass) => bare(pass.id) === id)?.textures ?? []).filter((texture) => String(texture["binding"]).startsWith("shadow"));
    // In list order: a sun, a lamp, a lamp, a sun, a lamp. A slot's binding is its slot's; its layer is its place in its kind.
    const five = [
      { binding: "shadowMap0", resourceId: "scratch:render_shot:shadowMaps", sampled: "unfiltered", layer: 0 },
      { binding: "shadowMap1", resourceId: "scratch:render_shot:shadowCubes", sampled: "unfiltered", layer: 0 },
      { binding: "shadowMap2", resourceId: "scratch:render_shot:shadowCubes", sampled: "unfiltered", layer: 1 },
      { binding: "shadowMap3", resourceId: "scratch:render_shot:shadowMaps", sampled: "unfiltered", layer: 1 },
      { binding: "shadowMap4", resourceId: "scratch:render_shot:shadowCubes", sampled: "unfiltered", layer: 2 },
    ];
    const plan = compiled([SUN, LAMP, LAMP, SUN, LAMP]);
    expect(shadowsOf(plan, "render_shot:scene:0")).toEqual(five);
    expect(shadowsOf(plan, "render_shot:scene:1")).toEqual(five);
    // No draw binds an array whole: that binding is what costs (the docblock above).
    expect(passesOf(plan).flatMap((pass) => pass.textures ?? []).filter((texture) => texture["array"] === true)).toEqual([]);
    // The shadow matte (T1414b) reads the same layers. Its port is compiled when something reads it.
    const matte = compileGraph({
      graph: shadowLayersScene([SUN, LAMP], { shadowOutput: true }),
      settings: settingsAt(64, 64),
      registry,
      capabilities: TIER_B_CAPABILITIES,
      sinks: [{ nodeId: "render_shot", portId: "shadow", kind: "preview" }],
    } as never);
    expect(matte.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(shadowsOf(matte, "render_shot:gbuffer:shadow:0")).toEqual(five.slice(0, 2));
  });

  it("is still bounded by the sixteen sampled textures a stage may bind, a texture a casting light: sixteen compile, seventeen are refused by the compiler's name", () => {
    const errorsOf = (count: number) => compile(shadowLayersScene(lightsOf(count, [SUN, LAMP]))).diagnostics.filter((entry) => entry.severity === "error");
    expect(errorsOf(16)).toEqual([]);
    expect([...new Set(errorsOf(17).map((entry) => entry.code))]).toEqual(["compiler/binding-budget"]);
    // Sixteen of one kind are sixteen layers of one array: the layers were never what bounds them.
    expect(layered(compiled(lightsOf(16, [SUN]))).map((resource) => resource.layers)).toEqual([16]);
  });

  it("leaves the lit text knowing nothing of layers, in both generators and in the matte's: a plain texture a slot, read as it was", () => {
    // Three slots: a sun, a lamp, a sun.
    const options = { lightCount: 3, shadows: [0, 1, 2], pointShadows: [1] };
    for (const text of [
      String(sceneSurfaceWgsl({ model: "pbr", ...options })),
      String(sceneInstancesWgsl({ model: "pbr", ...options })),
      String(sceneSurfaceWgsl({ model: "pbr", ...options, gbuffer: "shadow" })),
    ]) {
      expect(text.match(/var shadow\w+: texture_2d<f32>;/g)).toEqual(["var shadowMap0: texture_2d<f32>;", "var shadowMap1: texture_2d<f32>;", "var shadowMap2: texture_2d<f32>;"]);
      expect(text).not.toContain("texture_2d_array");
      // Every read of a map is a read of level 0 of a 2D texture: two arguments after the texture, not three.
      const loads = text.match(/textureLoad\(shadowMap\d, [^;]*\)\.r/g) ?? [];
      expect(loads.length).toBe(3);
      for (const load of loads) expect(load).toMatch(/\), 0\)\.r$/);
    }
  });

  it("keeps a light's sweep the runs of draws it was: one device pass a directional map, one a cube atlas of six faces", () => {
    const plan = compiled([SUN, LAMP, LAMP]);
    const runs = renderPassRuns(plan.passes, plan.resources).filter((run) => run.target.includes(":shadow"));
    expect(runs.map((run) => [run.target.replace("scratch:render_shot:", ""), run.layer, run.passIds.length])).toEqual([
      ["shadowMaps", 0, 3],
      // Six faces, a draw a caster a face, behind one clear: one run, as it was when the atlas was a target of its own.
      ["shadowCubes", 0, 13],
      ["shadowCubes", 1, 13],
    ]);
    // Each run opens with the pass that clears: the layers of an array share one depth buffer.
    const byId = new Map(passesOf(plan).map((pass) => [pass.id, pass]));
    expect(runs.map((run) => [byId.get(run.passIds[0] as string)?.clear, run.passIds.slice(1).some((id) => byId.get(id)?.clear !== false)])).toEqual([
      [true, false],
      [true, false],
      [true, false],
    ]);
  });
});

describe("T1623b slice 4: the layers are allocated in steps, and an array is never more memory than the lights' own targets were", () => {
  it("steps 1, 2, 4, 8, then by eights", () => {
    expect([0, 1, 2, 3, 4, 5, 8, 9, 16, 17, 24, 25].map(shadowLayerStep)).toEqual([0, 1, 2, 4, 4, 8, 8, 16, 16, 24, 24, 32]);
  });

  it("rebuilds an array only when a step is passed: a third and a fourth casting sun are the same texture, a fifth is another", () => {
    const mapsOf = (count: number) => (compiled(lightsOf(count, [SUN])).resources as unknown as Array<{ kind: string; id: string }>).find((resource) => resource.id.endsWith(":shadowMaps"));
    const key = (count: number): string => resourceStructureKey(mapsOf(count) as never);
    expect(key(3)).toBe(key(4));
    expect(key(4)).not.toBe(key(5));
    expect(key(5)).toBe(key(8));
    // A sun more does not touch the cubes' array, and a lamp more does not touch the maps'.
    const cubesKey = (lights: ReadonlyArray<Record<string, unknown>>): string =>
      resourceStructureKey((compiled(lights).resources as unknown as Array<{ id: string }>).find((resource) => resource.id.endsWith(":shadowCubes")) as never);
    expect(cubesKey([LAMP, SUN])).toBe(cubesKey([LAMP, SUN, SUN, SUN]));
  });

  it("is a write and nothing built when a casting light moves, and a rebuild when one is added: said, not hidden", async () => {
    // A casting light is still a block and a binding of the lit text, so a casting light more IS another lit text (slice 5).
    expect(isUniformOnlyChange(compiled([SUN, LAMP]), compiled([castingSun([0, -1, 1], 0.5), castingLamp([3, 2, 1], 2)]))).toBe(true);
    expect(isUniformOnlyChange(compiled([SUN, LAMP]), compiled([SUN, LAMP, LAMP]))).toBe(false);
    const host = mockGpuHost({});
    const backend = createVgpuBackend({ host });
    const input: FrameInputs = { frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] };
    try {
      await backend.initialize({});
      backend.render(await backend.compile(compiled([SUN, LAMP])), input);
      const asked = countBuildsAndWrites(host);
      backend.render(await backend.compile(compiled([castingSun([0, -1, 1], 0.5), castingLamp([3, 2, 1], 2)])), input);
      expect([asked.modules, asked.pipelines]).toEqual([0, 0]);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });

  it("costs four bytes a texel a layer and ONE depth buffer a kind, which with a step's spare layers is never more than a target and a depth buffer a light", () => {
    // What the plan's own estimate says of a Render's shadow resources, at 1920 x 1080.
    const bytesOf = (lights: ReadonlyArray<Record<string, unknown>>): number =>
      estimateResourceBytes((compiled(lights, {}, [1920, 1080]).resources as unknown as Array<{ id: string }>).filter((resource) => /:shadow(Maps|Cubes)$/.test(resource.id)) as never);
    const map = 3840 * 2160 * 4;
    const cube = 2880 * 1620 * 4;
    // Three suns: a step of four layers and their one depth buffer. Two lamps: two layers and theirs.
    expect(bytesOf([SUN, SUN, SUN])).toBe(5 * map);
    expect(bytesOf([LAMP, LAMP])).toBe(3 * cube);
    expect(bytesOf([SUN, SUN, SUN, LAMP, LAMP])).toBe(5 * map + 3 * cube);
    // Before the slice each light held a colour target and a depth buffer of its own: 2n of them.
    for (const count of [1, 2, 3, 4, 5, 8, 9, 16]) expect([count, shadowLayerStep(count) + 1 <= 2 * count]).toEqual([count, true]);
  });
});
