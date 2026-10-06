import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../domain/types/graph.ts";
import type { Vec3 } from "../../points/curve.ts";
import { authoredPoints, curveEdge, curveGraph, curveNode, onDawn, type AuthoredAttribute } from "./curve-test-support.ts";

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
 *  - §T1618b: a pointset that carries a vec2f `uv` is read in place of the grid coordinate,
 *    by a stock material's maps and by a Material · WGSL's `s.uv`. Past a wrapped seam it is
 *    carried on by whole turns, up or down as the coordinate goes. A Sweep's own coordinate
 *    (round its profile, along its path by length) reaches a stock material with no kernel
 *    between, and on a grid of several sheets each sheet reads its own.
 *  - MAP EXTEND: what a map reads past its edge is the material's to say, an axis at a time.
 *    Hold carries the edge texel on, as ever; Repeat tiles (a tube swept by its length shows
 *    the tile again every tile length); Mirror tiles with every other tile turned round.
 *    And why it is a parameter: an open edge under MSAA, where the coordinate leaves 0..1.
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
function ruled(
  stage: Stage,
  eye: Vec3,
  /** `map: false` is a material with no map input: it shows the coordinate by its own code. */
  material: { readonly type: string; readonly parameters: Record<string, unknown>; readonly map?: false } = { type: "materialUnlit", parameters: { color: [1, 1, 1, 1] } },
  render: Record<string, unknown> = {},
) {
  const mapped = material.map !== false;
  return curveGraph(
    [
      ...stage.nodes,
      ...(mapped ? [curveNode("solid_white", "solid", { color: [1, 1, 1, 1] }), curveNode("wgsl_ruler", "customWgsl", { source: RULER })] : []),
      curveNode("material_ruled", material.type, material.parameters),
      curveNode("geometry_skin", "geometry", { mode: "surface", material: "material_ruled" }),
      curveNode("camera_main", "camera", { eye: [...eye], lookAt: [0, 0, 0], near: 0.1, far: 10, ortho: true, orthoHeight: 4 }),
      curveNode("render_shot", "render", { scenes: "geometry_skin", camera: "camera_main", lights: "", background: [0, 0, 1, 1], ...render }),
      curveNode("output_probe", "output"),
    ],
    [
      ...stage.edges,
      ...(mapped ? [curveEdge(["solid_white", "out"], ["wgsl_ruler", "input"]), curveEdge(["wgsl_ruler", "out"], ["material_ruled", "albedo"])] : []),
      curveEdge([stage.last, "out"], ["geometry_skin", "points"]),
      curveEdge(["render_shot", "out"], ["output_probe", "input"]),
    ],
  );
}

