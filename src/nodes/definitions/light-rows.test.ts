import { describe, expect, it, vi } from "vitest";

import { compileGraph, compiledWithoutCatalogue, isUniformOnlyChange } from "../../compiler/index.ts";
import { prepareFrameCompiler } from "../../compiler/frame-compile.ts";
import { graphChannelResolver } from "../../domain/channels/graph-channels.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { LightPayload } from "../../domain/types/scene.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { countBuildsAndWrites } from "../../runtime/backend/vgpu/device-calls.test-support.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { forgetGeneratedText, generatedTextCounts } from "../../runtime/backend/wgsl.ts";
import { LIGHT_NO_CONE, LIGHT_ROWS_A_TURN, LIGHT_TABLE_HEADER, LIGHT_TABLE_HEADER_WORDS } from "../shaders/scene-lights.wgsl.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { LIGHT_EVERYWHERE_ABOVE, namedLightRecord } from "./light-points.ts";
import { lampsScene, namedLights, type LampsScene } from "./light-points.fixture.ts";
import { MAX_LIGHT_SLOTS, NAMED_LIGHT_STEP, namedLightCapacity } from "./light-records.ts";

/**
 * T1623b, slice 3 — A LIGHT IN SINGLE MODE THAT DOES NOT CAST IS A ROW, at the plan (no GPU).
 *
 * Before this slice a Render unrolled a block of its lit shader for every Light in Single
 * mode: the text grew with the count, and adding a Light compiled a pipeline. Now such a
 * Light is one row of the Render's light table, written as values, and the lit text is one
 * string whatever the Render lists. What the pictures are is `light-rows.gpu.test.ts`'s
 * claim, on Dawn. Here:
 *
 *  - the PROPERTY: one lit text at 0, 1, 8 and 64 Lights of any mix of kinds, and on a device
 *    no shader module and no pipeline for a Light added, removed, re-ordered or re-typed;
 *  - what a row holds for each kind, and that it is what a Light in Points mode resolves;
 *  - the ORDER of the rows: by the walk each is for, and within one in the Render's list order;
 *  - that every Render with a lit Surface has a table, lights or none, and one with none has none;
 *  - what is said: more rows that reach every pixel than is cheap, a spot where no cone is read.
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

type Parameters = Record<string, unknown>;
type AnyPass = {
  readonly id: string;
  readonly kind: string;
  readonly shader?: string;
  readonly buffers?: ReadonlyArray<{ readonly binding: string; readonly resourceId: string }>;
  readonly uniforms?: Readonly<Record<string, unknown>>;
  readonly values?: { readonly rows: number[]; readonly count: number };
  readonly capacity?: number;
};

const named = namedLights;
const compile = (graph: GraphDocument) => compileGraph({ graph, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
const compiled = (options: LampsScene) => {
  const plan = compile(lampsScene(options));
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
};
const passesOf = (plan: { readonly passes: ReadonlyArray<unknown> }): ReadonlyArray<AnyPass> => plan.passes as unknown as ReadonlyArray<AnyPass>;
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);
const pass = (plan: { readonly passes: ReadonlyArray<unknown> }, id: string): AnyPass => {
  const found = passesOf(plan).find((entry) => bare(entry.id) === id);
  if (found === undefined) throw new Error(`the plan has no pass "${id}"; it has ${passesOf(plan).map((entry) => bare(entry.id)).join(", ")}`);
  return found;
};
const litText = (plan: { readonly passes: ReadonlyArray<unknown> }): string => String(pass(plan, "render_shot:scene:0").shader);
const headerOf = (plan: { readonly passes: ReadonlyArray<unknown> }): number[] => pass(plan, "render_shot:lights:header").values?.rows ?? [];
/** The named rows as written: sixteen floats each. */
const rowsOf = (plan: { readonly passes: ReadonlyArray<unknown> }): number[][] => {
  const values = pass(plan, "render_shot:lights:named").values;
  return Array.from({ length: values?.count ?? 0 }, (_, row) => (values?.rows ?? []).slice(row * 16, row * 16 + 16));
};
/** The Light a row came from: the last float of its record. */
const numbersOf = (plan: { readonly passes: ReadonlyArray<unknown> }): number[] => rowsOf(plan).map((row) => row[15] as number);

