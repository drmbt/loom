import { describe, expect, it, vi } from "vitest";

import { classifyRevision } from "../../app/classify-revision.ts";
import { compileGraph, isUniformOnlyChange } from "../../compiler/index.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { countBuildsAndWrites } from "../../runtime/backend/vgpu/device-calls.test-support.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { lightNode } from "./scene.ts";
import { castingLamp, castingSun, shadowLayersScene } from "./shadow-layers.fixture.ts";

/**
 * T1688b — A CASTING LIGHT'S SHADOW IS SWITCHED BY A VALUE, at the plan (no GPU).
 *
 * Cast Shadows is structure: it gives a light its shadow map, its sweeps and its block of
 * the lit text, and changing it rebuilds the Render. Shadow On, beside it, is a value: off,
 * every draw of that light's sweeps is skipped this frame, by the mechanism a caster out of a
 * light's reach already had (T1598b), and each sweep's far plate still clears, so the map
 * says "nothing here" and not what it held when the shadow went out.
 *
 * Here: which draws carry `skip` and which do not; that the plan with the shadow out is the
 * plan with it on in everything but those flags (the same passes, texts, bindings and
 * resources, §V1029); that the device is asked to build nothing; and that the document
 * revision that turns it is a values-only one. What the picture is, and that the map is not
 * stale the frame the shadow comes back, is `vgpu/shadow-switch.gpu.test.ts`'s, on Dawn.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const settings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 20,
  limits: { maxResolution: 8192, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;
const compile = (graph: GraphDocument, more: Record<string, unknown> = {}) => {
  const plan = compileGraph({ graph, settings, registry, capabilities: TIER_B_CAPABILITIES, ...more } as never);
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
};
type AnyPass = { readonly id: string; readonly kind: string; readonly skip?: boolean; readonly shader?: string; readonly target?: string; readonly layer?: number; readonly textures?: unknown; readonly clear?: boolean };
const passesOf = (plan: { readonly passes: ReadonlyArray<unknown> }): AnyPass[] => plan.passes as unknown as AnyPass[];
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);
/** A light's sweep draws: `[id, skipped]`, the far plate (`:clear`) among them. */
const sweepOf = (plan: { readonly passes: ReadonlyArray<unknown> }, light: number, prefix = "shadow"): Array<[string, boolean]> =>
  passesOf(plan)
    .filter((pass) => pass.kind === "draw" && bare(pass.id).startsWith(`render_shot:${prefix}:${light}:`))
    .map((pass) => [bare(pass.id).replace(`render_shot:${prefix}:${light}:`, ""), pass.skip === true]);

const SUN = castingSun([1, -1, 0], 1);
const LAMP = castingLamp([-2, 3, 0], 4);
const OUT = { shadowOn: false };

describe("T1688b: Shadow On off skips every caster's draw of that light's sweeps, and nothing else", () => {
  it("a sun: its far plate still clears, its two casters' draws are skipped, and with the shadow on none is", () => {
    expect(sweepOf(compile(shadowLayersScene([SUN])), 0)).toEqual([["clear", false], ["0", false], ["1", false]]);
    expect(sweepOf(compile(shadowLayersScene([{ ...SUN, ...OUT }])), 0)).toEqual([["clear", false], ["0", true], ["1", true]]);
  });

  it("a point light: one far plate, and every draw of all six faces skipped (the faces a caster is in, and the ones reach already skipped)", () => {
    const out = sweepOf(compile(shadowLayersScene([{ ...LAMP, ...OUT }])), 0);
    expect(out.filter(([id]) => id.endsWith("clear"))).toEqual([["face0:clear", false]]);
    const casters = out.filter(([id]) => !id.endsWith("clear"));
    expect(casters).toHaveLength(12);
    expect(casters.filter(([, skipped]) => !skipped)).toEqual([]);
    // With the shadow on some of those twelve are drawn: the test above is not vacuous.
    expect(sweepOf(compile(shadowLayersScene([LAMP])), 0).filter(([id, skipped]) => !id.endsWith("clear") && !skipped).length).toBeGreaterThan(0);
  });

  it("is that light's alone: the light beside it keeps its sweep, in either order", () => {
    for (const lights of [[{ ...SUN, ...OUT }, LAMP], [LAMP, { ...SUN, ...OUT }]]) {
      const plan = compile(shadowLayersScene(lights));
      const sun = lights.indexOf(lights.find((light) => light["kind"] === "directional") as never);
      expect(sweepOf(plan, sun).filter(([id, skipped]) => !id.endsWith("clear") && !skipped)).toEqual([]);
      expect(sweepOf(plan, 1 - sun).filter(([id, skipped]) => !id.endsWith("clear") && !skipped).length).toBeGreaterThan(0);
    }
  });

  it("puts the Light Depth output out with it: that output is the first casting light's shadow map as data", () => {
    const graphOf = (light: Record<string, unknown>) => shadowLayersScene([light], { lightDepthOutput: true });
    const sink = { sinks: [{ nodeId: "render_shot", portId: "lightDepth", kind: "preview" }] };
    const depthOf = (light: Record<string, unknown>): Array<[string, boolean]> =>
      passesOf(compile(graphOf(light), sink))
        .filter((pass) => pass.kind === "draw" && bare(pass.id).startsWith("render_shot:lightDepth"))
        .map((pass) => [bare(pass.id).replace("render_shot:", ""), pass.skip === true]);
    expect(depthOf(SUN)).toEqual([["lightDepth:clear", false], ["lightDepth:0", false], ["lightDepth:1", false]]);
    expect(depthOf({ ...SUN, ...OUT })).toEqual([["lightDepth:clear", false], ["lightDepth:0", true], ["lightDepth:1", true]]);
  });
});

