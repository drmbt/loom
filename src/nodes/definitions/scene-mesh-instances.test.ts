import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { geometryNode } from "./scene.ts";
import { meshFileInNode } from "./mesh-file-in.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../points/mesh.ts";
import { SURFACE_RESERVED_NAMES } from "../shaders/scene-render.wgsl.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { DispatchPassDescriptor, DrawPassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * T1581b — mesh instancing at the definition (no GPU): what the Geometry says about itself,
 * where it refuses and in which words, and the SHAPE of what it emits — one resolve pass
 * the node owns, and draws that bind a buffer per producer whatever is mapped. What reaches
 * a pixel is `mesh-instances.gpu.test.ts`'s claim, on Dawn.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label }) as never;
const edge = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });
const mapped = (attribute: string, value: unknown, extra: Record<string, unknown> = {}) => ({
  mode: "map",
  bindings: { static: { kind: "static", value }, map: { kind: "map", attribute, ...extra } },
});

const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "place", type: "vec3f", default: [0, 0, 0] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
  { name: "size", type: "f32", default: [1] },
  { name: "tint", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "keep", type: "f32", default: [1] },
]);

interface Options {
  readonly geometry?: Record<string, unknown>;
  /** What feeds Shape Mesh: a mesh file, a plain grid (no normals), a cloud with normals and no triangles, or nothing. */
  readonly shape?: "mesh" | "grid" | "cloud" | "none";
  readonly material?: { readonly type: string; readonly parameters: Record<string, unknown> };
  readonly renders?: number;
  readonly render?: Record<string, unknown>;
}

function graph(options: Options = {}): GraphDocument {
  const shape = options.shape ?? "mesh";
  const renders = Array.from({ length: options.renders ?? 1 }, (_, index) => `shot${index}`);
  const nodes = [
    node("file", "meshFileIn", { vertices: 24, triangles: 12 }, "mesh_file"),
    node("grid", "pointGrid", { cols: 4, rows: 4 }, "grid_plain"),
    node(
      "cloud",
      "pointKernel",
      {
        capacity: 8,
        seed: 1,
        group: "",
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
        ]),
        kernel: "fn process(p: Point, ctx: PointCtx) -> Point { return p; }",
        value1: 0, value2: 0, value3: 0, value4: 0,
      },
      "kernel_cloud",
    ),
    node("pts", "pointKernel", { capacity: 16, seed: 1, group: "", attributes: ATTRIBUTES, kernel: "fn process(p: Point, ctx: PointCtx) -> Point { return p; }", value1: 0, value2: 0, value3: 0, value4: 0 }, "kernel_points"),
    ...(options.material === undefined ? [] : [node("mat", options.material.type, options.material.parameters, "material_worn")]),
    node("geo", "geometry", { mode: "instances", shape: "mesh", ...(options.material === undefined ? {} : { material: "material_worn" }), ...options.geometry }, "geometry_instances"),
    node("cam", "camera", {}, "camera_lens"),
    node("key", "light", { shadows: true }, "light_key"),
    ...renders.map((id) => node(id, "render", { scenes: "geometry_instances", camera: "camera_lens", lights: "light_key", normalOutput: true, ...options.render }, `render_${id}`)),
    ...(renders.length === 1 ? [] : [node("mix", "over", {}, "over_mix")]),
    node("out", "output", {}, "output_main"),
  ];
  const edges = [
    edge("e1", "pts", "geo", "points"),
    ...(shape === "none" ? [] : [edge("e2", shape === "mesh" ? "file" : shape, "geo", "mesh")]),
    ...renders.map((id, index) => edge(`r${index}`, id, renders.length === 1 ? "out" : "mix", renders.length === 1 ? "input" : `in${index + 1}`)),
    ...(renders.length === 1 ? [] : [edge("m1", "mix", "out", "input")]),
  ];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

const compile = (document: GraphDocument) =>
  compileGraph({ graph: document, settings: SETTINGS, registry, capabilities: CAPABILITIES, sinks: [{ nodeId: "shot0", portId: "normal", kind: "preview" as const }] } as never);

