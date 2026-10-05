import { describe, expect, it } from "vitest";

import {
  CURVE_TABLE_LIMIT,
  arcPoint,
  curvePointCount,
  curveSpans,
  curveStations,
  evaluateCurve,
  frameStrip,
  parseCurveTable,
  quatFromFrame,
  resampleStations,
  resampleStrip,
  rotateByQuat,
  solveArc,
  stripLengths,
  type Vec3,
} from "./curve.ts";

/**
 * T1586b — the CPU reference, against values worked out by hand.
 *
 * `curve.ts` is what the GPU passes are compared with, so it cannot be its own witness:
 * every expectation here is a number a person can derive from the fixture (an axis-aligned
 * line, a square, three unit steps along the axes, a helix's closed form), never a value
 * the function was run to obtain.
 */

const line = (count: number, step: number): Vec3[] => Array.from({ length: count }, (_, i) => [i * step, 0, 0] as Vec3);
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const expectVec = (actual: readonly number[], expected: readonly number[], digits = 12): void => {
  expected.forEach((value, at) => expect(actual[at], `component ${at} of [${actual.join(", ")}]`).toBeCloseTo(value, digits));
};
const UP: Vec3 = [0, 1, 0];

describe("frameStrip — the frame convention (T1586b R5)", () => {
  it("a straight line along +X with Up +Y: tangent X, normal Y, binormal Z, to the bit", () => {
    const frames = frameStrip(line(5, 0.5), { closed: false, method: "minimiseTwist", up: UP });
    for (let i = 0; i < 5; i += 1) {
      expect(frames.tangent[i]).toEqual([1, 0, 0]);
      expect(frames.normal[i]).toEqual([0, 1, 0]);
      expect(frames.binormal[i]).toEqual([0, 0, 1]);
      expect(frames.distance[i]).toBe(i * 0.5);
      expect(frames.curveU[i]).toBe(i / 4);
      expect(frames.curvature[i]).toBe(0);
    }
    expect(frames.curveLength).toBe(2);
  });

  /**
   * The convention itself, checked by rotating the shape's axes with the published
   * quaternion: +Z must land on the tangent and +Y on the normal (the instancer's Forward
   * and Up, §T1581b), which puts +X on normal × tangent — the opposite of the binormal.
   */
  it("orient carries +Z onto the tangent, +Y onto the normal and +X onto −binormal", () => {
    const frames = frameStrip([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], { closed: false, method: "minimiseTwist", up: UP });
    for (let i = 0; i < 4; i += 1) {
      const q = frames.orient[i]!;
      expectVec(rotateByQuat(q, [0, 0, 1]), frames.tangent[i]!);
      expectVec(rotateByQuat(q, [0, 1, 0]), frames.normal[i]!);
      expectVec(rotateByQuat(q, [1, 0, 0]), frames.binormal[i]!.map((value) => -value));
      expectVec(frames.binormal[i]!, cross(frames.tangent[i]!, frames.normal[i]!));
    }
  });

  it("quatFromFrame of the identity frame is the identity, and of a third-turn is (½, ½, ½, ½)", () => {
    expect(quatFromFrame([1, 0, 0], [0, 1, 0], [0, 0, 1])).toEqual([0, 0, 0, 1]);
    // X → Y, Y → Z, Z → X: a third of a turn about (1, 1, 1).
    expect(quatFromFrame([0, 1, 0], [0, 0, 1], [1, 0, 0])).toEqual([0.5, 0.5, 0.5, 0.5]);
  });
});

