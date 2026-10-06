import { describe, expect, it } from "vitest";

import { endTangent, frameStrip, type Vec3 } from "../../points/curve.ts";
import {
  authoredPoints,
  curveEdge,
  curveGraph,
  curveNode,
  drawnTo,
  formulaPoints,
  mappedTo,
  onDawn,
  vecAt,
  type AuthoredAttribute,
  type CurveSession,
} from "./curve-test-support.ts";
import { curveFramesHandedAt } from "../shaders/curve-frames-blocked.wgsl.ts";
import { curveFramesAttributes } from "./point-curve-frames.ts";

/**
 * Curve Frames (T1586b slice 3) on a real device, asserted on READ-BACK ATTRIBUTES.
 *
 * ## Why most of this file says `toEqual` and not `toBeCloseTo` (§V147)
 *
 * The walk carries a frame as two vectors and re-squares them at every point, and it makes
 * every direction by dividing a segment by its own length. So on fixtures whose numbers are
 * exact in f32 — an axis-aligned line, a square in a plane — a straight continuation turns
 * nothing AT ALL and a planar curve keeps its normal TO THE BIT. Those cases are asserted
 * for equality. Where a result is irrational (a 45° bisector, a helix) the expectation is
 * the closed form, compared at single precision; there are no bands.
 *
 * ## Three kinds of evidence, on purpose
 *
 * 1. values a person derives by hand from the fixture (the line, the square, three unit
 *    steps along the axes);
 * 2. closed forms that are independent of the implementation (a helix's lag, the spherical
 *    area a closed curve's directions enclose);
 * 3. agreement with the CPU reference, `points/curve.ts`, on a curve with no symmetry —
 *    the reference is checked against hand values in its own test, so this ties the GPU to
 *    the same definition a CPU reader will evaluate.
 *
 * Nothing here hands the node a dimension: the points are authored by a kernel, a Topology
 * node claims the strips, and Curve Frames reads the claim off the edge.
 *
 * ## The ends (§T1587b C13)
 *
 * Extrapolate Ends is on, as it is on a node a person places, so every comparison with the
 * reference below holds the ends pass too. The by-hand fixtures that are paths of straight
 * legs with a corner next to an end turn it off, which is what the switch is for: there an
 * end's frame is its leg's. The last describe of the file is the ends' own.
 */

const ALL = { frame: true, vectors: true, metrics: true } as const;
const UP_Y: Vec3 = [0, 1, 0];
const H = Math.SQRT1_2;

interface Measured {
  /** The points that were measured, as the device holds them. */
  readonly position: Vec3[];
  readonly tangent: number[][];
  readonly normal: number[][];
  readonly binormal: number[][];
  readonly orient: number[][];
  readonly distance: number[];
  readonly curveU: number[];
  readonly curveLength: number[];
  readonly curvature: number[];
}

type Strips = { readonly cols: number; readonly rows: number; readonly closed?: boolean };
type Source = ReturnType<typeof authoredPoints>;

/** source → Topology (Strips) → Curve Frames, every output on. */
function framesGraph(source: Source, count: number, strips: Strips, parameters: Record<string, unknown>) {
  const sink = drawnTo("frames_spine", count);
  return curveGraph(
    [
      source.node,
      curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: strips.cols, rows: strips.rows, wrapU: strips.closed === true }),
      curveNode("frames_spine", "pointCurveFrames", { vectors: true, ...parameters }),
      ...sink.nodes,
    ],
    [curveEdge(["kernel_source", "out"], ["topology_strips", "points"]), curveEdge(["topology_strips", "out"], ["frames_spine", "points"]), ...sink.edges],
  );
}

/** Everything Curve Frames wrote, and the points it measured, off a rendered session. */
async function readMeasured(session: CurveSession, source: Source, count: number): Promise<Measured> {
  const schema = curveFramesAttributes(ALL);
  const read = async (name: string) => (await session.read("frames_spine", schema, count, name)).floats;
  const vectors = async (name: string, size: 3 | 4 = 3) => {
    const floats = await read(name);
    return Array.from({ length: count }, (_, index) => vecAt(floats, index, size));
  };
  const positions = (await session.read("kernel_source", source.schema, count, "position")).floats;
  return {
    position: Array.from({ length: count }, (_, index) => vecAt(positions, index) as unknown as Vec3),
    tangent: await vectors("tangent"),
    normal: await vectors("normal"),
    binormal: await vectors("binormal"),
    orient: await vectors("orient", 4),
    distance: Array.from(await read("distance")),
    curveU: Array.from(await read("curveU")),
    curveLength: Array.from(await read("curveLength")),
    curvature: Array.from(await read("curvature")),
  };
}

/** One frame on Dawn of `source` measured as `strips`. */
const measureFrom = (source: Source, count: number, strips: Strips, parameters: Record<string, unknown> = {}): Promise<Measured> =>
  onDawn(framesGraph(source, count, strips, parameters), (session) => readMeasured(session, source, count));

/** authored points → Topology (Strips) → Curve Frames, every output on; one frame on Dawn. */
const measure = (
  positions: ReadonlyArray<Vec3>,
  strips: Strips,
  parameters: Record<string, unknown> = {},
  extras: ReadonlyArray<AuthoredAttribute> = [],
): Promise<Measured> => measureFrom(authoredPoints("kernel_source", positions, extras), positions.length, strips, parameters);

const close = (actual: readonly number[], expected: readonly number[], what: string, digits = 5): void => {
  expected.forEach((value, at) => expect(actual[at], `${what}, component ${at} of [${actual.join(", ")}]`).toBeCloseTo(value, digits));
};
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const cross = (a: readonly number[], b: readonly number[]): number[] => [
  a[1]! * b[2]! - a[2]! * b[1]!,
  a[2]! * b[0]! - a[0]! * b[2]!,
  a[0]! * b[1]! - a[1]! * b[0]!,
];
/** The signed angle from `from` to `to` about `axis`, all unit and both square to it. */
const angleAbout = (from: readonly number[], to: readonly number[], axis: readonly number[]): number =>
  Math.atan2(dot(cross(from, to), axis), dot(from, to));
const wrapped = (angle: number): number => angle - Math.round(angle / (2 * Math.PI)) * 2 * Math.PI;

describe("Curve Frames on Dawn — metrics and the frame convention (T1586b)", () => {
  /**
   * A straight line along +X in half-unit steps, Up +Y. Every number is exact in f32: the
   * segment (0.5, 0, 0) has length 0.5 and direction (1, 0, 0), a straight continuation is
   * the identity rotation, and the length 2 is a power of two, so distance ÷ length is
   * exact as well.
   */
  it("a straight line: tangent X, normal Y, binormal Z, distance k × 0.5 — exactly", async () => {
    const line: Vec3[] = [[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1.5, 0, 0], [2, 0, 0]];
    const m = await measure(line, { cols: 5, rows: 1 });
    for (let i = 0; i < 5; i += 1) {
      expect(m.tangent[i], `tangent ${i}`).toEqual([1, 0, 0]);
      expect(m.normal[i], `normal ${i}`).toEqual([0, 1, 0]);
      expect(m.binormal[i], `binormal ${i}`).toEqual([0, 0, 1]);
      expect(m.distance[i]).toBe(i * 0.5);
      expect(m.curveU[i]).toBe(i / 4);
      expect(m.curveLength[i]).toBe(2);
      expect(m.curvature[i]).toBe(0);
      // +Z onto +X and +Y kept: a quarter turn about +Y. (0, sin 45°, 0, cos 45°).
      close(m.orient[i]!, [0, H, 0, H], `orient ${i}`, 6);
    }
  }, 60_000);

  /**
   * Three unit steps along +X, +Y, +Z, seeded with the normal on +Y. The turn from X to Y
   * is a quarter turn about Z and carries the normal from +Y to −X; the turn from Y to Z is
   * a quarter turn about X and leaves −X alone. Each corner's own frame is half way through
   * its turn, so its tangent is the bisector of its two sides. Straight legs: an end's frame
   * is its leg's, so Extrapolate Ends is off.
   */
  it("three unit steps along X, Y, Z: two quarter turns, by hand", async () => {
    const m = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], { cols: 4, rows: 1 }, { extrapolateEnds: false });
    expect(m.tangent[0]).toEqual([1, 0, 0]);
    expect(m.normal[0]).toEqual([0, 1, 0]);
    close(m.tangent[1]!, [H, H, 0], "corner 1 tangent");
    close(m.normal[1]!, [-H, H, 0], "corner 1 normal");
    close(m.tangent[2]!, [0, H, H], "corner 2 tangent");
    close(m.normal[2]!, [-1, 0, 0], "corner 2 normal");
    close(m.tangent[3]!, [0, 0, 1], "end tangent");
    close(m.normal[3]!, [-1, 0, 0], "end normal");
    close(m.binormal[3]!, [0, -1, 0], "end binormal");
    expect(m.distance).toEqual([0, 1, 2, 3]);
    // The circle through three corners of a unit square has radius √½; the ends have no circle.
    expect(m.curvature[1]).toBeCloseTo(Math.SQRT2, 5);
    expect(m.curvature[2]).toBeCloseTo(Math.SQRT2, 5);
    expect(m.curvature[0]).toBe(0);
    expect(m.curvature[3]).toBe(0);
  }, 60_000);

  /**
   * §V683's shape: the convention is pinned to what the quaternion DOES, not to its four
   * numbers. Rotating the shape's axes by the published `orient` must land +Z on the
   * published tangent and +Y on the published normal — the instancer's Forward and Up
   * (§T1581b) — and +X on the far side of the binormal.
   */
  it("orient carries +Z onto the tangent and +Y onto the normal, at every point of a bent strip", async () => {
    const m = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1], [0, 1, 2], [-1, 3, 2]], { cols: 6, rows: 1 });
    const rotate = (q: readonly number[], v: readonly number[]): number[] => {
      const axis = [q[0]!, q[1]!, q[2]!];
      const inner = cross(axis, v).map((value, at) => value + q[3]! * v[at]!);
      return cross(axis, inner).map((value, at) => v[at]! + 2 * value);
    };
    for (let i = 0; i < 6; i += 1) {
      close(rotate(m.orient[i]!, [0, 0, 1]), m.tangent[i]!, `point ${i}: +Z onto the tangent`);
      close(rotate(m.orient[i]!, [0, 1, 0]), m.normal[i]!, `point ${i}: +Y onto the normal`);
      close(rotate(m.orient[i]!, [1, 0, 0]), m.binormal[i]!.map((value) => -value), `point ${i}: +X onto −binormal`);
      close(m.binormal[i]!, cross(m.tangent[i]!, m.normal[i]!), `point ${i}: binormal = tangent × normal`);
    }
  }, 60_000);
});

