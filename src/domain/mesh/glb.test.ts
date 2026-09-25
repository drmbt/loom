import { describe, expect, it } from "vitest";

import { decodeGlb, GlbDecodeError } from "./glb.ts";
import { cubePrimitive, encodeFixtureGlb } from "./glb.fixture.ts";

/**
 * T1353b — the decoder is the contract between a Blender export and every pixel the
 * mesh path draws, so these assert WHAT A CONSUMER READS BACK: world positions, world
 * normals, flattened material values, part indices and pivots, camera poses. Each one is
 * derived by hand from the fixture, never read off the decoder and pasted back.
 */

const SQRT1_2 = Math.SQRT1_2;

function vec(array: Float32Array, index: number, size: number): number[] {
  return Array.from(array.subarray(index * size, index * size + size));
}

describe("decodeGlb (T1353b)", () => {
  it("bakes the node hierarchy into world space: translate, rotate, non-uniform scale", () => {
    // Parent moves +10 on X; child turns 90° about Y and stretches ×2 along its local X.
    const glb = encodeFixtureGlb({
      nodes: [
        {
          name: "root",
          translation: [10, 0, 0],
          children: [
            {
              name: "box",
              rotation: [0, SQRT1_2, 0, SQRT1_2],
              scale: [2, 1, 1],
              mesh: [cubePrimitive()],
            },
          ],
        },
      ],
    });
    const mesh = decodeGlb(glb);
    expect(mesh.vertexCount).toBe(24);
    expect(mesh.triangleCount).toBe(12);
    // Local X is stretched to ±1, then turned onto world −Z/+Z; Z stays ±0.5 and turns onto X.
    expect(mesh.bounds.min[0]).toBeCloseTo(9.5, 6);
    expect(mesh.bounds.max[0]).toBeCloseTo(10.5, 6);
    expect(mesh.bounds.min[2]).toBeCloseTo(-1, 6);
    expect(mesh.bounds.max[2]).toBeCloseTo(1, 6);
    // The +X face's normal turns onto −Z and stays unit length under the ×2 stretch.
    const n = vec(mesh.normals, 0, 3);
    expect(n[0]).toBeCloseTo(0, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(-1, 6);
  });

  it("keeps normals perpendicular under non-uniform scale (the inverse transpose, not the matrix)", () => {
    // A 45° slope in XY, squashed ×0.25 in Y. The plain matrix would tilt the normal the
    // wrong way; the surface after scaling has a shallower slope, so its normal is steeper.
    const glb = encodeFixtureGlb({
      nodes: [
        {
          scale: [1, 0.25, 1],
          mesh: [
            {
              positions: [0, 0, 0, 1, 1, 0, 0, 0, 1],
              normals: [-SQRT1_2, SQRT1_2, 0, -SQRT1_2, SQRT1_2, 0, -SQRT1_2, SQRT1_2, 0],
              indices: [0, 1, 2],
            },
          ],
        },
      ],
    });
    const mesh = decodeGlb(glb);
    const n = vec(mesh.normals, 0, 3);
    const edge = [1, 0.25, 0];
    expect(n[0]! * edge[0]! + n[1]! * edge[1]! + n[2]! * edge[2]!).toBeCloseTo(0, 6);
    expect(Math.hypot(n[0]!, n[1]!, n[2]!)).toBeCloseTo(1, 6);
  });

  it("flattens material factors onto every vertex: colour × COLOR_0, roughness, metallic, emissive × strength, heat", () => {
    const primitive = { ...cubePrimitive(0), colors: new Array(24).fill([0.5, 1, 1, 1]).flat() };
    const glb = encodeFixtureGlb({
      materials: [
        {
          name: "molten",
          baseColor: [0.8, 0.4, 0.2, 1],
          metallic: 0.25,
          roughness: 0.75,
          emissive: [1, 0.5, 0.1],
          emissiveStrength: 20,
          extras: { loom_heat: 0.9 },
        },
      ],
      extensionsRequired: ["KHR_materials_emissive_strength"],
      nodes: [{ mesh: [primitive] }],
    });
    const mesh = decodeGlb(glb);
    for (const index of [0, 23]) {
      expect(vec(mesh.colors, index, 4).map((x) => Number(x.toFixed(5)))).toEqual([0.4, 0.4, 0.2, 1]);
      expect(vec(mesh.surface, index, 4).map((x) => Number(x.toFixed(5)))).toEqual([0.75, 0.25, 0.9, 0]);
      expect(vec(mesh.emissive, index, 3).map((x) => Number(x.toFixed(4)))).toEqual([20, 10, 2]);
    }
  });

  it("marks every vertex under a loom_part node with its part, and publishes the pivot and turn", () => {
    const glb = encodeFixtureGlb({
      nodes: [
        { name: "floor", mesh: [cubePrimitive()] },
        {
          name: "ladle",
          extras: { loom_part: "ladle" },
          translation: [3, 4, 5],
          rotation: [0, 0, SQRT1_2, SQRT1_2],
          // The child mesh inherits the part — a Blender object parented under the pivot.
          children: [{ name: "ladle_shell", translation: [0, -1, 0], mesh: [cubePrimitive()] }],
        },
        { name: "crane", extras: { loom_part: "crane", loom_parent: "ladle" }, mesh: [cubePrimitive()] },
      ],
    });
    const mesh = decodeGlb(glb);
    expect(mesh.parts.map((part) => [part.name, part.index])).toEqual([["ladle", 1], ["crane", 2]]);
    // T1363b: the exporter's hierarchy, by name — a rig composes child under parent from it.
    expect(mesh.parts.map((part) => part.parent)).toEqual([undefined, "ladle"]);
    expect(mesh.parts[0]?.pivot).toEqual([3, 4, 5]);
    const rotation = mesh.parts[0]?.rotation ?? [];
    expect(rotation[2]).toBeCloseTo(SQRT1_2, 6);
    expect(rotation[3]).toBeCloseTo(SQRT1_2, 6);
    expect(mesh.surface[0 * 4 + 3]).toBe(0);
    expect(mesh.surface[24 * 4 + 3]).toBe(1);
    expect(mesh.surface[48 * 4 + 3]).toBe(2);
    expect(mesh.parts[0]).toMatchObject({ vertexStart: 24, vertexCount: 24 });
    // The cube's first corner (0.5, −0.5, 0.5), dropped 1 on the child's Y → (0.5, −1.5, 0.5),
    // turned 90° about Z (x, y) → (−y, x) → (1.5, 0.5, 0.5), plus the pivot (3, 4, 5).
    expect(vec(mesh.positions, 24, 3).map((x) => Number(x.toFixed(5)))).toEqual([4.5, 4.5, 5.5]);
  });

  it("publishes cameras as eye, forward, up and vertical fov, and meshless leaves as markers", () => {
    const glb = encodeFixtureGlb({
      nodes: [
        // Turned 90° about Y: the camera's −Z looks down world −X.
        { name: "shot.hero", translation: [1, 2, 3], rotation: [0, SQRT1_2, 0, SQRT1_2], camera: { yfovDeg: 40, near: 0.1, far: 500 } },
        { name: "emit.tap", translation: [0, 7, 0] },
        // T1363b: what the exporter says about a fixture rides on the marker, verbatim.
        { name: "lamp.hall.01", translation: [4, 20, 0], extras: { loom_light_kind: "high_bay", loom_light_lumens: 36000, loom_light_color: [1, 0.86, 0.66] } },
      ],
    });
    const mesh = decodeGlb(glb);
    expect(mesh.cameras).toHaveLength(1);
    const camera = mesh.cameras[0]!;
    expect(camera.name).toBe("shot.hero");
    expect(camera.eye).toEqual([1, 2, 3]);
    expect(camera.forward[0]).toBeCloseTo(-1, 6);
    expect(camera.up[1]).toBeCloseTo(1, 6);
    expect(camera.fovDeg).toBeCloseTo(40, 4);
    expect(camera.far).toBe(500);
    expect(mesh.markers).toEqual([
      { name: "emit.tap", position: [0, 7, 0], direction: [0, 0, -1] },
      {
        name: "lamp.hall.01",
        position: [4, 20, 0],
        direction: [0, 0, -1],
        extras: { loom_light_kind: "high_bay", loom_light_lumens: 36000, loom_light_color: [1, 0.86, 0.66] },
      },
    ]);
    expect(mesh.vertexCount).toBe(0);
  });

  it("select keeps only the matching nodes, parts or materials — how one scene splits across nodes", () => {
    const glb = encodeFixtureGlb({
      materials: [{ name: "steel" }, { name: "glass" }],
      nodes: [
        { name: "column_1", mesh: [cubePrimitive(0)] },
        { name: "window", mesh: [cubePrimitive(1)] },
        { name: "hook", extras: { loom_part: "crane_hook" }, mesh: [cubePrimitive(0)] },
      ],
    });
    expect(decodeGlb(glb, { select: "column_*" }).vertexCount).toBe(24);
    expect(decodeGlb(glb, { select: "glass" }).vertexCount).toBe(24);
    expect(decodeGlb(glb, { select: "crane_*" }).vertexCount).toBe(24);
    expect(decodeGlb(glb, { select: "steel" }).vertexCount).toBe(48);
    expect(decodeGlb(glb, { select: "" }).vertexCount).toBe(72);
    // Scoped and negated: the moving parts, the static rest, and a material inside one scope.
    expect(decodeGlb(glb, { select: "part:*" }).vertexCount).toBe(24);
    expect(decodeGlb(glb, { select: "!part:*" }).vertexCount).toBe(48);
    expect(decodeGlb(glb, { select: "material:steel !part:*" }).vertexCount).toBe(24);
    // A bare glob that names a material is not a part: `part:steel` keeps nothing.
    expect(decodeGlb(glb, { select: "part:steel" }).vertexCount).toBe(0);
  });

  it("offsets indices by each primitive's vertex base and flips winding under a mirror", () => {
    const tri = { positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] };
    const glb = encodeFixtureGlb({ nodes: [{ mesh: [tri] }, { scale: [-1, 1, 1], mesh: [tri] }] });
    const mesh = decodeGlb(glb);
    expect(Array.from(mesh.indices)).toEqual([0, 1, 2, 3, 5, 4]);
  });

  it("generates smooth normals for a primitive without NORMAL and says so", () => {
    const glb = encodeFixtureGlb({ nodes: [{ mesh: [{ positions: [0, 0, 0, 1, 0, 0, 0, 0, -1], indices: [0, 1, 2] }] }] });
    const mesh = decodeGlb(glb);
    expect(vec(mesh.normals, 0, 3).map((x) => Math.round(x))).toEqual([0, 1, 0]);
    expect(mesh.warnings.some((warning) => warning.includes("no NORMAL"))).toBe(true);
  });

  it("refuses by name what it cannot decode, instead of drawing a plausible wrong shape", () => {
    const draco = encodeFixtureGlb({ nodes: [{ mesh: [cubePrimitive()] }], extensionsRequired: ["KHR_draco_mesh_compression"] });
    expect(() => decodeGlb(draco)).toThrowError(/Draco compression/);
    const unknown = encodeFixtureGlb({ nodes: [], extensionsRequired: ["EXT_something"] });
    expect(() => decodeGlb(unknown)).toThrowError(/EXT_something/);
    expect(() => decodeGlb(new TextEncoder().encode("{\"asset\":{}}   "))).toThrowError(GlbDecodeError);
  });
});
