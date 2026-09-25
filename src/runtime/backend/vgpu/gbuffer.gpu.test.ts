import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1371b on a REAL device, exact to the byte (§V147): the Render's Normal output is the
 * SHADED normal and roughness. A cube faces the camera: its front face writes (0,0,1)
 * encoded as (128,128,255) and the file's roughness 0.6 as 153; the background is zero
 * ("no surface"). Then a Material · WGSL bends the normal to +Y — the G-buffer must carry
 * the MATERIAL's normal (128,255,128), which only running the material code can produce.
 *
 * T1380b, the Albedo output: the same cube writes the colour the lit draw shades with —
 * the default material's 0.8 base × the file's (0.2, 0.4, 0.6) = 0.16, 0.32, 0.48 → 41,
 * 82, 122 — and the file's metallic 0.5 → 128; a WGSL material that repaints the surface
 * writes ITS colour — the colour a deferred pass would light, not the file's.
 */

const SIZE = 32;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const GLB = encodeFixtureGlb({
  materials: [{ name: "slate", baseColor: [0.2, 0.4, 0.6, 1], roughness: 0.6, metallic: 0.5 }],
  nodes: [{ name: "box", mesh: [cubePrimitive(0)] }],
});
const FACTS = prepareMesh(GLB, "")!.facts;

function graph(material?: { type: string; parameters: Record<string, unknown> }): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
  const nodes = [
    node("mesh", "meshFileIn", { vertices: FACTS.vertices, triangles: FACTS.triangles, parts: FACTS.parts }, "mesh1"),
    ...(material === undefined ? [] : [node("mat", material.type, material.parameters, "mat1")]),
    node("geo", "geometry", { mode: "surface", ...(material === undefined ? {} : { material: "mat1" }) }, "geo1"),
    node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", normalOutput: true, albedoOutput: true }, "shot1"),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function layerBytes(document: GraphDocument, layer: "normal" | "albedo"): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings: SETTINGS,
    frames: 1,
    outputNodeId: "shot",
    outputPortId: layer,
    sinks: [{ nodeId: "shot", portId: layer }],
    meshes: { mesh: GLB },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames[0]!.bytes;
}

const at = (bytes: Uint8Array, x: number, y: number): number[] => Array.from(bytes.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 4));

describe("the Render's G-buffer Normal output (T1371b, §V147)", () => {
  it("carries the shaded normal and roughness, zero where there is no surface", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const stock = await layerBytes(graph(), "normal");
    expect(at(stock, SIZE / 2, SIZE / 2)).toEqual([128, 128, 255, 153]);
    expect(at(stock, 0, 0)).toEqual([0, 0, 0, 0]);

    // The material's own normal, not the mesh's: only the material code produces +Y here.
    const bent = await layerBytes(
      graph({
        type: "materialWgsl",
        parameters: {
          model: "lambert",
          source: `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.normal = vec3f(0.0, 1.0, 0.0);
  return o;
}`,
        },
      }),
      "normal",
    );
    expect(at(bent, SIZE / 2, SIZE / 2)).toEqual([128, 255, 128, 153]);
  });

  it("carries the shaded base colour and metallic in the Albedo output (T1380b)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const stock = await layerBytes(graph(), "albedo");
    expect(at(stock, SIZE / 2, SIZE / 2)).toEqual([41, 82, 122, 128]);
    expect(at(stock, 0, 0)).toEqual([0, 0, 0, 0]);

    // The material's colour, not the file's: only the material code paints it.
    const painted = await layerBytes(
      graph({
        type: "materialWgsl",
        parameters: {
          model: "pbr",
          source: `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(1.0, 0.0, 0.2, 1.0);
  o.metallic = 1.0;
  return o;
}`,
        },
      }),
      "albedo",
    );
    expect(at(painted, SIZE / 2, SIZE / 2)).toEqual([255, 0, 51, 255]);
  });
});
