import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../domain/types/graph.ts";
import type { Vec3 } from "../../points/curve.ts";
import { authoredPoints, curveEdge, curveGraph, curveNode, onDawn } from "./curve-test-support.ts";

/**
 * A GRID SURFACE'S TEXTURE COORDINATE, read back as the texel a map was read at (§T1618b,
 * §B255), on a real device.
 *
 * The map is a RULER: texel (x, y) holds the colour (x, y, 0), so a white unlit material
 * that wears it shows, at every pixel, which texel the surface read there. A map is read at
 * `trunc(uv × (size − 1))`, the ruler is 96 texels each way, and the cameras are
 * orthographic, so the texel a pixel must show follows from where the pixel is on the
 * surface. Every expectation below is that derived texel, exactly (§V147).
 *
 *  - §B255: an axis's coordinate runs over its CELLS. A wrapped axis has as many cells as
 *    points, so the coordinate is 1 at the seam vertex and the map goes once round. It was
 *    the points less one on every axis: on a wrapped one the map was squeezed into all but
 *    the last cell and the seam cell showed the map's last texel from side to side.
 */

const SIZE = 96;
/** The ruler's last texel: a coordinate of 1 reads it. */
const LAST = SIZE - 1;

type Edge = ReturnType<typeof curveEdge>;