type Pass = DrawPassDescriptor | DispatchPassDescriptor;
const passesOf = (compiled: { passes: ReadonlyArray<unknown> }): Pass[] => (compiled.passes as Pass[]).map((pass) => ({ ...pass, id: pass.id.slice(pass.id.indexOf("#") + 1) }));
const errors = (compiled: { diagnostics: ReadonlyArray<{ severity: string; code: string; message: string }> }) => compiled.diagnostics.filter((d) => d.severity === "error");

describe("a Geometry drawing a mesh at every point (T1581b)", () => {
  it("defaults a mesh instance's Size to 1, never the primitives' 0.05 (O3)", () => {
    // The schema one placed node carries, through the one funnel (§T903).
    const sizeOf = (stored: Record<string, unknown>): unknown => (effectiveParameterSchema(geometryNode, stored)["scale"] as { default?: unknown }).default;
    expect(sizeOf({ mode: "instances", shape: "mesh" })).toBe(1);
    expect(sizeOf({ mode: "instances", shape: "box" })).toBe(0.05);
    expect(sizeOf({ mode: "instances" })).toBe(0.05);
    expect(sizeOf({ mode: "surface", shape: "mesh" })).toBe(0.05);
    expect(sizeOf({})).toBe(0.05);
    // Nothing else about the schema differs: same keys, in the same order.
    expect(Object.keys(effectiveParameterSchema(geometryNode, { mode: "instances", shape: "mesh" }))).toEqual(Object.keys(effectiveParameterSchema(geometryNode, {})));
    // … and it is what the compile resolves an unset Size to: the resolve pass is handed 1.
    const resolve = passesOf(compile(graph())).find((pass) => pass.id === "geo:instances:resolve");
    expect(resolve?.uniforms?.["scale"]).toEqual([1, 0, 0, 0]);
  });

  it("says which rows apply to a mesh instance (§V146)", () => {
    const parameters = effectiveParameterSchema(geometryNode, { mode: "instances", shape: "mesh" });
    const mesh = { mode: "instances", shape: "mesh" };
    const box = { mode: "instances", shape: "box" };
    // Instance Translate is the mesh instance's own target.
    expect(parameters["instanceTranslate"]?.inactiveWhen?.(mesh)).toBeNull();
    expect(typeof parameters["instanceTranslate"]?.inactiveWhen?.(box)).toBe("string");
    expect(typeof parameters["instanceTranslate"]?.inactiveWhen?.({ mode: "surface" })).toBe("string");
    // The object Transform reaches mesh instances (through their records) and not primitives.
    for (const key of ["translate", "rotate", "objectScale", "pivot"]) {
      expect([key, parameters[key]?.inactiveWhen?.(mesh)]).toEqual([key, null]);
      expect([key, typeof parameters[key]?.inactiveWhen?.(box)]).toEqual([key, "string"]);
    }
    // Mesh is a Shape, and the shape arrives on a second pointset input AFTER points (§V306).
    const shape = parameters["shape"] as { options: ReadonlyArray<{ value: string }> };
    expect(shape.options.map((option) => option.value)).toEqual(["quad", "box", "octahedron", "mesh"]);
    expect(geometryNode.inputs.filter((port) => port.type.kind === "pointset").map((port) => port.id)).toEqual(["points", "mesh"]);
  });

  it("resolves every instance ONCE, in a pass the Geometry owns, however many Renders draw it", () => {
    const compiled = compile(graph({ renders: 2, geometry: { orient: mapped("orient", [0, 0, 0, 1]), scale: mapped("size", 1), tint: mapped("tint", [1, 1, 1, 1]), group: "p.keep > 0.5" } }));
    expect(errors(compiled)).toEqual([]);
    const passes = passesOf(compiled);
    const resolves = passes.filter((pass) => pass.id.includes("instances:resolve"));
    expect(resolves.map((pass) => [pass.id, pass.kind])).toEqual([["geo:instances:resolve", "dispatch"]]);
    // It reads the points' one packed buffer whole and writes the records: two bindings for
    // five mapped things (place, orient, size, tint, the group's attribute).
    expect(resolves[0]?.buffers?.map((buffer) => buffer.binding)).toEqual(["records", "source0"]);
    expect(resolves[0]?.buffers?.[0]?.resourceId).toBe("scratch:geo:instanceRecords");
    // It runs before either Render's draws.
    const firstDraw = passes.findIndex((pass) => pass.kind === "draw" && pass.id.startsWith("shot"));
    expect(passes.findIndex((pass) => pass.id === "geo:instances:resolve")).toBeLessThan(firstDraw);
  });

  it("draws by a buffer per PRODUCER, whatever is mapped (§V588)", () => {
    const plain = passesOf(compile(graph()));
    const loaded = passesOf(compile(graph({ geometry: { instanceTranslate: mapped("place", [0, 0, 0]), orient: mapped("orient", [0, 0, 0, 1]), scale: mapped("size", 1), tint: mapped("tint", [1, 1, 1, 1]), group: "p.keep > 0.5" } })));
    for (const passes of [plain, loaded]) {
      // The lit draw, the Normal layer and the light's sweep of the one geometry.
      const draws = passes.filter((pass): pass is DrawPassDescriptor => pass.kind === "draw" && /^shot0:(scene|gbuffer|shadow:0):0$/.test(pass.id));
      expect(draws.map((pass) => pass.id).sort()).toEqual(["shot0:gbuffer:0", "shot0:scene:0", "shot0:shadow:0:0"]);
      for (const draw of draws) {
        // The shape's packed buffer, the records, the index list — and nothing per attribute.
        expect([draw.id, draw.buffers?.map((buffer) => buffer.binding)]).toEqual([draw.id, ["packed0", "packed1", "meshIndices"]]);
        expect([draw.id, draw.buffers?.map((buffer) => buffer.resourceId)]).toEqual([draw.id, ["scratch:file:meshPoints", "scratch:geo:instanceRecords", "scratch:file:meshIndices"]]);
        // One instance per point, the mesh's 12 triangles each.
        expect([draw.id, draw.instances, draw.vertexCount]).toEqual([draw.id, 16, 36]);
        // The object matrix is already in the records: the draw is handed no model matrix.
        expect([draw.id, draw.uniforms?.["model"]]).toEqual([draw.id, undefined]);
      }
    }
  });

  it("leaves Quad, Box and Octahedron on the generator they had", () => {
    const passes = passesOf(compile(graph({ shape: "none", geometry: { shape: "box" } })));
    expect(passes.some((pass) => pass.id.includes("instances:resolve"))).toBe(false);
    const lit = passes.find((pass) => pass.id === "shot0:scene:0") as DrawPassDescriptor;
    expect(lit.vertexCount).toBe(36);
    expect(lit.buffers?.map((buffer) => buffer.binding)).toEqual(["positions"]);
    expect(String(lit.shader)).toContain("fn shapeVertex(");
    expect(String(lit.shader)).not.toContain("instanceSlot");
  });

  it("refuses by name what it cannot draw (§V288)", () => {
    const refusal = (options: Options, code: string): string => {
      const found = errors(compile(graph(options))).find((d) => d.code === code);
      expect(found, `expected a ${code} refusal`).toBeDefined();
      return found?.message ?? "";
    };
    // Shape: Mesh with nothing on Shape Mesh.
    expect(refusal({ shape: "none" }, "node.scene.shape")).toContain("no mesh arrives on it");
    // A pointset with positions and normals but no triangles is not a shape.
    expect(refusal({ shape: "cloud" }, "node.scene.shape")).toContain("carries points with no triangles, and an instance shape needs a mesh's triangles");
    expect(refusal({ shape: "grid" }, "node.scene.shape")).toContain("carries a grid, and an instance shape needs a mesh's triangles");
    // A Map reads the points, never the shape.
    expect(refusal({ geometry: { tint: mapped("color", [1, 1, 1, 1], { port: "mesh" }) } }, "node.parameter.map")).toContain('tint maps port "mesh", but a Map reads a per-instance value and those are on the Points input');
    // Instance Translate maps a vec3f, and says so when handed something else.
    expect(refusal({ geometry: { instanceTranslate: mapped("orient", [0, 0, 0]) } }, "node.parameter.map")).toContain('instanceTranslate needs a vec3f attribute to map the whole compound; "orient" is vec4f');
    expect(refusal({ geometry: { instanceTranslate: mapped("nowhere", [0, 0, 0]) } }, "node.parameter.map")).toContain('"nowhere", which the incoming pointset does not carry');
    // … and belongs to mesh instances: MAPPED on a primitive it would be dropped, so the map refuses.
    expect(refusal({ shape: "none", geometry: { shape: "box", instanceTranslate: mapped("place", [0, 0, 0]) } }, "node.parameter.map")).toContain("this geometry is box instances and would ignore it");
    // Its constant value there is inactive, not a refusal: a value never decides the plan's structure (§V453).
    expect(errors(compile(graph({ shape: "none", geometry: { shape: "box", instanceTranslate: [1, 0, 0] } })))).toEqual([]);
    // The object Transform still refuses on a primitive, and is taken by a mesh instance.
    expect(refusal({ shape: "none", geometry: { shape: "box", translate: [1, 0, 0] } }, "node.scene.transform")).toContain("a geometry drawing primitive instances does not take it yet");
    expect(errors(compile(graph({ geometry: { translate: [1, 0, 0], rotate: [0, 0, 90] } })))).toEqual([]);
    // Glass on mesh instances is not built: said, not drawn as a box.
    expect(refusal({ material: { type: "materialGlass", parameters: {} } }, "node.scene.glass")).toContain("wears glass as mesh instances, which is not built yet");
  });

  it("reserves the names an instanced draw declares, so a Material · WGSL cannot shadow them", () => {
    for (const name of ["instanceSlot", "recordM0", "recordM2", "recordTint", "meshPositionAt", "meshNormalAt", "meshUvAt", "meshColorAt", "meshSurfaceAt", "meshEmissiveAt"]) {
      expect([name, SURFACE_RESERVED_NAMES.has(name)]).toEqual([name, true]);
    }
    const clash = errors(
      compile(graph({ material: { type: "materialWgsl", parameters: { source: "fn instanceSlot(i: u32) -> u32 { return i; }\nfn surface(s: SurfaceIn, p: Params) -> SurfaceOut { return surfaceDefaults(s); }" } } })),
    );
    expect(clash.map((d) => d.message).join(" ")).toContain('"instanceSlot" is declared by the surface generator');
  });
});

describe("the frame a Mesh File In decodes in (T1581b)", () => {
  it("is a choice on the node, and the loader reports the frame it found", () => {
    const parameters = effectiveParameterSchema(meshFileInNode, {});
    const frame = parameters["frame"] as { default: string; options: ReadonlyArray<{ value: string }> };
    expect(frame.default).toBe("world");
    expect(frame.options.map((option) => option.value)).toEqual(["world", "object", "part"]);
    // Measured, like Vertices and Parts: the loader writes it.
    expect(typeof parameters["frameOrigin"]?.inactiveWhen?.({})).toBe("string");

    const glb = encodeFixtureGlb({ nodes: [{ name: "rig", translation: [0, 2, 0], children: [{ name: "ring one", translation: [1, 0, 0.25], mesh: [cubePrimitive()] }] }] });
    expect(prepareMesh(glb, "")?.facts.frameOrigin).toBe("");
    // The frame node's name (whitespace made safe) and where it stands in the file's world.
    expect(prepareMesh(glb, "", {}, "", "object")?.facts.frameOrigin).toBe("ring_one@1,2,0.25");
  });
});
