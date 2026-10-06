import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { flattenComponents } from "../../compiler/flatten.ts";
import { graphChannelResolver } from "../../domain/channels/graph-channels.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import { loadProject } from "../../domain/project/index.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { authoredPoints, curveEdge, curveGraph, curveNode, compileCurveGraph, type AuthoredAttribute, type ReadPort } from "./curve-test-support.ts";
import { SHARED_WGSL_MODULES } from "../shaders/shared-modules.ts";
import { allNodeDefinitions } from "./index.ts";
import { materialPbrNode, materialPhongNode, materialUnlitNode } from "./scene.ts";
import { planFingerprint } from "./test-support.ts";

/**
 * §T1618b at the plan level — WHICH DRAWS BIND A GRID'S `uv`, and that the rest are the
 * programs they were.
 *
 * A grid pointset that carries a vec2f `uv` hands it to the material as its texture
 * coordinate. The attribute is bound and read only where a coordinate IS read: a map is
 * wired, or the Material · WGSL's source names the member. So a Sweep, which always
 * publishes a `uv`, costs a Geometry nothing until its material wants one, and every grid
 * program that shipped is the text it was.
 *
 * What the coordinate reads back as is asserted on Dawn in `grid-uv.gpu.test.ts`.
 */

type Pass = { id: string; kind: string; shader?: string; buffers?: Array<{ binding: string }>; textures?: Array<{ binding: string }>; uniforms?: Record<string, unknown> };
type Draw = { id: string; shader: string; buffers: string[] };

/** Four points, one cell: with the named extra attributes, claimed as a grid. */
const points = (extras: ReadonlyArray<AuthoredAttribute>, claim: Record<string, unknown> = {}): { nodes: GraphNode[]; edges: Array<ReturnType<typeof curveEdge>> } => ({
  nodes: [
    authoredPoints("kernel_sheet", [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]], extras).node,
    curveNode("topology_sheet", "pointTopology", { connectivity: "grid", cols: 2, rows: 2, ...claim }),
  ],
  edges: [curveEdge(["kernel_sheet", "out"], ["topology_sheet", "points"])],
});
const UV: AuthoredAttribute = { name: "uv", type: "vec2f", values: [[0, 0], [1, 0], [0, 1], [1, 1]] };

interface Material {
  readonly node: GraphNode;
  /** Material inputs to wire a texture into. */
  readonly maps?: ReadonlyArray<"albedo" | "roughness">;
}
const stock = (type: string, maps: ReadonlyArray<"albedo" | "roughness"> = [], parameters: Record<string, unknown> = {}): Material => ({ node: curveNode("material_skin", type, parameters), maps });
const wgsl = (body: string): Material => ({
  node: curveNode("material_skin", "materialWgsl", { model: "pbr", source: `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {\n  var o = surfaceDefaults(s);\n${body}\n  return o;\n}` }),
});

