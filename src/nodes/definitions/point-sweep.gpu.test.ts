import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import type { PointAttributeSchema, PointAttributeType } from "../../points/attributes.ts";
import type { Quat, Vec2, Vec3 } from "../../points/curve.ts";
import {
  sweepCapRows,
  sweepColumnCount,
  sweepOutline,
  sweepStrip,
  type SweepCaps,
  type SweepOutline,
  type SweepPathPoint,
  type SweepUvAlong,
} from "../../points/sweep.ts";
import {
  authoredPoints,
  curveEdge,
  curveGraph,
  curveNode,
  drawnTo,
  mappedTo,
  onDawn,
  vecAt,
  type AuthoredAttribute,
  type CurveSession,
} from "./curve-test-support.ts";
import { curveFramesAttributes } from "./point-curve-frames.ts";
import { sweepAttributes } from "./point-sweep.ts";

/**
 * Sweep (T1587b slices 1 and 3) on a real device, asserted on READ-BACK VERTICES.
 *
 * ## What is asserted for equality, and why it can be (§V147)
 *
 * A vertex is `path point + frame × (profile point × radius)`. Under the identity frame the
 * rotation adds a cross product of zero, a Square's corners are ±1, and a cap's centre is
 * the path point copied. So on fixtures whose numbers are exact in f32 the results are
 * exact too, and those tests say `toEqual`: a Square's eight columns, a mapped radius, a
 * frame of halves that turns the axes into each other, the coordinate along in metres, and
 * a Ring along +Z, which is the Tube generator's points TO THE BIT.
 *
 * Where a result is irrational (a ring turned by a measured frame) the expectation is the
 * CPU reference `points/sweep.ts`, fed the path and the frames READ BACK from the device,
 * so the comparison holds the sweep alone and not Curve Frames' rounding. Single precision;
 * there are no bands.
 *
 * The pictures (lit, Normal and Depth outputs through the Render) are in
 * `point-sweep-render.gpu.test.ts`.
 */

const close = (actual: readonly number[], expected: readonly number[], what: string, digits = 5): void => {
  expected.forEach((value, at) => expect(actual[at], `${what}, component ${at} of [${actual.join(", ")}]`).toBeCloseTo(value, digits));
};
const IDENTITY: Quat = [0, 0, 0, 1];

interface Fixture {
  readonly graph: GraphDocument;
  /** Points of the path. */
  readonly count: number;
  /** What the path edge carries, name and type: what `sweepAttributes` is given. */
  readonly carried: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }>;
  readonly pathSchema: ReadonlyArray<PointAttributeSchema>;
  /** Curve Frames' own attributes, when the path goes through one. */
  readonly frames?: ReadonlyArray<PointAttributeSchema>;
}

/**
 * kernel_path → topology_path (one strip) → [frames_path] → sweep_skin → a sink.
 * `frames: false` leaves Curve Frames out: the path then authors its own `orient`.
 */
function sweepFixture(options: {
  readonly positions: ReadonlyArray<Vec3>;
  readonly extras?: ReadonlyArray<AuthoredAttribute>;
  readonly closed?: boolean;
  readonly frames?: Record<string, unknown> | false;
  readonly sweep: Record<string, unknown>;
  readonly outline?: { readonly positions: ReadonlyArray<Vec3>; readonly closed?: boolean };
}): Fixture {
  const count = options.positions.length;
  const path = authoredPoints("kernel_path", options.positions, options.extras ?? []);
  const measured = options.frames !== false;
  const frameSwitches = {
    frame: options.frames === false || options.frames?.["frame"] !== false,
    vectors: options.frames !== false && options.frames?.["vectors"] === true,
    metrics: options.frames === false || options.frames?.["metrics"] !== false,
  };
  const frames = measured ? curveFramesAttributes(frameSwitches) : undefined;
  const last = measured ? "frames_path" : "topology_path";
  const outline = options.outline === undefined ? undefined : authoredPoints("kernel_outline", options.outline.positions);
  const sink = drawnTo("sweep_skin", 16);
  const graph = curveGraph(
    [
      path.node,
      curveNode("topology_path", "pointTopology", { connectivity: "strips", cols: count, rows: 1, wrapU: options.closed === true }),
      ...(measured ? [curveNode("frames_path", "pointCurveFrames", options.frames ?? {})] : []),
      ...(outline === undefined
        ? []
        : [
            outline.node,
            curveNode("topology_outline", "pointTopology", {
              connectivity: "strips",
              cols: options.outline!.positions.length,
              rows: 1,
              wrapU: options.outline!.closed === true,
            }),
          ]),
      curveNode("sweep_skin", "pointSweep", options.sweep),
      ...sink.nodes,
    ],
    [
      curveEdge(["kernel_path", "out"], ["topology_path", "points"]),
      ...(measured ? [curveEdge(["topology_path", "out"], ["frames_path", "points"])] : []),
      curveEdge([last, "out"], ["sweep_skin", "points"]),
      ...(outline === undefined
        ? []
        : [curveEdge(["kernel_outline", "out"], ["topology_outline", "points"]), curveEdge(["topology_outline", "out"], ["sweep_skin", "profile"])]),
      ...sink.edges,
    ],
  );
  return {
    graph,
    count,
    carried: [...path.schema, ...(frames ?? [])].map(({ name, type }) => ({ name, type })),
    pathSchema: path.schema,
    ...(frames === undefined ? {} : { frames }),
  };
}