describe("frameStrip — the frame is carried along the polyline (T1586b D9)", () => {
  /**
   * Three unit steps along +X, +Y, +Z, seeded with the normal on +Y. The turn from X to Y
   * is a quarter turn about Z, which carries the normal from +Y to −X. The turn from Y to
   * Z is a quarter turn about X, which leaves −X where it is. So the last segment's frame
   * is tangent +Z, normal −X — two quarter turns, by hand — and each corner's own frame is
   * half way through its turn.
   */
  it("two quarter turns: X, then Y, then Z", () => {
    const frames = frameStrip([[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 1]], { closed: false, method: "minimiseTwist", up: UP });
    const h = Math.SQRT1_2;
    expectVec(frames.tangent[0]!, [1, 0, 0]);
    expectVec(frames.normal[0]!, [0, 1, 0]);
    expectVec(frames.tangent[1]!, [h, h, 0]);
    expectVec(frames.normal[1]!, [-h, h, 0]);
    expectVec(frames.tangent[2]!, [0, h, h]);
    expectVec(frames.normal[2]!, [-1, 0, 0]);
    expectVec(frames.tangent[3]!, [0, 0, 1]);
    expectVec(frames.normal[3]!, [-1, 0, 0]);
    expectVec(frames.binormal[3]!, [0, -1, 0]);
    expect(frames.distance).toEqual([0, 1, 2, 3]);
    // The circle through three corners of a unit square has radius √½.
    expect(frames.curvature[1]).toBeCloseTo(Math.SQRT2, 12);
    expect(frames.curvature[0]).toBe(0);
    expect(frames.curvature[3]).toBe(0);
  });

  it("a planar closed curve never twists: the normal stays on the plane's own normal, exactly", () => {
    const square: Vec3[] = [[1, 0, 0], [0, 1, 0], [-1, 0, 0], [0, -1, 0]];
    const frames = frameStrip(square, { closed: true, method: "minimiseTwist", up: [0, 0, 1] });
    for (let i = 0; i < 4; i += 1) expect(frames.normal[i]).toEqual([0, 0, 1]);
    expect(frames.closingAngle).toBe(0);
    // Every corner of a square inscribed in the unit circle lies on that circle.
    for (let i = 0; i < 4; i += 1) expect(frames.curvature[i]).toBeCloseTo(1, 12);
    expect(frames.curveLength).toBeCloseTo(4 * Math.SQRT2, 12);
    // A corner's tangent is the bisector of its two sides: at (1, 0, 0) that is +Y.
    expectVec(frames.tangent[0]!, [0, 1, 0]);
    expectVec(frames.tangent[1]!, [-1, 0, 0]);
  });

  /**
   * THE CLOSED FORM. A helix sampled every `h` radians has segments that are one another's
   * image under a turn of `h` about the axis. That turn is the smallest rotation between
   * two consecutive segments FOLLOWED BY a twist about the second one, of
   * α = 2·atan(cos β · tan(h/2)), β being the angle between a segment and the axis (the
   * swing-twist split of a rotation). A carried frame takes the smallest rotation only, so
   * against the helix's own inward normal it falls behind by exactly α at every point.
   */
  it("a helix: the carried normal falls behind the inward normal by 2·atan(cos β · tan(h/2)) per point", () => {
    const h = 0.3;
    const pitch = 0.4;
    const points: Vec3[] = Array.from({ length: 24 }, (_, i) => [Math.cos(i * h), Math.sin(i * h), pitch * i * h] as Vec3);
    const frames = frameStrip(points, { closed: false, method: "minimiseTwist", up: [0, 0, 1] });
    const chord = Math.hypot(2 * Math.sin(h / 2), pitch * h);
    const alpha = 2 * Math.atan(((pitch * h) / chord) * Math.tan(h / 2));
    const lag = (i: number): number => {
      const inward: Vec3 = [-Math.cos(i * h), -Math.sin(i * h), 0];
      return Math.atan2(dot(cross(inward, frames.normal[i]!), frames.tangent[i]!), dot(inward, frames.normal[i]!));
    };
    for (let i = 1; i < 22; i += 1) {
      const step = lag(i + 1) - lag(i);
      expect(step - Math.round(step / (2 * Math.PI)) * 2 * Math.PI, `point ${i}`).toBeCloseTo(-alpha, 10);
    }
  });

  /**
   * A closed curve that leaves its plane comes back turned. The amount is the area its
   * segment directions enclose on the unit sphere (the holonomy of parallel transport),
   * turning the way the loop runs: counter-clockwise seen from outside for a loop that
   * runs counter-clockwise. For the four directions here — +X, +Y, +Z and −(1, 1, 1)/√3 —
   * that signed area is worked out below from two spherical triangles with the tan(E/2)
   * formula: an octant (π/2) and a triangle of 7π/6, 5π/3 in all, which is −π/3 as an angle.
   */
  it("a closed, non-planar polygon: the closing angle is the spherical area of its directions", () => {
    const corners: Vec3[] = [[0, 0, 0], [2, 0, 0], [2, 2, 0], [2, 2, 2]];
    const open = frameStrip(corners, { closed: true, method: "minimiseTwist", up: UP, closeTwist: false });
    const s = 1 / Math.sqrt(3);
    const directions: Vec3[] = [[1, 0, 0], [0, 1, 0], [0, 0, 1], [-s, -s, -s]];
    const triangle = (a: Vec3, b: Vec3, c: Vec3): number =>
      2 * Math.atan2(dot(a, cross(b, c)), 1 + dot(a, b) + dot(b, c) + dot(c, a));
    const area = triangle(directions[0]!, directions[1]!, directions[2]!) + triangle(directions[0]!, directions[2]!, directions[3]!);
    const wrapped = (angle: number): number => angle - Math.round(angle / (2 * Math.PI)) * 2 * Math.PI;
    expect(area).toBeCloseTo((5 * Math.PI) / 3, 10);
    expect(wrapped(open.closingAngle - area)).toBeCloseTo(0, 10);
    expect(open.closingAngle).toBeCloseTo(-Math.PI / 3, 10);

    // Spread along the strip, the frame after the lap is the frame it started with: the
    // correction at a point is the closing angle times its share of the length.
    const closed = frameStrip(corners, { closed: true, method: "minimiseTwist", up: UP });
    for (let i = 0; i < 4; i += 1) {
      const turned = Math.atan2(dot(cross(open.normal[i]!, closed.normal[i]!), open.tangent[i]!), dot(open.normal[i]!, closed.normal[i]!));
      expect(wrapped(turned + open.closingAngle * open.curveU[i]!), `corner ${i}`).toBeCloseTo(0, 10);
    }
  });
});

