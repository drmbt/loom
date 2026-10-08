import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { createValueGraphSession } from "../domain/channels/value-graph.ts";
import { graphChannelResolver } from "../domain/channels/graph-channels.ts";
import { createComponentSystem } from "../domain/components/index.ts";
import { NO_INSTANCES, NO_PAGES } from "../domain/parameters/node-references.ts";
import { effectiveParameterSchema } from "../domain/parameters/resolve.ts";
import { buildMorphIndex } from "../domain/presets/morph-index.ts";
import { loadProject } from "../domain/project/index.ts";
import type { FrameEvaluationInput } from "../domain/types/frame.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../domain/types/graph.ts";
import type { NodeDefinition } from "../domain/types/node-definition.ts";
import type { ParameterDefinition } from "../domain/types/parameters.ts";
import { TIER_B_CAPABILITIES } from "../examples/runner.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { PACK, sentinelDocument } from "../projects/sentinel-bot/document.ts";
import { KIT_FIXTURE } from "../projects/sentinel-bot/kit.fixture.ts";
import { passStructureKey, samePassStructure } from "../runtime/backend/plan.ts";
import { forgetGeneratedText, generatedTextCounts } from "../runtime/backend/wgsl.ts";
import { compileGraph } from "./compile.ts";
import { compiledWithoutCatalogue, flattenComponents } from "./flatten.ts";
import { prepareFrameCompiler } from "./frame-compile.ts";
import type { ParameterResolution } from "./validate.ts";
import type { CompileRequest, CompiledGraph } from "./types.ts";

/**
 * T1603b — GENERATED SHADER TEXT IS REMEMBERED, AND THE MEMORY CANNOT GO STALE.
 *
 * A values-only frame used to rebuild every pass's WGSL: more than half of the per-frame
 * compile on a scene of thirteen geometries with shadows, for text such a frame cannot
 * change. The generators now remember their results by a walk of everything they are handed
 * (`generatedOnce`, `runtime/backend/wgsl.ts`). Two claims, and the second is the one that
 * matters:
 *
 *  1. A VALUES-ONLY FRAME BUILDS NO SHADER TEXT — no generator runs, no template builds —
 *     and what it splices is, byte for byte, what a full compile with nothing remembered
 *     produces at that frame.
 *
 *  2. A STRUCTURAL CHANGE STILL CHANGES THE TEXT. A memory that returned last revision's
 *     shader after a structural edit would render the previous picture perfectly and pass
 *     every identity check. So every structural parameter of the nodes whose text is
 *     remembered is perturbed, one at a time, over a scene compiled before it, and the plan
 *     is compared with the same compile done COLD. The parameters are derived from the
 *     definitions (`compileTime`, and every key that takes a Map), so one added next year
 *     is in this sweep the day it is declared.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const frameAt = (frameIndex: number): FrameEvaluationInput => ({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 });

/** The plan a compile with NOTHING remembered produces: every generator runs. */
function compiledCold(request: CompileRequest): CompiledGraph {
  forgetGeneratedText();
  return compileGraph(request);
}

/* ------------------------------------------------------------------------------------ */
/* 1. a values-only frame builds no shader text                                          */
/* ------------------------------------------------------------------------------------ */

interface Animated {
  readonly name: string;
  readonly request: CompileRequest;
  /** The channels a frame reads, evaluated as the app does. */
  readonly resolutionAt: (frameIndex: number) => ParameterResolution;
}