/** The swept grid as the device wrote it. */
interface Swept {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly uv: Float32Array;
  attribute(name: string): Promise<{ readonly floats: Float32Array; readonly words: Uint32Array }>;
}

async function readSweep(session: CurveSession, fixture: Fixture, capacity: number): Promise<Swept> {
  const schema = sweepAttributes(fixture.carried);
  const read = (name: string) => session.read("sweep_skin", schema, capacity, name);
  return {
    position: (await read("position")).floats,
    normal: (await read("normal")).floats,
    uv: (await read("uv")).floats,
    attribute: read,
  };
}

/** The path as the device holds it, for the reference: its points, and the frames Curve Frames measured. */
async function readPath(session: CurveSession, fixture: Fixture, scale?: ReadonlyArray<number>): Promise<SweepPathPoint[]> {
  const positions = (await session.read("kernel_path", fixture.pathSchema, fixture.count, "position")).floats;
  const frames = fixture.frames;
  const from = async (name: string): Promise<Float32Array | undefined> =>
    frames?.some((attribute) => attribute.name === name) === true ? (await session.read("frames_path", frames, fixture.count, name)).floats : undefined;
  const orient =
    frames === undefined ? (await session.read("kernel_path", fixture.pathSchema, fixture.count, "orient")).floats : (await from("orient"))!;
  const distance = await from("distance");
  const curveU = await from("curveU");
  const curveLength = await from("curveLength");
  return Array.from({ length: fixture.count }, (_, index) => ({
    position: vecAt(positions, index) as unknown as Vec3,
    orient: vecAt(orient, index, 4) as unknown as Quat,
    ...(scale === undefined ? {} : { scale: scale[index] as number }),
    ...(distance === undefined ? {} : { distance: distance[index] as number }),
    ...(curveU === undefined ? {} : { curveU: curveU[index] as number }),
    ...(curveLength === undefined ? {} : { curveLength: curveLength[index] as number }),
  }));
}

const uvAt = (uv: Float32Array, slot: number): number[] => Array.from(uv.subarray(slot * 2, slot * 2 + 2));

/** A path with its own frame: every point the same quaternion. */
const withOrient = (count: number, orient: Quat): AuthoredAttribute => ({ name: "orient", type: "vec4f", values: Array.from({ length: count }, () => [...orient]) });

const LINE: ReadonlyArray<Vec3> = [
  [0, 0, -1],
  [0, 0, 0],
  [0, 0, 1],
];