describe("frameStrip — seeds, roll, twist, padding, Fixed Up", () => {
  it("an orient seed whose +Z runs along the first segment is reproduced at the first point", () => {
    const frames = frameStrip(line(3, 1), { closed: false, method: "minimiseTwist", up: UP, seedOrient: [0.5, 0.5, 0.5, 0.5] });
    expect(frames.normal[0]).toEqual([0, 0, 1]);
    expect(frames.orient[0]).toEqual([0.5, 0.5, 0.5, 0.5]);
  });

  it("Roll 90° puts the normal where the binormal was; Twist 360° brings the last normal back", () => {
    const rolled = frameStrip(line(3, 1), { closed: false, method: "minimiseTwist", up: UP, roll: Math.PI / 2 });
    expectVec(rolled.normal[1]!, [0, 0, 1]);
    const twisted = frameStrip(line(5, 1), { closed: false, method: "minimiseTwist", up: UP, twist: 2 * Math.PI });
    expectVec(twisted.normal[0]!, [0, 1, 0]);
    expectVec(twisted.normal[1]!, [0, 0, 1]);
    expectVec(twisted.normal[2]!, [0, -1, 0]);
    expectVec(twisted.normal[4]!, [0, 1, 0]);
  });

  /**
   * §V788: padding repeats the nearest live point, a segment of no length is skipped, and
   * so the repeats take the frame and the distance of the point they repeat — at the tail
   * and at the HEAD, which is where a tentacle stows its slack.
   */
  it("padding takes its neighbour's frame and distance, and adds no length", () => {
    const bare = frameStrip([[0, 0, 0], [1, 0, 0], [1, 1, 0]], { closed: false, method: "minimiseTwist", up: UP });
    const padded = frameStrip(
      [[0, 0, 0], [0, 0, 0], [0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0], [1, 1, 0]],
      { closed: false, method: "minimiseTwist", up: UP },
    );
    expect(padded.curveLength).toBe(bare.curveLength);
    for (const head of [0, 1, 2]) {
      expect(padded.normal[head]).toEqual(bare.normal[0]);
      expect(padded.tangent[head]).toEqual(bare.tangent[0]);
      expect(padded.distance[head]).toBe(0);
    }
    expect(padded.tangent[3]).toEqual(bare.tangent[1]);
    for (const tail of [4, 5, 6, 7]) {
      expect(padded.normal[tail]).toEqual(bare.normal[2]);
      expect(padded.tangent[tail]).toEqual(bare.tangent[2]);
      expect(padded.distance[tail]).toBe(2);
      expect(padded.curveU[tail]).toBe(1);
    }
  });

  it("a strip of no length takes the seed's frame and zero metrics, with no NaN", () => {
    const frames = frameStrip([[3, 3, 3], [3, 3, 3], [3, 3, 3]], { closed: false, method: "minimiseTwist", up: UP });
    for (let i = 0; i < 3; i += 1) {
      expect(frames.orient[i]).toEqual([0, 0, 0, 1]);
      expect(frames.distance[i]).toBe(0);
      expect(frames.curveU[i]).toBe(0);
    }
    expect(frames.curveLength).toBe(0);
  });

  /**
   * Fixed Up where the tangent runs straight up: the point between two vertical segments
   * has no "up made square to the tangent", so it keeps the normal of the point before it.
   */
  it("Fixed Up through vertical keeps the previous normal, and every value is finite", () => {
    const points: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [1, 2, 0], [2, 2, 0]];
    const frames = frameStrip(points, { closed: false, method: "fixedUp", up: UP });
    const h = Math.SQRT1_2;
    expectVec(frames.normal[0]!, [0, 1, 0]);
    expectVec(frames.normal[1]!, [-h, h, 0]);
    expectVec(frames.tangent[2]!, [0, 1, 0]);
    expectVec(frames.normal[2]!, [-1, 0, 0]);
    expectVec(frames.normal[4]!, [0, 1, 0]);
    for (const q of frames.orient) for (const component of q) expect(Number.isFinite(component)).toBe(true);
  });
});

