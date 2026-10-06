import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import {
  BORE_ATTRIBUTES,
  BORE_CHAMBERS as CHAMBERS,
  BORE_COLUMNS,
  BORE_KERNEL,
  BORE_PATH as PATH,
  BORE_PATH_WGSL,
  BORE_ROWS,
  boreChamberAt as chamberAt,
  borePathAt as pathAt,
} from "./point-sweep-bore.fixture.ts";
import { curveEdge, curveGraph, curveNode, drawnTo, mappedTo, onDawn } from "./curve-test-support.ts";
import { curveAttributes } from "./point-curve.ts";
import { curveFramesAttributes } from "./point-curve-frames.ts";
import { resampleAttributes } from "./point-resample.ts";
import { sweepAttributes } from "./point-sweep.ts";

/**
 * T1587b — THE WORKED CHECK: the sentinel tunnel's bore, laid by the stock nodes and held
 * against the hand-written kernel-bent grid it would replace.
 *
 * That grid is the sentinel-bot project's, FROZEN in `point-sweep-bore.fixture.ts` as it stood
 * when this check was made (the fixture names the files, the commits and the date). This file
 * imports nothing from the project: it proves a fact about a fixed input, and a later change
 * to the project's bore neither reddens it nor is covered by it.
 *
 * The bore is one grid of 256 × 768 vertices that a kernel bends: for every vertex it works
 * out the centre line's frame at the row's distance from a closed form, and puts the vertex
 * a radius out. A Sweep does the second half and Curve Frames the first, from points. This
 * file measures how far apart the two land, and every bound below is derived from what
 * explains the difference, so a number that grows past its explanation goes red.
 *
 * ## What was measured (Dawn on Metal, 2026-10-06), and what explains it
 *
 * 1. ON THE BORE'S OWN ROWS (the path's points from the bore's own formula): the worst vertex
 *    of the 766 inner rings is 0.11 mm from the bore's. It is rounding: the frame's tangent
 *    is measured from points a 32-bit float holds to 0.004 mm, across a 0.15 m chord, and a
 *    hall's 5 m radius multiplies that angle. The first ring is 2.7 mm off and the last
 *    0.7 mm: a strip's end has one chord to take its tangent from.
 * 2. THROUGH A CURVE AND A RESAMPLE (control points on the formula every 1.2 m, eight
 *    segments, rows at the curve's own points): the centre line is within 0.12 mm, the wall
 *    within 0.9 mm of the bore's surface, and a vertex within 2.3 mm of the bore's vertex at
 *    the same place. It is the spline's DIRECTION: a Catmull-Rom's tangent at a control
 *    point is the chord across two spans, which is off the curve's own by h² f‴ ÷ 6, and a
 *    ring of radius R turns an angle into R times as much. Halving the spacing quarters it
 *    (11.2 mm at 2.4 m, 2.3 mm at 1.2 m, 0.4 mm at 0.6 m).
 * 3. THE REPEATED TAIL. The tunnel repeats every 960 m of z, which is 1,058.257 m of curve.
 *    A Resample by Distance lays its rows from the start of its Range, so the rows a period
 *    on are the same rows — to 0.23 mm, which is what a float holds of a distance near
 *    1,200 m — when the Range starts a period on. That period is 7,055.05 rows of 0.15 m:
 *    a Range stepped in whole rows of 0.15 m does NOT land on the same places a period
 *    later (7.4 mm off). Rows taken at the curve's own points do: a period is then a whole
 *    number of rows because the control points say so.
 */

const COLUMNS = BORE_COLUMNS;
const ROWS = BORE_ROWS;
/** The bore's row spacing, the rows behind the robots and the liner's standing off: the kernel's own, read from its text. */
const ROW = 0.15;
const ROWS_BEHIND = 180;
const LINER = 0.05;
const BORE = 2.6;