describe("Sweep: the vertices of a Square, exact (T1587b)", () => {
  it("lays eight columns a ring at (±r, ±r), two to a corner, each side with its own normal", async () => {
    const fixture = sweepFixture({
      positions: LINE,
      extras: [withOrient(3, IDENTITY)],
      frames: false,
      sweep: { profile: "square", radius: 0.25, uvAlong: "points" },
    });
    await onDawn(fixture.graph, async (session) => {
      expect(session.plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
      const swept = await readSweep(session, fixture, 24);
      /* Round from the +X face: its two corners, then the +Y face's two, and so on. */
      const corners: ReadonlyArray<readonly [number, number]> = [
        [0.25, -0.25], [0.25, 0.25],
        [0.25, 0.25], [-0.25, 0.25],
        [-0.25, 0.25], [-0.25, -0.25],
        [-0.25, -0.25], [0.25, -0.25],
      ];
      const sideNormals: ReadonlyArray<Vec3> = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]];
      for (let row = 0; row < 3; row += 1) {
        for (let column = 0; column < 8; column += 1) {
          const slot = row * 8 + column;
          expect(vecAt(swept.position, slot), `row ${row}, column ${column}`).toEqual([...corners[column]!, row - 1]);
          expect(vecAt(swept.normal, slot), `normal, row ${row}, column ${column}`).toEqual([...sideNormals[Math.floor(column / 2)]!]);
          /* A quarter of the way round per side; the two columns at a corner share it. */
          expect(uvAt(swept.uv, slot), `uv, row ${row}, column ${column}`).toEqual([Math.floor((column + 1) / 2) / 4, row / 2]);
        }
      }
    });
  }, 120_000);

  it("turns the profile by the frame: a frame of halves carries X to Y, Y to Z and Z to X", async () => {
    /* (½, ½, ½, ½) is a third of a turn about (1, 1, 1): every product in the rotation is
       a power of two, so the corner (r, r, 0) of the profile lands on (0, r, r) exactly. */
    const fixture = sweepFixture({
      positions: [[1, 0, 0], [2, 0, 0]],
      extras: [withOrient(2, [0.5, 0.5, 0.5, 0.5])],
      frames: false,
      sweep: { profile: "square", radius: 0.25, uvAlong: "points" },
    });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 16);
      // Column 1 is the corner (r, r) on the +X face, whose normal is the profile's +X: the world's +Y.
      expect(vecAt(swept.position, 1)).toEqual([1, 0.25, 0.25]);
      expect(vecAt(swept.normal, 1)).toEqual([0, 1, 0]);
      // Column 0 is (r, −r): Y by r, Z by −r.
      expect(vecAt(swept.position, 0)).toEqual([1, 0.25, -0.25]);
      // The second ring is the first, one metre along the world's X.
      expect(vecAt(swept.position, 8 + 1)).toEqual([2, 0.25, 0.25]);
    });
  }, 120_000);
});

describe("Sweep: a Ring along a straight path is a cylinder (T1587b)", () => {
  it("is the Tube generator's points to the bit, through a measured frame", async () => {
    /* The Tube lays `cos(angle) × radius, sin(angle) × radius, z` with the angle a column's
       share of a turn; a Ring along +Z under the identity frame is the same three numbers,
       and Curve Frames measures a +Z line with Up +Y as the identity. Rows at exact z. */
    const fixture = sweepFixture({
      positions: [[0, 0, -1], [0, 0, -0.5], [0, 0, 0], [0, 0, 0.5], [0, 0, 1]],
      sweep: { profile: "ring", sides: 16, radius: 0.5, uvAlong: "points" },
    });
    const swept = await onDawn(fixture.graph, async (session) => {
      const path = await readPath(session, fixture);
      for (const point of path) expect(point.orient, "a +Z line with Up +Y is measured as the identity frame").toEqual([0, 0, 0, 1]);
      return (await readSweep(session, fixture, 80)).attribute("position");
    });
    const sink = drawnTo("tube_reference", 16);
    const tube = await onDawn(
      curveGraph([curveNode("tube_reference", "pointTube", { count: 80, cols: 16, rows: 5, radius: 0.5, sizeZ: 2 }), ...sink.nodes], sink.edges),
      async (session) => session.read("tube_reference", [{ name: "position", type: "vec3f" }], 80, "position"),
    );
    for (let slot = 0; slot < 80; slot += 1) {
      expect(Array.from(swept.words.subarray(slot * 4, slot * 4 + 3)), `vertex ${slot}`).toEqual(Array.from(tube.words.subarray(slot * 4, slot * 4 + 3)));
    }
    /* And the cylinder itself, in closed form: every vertex half a metre from the axis, at
       its row's z, a sixteenth of a turn on from the column before. */
    for (let slot = 0; slot < 80; slot += 1) {
      const angle = ((slot % 16) / 16) * 2 * Math.PI;
      close(vecAt(swept.floats, slot), [0.5 * Math.cos(angle), 0.5 * Math.sin(angle), -1 + Math.floor(slot / 16) * 0.5], `vertex ${slot}`, 6);
    }
  }, 120_000);

  it("writes the outward normal and the way round for every vertex", async () => {
    const fixture = sweepFixture({
      positions: [[0, 0, -1], [0, 0, 0], [0, 0, 1]],
      sweep: { profile: "ring", sides: 8, radius: 0.5, uvAlong: "points" },
    });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 24);
      for (let slot = 0; slot < 24; slot += 1) {
        const angle = ((slot % 8) / 8) * 2 * Math.PI;
        close(vecAt(swept.normal, slot), [Math.cos(angle), Math.sin(angle), 0], `normal ${slot}`, 6);
        expect(uvAt(swept.uv, slot), `uv ${slot}`).toEqual([(slot % 8) / 8, Math.floor(slot / 8) / 2]);
      }
    });
  }, 120_000);
});