const SUN: Parameters = { kind: "directional", direction: [0, -2, 0], intensity: 1.5, color: [1, 0.5, 0.25, 1] };
const POINT: Parameters = { kind: "point", position: [1, 2, 3], intensity: 2, falloff: "inverseSquare" };
const RANGED: Parameters = { ...POINT, range: 4 };
const SPOT: Parameters = { kind: "spot", position: [1, 2, 3], direction: [0, -1, 0], cone: 60, coneSoftness: 0.4, intensity: 2 };
/** `count` Lights, their kinds taken in turn from `mix`. */
const mixOf = (count: number, mix: ReadonlyArray<Parameters>): Parameters[] => Array.from({ length: count }, (_, index) => ({ ...mix[index % mix.length], position: [index % 7, 2, index % 5] }));

/* ------------------------------------------------------------------------------------ */
/* The property                                                                          */
/* ------------------------------------------------------------------------------------ */

describe("T1623b: the lit text does not know how many Lights a Render lists, nor of what kind", () => {
  it("is ONE string at 0, 1, 8 and 64 Lights that do not cast, of any mix of kinds, beside a pointset's or not", () => {
    const scenes: ReadonlyArray<readonly [string, LampsScene]> = [
      ["no light at all", named([])],
      ["one sun", named([SUN])],
      ["one point light", named([POINT])],
      ["one spot", named([SPOT])],
      ["one point light with a Range", named([RANGED])],
      ["eight suns", named(mixOf(8, [SUN]))],
      ["eight of every kind", named(mixOf(8, [SUN, POINT, SPOT, RANGED]))],
      ["sixty-four point lights", named(mixOf(64, [POINT]))],
      ["sixty-four of every kind", named(mixOf(64, [SPOT, RANGED, SUN, POINT, { ...POINT, intensity: 0 }]))],
      ["eight beside a Light in Points mode", { ...named(mixOf(8, [SUN, POINT])), unwired: false, lights: `light_lamps ${Array.from({ length: 8 }, (_, index) => `light_n${index}`).join(" ")}` }],
    ];
    const texts = scenes.map(([label, scene]) => [label, litText(compiled(scene))] as const);
    const first = texts[0]?.[1] ?? "";
    expect(first).toContain("lightTable");
    expect(texts.filter(([, text]) => text !== first).map(([label]) => label)).toEqual([]);
    // Not one block: the Surface generator unrolls one for a casting Light alone.
    expect(first).not.toMatch(/light\d+Meta/);
    // And the table's own passes are one text each too, whatever they are handed.
    for (const id of ["render_shot:lights:gather:0", "render_shot:lights:grid"]) {
      expect([id, new Set(scenes.map(([, scene]) => String(pass(compiled(scene), id).shader))).size]).toEqual([id, 1]);
    }
  });

  it("keeps the whole plan's STRUCTURE the same inside a step of the named rows: a Light more or fewer, another order, another Type are values", () => {
    const base = compiled(named(mixOf(4, [SUN, POINT])));
    const others: ReadonlyArray<readonly [string, LampsScene]> = [
      ["one more", named(mixOf(5, [SUN, POINT]))],
      ["a step's worth", named(mixOf(NAMED_LIGHT_STEP, [SUN, POINT]))],
      ["none", named([])],
      ["another order", { ...named(mixOf(4, [SUN, POINT])), lights: "light_n3 light_n1 light_n2 light_n0" }],
      ["other Types", named(mixOf(4, [SPOT, RANGED]))],
    ];
    for (const [label, scene] of others) expect([label, isUniformOnlyChange(base, compiled(scene))]).toEqual([label, true]);
    // The step is the structure: one Light past it is a larger buffer, and says so here.
    expect(isUniformOnlyChange(base, compiled(named(mixOf(NAMED_LIGHT_STEP + 1, [SUN, POINT]))))).toBe(false);
    expect([0, 1, NAMED_LIGHT_STEP, NAMED_LIGHT_STEP + 1, 3 * NAMED_LIGHT_STEP].map(namedLightCapacity)).toEqual([32, 32, 32, 64, 96]);
  });

  it("takes two rows a turn in each loop written for a kind, and reads every bound from the table", () => {
    const text = litText(compiled(named([SUN])));
    // The measured shape (`lightTableWalkWgsl`): a loop of rows of any kind, then the point
    // lights and the suns, each stepping by LIGHT_ROWS_A_TURN with every row after the first
    // of a turn under a test of the loop's own bound.
    expect(LIGHT_ROWS_A_TURN).toBe(2);
    expect(text.match(/for \(var lightBase = [^;]+; lightBase < [^;]+; lightBase \+= 2u\)/g)).toEqual([
      "for (var lightBase = lightParts.y; lightBase < lightParts.z; lightBase += 2u)",
      "for (var lightBase = lightParts.z; lightBase < lightHeader.w; lightBase += 2u)",
    ]);
    expect(text.match(/if \(lightBase \+ 1u < [^)]+\) \{/g)).toEqual(["if (lightBase + 1u < lightParts.z) {", "if (lightBase + 1u < lightHeader.w) {"]);
    expect(text).toContain("for (var lightRow = 0u; lightRow < lightParts.y; lightRow++) {");
    // No loop of the walk is bounded by a literal: a count in the text is a text per count.
    const walk = text.slice(text.indexOf("let lightHeader = lightTable[0];"));
    expect(walk.match(/\b(for|while) \([^)]*\)/g)?.filter((loop) => /[<>]=?\s*\d/.test(loop))).toEqual([]);
  });
});

