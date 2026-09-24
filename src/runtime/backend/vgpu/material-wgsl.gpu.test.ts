import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { MATERIAL_WGSL_DEFAULT_SOURCE } from "../../../nodes/definitions/material-wgsl.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1355b on a REAL device, exact to the byte (§V147): a Material · WGSL's `surface()` runs
 * per fragment before lighting, and what it returns is what gets lit.
 *
 * The identity first — the shipped default source (heatGlow 0) renders the very bytes the
 * same model renders with no code at all — then each output the contract names, moved on
 * its own: emissive by a reflected knob (and moved again by the knob alone, a uniform
 * write), albedo replaced, a mesh's heat turned into glow. Every expected value is the
 * lambert arithmetic the file's own numbers give.
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

const GLB = encodeFixtureGlb({
  materials: [{ name: "painted", baseColor: [1, 0.5, 0.25, 1], roughness: 1, extras: { loom_heat: 0.5 } }],
  nodes: [{ name: "box", mesh: [cubePrimitive(0)] }],
});
const FACTS = prepareMesh(GLB, "")!.facts;

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function graph(material: { type: string; parameters: Record<string, unknown> }, mode = "surface"): GraphDocument {
  const nodes = [
    node("mesh", "meshFileIn", { vertices: FACTS.vertices, triangles: FACTS.triangles, parts: FACTS.parts }, "mesh1"),
    node("mat", material.type, material.parameters, "mat1"),
    node("geo", "geometry", { mode, material: "mat1" }, "geo1"),
    node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
    node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "sun1", ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12 }, "shot1"),
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

async function render(document: GraphDocument) {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings: SETTINGS,
    frames: 2,
    outputNodeId: "shot",
    outputPortId: "out",
    meshes: { mesh: GLB },
  });
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  return { bytes: frame.bytes, errors: result.diagnostics.filter((d) => d.severity === "error").map((d) => d.message) };
}

const matrix = cameraPayloadMatrix({ eye: [0, 0, 3], lookAt: [0, 0, 0], fovDeg: 60, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
const centre = (() => {
  const clip = transformPoint(matrix, [0, 0, 0.5]);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
})();
const rgb = (bytes: Uint8Array): number[] => [bytes[centre] ?? -1, bytes[centre + 1] ?? -1, bytes[centre + 2] ?? -1];
const byte = (linear: number): number => Math.round(Math.min(1, linear) * 255);

/** Lambert, head-on light: (ambient 0.12 + |N·L| 1) × albedo, where albedo = base 1 × the file's colour. */
const LIT = [byte(1 * 1.12), byte(0.5 * 1.12), byte(0.25 * 1.12)];

describe("Material · WGSL on Dawn (T1355b, §V147)", () => {
  it("the default source is the identity: the same bytes as no code at all", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const stock = await render(graph({ type: "materialPhong", parameters: { color: [1, 1, 1, 1], specular: [0, 0, 0, 1] } }));
    // Phong with a black specular is lambert; the WGSL material in lambert mode with its default code.
    const coded = await render(graph({ type: "materialWgsl", parameters: { model: "lambert", source: MATERIAL_WGSL_DEFAULT_SOURCE } }));
    expect(stock.errors).toEqual([]);
    expect(coded.errors).toEqual([]);
    expect({ coded: rgb(coded.bytes), stock: rgb(stock.bytes) }).toEqual({ coded: LIT, stock: LIT });
  });

  it("emissive, albedo and the mesh's heat each arrive — and a reflected knob moves the pixel by its value", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const blueSource = `struct Params {
  glow: f32, // @default 0  Blue emissive.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.emissive = vec3f(0.0, 0.0, p.glow);
  return o;
}`;
    const blueLow = await render(graph({ type: "materialWgsl", parameters: { model: "lambert", source: blueSource, glow: 0.1 } }));
    const blueHigh = await render(graph({ type: "materialWgsl", parameters: { model: "lambert", source: blueSource, glow: 0.3 } }));
    expect(rgb(blueLow.bytes)).toEqual([LIT[0], LIT[1], byte(0.25 * 1.12 + 0.1)]);
    expect(rgb(blueHigh.bytes)).toEqual([LIT[0], LIT[1], byte(0.25 * 1.12 + 0.3)]);

    // Albedo REPLACED: the lighting shades what the code returns, not what the file said.
    const green = await render(
      graph({
        type: "materialWgsl",
        parameters: {
          model: "lambert",
          source: `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.5, 0.0, 1.0);
  return o;
}`,
        },
      }),
    );
    expect(green.errors).toEqual([]);
    expect(rgb(green.bytes)).toEqual([0, byte(0.5 * 1.12), 0]);

    // The default source's heat glow: attr.z is the file's loom_heat (0.5), heatColor white.
    const hot = await render(graph({ type: "materialWgsl", parameters: { model: "lambert", source: MATERIAL_WGSL_DEFAULT_SOURCE, heatGlow: 0.2 } }));
    expect(rgb(hot.bytes)).toEqual([255, byte(0.5 * 1.12 + 0.1), byte(0.25 * 1.12 + 0.1)]);
  });

  it("refuses by name on a non-surface draw, and a source without fn surface", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // The harness refuses a graph that compiles with errors, naming them — which is the claim.
    await expect(render(graph({ type: "materialWgsl", parameters: {} }, "instances"))).rejects.toThrow(/Material · WGSL, which runs on surface geometry only/);
    await expect(render(graph({ type: "materialWgsl", parameters: { source: "fn shade() {}" } }))).rejects.toThrow(/fn surface/);
  });
});