describe("Sweep: the ring follows the frame it is given (T1587b)", () => {
  it("keeps every ring of a planar arc square to the curve, and its normal out of the plane", async () => {
    /* A quarter circle of radius 2 in the XZ plane, in eight equal chords. Curve Frames'
       tangent at an inner point is the bisector of its two chords, which on equal chords
       is the circle's own tangent there: (sin a, 0, cos a). A planar curve does not twist,
       so the frame's normal stays +Y all the way. */
    const angles = Array.from({ length: 9 }, (_, index) => (index / 8) * (Math.PI / 2));
    const positions = angles.map((a): Vec3 => [2 - 2 * Math.cos(a), 0, 2 * Math.sin(a)]);
    const fixture = sweepFixture({
      positions,
      frames: { vectors: true },
      sweep: { profile: "ring", sides: 8, radius: 0.25, uvAlong: "points" },
    });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 72);
      const path = await readPath(session, fixture);
      const tangents = (await session.read("frames_path", fixture.frames!, 9, "tangent")).floats;
      for (let row = 0; row < 9; row += 1) {
        const origin = path[row]!.position;
        const tangent = vecAt(tangents, row);
        if (row > 0 && row < 8) close(tangent, [Math.sin(angles[row]!), 0, Math.cos(angles[row]!)], `tangent ${row}`, 6);
        for (let column = 0; column < 8; column += 1) {
          const vertex = vecAt(swept.position, row * 8 + column);
          const spoke = [vertex[0]! - origin[0], vertex[1]! - origin[1], vertex[2]! - origin[2]];
          // In the plane square to the tangent, a radius out.
          expect(spoke[0]! * tangent[0]! + spoke[1]! * tangent[1]! + spoke[2]! * tangent[2]!, `ring ${row}, column ${column}: along the tangent`).toBeCloseTo(0, 6);
          expect(Math.hypot(spoke[0]!, spoke[1]!, spoke[2]!), `ring ${row}, column ${column}: radius`).toBeCloseTo(0.25, 6);
        }
        // Column 2 is a quarter of the way round: the frame's +Y, which is the world's.
        close(vecAt(swept.position, row * 8 + 2), [origin[0], origin[1] + 0.25, origin[2]], `ring ${row}: the column on the normal`, 6);
        // Column 0 is on the frame's +X: normal × tangent, in the curve's plane.
        close(vecAt(swept.position, row * 8), [origin[0] + 0.25 * tangent[2]!, origin[1], origin[2] - 0.25 * tangent[0]!], `ring ${row}: the column on X`, 6);
      }
    });
  }, 120_000);

  /* A path that leaves its plane, so every frame is a different rotation. */
  const WANDER: ReadonlyArray<Vec3> = [
    [0, 0, 0],
    [0.5, 0.25, 1],
    [1.25, 1, 1.5],
    [1.5, 2, 1.5],
    [1, 2.75, 2.25],
    [0.25, 3, 3.5],
  ];
  const WIDTHS = [1, 0.5, 2, 1.5, 0.75, 1.25];
  const L_SHAPE: ReadonlyArray<Vec3> = [
    [1, 0, 0],
    [1, 1, 0],
    [1, 1, 0],
    [-0.5, 1, 0],
  ];
  const TRIANGLE: ReadonlyArray<Vec3> = [
    [1, -0.5, 0],
    [0, 1, 0],
    [-1, -0.5, 0],
  ];
  const custom = (points: ReadonlyArray<Vec3>, closed: boolean, smooth: boolean): SweepOutline => ({
    points: points.map((point): Vec2 => [point[0], point[1]]),
    closed,
    flat: !smooth,
  });

  interface Case {
    readonly name: string;
    readonly sweep: Record<string, unknown>;
    readonly outline: SweepOutline;
    readonly wired?: { readonly positions: ReadonlyArray<Vec3>; readonly closed?: boolean };
    readonly inward?: boolean;
    readonly caps?: SweepCaps;
    readonly uvAlong: SweepUvAlong;
    readonly uvLength?: number;
    readonly mapped?: boolean;
    readonly closed?: boolean;
  }
  const CASES: ReadonlyArray<Case> = [
    { name: "a Ring of seven, capped at both ends, stretched", sweep: { profile: "ring", sides: 7 }, outline: sweepOutline("ring", 7, true), caps: "both", uvAlong: "stretch", mapped: true },
    { name: "a Ring of five with flat sides, facing inward, in metres", sweep: { profile: "ring", sides: 5, smooth: false }, outline: sweepOutline("ring", 5, false), inward: true, caps: "start", uvAlong: "metres", uvLength: 0.75 },
    { name: "a Ring of six facing inward", sweep: { profile: "ring", sides: 6 }, outline: sweepOutline("ring", 6, true), inward: true, uvAlong: "points" },
    { name: "a Square capped at its end", sweep: { profile: "square" }, outline: sweepOutline("square", 4, true), caps: "end", uvAlong: "points", mapped: true },
    { name: "a Strip of three segments facing inward", sweep: { profile: "strip", sides: 3 }, outline: sweepOutline("strip", 3, true), inward: true, uvAlong: "stretch" },
    { name: "a custom open outline with one sharp corner", sweep: { profile: "custom" }, outline: custom(L_SHAPE, false, true), wired: { positions: L_SHAPE }, caps: "both", uvAlong: "metres", uvLength: 1.5 },
    { name: "a custom closed outline with flat sides, facing inward", sweep: { profile: "custom", smooth: false }, outline: custom(TRIANGLE, true, false), wired: { positions: TRIANGLE, closed: true }, inward: true, uvAlong: "points" },
    { name: "a custom closed outline, smooth", sweep: { profile: "custom" }, outline: custom(TRIANGLE, true, true), wired: { positions: TRIANGLE, closed: true }, uvAlong: "stretch", mapped: true },
    { name: "a closed path, in metres", sweep: { profile: "ring", sides: 5 }, outline: sweepOutline("ring", 5, true), closed: true, uvAlong: "metres", uvLength: 1.25 },
    { name: "a closed path, by points, with caps asked for", sweep: { profile: "square" }, outline: sweepOutline("square", 4, true), closed: true, caps: "both", uvAlong: "points" },
  ];

  for (const entry of CASES) {
    it(`agrees with the reference: ${entry.name}`, async () => {
      const caps = entry.caps ?? "none";
      const fixture = sweepFixture({
        positions: WANDER,
        extras: [{ name: "width", type: "f32", values: WIDTHS }],
        closed: entry.closed === true,
        ...(entry.wired === undefined ? {} : { outline: entry.wired }),
        sweep: {
          ...entry.sweep,
          radius: entry.mapped === true ? mappedTo("width", 0.2) : 0.2,
          facing: entry.inward === true ? "inward" : "outward",
          caps,
          uvAlong: entry.uvAlong,
          ...(entry.uvLength === undefined ? {} : { uvLength: entry.uvLength }),
        },
      });
      const columns = sweepColumnCount(entry.outline);
      const capRows = sweepCapRows(caps, entry.closed === true);
      const rows = capRows.start + WANDER.length + capRows.end;
      await onDawn(fixture.graph, async (session) => {
        const swept = await readSweep(session, fixture, columns * rows);
        const path = await readPath(session, fixture, entry.mapped === true ? WIDTHS : undefined);
        const expected = sweepStrip(path, {
          outline: entry.outline,
          inward: entry.inward === true,
          radius: 0.2,
          caps,
          pathClosed: entry.closed === true,
          uvAlong: entry.uvAlong,
          uvLength: entry.uvLength ?? 1,
        });
        expect(expected).toHaveLength(columns * rows);
        const widths = (await swept.attribute("width")).floats;
        expected.forEach((vertex, slot) => {
          close(vecAt(swept.position, slot), vertex.position, `position, slot ${slot}`);
          close(vecAt(swept.normal, slot), vertex.normal, `normal, slot ${slot}`);
          close(uvAt(swept.uv, slot), vertex.uv, `uv, slot ${slot}`);
          // What a ring carries is its path point's own.
          expect(widths[slot], `width, slot ${slot}`).toBe(WIDTHS[vertex.point]);
        });
      });
    }, 120_000);
  }
});