/** A shipped example, read by name (two of them; this is not a walk of the set). */
function example(fileName: string): Animated {
  const text = readFileSync(new URL(`../../examples/${fileName}`, import.meta.url), "utf8");
  const system = createComponentSystem(registry);
  const loaded = loadProject(text, { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`${fileName} does not load`);
  for (const definition of loaded.components) system.components.register(definition);
  const components = system.components.view();
  const flattened = flattenComponents({ graph: loaded.document.graph, registry: system.nodes, components });
  const channels = graphChannelResolver(flattened.graph, system.nodes);
  return {
    name: fileName,
    request: { graph: loaded.document.graph, settings: loaded.document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components, flattened, resolution: { channels } },
    resolutionAt: (frameIndex) => ({ frame: frameAt(frameIndex), channels }),
  };
}

/**
 * What this file needs of ANOTHER SESSION'S project, checked before anything is built on
 * it. `sentinelDocument` and `KIT_FIXTURE` belong to `src/projects/sentinel-bot`, which
 * changes under its own author; when their shape changes, this says so in one sentence
 * instead of failing three lines later on an undefined field.
 */
function consumerDocument(): { graph: GraphDocument; settings: ProjectSettings } {
  const changed = (what: string): Error =>
    new Error(
      `The consumer's document builder changed its signature: ${what}. This test (T1603b) reads sentinelDocument(facts, { width, height, robots, tier, shadows, hingedClaws }) and KIT_FIXTURE from src/projects/sentinel-bot; update how it calls them here, or tell that session.`,
    );
  const fixture = KIT_FIXTURE as unknown as Record<string, unknown>;
  for (const key of ["robot", "ring", "hub", "claw", "phalanxMeshes", "phalanges"]) {
    if (!(key in fixture)) throw changed(`KIT_FIXTURE has no "${key}"`);
  }
  if (!Array.isArray(fixture["phalanges"]) || !Array.isArray(PACK) || PACK.length === 0) throw changed("KIT_FIXTURE.phalanges or PACK is not a list");
  if (typeof sentinelDocument !== "function") throw changed("sentinelDocument is not a function");
  // The kit is not in the repository, so its meshes are sized as cubes; a compile reads the sizes and nothing else.
  const mesh = (select: string) => ({ select, vertices: 24, triangles: 12, parts: "" });
  const facts = { ...KIT_FIXTURE, robot: mesh("hull"), ring: mesh("ring"), hub: mesh("hub"), claw: mesh("claw"), phalanxMeshes: KIT_FIXTURE.phalanges.map((_, which) => mesh(`phalanx${String(which)}`)) };
  let built: unknown;
  try {
    built = sentinelDocument(facts, { width: 320, height: 180, robots: PACK.slice(0, 1), tier: "live", shadows: true, hingedClaws: true });
  } catch (error) {
    throw changed(`sentinelDocument threw "${error instanceof Error ? error.message : String(error)}"`);
  }
  const document = built as { graph?: { nodes?: Record<string, { type?: string }> }; settings?: unknown };
  if (document.graph?.nodes === undefined || document.settings === undefined) throw changed("it no longer returns { graph, settings }");
  // The scene this test is about: nine claw pieces, the ring and the hull as geometries, and a light that casts.
  const types = Object.values(document.graph.nodes).map((node) => node.type);
  const geometries = types.filter((type) => type === "geometry").length;
  if (geometries < 12 || !types.includes("render") || !types.includes("light")) {
    throw changed(`{ hingedClaws: true, shadows: true } built ${String(geometries)} geometries (twelve or more expected), ${types.includes("render") ? "a" : "no"} render and ${types.includes("light") ? "a" : "no"} light`);
  }
  return built as { graph: GraphDocument; settings: ProjectSettings };
}

/**
 * The first consumer's document with its claw as nine pieces and shadows on: thirteen
 * geometries, the scene the cost was measured on.
 */
function sentinel(): Animated {
  const built = consumerDocument();
  const graph = built.graph;
  const logical = compiledWithoutCatalogue(graph);
  const session = createValueGraphSession(registry);
  const morphs = buildMorphIndex({ document: graph, registry });
  return {
    name: "sentinel-bot, hinged claws, shadows on",
    request: { graph, settings: built.settings, registry, capabilities: TIER_B_CAPABILITIES },
    resolutionAt: (frameIndex) => {
      const frame = frameAt(frameIndex);
      const evaluated = session.evaluate(logical, frame, { pointer: { x: 0, y: 0, buttons: 0 } as never, flattening: { morphs, instanceChannels: NO_INSTANCES, instancePages: NO_PAGES } });
      return { frame, channels: evaluated.resolver };
    },
  };
}

describe("T1603b: a values-only frame builds no shader text", () => {
  // The consumer's scene, and five shipped examples whose frame re-emits a Render's passes:
  // E13 and E33 by request, and the three that re-emit the most (E79 does sixty-four).
  const documents: ReadonlyArray<() => Animated> = [
    sentinel,
    ...["E13-Prism", "E33-Obol", "E28-Sundial", "E69-Burnish", "E79-Crucible"].map((name) => () => example(`${name}.loom.json`)),
  ];

  for (const build of documents) {
    const document = build();
    it(`${document.name}: no generator runs, no template builds, and the frame is the cold compile's`, () => {
      forgetGeneratedText();
      const prepared = prepareFrameCompiler(document.request);
      expect(prepared.base.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);

      for (const frameIndex of [1, 2, 30]) {
        const resolution = document.resolutionAt(frameIndex);
        const before = generatedTextCounts();
        const spliced = prepared.compileFrame(resolution);
        const after = generatedTextCounts();
        expect(spliced, prepared.reason ?? "").not.toBeNull();
        if (spliced === null) return;

        // The frame did real work: it re-emitted passes that carry a shader …
        const reemitted = spliced.passes.filter((pass, index) => pass !== prepared.base.passes[index] && "shader" in pass);
        expect([frameIndex, reemitted.length > 0]).toEqual([frameIndex, true]);
        // … and built none of that text. Named by generator, so a failure says which one ran.
        const ran = Object.fromEntries(
          Object.entries(after.byGenerator)
            .map(([name, counts]) => [name, counts.generated - (before.byGenerator[name]?.generated ?? 0)] as const)
            .filter(([, count]) => count !== 0),
        );
        expect([frameIndex, ran, after.built - before.built]).toEqual([frameIndex, {}, 0]);
        // It asked, though: the generators were called and answered from memory.
        expect(after.reused).toBeGreaterThan(before.reused);
        // Every re-emitted shader IS the base's string: the verifier compares them where they stand.
        for (const pass of reemitted) {
          const base = prepared.base.passes.find((entry) => entry.id === pass.id);
          expect([pass.id, (pass as { shader: string }).shader === (base as { shader: string }).shader]).toEqual([pass.id, true]);
        }

        // Byte for byte what a full compile produces at this frame with nothing remembered.
        const full = compiledCold({ ...document.request, resolution });
        expect(spliced.passes).toEqual(full.passes);
        expect(spliced.signature).toBe(full.signature);
      }
    });
  }
});

/* ------------------------------------------------------------------------------------ */
/* 2. every structural parameter still reaches the text                                  */
/* ------------------------------------------------------------------------------------ */

const SETTINGS: ProjectSettings = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxBufferBytes: 1 << 28, maxDispatch: 65535, memoryBudgetBytes: 1 << 30 },
};