describe("stripLengths and resampleStations (T1586b section 3.3)", () => {
  const four = line(5, 1);

  it("lengths are the running sum, and a closed strip counts its closing segment", () => {
    expect(stripLengths(four, false)).toEqual({ cumulative: [0, 1, 2, 3, 4], total: 4 });
    const square: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    expect(stripLengths(square, true)).toEqual({ cumulative: [0, 1, 2, 3], total: 4 });
  });

  it("Distance 0.5 over a length of 4: nine live stations, the padding on the last one", () => {
    const result = resampleStrip(four, { closed: false, method: "distance", slots: 16, distance: 0.5 });
    expect(result.live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    expect(result.positions.map((p) => p[0])).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4, 4, 4, 4, 4, 4, 4]);
  });

  it("anchored at the End, the last slot is on the end and the padding collects at the head", () => {
    const result = resampleStrip(four, { closed: false, method: "distance", slots: 8, distance: 0.75, anchor: "end" });
    expect(result.live).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
    // Six stations step back from 4 by 0.75; the two padding slots repeat the first of them.
    expect(result.positions.map((p) => p[0])).toEqual([0.25, 0.25, 0.25, 1, 1.75, 2.5, 3.25, 4]);
  });

  it("over budget the spacing widens and the whole strip is still covered", () => {
    const result = resampleStrip(four, { closed: false, method: "distance", slots: 5, distance: 0.1 });
    expect(result.live).toEqual([1, 1, 1, 1, 1]);
    expect(result.positions.map((p) => p[0])).toEqual([0, 1, 2, 3, 4]);
  });

  it("Count: Even Length steps evenly in metres, Even Parameter evenly in the input's points", () => {
    const uneven: Vec3[] = [[0, 0, 0], [1, 0, 0], [4, 0, 0]];
    const byLength = resampleStrip(uneven, { closed: false, method: "count", spacing: "length", slots: 5 });
    expect(byLength.positions.map((p) => p[0])).toEqual([0, 1, 2, 3, 4]);
    const byParameter = resampleStrip(uneven, { closed: false, method: "count", spacing: "parameter", slots: 5 });
    expect(byParameter.positions.map((p) => p[0])).toEqual([0, 0.5, 1, 2.5, 4]);
  });

  it("a closed unit square at Distance 0.5: eight stations, on the corners and the edge midpoints", () => {
    const square: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const result = resampleStrip(square, { closed: true, method: "distance", slots: 12, distance: 0.5 });
    expect(result.live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
    expect(result.positions.slice(0, 8)).toEqual([
      [0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1, 0.5, 0], [1, 1, 0], [0.5, 1, 0], [0, 1, 0], [0, 0.5, 0],
    ]);
    // The padding repeats the last live station, so the closing segment runs from it to slot 0.
    expect(result.positions[11]).toEqual([0, 0.5, 0]);
  });

  it("a range trims, an offset slides, and a count of one sits on the range's start", () => {
    const ranged = resampleStrip(four, { closed: false, method: "count", spacing: "length", slots: 3, rangeStart: 0.25, rangeEnd: 0.75 });
    expect(ranged.positions.map((p) => p[0])).toEqual([1, 2, 3]);
    const slid = resampleStrip(four, { closed: false, method: "distance", slots: 16, distance: 0.5, offset: 0.25 });
    expect(slid.positions.slice(0, 8).map((p) => p[0])).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]);
    expect(slid.live.slice(0, 9)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0]);
    const tip = resampleStations(stripLengths(four, false), { closed: false, method: "count", spacing: "length", slots: 1, rangeStart: 1, rangeEnd: 1 });
    expect(tip).toEqual([{ live: true, index: 4, next: 4, t: 0 }]);
  });

  it("padding in the INPUT is passed over: a padded strip resamples like the bare one", () => {
    const padded: Vec3[] = [[0, 0, 0], [0, 0, 0], [1, 0, 0], [4, 0, 0], [4, 0, 0], [4, 0, 0]];
    const result = resampleStrip(padded, { closed: false, method: "count", spacing: "length", slots: 5 });
    expect(result.positions.map((p) => p[0])).toEqual([0, 1, 2, 3, 4]);
  });
});