describe("Sweep: the radius, mapped (T1587b)", () => {
  const widths = [1, 2, 0.5];
  const fixtureWith = (radius: unknown): Fixture =>
    sweepFixture({
      positions: LINE,
      extras: [withOrient(3, IDENTITY), { name: "width", type: "f32", values: widths }],
      frames: false,
      sweep: { profile: "square", radius, uvAlong: "points" },
    });
  /** The corner (r, r) of each ring: column 1. */
  const corners = async (fixture: Fixture): Promise<number[][]> =>
    onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 24);
      return [0, 1, 2].map((row) => vecAt(swept.position, row * 8 + 1));
    });

  it("multiplies the authored radius by the path's attribute, ring by ring", async () => {
    expect(await corners(fixtureWith(mappedTo("width", 0.25)))).toEqual([
      [0.25, 0.25, -1],
      [0.5, 0.5, 0],
      [0.125, 0.125, 1],
    ]);
  }, 120_000);

  it("is the authored radius on every ring with the map cut", async () => {
    expect(await corners(fixtureWith(0.25))).toEqual([
      [0.25, 0.25, -1],
      [0.25, 0.25, 0],
      [0.25, 0.25, 1],
    ]);
  }, 120_000);
});

describe("Sweep: the coordinate along (T1587b)", () => {
  /* Five points half a metre apart: distances 0, 0.5, 1, 1.5, 2, all exact. */
  const HALVES: ReadonlyArray<Vec3> = [0, 0.5, 1, 1.5, 2].map((z): Vec3 => [0, 0, z]);
  /** uv.y of the first column of every row. */
  const along = async (fixture: Fixture, columns: number, rows: number): Promise<number[]> =>
    onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, columns * rows);
      // One row, one coordinate along: every column of a row agrees.
      for (let slot = 0; slot < columns * rows; slot += 1) expect(swept.uv[slot * 2 + 1], `slot ${slot}`).toBe(swept.uv[Math.floor(slot / columns) * columns * 2 + 1]);
      return Array.from({ length: rows }, (_, row) => swept.uv[row * columns * 2 + 1] as number);
    });

  it("Metres is the distance over the tile: a quarter a row at half a metre and a tile of two", async () => {
    expect(await along(sweepFixture({ positions: HALVES, sweep: { profile: "square", uvAlong: "metres", uvLength: 2 } }), 8, 5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  }, 120_000);

  it("Stretch runs from 0 at the path's start to 1 at its end, whatever its length", async () => {
    expect(await along(sweepFixture({ positions: HALVES, sweep: { profile: "square", uvAlong: "stretch" } }), 8, 5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    // Twice as long, the same coordinate: it is a share of the length. Metres would double.
    const longer = HALVES.map((point): Vec3 => [0, 0, point[2] * 2]);
    expect(await along(sweepFixture({ positions: longer, sweep: { profile: "square", uvAlong: "stretch" } }), 8, 5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(await along(sweepFixture({ positions: longer, sweep: { profile: "square", uvAlong: "metres", uvLength: 2 } }), 8, 5)).toEqual([0, 0.5, 1, 1.5, 2]);
  }, 120_000);

  it("Points is the row over the rows, and reads nothing from the path", async () => {
    /* Unevenly spaced, and no metrics on the path at all. */
    const uneven: ReadonlyArray<Vec3> = [0, 0.25, 1, 4, 4.5].map((z): Vec3 => [0, 0, z]);
    const fixture = sweepFixture({ positions: uneven, frames: { metrics: false }, sweep: { profile: "square", uvAlong: "points" } });
    expect(await along(fixture, 8, 5)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  }, 120_000);

  it("a closed path holds a whole number of tiles, so the pattern meets itself at the seam", async () => {
    /* A square loop of side 1: four metres round. A tile of 1.5 asks for 2.67 tiles and gets
       3, so a metre is three quarters of a tile and the fourth corner is at 2.25. The seam,
       one more metre on, is at 3: a whole number. */
    const loop: ReadonlyArray<Vec3> = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const fixture = sweepFixture({ positions: loop, closed: true, sweep: { profile: "square", uvAlong: "metres", uvLength: 1.5 } });
    expect(await along(fixture, 8, 4)).toEqual([0, 0.75, 1.5, 2.25]);
    // The control: the same loop opened is plain metres over the tile.
    const open = sweepFixture({ positions: loop, sweep: { profile: "square", uvAlong: "metres", uvLength: 1.5 } });
    const plain = await along(open, 8, 4);
    [0, 1 / 1.5, 2 / 1.5, 2].forEach((value, row) => expect(plain[row], `open, row ${row}`).toBeCloseTo(value, 6));
  }, 120_000);
});

describe("Sweep: what a ring carries (T1587b)", () => {
  it("copies every attribute of the path point to each vertex of its ring, floats and integers alike", async () => {
    const colours = [[1, 0, 0, 1], [0, 0.5, 0, 1], [0.25, 0.25, 1, 0.5]];
    const serials = [7, 4_000_000_000, 12];
    const fixture = sweepFixture({
      positions: LINE,
      extras: [
        { name: "color", type: "vec4f", values: colours },
        { name: "serial", type: "u32", values: serials },
      ],
      sweep: { profile: "ring", sides: 5, uvAlong: "points" },
    });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 15);
      const colour = (await swept.attribute("color")).floats;
      const serial = (await swept.attribute("serial")).words;
      const distance = (await swept.attribute("distance")).floats;
      for (let slot = 0; slot < 15; slot += 1) {
        const row = Math.floor(slot / 5);
        expect(vecAt(colour, slot, 4), `colour, slot ${slot}`).toEqual(colours[row]);
        expect(serial[slot], `serial, slot ${slot}`).toBe(serials[row]);
        // Curve Frames' own measurement rides along too: a kernel after the sweep can read it.
        expect(distance[slot], `distance, slot ${slot}`).toBe(row);
      }
    });
  }, 120_000);

  it("sweeps padding to rings of no length: a path that repeats its end repeats its last ring", async () => {
    /* A strip shorter than its slots repeats its end point (§V788), and Curve Frames gives
       the repeats the end's frame, so the rings there are one ring several times. */
    const fixture = sweepFixture({
      positions: [[0, 0, 0], [0.5, 0, 1], [0.5, 0.5, 2], [0.5, 0.5, 2], [0.5, 0.5, 2]],
      sweep: { profile: "ring", sides: 6, radius: 0.3, uvAlong: "stretch", caps: "end" },
    });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 6 * 7);
      for (let column = 0; column < 6; column += 1) {
        const ring = vecAt(swept.position, 2 * 6 + column);
        // Rows 3 and 4 are the repeats, row 5 the cap's rim: all the last real ring.
        for (const row of [3, 4, 5]) expect(vecAt(swept.position, row * 6 + column), `row ${row}, column ${column}`).toEqual(ring);
        // The cap's centre is the end point itself.
        expect(vecAt(swept.position, 6 * 6 + column)).toEqual([0.5, 0.5, 2]);
      }
    });
  }, 120_000);
});

