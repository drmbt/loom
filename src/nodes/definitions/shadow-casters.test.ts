import { describe, expect, it } from "vitest";

import { compileGraph, compiledWithoutCatalogue, isUniformOnlyChange } from "../../compiler/index.ts";
import { prepareFrameCompiler } from "../../compiler/frame-compile.ts";
import { graphChannelResolver } from "../../domain/channels/graph-channels.ts";
import { rewriteNodeNameReferences } from "../../domain/graph/names.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { formatMeshBounds, parseMeshBounds, prepareMesh } from "../../points/mesh.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { CASTERS_GLB, castersScene, sweepDraws, type CastersScene, type SweepDraw } from "./shadow-casters.fixture.ts";

/**
 * T1598b — WHICH GEOMETRY A LIGHT'S SHADOW SWEEP DRAWS, at the plan (no GPU).
 *
 * A casting light used to sweep every geometry the Render names, a point light six times.
 * Two things now take draws out, and they are different in kind:
 *
 *  - THE LIGHT'S LISTS (Shadow Casters, Shadow Exclude): the author's knowledge that a
 *    geometry never casts for this light. Structure — the draws do not exist.
 *  - REACH: a geometry whose bound lies beyond the light's shadow range, or outside one
 *    face's quarter of space, this frame. A value — the draws exist and are skipped.
 *
 * What the pictures look like is `shadow-casters.gpu.test.ts`'s claim, on Dawn, over the
 * same scene (`shadow-casters.fixture.ts`).
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 128, height: 128 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;
const CAPABILITIES = { tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"], timestampQuery: false, limits: { maxTextureDimension2D: 8192 } } as never;

const compile = (graph: GraphDocument) => compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
const compiled = (options: CastersScene = {}) => {
  const plan = compile(castersScene(options));
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return plan;
};

const TOP = 0;
const SIDE = 1;
/** The roles one light's sweep has a draw for at all (the lists), in draw order, once. */
const casters = (draws: ReadonlyArray<SweepDraw>, light: number): string[] => [...new Set(draws.filter((draw) => draw.light === light).map((draw) => draw.role))];
/** The faces of one light's sweep that are ENCODED for a role (drawn, not skipped). */
const faces = (draws: ReadonlyArray<SweepDraw>, light: number, role: string): number[] =>
  draws.filter((draw) => draw.light === light && draw.role === role && !draw.skip).map((draw) => draw.face);
/** How many draws a role has in one light's sweep, skipped or not: six per caster of a point light. */
const emitted = (draws: ReadonlyArray<SweepDraw>, light: number, role: string): number => draws.filter((draw) => draw.light === light && draw.role === role).length;

describe("T1598b: a light's Shadow Casters and Shadow Exclude choose its sweep's draws", () => {
  it("with neither, every geometry the Render draws is a caster of every light", () => {
    const draws = sweepDraws(compiled().passes);
    expect(casters(draws, TOP)).toEqual(["floor", "box", "lid", "far"]);
    expect(casters(draws, SIDE)).toEqual(["floor", "box", "lid", "far"]);
    expect(draws).toHaveLength(2 * 6 * 4);
  });

  it("an excluded geometry is in no draw of THAT light's sweep, and in the other light's as before", () => {
    const draws = sweepDraws(compiled({ top: { shadowExclude: "geometry_box" } }).passes);
    expect(casters(draws, TOP)).toEqual(["floor", "lid", "far"]);
    expect(emitted(draws, TOP, "box")).toBe(0);
    // Per light: the side light never heard of the list.
    expect(casters(draws, SIDE)).toEqual(["floor", "box", "lid", "far"]);
    expect(emitted(draws, SIDE, "box")).toBe(6);
  });

  it("Shadow Casters keeps only what it names; Shadow Exclude then takes out of that, and wins", () => {
    const only = sweepDraws(compiled({ top: { shadowCasters: "geometry_lid, geometry_box" } }).passes);
    // Draw order stays the Render's Scenes order, not the list's.
    expect(casters(only, TOP)).toEqual(["box", "lid"]);
    const both = sweepDraws(compiled({ top: { shadowCasters: "geometry_lid geometry_box", shadowExclude: "geometry_lid" } }).passes);
    expect(casters(both, TOP)).toEqual(["box"]);
  });

  it("the Light Depth output draws the casters of the shadow it mirrors", () => {
    const graph = castersScene({ top: { shadowExclude: "geometry_box" }, render: { lightDepthOutput: true } });
    // The port is read by a preview, as the editor's tile reads it.
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES, sinks: [{ nodeId: "render_shot", portId: "lightDepth", kind: "preview" }] });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const mirrored = plan.passes.flatMap((pass) => {
      const match = /:lightDepth:face(\d):(\d+)$/.exec(pass.id);
      return match === null ? [] : [Number(match[2])];
    });
    // Geometry 1 is the box: in none of the six faces. The other three are in all of them.
    expect([...new Set(mirrored)]).toEqual([0, 2, 3]);
    expect(mirrored).toHaveLength(18);
  });

  it("says so when the lists leave a light nothing to cast in this Render, and is quiet otherwise", () => {
    const warned = (options: CastersScene) => compiled(options).diagnostics.filter((d) => d.code === "node.scene.shadowCasters");
    expect(warned({ top: { shadowExclude: "geometry_box" } })).toEqual([]);
    const none = warned({ top: { shadowExclude: "geometry_floor geometry_box geometry_lid geometry_far" } });
    expect(none.map((d) => [d.severity, d.nodeId, d.message])).toEqual([
      ["warning", "render_shot", 'Node "render_shot": light "light_top" casts no shadow here — its Shadow Casters and Shadow Exclude leave none of this Render\'s geometries.'],
    ]);
  });

  it("refuses a name that is no node, and a name that is not a geometry, in the reference's own words", () => {
    const errors = (top: Record<string, unknown>) =>
      compile(castersScene({ top }))
        .diagnostics.filter((d) => d.severity === "error")
        .map((d) => d.message);
    expect(errors({ shadowExclude: "geometry_nope" })).toContain('Node "light_top" (light) names shadowExclude "geometry_nope", which no node in the document is called.');
    expect(errors({ shadowCasters: "camera_shot" })).toContain('Node "light_top" (light) names shadowCasters "camera_shot", but "camera_shot" is a camera and publishes no scene.');
  });

  it("follows a rename: the list is a reference, not text (§V128)", () => {
    const graph = castersScene({ top: { shadowCasters: "geometry_lid geometry_box", shadowExclude: "geometry_box" } });
    // Two parameters of one node hold the name; the Render's Scenes is the third.
    expect(rewriteNodeNameReferences(graph, "geometry_box", "geometry_crate")).toBe(3);
    const top = (graph as unknown as { nodes: Record<string, { parameters: Record<string, unknown> }> }).nodes["light_top"]!.parameters;
    expect([top["shadowCasters"], top["shadowExclude"]]).toEqual(["geometry_lid geometry_crate", "geometry_crate"]);
  });
});