describe("Curve Frames on Dawn — the frame is carried along the polyline (T1586b D9)", () => {
  const SQUARE: Vec3[] = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]];

  /**
   * A planar curve never twists. Every rotation the walk applies here has its axis on the
   * plane's own normal, and rotating a vector about itself is a no-op to the bit — so the
   * normal is (0, 0, 1) EXACTLY at every corner, the lap closes with nothing to spread,
   * and Close Twist on and off are the same bytes.
   */
  it("a closed square in a plane keeps its normal exactly, and has nothing to close", async () => {
    const on = await measure(SQUARE, { cols: 4, rows: 1, closed: true }, { up: [0, 0, 1] });
    const off = await measure(SQUARE, { cols: 4, rows: 1, closed: true }, { up: [0, 0, 1], closeTwist: false });
    for (let i = 0; i < 4; i += 1) {
      expect(on.normal[i], `normal ${i}`).toEqual([0, 0, 1]);
      // Every corner of a square inscribed in the unit circle lies on that circle.
      expect(on.curvature[i]).toBeCloseTo(1, 5);
      expect(on.curveLength[i]).toBeCloseTo(4 * Math.SQRT2, 5);
    }
    expect(off.normal).toEqual(on.normal);
    expect(off.orient).toEqual(on.orient);
    // A corner's tangent is the bisector of its two sides: at (1, 0, 0) that is +Y.
    close(on.tangent[0]!, [0, 1, 0], "corner 0 tangent");
    close(on.tangent[1]!, [-1, 0, 0], "corner 1 tangent");
    // The closing side counts: the last corner is three sides in, of four.
    expect(on.curveU[3]).toBeCloseTo(0.75, 5);
  }, 60_000);

  it("the same square with Up in its plane: the normal stays in the plane, square to the tangent", async () => {
    const m = await measure(SQUARE, { cols: 4, rows: 1, closed: true }, { up: [1, 0, 0] });
    for (let i = 0; i < 4; i += 1) {
      expect(m.normal[i]![2], `normal ${i} leaves the plane`).toBe(0);
      expect(dot(m.normal[i]!, m.tangent[i]!)).toBeCloseTo(0, 6);
      expect(Math.hypot(...m.normal[i]!)).toBeCloseTo(1, 6);
    }
  }, 60_000);

  /**
   * THE CLOSED FORM. A helix sampled every `h` radians has segments that are one another's
   * image under a turn of `h` about the axis. That turn is the smallest rotation between
   * two consecutive segments followed by a twist of α = 2·atan(cos β · tan(h/2)) about the
   * second, β being the angle between a segment and the axis. A carried frame takes the
   * smallest rotation only, so against the helix's own inward normal it falls behind by
   * exactly α at every point. Nothing in this expectation comes from the implementation.
   */
  it("a helix: the carried normal falls behind the inward normal by 2·atan(cos β · tan(h/2)) per point", async () => {
    const h = 0.3;
    const pitch = 0.4;
    const count = 24;
    const helix: Vec3[] = Array.from({ length: count }, (_, i) => [Math.cos(i * h), Math.sin(i * h), pitch * i * h] as Vec3);
    const m = await measure(helix, { cols: count, rows: 1 }, { up: [0, 0, 1] });
    const chord = Math.hypot(2 * Math.sin(h / 2), pitch * h);
    const alpha = 2 * Math.atan(((pitch * h) / chord) * Math.tan(h / 2));
    const lag = (i: number): number => angleAbout([-Math.cos(i * h), -Math.sin(i * h), 0], m.normal[i]!, m.tangent[i]!);
    for (let i = 1; i < count - 2; i += 1) {
      expect(wrapped(lag(i + 1) - lag(i)), `point ${i}`).toBeCloseTo(-alpha, 4);
    }
    // And the helix's own numbers: every interior point turns alike, on a curve of fixed curvature.
    for (let i = 2; i < count - 1; i += 1) expect(m.curvature[i]).toBeCloseTo(m.curvature[1]!, 4);
    expect(m.distance[count - 1]).toBeCloseTo((count - 1) * chord, 4);
  }, 60_000);

  /**
   * A closed curve that leaves its plane comes back turned by the area its segment
   * directions enclose on the unit sphere. For +X, +Y, +Z and −(1, 1, 1)/√3 that is an
   * octant plus a triangle of 7π/6: 5π/3 in all, which is −π/3 as an angle. With Close
   * Twist OFF the raw frames show it; ON, each point is turned back by that angle times
   * its share of the length — so the difference between the two runs, point by point, is
   * the closing angle times curveU, and at the seam the frame meets itself.
   */
  it("a closed, non-planar polygon comes back turned by −π/3, and Close Twist spreads it by distance", async () => {
    const corners: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [2, 2, 2]];
    const raw = await measure(corners, { cols: 4, rows: 1, closed: true }, { closeTwist: false });
    const closed = await measure(corners, { cols: 4, rows: 1, closed: true });
    const closing = -Math.PI / 3;
    for (let i = 0; i < 4; i += 1) {
      const turned = angleAbout(raw.normal[i]!, closed.normal[i]!, raw.tangent[i]!);
      expect(wrapped(turned + closing * raw.curveU[i]!), `corner ${i}`).toBeCloseTo(0, 4);
    }
    // The first corner is at distance 0: nothing is taken off it, in either run.
    expect(closed.normal[0]).toEqual(raw.normal[0]);
    // Three sides of 2 and a diagonal of 2√3.
    expect(raw.curveLength[0]).toBeCloseTo(6 + 2 * Math.sqrt(3), 4);
  }, 60_000);

  /** The reference is this node's definition on the CPU; a curve with no symmetry must agree with it everywhere. */
  it("agrees with the CPU reference on two unlike strips, attribute by attribute", async () => {
    const stripA: Vec3[] = [[0, 0, 0], [1, 0.25, 0], [1.5, 1, 0.5], [1, 2, 1.5], [0, 2.5, 1], [-1, 2, 0]];
    const stripB: Vec3[] = [[4, 0, 0], [4, 1, 0], [5, 1, 1], [5, 3, 1], [3, 3, 2], [3, 0, -1]];
    const m = await measure([...stripA, ...stripB], { cols: 6, rows: 2 }, { roll: 20, twist: 75 });
    const options = { closed: false, method: "minimiseTwist", up: UP_Y, roll: (20 * Math.PI) / 180, twist: (75 * Math.PI) / 180, extrapolateEnds: true } as const;
    [frameStrip(stripA, options), frameStrip(stripB, options)].forEach((expected, strip) => {
      for (let i = 0; i < 6; i += 1) {
        const slot = strip * 6 + i;
        close(m.tangent[slot]!, expected.tangent[i]!, `strip ${strip} tangent ${i}`);
        close(m.normal[slot]!, expected.normal[i]!, `strip ${strip} normal ${i}`);
        close(m.binormal[slot]!, expected.binormal[i]!, `strip ${strip} binormal ${i}`);
        close(m.orient[slot]!, expected.orient[i]!, `strip ${strip} orient ${i}`);
        expect(m.distance[slot]).toBeCloseTo(expected.distance[i]!, 5);
        expect(m.curveU[slot]).toBeCloseTo(expected.curveU[i]!, 5);
        expect(m.curveLength[slot]).toBeCloseTo(expected.curveLength, 5);
        expect(m.curvature[slot]).toBeCloseTo(expected.curvature[i]!, 4);
      }
    });
  }, 60_000);
});

