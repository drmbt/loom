import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { LAMP_AT_WALL, RING_LOW_TRIANGLES, RING_TRIANGLES, SUN_AT_WALL, shadowMeshScene, type ShadowMeshScene } from "./shadow-mesh.fixture.ts";

/**
 * T1689b — A GEOMETRY'S SHADOW MESH, at the plan (no GPU).
 *
 * A Geometry that draws a mesh at every point takes a second, lighter mesh on its Shadow Mesh
 * input, and every sweep that asks what stands between a source of light and a surface draws
 * that one in the shape's place: a casting light's shadow passes (a point light's six), the
 * Light Depth output, a projector's occlusion. The same instance records place both, so the
 * instances and their transforms are the shape's. What the camera sees reads the shape.
 *
 * Here: which draws take which mesh, by the triangles they draw and the buffers they bind;
 * the second set of indirect arguments a geometry that leaves instances out needs; what is
 * refused and what is remarked on; that Shadow On and a light's caster lists still decide
 * whether a sweep's draw happens. What the pictures are is `vgpu/shadow-mesh.gpu.test.ts`'s.
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
const compile = (scene: ShadowMeshScene, sinks: ReadonlyArray<string> = []) =>
  compileGraph({ graph: shadowMeshScene(scene) as GraphDocument, settings, registry, capabilities: TIER_B_CAPABILITIES, sinks: sinks.map((portId) => ({ nodeId: "render_shot", portId, kind: "preview" })) } as never);
const errors = (plan: { diagnostics: ReadonlyArray<{ severity: string }> }) => plan.diagnostics.filter((entry) => entry.severity === "error");
type AnyPass = { readonly id: string; readonly kind: string; readonly vertexCount?: number; readonly instances?: unknown; readonly skip?: boolean; readonly shader?: string; readonly buffers?: ReadonlyArray<{ binding: string; resourceId: string }>; readonly uniforms?: Record<string, unknown> };
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);
/** The draws of the rings (the Render's second geometry), by what they are: `[pass, triangles]`. */
const ringDraws = (plan: { passes: ReadonlyArray<unknown> }): Array<[string, number]> =>
  (plan.passes as AnyPass[]).filter((pass) => pass.kind === "draw" && /:1$/.test(pass.id)).map((pass) => [bare(pass.id).replace("render_shot:", "").replace(/:1$/, ""), (pass.vertexCount ?? 0) / 3]);
const passOf = (plan: { passes: ReadonlyArray<unknown> }, id: string): AnyPass => {
  const found = (plan.passes as AnyPass[]).find((pass) => bare(pass.id) === id);
  if (found === undefined) throw new Error(`no pass "${id}" among ${(plan.passes as AnyPass[]).map((pass) => bare(pass.id)).join(", ")}`);
  return found;
};

