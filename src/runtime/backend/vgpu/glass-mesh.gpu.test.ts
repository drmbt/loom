import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { encodeFixtureGlb, type FixturePrimitive } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1357b on a REAL device, exact to the byte (§V147): Material · Glass on an INDEXED MESH.
 * It used to be refused with the grid message — the glass generator was grid-only.
 *
 * The same two exact gates the grid pane has (glass-render.gpu.test.ts), on a file mesh:
 * at ior 1 a polished, non-absorbing pane is byte-identical to the white wall behind it —
 * the refracted sample lands on its own pixel, so the index pull, the file normals and the
 * pyramid read agree to the texel — and Beer-Lambert removes exp(−a·d) per channel.
 *
 * Then the On Nothing lamp cover (T1411b): a glass pane AND an additive emissive shell on
 * the SAME mesh. The shell draws after the glass and passes the glass's own depth, so the
 * pixel is the glass's transmission plus the shell's emission — the lamp refracted, the
 * sheen added, nothing replaced.
 */

const SIZE = 64;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const quad = (half: number, z: number): FixturePrimitive => ({
  positions: [-half, -half, z, half, -half, z, half, half, z, -half, half, z],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  material: 0,
});
const WHITE = [{ name: "white", baseColor: [1, 1, 1, 1] as const }];
const WALL = encodeFixtureGlb({ materials: WHITE, nodes: [{ name: "wall", mesh: [quad(3, -1)] }] });
const PANE = encodeFixtureGlb({ materials: WHITE, nodes: [{ name: "pane", mesh: [quad(1, 0)] }] });
const SHELL_EMISSION = [40, 80, 120] as const;
const SHELL_WGSL = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.emissive = vec3f(${SHELL_EMISSION.map((value) => `${value}.0 / 255.0`).join(", ")});
  return o;
}`;

function graph(glass: Record<string, unknown>, shell: boolean): GraphDocument {
  const wallFacts = prepareMesh(WALL, "")!.facts;
  const paneFacts = prepareMesh(PANE, "")!.facts;
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
  const nodes = [
    node("wallMesh", "meshFileIn", { vertices: wallFacts.vertices, triangles: wallFacts.triangles, parts: wallFacts.parts }, "wallmesh1"),
    node("white", "materialUnlit", { color: [1, 1, 1, 1] }, "white1"),
    node("wall", "geometry", { mode: "surface", material: "white1" }, "wall1"),
    node("paneMesh", "meshFileIn", { vertices: paneFacts.vertices, triangles: paneFacts.triangles, parts: paneFacts.parts }, "panemesh1"),
    node("glassMat", "materialGlass", glass, "glassmat1"),
    node("pane", "geometry", { mode: "surface", material: "glassmat1" }, "pane1"),
    node("shellMat", "materialWgsl", { model: "unlit", source: SHELL_WGSL }, "shellmat1"),
    node("shell", "geometry", { mode: "surface", material: "shellmat1", blend: "additive" }, "shell1"),
    node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
    node("shot", "render", { scenes: shell ? "shell1 wall1 pane1" : "wall1 pane1", camera: "cam1", lights: "", background: [0, 0, 0, 1] }, "shot1"),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "wallMesh", portId: "out" }, target: { nodeId: "wall", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "paneMesh", portId: "out" }, target: { nodeId: "pane", portId: "points" } },
      // The shell is the SAME mesh as the pane: one Mesh File In feeding both geometries.
      e3: { id: "e3", source: { nodeId: "paneMesh", portId: "out" }, target: { nodeId: "shell", portId: "points" } },
      e4: { id: "e4", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function render(glass: Record<string, unknown>, shell = false): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(glass, shell),
    settings: SETTINGS,
    frames: 1,
    outputNodeId: "shot",
    outputPortId: "out",
    meshes: { wallMesh: WALL, paneMesh: PANE },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames[0]!.bytes;
}

const at = (x: number, y: number): number => (y * SIZE + x) * 4;
const rgba = (bytes: Uint8Array, index: number): number[] => Array.from(bytes.subarray(index, index + 4));
const CENTRE = at(32, 32);
/** Near the frame corner: the wall seen directly, beside the pane (±1 at z = 0 spans ~±0.58 NDC). */
const BESIDE = at(3, 32);

describe("glass on a mesh (T1357b, §V147)", () => {
  it("ior 1, no absorption: the mesh pane is byte-identical to the wall behind it", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const image = await render({ ior: 1, roughness: 0, thickness: 1, absorption: [0, 0, 0, 1], dispersion: 0 });
    expect(rgba(image, CENTRE)).toEqual([255, 255, 255, 255]);
    expect(rgba(image, BESIDE)).toEqual([255, 255, 255, 255]);
  }, 60_000);

  it("Beer-Lambert removes per channel through the mesh: exp(−1) on red, green and blue untouched", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const image = await render({ ior: 1, roughness: 0, thickness: 1, absorption: [1, 0, 0, 1], dispersion: 0 });
    expect(rgba(image, CENTRE)).toEqual([Math.round(255 * Math.exp(-1)), 255, 255, 255]);
    // Beside the pane the wall is seen directly — the §V361 control in the same frame.
    expect(rgba(image, BESIDE)).toEqual([255, 255, 255, 255]);
  }, 60_000);

  it("a lamp cover: glass transmission + an additive shell on the same mesh, summed to the byte (T1411b)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const glass = { ior: 1, roughness: 0, thickness: 1, absorption: [1, 1, 1, 1], dispersion: 0 };
    const bare = await render(glass);
    const transmitted = Math.round(255 * Math.exp(-1));
    expect(rgba(bare, CENTRE)).toEqual([transmitted, transmitted, transmitted, 255]);
    // Listed FIRST, drawn last: the shell passes the pane's own depth and adds; the pane's
    // transmission underneath is untouched, and the wall beside it takes nothing.
    const covered = await render(glass, true);
    expect(rgba(covered, CENTRE)).toEqual([transmitted + SHELL_EMISSION[0], transmitted + SHELL_EMISSION[1], transmitted + SHELL_EMISSION[2], 255]);
    expect(rgba(covered, BESIDE)).toEqual([255, 255, 255, 255]);
  }, 60_000);
});