describe("Curve Frames on Dawn — seeds, roll and twist (T1586b)", () => {
  const TWO_LINES: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [0, 5, 0], [1, 5, 0], [2, 5, 0]];
  const S = Math.fround(Math.SQRT1_2);

  /**
   * (½, ½, ½, ½) is a third of a turn about (1, 1, 1): it carries +Z onto +X and +Y onto
   * +Z. Its +Z already runs along the strip, so the seeded frame IS that quaternion and
   * comes back to the bit, with the normal on +Z. The second strip carries a different
   * seed (a quarter turn about +Y: normal +Y) and must not see the first one's.
   */
  it("Seed: Orient Attribute reproduces the attribute's frame at each strip's first point", async () => {
    const seeds: AuthoredAttribute = {
      name: "orient",
      type: "vec4f",
      values: [[0.5, 0.5, 0.5, 0.5], [0, 0, 0, 1], [0, 0, 0, 1], [0, S, 0, S], [0, 0, 0, 1], [0, 0, 0, 1]],
    };
    const seeded = await measure(TWO_LINES, { cols: 3, rows: 2 }, { seed: "orient" }, [seeds]);
    for (const slot of [0, 1, 2]) {
      expect(seeded.normal[slot], `strip 0 normal ${slot}`).toEqual([0, 0, 1]);
      expect(seeded.orient[slot], `strip 0 orient ${slot}`).toEqual([0.5, 0.5, 0.5, 0.5]);
    }
    for (const slot of [3, 4, 5]) expect(seeded.normal[slot], `strip 1 normal ${slot}`).toEqual([0, 1, 0]);

    // THE WIRE CUT: the same attribute on the edge, the seed switched back to Up, and both
    // strips lean to +Y — so the +Z above came from the attribute and from nowhere else.
    const unseeded = await measure(TWO_LINES, { cols: 3, rows: 2 }, { seed: "up" }, [seeds]);
    for (const slot of [0, 1, 2, 3, 4, 5]) expect(unseeded.normal[slot], `unseeded normal ${slot}`).toEqual([0, 1, 0]);
  }, 60_000);

  it("Up in Map mode seeds each strip from its own first point; cut the map and both lean alike", async () => {
    const lean: AuthoredAttribute = {
      name: "lean",
      type: "vec3f",
      values: [[0, 0, 1], [0, 1, 0], [0, 1, 0], [0, 0, -1], [0, 1, 0], [0, 1, 0]],
    };
    const mapped = await measure(TWO_LINES, { cols: 3, rows: 2 }, { up: mappedTo("lean", [0, 1, 0]) }, [lean]);
    // Carried from the first point: the later points' own `lean` is not read.
    for (const slot of [0, 1, 2]) expect(mapped.normal[slot]).toEqual([0, 0, 1]);
    for (const slot of [3, 4, 5]) expect(mapped.normal[slot]).toEqual([0, 0, -1]);
    const cut = await measure(TWO_LINES, { cols: 3, rows: 2 }, {}, [lean]);
    for (const slot of [0, 1, 2, 3, 4, 5]) expect(cut.normal[slot]).toEqual([0, 1, 0]);
  }, 60_000);

  /**
   * A right-handed turn about the tangent swings the normal toward the binormal. On the
   * +X line with Up +Y the binormal is +Z, so Roll 90 puts the normal there; and a Twist
   * of 360 over the strip is a quarter turn at each quarter of its length.
   */
  it("Roll 90 puts the normal where the binormal was; Twist 360 brings the last normal back", async () => {
    const line: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]];
    const rolled = await measure(line, { cols: 5, rows: 1 }, { roll: 90 });
    for (let i = 0; i < 5; i += 1) close(rolled.normal[i]!, [0, 0, 1], `rolled normal ${i}`, 6);
    const twisted = await measure(line, { cols: 5, rows: 1 }, { twist: 360 });
    expect(twisted.normal[0]).toEqual([0, 1, 0]);
    close(twisted.normal[1]!, [0, 0, 1], "a quarter of the way", 6);
    close(twisted.normal[2]!, [0, -1, 0], "half way", 6);
    close(twisted.normal[3]!, [0, 0, -1], "three quarters", 6);
    close(twisted.normal[4]!, [0, 1, 0], "the end", 6);
  }, 60_000);

  it("Roll in Map mode ADDS a per-point bank in degrees; cut the map and only the value is left", async () => {
    const line: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0]];
    const bank: AuthoredAttribute = { name: "bank", type: "f32", values: [0, 90, 180] };
    const mapped = await measure(line, { cols: 3, rows: 1 }, { roll: mappedTo("bank", 90) }, [bank]);
    // 90 + 0, 90 + 90, 90 + 180 degrees from +Y toward +Z.
    close(mapped.normal[0]!, [0, 0, 1], "90 degrees", 6);
    close(mapped.normal[1]!, [0, -1, 0], "180 degrees", 6);
    close(mapped.normal[2]!, [0, 0, -1], "270 degrees", 6);
    const cut = await measure(line, { cols: 3, rows: 1 }, { roll: 90 }, [bank]);
    for (let i = 0; i < 3; i += 1) close(cut.normal[i]!, [0, 0, 1], `unmapped normal ${i}`, 6);
  }, 60_000);
});

describe("Curve Frames on Dawn — padding and Fixed Up (T1586b R4)", () => {
  /**
   * §V788: a strip shorter than its slots repeats its nearest live point. A segment of no
   * length adds no distance and turns no frame, so the repeats read back the frame and the
   * distance of the point they repeat — at the tail and at the HEAD, where a tentacle stows
   * its slack — and the strip's length is the bare strip's. The node never reads `live`.
   */
  it("padding takes its neighbour's frame and distance, and adds no length", async () => {
    const bare = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0]], { cols: 3, rows: 1 });
    const padded = await measure(
      [[0, 0, 0], [0, 0, 0], [0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]],
      { cols: 8, rows: 1 },
    );
    for (const head of [0, 1, 2]) {
      expect(padded.tangent[head]).toEqual(bare.tangent[0]);
      expect(padded.normal[head]).toEqual(bare.normal[0]);
      expect(padded.orient[head]).toEqual(bare.orient[0]);
      expect(padded.distance[head]).toBe(0);
    }
    expect(padded.tangent[3]).toEqual(bare.tangent[1]);
    expect(padded.normal[3]).toEqual(bare.normal[1]);
    for (const tail of [4, 5, 6, 7]) {
      expect(padded.tangent[tail]).toEqual(bare.tangent[2]);
      expect(padded.normal[tail]).toEqual(bare.normal[2]);
      expect(padded.orient[tail]).toEqual(bare.orient[2]);
      expect(padded.distance[tail]).toBe(2);
      expect(padded.curveU[tail]).toBe(1);
    }
    for (let i = 0; i < 8; i += 1) expect(padded.curveLength[i]).toBe(bare.curveLength[0]);
  }, 60_000);

  it("a strip of no length takes the seed's frame and zero metrics, with no NaN", async () => {
    const m = await measure([[3, 3, 3], [3, 3, 3], [3, 3, 3]], { cols: 3, rows: 1 });
    for (let i = 0; i < 3; i += 1) {
      expect(m.orient[i]).toEqual([0, 0, 0, 1]);
      expect(m.distance[i]).toBe(0);
      expect(m.curveU[i]).toBe(0);
      expect(m.curveLength[i]).toBe(0);
    }
  }, 60_000);

  /**
   * Fixed Up leans every normal toward Up with no carrying. Between two vertical segments
   * the tangent IS up, so there is no "up made square to the tangent": the point keeps the
   * normal of the point before it, squared to its own tangent. Past the vertical run the
   * normal is back on +Y — a carried frame would still be leaning. Straight legs again, so
   * the ends are their legs'.
   */
  it("Fixed Up through vertical keeps the previous normal, recovers after, and is finite everywhere", async () => {
    const m = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 2, 0], [2, 2, 0]], { cols: 5, rows: 1 }, { method: "fixedUp", extrapolateEnds: false });
    expect(m.normal[0]).toEqual([0, 1, 0]);
    close(m.normal[1]!, [-H, H, 0], "the corner before the vertical run");
    close(m.tangent[2]!, [0, 1, 0], "the vertical point's tangent", 6);
    close(m.normal[2]!, [-1, 0, 0], "the vertical point keeps the corner's normal", 6);
    expect(m.normal[4]).toEqual([0, 1, 0]);
    for (const q of m.orient) for (const component of q) expect(Number.isFinite(component)).toBe(true);
  }, 60_000);
});

describe("Curve Frames on Dawn — orient reaches an instanced draw (T1586b 5.1)", () => {
  /**
   * §V683: pinned to a fact about the world. A quad lies in the XY plane, facing +Z. The
   * camera sits on +X, looking down the line the quads are strung along — so an unturned
   * quad is seen exactly EDGE-ON and covers nothing. `orient` carries +Z onto the tangent,
   * which runs along +X: turned by it, every quad faces the camera and covers pixels.
   * Cut the Orient map and the frame goes dark again, so the turn came through the wire.
   */
  const instancedAlong = (orient: boolean) => {
    const source = authoredPoints("kernel_source", [[-1, 0, 0], [0, 0, 0], [1, 0, 0]]);
    return curveGraph(
      [
        source.node,
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 3, rows: 1 }),
        curveNode("frames_spine", "pointCurveFrames"),
        curveNode("material_white", "materialUnlit", { color: [1, 1, 1, 1] }),
        curveNode("geometry_rings", "geometry", {
          mode: "instances",
          shape: "quad",
          scale: 0.4,
          material: "material_white",
          ...(orient ? { orient: mappedTo("orient", [0, 0, 0, 1]) } : {}),
        }),
        curveNode("camera_main", "camera", { eye: [6, 0, 0], lookAt: [0, 0, 0], fov: 40, near: 0.1, far: 20 }),
        curveNode("render_shot", "render", { scenes: "geometry_rings", camera: "camera_main", lights: "", ambientIntensity: 1, background: [0, 0, 0, 1] }),
        curveNode("output_probe", "output"),
      ],
      [
        curveEdge(["kernel_source", "out"], ["topology_strips", "points"]),
        curveEdge(["topology_strips", "out"], ["frames_spine", "points"]),
        curveEdge(["frames_spine", "out"], ["geometry_rings", "points"]),
        curveEdge(["render_shot", "out"], ["output_probe", "input"]),
      ],
    );
  };
  const litPixels = async (orient: boolean): Promise<number> =>
    onDawn(
      instancedAlong(orient),
      async (session) => {
        const image = await session.readOutput();
        let lit = 0;
        for (let y = 0; y < image.height; y += 1) {
          for (let x = 0; x < image.width; x += 1) if ((image.bytes[y * image.rowStride + x * 4] as number) > 128) lit += 1;
        }
        return lit;
      },
      64,
    );

  it("quads strung along +X face down the line when Orient is mapped, and are edge-on when it is cut", async () => {
    const turned = await litPixels(true);
    const unturned = await litPixels(false);
    expect(unturned, "an unturned quad is edge-on to a camera on +X").toBe(0);
    // A 0.4 quad at 5 to 7 units through a 40° lens on 64 pixels is some 6 pixels across.
    expect(turned).toBeGreaterThan(20);
  }, 60_000);
});