const input = (frameIndex: number): FrameInputs => ({
  frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "realtime", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [128, 128],
});

describe("T1623b: on a device, a Light is a write", () => {
  it("builds no shader module and no pipeline when a Light that does not cast is added, removed, re-ordered or changes its Type", async () => {
    const host = mockGpuHost({});
    const backend = createVgpuBackend({ host });
    try {
      await backend.initialize({});
      const three = mixOf(3, [SUN, POINT]);
      backend.render(await backend.compile(compiled(named(three))), input(0));
      const asked = countBuildsAndWrites(host);
      const steps: ReadonlyArray<readonly [string, LampsScene, number]> = [
        ["a fourth Light", named([...three, { ...POINT, position: [5, 5, 5] }]), 4],
        ["one taken out", named(three.slice(0, 2)), 2],
        ["another order", { ...named(three), lights: "light_n2 light_n0 light_n1" }, 3],
        ["a Point made a Spot, a sun made a Point", named([{ ...three[0], kind: "point" }, { ...three[1], kind: "spot", direction: [0, -1, 0] }, three[2] as Parameters]), 3],
        ["every one taken out", named([]), 0],
      ];
      const built: Array<readonly [string, number, number]> = [];
      for (const [label, scene, rows] of steps) {
        asked.writes.length = 0;
        const before = { modules: asked.modules, pipelines: asked.pipelines };
        backend.render(await backend.compile(compiled(scene)), input(1));
        built.push([label, asked.modules - before.modules, asked.pipelines - before.pipelines]);
        // And it WAS written: the table's header says how many rows are live now.
        const headers = asked.writes.filter((entry) => entry.offset === 0 && entry.words.length === LIGHT_TABLE_HEADER_WORDS).map((entry) => entry.words[LIGHT_TABLE_HEADER.rows]);
        expect([label, headers]).toEqual([label, [rows]]);
      }
      expect(built).toEqual(steps.map(([label]) => [label, 0, 0]));
    } finally {
      backend.dispose();
      vi.restoreAllMocks();
    }
  });
});