describe("T1598b: a caster a point light cannot reach this frame is skipped, face by face", () => {
  it("each geometry is encoded only in the faces its bound touches, and the far cube in none", () => {
    const draws = sweepDraws(compiled().passes);
    // Faces are +X −X +Y −Y +Z −Z. The top light hangs over the box: only −Y sees the box and the lid.
    expect(faces(draws, TOP, "floor")).toEqual([0, 1, 2, 3, 4, 5]);
    expect(faces(draws, TOP, "box")).toEqual([3]);
    expect(faces(draws, TOP, "lid")).toEqual([3]);
    expect(faces(draws, TOP, "far")).toEqual([]);
    // The side light looks along +X at the lid (level with it) and down-and-along at the box.
    expect(faces(draws, SIDE, "floor")).toEqual([0, 1, 2, 3, 4, 5]);
    expect(faces(draws, SIDE, "box")).toEqual([0, 3]);
    expect(faces(draws, SIDE, "lid")).toEqual([0]);
    expect(faces(draws, SIDE, "far")).toEqual([]);
    // Skipped, not absent: where things stand is a value, so the pass list is the same (§V453).
    expect(draws).toHaveLength(2 * 6 * 4);
  });

  it("a geometry with no bound is always drawn: no measured sphere, or a kernel between the file and the Geometry", () => {
    const unmeasured = sweepDraws(compiled({ mesh: { far: { bounds: "" } } }).passes);
    expect(faces(unmeasured, TOP, "far")).toEqual([0, 1, 2, 3, 4, 5]);
    // A kernel may move every vertex; nothing on the CPU knows where to.
    const moved = sweepDraws(compiled({ throughKernel: ["far"] }).passes);
    expect(faces(moved, TOP, "far")).toEqual([0, 1, 2, 3, 4, 5]);
    // The guard did not swallow the others.
    expect(faces(moved, TOP, "box")).toEqual([3]);
  });

  it("only a Surface has a bound: instances at the mesh's vertices, and a mesh a clip is posing, are always drawn", () => {
    // A box at each of the far cube's vertices reaches past the vertices' own sphere; nothing here bounds that.
    const instanced = sweepDraws(compiled({ geometry: { far: { mode: "instances", shape: "box", scale: 0.25 } } }).passes);
    expect(faces(instanced, TOP, "far")).toEqual([0, 1, 2, 3, 4, 5]);
    // A clip poses the vertices on the GPU, so the measured sphere (the rest pose's) says nothing about them.
    const posed = sweepDraws(compiled({ mesh: { far: { joints: "0:root@0,0,0", clips: "walk", clip: "walk", clipFrames: 4 } } }).passes);
    expect(faces(posed, TOP, "far")).toEqual([0, 1, 2, 3, 4, 5]);
    // The same skinned mesh at rest keeps its bound: it is the clip that takes it away.
    const rest = sweepDraws(compiled({ mesh: { far: { joints: "0:root@0,0,0", clips: "walk" } } }).passes);
    expect(faces(rest, TOP, "far")).toEqual([]);
  });

  it("the bound goes through the Geometry's Transform: moved into range it is drawn, scaled up to hold the light it is in every face", () => {
    // The far cube stands at x = 30. Brought to x = 2.5 it is beside the box, under the top light's +X and −Y faces.
    const near = sweepDraws(compiled({ geometry: { far: { translate: [-27.5, 0, 0] } } }).passes);
    expect(faces(near, TOP, "far")).toEqual([0, 3]);
    // Forty times the size about its own centre: its sphere (0.87 m) becomes 35 m and holds both lights.
    const huge = sweepDraws(compiled({ geometry: { far: { pivot: [30, 1, 0], objectScale: [40, 40, 40] } } }).passes);
    expect(faces(huge, TOP, "far")).toEqual([0, 1, 2, 3, 4, 5]);
    expect(faces(huge, SIDE, "far")).toEqual([0, 1, 2, 3, 4, 5]);
    // A longer shadow range reaches it where it stands: 30.15 m from the top light, less its 0.87 m sphere, is 29.28.
    const long = sweepDraws(compiled({ top: { shadowExtent: 29.3 } }).passes);
    expect(faces(long, TOP, "far")).toEqual([0]);
    expect(faces(sweepDraws(compiled({ top: { shadowExtent: 29.2 } }).passes), TOP, "far")).toEqual([]);
  });

  it("is a VALUE: a driven Transform flips the skips on a values-only frame, with the structure untouched", () => {
    const frameAt = (frameIndex: number): FrameEvaluationInput => ({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 });
    // 27.5 m a frame towards the lights: out of range at frame 0, beside the box at frame 1.
    const graph = castersScene({ geometry: { far: { "translate.x": expressionSlot("-abstime * 60 * 27.5", 0) } } });
    const channels = graphChannelResolver(compiledWithoutCatalogue(graph), registry);
    const prepared = prepareFrameCompiler({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES, resolution: { frame: frameAt(0), channels } });
    expect(prepared.base.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);
    expect(faces(sweepDraws(prepared.base.passes), TOP, "far")).toEqual([]);

    const next = prepared.compileFrame({ frame: frameAt(1), channels });
    expect(next, prepared.reason ?? "").not.toBeNull();
    if (next === null) return;
    expect(faces(sweepDraws(next.passes), TOP, "far")).toEqual([0, 3]);
    // Nothing structural moved: this is the frame the uniform animator pushes.
    expect(isUniformOnlyChange(prepared.base, next)).toBe(true);
    // And the frame is the full compile's at that moment, skips included.
    const full = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES, resolution: { frame: frameAt(1), channels } });
    expect(sweepDraws(next.passes)).toEqual(sweepDraws(full.passes));
  });
});