/** The picture: at each pixel the texel that was read, as (x, y), or `undefined` on the background. */
async function texelsOf(graph: ReturnType<typeof curveGraph>, port = "out"): Promise<(x: number, y: number) => readonly [number, number] | undefined> {
  const bytes = await onDawn(
    graph,
    async (session) => {
      expect(session.plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
      // The Render's own target, before the Output node encodes it for a display: the bytes the material wrote.
      const image = await session.readPort("render_shot", port);
      expect([image.width, image.height]).toEqual([SIZE, SIZE]);
      return image.bytes;
    },
    SIZE,
    0,
    [{ nodeId: "render_shot", portId: port }],
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
const prism = (claim: Record<string, unknown>, extras: ReadonlyArray<AuthoredAttribute> = []): Stage => ({
  nodes: [
    authoredPoints("kernel_prism", [-1, 1].flatMap((y) => CORNERS.map(([x, z]): Vec3 => [x, y, z])), extras).node,
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


/** A coordinate per point of the prism: `round[k]` at column k, and 0 on the first row, 1 on the second. */
const roundBy = (round: ReadonlyArray<number>, name = "uv"): AuthoredAttribute => ({ name, type: "vec2f", values: [0, 1].flatMap((row) => round.map((u) => [u, row])) });

describe("§T1618b: a grid Surface reads the texture coordinate its points carry", () => {
  /* One cell facing the camera, 2 m a side. Its points say the map's middle half across and
     its upper half up; the grid's own coordinate would say all of it both ways. */
  const SHEET: Vec3[] = [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]];
  const sheet = (name: string | undefined): Stage => ({
    nodes: [
      authoredPoints("kernel_sheet", SHEET, name === undefined ? [] : [{ name, type: "vec2f", values: [[0.25, 0.5], [0.75, 0.5], [0.25, 1], [0.75, 1]] }]).node,
      curveNode("topology_sheet", "pointTopology", { connectivity: "grid", cols: 2, rows: 2 }),
    ],
    edges: [curveEdge(["kernel_sheet", "out"], ["topology_sheet", "points"])],
    last: "topology_sheet",
  });
  const front: Vec3 = [0, 0, 5];

  it("a stock material's map is read at the points' own `uv`; without one, or under another name, at the grid's", async () => {
    const own = await texelsOf(ruled(sheet("uv"), front));
    const grid = await texelsOf(ruled(sheet(undefined), front));
    const other = await texelsOf(ruled(sheet("st"), front));
    let checked = 0;
    for (let x = 24; x < 72; x += 4) {
      for (let y = 24; y < 72; y += 4) {
        const across = acrossAt(x);
        const along = alongAt(y);
        if (onAnEdge(across) || onAnEdge(along) || onAnEdge(0.25 + 0.5 * across) || onAnEdge(0.5 + 0.5 * along)) continue;
        expect(own(x, y), `own, ${x}, ${y}`).toEqual([texelAt(0.25 + 0.5 * across), texelAt(0.5 + 0.5 * along)]);
        // The wire cut: the same points with no `uv`, or with the same numbers under another name.
        expect(grid(x, y), `grid, ${x}, ${y}`).toEqual([texelAt(across), texelAt(along)]);
        expect(other(x, y), `another name, ${x}, ${y}`).toEqual([texelAt(across), texelAt(along)]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  }, 240_000);

  it("the Albedo output, a layer of its own draw, reads the same texels", async () => {
    const layer = await texelsOf(ruled(sheet("uv"), front, undefined, { albedoOutput: true }), "albedo");
    let checked = 0;
    for (let x = 26; x < 70; x += 4) {
      const across = acrossAt(x);
      if (onAnEdge(0.25 + 0.5 * across)) continue;
      expect(layer(x, 48), `column ${x}`).toEqual([texelAt(0.25 + 0.5 * across), texelAt(0.5 + 0.5 * alongAt(48))]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(8);
  }, 120_000);

  it("a coordinate that rises round a wrapped prism is carried past the seam: the seam face runs on to the map's end", async () => {
    /* 0, 0.2, 0.4 and 0.6 at the four columns. The seam vertex is column 0 again; read
       plainly it would say 0 and the seam face would run from 0.6 back to 0. Carried on by
       the one whole turn the axis makes, it says 1. */
    const stage = prism({ wrapU: true }, [roundBy([0, 0.2, 0.4, 0.6])]);
    for (const face of FACES) {
      const texel = await texelsOf(ruled(stage, face.eye));
      let checked = 0;
      for (let x = 24; x < 72; x += 1) {
        const u = face.cell < 3 ? 0.2 * (face.cell + acrossAt(x)) : 0.6 + 0.4 * acrossAt(x);
        if (onAnEdge(u)) continue;
        expect(texel(x, 48)?.[0], `${face.name}, column ${x}`).toBe(texelAt(u));
        checked += 1;
      }
      expect(checked).toBeGreaterThan(40);
    }
    // The texel at the seam itself: the last pixel of the seam face is at the map's end, not back at its start.
    const seam = await texelsOf(ruled(stage, FACES[3]!.eye));
    expect(seam(71, 48)?.[0]).toBe(texelAt(0.6 + 0.4 * acrossAt(71)));
    expect(seam(71, 48)?.[0]).toBeGreaterThan(90);
  }, 240_000);

  it("a coordinate that FALLS round it is carried down: a mirrored map ends at 0 across the seam, and does not turn back", async () => {
    /* 1, 0.8, 0.6 and 0.4: a kernel's mirrored coordinate. It goes down by one whole turn, so
       the seam vertex says 0 and the seam face runs from 0.4 to 0. Carried UP it would say 1
       and the face would run back from 0.4 to 1. */
    const stage = prism({ wrapU: true }, [roundBy([1, 0.8, 0.6, 0.4])]);
    for (const face of FACES) {
      const texel = await texelsOf(ruled(stage, face.eye));
      let checked = 0;
      for (let x = 24; x < 72; x += 1) {
        const u = face.cell < 3 ? 1 - 0.2 * (face.cell + acrossAt(x)) : 0.4 - 0.4 * acrossAt(x);
        if (onAnEdge(u)) continue;
        expect(texel(x, 48)?.[0], `${face.name}, column ${x}`).toBe(texelAt(u));
        checked += 1;
      }
      expect(checked).toBeGreaterThan(40);
    }
    const seam = await texelsOf(ruled(stage, FACES[3]!.eye));
    expect(seam(71, 48)?.[0]).toBeLessThan(5);
  }, 240_000);

  it("the other axis: a coordinate that rises along wrapped rows is carried past the row seam", async () => {
    const turned: Stage = {
      nodes: [
        authoredPoints("kernel_prism", CORNERS.flatMap(([x, z]) => [-1, 1].map((y): Vec3 => [x, y, z])), [
          { name: "uv", type: "vec2f", values: [0, 0.2, 0.4, 0.6].flatMap((v) => [[0, v], [1, v]]) },
        ]).node,
        curveNode("topology_prism", "pointTopology", { connectivity: "grid", cols: 2, rows: 4, wrapV: true }),
      ],
      edges: [curveEdge(["kernel_prism", "out"], ["topology_prism", "points"])],
      last: "topology_prism",
    };
    const texel = await texelsOf(ruled(turned, FACES[3]!.eye));
    let checked = 0;
    for (let x = 24; x < 72; x += 1) {
      const v = 0.6 + 0.4 * acrossAt(x);
      if (onAnEdge(v)) continue;
      expect(texel(x, 48)?.[1], `column ${x}`).toBe(texelAt(v));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  }, 120_000);
});

describe("§T1618b: a Material · WGSL reads the same coordinate as `s.uv`", () => {
  /** Writes the coordinate as colour: a quarter of the way round in red (so three turns fit), the way along in green. */
  const SHOWS_UV = `fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(s.uv.x * 0.25, s.uv.y, 0.0, 1.0);
  return o;
}`;
  const custom = { type: "materialWgsl", parameters: { model: "unlit", source: SHOWS_UV }, map: false } as const;
  /** The byte a colour channel is written as, or `undefined` where a float's last bit could decide it. */
  const byteOf = (value: number): number | undefined => (Math.abs(value * 255 - Math.floor(value * 255) - 0.5) < 0.03 ? undefined : Math.round(value * 255));

  it("three turns round a wrapped prism: the seam face runs from 2.25 on to 3", async () => {
    /* 0, 0.75, 1.5 and 2.25: a coordinate that goes three times round. The seam vertex is
       carried on by three whole turns. */
    const stage = prism({ wrapU: true }, [roundBy([0, 0.75, 1.5, 2.25])]);
    for (const face of FACES) {
      const texel = await texelsOf(ruled(stage, face.eye, custom));
      let checked = 0;
      for (let x = 24; x < 72; x += 1) {
        const u = 0.75 * (face.cell + acrossAt(x));
        const expected = byteOf(u * 0.25);
        if (expected === undefined) continue;
        expect(texel(x, 48)?.[0], `${face.name}, column ${x}`).toBe(expected);
        checked += 1;
      }
      // Of a face's 48 pixels, the ones a rounding could decide are left out: most remain.
      expect(checked).toBeGreaterThan(32);
    }
  }, 240_000);

  it("without a `uv` on the points it reads the grid's coordinate, once round", async () => {
    const texel = await texelsOf(ruled(prism({ wrapU: true }), FACES[3]!.eye, custom));
    let checked = 0;
    for (let x = 24; x < 72; x += 1) {
      const expected = byteOf(((3 + acrossAt(x)) / 4) * 0.25);
      if (expected === undefined) continue;
      expect(texel(x, 48)?.[0], `column ${x}`).toBe(expected);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
  }, 120_000);
});

describe("§T1618b: a Sweep's own coordinate reaches a stock material with no kernel between", () => {
  /** kernel → Topology (Strips) → Curve Frames → Sweep. A path along +Z is measured as the identity frame. */
  const swept = (strips: ReadonlyArray<ReadonlyArray<Vec3>>, sweep: Record<string, unknown>): Stage => ({
    nodes: [
      authoredPoints("kernel_path", strips.flat()).node,
      curveNode("topology_path", "pointTopology", { connectivity: "strips", cols: strips[0]!.length, rows: strips.length }),
      curveNode("frames_path", "pointCurveFrames"),
      curveNode("sweep_skin", "pointSweep", sweep),
    ],
    edges: [curveEdge(["kernel_path", "out"], ["topology_path", "points"]), curveEdge(["topology_path", "out"], ["frames_path", "points"]), curveEdge(["frames_path", "out"], ["sweep_skin", "points"])],
    last: "sweep_skin",
  });
  /* From +X the picture's right is −Z and its top is +Y: the path runs right to left. */
  const side: Vec3 = [5, 0, 0];
  const zAt = (x: number): number => -(x + 0.5 - 48) / 24;
  const yAt = (y: number): number => (48 - (y + 0.5)) / 24;
  const LINE: Vec3[] = [[0, 0, -1], [0, 0, 0], [0, 0, 1]];

  it("along by LENGTH: two metres of tube at four metres a tile read half the map, where the grid's coordinate reads all of it", async () => {
    /* A Square of half-width 1: its first side is the +X face, y from −1 to 1, a quarter of
       the way round. Its grid has two columns a side, so the grid's own coordinate would
       put an eighth of the map on the face, and all of the map along three rows. */
    const tube = { profile: "square", radius: 1, uvAlong: "metres", uvLength: 4 };
    const texel = await texelsOf(ruled(swept([LINE], tube), side));
    let checked = 0;
    for (let x = 26; x < 70; x += 3) {
      for (let y = 26; y < 70; y += 3) {
        const u = (0.25 * (yAt(y) + 1)) / 2;
        const v = (zAt(x) + 1) / 4;
        if (onAnEdge(u) || onAnEdge(v)) continue;
        expect(texel(x, y), `pixel ${x}, ${y}`).toEqual([texelAt(u), texelAt(v)]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(150);
    // The far end of the tube, z = 1, is at half the map: texel 47, not the last.
    expect(texel(24, 48)?.[1]).toBe(texelAt((zAt(24) + 1) / 4));
    expect(texel(24, 48)?.[1]).toBeLessThan(48);
  }, 240_000);

  it("round the profile: a swept Ring's seam face runs on to the map's end, with no column of the map twice", async () => {
    /* A Ring of four, smooth: corners at (1, 0), (0, 1), (−1, 0), (0, −1). From +X the upper
       face is its first side (0 to a quarter) and the lower one is the SEAM side, from the
       last column back to the first: three quarters to one. */
    const texel = await texelsOf(ruled(swept([LINE], { profile: "ring", sides: 4, radius: 1, uvAlong: "points" }), side));
    const seen: number[] = [];
    let checked = 0;
    for (let y = 24; y < 72; y += 1) {
      const height = yAt(y);
      const u = height > 0 ? 0.25 * height : 0.75 + 0.25 * (height + 1);
      if (onAnEdge(u)) continue;
      expect(texel(48, y)?.[0], `row ${y}`).toBe(texelAt(u));
      if (height < 0) seen.push(texel(48, y)?.[0] ?? -1);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(40);
    // Down the seam face the map's columns only ever go one way, from 94 at its top to 71 at its foot.
    expect(seen[0]).toBe(94);
    expect(seen[seen.length - 1]).toBe(71);
    for (let k = 1; k < seen.length; k += 1) expect(seen[k]!).toBeLessThanOrEqual(seen[k - 1]!);
  }, 120_000);

  it("several strips: each sheet reads its own coordinate, a long tube half the map and a short one a quarter", async () => {
    /* Two strips of three points: two metres long above, one metre long below, both starting
       at z = −1. At four metres a tile the upper tube ends at half the map and the lower at a
       quarter. A sheet that read the first sheet's rows would end at a half too. */
    const upper: Vec3[] = [[0, 1.25, -1], [0, 1.25, 0], [0, 1.25, 1]];
    const lower: Vec3[] = [[0, -1.25, -1], [0, -1.25, -0.5], [0, -1.25, 0]];
    const texel = await texelsOf(ruled(swept([upper, lower], { profile: "square", radius: 0.5, uvAlong: "metres", uvLength: 4 }), side));
    // The upper tube's +X face is rows 6 to 29, the lower one's rows 66 to 89.
    for (const x of [26, 40, 55, 69]) expect(texel(x, 18)?.[1], `upper, column ${x}`).toBe(texelAt((zAt(x) + 1) / 4));
    for (const x of [50, 58, 66, 69]) expect(texel(x, 78)?.[1], `lower, column ${x}`).toBe(texelAt((zAt(x) + 1) / 4));
    // The lower tube stops at z = 0, the middle of the picture: left of it is the background.
    expect(texel(40, 78)).toBeUndefined();
    expect(texel(49, 78)?.[1]).toBe(texelAt((zAt(49) + 1) / 4));
    expect(texel(49, 78)?.[1]).toBeLessThan(24);
    expect(texel(25, 18)?.[1]).toBeGreaterThan(44);
  }, 120_000);
});

/** Where a tiled axis reads: all 96 texels a tile, the address a material's Map Extend uses. */
const repeatAt = (coordinate: number): number => Math.min(Math.floor((coordinate - Math.floor(coordinate)) * SIZE), LAST);
const mirrored = (coordinate: number): number => 1 - Math.abs(1 - (coordinate - 2 * Math.floor(coordinate / 2)));
const mirrorAt = (coordinate: number): number => Math.min(Math.floor(mirrored(coordinate) * SIZE), LAST);
/** A fold close enough to a texel's edge, or to a tile's, that a float's last bit could decide the texel. */
const onATile = (fold: number, coordinate: number): boolean => {
  const scaled = fold * SIZE;
  return Math.abs(scaled - Math.round(scaled)) < 0.03 || Math.abs(coordinate - Math.round(coordinate)) < 0.002;
};
const onARepeat = (coordinate: number): boolean => onATile(coordinate - Math.floor(coordinate), coordinate);
const onAMirror = (coordinate: number): boolean => onATile(mirrored(coordinate), coordinate);

describe("§T1618b: Map Extend, a map tiles where its material says so", () => {
  const unlit = (parameters: Record<string, unknown>) => ({ type: "materialUnlit", parameters: { color: [1, 1, 1, 1], ...parameters } });
  const side: Vec3 = [5, 0, 0];
  const zAt = (x: number): number => -(x + 0.5 - 48) / 24;
  const yAt = (y: number): number => (48 - (y + 0.5)) / 24;
  /** kernel → Topology (Strips) → Curve Frames → Sweep: a Square tube 2 m long along +Z from z = −1, a tile every 1.25 m. */
  const tube: Stage = {
    nodes: [
      authoredPoints("kernel_path", [[0, 0, -1], [0, 0, 0], [0, 0, 1]]).node,
      curveNode("topology_path", "pointTopology", { connectivity: "strips", cols: 3, rows: 1 }),
      curveNode("frames_path", "pointCurveFrames"),
      curveNode("sweep_skin", "pointSweep", { profile: "square", radius: 1, uvAlong: "metres", uvLength: 1.25 }),
    ],
    edges: [curveEdge(["kernel_path", "out"], ["topology_path", "points"]), curveEdge(["topology_path", "out"], ["frames_path", "points"]), curveEdge(["frames_path", "out"], ["sweep_skin", "points"])],
    last: "sweep_skin",
  };
  /** Tiles along the tube at a picture column: a tile is 30 pixels, and from +X the tube's start is the right. */
  const tilesAt = (x: number): number => (zAt(x) + 1) / 1.25;

  it("a Sweep by its length, Extend V Repeat: one tile length along, the map's first texels come round again", async () => {
    const texel = await texelsOf(ruled(tube, side, unlit({ mapExtendV: "repeat" })));
    let checked = 0;
    for (let x = 24; x < 72; x += 1) {
      const tiles = tilesAt(x);
      if (onARepeat(tiles)) continue;
      expect(texel(x, 48)?.[1], `column ${x}, ${tiles.toFixed(3)} tiles along`).toBe(repeatAt(tiles));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30);
    // A tile is 30 pixels: every column of the second tile reads what the column a tile before it read.
    const columns = [40, 37, 33, 30, 26];
    expect(columns.map((x) => texel(x, 48)?.[1])).toEqual(columns.map((x) => texel(x + 30, 48)?.[1]));
    // It is the map's START that comes round: just past one tile the map is back at its first texels, not held at its last.
    expect(texel(41, 48)?.[1]).toBe(repeatAt(tilesAt(41)));
    expect(texel(41, 48)?.[1]).toBeLessThan(6);
    expect(texel(42, 48)?.[1]).toBeGreaterThan(88);
    // The other axis is not tiled and is read as ever: the +X face is the first quarter of the map, by the Hold address.
    for (const y of [27, 40, 55, 68]) expect(texel(60, y)?.[0], `row ${y}`).toBe(texelAt((0.25 * (yAt(y) + 1)) / 2));
  }, 120_000);

  it("the same Sweep with Hold, the default: the map's last texel is held from one tile length on", async () => {
    for (const material of [unlit({}), unlit({ mapExtendU: "hold", mapExtendV: "hold" }), unlit({ mapExtendU: "repeat" })]) {
      const texel = await texelsOf(ruled(tube, side, material));
      for (let x = 24; x < 72; x += 1) {
        const tiles = tilesAt(x);
        if (onAnEdge(Math.min(tiles, 1)) || Math.abs(tiles - 1) < 0.002) continue;
        expect(texel(x, 48)?.[1], `column ${x}`).toBe(texelAt(tiles));
      }
      expect(texel(30, 48)?.[1]).toBe(LAST);
      expect(texel(24, 48)?.[1]).toBe(LAST);
    }
  }, 240_000);

  it("Mirror: the second tile is read backwards, so the map meets itself with no seam", async () => {
    const texel = await texelsOf(ruled(tube, side, unlit({ mapExtendV: "mirror" })));
    let checked = 0;
    for (let x = 24; x < 72; x += 1) {
      const tiles = tilesAt(x);
      if (onAMirror(tiles)) continue;
      expect(texel(x, 48)?.[1], `column ${x}, ${tiles.toFixed(3)} tiles along`).toBe(mirrorAt(tiles));
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30);
    // Either side of one tile length both read the map's end, and it runs back down from there.
    expect(texel(42, 48)?.[1]).toBeGreaterThan(88);
    expect(texel(41, 48)?.[1]).toBeGreaterThan(88);
    expect(texel(30, 48)?.[1]).toBeLessThan(texel(40, 48)?.[1] ?? 0);
  }, 120_000);

  it("an axis at a time, below 0 as well: across mirrored and along repeated, and the reverse", async () => {
    /* One cell whose points say −0.5 to 1.3 across and 0.2 to 2.3 up. */
    const sheet: Stage = {
      nodes: [
        authoredPoints("kernel_sheet", [[-1, -1, 0], [1, -1, 0], [-1, 1, 0], [1, 1, 0]], [{ name: "uv", type: "vec2f", values: [[-0.5, 0.2], [1.3, 0.2], [-0.5, 2.3], [1.3, 2.3]] }]).node,
        curveNode("topology_sheet", "pointTopology", { connectivity: "grid", cols: 2, rows: 2 }),
      ],
      edges: [curveEdge(["kernel_sheet", "out"], ["topology_sheet", "points"])],
      last: "topology_sheet",
    };
    const cases = [
      { u: "repeat", v: "repeat" },
      { u: "mirror", v: "repeat" },
      { u: "repeat", v: "mirror" },
      { u: "hold", v: "mirror" },
    ] as const;
    for (const extend of cases) {
      const texel = await texelsOf(ruled(sheet, [0, 0, 5], unlit({ mapExtendU: extend.u, mapExtendV: extend.v })));
      const address = { hold: texelAt, repeat: repeatAt, mirror: mirrorAt };
      const edge = { hold: (c: number) => onAnEdge(Math.min(Math.max(c, 0), 1)) || Math.abs(c) < 0.002 || Math.abs(c - 1) < 0.002, repeat: onARepeat, mirror: onAMirror };
      let checked = 0;
      for (let x = 25; x < 71; x += 3) {
        for (let y = 25; y < 71; y += 3) {
          const u = -0.5 + 1.8 * acrossAt(x);
          const v = 0.2 + 2.1 * alongAt(y);
          if (edge[extend.u](u) || edge[extend.v](v)) continue;
          expect(texel(x, y), `${extend.u} across, ${extend.v} along, pixel ${x}, ${y}`).toEqual([address[extend.u](u), address[extend.v](v)]);
          checked += 1;
        }
      }
      expect(checked, `${extend.u}, ${extend.v}`).toBeGreaterThan(120);
    }
  }, 240_000);

  it("the Albedo output, a layer of its own draw, tiles with it", async () => {
    const layer = await texelsOf(ruled(tube, side, unlit({ mapExtendV: "repeat" }), { albedoOutput: true }), "albedo");
    for (const x of [26, 33, 40, 47, 58, 69]) {
      const tiles = tilesAt(x);
      if (onARepeat(tiles)) continue;
      expect(layer(x, 48)?.[1], `column ${x}`).toBe(repeatAt(tiles));
    }
    expect(layer(41, 48)?.[1]).toBeLessThan(6);
  }, 120_000);

  it("a Material · WGSL folds by the same two functions: `// @use extend`", async () => {
    /* A pattern written from the coordinate along: its fraction in red, its mirror in green.
       It tiles where the stock map above does, one tile every 30 pixels. */
    const FOLDS = `// @use extend
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(extendRepeat(s.uv.y), extendMirror(s.uv.y), 0.0, 1.0);
  return o;
}`;
    const texel = await texelsOf(ruled(tube, side, { type: "materialWgsl", parameters: { model: "unlit", source: FOLDS }, map: false }));
    const byteOf = (value: number): number | undefined => (Math.abs(value * 255 - Math.floor(value * 255) - 0.5) < 0.03 ? undefined : Math.round(value * 255));
    let checked = 0;
    for (let x = 24; x < 72; x += 1) {
      const tiles = tilesAt(x);
      if (Math.abs(tiles - Math.round(tiles)) < 0.002) continue;
      const repeat = byteOf(tiles - Math.floor(tiles));
      const mirror = byteOf(mirrored(tiles));
      if (repeat === undefined || mirror === undefined) continue;
      expect(texel(x, 48), `column ${x}`).toEqual([repeat, mirror]);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(30);
  }, 120_000);
});

describe("why Map Extend is a parameter: an open edge of a mapped grid under 4x MSAA (E75's shape)", () => {
  /* One cell, its own grid coordinate, whose right edge stops 0.45 of a pixel into picture
     column 72: the pixel's centre is past the surface, and two of its four samples are on
     it. A multisampled pixel is shaded once, at its centre, so there the coordinate has
     LEFT 0..1, by a thousandth, on a surface whose coordinate never does.

     E75 Resonance multisamples mapped grids with open edges in frame. A map that repeated
     whatever left 0..1 moved 571 of its pixels: this is that, in one pixel. */
  const edgeAt = 1 + 0.45 / 24;
  const sheet: Stage = {
    nodes: [
      authoredPoints("kernel_sheet", [[-1, -1, 0], [edgeAt, -1, 0], [-1, 1, 0], [edgeAt, 1, 0]]).node,
      curveNode("topology_sheet", "pointTopology", { connectivity: "grid", cols: 2, rows: 2 }),
    ],
    edges: [curveEdge(["kernel_sheet", "out"], ["topology_sheet", "points"])],
    last: "topology_sheet",
  };
  /** The red and blue bytes at a pixel: the ruler's column, weighed by how much of the pixel the sheet covers, and the background's share. */
  const pixels = async (parameters: Record<string, unknown>): Promise<(x: number, y: number) => readonly [number, number]> => {
    const bytes = await onDawn(
      ruled(sheet, [0, 0, 5], { type: "materialUnlit", parameters: { color: [1, 1, 1, 1], ...parameters } }, { antialias: "msaa" }),
      async (session) => (await session.readPort("render_shot", "out")).bytes,
      SIZE,
      0,
      [{ nodeId: "render_shot", portId: "out" }],
    );
    return (x, y) => [bytes[(y * SIZE + x) * 4] as number, bytes[(y * SIZE + x) * 4 + 2] as number];
  };
  /** The coordinate across at a pixel's centre, on or past the sheet. */
  const uAt = (x: number): number => ((x + 0.5 - 48) / 24 + 1) / (edgeAt + 1);

  it("Hold reads the edge's own texel on the partly covered pixel", async () => {
    const hold = await pixels({});
    // Fully covered, a pixel in: the map's own column there.
    expect(hold(71, 48)).toEqual([texelAt(uAt(71)), 0]);
    // The edge pixel: its centre is past the sheet (the coordinate is 1.001), part of it is the background's blue…
    expect(uAt(72)).toBeGreaterThan(1);
    const [red, blue] = hold(72, 48);
    expect(blue).toBeGreaterThan(0);
    expect(blue).toBeLessThan(255);
    // …and the rest is the map's LAST texel, 95: a whole number of the four samples of it.
    expect([24, 47, 48, 71]).toContain(red);
  }, 120_000);

  it("Repeat reads the map's FAR edge there: the price of a tiled axis on an open edge, and why Hold is the default", async () => {
    const repeat = await pixels({ mapExtendU: "repeat" });
    expect(repeat(71, 48)).toEqual([repeatAt(uAt(71)), 0]);
    const [red, blue] = repeat(72, 48);
    expect(blue).toBeGreaterThan(0);
    expect(blue).toBeLessThan(255);
    // The coordinate there is 1.001: its fraction is the map's first texel, 0, whatever share of the pixel it has.
    expect(repeatAt(uAt(72))).toBe(0);
    expect(red).toBe(0);
  }, 120_000);
});