/**
 * T1586b slice 6 — STRIPS LONGER THAN ONE BLOCK.
 *
 * A strip of more than 1,024 points is cut into blocks and walked by many invocations at
 * once (`nodes/shaders/curve-frames-blocked.wgsl.ts`). Every test here crosses a seam, and
 * the evidence is of the same three kinds as above:
 *
 *  1. EXACT values on fixtures whose numbers are exact in f32, seams included — a straight
 *     line, a polygon in a plane. A block's start is added to a distance and a block's turn
 *     is applied to a normal; on these fixtures neither rounds, so a wrong start or a wrong
 *     turn has nowhere to hide;
 *  2. CLOSED FORMS that owe nothing to the implementation — a helix's lag per point, the
 *     turn a closed curve comes back with — on curves that wind for thousands of points;
 *  3. the CPU reference in its blocked order, on curves with no symmetry, with padding laid
 *     across the seams. The points are placed on the device by a formula (too many to
 *     author one by one), so they are read BACK and the reference is run on those.
 *
 * And one that only a long strip can have: the points of its first block read back the
 * BYTES they read when those points are a short strip of their own, because a block is
 * walked from the state the whole walk would have arrived with.
 *
 * Reference comparisons here are at four digits where the short strips' are at five: a
 * frame at point 3,000 is the product of three thousand single-precision turns.
 */