describe("T1689b: the sweeps of light draw the shadow mesh, and what the camera sees draws the shape", () => {
  it("with no shadow mesh every draw of the rings is the shape, 720 triangles", () => {
    const plan = compile({ lights: [SUN_AT_WALL], render: { normalOutput: true } }, ["normal"]);
    expect(errors(plan)).toEqual([]);
    expect(ringDraws(plan)).toEqual([["shadow:0", RING_TRIANGLES], ["scene", RING_TRIANGLES], ["gbuffer", RING_TRIANGLES]]);
  });

  it("a sun's sweep draws the shadow mesh's 180 triangles; the lit draw and the Normal layer draw the shape's 720", () => {
    const plan = compile({ proxy: "mesh_low", lights: [SUN_AT_WALL], render: { normalOutput: true } }, ["normal"]);
    expect(errors(plan)).toEqual([]);
    expect(ringDraws(plan)).toEqual([["shadow:0", RING_LOW_TRIANGLES], ["scene", RING_TRIANGLES], ["gbuffer", RING_TRIANGLES]]);
    // The sweep binds the shadow mesh's own vertices and index list, and the SAME records: the same instances at the same places.
    const buffers = (id: string) => passOf(plan, id).buffers?.map((buffer) => buffer.resourceId);
    expect(buffers("render_shot:shadow:0:1")).toEqual(["scratch:mesh_low:meshPoints", "scratch:geometry_rings:instanceRecords", "scratch:mesh_low:meshIndices"]);
    expect(buffers("render_shot:scene:1")?.slice(0, 3)).toEqual(["scratch:mesh_ring:meshPoints", "scratch:geometry_rings:instanceRecords", "scratch:mesh_ring:meshIndices"]);
    // The same count of instances, said the same way.
    expect(passOf(plan, "render_shot:shadow:0:1").instances).toEqual(passOf(plan, "render_shot:scene:1").instances);
  });

  it("a point light's six faces each draw the shadow mesh", () => {
    const plan = compile({ proxy: "mesh_low", lights: [LAMP_AT_WALL] });
    expect(errors(plan)).toEqual([]);
    expect(ringDraws(plan)).toEqual([...[0, 1, 2, 3, 4, 5].map((face): [string, number] => [`shadow:0:face${face}`, RING_LOW_TRIANGLES]), ["scene", RING_TRIANGLES]]);
  });

  it("the Light Depth output is that light's map as data, so the shadow mesh; the camera's Depth output and its occlusion prepass are what the camera sees, so the shape", () => {
    const plan = compile({ proxy: "mesh_low", lights: [SUN_AT_WALL], render: { lightDepthOutput: true, depthOutput: true, ambientOcclusion: true } }, ["lightDepth", "depth"]);
    expect(errors(plan)).toEqual([]);
    const draws = new Map(ringDraws(plan));
    expect(draws.get("lightDepth")).toBe(RING_LOW_TRIANGLES);
    expect(draws.get("shadow:0")).toBe(RING_LOW_TRIANGLES);
    expect(draws.get("depthOut")).toBe(RING_TRIANGLES);
    expect(draws.get("ao:depth")).toBe(RING_TRIANGLES);
    expect(draws.get("scene")).toBe(RING_TRIANGLES);
  });

  it("a projector's occlusion sweep is a shadow of projected light: it draws the shadow mesh", () => {
    const projector = { eye: [0, 0, 8], lookAt: [0, 0, 0], occlusion: true };
    const withProxy = compile({ proxy: "mesh_low", lights: [], projector });
    expect(errors(withProxy)).toEqual([]);
    expect(new Map(ringDraws(withProxy)).get("projector:0")).toBe(RING_LOW_TRIANGLES);
    expect(new Map(ringDraws(compile({ lights: [], projector }))).get("projector:0")).toBe(RING_TRIANGLES);
  });
});

describe("T1689b: a geometry that leaves instances out draws the shadow mesh by arguments of its own", () => {
  const GROUPED = { geometry: { group: "p.keep > 0.5" }, rings: 4, lights: [SUN_AT_WALL] };

  it("the resolve pass writes a second set: the shadow mesh's vertex count, the same instance count", () => {
    const plan = compile({ ...GROUPED, proxy: "mesh_low" });
    expect(errors(plan)).toEqual([]);
    expect(passOf(plan, "render_shot:scene:1").instances).toEqual({ indirect: "scratch:geometry_rings:instanceArgs" });
    expect(passOf(plan, "render_shot:shadow:0:1").instances).toEqual({ indirect: "scratch:geometry_rings:instanceShadowArgs" });
    const resolve = passOf(plan, "geometry_rings:instances:resolve");
    expect(resolve.buffers?.map((buffer) => buffer.binding)).toEqual(["records", "drawArgs", "source0", "shadowDrawArgs"]);
    expect([resolve.uniforms?.["vertexCount"], resolve.uniforms?.["shadowVertexCount"]]).toEqual([RING_TRIANGLES * 3, RING_LOW_TRIANGLES * 3]);
    // Both sets are written where the count is known, with the one count.
    const text = String(resolve.shader);
    expect(text).toContain("drawArgs[0] = params.vertexCount;\n    drawArgs[1] = at;");
    expect(text).toContain("shadowDrawArgs[0] = params.shadowVertexCount;\n    shadowDrawArgs[1] = at;");
  });

  it("with no shadow mesh the resolve pass is the pass it was: no second arguments, in its text or its bindings", () => {
    const resolve = passOf(compile(GROUPED), "geometry_rings:instances:resolve");
    expect(resolve.buffers?.map((buffer) => buffer.binding)).toEqual(["records", "drawArgs", "source0"]);
    expect(String(resolve.shader)).not.toContain("shadow");
    expect(resolve.uniforms?.["shadowVertexCount"]).toBeUndefined();
  });

  it("a geometry that draws every point needs none: a literal count for both meshes", () => {
    const plan = compile({ proxy: "mesh_low", rings: 4, lights: [SUN_AT_WALL] });
    expect([passOf(plan, "render_shot:scene:1").instances, passOf(plan, "render_shot:shadow:0:1").instances]).toEqual([4, 4]);
    expect(passOf(plan, "geometry_rings:instances:resolve").buffers?.map((buffer) => buffer.binding)).toEqual(["records", "source0"]);
  });
});