/** The Render's draws of the grid Geometry: the lit draw, and a G-buffer layer for each output asked for. */
function drawsOf(source: ReturnType<typeof points>, material: Material, outputs: ReadonlyArray<string> = []): Draw[] {
  const ports: ReadPort[] = outputs.map((portId) => ({ nodeId: "render_shot", portId }));
  const plan = compileCurveGraph(
    curveGraph(
      [
        ...source.nodes,
        curveNode("solid_plate", "solid", {}),
        material.node,
        curveNode("geometry_skin", "geometry", { mode: "surface", material: "material_skin" }),
        curveNode("camera_main", "camera", { eye: [0, 0, 5], lookAt: [0, 0, 0] }),
        curveNode("light_key", "light", { kind: "directional", direction: [0, -1, -1] }),
        curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main", lights: "light_key", ...Object.fromEntries(outputs.map((output) => [`${output}Output`, true])) }),
        curveNode("output_probe", "output"),
      ],
      [
        ...source.edges,
        ...(material.maps ?? []).map((port) => curveEdge(["solid_plate", "out"], ["material_skin", port])),
        curveEdge(["topology_sheet", "out"], ["geometry_skin", "points"]),
        curveEdge(["render_shot", "out"], ["output_probe", "input"]),
      ],
    ),
    16,
    ports,
  );
  expect(plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  return (plan.passes as unknown as Pass[])
    .filter((pass) => pass.kind === "draw" && pass.uniforms !== undefined && "grid" in pass.uniforms && String(pass.shader).includes("out.uv"))
    .map((pass) => ({ id: pass.id, shader: String(pass.shader), buffers: (pass.buffers ?? []).map((entry) => entry.binding) }));
}

const binds = (draw: Draw): boolean => draw.buffers.includes("gridUvs");
const reads = (draw: Draw): boolean => draw.shader.includes("out.uv = gridUvOf(gx, gy);") && draw.shader.includes("var<storage, read> gridUvs: array<vec2f>;");

describe("§T1618b: a grid's `uv` is bound where a texture coordinate is read, and nowhere else", () => {
  it("a stock material with a map wired binds it and reads it, in the lit draw and in every layer", () => {
    for (const maps of [["albedo"], ["roughness"], ["albedo", "roughness"]] as const) {
      const draws = drawsOf(points([UV]), stock("materialPbr", maps), ["normal", "albedo"]);
      expect(draws.map((draw) => draw.id.replace(/^.*render_shot:/, ""))).toEqual(["scene:0", "gbuffer:0", "gbuffer:albedo:0"]);
      for (const draw of draws) expect([maps.join("+"), draw.id, binds(draw), reads(draw)]).toEqual([maps.join("+"), draw.id, true, true]);
    }
  });

  it("the same material with NO map wired does not: its program is the one the pointset gets without a `uv`, to the byte", () => {
    for (const type of ["materialUnlit", "materialPhong", "materialPbr"]) {
      const carrying = drawsOf(points([UV]), stock(type), ["normal"]);
      const bare = drawsOf(points([]), stock(type), ["normal"]);
      expect(carrying).toHaveLength(2);
      expect(carrying.map(binds)).toEqual([false, false]);
      expect(carrying.map((draw) => draw.shader)).toEqual(bare.map((draw) => draw.shader));
      expect(carrying.map((draw) => draw.buffers)).toEqual(bare.map((draw) => draw.buffers));
    }
  });

  it("a Material · WGSL binds it exactly when its source names the member", () => {
    const naming = drawsOf(points([UV]), wgsl("  o.albedo = vec4f(s.uv, 0.0, 1.0);"), ["normal"]);
    expect(naming.map((draw) => [binds(draw), reads(draw)])).toEqual([[true, true], [true, true]]);
    // Through a copy handed to a helper it is still spelled.
    const copied = drawsOf(points([UV]), wgsl("  let q = s;\n  o.roughness = q . uv.x;"));
    expect(copied.map(binds)).toEqual([true]);

    const silent = drawsOf(points([UV]), wgsl("  o.albedo = vec4f(fract(s.world), 1.0);"), ["normal"]);
    const bare = drawsOf(points([]), wgsl("  o.albedo = vec4f(fract(s.world), 1.0);"), ["normal"]);
    expect(silent.map(binds)).toEqual([false, false]);
    expect(silent.map((draw) => draw.shader)).toEqual(bare.map((draw) => draw.shader));
  });

  it("a pointset with no `uv`, or one that is not a vec2f, keeps the grid's own coordinate", () => {
    const none = drawsOf(points([]), stock("materialPbr", ["albedo"]));
    const wrong = drawsOf(points([{ name: "uv", type: "vec3f", values: [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0]] }]), stock("materialPbr", ["albedo"]));
    for (const draws of [none, wrong]) {
      expect(draws.map(binds)).toEqual([false]);
      expect(draws[0]!.shader).toContain("f32(gx) / max(select(params.grid.x - 1.0, params.grid.x, wrapU), 1.0)");
      expect(draws[0]!.shader).not.toContain("gridUv");
    }
    expect(wrong[0]!.shader).toBe(none[0]!.shader);
  });

  it("on a grid of several sheets a vertex reads its own sheet's row", () => {
    const eight: AuthoredAttribute = { name: "uv", type: "vec2f", values: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 0], [2, 0], [0, 2], [2, 2]] };
    const source = {
      nodes: [
        authoredPoints("kernel_sheet", [[-2, -1, 0], [-1, -1, 0], [-2, 1, 0], [-1, 1, 0], [1, -1, 0], [2, -1, 0], [1, 1, 0], [2, 1, 0]], [eight]).node,
        curveNode("topology_sheet", "pointTopology", { connectivity: "grid", cols: 2, rows: 2, sheets: 2 }),
      ],
      edges: [curveEdge(["kernel_sheet", "out"], ["topology_sheet", "points"])],
    };
    const [draw] = drawsOf(source, stock("materialUnlit", ["albedo"]));
    expect(binds(draw!)).toBe(true);
    expect(draw!.shader).toContain("return gridUvs[(gridSheet * rows + row) * cols + column];");
    // One sheet reads the row as it is.
    expect(drawsOf(points([UV]), stock("materialUnlit", ["albedo"]))[0]!.shader).toContain("return gridUvs[row * cols + column];");
  });
});