describe("Sweep: caps (T1587b slice 3)", () => {
  /* The path authors its own frame and its own metrics, so every number below is exact. */
  const metrics: ReadonlyArray<AuthoredAttribute> = [
    withOrient(3, IDENTITY),
    { name: "distance", type: "f32", values: [0, 1, 2] },
    { name: "curveU", type: "f32", values: [0, 0.5, 1] },
    { name: "curveLength", type: "f32", values: [2, 2, 2] },
  ];
  const capped = (sweep: Record<string, unknown>): Fixture =>
    sweepFixture({ positions: LINE, extras: metrics, frames: false, sweep: { profile: "square", radius: 0.25, ...sweep } });

  it("adds two rows an end: the end ring again, then that ring drawn in to the path point", async () => {
    const fixture = capped({ caps: "both", uvAlong: "points" });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 8 * 7);
      for (let column = 0; column < 8; column += 1) {
        const at = (row: number): number[] => vecAt(swept.position, row * 8 + column);
        const normal = (row: number): number[] => vecAt(swept.normal, row * 8 + column);
        // The start: its centre is the first path point, its rim the first ring.
        expect(at(0)).toEqual([0, 0, -1]);
        expect(at(1)).toEqual(at(2));
        // The end: its rim is the last ring, its centre the last path point.
        expect(at(5)).toEqual(at(4));
        expect(at(6)).toEqual([0, 0, 1]);
        // A cap faces out of its end; the tube's own end rings keep their sides' normals.
        expect(normal(0)).toEqual([0, 0, -1]);
        expect(normal(1)).toEqual([0, 0, -1]);
        expect(normal(5)).toEqual([0, 0, 1]);
        expect(normal(6)).toEqual([0, 0, 1]);
        expect(normal(2)).toEqual(normal(4));
        expect(normal(2)[2]).toBe(0);
        // Points counts every row, the caps' included.
        for (let row = 0; row < 7; row += 1) expect(swept.uv[(row * 8 + column) * 2 + 1], `row ${row}`).toBeCloseTo(row / 6, 6);
      }
    });
  }, 120_000);

  it("one end only: Start puts its two rows first, End its two last", async () => {
    for (const [caps, centreRow, centreAt] of [["start", 0, [0, 0, -1]], ["end", 4, [0, 0, 1]]] as const) {
      const fixture = capped({ caps, uvAlong: "points" });
      await onDawn(fixture.graph, async (session) => {
        const swept = await readSweep(session, fixture, 8 * 5);
        for (let column = 0; column < 8; column += 1) expect(vecAt(swept.position, centreRow * 8 + column), `${caps}, column ${column}`).toEqual([...centreAt]);
        // The three rings are where they were: rows 2 to 4 after a start cap, 0 to 2 before an end cap.
        const first = caps === "start" ? 2 : 0;
        expect(vecAt(swept.position, first * 8 + 1)).toEqual([0.25, 0.25, -1]);
        expect(vecAt(swept.position, (first + 2) * 8 + 1)).toEqual([0.25, 0.25, 1]);
      });
    }
  }, 120_000);

  it("carries the coordinate along on over the edge: a cap's centre is one radius further", async () => {
    const rowsOf = async (sweep: Record<string, unknown>): Promise<number[]> => {
      const fixture = capped({ caps: "both", ...sweep });
      return onDawn(fixture.graph, async (session) => {
        const swept = await readSweep(session, fixture, 8 * 7);
        return Array.from({ length: 7 }, (_, row) => swept.uv[row * 8 * 2 + 1] as number);
      });
    };
    // Metres, a tile of half a metre: the rims at 0 and 4, the centres a quarter metre beyond.
    expect(await rowsOf({ uvAlong: "metres", uvLength: 0.5 })).toEqual([-0.5, 0, 0, 2, 4, 4, 4.5]);
    // Stretch: a quarter metre of a two-metre path is an eighth.
    expect(await rowsOf({ uvAlong: "stretch" })).toEqual([-0.125, 0, 0, 0.5, 1, 1, 1.125]);
  }, 120_000);

  it("a cap takes its radius from its own end of a tapered path", async () => {
    const fixture = sweepFixture({
      positions: LINE,
      extras: [...metrics, { name: "width", type: "f32", values: [2, 1, 0.5] }],
      frames: false,
      sweep: { profile: "square", radius: mappedTo("width", 0.25), caps: "both", uvAlong: "metres", uvLength: 1 },
    });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 8 * 7);
      // The rims: the start's at half a metre, the end's at an eighth.
      expect(vecAt(swept.position, 1 * 8 + 1)).toEqual([0.5, 0.5, -1]);
      expect(vecAt(swept.position, 5 * 8 + 1)).toEqual([0.125, 0.125, 1]);
      expect(Array.from({ length: 7 }, (_, row) => swept.uv[row * 8 * 2 + 1])).toEqual([-0.5, 0, 0, 1, 2, 2, 2.125]);
    });
  }, 120_000);
});

