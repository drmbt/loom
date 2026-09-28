import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../../tests/headless/pixel-compare.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1417b on a REAL device (§V147): a Render's LIGHT DEPTH output, read by a Custom WGSL
 * through `// @use light-depth`, answers "does the light reach this world point" the way the
 * light sees it — for points the camera never sees.
 *
 * The scene: a white floor and a unit box standing 0.5..1.5 m over it (mesh-render's). The
 * probe pass maps its output row along a line 5 cm over the floor (clear of the floor's own
 * depth, which a nearest lookup at a grazing angle would read as an occluder), x from −2 to 3 m,
 * and writes the lookup's answer. The shadow's extent is analytic:
 *  - a POINT light at (1, 4, 0), off-centre so a mirrored lookup cannot pass: a point
 *    (x, 0.05, 0) is hidden when its ray to the lamp, at x + (1 − x)·(y − 0.05)/3.95 at height
 *    y, is within ±0.5 somewhere in y = 0.5..1.5 — the low end reaches +0.5 at x ≈ 0.436, the
 *    high end −0.5 at x ≈ −1.370;
 *  - a DIRECTIONAL light travelling (1, −1, 0)/√2: (x, 0.05, 0) looks back up (−1, 1, 0), so
 *    it is hidden when x − (y − 0.05) ∈ [−0.5, 0.5] for some y in 0.5..1.5: x ∈ [−0.05, 1.95].
 * Columns within one map texel's reach of an edge are not asserted (a nearest lookup there is
 * either answer); every other column is exactly 0 or 1.
 */

const W = 128;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: W, height: 8 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const GLB = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "floor", mesh: [{ positions: [-3, 0, -3, 3, 0, -3, 3, 0, 3, -3, 0, 3], normals: [0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0], indices: [0, 2, 1, 0, 3, 2], material: 0 }] },
    { name: "box", translation: [0, 1, 0], mesh: [cubePrimitive(0)] },
  ],
});

const probeSource = (lookup: string): string => `// @use light-depth
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let unused = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).a * 0.0;
  let p = vec3f(mix(-2.0, 3.0, uv.x), 0.05, 0.0);
  let lit = ${lookup};
  return vec4f(lit + unused, 0.0, 0.0, 1.0);
}`;

const node = (id: string, type: string, parameters: Record<string, unknown>, label?: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  ...(label === undefined ? {} : { label }),
});

function graph(light: Record<string, unknown>, lookup: string, renderSize: readonly [number, number]): GraphDocument {
  const facts = prepareMesh(GLB, "")!.facts;
  const nodes = [
    node("mesh", "meshFileIn", { vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts }, "mesh1"),
    node("geo", "geometry", { mode: "surface" }, "geo1"),
    node("cam", "camera", { eye: [0, 7, 0.01], lookAt: [0, 0, 0] }, "cam1"),
    node("key", "light", { intensity: 1, shadows: true, shadowSoftness: 0, ...light }, "key1"),
    {
      ...node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "key1", lightDepthOutput: true }, "shot1"),
      resolution: { mode: "fixed", width: renderSize[0], height: renderSize[1] },
    },
    // The probe's own size, not its input's: one texel per sampled floor point.
    { ...node("probe", "customWgslMulti", { source: probeSource(lookup) }, "probe1"), resolution: { mode: "fixed", width: W, height: 8 } },
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "probe", portId: "input" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "lightDepth" }, target: { nodeId: "probe", portId: "more" } },
      e4: { id: "e4", source: { nodeId: "probe", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function row(document: GraphDocument): Promise<number[]> {
  const result = await renderHeadless({ host: nodeGpuHost(), graph: document, settings: SETTINGS, frames: 1, outputNodeId: "probe", meshes: { mesh: GLB } });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  const values = decodeComponents(frame.bytes, frame.format);
  return Array.from({ length: W }, (_, x) => values[(4 * W + x) * 4]!);
}

/** Every column clear of the shadow's edges by `margin` metres: 0 inside [from, to], 1 outside. */
function expectShadow(lit: number[], from: number, to: number, margin: number): void {
  let asserted = 0;
  lit.forEach((value, x) => {
    const at = -2 + ((x + 0.5) / W) * 5;
    if (Math.abs(at - from) < margin || Math.abs(at - to) < margin) return;
    expect(value, `x = ${at.toFixed(3)} m`).toBe(at > from && at < to ? 0 : 1);
    asserted += 1;
  });
  expect(asserted).toBeGreaterThan(W * 0.8);
}

describe("a Render's Light Depth output, read by // @use light-depth (T1417b, §V147)", () => {
  it("a point light's cube atlas: the floor is hidden from the lamp for x in −1.37..0.44 m and lit beyond", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // 768×512: 256-texel faces; the −Y face spans 8 m of floor at 4 m, 3 cm a texel.
    const lit = await row(graph({ kind: "point", position: [1, 4, 0], shadowExtent: 8 }, "lightDepthPointVisible(inputTexture1, vec3f(1.0, 4.0, 0.0), 8.0, p, 0.02)", [768, 512]));
    const at = (height: number): number => (height - 0.05) / 3.95;
    expectShadow(lit, (-0.5 - at(1.5)) / (1 - at(1.5)), (0.5 - at(0.5)) / (1 - at(0.5)), 0.06);
  }, 60_000);

  it("a directional light's ortho map: the floor is hidden for x in −0.05..1.95 m", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // Extent 4: an 8 m square volume over 512 texels, 1.6 cm a texel.
    const lit = await row(graph({ kind: "directional", direction: [1, -1, 0], shadowExtent: 4 }, "lightDepthDirectionalVisible(inputTexture1, vec3f(1.0, -1.0, 0.0), 4.0, p, 0.02)", [512, 512]));
    expectShadow(lit, -0.05, 1.95, 0.06);
  }, 60_000);

  it("refuses Light Depth Output with no casting light, by name", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    await expect(
      row(graph({ kind: "point", position: [0, 4, 0], shadows: false }, "lightDepthPointVisible(inputTexture1, vec3f(0.0, 4.0, 0.0), 8.0, p, 0.02)", [768, 512])),
    ).rejects.toThrow(/no light in Lights casts shadows/);
  }, 60_000);

});