/**
 * T1586b slice 2 — the Curve reference. Every expectation is a textbook value of the
 * basis at a parameter where it is a short sum (a span's start, its middle), or a point on
 * a circle whose centre and radius the fixture fixes.
 */
describe("evaluateCurve — spans, counts and stations", () => {
  it("an open strip of N control points has N − 1 spans, a closed one N; an unclamped B-Spline two fewer", () => {
    expect(curveSpans(5, { closed: false, basis: "catmullRom" })).toBe(4);
    expect(curveSpans(5, { closed: true, basis: "catmullRom" })).toBe(5);
    expect(curveSpans(5, { closed: false, basis: "bspline", clamped: false })).toBe(2);
    // Clamped is the default, and a closed strip has no ends to stop short of.
    expect(curveSpans(5, { closed: false, basis: "bspline" })).toBe(4);
    expect(curveSpans(5, { closed: true, basis: "bspline", clamped: false })).toBe(5);
    expect(curveSpans(1, { closed: true, basis: "linear" })).toBe(0);
    expect(curvePointCount(5, { closed: false, basis: "linear", segments: 4 })).toBe(17);
    expect(curvePointCount(5, { closed: true, basis: "linear", segments: 4 })).toBe(20);
    expect(curvePointCount(1, { closed: false, basis: "linear", segments: 4 })).toBe(1);
  });

  it("the last point of an open strip is the END of the last span, between the last two control points", () => {
    const stations = curveStations(3, { closed: false, basis: "linear", segments: 2 });
    expect(stations).toEqual([
      { span: 0, u: 0, index: 0, next: 1 },
      { span: 0, u: 0.5, index: 0, next: 1 },
      { span: 1, u: 0, index: 1, next: 2 },
      { span: 1, u: 0.5, index: 1, next: 2 },
      { span: 1, u: 1, index: 1, next: 2 },
    ]);
    // A closed strip's last span runs back to control point 0.
    expect(curveStations(3, { closed: true, basis: "linear", segments: 1 }).at(-1)).toEqual({ span: 2, u: 0, index: 2, next: 0 });
    // An unclamped B-Spline's span s blends attributes between control points s + 1 and s + 2.
    expect(curveStations(4, { closed: false, basis: "bspline", clamped: false, segments: 1 })).toEqual([
      { span: 0, u: 0, index: 1, next: 2 },
      { span: 0, u: 1, index: 1, next: 2 },
    ]);
  });
});