describe("T1689b: what decides whether a sweep's draw happens is what decided it", () => {
  it("Shadow On off skips the shadow mesh's draw as it skipped the shape's", () => {
    const plan = compile({ proxy: "mesh_low", lights: [{ ...SUN_AT_WALL, shadowOn: false }] });
    expect(passOf(plan, "render_shot:shadow:0:1").skip).toBe(true);
    expect(passOf(compile({ proxy: "mesh_low", lights: [SUN_AT_WALL] }), "render_shot:shadow:0:1").skip).toBeUndefined();
  });

  it("a light's Shadow Exclude takes the geometry out of its sweep, shadow mesh and all", () => {
    const plan = compile({ proxy: "mesh_low", lights: [{ ...SUN_AT_WALL, shadowExclude: "geometry_rings" }] });
    expect(errors(plan)).toEqual([]);
    expect(ringDraws(plan).map(([id]) => id)).toEqual(["scene"]);
  });
});

describe("T1689b: what the node says about its Shadow Mesh", () => {
  const said = (scene: ShadowMeshScene) => compile(scene).diagnostics.filter((entry) => entry.code.startsWith("node.scene.shadowMesh")).map((entry) => [entry.severity, entry.code, entry.nodeId]);

  it("nothing, for a shadow mesh in the shape's frame", () => {
    expect(said({ proxy: "mesh_low" })).toEqual([]);
    expect(said({ proxy: "mesh_ring" })).toEqual([]);
    expect(said({})).toEqual([]);
  });

  it("refuses a Shadow Mesh that carries no triangles, by name", () => {
    const plan = compile({ proxy: "grid_plain" });
    expect(said({ proxy: "grid_plain" })).toEqual([["error", "node.scene.shadowMesh", "geometry_rings"]]);
    expect(plan.diagnostics.find((entry) => entry.code === "node.scene.shadowMesh")?.message).toContain("the Shadow Mesh input carries no mesh triangles");
  });

  it("remarks on one that stands apart from the shape (another Frame), with both spheres, and still draws it", () => {
    const plan = compile({ proxy: "mesh_off" });
    expect(said({ proxy: "mesh_off" })).toEqual([["warning", "node.scene.shadowMeshFit", "geometry_rings"]]);
    const message = plan.diagnostics.find((entry) => entry.code === "node.scene.shadowMeshFit")?.message ?? "";
    // Three metres off, give or take what a bounding sphere fitted to another mesh's vertices is off by; the shape's own reach is 1.9.
    expect(message).toMatch(/its centre is 3\.0\d from the shape's, whose radius is 1\.90\./);
    expect(errors(plan)).toEqual([]);
    expect(new Map(ringDraws(plan)).get("shadow:0")).toBe(RING_LOW_TRIANGLES);
  });

  it("is read in no other mode, as the Shape Mesh is: a Geometry that draws a built-in shape casts that shape, and says nothing", () => {
    /* An optional input that a mode does not read is silent across the catalogue (the Shape
       Mesh itself, a Light's Points): the port's description carries the sentence. */
    const scene = { proxy: "mesh_low", geometry: { shape: "box" } };
    expect(said(scene)).toEqual([]);
    const plan = compile(scene);
    expect(errors(plan)).toEqual([]);
    // Twelve triangles: the built-in box, in the sweep as in the lit draw.
    expect(ringDraws(plan)).toEqual([["shadow:0", 12], ["scene", 12]]);
  });
});