describe("Sweep: Facing (T1587b)", () => {
  it("Inward walks the same outline the other way: the columns reversed, the normals turned, the way round still rising", async () => {
    const facingOf = async (facing: string): Promise<Swept> => {
      const fixture = sweepFixture({
        positions: LINE,
        extras: [withOrient(3, IDENTITY)],
        frames: false,
        sweep: { profile: "square", radius: 0.25, facing, uvAlong: "points" },
      });
      return onDawn(fixture.graph, async (session) => readSweep(session, fixture, 24));
    };
    const outward = await facingOf("outward");
    const inward = await facingOf("inward");
    for (let slot = 0; slot < 24; slot += 1) {
      const mirror = Math.floor(slot / 8) * 8 + (7 - (slot % 8));
      expect(vecAt(inward.position, slot), `position, slot ${slot}`).toEqual(vecAt(outward.position, mirror));
      // Negated; `+ 0` so that a −0 reads as the 0 it is.
      expect(vecAt(inward.normal, slot).map((value) => value + 0), `normal, slot ${slot}`).toEqual(vecAt(outward.normal, mirror).map((value) => -value + 0));
      expect(uvAt(inward.uv, slot), `uv, slot ${slot}`).toEqual(uvAt(outward.uv, slot));
    }
  }, 120_000);

  it("an inward Ring starts on the same point and goes the other way round", async () => {
    const fixture = sweepFixture({
      positions: LINE,
      extras: [withOrient(3, IDENTITY)],
      frames: false,
      sweep: { profile: "ring", sides: 8, radius: 0.5, facing: "inward", uvAlong: "points" },
    });
    await onDawn(fixture.graph, async (session) => {
      const swept = await readSweep(session, fixture, 24);
      expect(vecAt(swept.position, 0)).toEqual([0.5, 0, -1]);
      for (let column = 0; column < 8; column += 1) {
        const angle = -(column / 8) * 2 * Math.PI;
        close(vecAt(swept.position, column), [0.5 * Math.cos(angle), 0.5 * Math.sin(angle), -1], `column ${column}`, 6);
        // Toward the path.
        close(vecAt(swept.normal, column), [-Math.cos(angle), -Math.sin(angle), 0], `normal ${column}`, 6);
        expect(swept.uv[column * 2], `the way round, column ${column}`).toBe(column / 8);
      }
    });
  }, 120_000);
});