describe("evaluateCurve — the bases, at values a person can work out", () => {
  const x = (points: ReadonlyArray<Vec3>): number[] => points.map((point) => point[0]);

  it("Linear keeps the chords: (0,0,0) to (4,0,0) in four segments is 0, 1, 2, 3, 4", () => {
    expect(x(evaluateCurve([[0, 0, 0], [4, 0, 0]], { closed: false, basis: "linear", segments: 4 }))).toEqual([0, 1, 2, 3, 4]);
    const bent = evaluateCurve([[0, 0, 0], [2, 0, 0], [2, 4, 0]], { closed: false, basis: "linear", segments: 2 });
    expect(bent).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 2, 0], [2, 4, 0]]);
  });

  /**
   * Evenly spaced control points on a line are the case where every interpolating basis
   * must agree with the line itself, and written "point + share × difference" they do so
   * EXACTLY: the differences of differences are zero, not rounding noise.
   */
  it("Catmull-Rom and Cardinal give exactly the line through collinear, evenly spaced control points", () => {
    const controls: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
    const expected = Array.from({ length: 13 }, (_, k) => k / 4);
    expect(x(evaluateCurve(controls, { closed: false, basis: "catmullRom", segments: 4 }))).toEqual(expected);
    expect(x(evaluateCurve(controls, { closed: false, basis: "cardinal", segments: 4 }))).toEqual(expected);
  });

  /**
   * The corners of a unit square, closed: every knot gap is the same, so centripetal
   * Catmull-Rom is the uniform one and the middle of the span from (0,0) to (1,0) is
   * (−P0 + 9·P1 + 9·P2 − P3) ÷ 16 = (0.5, −0.125). Cardinal scales the bulge by 1 − tension.
   */
  it("on a unit square the middle of a span bulges out by an eighth, and Tension flattens it", () => {
    const square: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const middle = (options: Parameters<typeof evaluateCurve>[1]): Vec3 => evaluateCurve(square, options)[1] as Vec3;
    expectVec(middle({ closed: true, basis: "catmullRom", segments: 2 }), [0.5, -0.125, 0]);
    expectVec(middle({ closed: true, basis: "cardinal", segments: 2, tension: 0 }), [0.5, -0.125, 0]);
    expectVec(middle({ closed: true, basis: "cardinal", segments: 2, tension: 0.5 }), [0.5, -0.0625, 0]);
    expectVec(middle({ closed: true, basis: "cardinal", segments: 2, tension: 1 }), [0.5, 0, 0]);
  });

  /**
   * WHICH Catmull-Rom it is, pinned by a value only the centripetal one takes. Control
   * points on a line at 0, 1, 5 and 14 are 1, 4 and 9 apart, so their centripetal knot gaps
   * (the square roots) are 1, 2 and 3. The middle of the span from 1 to 5, by Barry and
   * Goldman's pyramid: A = 2, 3, 2; B = 8/3, 14/5; C = 8/3 + ½·(14/5 − 8/3) = 41/15.
   * Uniform knots would give (−0 + 9 + 45 − 14) ÷ 16 = 2.5, and chordal ones 3.
   */
  it("Catmull-Rom is centripetal: unevenly spaced control points put a span's middle at 41/15, not 2.5 or 3", () => {
    const controls: Vec3[] = [[0, 0, 0], [1, 0, 0], [5, 0, 0], [14, 0, 0]];
    const curve = evaluateCurve(controls, { closed: false, basis: "catmullRom", segments: 2 });
    expect((curve[3] as Vec3)[0]).toBeCloseTo(41 / 15, 12);
    // Cardinal is the uniform spline: the same control points give the uniform value.
    const uniform = evaluateCurve(controls, { closed: false, basis: "cardinal", segments: 2 });
    expect((uniform[3] as Vec3)[0]).toBeCloseTo(2.5, 12);
  });

  it("the interpolating bases return every control point to the bit, however unevenly they are spaced", () => {
    const controls: Vec3[] = [[0.1, 0.2, 0.3], [1.7, -0.4, 0.9], [1.9, 2.3, -1.1], [-3.3, 0.7, 0.01], [0.4, 0.4, 5.5]];
    for (const basis of ["linear", "catmullRom", "cardinal", "arc"] as const) {
      const curve = evaluateCurve(controls, { closed: false, basis, segments: 3, arcLength: 9 });
      // An arc that is in reach ends ON its control point only to rounding; its start is exact.
      const last = basis === "arc" ? 4 : 5;
      for (let i = 0; i < last; i += 1) expect(curve[i * 3], `${basis} control ${i}`).toEqual(controls[i]);
    }
  });

  /**
   * A uniform cubic B-Spline at a knot is (P0 + 4·P1 + P2) ÷ 6: for (0,0), (6,0), (6,6)
   * that is (5, 1). Clamped, the ends are mirrored, so the same sum at the first control
   * point is (−P1 + 2·P0 … ) = P0 itself: the curve reaches both ends.
   */
  it("a B-Spline passes (P0 + 4·P1 + P2) ÷ 6 at a knot, and reaches its ends when clamped", () => {
    const controls: Vec3[] = [[0, 0, 0], [6, 0, 0], [6, 6, 0]];
    const clamped = evaluateCurve(controls, { closed: false, basis: "bspline", segments: 2 });
    expect(clamped[0]).toEqual([0, 0, 0]);
    expect(clamped[2]).toEqual([5, 1, 0]);
    expect(clamped[4]).toEqual([6, 6, 0]);
    // Unclamped it is the plain spline: four control points make one span, from one knot value to the next.
    const four: Vec3[] = [[0, 0, 0], [6, 0, 0], [6, 6, 0], [0, 6, 0]];
    const plain = evaluateCurve(four, { closed: false, basis: "bspline", clamped: false, segments: 2 });
    expect(plain).toHaveLength(3);
    expect(plain[0]).toEqual([5, 1, 0]);
    expect(plain[2]).toEqual([5, 5, 0]);
  });

  it("a Bezier span's middle is (P1 + 3·(P1 + out) + 3·(P2 + in) + P2) ÷ 8", () => {
    const controls: Vec3[] = [[0, 0, 0], [8, 0, 0]];
    const curve = evaluateCurve(controls, {
      closed: false,
      basis: "bezier",
      segments: 2,
      handlesOut: [[0, 8, 0], [0, 0, 0]],
      handlesIn: [[0, 0, 0], [0, 8, 0]],
    });
    // (0 + 3·(0,8) + 3·(8,8) + (8,0)) ÷ 8 = (4, 6).
    expect(curve).toEqual([[0, 0, 0], [4, 6, 0], [8, 0, 0]]);
  });
});

