import { describe, expect, it } from "vitest";

import { frameStrip, type Vec3 } from "../../points/curve.ts";
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
} from "./curve-test-support.ts";
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
 */

const ALL = { frame: true, vectors: true, metrics: true } as const;
const UP_Y: Vec3 = [0, 1, 0];
const H = Math.SQRT1_2;

interface Measured {
  readonly tangent: number[][];
  readonly normal: number[][];
  readonly binormal: number[][];
  readonly orient: number[][];
  readonly distance: number[];
  readonly curveU: number[];
  readonly curveLength: number[];
  readonly curvature: number[];
}

/** authored points → Topology (Strips) → Curve Frames, every output on; one frame on Dawn. */
async function measure(
  positions: ReadonlyArray<Vec3>,
  strips: { readonly cols: number; readonly rows: number; readonly closed?: boolean },
  parameters: Record<string, unknown> = {},
  extras: ReadonlyArray<AuthoredAttribute> = [],
): Promise<Measured> {
  const count = positions.length;
  const source = authoredPoints("kernel_source", positions, extras);
  const sink = drawnTo("frames_spine", count);
  const graph = curveGraph(
    [
      source.node,
      curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: strips.cols, rows: strips.rows, wrapU: strips.closed === true }),
      curveNode("frames_spine", "pointCurveFrames", { vectors: true, ...parameters }),
      ...sink.nodes,
    ],
    [curveEdge(["kernel_source", "out"], ["topology_strips", "points"]), curveEdge(["topology_strips", "out"], ["frames_spine", "points"]), ...sink.edges],
  );
  const schema = curveFramesAttributes(ALL);
  return onDawn(graph, async (session) => {
    const read = async (name: string) => (await session.read("frames_spine", schema, count, name)).floats;
    const vectors = async (name: string, size: 3 | 4 = 3) => {
      const floats = await read(name);
      return Array.from({ length: count }, (_, index) => vecAt(floats, index, size));
    };
    return {
      tangent: await vectors("tangent"),
      normal: await vectors("normal"),
      binormal: await vectors("binormal"),
      orient: await vectors("orient", 4),
      distance: Array.from(await read("distance")),
      curveU: Array.from(await read("curveU")),
      curveLength: Array.from(await read("curveLength")),
      curvature: Array.from(await read("curvature")),
    };
  });
}

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
   * its turn, so its tangent is the bisector of its two sides.
   */
  it("three unit steps along X, Y, Z: two quarter turns, by hand", async () => {
    const m = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], { cols: 4, rows: 1 });
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
    const options = { closed: false, method: "minimiseTwist", up: UP_Y, roll: (20 * Math.PI) / 180, twist: (75 * Math.PI) / 180 } as const;
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
   * normal is back on +Y — a carried frame would still be leaning.
   */
  it("Fixed Up through vertical keeps the previous normal, recovers after, and is finite everywhere", async () => {
    const m = await measure([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 2, 0], [2, 2, 0]], { cols: 5, rows: 1 }, { method: "fixedUp" });
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