const POINT_ATTRIBUTES = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "place", type: "vec3f", default: [0, 0, 0] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
  { name: "size", type: "f32", default: [1] },
  { name: "tint", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "keep", type: "f32", default: [1] },
  { name: "glow", type: "f32", default: [0] },
];
const KERNEL = "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = vec3f(f32(ctx.index), 0.0, 0.0);\n  return q;\n}";
const MATERIAL = "struct Params {\n  heat: f32, // @default 1\n};\n\nstruct Instance {\n  glow: f32, // @default 0\n};\n\nfn surface(s: SurfaceIn, p: Params) -> SurfaceOut {\n  var o = surfaceDefaults(s);\n  o.emissive = vec3f(p.heat * s.instance.glow);\n  return o;\n}";

/**
 * Other values for each structural parameter that is TEXT, by `type.key`. A structural text
 * parameter with no entry here fails the sweep by name: adding one to a definition is what
 * makes this list owe it a second value.
 *
 * Where the text is code, one of the others is an edit that keeps its LENGTH: a memory that
 * told two sources apart by their size would pass every other change in this file.
 */
const OTHER_TEXT: Readonly<Record<string, readonly string[]>> = {
  "geometry.endpoint": ["place"],
  "geometry.instanceAttributes": ["glow = keep"],
  "geometry.group": ["p.size > 0.25", "p.keep > 0.25"],
  // The material a geometry wears is named, not wired: the default one, and a stock one.
  "geometry.material": ["", "material_plain"],
  "materialWgsl.source": [
    MATERIAL.replace("p.heat * s.instance.glow", "p.heat + s.instance.glow").replace("heat: f32, // @default 1", "heat: f32, // @default 1\n  tone: vec3f, // @default 1"),
    MATERIAL.replace("p.heat * s.instance.glow", "p.heat + s.instance.glow"),
  ],
  "pointKernel.attributes": [JSON.stringify([...POINT_ATTRIBUTES, { name: "age", type: "f32", default: [0] }])],
  "pointKernel.kernel": [KERNEL.replace("f32(ctx.index)", "f32(ctx.index) * 2.0"), KERNEL.replace("0.0, 0.0)", "1.0, 0.0)")],
  "pointKernel.group": ["p.keep > 0.5"],
  "pointKernelAdvanced.attributes": [
    JSON.stringify([
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "velocity", type: "vec3f", default: [0, 0, 0] },
      { name: "id", type: "u32", semantic: "id", default: [0] },
      { name: "heat", type: "f32", default: [0] },
    ]),
  ],
  "pointKernelAdvanced.kernel": ["fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position.y = 1.0;\n  return q;\n}"],
  "pointKernelAdvanced.group": ["p.position.x > 0.0"],
  "pointKernelAdvanced.spawn": ["fn spawn(child: Point, ctx: PointCtx) -> Point {\n  var c = child;\n  c.position.y = 2.0;\n  return c;\n}"],
};

