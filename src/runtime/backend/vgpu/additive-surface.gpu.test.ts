import { describe, expect, it } from "vitest";

import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { cameraPayloadMatrix, transformPoint } from "../../../domain/geometry/camera.ts";
import { encodeFixtureGlb, type FixturePrimitive } from "../../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../../points/mesh.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1411b on a REAL device, exact to the byte (§V147): a Surface drawn with Blend: Additive
 * is LIGHT laid over the picture, not a body. The bug it fixes: an additive Material · WGSL
 * shell over a lit lamp rendered opaque — it wrote depth and the G-buffer and replaced the
 * colour, so the lamp behind it vanished.
 *
 * The stage: a lit wall (a file mesh at z = 0) and an additive, black, emissive shell with
 * three patches — one in FRONT of the wall, one BEHIND it, one over the empty background.
 * The shell is listed FIRST in `scenes`, so a shell drawn in list order without depth write
 * would be painted over by the wall behind it: only the deferral makes the front patch show.
 * The light casts shadows straight down the view axis, onto exactly the wall under the
 * front patch: a shell that entered the shadow sweep darkens it. The shell's material is
 * LAMBERT (black albedo, so its colour is its emission alone): an unlit material already
 * skips the shadow sweep (§V617), and would prove nothing about the additive rule.
 *
 * Every claim is against the SAME graph with the shell unnamed (the cut), plus the analytic
 * values: wall = 0.8 (default material) × 0.5 (file colour) × (0.12 ambient + 1 lambert)
 * = 0.448 → 114, and the shell's emission is (40, 80, 120)/255 — whole bytes, so the
 * one/one blend lands on integers and the sum is exact.
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

type Vec3 = readonly [number, number, number];
const EYE: Vec3 = [0, 0, 4];

/** An axis-aligned quad in the plane z, facing +Z (toward the camera). */
const quad = (x0: number, x1: number, y0: number, y1: number, z: number): FixturePrimitive => ({
  positions: [x0, y0, z, x1, y0, z, x1, y1, z, x0, y1, z],
  normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2, 0, 2, 3],
  material: 0,
});