describe("solveArc — the one arc of a given length through two points", () => {
  /**
   * A chord of 2 and a length of π is a half circle of radius 1, because sinc(π/2) = 2/π.
   * With the bow on +Y the arc is the upper half of the unit circle about the origin, run
   * from (−1, 0) to (1, 0): station k of n sits at the angle π − kπ/n.
   */
  it("length π over a chord of 2 is a half circle of radius 1, on the bow's side", () => {
    const arc = solveArc([-1, 0, 0], [1, 0, 0], Math.PI, [0, 1, 0]);
    expect(arc.length).toBe(Math.PI);
    expect(arc.halfTurn).toBeCloseTo(Math.PI / 2, 6);
    expect(arc.curvature).toBeCloseTo(1, 6);
    const curve = evaluateCurve([[-1, 0, 0], [1, 0, 0]], { closed: false, basis: "arc", segments: 8, arcLength: Math.PI, bow: [0, 1, 0] });
    curve.forEach((point, k) => {
      const angle = Math.PI - (k * Math.PI) / 8;
      expectVec(point, [Math.cos(angle), Math.sin(angle), 0], 6);
    });
    // THE LENGTH IS KEPT: the arc ends on its far control point having run exactly π.
    expectVec(arcPoint(arc, arc.length), [1, 0, 0], 6);
  });

  it("the bow picks the side: the opposite bow is the same arc mirrored through the chord", () => {
    const options = { closed: false, basis: "arc", segments: 6, arcLength: 3 } as const;
    const up = evaluateCurve([[0, 0, 0], [2, 0, 0]], { ...options, bow: [0, 1, 0] });
    const down = evaluateCurve([[0, 0, 0], [2, 0, 0]], { ...options, bow: [0, -1, 0] });
    up.forEach((point, k) => expectVec(down[k] as Vec3, [point[0], -point[1], point[2]]));
    expect((up[3] as Vec3)[1]).toBeGreaterThan(0.9);
    // Only the part of the bow SQUARE to the chord counts: a bow leaning along it changes nothing.
    const leaning = evaluateCurve([[0, 0, 0], [2, 0, 0]], { ...options, bow: [5, 0.1, 0] });
    up.forEach((point, k) => expectVec(leaning[k] as Vec3, point));
  });

  it("taut, the stations are exactly k × chord ÷ segments; out of reach, the line keeps its length and stops short", () => {
    const taut = evaluateCurve([[0, 0, 0], [4, 0, 0]], { closed: false, basis: "arc", segments: 4, arcLength: 4, bow: [0, 1, 0] });
    expect(taut).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
    const short = evaluateCurve([[0, 0, 0], [4, 0, 0]], { closed: false, basis: "arc", segments: 4, arcLength: 2, bow: [0, 1, 0] });
    expect(short).toEqual([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1.5, 0, 0], [2, 0, 0]]);
  });

  /**
   * Max Turn caps the bow. A chord of 2 with 10 metres asked for and at most a half turn
   * is the half circle again — π metres laid out, the rest not deployed — and the arc
   * still ends on its far point.
   */
  it("Max Turn leaves slack undeployed: 10 metres asked, a half turn allowed, π laid out", () => {
    const arc = solveArc([-1, 0, 0], [1, 0, 0], 10, [0, 1, 0], Math.PI);
    expect(arc.length).toBeCloseTo(Math.PI, 12);
    expectVec(arcPoint(arc, arc.length * 0.5), [0, 1, 0], 6);
    expectVec(arcPoint(arc, arc.length), [1, 0, 0], 6);
    // No turn allowed is a straight line of the chord's length.
    expect(solveArc([-1, 0, 0], [1, 0, 0], 10, [0, 1, 0], 0).length).toBe(2);
  });

  it("in chords, the length follows the span: 1.5 chords over a chord of 2 is 3 metres", () => {
    const metres = evaluateCurve([[0, 0, 0], [2, 0, 0]], { closed: false, basis: "arc", segments: 4, arcLength: 3, bow: [0, 1, 0] });
    const chords = evaluateCurve([[0, 0, 0], [2, 0, 0]], { closed: false, basis: "arc", segments: 4, arcLength: 1.5, arcLengthUnit: "chords", bow: [0, 1, 0] });
    expect(chords).toEqual(metres);
  });

  it("with no chord it is a circle through the point, of the length asked for", () => {
    const arc = solveArc([2, 3, 4], [2, 3, 4], 2 * Math.PI, [0, 1, 0]);
    expect(arc.halfTurn).toBeCloseTo(Math.PI, 6);
    // Circumference 2π is radius 1: the far side of the circle is two radii away, on the bow's side.
    expectVec(arcPoint(arc, Math.PI), [2, 5, 4], 5);
    expectVec(arcPoint(arc, 2 * Math.PI), [2, 3, 4], 5);
  });
});