/* ------------------------------------------------------------------------------------ */
/* What a row holds                                                                      */
/* ------------------------------------------------------------------------------------ */

const lightOf = (over: Partial<LightPayload["light"]>): LightPayload["light"] => ({
  type: "point",
  color: [1, 0.5, 0.25],
  intensity: 2,
  direction: [0, -2, 0],
  position: [1, 2, 3],
  shadows: false,
  shadowExtent: 8,
  shadowSoftness: 2,
  shadowBias: 0,
  shadowCenter: [0, 0, 0],
  falloff: "inverseSquare",
  range: 0,
  ...over,
});

describe("T1623b: a named Light as one record, the sixteen floats a Light in Points mode resolves for a point", () => {
  it("writes a sun, a point light and a spot each as its kind of row, and says which walk each is for", () => {
    const sun = namedLightRecord(lightOf({ type: "directional" }), 4);
    // place (unread for a sun), range 0; colour times intensity, the law; the way it travels AS AUTHORED (its reader normalises it), no cone; kind 0, no shadow slot, its Light's number.
    expect(sun.record).toEqual([1, 2, 3, 0, 2, 1, 0.5, 1, 0, -2, 0, LIGHT_NO_CONE.outer, LIGHT_NO_CONE.inner, 0, 0, 4]);
    expect(sun.walk).toBe("suns");

    const point = namedLightRecord(lightOf({ falloff: "soft" }), 0);
    expect(point.record).toEqual([1, 2, 3, 0, 2, 1, 0.5, 0, 0, -1, 0, LIGHT_NO_CONE.outer, LIGHT_NO_CONE.inner, 1, 0, 0]);
    expect(point.walk).toBe("points");
    // A Range sends it through the grid.
    const ranged = namedLightRecord(lightOf({ range: 4 }), 0);
    expect([ranged.record[3], ranged.walk]).toEqual([4, "grid"]);

    // A spot: its axis as a UNIT vector (the cone is measured against it), the cosine of half its Cone, where its light ends, and of (1 − softness) of that, inside which it is whole.
    const spot = namedLightRecord(lightOf({ spot: { cone: 60, softness: 0.4 } }), 7);
    expect(spot.record.slice(8, 16)).toEqual([0, -1, 0, Math.cos(Math.PI / 6), Math.cos((Math.PI / 6) * 0.6), 2, 0, 7]);
    expect(spot.walk).toBe("general");
    expect(namedLightRecord(lightOf({ spot: { cone: 60, softness: 0.4 }, range: 9 }), 0).walk).toBe("grid");
    // A Cone of every direction is no cone: the row is walked as the point light it is, and stays a spot by its kind.
    const wide = namedLightRecord(lightOf({ spot: { cone: 359, softness: 0.4 } }), 0);
    expect([wide.record[11], wide.record[12], wide.record[13], wide.walk]).toEqual([LIGHT_NO_CONE.outer, LIGHT_NO_CONE.inner, 2, "points"]);
  });

  it("multiplies colour by intensity as the shader multiplied its two uniform rows: floats, and one float product", () => {
    // 0.1 and 0.7 are not floats: the product of the two doubles, rounded once, is another number than the product of the two floats.
    const row = namedLightRecord(lightOf({ color: [0.1, 0.7, 1 / 3], intensity: 1.3 }), 0).record;
    const product = (colour: number): number => Math.fround(Math.fround(colour) * Math.fround(1.3));
    expect(row.slice(4, 7)).toEqual([product(0.1), product(0.7), product(1 / 3)]);
    expect([0.1, 0.7, 1 / 3].map((colour) => Math.fround(colour * 1.3) === product(colour))).toContain(false);
  });

  it("switches a row off where the Light cannot shine: no intensity, no way to travel, no cone", () => {
    const off = (over: Partial<LightPayload["light"]>) => namedLightRecord(lightOf(over), 0);
    for (const [label, row] of [
      ["no intensity", off({ intensity: 0 })],
      ["a sun with no direction", off({ type: "directional", direction: [0, 0, 0] })],
      ["a spot with no direction", off({ spot: { cone: 60, softness: 0 }, direction: [0, 0, 0] })],
      ["a spot of no cone", off({ spot: { cone: 0, softness: 0 } })],
    ] as const) {
      // Below zero in the range's slot is OFF, for the grid's build and for every walk.
      expect([label, row.record[3], row.walk]).toEqual([label, -1, "off"]);
    }
    // The legitimate neighbours: a point light needs no direction, and a range of 0 is unlimited, not off.
    expect(off({ direction: [0, 0, 0] }).walk).toBe("points");
    expect(off({ range: 0 }).record[3]).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------ */
/* The order                                                                             */
/* ------------------------------------------------------------------------------------ */

describe("T1623b: the Render orders its rows by the walk each is for, and within one by its own list", () => {
  /* In list order: a point, a sun, a spot, a ranged point, a sun, a point, one that is off. */
  const SEVEN = [POINT, SUN, SPOT, RANGED, SUN, POINT, { ...POINT, intensity: 0 }];

  it("stands the rows of any kind first, then the point lights, then the suns, then the rest, and says in the header where each run ends", () => {
    const plan = compiled(named(SEVEN));
    // Each row's Light, by its place in the list: the spot; the two points; the two suns; the ranged one and the one that is off.
    expect(numbersOf(plan)).toEqual([2, 0, 5, 1, 4, 3, 6]);
    expect(rowsOf(plan).map((row) => row[13])).toEqual([2, 1, 1, 0, 0, 1, 1]);
    const header = headerOf(plan);
    expect(header).toHaveLength(LIGHT_TABLE_HEADER_WORDS);
    expect({
      regionRows: header[LIGHT_TABLE_HEADER.regionRows],
      words: header[LIGHT_TABLE_HEADER.words],
      cells: header[LIGHT_TABLE_HEADER.cells],
      general: header[LIGHT_TABLE_HEADER.general],
      points: header[LIGHT_TABLE_HEADER.points],
      always: header[LIGHT_TABLE_HEADER.always],
      rows: header[LIGHT_TABLE_HEADER.rows],
    }).toEqual({ regionRows: NAMED_LIGHT_STEP, words: 1, cells: LIGHT_TABLE_HEADER_WORDS + NAMED_LIGHT_STEP * 16, general: 1, points: 3, always: 5, rows: 7 });
    // One gather for the named rows: all seven, from the table's first row.
    expect(pass(plan, "render_shot:lights:gather:0").uniforms?.["source"]).toEqual([0, 7, 0, 0]);
  });

  it("keeps the list's order inside a run: it is a filter of the list, never a sort", () => {
    // Five point lights listed in an order that no sort of their names, places or values gives.
    const five = [3, 1, 4, 0, 2].map((at) => ({ ...POINT, position: [at, 2, 0], intensity: 5 - at }));
    const order = "light_n2 light_n4 light_n0 light_n3 light_n1";
    const plan = compiled({ ...named(five), lights: order });
    // A row's number is its place in the LIST, so in list order the numbers count up.
    expect(numbersOf(plan)).toEqual([0, 1, 2, 3, 4]);
    expect(rowsOf(plan).map((row) => row[0])).toEqual([4, 2, 3, 0, 1]);
    // Reversed, the rows are reversed: the order is the list's and nothing else's.
    const reversed = compiled({ ...named(five), lights: order.split(" ").reverse().join(" ") });
    expect(rowsOf(reversed).map((row) => row[0])).toEqual([1, 0, 3, 2, 4]);
  });

  it("stands a pointset's rows that reach every pixel ahead of the named ones, and its ranged rows behind them", () => {
    const beside = (range: number): LampsScene => ({ ...named([POINT, SUN, RANGED]), unwired: false, light: { range }, lights: "light_n0 light_lamps light_n1 light_n2" });
    // With no Range the set's three rows are rows of any kind that reach every pixel.
    const everywhere = compiled(beside(0));
    expect(pass(everywhere, "render_shot:lights:gather:1").uniforms?.["source"]).toEqual([0, 3, 1, 0]);
    expect(pass(everywhere, "render_shot:lights:gather:0").uniforms?.["source"]).toEqual([3, 3, 0, 0]);
    const header = headerOf(everywhere);
    expect([header[LIGHT_TABLE_HEADER.general], header[LIGHT_TABLE_HEADER.points], header[LIGHT_TABLE_HEADER.always], header[LIGHT_TABLE_HEADER.rows]]).toEqual([3, 4, 5, 6]);
    // With a Range they follow the named rows, and the header's runs are the named Lights' alone.
    const ranged = compiled(beside(3));
    expect(pass(ranged, "render_shot:lights:gather:0").uniforms?.["source"]).toEqual([0, 3, 0, 0]);
    expect(pass(ranged, "render_shot:lights:gather:1").uniforms?.["source"]).toEqual([3, 3, 1, 0]);
    const then = headerOf(ranged);
    expect([then[LIGHT_TABLE_HEADER.general], then[LIGHT_TABLE_HEADER.points], then[LIGHT_TABLE_HEADER.always], then[LIGHT_TABLE_HEADER.rows]]).toEqual([0, 1, 2, 6]);
    // A Range is a value: the two are one structure, so the move is a write.
    expect(isUniformOnlyChange(everywhere, ranged)).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Values stay values                                                                    */
/* ------------------------------------------------------------------------------------ */

const frameAt = (frameIndex: number): FrameEvaluationInput => ({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 });

describe("T1623b: a driven named Light is a write, whatever it drives (§V5)", () => {
  it("keeps a Type driven through all three kinds, with its Intensity, Color, Position and Range, on the values-only path: the rows move in the table and no text is built", () => {
    // The first Light's Type counts 0, 1, 2 with the seconds: a sun, a point light, a spot.
    const graph = lampsScene(
      named([
        { ...SPOT, kind: expressionSlot("floor(abstime)", 0), intensity: expressionSlot("2 + abstime", 2), "color.r": expressionSlot("0.5 + 0.1 * abstime", 0.5), "position.x": expressionSlot("abstime", 0) },
        { ...POINT, range: expressionSlot("floor(abstime) * 4", 0) },
        SUN,
      ]),
    );
    const channels = graphChannelResolver(compiledWithoutCatalogue(graph), registry);
    const request = { graph, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES, resolution: { channels } };
    forgetGeneratedText();
    const prepared = prepareFrameCompiler(request);
    expect(prepared.base.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);
    const seen: Array<{ second: number; numbers: number[]; kinds: number[]; runs: number[] }> = [];
    for (const second of [0, 1, 2]) {
      const resolution = { frame: frameAt(second * 60), channels };
      const before = generatedTextCounts();
      const spliced = prepared.compileFrame(resolution);
      const after = generatedTextCounts();
      expect(spliced, prepared.reason ?? "").not.toBeNull();
      if (spliced === null) return;
      expect([second, after.generated - before.generated, after.built - before.built]).toEqual([second, 0, 0]);
      const header = headerOf(spliced);
      seen.push({
        second,
        numbers: numbersOf(spliced),
        kinds: rowsOf(spliced).map((row) => row[13] as number),
        runs: [header[LIGHT_TABLE_HEADER.general] as number, header[LIGHT_TABLE_HEADER.points] as number, header[LIGHT_TABLE_HEADER.always] as number],
      });
      // Byte for byte what a full compile produces at this frame with nothing remembered.
      forgetGeneratedText();
      expect(spliced.passes).toEqual(compileGraph({ ...request, resolution }).passes);
    }
    expect(seen).toEqual([
      // Second 0: the first Light is a sun; the second a point light with no Range. Point lights, then suns in list order.
      { second: 0, numbers: [1, 0, 2], kinds: [1, 0, 0], runs: [0, 1, 3] },
      // Second 1: a point light; the second has a Range of 4 now and leaves the always-walked rows.
      { second: 1, numbers: [0, 2, 1], kinds: [1, 0, 1], runs: [0, 1, 2] },
      // Second 2: a spot with a cone and no Range is a row of any kind, ahead of the sun.
      { second: 2, numbers: [0, 2, 1], kinds: [2, 0, 1], runs: [1, 1, 2] },
    ]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Which Renders have a table                                                            */
/* ------------------------------------------------------------------------------------ */

describe("T1623b: every Render with a lit Surface has a table, lights or none", () => {
  const tablePasses = (plan: { readonly passes: ReadonlyArray<unknown> }): string[] => passesOf(plan).map((entry) => bare(entry.id)).filter((id) => id.includes(":lights:"));

  it("gives a Render that lists no Light the table's passes and the lit text of one that lists many, with nothing in its rows", () => {
    const none = compiled(named([]));
    expect(tablePasses(none)).toEqual(["render_shot:lights:header", "render_shot:lights:named", "render_shot:lights:gather:0", "render_shot:lights:grid"]);
    expect(headerOf(none)).toEqual([NAMED_LIGHT_STEP, 1, LIGHT_TABLE_HEADER_WORDS + NAMED_LIGHT_STEP * 16, 0, 0, 0, 0, 0]);
    expect(pass(none, "render_shot:lights:named").values).toEqual({ rows: [], count: 0 });
    expect(pass(none, "render_shot:scene:0").buffers?.map((buffer) => buffer.binding)).toEqual(["positions", "lightTable"]);
    // So the first Light it is given is a write.
    expect(isUniformOnlyChange(none, compiled(named([SUN])))).toBe(true);
  });

  it("gives none to a Render whose Surfaces take no light: an unlit draw binds no table and its text names none", () => {
    const unlit: LampsScene = { ...named([SUN, POINT]), nodes: [{ id: "material_flat", type: "materialUnlit", parameters: {} }], floor: { material: "material_flat" }, lights: "light_n0 light_n1" };
    const scene: LampsScene = { ...unlit, nodes: [...named([SUN, POINT]).nodes!, ...unlit.nodes!] };
    const plan = compiled(scene);
    expect(tablePasses(plan)).toEqual([]);
    const draw = pass(plan, "render_shot:scene:0");
    expect(draw.buffers?.map((buffer) => buffer.binding)).toEqual(["positions"]);
    expect(String(draw.shader)).not.toContain("lightTable");
    // Nor a row of a Light it would never read (the Surface generator unrolls a casting Light's block only).
    expect(Object.keys(draw.uniforms ?? {}).filter((key) => /^light\d/.test(key))).toEqual([]);
    // One lit Surface beside it brings the table for the Render.
    expect(tablePasses(compiled({ ...scene, scenes: "geometry_floor geometry_wall" }))).toHaveLength(4);
  });

  it(`keeps a step of ${NAMED_LIGHT_STEP} rows for the named Lights and grows by steps: thirty-three Lights are two`, () => {
    const plan = compiled(named(mixOf(NAMED_LIGHT_STEP + 1, [POINT])));
    expect(headerOf(plan)[LIGHT_TABLE_HEADER.regionRows]).toBe(2 * NAMED_LIGHT_STEP);
    expect(pass(plan, "render_shot:lights:named").capacity).toBe(2 * NAMED_LIGHT_STEP);
    expect(rowsOf(plan)).toHaveLength(NAMED_LIGHT_STEP + 1);
    // The named rows' steps are rows of the table like any other: they count against its room.
    const full = MAX_LIGHT_SLOTS - 2 * NAMED_LIGHT_STEP;
    const beside = (count: number): LampsScene => ({ ...named(mixOf(NAMED_LIGHT_STEP + 1, [POINT])), unwired: false, count, lights: `light_lamps ${Array.from({ length: NAMED_LIGHT_STEP + 1 }, (_, index) => `light_n${index}`).join(" ")}` });
    compiled(beside(full));
    const [error] = compile(lampsScene(beside(full + 1))).diagnostics.filter((entry) => entry.severity === "error");
    expect(error?.code).toBe("node.scene.lightCapacity");
    expect(error?.message).toContain(`${2 * NAMED_LIGHT_STEP} kept for its ${NAMED_LIGHT_STEP + 1} Lights in Single mode that do not cast`);
  });
});

/* ------------------------------------------------------------------------------------ */
/* What is said                                                                          */
/* ------------------------------------------------------------------------------------ */

describe("T1623b: what a Render says about its rows", () => {
  const said = (options: LampsScene, code: string) => compile(lampsScene(options)).diagnostics.filter((entry) => entry.code === code);

  it(`remarks, by its own name, on more than ${LIGHT_EVERYWHERE_ABOVE} lights that reach every pixel, and on no fewer`, () => {
    expect(said(named(mixOf(LIGHT_EVERYWHERE_ABOVE, [POINT, SUN])), "node.scene.lightEverywhere")).toEqual([]);
    const [warning] = said(named(mixOf(LIGHT_EVERYWHERE_ABOVE + 1, [POINT, SUN])), "node.scene.lightEverywhere");
    expect([warning?.severity, warning?.nodeId]).toEqual(["warning", "render_shot"]);
    expect(warning?.message).toContain(`Node "render_shot": ${LIGHT_EVERYWHERE_ABOVE + 1} of its lights reach every pixel`);
    expect(warning?.message).toContain(`${LIGHT_EVERYWHERE_ABOVE + 1} Lights in Single mode`);
    expect(warning?.suggestion).toContain("Range");
    // What it could swallow: any number of lights with a Range say nothing, in either mode.
    expect(said(named(mixOf(2 * LIGHT_EVERYWHERE_ABOVE, [RANGED])), "node.scene.lightEverywhere")).toEqual([]);
    expect(said({ count: 300 }, "node.scene.lightEverywhere")).toEqual([]);
    // A pointset with no Range counts every point of its capacity, and is named with it.
    const [set] = said({ ...named([SUN]), unwired: false, count: 40, light: { range: 0 }, lights: "light_lamps light_n0" }, "node.scene.lightEverywhere");
    expect(set?.message).toContain("41 of its lights reach every pixel");
    expect(set?.message).toContain('"light_lamps" 40, 1 Light in Single mode');
  });

  it("says that a draw of primitive instances lights from a Spot as from a Point light, by the geometry's name and the spot's, and says nothing where the cone is read", () => {
    const boxes: LampsScene = {
      ...named([SPOT, POINT]),
      unwired: false,
      nodes: [...named([SPOT, POINT]).nodes!, { id: "geometry_boxes", type: "geometry", parameters: { mode: "instances", shape: "box" } }],
      edges: [["kernel_lamps", "geometry_boxes", "points"]],
      scenes: "geometry_floor geometry_boxes",
      lights: "light_n0 light_n1",
    };
    const warnings = said(boxes, "node.scene.lightSpot");
    expect(warnings).toHaveLength(1);
    expect([warnings[0]?.severity, warnings[0]?.nodeId]).toEqual(["warning", "render_shot"]);
    expect(warnings[0]?.message).toContain('geometry "geometry_boxes" is drawn as primitive instances, which a Spot ("light_n0") lights as a Point light');
    // The floor alone, a Surface: the cone is the walk's, and nothing is said.
    expect(said(named([SPOT, POINT]), "node.scene.lightSpot")).toEqual([]);
    // Nor for instances under lights that are no spot.
    expect(said({ ...boxes, lights: "light_n1" }, "node.scene.lightSpot")).toEqual([]);
  });
});