describe("T1598b: the sphere a Mesh File In measures", () => {
  it("is the middle of the vertices' box and reaches the furthest vertex, rounded up", () => {
    const facts = (select: string) => prepareMesh(CASTERS_GLB, select)!.facts.bounds;
    // The floor: 8 × 8 m about the origin, corner to centre 4·√2 = 5.65685…
    expect(facts("floor")).toBe("0,0,0,5.6569");
    // The box, 2 × 1 × 2 at (0, 1, 0): half-diagonal √(1 + 0.25 + 1) = 1.5 exactly, never written smaller.
    expect(facts("box")).toBe("0,1,0,1.5001");
    expect(facts("far")).toBe("30,1,0,0.8661");
  });

  it("holds every vertex, as text: what is parsed back is never smaller than what was measured", () => {
    let state = 12345;
    const random = (): number => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      return state / 0x100000000;
    };
    for (let trial = 0; trial < 200; trial += 1) {
      const count = 1 + Math.floor(random() * 20);
      const positions = new Float32Array(count * 3).map(() => (random() - 0.5) * 200 * random());
      const sphere = parseMeshBounds(formatMeshBounds(positions, count));
      expect(sphere).toBeDefined();
      if (sphere === undefined) return;
      for (let vertex = 0; vertex < count; vertex += 1) {
        const distance = Math.hypot(positions[vertex * 3]! - sphere.center[0], positions[vertex * 3 + 1]! - sphere.center[1], positions[vertex * 3 + 2]! - sphere.center[2]);
        expect(distance).toBeLessThanOrEqual(sphere.radius);
      }
    }
  });

  it("reads nothing out of text that is not a sphere, so such a mesh is always drawn", () => {
    expect(parseMeshBounds("")).toBeUndefined();
    expect(parseMeshBounds("1,2,3")).toBeUndefined();
    expect(parseMeshBounds("1,2,3,-1")).toBeUndefined();
    expect(parseMeshBounds("1,2,x,4")).toBeUndefined();
    expect(parseMeshBounds(7)).toBeUndefined();
    expect(parseMeshBounds("1,2,3,0.5")).toEqual({ center: [1, 2, 3], radius: 0.5 });
    expect(formatMeshBounds(new Float32Array(0), 0)).toBe("");
  });
});