const POSITION = { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] } as const;
const WITH_HALL = [POSITION, { name: "hall", type: "f32", default: [0] }] as const;
const FRAMES = curveFramesAttributes({ frame: true, vectors: true, metrics: true });
const named = (schema: ReadonlyArray<{ readonly name: string; readonly type: string }>) => schema.map(({ name, type }) => ({ name, type })) as never;

/* ── The bore as a function, in float64: its centre line, its frame, its radius ── */
type V3 = readonly [number, number, number];
const wave = (cycles: number): number => (2 * Math.PI * cycles) / PATH.period;
/** The centre line's first or second derivative by z. */
const derivative = (order: 1 | 2, z: number): V3 => {
  const of = (terms: typeof PATH.x): number =>
    terms.reduce((sum, term) => {
      const w = wave(term.cycles);
      const angle = w * z + term.phase;
      return sum + term.amplitude * (order === 1 ? w * Math.cos(angle) : -w * w * Math.sin(angle));
    }, 0);
  return [of(PATH.x), of(PATH.y), order === 1 ? 1 : 0];
};
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const minus = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const size = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => [a[0] / size(a), a[1] / size(a), a[2] / size(a)];
const radiusAt = (z: number): number => BORE * (1 + CHAMBERS.swell * chamberAt(z)) + LINER;
/** The bore's vertex at distance z and angle theta, as its kernel lays it with no relief and no deck. */
function boreVertex(z: number, theta: number): V3 {
  const origin = pathAt(z);
  const forward = unit(derivative(1, z));
  const right = unit(cross([0, 1, 0], forward));
  const up = cross(forward, right);
  const radius = radiusAt(z);
  return [0, 1, 2].map((axis) => origin[axis]! + (right[axis]! * Math.cos(theta) + up[axis]! * Math.sin(theta)) * radius) as unknown as V3;
}
/** How far a point stands off the bore's wall: its distance from the centre line, in the ring whose plane it lies in, less the radius there. */
function offTheWall(point: V3, near: number): number {
  let z = near;
  for (let step = 0; step < 6; step += 1) {
    const from = minus(point, pathAt(z));
    const along = derivative(1, z);
    z += dot(from, along) / (dot(along, along) - dot(from, derivative(2, z)));
  }
  return size(minus(point, pathAt(z))) - radiusAt(z);
}
/* The most the centre line turns and the most its turn changes, per metre: sums of the terms' own, so no search. */
const peak = (order: 2 | 3): number =>
  Math.hypot(...[PATH.x, PATH.y].map((terms) => terms.reduce((sum, term) => sum + term.amplitude * wave(term.cycles) ** order, 0)));
const MOST_BEND = peak(2);
const MOST_JERK = peak(3);
const HALL_RADIUS = BORE * (1 + CHAMBERS.swell) + LINER;
/** What a 32-bit float holds of a number up to `reach`. */
const resolves = (reach: number): number => 2 ** (Math.ceil(Math.log2(reach)) - 24);

const at = (floats: Float32Array, index: number): V3 => [floats[index * 4]!, floats[index * 4 + 1]!, floats[index * 4 + 2]!];