const WALL = encodeFixtureGlb({
  materials: [{ name: "grey", baseColor: [0.5, 0.5, 0.5, 1], roughness: 0.6 }],
  nodes: [{ name: "wall", mesh: [quad(-1.5, 1.5, -1.5, 1.5, 0)] }],
});
const FRONT: Vec3 = [-0.8, 0, 1];
const BEHIND: Vec3 = [0.8, 0, -1];
const OVER_BACKGROUND: Vec3 = [1.5, 1.5, 1];
const SHELL = encodeFixtureGlb({
  materials: [{ name: "clear", baseColor: [1, 1, 1, 1] }],
  nodes: [
    { name: "front", mesh: [quad(-1.2, -0.4, -0.4, 0.4, 1)] },
    { name: "behind", mesh: [quad(0.4, 1.2, -0.4, 0.4, -1)] },
    { name: "open", mesh: [quad(1.3, 1.7, 1.3, 1.7, 1)] },
  ],
});
const SHELL_EMISSION = [40, 80, 120] as const;
const SHELL_WGSL = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.emissive = vec3f(${SHELL_EMISSION.map((value) => `${value}.0 / 255.0`).join(", ")});
  return o;
}`;

function graph(withShell: boolean): GraphDocument {
  const wallFacts = prepareMesh(WALL, "")!.facts;
  const shellFacts = prepareMesh(SHELL, "")!.facts;
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
  const nodes = [
    node("wallMesh", "meshFileIn", { vertices: wallFacts.vertices, triangles: wallFacts.triangles, parts: wallFacts.parts }, "wallmesh1"),
    node("wall", "geometry", { mode: "surface" }, "wall1"),
    node("shellMesh", "meshFileIn", { vertices: shellFacts.vertices, triangles: shellFacts.triangles, parts: shellFacts.parts }, "shellmesh1"),
    node("shellMat", "materialWgsl", { model: "lambert", source: SHELL_WGSL }, "shellmat1"),
    node("shell", "geometry", { mode: "surface", material: "shellmat1", blend: "additive" }, "shell1"),
    node("cam", "camera", { eye: [...EYE], lookAt: [0, 0, 0] }, "cam1"),
    node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1, shadows: true, shadowExtent: 4, shadowSoftness: 0 }, "sun1"),
    node(
      "shot",
      "render",
      {
        // The shell FIRST: list order would draw it before the wall that sits behind it.
        scenes: withShell ? "shell1 wall1" : "wall1",
        camera: "cam1",
        lights: "sun1",
        ambientColor: [1, 1, 1, 1],
        ambientIntensity: 0.12,
        // Transparent, so the coverage the shell adds (none) is readable in alpha.
        background: [0, 0, 0, 0],
        depthOutput: true,
        normalOutput: true,
        albedoOutput: true,
      },
      "shot1",
    ),
    node("out", "output", {}, "out1"),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "wallMesh", portId: "out" }, target: { nodeId: "wall", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shellMesh", portId: "out" }, target: { nodeId: "shell", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

async function layer(withShell: boolean, port: "out" | "depth" | "normal" | "albedo"): Promise<Uint8Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(withShell),
    settings: SETTINGS,
    frames: 1,
    outputNodeId: "shot",
    outputPortId: port,
    ...(port === "out" ? {} : { sinks: [{ nodeId: "shot", portId: port }] }),
    meshes: { wallMesh: WALL, shellMesh: SHELL },
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return result.frames[0]!.bytes;
}

function texelOf(world: Vec3): number {
  const matrix = cameraPayloadMatrix({ eye: EYE, lookAt: [0, 0, 0], fovDeg: 60, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
}

const rgba = (bytes: Uint8Array, at: number): number[] => Array.from(bytes.subarray(at, at + 4));

describe("an additive Surface is light over the picture (T1411b, §V147)", () => {
  it("adds its emission onto the lit wall behind it, hides behind the wall, casts no shadow", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const bare = await layer(false, "out");
    const shelled = await layer(true, "out");
    const wall = Math.round(0.8 * 0.5 * 1.12 * 255);
    expect(wall).toBe(114);

    // The cut: the wall alone is the analytic lit value under the front patch — unshadowed.
    expect(rgba(bare, texelOf(FRONT))).toEqual([wall, wall, wall, 255]);
    // In front: wall + emission, to the byte. Opaque (the bug) read the emission alone; a
    // list-order draw read the wall alone; a shell in the shadow sweep read the ambient floor
    // (0.8·0.5·0.12 → 12) plus the emission.
    expect(rgba(shelled, texelOf(FRONT))).toEqual([wall + SHELL_EMISSION[0], wall + SHELL_EMISSION[1], wall + SHELL_EMISSION[2], 255]);
    // Behind the wall: the depth TEST still runs — the wall hides it completely.
    expect(rgba(shelled, texelOf(BEHIND))).toEqual(rgba(bare, texelOf(BEHIND)));
    expect(rgba(bare, texelOf(BEHIND))).toEqual([wall, wall, wall, 255]);
    // Over the empty background: the emission onto black, and no coverage added — alpha stays
    // the background's 0, so the glow never makes a pixel "more opaque" than what it is over.
    expect(rgba(bare, texelOf(OVER_BACKGROUND))).toEqual([0, 0, 0, 0]);
    expect(rgba(shelled, texelOf(OVER_BACKGROUND))).toEqual([...SHELL_EMISSION, 0]);
  }, 60_000);

  it("leaves the Depth, Normal and Albedo outputs to the surface it glows over", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    for (const port of ["depth", "normal", "albedo"] as const) {
      const bare = await layer(false, port);
      const shelled = await layer(true, port);
      // The whole layer, byte for byte: the shell contributes nothing to any of them.
      expect(Buffer.from(shelled).equals(Buffer.from(bare)), `${port} layer changed under the shell`).toBe(true);
    }
    // And those layers hold the WALL where the shell sits in front of it — the G-buffer's
    // (0,0,1) → (128,128,255) with the file's roughness 0.6 → 153, and the wall's albedo
    // 0.4 → 102 with metallic 0 — not "no surface", and not the shell's black albedo.
    expect(rgba(await layer(true, "normal"), texelOf(FRONT))).toEqual([128, 128, 255, 153]);
    expect(rgba(await layer(true, "albedo"), texelOf(FRONT))).toEqual([102, 102, 102, 0]);
  }, 120_000);
});