describe("Curve Frames on Dawn — strips longer than one block (T1586b slice 6)", () => {
  const METHODS = ["minimiseTwist", "fixedUp"] as const;
  type Expected = ReturnType<typeof frameStrip>;

  /** One strip of the device's frames against the reference's, attribute by attribute. */
  const agree = (m: Measured, expected: Expected, first: number, what: string, digits = 4): void => {
    expected.tangent.forEach((_, i) => {
      const slot = first + i;
      const at = `${what}, point ${i}`;
      close(m.tangent[slot]!, expected.tangent[i]!, `${at} tangent`, digits);
      close(m.normal[slot]!, expected.normal[i]!, `${at} normal`, digits);
      close(m.binormal[slot]!, expected.binormal[i]!, `${at} binormal`, digits);
      // One rotation has two quaternions; either is the frame.
      expect(Math.abs(m.orient[slot]!.reduce((sum, value, axis) => sum + value * expected.orient[i]![axis]!, 0)), `${at} orient`).toBeCloseTo(1, digits);
      expect(m.distance[slot]! / Math.max(expected.distance[i]!, 1), `${at} distance`).toBeCloseTo(expected.distance[i]! / Math.max(expected.distance[i]!, 1), digits);
      expect(m.curveU[slot], `${at} curveU`).toBeCloseTo(expected.curveU[i]!, digits);
      expect(m.curvature[slot], `${at} curvature`).toBeCloseTo(expected.curvature[i]!, digits - 1);
    });
    expect(m.curveLength[first]! / expected.curveLength, `${what} length`).toBeCloseTo(1, digits);
  };

  /**
   * Half-unit steps along +X for 2,500 points: three blocks, the last one short. Every
   * distance is a multiple of a half below 2²⁴, so a block's sum, a block's start and
   * their sum are all exact — and so is a frame that never turns.
   */
  it("a straight line of 2,500 points: distance k × 0.5 and an unturned frame, exactly, across both seams", async () => {
    const line = formulaPoints("kernel_source", 2500, "  q.position = vec3f(f32(i) * 0.5, 0.0, 0.0);");
    for (const method of METHODS) {
      const m = await measureFrom(line, 2500, { cols: 2500, rows: 1 }, { method });
      expect(m.distance, method).toEqual(Array.from({ length: 2500 }, (_, k) => k * 0.5));
      expect(m.tangent, method).toEqual(Array.from({ length: 2500 }, () => [1, 0, 0]));
      expect(m.normal, method).toEqual(Array.from({ length: 2500 }, () => [0, 1, 0]));
      expect(m.binormal, method).toEqual(Array.from({ length: 2500 }, () => [0, 0, 1]));
      expect(m.curvature, method).toEqual(Array.from({ length: 2500 }, () => 0));
      expect(m.curveLength, method).toEqual(Array.from({ length: 2500 }, () => 1249.5));
      expect(m.curveU[0]).toBe(0);
      expect(m.curveU[2499]).toBe(1);
      expect(m.curveU[1024]).toBeCloseTo(512 / 1249.5, 6);
    }
  }, 120_000);

  /**
   * Sixteen blocks, and a strip a Topology node could not claim before this slice: its
   * Columns stopped at 4,096, and the compiler refused a larger number by name — so a
   * kernel's strip of 16,384 points could not become a curve at all. The limit on a claim
   * is the points the edge carries, which the node already checks.
   */
  it("a kernel's strip of 16,384 points is claimed whole and measured to its last point", async () => {
    const line = formulaPoints("kernel_source", 16_384, "  q.position = vec3f(f32(i) * 0.5, 0.0, 0.0);");
    const m = await measureFrom(line, 16_384, { cols: 16_384, rows: 1 });
    expect(m.distance).toEqual(Array.from({ length: 16_384 }, (_, k) => k * 0.5));
    expect(m.curveLength[16_383]).toBe(8191.5);
    expect(m.tangent[16_383]).toEqual([1, 0, 0]);
    expect(m.normal[16_383]).toEqual([0, 1, 0]);
    expect(m.curveU[16_383]).toBe(1);
  }, 120_000);

  /**
   * A regular twelve-gon of radius 2, traced two hundred times: 2,400 points, closed. It is
   * the planar case above with seams in it — every rotation's axis is the plane's own
   * normal, so the normal is (0, 0, 1) to the bit at every point of every block, the lap
   * closes with nothing to spread, and every corner sits on a circle of radius 2.
   */
  it("a twelve-gon traced 200 times, closed: the normal exact at all 2,400 points, the curvature one half", async () => {
    const polygon = formulaPoints(
      "kernel_source",
      2400,
      "  let a = f32(i % 12u) * 0.5235987755982988;\n  q.position = vec3f(2.0 * cos(a), 2.0 * sin(a), 0.0);",
    );
    const on = await measureFrom(polygon, 2400, { cols: 2400, rows: 1, closed: true }, { up: [0, 0, 1] });
    const off = await measureFrom(polygon, 2400, { cols: 2400, rows: 1, closed: true }, { up: [0, 0, 1], closeTwist: false });
    expect(on.normal).toEqual(Array.from({ length: 2400 }, () => [0, 0, 1]));
    expect(off.orient).toEqual(on.orient);
    const side = 4 * Math.sin(Math.PI / 12);
    for (const k of [0, 1, 500, 1023, 1024, 1025, 2047, 2048, 2399]) {
      const a = ((k % 12) * Math.PI) / 6;
      // A corner's tangent is the bisector of its two sides: square to its radius.
      close(on.tangent[k]!, [-Math.sin(a), Math.cos(a), 0], `corner ${k} tangent`, 5);
      expect(on.curvature[k], `corner ${k} curvature`).toBeCloseTo(0.5, 5);
      expect(on.distance[k]! / Math.max(k * side, 1), `corner ${k} distance`).toBeCloseTo(k === 0 ? 0 : 1, 5);
      expect(on.curveU[k], `corner ${k} curveU`).toBeCloseTo(k / 2400, 5);
    }
    expect(on.curveLength[0]! / (2400 * side)).toBeCloseTo(1, 5);
  }, 120_000);

  /**
   * The closed, non-planar polygon of the short test, traced 301 times: 1,204 points. One
   * lap turns the carried frame by −π/3 (the area its directions enclose on the sphere), so
   * 301 laps turn it by −301π/3, which is −π/3 again. The lap is now a fold over two
   * blocks' summaries, and the angle it finds must still be that one: Close Twist on and
   * off differ, point by point, by −π/3 times the point's share of the length.
   */
  it("a closed space polygon traced 301 times still comes back turned by −π/3", async () => {
    const corners = formulaPoints(
      "kernel_source",
      1204,
      "  let c = i % 4u;\n  q.position = vec3f(select(2.0, 0.0, c == 0u), select(2.0, 0.0, c < 2u), select(0.0, 2.0, c == 3u));",
    );
    const raw = await measureFrom(corners, 1204, { cols: 1204, rows: 1, closed: true }, { closeTwist: false });
    const closed = await measureFrom(corners, 1204, { cols: 1204, rows: 1, closed: true });
    expect(raw.position.slice(0, 4)).toEqual([[0, 0, 0], [2, 0, 0], [2, 2, 0], [2, 2, 2]]);
    const closing = -Math.PI / 3;
    for (let i = 0; i < 1204; i += 1) {
      const turned = angleAbout(raw.normal[i]!, closed.normal[i]!, raw.tangent[i]!);
      expect(wrapped(turned + closing * raw.curveU[i]!), `point ${i}`).toBeCloseTo(0, 3);
    }
    expect(closed.normal[0]).toEqual(raw.normal[0]);
    // And lap by lap the raw frame really does turn: a lap on, the same corner leans −π/3 further.
    for (const i of [1, 501, 1021, 1101]) {
      expect(wrapped(angleAbout(raw.normal[i]!, raw.normal[i + 4]!, raw.tangent[i]!) - closing), `corner ${i} a lap on`).toBeCloseTo(0, 3);
    }
  }, 120_000);

  /**
   * THE CLOSED FORM, across seams. The helix of the short test, 3,000 points long: at every
   * point — the ones either side of 1,024 and 2,048 like any other — the carried normal
   * falls behind the helix's own inward normal by the same 2·atan(cos β · tan(h/2)).
   */
  it("a helix of 3,000 points: the same lag per point on both sides of every seam", async () => {
    const h = 0.3;
    const pitch = 0.05;
    const count = 3000;
    const helix = formulaPoints(
      "kernel_source",
      count,
      `  let a = f32(i) * ${h};\n  q.position = vec3f(cos(a), sin(a), ${pitch} * (a - ${(count * h) / 2}));`,
    );
    const m = await measureFrom(helix, count, { cols: count, rows: 1 }, { up: [0, 0, 1] });
    const chord = Math.hypot(2 * Math.sin(h / 2), pitch * h);
    const alpha = 2 * Math.atan(((pitch * h) / chord) * Math.tan(h / 2));
    const lag = (i: number): number => angleAbout([-Math.cos(i * h), -Math.sin(i * h), 0], m.normal[i]!, m.tangent[i]!);
    for (let i = 1; i < count - 2; i += 1) {
      expect(wrapped(lag(i + 1) - lag(i)), `point ${i}`).toBeCloseTo(-alpha, 3);
    }
    for (const i of [2, 1023, 1024, 2047, 2048, 2998]) expect(m.curvature[i], `curvature ${i}`).toBeCloseTo(m.curvature[1]!, 3);
    expect(m.distance[count - 1]! / ((count - 1) * chord)).toBeCloseTo(1, 5);
  }, 120_000);

  /**
   * A curve with no symmetry, 3,500 points a strip, with padding where the seams are: a run
   * of coincident points across the seam at 1,024, a run that fills the whole third block
   * and spills over both its edges, and a padded tail. Two strips, so a block's record is
   * found by strip as well as by block.
   */
  const WANDER = `  let j = i / 3500u;
  var s = i % 3500u;
  if (s >= 1020u) { s = 1020u; }
  if (i % 3500u >= 1030u) { s = i % 3500u - 10u; }
  if (i % 3500u >= 2040u) { s = 2030u; }
  if (i % 3500u >= 3080u) { s = i % 3500u - 1050u; }
  if (i % 3500u >= 3300u) { s = 2250u; }
  let t = f32(s) * 0.013 + f32(j) * 1.7;
  q.position = vec3f(cos(t) * (1.0 + 0.3 * sin(t * 2.7)), sin(t * 1.3) * 0.8 + 0.2 * cos(t * 3.1), sin(t * 0.7) + f32(s) * 0.001);`;

  it("agrees with the blocked reference on two unlike strips with padding across the seams, open and closed", async () => {
    const wander = formulaPoints("kernel_source", 7000, WANDER);
    for (const closed of [false, true]) {
      const m = await measureFrom(wander, 7000, { cols: 3500, rows: 2, closed }, { roll: 20, twist: 75, up: [0.2, 1, -0.3] });
      for (const strip of [0, 1]) {
        const points = m.position.slice(strip * 3500, (strip + 1) * 3500);
        const expected = frameStrip(points, { closed, method: "minimiseTwist", up: [0.2, 1, -0.3], roll: (20 * Math.PI) / 180, twist: (75 * Math.PI) / 180, extrapolateEnds: true });
        agree(m, expected, strip * 3500, `${closed ? "closed" : "open"} strip ${strip}`);
      }
      // The points of one run share ONE frame and one distance, to the bit, across the seam
      // at 1,024 and through the whole padded block.
      for (const [from, to] of [[1020, 1029], [2040, 3079], [3300, 3499]] as const) {
        for (let i = from; i < to; i += 1) {
          expect(m.orient[i + 1], `orient ${i + 1}`).toEqual(m.orient[i]);
          expect(m.distance[i + 1], `distance ${i + 1}`).toBe(m.distance[i]);
          expect(m.curvature[i + 1], `curvature ${i + 1}`).toBe(m.curvature[i]);
        }
      }
    }
  }, 240_000);

  it("Fixed Up agrees with the blocked reference on the same strips", async () => {
    const wander = formulaPoints("kernel_source", 7000, WANDER);
    const m = await measureFrom(wander, 7000, { cols: 3500, rows: 2 }, { method: "fixedUp", up: [0.2, 1, -0.3], twist: 40 });
    for (const strip of [0, 1]) {
      const points = m.position.slice(strip * 3500, (strip + 1) * 3500);
      agree(m, frameStrip(points, { closed: false, method: "fixedUp", up: [0.2, 1, -0.3], twist: (40 * Math.PI) / 180, extrapolateEnds: true }), strip * 3500, `strip ${strip}`);
    }
  }, 240_000);

  /**
   * A curve doubling straight back has no smallest rotation: the frame turns about its own
   * normal, which keeps the normal and turns the direction round. That mirrors the angle a
   * block's reference is carried at, and a block must say so. Here the curve wanders first,
   * so the frame that reaches the second block is not the one the block would pick for
   * itself; then, inside that block, it runs out along +X in quarter steps and exactly back.
   */
  it("an exact reversal inside a later block: the frame on the far side is the reference's", async () => {
    const doubled = formulaPoints(
      "kernel_source",
      2200,
      `  let t = f32(min(i, 1099u)) * 0.013;
  q.position = vec3f(cos(t) * (1.0 + 0.3 * sin(t * 2.7)), sin(t * 1.3), sin(t * 0.7) + t * 0.1);
  if (i >= 1100u) { q.position = vec3f(3.0 + f32(min(i, 1300u) - 1100u) * 0.25, 1.0, 0.5); }
  if (i > 1300u) { q.position.x = 53.0 - f32(min(i, 1400u) - 1300u) * 0.25; }
  if (i > 1400u) {
    let w = f32(i - 1400u) * 0.02;
    q.position = vec3f(28.0 - w, 1.0 + sin(w), 0.5 + (1.0 - cos(w * 1.7)));
  }`,
    );
    const m = await measureFrom(doubled, 2200, { cols: 2200, rows: 1 }, { up: [0.3, 1, 0.2] });
    // The reversal is exact: out along +X, back along −X.
    close(m.tangent[1200]!, [1, 0, 0], "outward", 6);
    close(m.tangent[1350]!, [-1, 0, 0], "and back", 6);
    agree(m, frameStrip(m.position, { closed: false, method: "minimiseTwist", up: [0.3, 1, 0.2], extrapolateEnds: true }), 0, "the whole strip");
  }, 120_000);

  /**
   * WHAT A BLOCK IS: the whole walk, started where the block starts. So the first block of
   * a long strip is walked as those 1,024 points are walked when they are a strip of their
   * own, and all but the last of them — which is an end there and a middle here — read back
   * the same frame at the THOUSANDTH point as at the tenth: to the last digit of single
   * precision, with nothing accumulated. (Not `toEqual`: the two are different programs,
   * and a device may fuse a multiply and an add in one and not in the other. Measured here,
   * tangent, distance and curvature are the same bytes and a normal differs by at most one
   * unit in its last place. No twist: a twist is spread over the strip's whole length,
   * which the two strips do not share.)
   */
  it("the first block of a long strip is the short strip its points make, to the last digit", async () => {
    const body = "  let t = f32(i) * 0.013;\n  q.position = vec3f(cos(t) * (1.0 + 0.3 * sin(t * 2.7)), sin(t * 1.3), sin(t * 0.7) + t * 0.1);";
    for (const method of METHODS) {
      const whole = await measureFrom(formulaPoints("kernel_source", 1024, body), 1024, { cols: 1024, rows: 1 }, { method, roll: 15 });
      const long = await measureFrom(formulaPoints("kernel_source", 1500, body), 1500, { cols: 1500, rows: 1 }, { method, roll: 15 });
      expect(long.position.slice(0, 1024)).toEqual(whole.position);
      for (let i = 0; i < 1023; i += 1) {
        for (const name of ["tangent", "normal", "binormal", "orient"] as const) close(long[name][i]!, whole[name][i]!, `${method} ${name} ${i}`, 6);
        expect(long.distance[i], `${method} distance ${i}`).toBeCloseTo(whole.distance[i]!, 5);
        expect(long.curvature[i], `${method} curvature ${i}`).toBeCloseTo(whole.curvature[i]!, 5);
      }
      // The control: the 1,024th point is the short strip's end and the long strip's middle.
      expect(long.tangent[1023]).not.toEqual(whole.tangent[1023]);
    }
  }, 120_000);

  /**
   * Fixed Up where the curve runs straight along Up for 2,600 points — longer than two
   * blocks. No point of the run can lean toward Up, so each takes the normal of the point
   * before it, and whole blocks hand on what they were handed.
   *
   * Up is (½, 1, 1) and the run goes along (1, 2, 2) in steps of exactly 3, off every axis
   * so that a block's map of the handed normal has no zero in it to hide a mistake. By
   * hand: before the run the curve goes along +X and leans (0, 1, 1)/√2. The corner into
   * the run has the tangent (2, 1, 1)/√6, where Up made square is (−1, 1, 1)/√3. That,
   * pressed square to (1, 2, 2)/3, is (−4, 1, 1)/(3√2) — and so is every point of the run.
   */
  it("Fixed Up through a run along Up longer than two blocks hands the normal across every seam", async () => {
    const shaft = formulaPoints(
      "kernel_source",
      2700,
      `  let s = f32(i);
  if (i < 5u) { q.position = vec3f(s, 0.0, 0.0); }
  else if (i < 2605u) { q.position = vec3f(s, 2.0 * (s - 4.0), 2.0 * (s - 4.0)); }
  else { q.position = vec3f(s, 5200.0, 5200.0); }`,
    );
    const corner = [-1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)];
    const handed = [-4 / (3 * Math.SQRT2), 1 / (3 * Math.SQRT2), 1 / (3 * Math.SQRT2)];
    await onDawn(framesGraph(shaft, 2700, { cols: 2700, rows: 1 }, { method: "fixedUp", up: [0.5, 1, 1] }), async (session) => {
      const m = await readMeasured(session, shaft, 2700);
      close(m.normal[3]!, [0, H, H], "before the run", 6);
      close(m.normal[4]!, corner, "the corner into the run");
      for (let i = 5; i < 2604; i += 1) {
        close(m.tangent[i]!, [1 / 3, 2 / 3, 2 / 3], `tangent ${i}`, 6);
        close(m.normal[i]!, handed, `normal ${i}`);
      }
      close(m.normal[2604]!, corner, "the corner out of the run");
      close(m.normal[2650]!, [0, H, H], "after the run", 6);
      // Four unit steps, 2,600 steps of 3, and 95 unit steps: every sum exact.
      expect(m.distance[2699]).toBe(4 + 2600 * 3 + 95);

      /* THE COST, which no point's value shows. The second block holds no point that can
         decide a normal, so what it hands the third is its MAP of what it was handed. If
         the fold got that map wrong, or did not trust it, the write pass would still be
         right — by walking the run again, as deep as the run is long. So the fold itself is
         held here: it hands both later blocks the run's normal, and says it knows it. */
      const walk = await session.readScratch("frames_spine", "walk");
      for (const block of [1, 2]) {
        const entry = curveFramesHandedAt(walk, 1, 3, 0, block);
        expect(entry.known, `block ${block}`).toBe(true);
        close(entry.normal, handed, `the normal handed to block ${block}`);
      }
    });
  }, 120_000);

  /**
   * The corner a block's summary cannot hold, on the device. Up is mapped to the curve's own
   * tangent from the third point on, so no point can decide its normal and whole blocks
   * only hand one on. At point 1,500, inside the second block, the curve doubles straight
   * back: the tangent there swings onto the handed normal, which is pressed to nothing and
   * restarts from a world axis. The fold sees only that the handed normal has vanished and
   * marks the third block's as not known; the third block walks forward from the second.
   */
  it("Fixed Up: a handed normal that collapses inside a block is followed into the next", async () => {
    const count = 2600;
    const source = formulaPoints(
      "kernel_source",
      count,
      `  let back = f32(max(i, 1501u) - 1501u);
  var x = f32(min(i, 1500u)) * 0.01;
  if (i > 1500u) { x = 14.99 - back * 0.004; }
  q.position = vec3f(x, sin(back * 0.01) * 0.5, (1.0 - cos(back * 0.013)) * 0.5);`,
    );
    const leanSchema = [
      { name: "position", type: "vec3f" as const },
      { name: "lean", type: "vec3f" as const },
      { name: "tangent", type: "vec3f" as const },
    ];
    const sink = drawnTo("frames_spine", count);
    const graph = curveGraph(
      [
        source.node,
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: count, rows: 1 }),
        // The curve's own tangents, to hand back as Up: carried from a +Z seed, as below.
        curveNode("frames_first", "pointCurveFrames", { vectors: true, up: [0, 0, 1] }),
        curveNode("kernel_lean", "pointKernel", {
          capacity: count,
          seed: 7,
          attributes: JSON.stringify(leanSchema.map((entry) => ({ ...entry, ...(entry.name === "position" ? { semantic: "position" } : {}), default: [0, 0, 0] }))),
          kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.lean = p.tangent;
  if (ctx.index == 0u) { q.lean = vec3f(0.0, 0.0, 1.0); }
  if (ctx.index == 1u) { q.lean = vec3f(0.0, 1.0, 0.0); }
  return q;
}`,
        }),
        curveNode("frames_spine", "pointCurveFrames", { vectors: true, method: "fixedUp", up: mappedTo("lean", [0, 1, 0]) }),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_source", "out"], ["topology_strips", "points"]),
        curveEdge(["topology_strips", "out"], ["frames_first", "points"]),
        curveEdge(["frames_first", "out"], ["kernel_lean", "in"]),
        curveEdge(["kernel_lean", "out"], ["frames_spine", "points"]),
        ...sink.edges,
      ],
    );
    await onDawn(graph, async (session) => {
      const m = await readMeasured(session, source, count);
      const leanFloats = (await session.read("kernel_lean", leanSchema, count, "lean")).floats;
      const up = Array.from({ length: count }, (_, index) => vecAt(leanFloats, index) as unknown as Vec3);
      // The collapse is real: into the reversal the handed normal is +Y, and there the tangent is +Y.
      close(m.normal[1499]!, [0, 1, 0], "the handed normal before the reversal", 6);
      close(m.tangent[1500]!, [0, 1, 0], "the tangent at the reversal", 6);
      close(m.normal[1500]!, [1, 0, 0], "restarted from the world axis least aligned with it", 6);
      agree(m, frameStrip(m.position, { closed: false, method: "fixedUp", up, extrapolateEnds: true }), 0, "the whole strip");
      // And this is the path it took: the fold knew what to hand the second block, not the third.
      const walk = await session.readScratch("frames_spine", "walk");
      expect(curveFramesHandedAt(walk, 1, 3, 0, 1).known).toBe(true);
      expect(curveFramesHandedAt(walk, 1, 3, 0, 2).known).toBe(false);
    });
  }, 120_000);

  /**
   * §V170, with scratch in it: the walk's summaries live in a buffer that outlasts the
   * frame, and every word a pass reads must have been written by a pass of the SAME frame.
   * So frame 5 rendered on its own is frame 5 after frames 0 to 4, byte for byte, while the
   * curve moves under it.
   */
  it("seek: under a moving long curve, frame 5 rendered directly is frame 5 after frames 0 to 4", async () => {
    const moving = formulaPoints(
      "kernel_source",
      3000,
      // timeline-anchored: the fixture's position in the piece is the point of the test.
      "  let t = f32(i % 1500u) * 0.01;\n  q.position = vec3f(t * 2.0, sin(ctx.time * 3.0 + t), cos(t * 1.3 + ctx.time) + f32(i / 1500u));",
    );
    const schema = curveFramesAttributes(ALL);
    for (const method of METHODS) {
      const graph = framesGraph(moving, 3000, { cols: 1500, rows: 2, closed: true }, { method, twist: 90 });
      const snapshot = async (session: CurveSession): Promise<number[]> => [
        ...(await session.read("frames_spine", schema, 3000, "orient")).words,
        ...(await session.read("frames_spine", schema, 3000, "distance")).words,
        ...(await session.read("frames_spine", schema, 3000, "curveU")).words,
      ];
      const direct = await onDawn(graph, snapshot, 16, 5);
      const played = await onDawn(graph, async (session) => {
        for (let frame = 1; frame <= 5; frame += 1) session.renderFrame(frame);
        return snapshot(session);
      });
      const still = await onDawn(graph, snapshot);
      expect(played, method).toEqual(direct);
      // The control: the curve really moved between frame 0 and frame 5.
      expect(still, method).not.toEqual(direct);
    }
  }, 240_000);
});

/**
 * T1587b C13 — EXTRAPOLATE ENDS: an open strip's two ends aimed by their two nearest
 * segments.
 *
 * Two claims, and they are separate. WHAT an end is aimed at: the slope, at the end, of the
 * parabola through the end's three nearest points — by hand on a right angle, in closed
 * form on a circle, and against the reference everywhere above. And WHAT ELSE CHANGES:
 * nothing. The ends are rewritten by a pass after the walk, so with the switch on and off
 * every interior value of every attribute is the same WORD, and so is every metric at an
 * end. That is asserted on bits, not digits, on a short strip and on one cut into blocks.
 */
describe("Curve Frames on Dawn — Extrapolate Ends (T1587b C13)", () => {
  const SCHEMA = curveFramesAttributes(ALL);
  const FRAME = ["orient", "tangent", "normal", "binormal"] as const;
  const METRICS = ["distance", "curveU", "curveLength", "curvature"] as const;
  const words = (name: string): number => (name === "orient" || name === "tangent" || name === "normal" || name === "binormal" ? 4 : 1);
  /** Every attribute Curve Frames wrote, as the words in its buffer. */
  const bitsOf = (source: Source, count: number, strips: Strips, parameters: Record<string, unknown>): Promise<Record<string, Uint32Array>> =>
    onDawn(framesGraph(source, count, strips, parameters), async (session) => {
      const read: Record<string, Uint32Array> = {};
      for (const name of [...FRAME, ...METRICS]) read[name] = new Uint32Array((await session.read("frames_spine", SCHEMA, count, name)).words);
      return read;
    });
  const slotOf = (bits: Record<string, Uint32Array>, name: string, slot: number): number[] => Array.from(bits[name]!.subarray(slot * words(name), (slot + 1) * words(name)));

  /**
   * A right angle with equal legs, in the XY plane, Up out of it. The parabola through
   * (0,0), (1,0), (1,1) leaves its first point along 1.5 × (1,0) − 0.5 × (0,1) and arrives at
   * its last along 1.5 × (0,1) − 0.5 × (1,0). The curve is planar and the frame is turned
   * about the plane's own normal, so the normal stays +Z to the bit.
   */
  it("a right angle with equal legs: each end leans back by half the next leg, by hand", async () => {
    const size = Math.hypot(1.5, 0.5);
    const m = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0]], { cols: 3, rows: 1 }, { up: [0, 0, 1] });
    close(m.tangent[0]!, [1.5 / size, -0.5 / size, 0], "the first point's tangent", 6);
    close(m.tangent[2]!, [-0.5 / size, 1.5 / size, 0], "the last point's tangent", 6);
    // The corner between them is the walk's: the bisector of its two legs.
    close(m.tangent[1]!, [H, H, 0], "the corner's tangent", 6);
    for (const slot of [0, 1, 2]) expect(m.normal[slot], `normal ${slot}`).toEqual([0, 0, 1]);
    // Off, an end is its leg.
    const off = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0]], { cols: 3, rows: 1 }, { up: [0, 0, 1], extrapolateEnds: false });
    expect(off.tangent[0]).toEqual([1, 0, 0]);
    expect(off.tangent[2]).toEqual([0, 1, 0]);
  }, 60_000);

  /**
   * Unequal legs weigh by their lengths: the end's own leg h and the next one g give
   * d + (d − e) × h ÷ (h + g). A first leg of 2 and a second of 1: (1,0) + ((1,0) − (0,1)) × ⅔
   * = (5, −2) ÷ 3. Seen from the other end the legs are 1 and 2: (0,1) + ((0,1) − (1,0)) × ⅓
   * = (−1, 4) ÷ 3.
   */
  it("unequal legs: the nearer segment's share is its own length over the two", async () => {
    const m = await measure([[0, 0, 0], [2, 0, 0], [2, 1, 0]], { cols: 3, rows: 1 }, { up: [0, 0, 1] });
    close(m.tangent[0]!, [5 / Math.hypot(5, 2), -2 / Math.hypot(5, 2), 0], "the first point's tangent", 6);
    close(m.tangent[2]!, [-1 / Math.hypot(1, 4), 4 / Math.hypot(1, 4), 0], "the last point's tangent", 6);
  }, 60_000);

  /**
   * WHY IT IS DONE. Nine points on a quarter circle, equal chords, each turning by φ. An
   * end's chord points half a chord further round than the circle does at the end: off by
   * φ ÷ 2. The extrapolated tangent is 1.5 × the first chord − 0.5 × the second, which is
   * off by atan2(1.5 sin a − 0.5 sin 3a, 1.5 cos a − 0.5 cos 3a) with a = φ ÷ 2: about 2a³.
   * Here that is 0.098 rad against 0.0019: fifty times nearer, and the same order as the
   * points in between.
   */
  it("on a circle an end is off its own tangent by about 2a³ where its chord is off by a", async () => {
    const angles = Array.from({ length: 9 }, (_, index) => (index / 8) * (Math.PI / 2));
    const arc = angles.map((angle): Vec3 => [2 - 2 * Math.cos(angle), 0, 2 * Math.sin(angle)]);
    const a = Math.PI / 2 / 8 / 2;
    const residue = Math.atan2(1.5 * Math.sin(a) - 0.5 * Math.sin(3 * a), 1.5 * Math.cos(a) - 0.5 * Math.cos(3 * a));
    expect(residue).toBeGreaterThan(0);
    expect(residue).toBeLessThan(2.1 * a ** 3);
    // The circle leaves along +Z and arrives along +X; angles are from +Z toward +X.
    const heading = (tangent: readonly number[]): number => Math.atan2(tangent[0]!, tangent[2]!);
    const on = await measure(arc, { cols: 9, rows: 1 });
    expect(heading(on.tangent[0]!), "the first point").toBeCloseTo(residue, 6);
    expect(heading(on.tangent[8]!), "the last point").toBeCloseTo(Math.PI / 2 - residue, 6);
    const off = await measure(arc, { cols: 9, rows: 1 }, { extrapolateEnds: false });
    expect(heading(off.tangent[0]!), "the first point, its chord").toBeCloseTo(a, 6);
    expect(heading(off.tangent[8]!), "the last point, its chord").toBeCloseTo(Math.PI / 2 - a, 6);
    // And the points in between, either way, are the circle's own to rounding.
    for (let index = 1; index < 8; index += 1) expect(heading(on.tangent[index]!), `point ${index}`).toBeCloseTo(angles[index]!, 6);
    // A planar curve under Up square to its plane: no end's normal leaves +Y.
    for (let index = 0; index < 9; index += 1) close(on.normal[index]!, [0, 1, 0], `normal ${index}`, 6);
  }, 60_000);

  /** Two strips that leave their planes, each with its start repeated three times and its end four. */
  const BENT: ReadonlyArray<Vec3> = [
    [0, 0, 0], [0, 0, 0], [0, 0, 0], [1, 0.25, 0], [1.5, 1, 0.5], [1, 2, 1.5], [0, 2.5, 1], [-1, 2, 0], [-1, 2, 0], [-1, 2, 0], [-1, 2, 0], [-1, 2, 0],
    [4, 0, 0], [4, 0, 0], [4, 0, 0], [4, 1, 0.5], [5, 1, 1], [5, 3, 1], [3, 3, 2], [3, 0, -1], [3, 0, -1], [3, 0, -1], [3, 0, -1], [3, 0, -1],
  ];
  /** A bank and a lean that differ at every slot, the repeats included. */
  const BANK: AuthoredAttribute = { name: "bank", type: "f32", values: Array.from({ length: 24 }, (_, slot) => 5 + slot * 7) };
  const LEAN: AuthoredAttribute = {
    name: "lean",
    type: "vec3f",
    values: Array.from({ length: 24 }, (_, slot) => [0.25 * Math.sin(slot), 1, 0.25 * Math.cos(slot * 1.7)]),
  };
  const SEEDS: AuthoredAttribute = {
    name: "orient",
    type: "vec4f",
    values: Array.from({ length: 24 }, (_, slot) => (slot < 12 ? [0.5, 0.5, 0.5, 0.5] : [0, Math.SQRT1_2, 0, Math.SQRT1_2])),
  };
  const CASES: ReadonlyArray<{ readonly name: string; readonly parameters: Record<string, unknown>; readonly reference: (strip: number) => Parameters<typeof frameStrip>[1] }> = [
    {
      name: "Minimise Twist, rolled, twisted and banked per point",
      parameters: { roll: mappedTo("bank", 20), twist: 75, up: [0.2, 1, -0.3] },
      reference: (strip) => ({
        closed: false,
        method: "minimiseTwist",
        up: [0.2, 1, -0.3],
        roll: (20 * Math.PI) / 180,
        rollPerPoint: (BANK.values as number[]).slice(strip * 12, strip * 12 + 12).map((degrees) => (degrees * Math.PI) / 180),
        twist: (75 * Math.PI) / 180,
        extrapolateEnds: true,
      }),
    },
    {
      name: "Minimise Twist, seeded from a quaternion",
      parameters: { seed: "orient", twist: -40 },
      reference: (strip) => ({
        closed: false,
        method: "minimiseTwist",
        up: UP_Y,
        seedOrient: (strip === 0 ? [0.5, 0.5, 0.5, 0.5] : [0, Math.SQRT1_2, 0, Math.SQRT1_2]) as [number, number, number, number],
        twist: (-40 * Math.PI) / 180,
        extrapolateEnds: true,
      }),
    },
    {
      name: "Fixed Up, Up mapped per point, banked per point",
      parameters: { method: "fixedUp", up: mappedTo("lean", [0, 1, 0]), roll: mappedTo("bank", -15), twist: 30 },
      reference: (strip) => ({
        closed: false,
        method: "fixedUp",
        up: (LEAN.values as number[][]).slice(strip * 12, strip * 12 + 12).map((lean) => lean.map((value) => Math.fround(value)) as unknown as Vec3),
        roll: (-15 * Math.PI) / 180,
        rollPerPoint: (BANK.values as number[]).slice(strip * 12, strip * 12 + 12).map((degrees) => (degrees * Math.PI) / 180),
        twist: (30 * Math.PI) / 180,
        extrapolateEnds: true,
      }),
    },
  ];

  for (const entry of CASES) {
    it(`a short strip, ${entry.name}: the ends are the reference's, and nothing else moved a bit`, async () => {
      const source = authoredPoints("kernel_source", BENT, [BANK, LEAN, SEEDS]);
      const strips = { cols: 12, rows: 2 };

      /* The ends, and every point, against the reference. */
      const m = await measureFrom(source, 24, strips, entry.parameters);
      for (const strip of [0, 1]) {
        const expected = frameStrip(m.position.slice(strip * 12, strip * 12 + 12), entry.reference(strip));
        for (let i = 0; i < 12; i += 1) {
          const slot = strip * 12 + i;
          close(m.tangent[slot]!, expected.tangent[i]!, `strip ${strip} tangent ${i}`);
          close(m.normal[slot]!, expected.normal[i]!, `strip ${strip} normal ${i}`);
          close(m.binormal[slot]!, expected.binormal[i]!, `strip ${strip} binormal ${i}`);
          expect(Math.abs(m.orient[slot]!.reduce((sum, value, axis) => sum + value * expected.orient[i]![axis]!, 0)), `strip ${strip} orient ${i}`).toBeCloseTo(1, 5);
        }
      }

      /* On against off, word for word. The first run is slots 0 to 2 (the start and its
         two repeats), the last is slots 7 to 11. */
      const on = await bitsOf(source, 24, strips, entry.parameters);
      const off = await bitsOf(source, 24, strips, { ...entry.parameters, extrapolateEnds: false });
      for (const strip of [0, 1]) {
        for (let i = 0; i < 12; i += 1) {
          const slot = strip * 12 + i;
          const inEnd = i <= 2 || i >= 7;
          for (const name of METRICS) expect(slotOf(on, name, slot), `${name}, strip ${strip} point ${i}`).toEqual(slotOf(off, name, slot));
          for (const name of FRAME) {
            if (inEnd) expect(slotOf(on, name, slot), `${name}, strip ${strip} point ${i}: an end`).not.toEqual(slotOf(off, name, slot));
            else expect(slotOf(on, name, slot), `${name}, strip ${strip} point ${i}: inside`).toEqual(slotOf(off, name, slot));
          }
        }
      }
    }, 120_000);
  }

  /**
   * A strip cut into blocks, most of it padding: the start is repeated through the whole
   * first block and into the second, and the end through the fourth block's tail and all
   * of the fifth. One pass per strip finds the two ends through the block summaries; every
   * block rewrites its own share of the two runs.
   */
  it("a long strip, mostly padding: both runs are re-aimed whole, and every slot between them is the same word", async () => {
    const COUNT = 4500;
    const padded = formulaPoints(
      "kernel_source",
      COUNT * 2,
      `  let j = i / ${COUNT}u;
  let s = clamp(i % ${COUNT}u, 1100u, 3200u);
  let t = f32(s) * 0.013 + f32(j) * 1.7;
  q.position = vec3f(cos(t) * (1.0 + 0.3 * sin(t * 2.7)), sin(t * 1.3) * 0.8 + 0.2 * cos(t * 3.1), sin(t * 0.7) + f32(s) * 0.001);`,
    );
    const strips = { cols: COUNT, rows: 2 };
    for (const [method, parameters] of [
      ["minimiseTwist", { roll: 20, twist: 75, up: [0.2, 1, -0.3] }],
      ["fixedUp", { method: "fixedUp", up: [0.2, 1, -0.3], twist: 40 }],
    ] as const) {
      const on = await bitsOf(padded, COUNT * 2, strips, parameters);
      const off = await bitsOf(padded, COUNT * 2, strips, { ...parameters, extrapolateEnds: false });
      for (const strip of [0, 1]) {
        const base = strip * COUNT;
        for (const name of METRICS) expect(Array.from(on[name]!.subarray(base, base + COUNT)), `${method} ${name}`).toEqual(Array.from(off[name]!.subarray(base, base + COUNT)));
        for (const name of FRAME) {
          // Inside: slots 1,101 to 3,199, across the seams at 2,048 and 3,072.
          expect(Array.from(on[name]!.subarray((base + 1101) * 4, (base + 3200) * 4)), `${method} ${name}, inside`).toEqual(
            Array.from(off[name]!.subarray((base + 1101) * 4, (base + 3200) * 4)),
          );
          // The first run, slots 0 to 1,100, and the last, 3,200 to 4,499: one frame each, to the bit, and not the chord's.
          for (const [from, to] of [[0, 1100], [3200, COUNT - 1]] as const) {
            const first = slotOf(on, name, base + from);
            expect(first, `${method} ${name}, slot ${from}`).not.toEqual(slotOf(off, name, base + from));
            for (let slot = from + 1; slot <= to; slot += 1) {
              if (String(slotOf(on, name, base + slot)) !== String(first)) expect(slotOf(on, name, base + slot), `${method} ${name}, slot ${slot}`).toEqual(first);
            }
          }
        }
      }
    }
  }, 240_000);

  /**
   * Two points say nothing about how a curve turns, and neither does one segment with a
   * length among repeats: the strip keeps its chord. With slots enough for a pass to exist
   * (five), on and off are the same words everywhere.
   */
  it("fewer than two segments with a length: the strip keeps its chord, to the bit", async () => {
    const one: ReadonlyArray<Vec3> = [[0, 0, 0], [0, 0, 0], [1, 2, 2], [1, 2, 2], [1, 2, 2]];
    const source = authoredPoints("kernel_source", one);
    const on = await bitsOf(source, 5, { cols: 5, rows: 1 }, {});
    const off = await bitsOf(source, 5, { cols: 5, rows: 1 }, { extrapolateEnds: false });
    for (const name of [...FRAME, ...METRICS]) expect(Array.from(on[name]!), name).toEqual(Array.from(off[name]!));
    const m = await measure(one, { cols: 5, rows: 1 });
    for (let slot = 0; slot < 5; slot += 1) close(m.tangent[slot]!, [1 / 3, 2 / 3, 2 / 3], `tangent ${slot}`, 6);
    // And a strip of two points has no pass to run at all: its tangent is its one segment's.
    const pair = await measure([[0, 0, 0], [1, 2, 2], [5, 0, 0], [5, 0, 3]], { cols: 2, rows: 2 });
    close(pair.tangent[0]!, [1 / 3, 2 / 3, 2 / 3], "the first pair", 6);
    expect(pair.tangent[3]).toEqual([0, 0, 1]);
  }, 120_000);

  /**
   * A straight end is exact. Where an end's two segments run the same way to the bit there
   * is nothing to extrapolate, and the end is left as the walk wrote it: here the first
   * three points are on a line and the last three are not. The line runs along (1, 2, 2),
   * whose direction is thirds and so is NOT a unit vector to the bit in f32: re-aiming it
   * "at itself" would renormalise it and move its last digits.
   */
  it("an end whose two segments run the same way is left alone, to the bit; the other end is aimed", async () => {
    const hook: ReadonlyArray<Vec3> = [[0, 0, 0], [1, 2, 2], [2, 4, 4], [3, 5, 4], [3, 6, 5]];
    const source = authoredPoints("kernel_source", hook);
    const parameters = { up: [0.3, 1, 0.2], roll: 25 };
    const on = await bitsOf(source, 5, { cols: 5, rows: 1 }, parameters);
    const off = await bitsOf(source, 5, { cols: 5, rows: 1 }, { ...parameters, extrapolateEnds: false });
    for (const name of FRAME) {
      expect(slotOf(on, name, 0), `${name}: the straight end`).toEqual(slotOf(off, name, 0));
      expect(slotOf(on, name, 4), `${name}: the bent end`).not.toEqual(slotOf(off, name, 4));
    }
    close(vecAt(new Float32Array(on["tangent"]!.buffer), 0), [1 / 3, 2 / 3, 2 / 3], "the straight end's tangent", 6);
  }, 60_000);

  /**
   * A long strip's ends are found through the walk's block summaries, and an end's two
   * segments need not be in one block. Here the curve begins on the LAST segment of the
   * first block (slot 1,023 to 1,024) and ends on the FIRST segment of the third (2,048 to
   * 2,049): each end's own segment is the only one its block has, and the next one is read
   * off the neighbouring block's summary.
   */
  it("a long strip whose end segments are alone in their blocks: the second one comes from the next block's summary", async () => {
    const COUNT = 3000;
    const straddle = formulaPoints(
      "kernel_source",
      COUNT,
      `  let t = f32(clamp(i, 1023u, 2049u)) * 0.013;
  q.position = vec3f(cos(t) * (1.0 + 0.3 * sin(t * 2.7)), sin(t * 1.3) * 0.8 + 0.2 * cos(t * 3.1), sin(t * 0.7) + t * 0.1);`,
    );
    const between = (m: Measured, k: number): Vec3 => [m.position[k + 1]![0] - m.position[k]![0], m.position[k + 1]![1] - m.position[k]![1], m.position[k + 1]![2] - m.position[k]![2]];
    for (const method of ["minimiseTwist", "fixedUp"] as const) {
      const m = await measureFrom(straddle, COUNT, { cols: COUNT, rows: 1 }, { method, up: [0.2, 1, -0.3] });
      // The rule, from the points the device holds: segments 1,023 and 1,024 at the start, 2,048 and 2,047 at the end.
      const head = endTangent(between(m, 1023), between(m, 1024)) as Vec3;
      const tail = endTangent(between(m, 2048), between(m, 2047)) as Vec3;
      for (const slot of [0, 500, 1023]) close(m.tangent[slot]!, head, `${method}: the first run, slot ${slot}`, 5);
      for (const slot of [2049, 2500, COUNT - 1]) close(m.tangent[slot]!, tail, `${method}: the last run, slot ${slot}`, 5);
      // And not the end segments' own directions, which is what they were.
      const chord = between(m, 1023);
      const size = Math.hypot(chord[0], chord[1], chord[2]);
      expect(Math.abs(m.tangent[0]![0]! - chord[0] / size) + Math.abs(m.tangent[0]![1]! - chord[1] / size) + Math.abs(m.tangent[0]![2]! - chord[2] / size)).toBeGreaterThan(1e-4);
      // The whole frame at both ends, against the reference.
      const expected = frameStrip(m.position, { closed: false, method, up: [0.2, 1, -0.3], extrapolateEnds: true });
      for (const slot of [0, 1023, 1024, 2048, 2049, COUNT - 1]) {
        close(m.tangent[slot]!, expected.tangent[slot]!, `${method} tangent ${slot}`, 4);
        close(m.normal[slot]!, expected.normal[slot]!, `${method} normal ${slot}`, 4);
      }
    }
  }, 240_000);

  /**
   * Fixed Up at an end: the normal is Up made square to the NEW tangent, which is the
   * method's own rule and not the old normal turned (the two differ by a roll on a climbing
   * curve). And where Up runs along an end it cannot say which way to lean: that end keeps
   * its chord's frame, and the other end is still aimed.
   */
  it("Fixed Up leans an end's normal toward Up about its new tangent, and leaves an end that runs along Up", async () => {
    const climb: ReadonlyArray<Vec3> = [[0, 0, 0], [1, 0.5, 0], [1.5, 1.25, 0.75], [1.25, 2.25, 1.5], [0.5, 2.75, 2.5]];
    const m = await measure(climb, { cols: 5, rows: 1 }, { method: "fixedUp" });
    for (const slot of [0, 4]) {
      const tangent = m.tangent[slot]!;
      const leaning = [0, 1, 0].map((value, axis) => value - tangent[axis]! * tangent[1]!);
      const size = Math.hypot(leaning[0]!, leaning[1]!, leaning[2]!);
      close(m.normal[slot]!, leaning.map((value) => value / size), `the normal at slot ${slot}`, 6);
    }
    // The first leg runs straight up Up, then the path bends away.
    const mast: ReadonlyArray<Vec3> = [[0, 0, 0], [0, 1, 0], [0.5, 2, 0], [1.5, 2.5, 0.5], [2.5, 2.5, 1.5]];
    const source = authoredPoints("kernel_source", mast);
    const on = await bitsOf(source, 5, { cols: 5, rows: 1 }, { method: "fixedUp" });
    const off = await bitsOf(source, 5, { cols: 5, rows: 1 }, { method: "fixedUp", extrapolateEnds: false });
    for (const name of FRAME) {
      expect(slotOf(on, name, 0), `${name}: the end along Up`).toEqual(slotOf(off, name, 0));
      expect(slotOf(on, name, 4), `${name}: the other end`).not.toEqual(slotOf(off, name, 4));
    }
  }, 120_000);
});