describe("parseCurveTable — a Curve node's own control points", () => {
  it("reads [x, y, z], with an optional scale and roll", () => {
    expect(parseCurveTable("[[0, 0, 0], [1, 2, 3, 0.5], [4, 5, 6, 2, 90]]")).toEqual({
      points: [
        { position: [0, 0, 0], scale: 1, roll: 0 },
        { position: [1, 2, 3], scale: 0.5, roll: 0 },
        { position: [4, 5, 6], scale: 2, roll: 90 },
      ],
    });
  });

  it("refuses what it cannot read, naming the entry — and a table over the limit, never truncating it", () => {
    const errorOf = (raw: unknown): string => {
      const result = parseCurveTable(raw);
      return "error" in result ? result.error : "";
    };
    expect(errorOf("[[0, 0, 0], [1, 2]]")).toContain("control point 1");
    expect(errorOf('[[0, 0, 0], [1, 2, "three"]]')).toContain("control point 1");
    expect(errorOf("[[0, 0")).toContain("not valid JSON");
    expect(errorOf("{}")).toContain("must be a JSON list");
    expect(errorOf("")).toContain("empty");
    const many = JSON.stringify(Array.from({ length: CURVE_TABLE_LIMIT + 1 }, (_, i) => [i, 0, 0]));
    expect(errorOf(many)).toContain(`${CURVE_TABLE_LIMIT + 1} control points`);
    expect(errorOf(many)).toContain("wire a longer control set");
    const full = parseCurveTable(JSON.stringify(Array.from({ length: CURVE_TABLE_LIMIT }, (_, i) => [i, 0, 0])));
    expect("points" in full && full.points.length).toBe(CURVE_TABLE_LIMIT);
  });
});