describe("T1688b: the plan with the shadow out is the plan with it on, but for the flags (§V1029)", () => {
  const on = compile(shadowLayersScene([SUN, LAMP]));
  const out = compile(shadowLayersScene([{ ...SUN, ...OUT }, { ...LAMP, ...OUT }]));

  it("the same passes in the same order, each with the same text, target, layer and bindings; the same resources", () => {
    const shape = (plan: typeof on) => passesOf(plan).map((pass) => [pass.id, pass.kind, pass.shader, pass.target, pass.layer, pass.clear, JSON.stringify(pass.textures)]);
    expect(shape(out)).toEqual(shape(on));
    expect(out.resources).toEqual(on.resources);
    // And the flags are what differs: this is not two equal plans.
    expect(passesOf(out).filter((pass) => pass.skip === true).length).toBeGreaterThan(passesOf(on).filter((pass) => pass.skip === true).length);
  });

  it("is a values-only change both ways, and Cast Shadows is not", () => {
    expect(isUniformOnlyChange(on, out)).toBe(true);
    expect(isUniformOnlyChange(out, on)).toBe(true);
    expect(isUniformOnlyChange(on, compile(shadowLayersScene([{ ...SUN, shadows: false }, LAMP])))).toBe(false);
  });

  it("asks the device for no shader module and no pipeline, going out and coming back", async () => {
    const host = mockGpuHost({});
    const backend = createVgpuBackend({ host });
    const input: FrameInputs = { frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] };
    try {
      await backend.initialize({});
      backend.render(await backend.compile(on), input);
      const asked = countBuildsAndWrites(host);
      backend.render(await backend.compile(out), input);
      backend.render(await backend.compile(on), input);
      expect([asked.modules, asked.pipelines]).toEqual([0, 0]);
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });
});

describe("T1688b: Shadow On is a value of the Light, and the revision that turns it is values-only", () => {
  it("is not compile-time, defaults to on, and is live only on a Light in Single mode that casts", () => {
    const parameter = lightNode.parameters["shadowOn"];
    expect(parameter).toMatchObject({ type: "boolean", default: true });
    expect((parameter as { compileTime?: boolean }).compileTime).toBeUndefined();
    expect(lightNode.parameters["shadows"]).toMatchObject({ compileTime: true });
    const inactive = (values: Record<string, unknown>) => (parameter as { inactiveWhen: (values: Record<string, unknown>) => string | null }).inactiveWhen(values);
    expect(inactive({ mode: "single", shadows: true })).toBeNull();
    expect(inactive({ mode: "single", shadows: false })).toBe("Only a casting light has a shadow to switch.");
    expect(inactive({ mode: "points", shadows: true })).toContain("Single mode");
  });

  it("a document revision that moves it, and nothing else, is values-only; one that moves Cast Shadows is structure", () => {
    // Both keys are stored in the document already: a key stored for the first time is structure by its own rule.
    const base = shadowLayersScene([{ ...SUN, shadowOn: true }]);
    const withLight = (parameters: Record<string, unknown>): GraphDocument => {
      const light = (base.nodes as Record<string, { parameters: Record<string, unknown> }>)["light_c0"]!;
      return { ...base, revision: 2, nodes: { ...base.nodes, light_c0: { ...light, parameters: { ...light.parameters, ...parameters } } } } as never;
    };
    expect(classifyRevision(base, withLight({ shadowOn: false }), registry)).toEqual({ kind: "values", written: ["light_c0"] });
    const structure = classifyRevision(base, withLight({ shadows: false }), registry);
    expect(structure.kind).toBe("structure");
  });
});