describe("T1587b: the sentinel tunnel's bore from Curve Frames and a Sweep, on the bore's own rows", () => {
  /** The frozen bore as a plain pipe: no relief, and a deck too low to cut it. */
  const boreGraph = (): GraphDocument => {
    const sink = drawnTo("kernel_bore", 16);
    return curveGraph(
      [
        curveNode("grid_bore", "pointGrid", { cols: COLUMNS, rows: ROWS, count: COLUMNS * ROWS, sizeX: 2, sizeY: 2 }),
        curveNode("kernel_bore", "pointKernel", { capacity: COLUMNS * ROWS, attributes: BORE_ATTRIBUTES, kernel: BORE_KERNEL, travel: 0, bore: BORE, relief: 0, deck: 3 }),
        ...sink.nodes,
      ],
      [curveEdge(["grid_bore", "out"], ["kernel_bore", "in"]), ...sink.edges],
    );
  };
  /* The path: the bore's rows at travel 0, by the bore's own centre line, with the hall's radius beside each. */
  const PATH_KERNEL = `${BORE_PATH_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let z = (f32(ctx.index) - ${ROWS_BEHIND}.0) * ${ROW.toFixed(5)};
  q.position = pathAt(z);
  q.hall = ${BORE} * (1.0 + CHAMBER_SWELL * chamberAt(z)) + ${LINER};
  return q;
}`;
  /* The bore's columns as an outline: 256 points from straight down, the last on the first. */
  const OUTLINE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let theta = (f32(ctx.index) / ${COLUMNS - 1}.0 - 0.25) * 6.2831853;
  q.position = vec3f(cos(theta), sin(theta), 0.0);
  return q;
}`;
  const sweptGraph = (variant: "outline" | "ring"): GraphDocument => {
    const sink = drawnTo("sweep_bore", 16);
    return curveGraph(
      [
        curveNode("kernel_path", "pointKernel", { capacity: ROWS, seed: 7, attributes: JSON.stringify(WITH_HALL), kernel: PATH_KERNEL }),
        curveNode("topology_path", "pointTopology", { connectivity: "strips", cols: ROWS, rows: 1 }),
        // A Ring starts on the frame's +X and the bore straight down: a quarter turn of the frame.
        curveNode("frames_path", "pointCurveFrames", { method: "fixedUp", vectors: true, roll: variant === "ring" ? -90 : 0 }),
        ...(variant === "outline"
          ? [
              curveNode("kernel_outline", "pointKernel", { capacity: COLUMNS, seed: 7, attributes: JSON.stringify([POSITION]), kernel: OUTLINE_KERNEL }),
              curveNode("topology_outline", "pointTopology", { connectivity: "strips", cols: COLUMNS, rows: 1 }),
            ]
          : []),
        curveNode("sweep_bore", "pointSweep", { profile: variant === "outline" ? "custom" : "ring", sides: COLUMNS - 1, radius: mappedTo("hall", 1), uvAlong: "points" }),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_path", "out"], ["topology_path", "points"]),
        curveEdge(["topology_path", "out"], ["frames_path", "points"]),
        curveEdge(["frames_path", "out"], ["sweep_bore", "points"]),
        ...(variant === "outline" ? [curveEdge(["kernel_outline", "out"], ["topology_outline", "points"]), curveEdge(["topology_outline", "out"], ["sweep_bore", "profile"])] : []),
        ...sink.edges,
      ],
    );
  };

  it("lays the kernel-bent grid's vertices: every inner ring to a float's rounding, the two end rings to their one chord", async () => {
    /* Three numbers of this file are the frozen kernel's own, and the float64 centre line is
       the WGSL one: the fixture agrees with itself, so the two sides below are one tunnel. */
    expect(BORE_KERNEL).toContain(`const ROW: f32 = ${ROW.toFixed(5)};`);
    expect(BORE_KERNEL).toContain(`- ${ROWS_BEHIND}.0) * ROW`);
    expect(BORE_KERNEL).toContain(`let liner = bore + ${LINER};`);
    expect([COLUMNS, ROWS]).toEqual([256, 768]);
    const nine = (value: number): string => (Number.isInteger(value) ? value.toFixed(1) : String(Number(value.toPrecision(9))));
    for (const term of [...PATH.x, ...PATH.y]) {
      expect(BORE_PATH_WGSL).toContain(`${nine(term.amplitude)} * sin(${nine(wave(term.cycles))} * z + ${nine(term.phase)})`);
    }
    expect(BORE_PATH_WGSL).toContain(`const PATH_PERIOD: f32 = ${nine(PATH.period)};`);
    expect(BORE_PATH_WGSL).toContain(`const CHAMBER_SWELL: f32 = ${nine(CHAMBERS.swell)};`);
    expect(BORE_PATH_WGSL).toContain(`let along = z - ${nine(CHAMBERS.spacing)} * floor(z / ${nine(CHAMBERS.spacing)});`);
    expect(BORE_PATH_WGSL).toContain(`smoothstep(${nine(CHAMBERS.reach - CHAMBERS.flare)}, ${nine(CHAMBERS.reach)}, abs(along - ${nine(CHAMBERS.spacing / 2)}))`);

    const bore = await onDawn(boreGraph(), async (session) => new Float32Array((await session.read("kernel_bore", JSON.parse(BORE_ATTRIBUTES), COLUMNS * ROWS, "position")).floats));
    // The grid is the tunnel: its seam is two columns in one place.
    expect(at(bore, 0)).toEqual(at(bore, COLUMNS - 1));

    /* An inner ring's tangent is the bisector of two chords between points a float rounds
       to half of what it resolves at 128 m, on each of three axes; the angle that makes,
       times a hall's radius, is the most a vertex can be out. Plus the same rounding of the
       vertex itself, twice (the bore's and the sweep's). */
    const rounding = resolves(128) / 2;
    const innerBound = HALL_RADIUS * ((2 * rounding * Math.sqrt(3)) / ROW) + 2 * rounding * Math.sqrt(3);
    /* An end ring has one chord, whose direction is the curve's half a chord further on:
       off the end's own tangent by half the turn across it. */
    const endBound = HALL_RADIUS * ((ROW * MOST_BEND) / 2) + innerBound;
    expect(innerBound).toBeLessThan(0.0005);

    for (const variant of ["outline", "ring"] as const) {
      const columns = variant === "outline" ? COLUMNS : COLUMNS - 1;
      const swept = await onDawn(sweptGraph(variant), async (session) => {
        const claim = session.plan.passes.find((pass) => pass.id.includes("sweep_bore:sweep"))?.id;
        // The bore as it is: 256 columns, the seam doubled. As a Ring: 255, the seam wrapped.
        expect(claim).toContain(variant === "outline" ? `${COLUMNS}x${ROWS}` : `${COLUMNS - 1}x${ROWS}`);
        return new Float32Array((await session.read("sweep_bore", sweepAttributes(named([...WITH_HALL, ...FRAMES])), columns * ROWS, "position")).floats);
      });
      let inner = 0;
      const ends = [0, 0];
      for (let row = 0; row < ROWS; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const apart = size(minus(at(swept, row * columns + column), at(bore, row * COLUMNS + column)));
          if (row === 0) ends[0] = Math.max(ends[0]!, apart);
          else if (row === ROWS - 1) ends[1] = Math.max(ends[1]!, apart);
          else inner = Math.max(inner, apart);
        }
      }
      expect(inner, `${variant}: the worst inner vertex, metres (measured 0.00011)`).toBeLessThan(innerBound);
      expect(ends[0], `${variant}: the first ring, metres (measured 0.0027)`).toBeLessThan(endBound);
      expect(ends[1], `${variant}: the last ring, metres (measured 0.0007)`).toBeLessThan(endBound);
      // The ends really are the worse for their one chord: the bound above is not slack on a thing that is exact.
      expect(ends[0]).toBeGreaterThan(inner);
    }
  }, 240_000);
});

describe("T1587b: the bore through a Curve and a Resample, and its repeated tail", () => {
  /* Control points on the centre line every SPACING metres of z, from 27 spacings before
     z = 0 to 77 past one period: the window of 768 rows starts 27 m behind and reaches 88 m
     ahead, and the last span of an open spline is shaped by its end, so the tail carries
     one control point more than is used. x and y come from the point's index WITHIN its
     period, so the tail's are the head's to the bit; only z is 960 m on. */
  const SPACING = 1.2;
  const SEGMENTS = 8;
  const PER_PERIOD = Math.round(PATH.period / SPACING);
  const BEFORE = 27;
  const CONTROLS = BEFORE + PER_PERIOD + 78;
  const CURVE_POINTS = (CONTROLS - 1) * SEGMENTS + 1;
  /** The curve point at the control point on z = 0, and how many curve points a period is. */
  const ORIGIN = BEFORE * SEGMENTS;
  const PERIOD_POINTS = PER_PERIOD * SEGMENTS;
  /** The first row of the window: 27 m behind z = 0. */
  const WINDOW_FROM = ORIGIN - Math.round(27 / (SPACING / SEGMENTS));
  const SIDES = COLUMNS - 1;

  const CONTROL_KERNEL = `${BORE_PATH_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let turn = (i32(ctx.index) - ${BEFORE} + ${PER_PERIOD}) / ${PER_PERIOD} - 1;
  let within = i32(ctx.index) - ${BEFORE} - turn * ${PER_PERIOD};
  let on = pathAt(f32(within) * ${SPACING});
  q.position = vec3f(on.x, on.y, on.z + f32(turn) * PATH_PERIOD);
  return q;
}`;
  const HALL_KERNEL = `${BORE_PATH_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.hall = ${BORE} * (1.0 + CHAMBER_SWELL * chamberAt(p.position.z)) + ${LINER};
  return q;
}`;

  /** kernel_control → curve_centre → [resample_window → kernel_hall → frames_window → sweep_bore]. */
  const chain = (resample?: Record<string, unknown>): GraphDocument => {
    const sink = drawnTo(resample === undefined ? "curve_centre" : "sweep_bore", 16);
    return curveGraph(
      [
        curveNode("kernel_control", "pointKernel", { capacity: CONTROLS, seed: 7, attributes: JSON.stringify([POSITION]), kernel: CONTROL_KERNEL }),
        curveNode("topology_control", "pointTopology", { connectivity: "strips", cols: CONTROLS, rows: 1 }),
        curveNode("curve_centre", "pointCurve", { basis: "catmullRom", segments: SEGMENTS }),
        ...(resample === undefined
          ? []
          : [
              curveNode("resample_window", "pointResample", resample),
              curveNode("kernel_hall", "pointKernel", { capacity: ROWS, seed: 7, attributes: JSON.stringify(WITH_HALL), kernel: HALL_KERNEL }),
              curveNode("frames_window", "pointCurveFrames", { method: "fixedUp", vectors: true, roll: -90 }),
              curveNode("sweep_bore", "pointSweep", { profile: "ring", sides: SIDES, radius: mappedTo("hall", 1), uvAlong: "points" }),
            ]),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_control", "out"], ["topology_control", "points"]),
        curveEdge(["topology_control", "out"], ["curve_centre", "in"]),
        ...(resample === undefined
          ? []
          : [
              curveEdge(["curve_centre", "out"], ["resample_window", "points"]),
              curveEdge(["resample_window", "out"], ["kernel_hall", "in"]),
              curveEdge(["kernel_hall", "out"], ["frames_window", "points"]),
              curveEdge(["frames_window", "out"], ["sweep_bore", "points"]),
            ]),
        ...sink.edges,
      ],
    );
  };

  interface Window {
    /** The rows' path points, their measured tangents, and the wall's vertices. */
    readonly stations: Float32Array;
    readonly tangents: Float32Array;
    readonly vertices: Float32Array;
  }
  const windowOf = (resample: Record<string, unknown>): Promise<Window> =>
    onDawn(chain(resample), async (session) => {
      const padded = resample["method"] !== "count";
      const stations = new Float32Array((await session.read("kernel_hall", WITH_HALL, ROWS, "position")).floats);
      const tangents = new Float32Array((await session.read("frames_window", FRAMES, ROWS, "tangent")).floats);
      const carried = named([...WITH_HALL, ...(padded ? [{ name: "live", type: "f32" }] : []), ...FRAMES]);
      const vertices = new Float32Array((await session.read("sweep_bore", sweepAttributes(carried), SIDES * ROWS, "position")).floats);
      if (padded) {
        const live = (await session.read("resample_window", resampleAttributes([POSITION], true), ROWS, "live")).floats;
        // Every slot is a row: the Range holds all 768 and no padding stands in for one.
        expect(Array.from(live).filter((value) => value > 0.5)).toHaveLength(ROWS);
      }
      return { stations, tangents, vertices };
    });
  /** Rows at the curve's own points: Count, Even Parameter, a Range that starts and ends on a point. */
  const byPoints = (from: number): Record<string, unknown> => ({
    method: "count",
    count: ROWS,
    spacing: "parameter",
    rangeStart: from / (CURVE_POINTS - 1),
    rangeEnd: (from + ROWS - 1) / (CURVE_POINTS - 1),
  });
  /** The worst any vertex of one window is from the same vertex of another, a period on. */
  const apartByAPeriod = (head: Float32Array, tail: Float32Array, count: number): number => {
    let worst = 0;
    for (let index = 0; index < count; index += 1) {
      const moved = at(tail, index);
      worst = Math.max(worst, size(minus([moved[0], moved[1], moved[2] - PATH.period], at(head, index))));
    }
    return worst;
  };

  it("the wall is the bore's to within what the spline's direction is off by, and no more", async () => {
    const head = await windowOf(byPoints(WINDOW_FROM));

    /* A Catmull-Rom's tangent at a control point is the chord across two spans, off the
       curve's own by h² f‴ ÷ 6; between control points the cubic's is no worse. */
    const directionBound = (SPACING ** 2 * MOST_JERK) / 6;
    /* A cubic through exact end points with end tangents that far out stands off the curve
       by at most 8/27 of a span of it (4/27 an end). */
    const lineBound = SPACING * directionBound * (8 / 27);
    /* The frame is then measured from the curve's points across chords of a row: the
       rounding of the first test, on top. */
    const rounding = resolves(128) / 2;
    const measuredBound = directionBound + (2 * rounding * Math.sqrt(3)) / (SPACING / SEGMENTS) + ((SPACING / SEGMENTS) * MOST_BEND) ** 2;

    let line = 0;
    let direction = 0;
    let vertex = 0;
    let wall = 0;
    for (let row = 1; row < ROWS - 1; row += 1) {
      const station = at(head.stations, row);
      line = Math.max(line, size(minus(station, pathAt(station[2]))));
      direction = Math.max(direction, Math.acos(Math.min(1, dot(unit(at(head.tangents, row)), unit(derivative(1, station[2]))))));
      for (let column = 0; column < SIDES; column += 1) {
        const swept = at(head.vertices, row * SIDES + column);
        // The bore's vertex at this row's own distance and this column's angle.
        vertex = Math.max(vertex, size(minus(swept, boreVertex(station[2], (column / SIDES - 0.25) * 2 * Math.PI))));
        wall = Math.max(wall, Math.abs(offTheWall(swept, station[2])));
      }
    }
    expect(line, "the centre line, metres (measured 0.00012)").toBeLessThan(lineBound);
    expect(direction, "the frame's tangent against the curve's own, radians (measured 0.00045)").toBeLessThan(measuredBound);
    // A ring turns an angle into a radius times as much, about a centre that is itself a little off.
    expect(vertex, "a vertex against the bore's at the same place, metres (measured 0.0023)").toBeLessThan(HALL_RADIUS * measuredBound + lineBound);
    /* Off the wall itself a vertex is less out than that: turning a ring slides its rim
       ALONG the wall, and only where the wall flares (a hall opening, at most its swell
       over its flare, times 3/2 for the smoothstep's steepest) does sliding leave it. */
    const flare = ((BORE * CHAMBERS.swell) / CHAMBERS.flare) * 1.5;
    expect(wall, "a vertex off the bore's wall, metres (measured 0.0009)").toBeLessThan(flare * HALL_RADIUS * measuredBound + lineBound);
    // And the explanation is the spline, not slack: the direction is most of what its bound allows.
    expect(direction).toBeGreaterThan(directionBound / 4);
  }, 240_000);

  it("rows at the curve's own points: a period on, the same rows", async () => {
    const head = await windowOf(byPoints(WINDOW_FROM));
    const tail = await windowOf(byPoints(WINDOW_FROM + PERIOD_POINTS));
    /* What a float holds of a z near 1,050 m is 0.12 mm, and the spline blends three times
       to reach a point: the tail's rows are the head's to that. */
    expect(apartByAPeriod(head.stations, tail.stations, ROWS), "rows, metres (measured 0.00014)").toBeLessThan(3 * resolves(1100));
    /* The wall is further out than its rows are: its frame is measured across a 0.15 m
       chord, so that rounding becomes an angle and a hall's radius multiplies it. */
    const frameRounding = (2 * resolves(1100)) / (SPACING / SEGMENTS);
    expect(apartByAPeriod(head.vertices, tail.vertices, SIDES * ROWS), "the wall, metres (measured 0.0008)").toBeLessThan(HALL_RADIUS * frameRounding + 3 * resolves(1100));
  }, 240_000);

  it("rows by Distance: the same rows a period on when the Range starts a period on, and a period is not a whole number of 0.15 m rows", async () => {
    /* The curve's own points, and how far along each is, in float64 from what the device wrote. */
    const curve = await onDawn(chain(), async (session) => new Float32Array((await session.read("curve_centre", curveAttributes([POSITION], "catmullRom"), CURVE_POINTS, "position")).floats));
    const distance = new Float64Array(CURVE_POINTS);
    for (let index = 1; index < CURVE_POINTS; index += 1) distance[index] = distance[index - 1]! + size(minus(at(curve, index), at(curve, index - 1)));
    const total = distance[CURVE_POINTS - 1]!;
    const period = distance[ORIGIN + PERIOD_POINTS]! - distance[ORIGIN]!;

    /* The tail IS the head, 960 m on, wherever the last span's end condition does not reach. */
    let copy = 0;
    for (let index = ORIGIN; index + PERIOD_POINTS <= CURVE_POINTS - 1 - SEGMENTS; index += 1) {
      const moved = at(curve, index + PERIOD_POINTS);
      copy = Math.max(copy, size(minus([moved[0], moved[1], moved[2] - PATH.period], at(curve, index))));
    }
    expect(copy, "the curve's tail against its head, metres (measured 0.00015)").toBeLessThan(3 * resolves(1100));

    /* One period of z is 960 m; of curve it is 1,058.26 m, and that is not a whole number of
       0.15 m rows. A Range stepped by whole rows of 0.15 m from a fixed start therefore lands
       7.4 mm off a period later. */
    expect(period).toBeCloseTo(1058.257, 2);
    const rows = period / ROW;
    expect(Math.abs(rows - Math.round(rows)) * ROW, "how far a 0.15 m row is from its place a period on, metres").toBeGreaterThan(0.005);

    const from = distance[WINDOW_FROM]!;
    const windowAt = (start: number): Record<string, unknown> => ({
      method: "distance",
      distance: ROW,
      maxPoints: ROWS,
      rangeStart: start / total,
      // A quarter of a row past the last, so the last is inside the Range whichever way its end rounds.
      rangeEnd: Math.min(1, (start + (ROWS - 0.75) * ROW) / total),
    });
    const head = await windowOf(windowAt(from));
    const tail = await windowOf(windowAt(from + period));
    /* A row's place is a distance near 1,200 m: its Range's start, and the two lengths it is
       found between. A float holds 0.12 mm of each. */
    expect(apartByAPeriod(head.stations, tail.stations, ROWS), "rows, metres (measured 0.00023)").toBeLessThan(4 * resolves(1200));
    const frameRounding = (2 * resolves(1200)) / ROW;
    expect(apartByAPeriod(head.vertices, tail.vertices, SIDES * ROWS), "the wall, metres (measured 0.0009)").toBeLessThan(HALL_RADIUS * frameRounding + 4 * resolves(1200));
    // The control: a Range that starts 0.15 m on is a different set of rows, by a whole row.
    const shifted = await windowOf(windowAt(from + ROW));
    expect(size(minus(at(shifted.stations, 0), at(head.stations, 1)))).toBeLessThan(4 * resolves(128));
    expect(size(minus(at(shifted.stations, 0), at(head.stations, 0)))).toBeGreaterThan(0.1);
  }, 240_000);
});