type Stored = Record<string, unknown>;
const node = (id: string, type: string, parameters: Stored, label: string): GraphNode => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label }) as never;
const wire = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });

/**
 * One scene that draws through every remembered generator: a mesh at every point under a
 * Material · WGSL, a grid Surface, counted primitive boxes, a directional and a point light
 * that both cast and a fill that does not, and every G-buffer output on.
 */
function scene(change?: { readonly nodeId: string; readonly key: string; readonly value: unknown }): GraphDocument {
  const nodes = [
    node("file", "meshFileIn", { vertices: 24, triangles: 12 }, "mesh_shape"),
    node("pts", "pointKernel", { capacity: 16, seed: 1, group: "", attributes: JSON.stringify(POINT_ATTRIBUTES), kernel: KERNEL }, "kernel_points"),
    node("sim", "pointKernelAdvanced", { capacity: 8, seed: 1 }, "kernel_sim"),
    node("grid", "pointGrid", { cols: 4, rows: 4 }, "grid_sheet"),
    node("mat", "materialWgsl", { model: "pbr", source: MATERIAL }, "material_code"),
    node("plain", "materialPbr", { color: [0.8, 0.6, 0.3, 1], metallic: 1, roughness: 0.4 }, "material_plain"),
    node("geo", "geometry", { mode: "instances", shape: "mesh", material: "material_code" }, "geometry_instances"),
    node("sheet", "geometry", { mode: "surface" }, "geometry_sheet"),
    node("boxes", "geometry", { mode: "instances", shape: "box" }, "geometry_boxes"),
    node("cam", "camera", {}, "camera_lens"),
    node("key", "light", { shadows: true }, "light_key"),
    node("lamp", "light", { kind: "point", shadows: true }, "light_lamp"),
    // Last in the list and casting nothing: dropping it changes the light COUNT and no other option.
    node("fill", "light", { intensity: 0.2 }, "light_fill"),
    node("shot", "render", { scenes: "geometry_sheet geometry_instances geometry_boxes", camera: "camera_lens", lights: "light_key light_lamp light_fill", normalOutput: true, albedoOutput: true, shadowOutput: true, depthOutput: true }, "render_shot"),
    node("out", "output", {}, "output_main"),
  ].map((entry) => (change !== undefined && entry.id === change.nodeId ? ({ ...entry, parameters: { ...entry.parameters, [change.key]: change.value } } as GraphNode) : entry));
  const edges = [wire("e1", "file", "geo", "mesh"), wire("e2", "pts", "geo", "points"), wire("e3", "grid", "sheet", "points"), wire("e4", "sim", "boxes", "points"), wire("e5", "shot", "out", "input")];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

const requestFor = (graph: GraphDocument): CompileRequest => ({
  graph,
  settings: SETTINGS,
  registry,
  capabilities: TIER_B_CAPABILITIES,
  sinks: ["normal", "albedo", "shadow", "depth"].map((portId) => ({ nodeId: "shot" as never, portId, kind: "preview" as const })),
});

/** The node of each swept type in the scene. */
const SUBJECTS: ReadonlyArray<readonly [type: string, nodeId: string]> = [
  ["geometry", "geo"],
  ["render", "shot"],
  ["materialWgsl", "mat"],
  ["pointKernel", "pts"],
  ["pointKernelAdvanced", "sim"],
  ["light", "lamp"],
];

interface Change {
  readonly label: string;
  readonly nodeId: string;
  readonly key: string;
  readonly value: unknown;
}

/** The other values a structural parameter can take, from its definition. */
function otherValues(type: string, key: string, parameter: ParameterDefinition, stored: unknown): unknown[] {
  const current = stored ?? (parameter as { default?: unknown }).default;
  switch (parameter.type) {
    case "enum":
      return parameter.options.map((option) => option.value).filter((value) => value !== current);
    case "boolean":
      return [current !== true];
    case "number":
      return [(typeof current === "number" ? current : 0) * 2 + 1];
    case "string":
    case "code": {
      const others = OTHER_TEXT[`${type}.${key}`];
      if (others === undefined) throw new Error(`${type}.${key} is a structural text parameter with no second value in OTHER_TEXT: add one, so the sweep reaches it.`);
      return [...others];
    }
    default:
      throw new Error(`${type}.${key} is a structural ${parameter.type} parameter and this sweep does not know how to change one: teach it.`);
  }
}

/** A stored Map envelope naming the attribute of the right shape for this parameter. */
function mapEnvelope(parameter: ParameterDefinition): unknown {
  const attribute = parameter.type === "color" ? "tint" : parameter.type === "vector" ? (parameter.size === 4 ? "orient" : "place") : "size";
  return { mode: "map", bindings: { static: { kind: "static", value: (parameter as { default?: unknown }).default }, map: { kind: "map", attribute } } };
}

function changes(): Change[] {
  const base = scene();
  const out: Change[] = [];
  for (const [type, nodeId] of SUBJECTS) {
    const definition = allNodeDefinitions.find((entry) => entry.type === type) as NodeDefinition;
    const stored = (base.nodes as Record<string, GraphNode>)[nodeId]!.parameters as Stored;
    const schema = effectiveParameterSchema(definition, stored);
    /* A name a node REFERENCES another by is structure though it is not `compileTime`: which
       geometries a Render draws, under which lights, and the material a geometry wears. A
       list is tried shorter, reversed and empty; a single name takes its OTHER_TEXT values. */
    const references = new Map((definition.sourceReferences ?? []).map((reference) => [reference.parameter, reference.list === true] as const));
    for (const [key, parameter] of Object.entries(schema)) {
      if (references.has(key)) {
        const names = String(stored[key] ?? "").split(/[\s,]+/).filter((name) => name !== "");
        const lists = references.get(key) === true ? [names.slice(0, -1), [...names].reverse(), []].map((list) => list.join(" ")) : [...(OTHER_TEXT[`${type}.${key}`] ?? [])];
        for (const value of new Set(lists)) {
          if (value !== names.join(" ")) out.push({ label: `${type}.${key} = ${JSON.stringify(value)}`, nodeId, key, value });
        }
      } else if (parameter.compileTime === true) {
        for (const value of otherValues(type, key, parameter, stored[key])) out.push({ label: `${type}.${key} = ${JSON.stringify(value).slice(0, 40)}`, nodeId, key, value });
      } else if (type === "geometry" && (parameter.type === "color" || parameter.type === "vector" || parameter.type === "number")) {
        // A Map is structure too: the draw binds and reads another attribute.
        out.push({ label: `${type}.${key} in Map mode`, nodeId, key, value: mapEnvelope(parameter) });
      }
    }
  }
  return out;
}

const textsOf = (plan: CompiledGraph): string[] => plan.passes.map((pass) => ("shader" in pass ? `${pass.id}\u0000${String(pass.shader)}` : pass.id));

describe("T1603b: every structural parameter still reaches the generated text", () => {
  const swept = changes();

  it("sweeps the definitions' own structural parameters, and enough of them", () => {
    // Derived, so a number: the floor that keeps a sweep over an emptied schema from passing.
    expect(swept.length).toBeGreaterThan(40);
    for (const [type] of SUBJECTS) expect([type, swept.some((change) => change.label.startsWith(`${type}.`))]).toEqual([type, true]);
  });

  it("gives, after any one of them changes, exactly the plan a compile with nothing remembered gives", () => {
    forgetGeneratedText();
    const base = compileGraph(requestFor(scene()));
    expect(base.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const baseTexts = textsOf(base);

    const moved: string[] = [];
    for (const change of swept) {
      const request = requestFor(scene(change));
      // WARM: everything the base and the changes before this one generated is remembered.
      const warm = compileGraph(request);
      const cold = compiledCold(request);
      expect(textsOf(warm), change.label).toEqual(textsOf(cold));
      expect(warm.passes, change.label).toEqual(cold.passes);
      expect(warm.diagnostics, change.label).toEqual(cold.diagnostics);
      if (textsOf(cold).join("\u0001") !== baseTexts.join("\u0001")) moved.push(change.label);
      // Back to the base, warm again, and it is still the base's: the change did not overwrite it.
      expect(textsOf(compileGraph(requestFor(scene()))), `${change.label}, then back`).toEqual(baseTexts);
    }

    // The sweep is about text that MOVES: most structural changes rewrite a shader, add or
    // drop a pass. (Some change nothing here by design: a beam's Endpoint on a geometry
    // that is not a beam.) A sweep in which nothing moved would prove nothing.
    expect(moved.length).toBeGreaterThan(swept.length / 2);
    for (const label of [
      "geometry.mode = \"surface\"",
      "geometry.group = \"p.size > 0.25\"",
      "geometry.material = \"material_plain\"",
      "render.normalOutput = false",
      "render.lights = \"light_key light_lamp\"",
      "render.scenes = \"geometry_sheet geometry_instances\"",
      "materialWgsl.model = \"phong\"",
      "pointKernel.capacity = 33",
      "light.shadows = false",
    ]) {
      expect([label, moved.includes(label)]).toEqual([label, true]);
    }
  });
});

/**
 * The per-frame verifier no longer builds a pass's structure key to compare it: the key
 * serialises the shader text, ten to twenty kilobytes a pass. `samePassStructure` walks the
 * same parts instead. It must give the answer the keys give — on passes that are the same
 * and, which is the half that matters, on passes that are not.
 */
describe("T1603b: samePassStructure is passStructureKey equality, without the keys", () => {
  it("agrees with the keys on every pair of same-id passes across the structural sweep", () => {
    const base = compileGraph(requestFor(scene()));
    const byId = new Map(base.passes.map((pass) => [pass.id, pass]));
    let same = 0;
    let different = 0;
    for (const change of changes()) {
      for (const pass of compileGraph(requestFor(scene(change))).passes) {
        const before = byId.get(pass.id);
        if (before === undefined) continue;
        const byKey = passStructureKey(pass) === passStructureKey(before);
        expect([change.label, pass.id, samePassStructure(pass, before)]).toEqual([change.label, pass.id, byKey]);
        if (byKey) same += 1;
        else different += 1;
      }
    }
    // Both answers were asked for, many times: a function that always said one would fail above.
    expect(same).toBeGreaterThan(500);
    expect(different).toBeGreaterThan(100);
  });

  it("tells passes of one plan apart exactly as the keys do", () => {
    const passes = compileGraph(requestFor(scene())).passes;
    for (const a of passes) {
      for (const b of passes) {
        expect([a.id, b.id, samePassStructure(a, b)]).toEqual([a.id, b.id, passStructureKey(a) === passStructureKey(b)]);
      }
    }
  });
});