/** texel (x, y) = (x, y, 0): the fragment's own place in the target, written as bytes. */
const RULER = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let white = textureSample(inputTexture, inputSampler, uv);
  return vec4f(floor(uv.x * ${SIZE}.0) / 255.0, floor(uv.y * ${SIZE}.0) / 255.0, 0.0, 1.0) * white;
}`;

interface Stage {
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<Edge>;
  /** The node whose `out` the Geometry draws. */
  readonly last: string;
}

/** The stage's points as a Surface that wears the ruler, seen by an orthographic camera 4 m tall: 24 pixels a metre. */
function ruled(stage: Stage, eye: Vec3, material: { readonly type: string; readonly parameters: Record<string, unknown> } = { type: "materialUnlit", parameters: { color: [1, 1, 1, 1] } }) {
  return curveGraph(
    [
      ...stage.nodes,
      curveNode("solid_white", "solid", { color: [1, 1, 1, 1] }),
      curveNode("wgsl_ruler", "customWgsl", { source: RULER }),
      curveNode("material_ruled", material.type, material.parameters),
      curveNode("geometry_skin", "geometry", { mode: "surface", material: "material_ruled" }),
      curveNode("camera_main", "camera", { eye: [...eye], lookAt: [0, 0, 0], near: 0.1, far: 10, ortho: true, orthoHeight: 4 }),
      curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main", lights: "", background: [0, 0, 1, 1] }),
      curveNode("output_probe", "output"),
    ],
    [
      ...stage.edges,
      curveEdge(["solid_white", "out"], ["wgsl_ruler", "input"]),
      curveEdge(["wgsl_ruler", "out"], ["material_ruled", "albedo"]),
      curveEdge([stage.last, "out"], ["geometry_skin", "points"]),
      curveEdge(["render_shot", "out"], ["output_probe", "input"]),
    ],
  );
}

/** The picture: at each pixel the texel that was read, as (x, y), or `undefined` on the background. */
async function texelsOf(graph: ReturnType<typeof curveGraph>): Promise<(x: number, y: number) => readonly [number, number] | undefined> {
  const bytes = await onDawn(
    graph,
    async (session) => {
      expect(session.plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
      // The Render's own target, before the Output node encodes it for a display: the bytes the material wrote.
      const image = await session.readPort("render_shot", "out");
      expect([image.width, image.height]).toEqual([SIZE, SIZE]);
      return image.bytes;
    },
    SIZE,
    0,
    [{ nodeId: "render_shot", portId: "out" }],
  );
  return (x, y) => {
    const at = (y * SIZE + x) * 4;
    // The background is pure blue; the ruler never writes blue.
    return (bytes[at + 2] as number) > 0 ? undefined : [bytes[at] as number, bytes[at + 1] as number];
  };
}

/** The texel a coordinate reads on the ruler: the map's own address rule. */
const texelAt = (coordinate: number): number => Math.trunc(Math.min(Math.max(coordinate, 0), 1) * LAST);
/** A coordinate close enough to a texel's edge that a float's last bit could decide the texel. */
const onAnEdge = (coordinate: number): boolean => {
  const scaled = coordinate * LAST;
  return Math.abs(scaled - Math.round(scaled)) < 0.02;
};

/**
 * A square prism about the Y axis, 2 m a side and 2 m long: four columns at its four
 * corners, `rows` rows along it. Column 0 is at (−1, 1) in x and z, and they go round by
 * (1, 1), (1, −1) and (−1, −1), so the cell from column 3 back to column 0 is the face at
 * x = −1: the SEAM cell, which only a wrapped claim has.
 */
const CORNERS: ReadonlyArray<readonly [number, number]> = [[-1, 1], [1, 1], [1, -1], [-1, -1]];
const prism = (claim: Record<string, unknown>): Stage => ({
  nodes: [
    authoredPoints("kernel_prism", [-1, 1].flatMap((y) => CORNERS.map(([x, z]): Vec3 => [x, y, z]))).node,
    curveNode("topology_prism", "pointTopology", { connectivity: "grid", cols: 4, rows: 2, ...claim }),
  ],
  edges: [curveEdge(["kernel_prism", "out"], ["topology_prism", "points"])],
  last: "topology_prism",
});
/** A camera 5 m out along each face's own normal, and what runs to the right in its picture: the cell's way round. */
const FACES = [
  { name: "the face from column 0 to 1", cell: 0, eye: [0, 0, 5] as Vec3 },
  { name: "the face from column 1 to 2", cell: 1, eye: [5, 0, 0] as Vec3 },
  { name: "the face from column 2 to 3", cell: 2, eye: [0, 0, -5] as Vec3 },
  { name: "the SEAM face, from column 3 back to 0", cell: 3, eye: [-5, 0, 0] as Vec3 },
];
/** A face fills columns 24 to 71 and rows 24 to 71 of the picture; `across` is 0 at its first column and 1 at its second. */
const acrossAt = (x: number): number => (x + 0.5 - 24) / 48;
/** Row 0 of the grid is at y = −1, the bottom of the picture. */
const alongAt = (y: number): number => (72 - (y + 0.5)) / 48;

describe("§B255: a wrapped grid's texture coordinate goes once round", () => {
  it("each of the four faces of a wrapped prism shows its own quarter of the map, and the seam face the last", async () => {
    for (const face of FACES) {
      const texel = await texelsOf(ruled(prism({ wrapU: true }), face.eye));
      let checked = 0;
      for (let x = 24; x < 72; x += 1) {
        const u = (face.cell + acrossAt(x)) / 4;
        const v = alongAt(48);
        if (onAnEdge(u) || onAnEdge(v)) continue;
        expect(texel(x, 48), `${face.name}, column ${x}`).toEqual([texelAt(u), texelAt(v)]);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(40);
      // Outside the face is the background.
      expect(texel(20, 48)).toBeUndefined();
      expect(texel(75, 48)).toBeUndefined();
    }
  }, 240_000);

  it("the seam face is not the map's last texel from side to side: its first pixel reads three quarters of the way along the map", async () => {
    const texel = await texelsOf(ruled(prism({ wrapU: true }), FACES[3]!.eye));
    // u = (3 + 0.0104) ÷ 4 = 0.7526, texel 71; at the far side u = 0.9974, texel 94.
    expect(texel(24, 48)?.[0]).toBe(71);
    expect(texel(71, 48)?.[0]).toBe(94);
    // Before §B255 every pixel of this face read texel 95, the last.
    const read = new Set<number>();
    for (let x = 24; x < 72; x += 1) read.add(texel(x, 48)?.[0] ?? -1);
    expect(read.size).toBeGreaterThan(20);
    expect(read.has(LAST)).toBe(false);
  }, 120_000);

  it("the same four columns NOT wrapped keep the coordinate they had: three faces, a third of the map each, and no fourth", async () => {
    for (const face of FACES.slice(0, 3)) {
      const texel = await texelsOf(ruled(prism({}), face.eye));
      let checked = 0;
      for (let x = 24; x < 72; x += 1) {
        const u = (face.cell + acrossAt(x)) / 3;
        if (onAnEdge(u)) continue;
        expect(texel(x, 48)?.[0], `${face.name}, column ${x}`).toBe(texelAt(u));
        checked += 1;
      }
      expect(checked).toBeGreaterThan(40);
    }
    // From the seam's side an open prism shows the inside of the face opposite, through the gap.
    const open = await texelsOf(ruled(prism({}), FACES[3]!.eye));
    expect(open(48, 48)?.[0]).toBe(texelAt((1 + acrossAt(47)) / 3));
  }, 240_000);

  it("the other axis: wrapped along its rows, the coordinate along reaches 1 at the row seam", async () => {
    /* The same prism with its axes exchanged: two columns along Y, four rows round. */
    const turned: Stage = {
      nodes: [
        authoredPoints("kernel_prism", CORNERS.flatMap(([x, z]) => [-1, 1].map((y): Vec3 => [x, y, z]))).node,
        curveNode("topology_prism", "pointTopology", { connectivity: "grid", cols: 2, rows: 4, wrapV: true }),
      ],
      edges: [curveEdge(["kernel_prism", "out"], ["topology_prism", "points"])],
      last: "topology_prism",
    };
    for (const face of FACES) {
      const texel = await texelsOf(ruled(turned, face.eye));
      let checked = 0;
      for (let x = 24; x < 72; x += 1) {
        const v = (face.cell + acrossAt(x)) / 4;
        if (onAnEdge(v)) continue;
        expect(texel(x, 48)?.[1], `${face.name}, column ${x}`).toBe(texelAt(v));
        checked += 1;
      }
      expect(checked).toBeGreaterThan(40);
    }
  }, 240_000);
});