describe("§T1618b: Map Extend picks how a map is read past its edge, and Hold is the read it always was", () => {
  const HELD = "textureLoad(albedoMap, vec2i(clamp(input.uv, vec2f(0.0), vec2f(1.0)) * (vec2f(textureDimensions(albedoMap)) - vec2f(1.0))), 0)";
  const both = ["albedo", "roughness"] as const;

  it("Hold on both axes, said or left alone, is the text a mapped Surface had: no fold, no address function", () => {
    const plain = drawsOf(points([]), stock("materialPbr", both), ["normal"]);
    const said = drawsOf(points([]), stock("materialPbr", both, { mapExtendU: "hold", mapExtendV: "hold" }), ["normal"]);
    expect(plain).toHaveLength(2);
    expect(said.map((draw) => draw.shader)).toEqual(plain.map((draw) => draw.shader));
    for (const draw of plain) {
      expect(draw.shader).toContain(HELD);
      expect(draw.shader).not.toContain("mapTexel");
      expect(draw.shader).not.toContain("extendRepeat");
    }
  });

  it("an axis that tiles sends every map of the material through one address, the shared module's two folds pasted once", () => {
    const draws = drawsOf(points([]), stock("materialPbr", both, { mapExtendV: "repeat" }), ["normal", "albedo"]);
    expect(draws).toHaveLength(3);
    for (const draw of draws) {
      expect(draw.shader).not.toContain("clamp(input.uv");
      expect(draw.shader.match(/mapTexel\(input\.uv, vec2f\(textureDimensions\((albedoMap|roughnessMap)\)\)\)/g)).toHaveLength(2);
      expect(draw.shader.match(/fn mapTexel\(/g)).toHaveLength(1);
      // ONE text for the folds: the module a Material · WGSL pulls in with `// @use extend`.
      expect(draw.shader.split(SHARED_WGSL_MODULES["extend"]!.source)).toHaveLength(2);
      // Across is held by the address it always had; along is the fraction over all the texels.
      expect(draw.shader).toContain("return vec2i(i32(clamp(uv.x, 0.0, 1.0) * (size.x - 1.0)), i32(min(floor(extendRepeat(uv.y) * size.y), size.y - 1.0)));");
    }
  });

  it("each axis takes its own: nine texts, and a material with no map wired has none of them", () => {
    const texts = new Set<string>();
    for (const u of ["hold", "repeat", "mirror"]) {
      for (const v of ["hold", "repeat", "mirror"]) {
        const [draw] = drawsOf(points([]), stock("materialUnlit", ["albedo"], { mapExtendU: u, mapExtendV: v }));
        texts.add(draw!.shader);
        const fold = (extend: string, axis: string): string =>
          extend === "hold" ? `i32(clamp(uv.${axis}, 0.0, 1.0) * (size.${axis} - 1.0))` : `i32(min(floor(${extend === "repeat" ? "extendRepeat" : "extendMirror"}(uv.${axis}) * size.${axis}), size.${axis} - 1.0))`;
        if (u !== "hold" || v !== "hold") expect(draw!.shader, `${u}, ${v}`).toContain(`return vec2i(${fold(u, "x")}, ${fold(v, "y")});`);
      }
    }
    expect(texts.size).toBe(9);
    const unmapped = drawsOf(points([]), stock("materialPbr", [], { mapExtendU: "repeat", mapExtendV: "mirror" }));
    expect(unmapped.map((draw) => draw.shader)).toEqual(drawsOf(points([]), stock("materialPbr")).map((draw) => draw.shader));
  });

  it("is two structural enums on each stock material, Hold by default", () => {
    for (const definition of [materialUnlitNode, materialPhongNode, materialPbrNode]) {
      for (const key of ["mapExtendU", "mapExtendV"]) {
        const parameter = definition.parameters[key] as { type: string; default: unknown; compileTime?: boolean; options?: ReadonlyArray<{ value: string }> };
        expect([definition.type, key, parameter.type, parameter.default, parameter.compileTime]).toEqual([definition.type, key, "enum", "hold", true]);
        expect(parameter.options?.map((option) => option.value)).toEqual(["hold", "repeat", "mirror"]);
      }
    }
  });
});

/**
 * THE SHIPPED EXAMPLES THAT WEAR A STOCK MAP ON A GRID SURFACE, pinned by their whole plan:
 * every pass's id, shader text, bindings and uniform values (`planFingerprint`). Taken on
 * 2026-10-06 at `fcf60408`, with §B255 and the `uv` read in and BEFORE a material could say
 * how a map is read past its edge.
 *
 * It is how "Map Extend: Hold is the program a mapped Surface always had" is held: E75
 * multisamples a Render whose mapped grids have open edges in frame, and an automatic repeat
 * outside 0 to 1 moved 571 of its pixels (a partly covered pixel reads its coordinate at
 * the pixel centre, outside the triangle). The same plan is the same bytes.
 *
 * RE-TAKEN ON PURPOSE BY T1623b SLICE 3 (2026-10-06), all five, and not for a map: a Render
 * that draws a lit Surface has a light table now, its Lights in Single mode that do not cast
 * are rows of it, and its casting Lights' blocks stand under B260's guard. So E20, E34 and
 * E75 gain the table's four passes and their lit Surface draws the walk's text. The Surfaces
 * of E25 and E76 are unlit: their text no longer declares the uniform rows of the Lights
 * that do not cast, which it never read. HOW A MAP IS READ did not move in any of them: the
 * lines that read it are the lines they were (`grid-uv.gpu.test.ts`, on Dawn, is unchanged
 * and green), and each Render's picture was compared before and after at frames 0 and 60:
 * E25 and E76 the same bytes, the others within one step of a half float in at most 117
 * channel values of 3.7 million. Before: E20 524da1380e9f7f65, E25 3ea3923714e496b7, E34
 * c73ed3113401e002, E75 b48273dc56455b40, E76 a05741c9165a6c6f.
 *
 * RE-TAKEN ON PURPOSE BY T1623b SLICE 4 (2026-10-06), the three that have a casting Light
 * (E34, E75, E76), and again not for a map and not for any shader text: a casting light's
 * shadow map is a layer of one of the Render's two layered targets, so its sweep's passes
 * and the lit draws' `shadowMap{s}` binding name that resource and that layer. Each one's
 * picture is the bytes it was at frames 0 and 60. E20 and E25 have no casting light and did
 * not move. Before: E34 14199392299ab466, E75 20539dddac39162c, E76 cb73eea6156d7eb0.
 */
const MAPPED: ReadonlyArray<readonly [example: string, fingerprint: string]> = [
  ["E20-Gooeyball", "1fbe0a8bf6618eb3"],
  ["E25-Stage", "85b151e8582f5a44"],
  ["E34-Lidar", "599df12eea639426"],
  ["E75-Resonance", "e01198d733cec059"],
  ["E76-Verdant-Lotus", "b88c8f5482d239b8"],
];

const registry = createNodeRegistry(allNodeDefinitions).view();
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

describe("a shipped Surface that wears a map keeps its plan: the map is read as it always was", () => {
  for (const [name, fingerprint] of MAPPED) {
    it(`${name}: every pass, its shader text, its bindings and its uniforms`, () => {
      const plan = examplePlan(name);
      expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
      // The claim is about a path that runs: a draw of the example binds a stock map.
      const mapped = (plan.passes as unknown as Pass[]).filter((pass) => (pass.textures ?? []).some((texture) => texture.binding === "albedoMap" || texture.binding === "roughnessMap"));
      expect(mapped.length).toBeGreaterThan(0);
      expect(planFingerprint(plan)).toBe(fingerprint);
    });
  }
});

