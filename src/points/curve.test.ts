import { describe, expect, it } from "vitest";

import {
  CURVE_TABLE_LIMIT,
  arcChainSections,
  arcPoint,
  curvePointCount,
  curveSpans,
  curveStations,
  endTangent,
  evaluateCurve,
  frameStrip,
  parseCurveTable,
  quatFromFrame,
  resampleDensity,
  resampleStations,
  resampleStrip,
  resampleTurnPerPoint,
  rotateByQuat,
  solveArc,
  stripDensity,
  stripLengths,
  type Vec2,
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

/**
 * T1587b C13 — Extrapolate Ends: an open strip's ends aimed by their two nearest segments.
 * By hand: a right angle, a parabola sampled where its slope is known, a circle's closed
 * form. And the property the GPU pass is built to keep: nothing but the two end runs moves.
 */
describe("endTangent and Extrapolate Ends (T1587b C13)", () => {
  const unit = (v: Vec3): Vec3 => {
    const size = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / size, v[1] / size, v[2] / size];
  };

  it("equal segments: one and a half of the end's own direction less half of the next", () => {
    expectVec(endTangent([1, 0, 0], [0, 1, 0]) as Vec3, unit([1.5, -0.5, 0]));
    // It is a direction: the segments' common length does not matter.
    expectVec(endTangent([3, 0, 0], [0, 3, 0]) as Vec3, unit([1.5, -0.5, 0]));
  });

  it("unequal segments: the end's own leg h and the next one g give d + (d − e) × h ÷ (h + g)", () => {
    // h = 2, g = 1: (1,0,0) + ((1,0,0) − (0,1,0)) × ⅔ = (5, −2, 0) ÷ 3.
    expectVec(endTangent([2, 0, 0], [0, 1, 0]) as Vec3, unit([5, -2, 0]));
    // h = 1, g = 2: (4, −1, 0) ÷ 3.
    expectVec(endTangent([1, 0, 0], [0, 2, 0]) as Vec3, unit([4, -1, 0]));
  });

  it("is the one-sided difference (−3 p0 + 4 p1 − p2) ÷ 2h where the spacing is even", () => {
    const p0: Vec3 = [0.5, -1, 2];
    const p1: Vec3 = [1.25, -0.5, 2.75];
    // The same distance on from p1 as p1 is from p0, in another direction.
    const step = Math.hypot(0.75, 0.5, 0.75);
    const p2: Vec3 = [p1[0] + step * 0.6, p1[1], p1[2] + step * 0.8];
    const near: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const far: Vec3 = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]];
    const stencil = unit([-3 * p0[0] + 4 * p1[0] - p2[0], -3 * p0[1] + 4 * p1[1] - p2[1], -3 * p0[2] + 4 * p1[2] - p2[2]]);
    expectVec(endTangent(near, far) as Vec3, stencil);
  });

  it("is the slope, at the end, of the parabola through the three points a chord apart", () => {
    /* The rule's own statement, worked the long way: put the three points at 0, h and h + g
       along a parameter (h and g the two chords' lengths), take the quadratic through them,
       and differentiate it at 0. */
    const p0: Vec3 = [0, 0, 0];
    const p1: Vec3 = [1, 1, 0];
    const p2: Vec3 = [3, 9, 0];
    const h = Math.hypot(1, 1);
    const g = Math.hypot(2, 8);
    // Lagrange through (0, p0), (h, p1), (h + g, p2), differentiated at 0.
    const slope = (axis: number): number => (-(2 * h + g) / (h * (h + g))) * p0[axis]! + ((h + g) / (h * g)) * p1[axis]! - (h / (g * (h + g))) * p2[axis]!;
    expectVec(endTangent([1, 1, 0], [2, 8, 0]) as Vec3, unit([slope(0), slope(1), slope(2)]));
  });

  it("on a circle of equal chords it is off the circle's own tangent by atan2(1.5 sin a − 0.5 sin 3a, 1.5 cos a − 0.5 cos 3a)", () => {
    for (const turn of [0.4, 0.1, 0.02]) {
      const at = (angle: number): Vec3 => [Math.sin(angle), 1 - Math.cos(angle), 0];
      const [p0, p1, p2] = [at(0), at(turn), at(2 * turn)];
      const tangent = endTangent([p1[0] - p0[0], p1[1] - p0[1], 0], [p2[0] - p1[0], p2[1] - p1[1], 0]) as Vec3;
      const a = turn / 2;
      const residue = Math.atan2(1.5 * Math.sin(a) - 0.5 * Math.sin(3 * a), 1.5 * Math.cos(a) - 0.5 * Math.cos(3 * a));
      // The circle leaves along +X; the chord is a further round, the extrapolation about 2a³.
      expect(Math.atan2(tangent[1], tangent[0])).toBeCloseTo(residue, 12);
      expect(residue).toBeGreaterThan(0);
      expect(residue).toBeLessThan(2.2 * a ** 3);
    }
  });

  it("two segments that run the same way have nothing to extrapolate; a reversal is still a direction", () => {
    expect(endTangent([0.5, 0, 0], [2, 0, 0])).toBeUndefined();
    expect(endTangent([1, 2, 2], [2, 4, 4])).toBeUndefined();
    // Straight back on itself: (1,0,0) + 2 × (1,0,0) × ½ = twice the end's own direction.
    expectVec(endTangent([1, 0, 0], [-1, 0, 0]) as Vec3, [1, 0, 0]);
  });

  const BENT: Vec3[] = [[0, 0, 0], [1, 0.25, 0], [1.5, 1, 0.5], [1, 2, 1.5], [0, 2.5, 1], [-1, 2, 0]];
  const segment = (points: ReadonlyArray<Vec3>, k: number): Vec3 => [points[k + 1]![0] - points[k]![0], points[k + 1]![1] - points[k]![1], points[k + 1]![2] - points[k]![2]];

  it("re-aims the two ends and leaves every other value exactly as the walk wrote it", () => {
    for (const method of ["minimiseTwist", "fixedUp"] as const) {
      const options = { closed: false, method, up: [0.2, 1, -0.3] as Vec3, roll: 0.3, twist: 1.1 };
      const off = frameStrip(BENT, options);
      const on = frameStrip(BENT, { ...options, extrapolateEnds: true });
      // The ends' tangents are the rule's.
      expectVec(on.tangent[0]!, endTangent(segment(BENT, 0), segment(BENT, 1)) as Vec3);
      expectVec(on.tangent[5]!, endTangent(segment(BENT, 4), segment(BENT, 3)) as Vec3);
      for (let i = 1; i < 5; i += 1) {
        expect(on.tangent[i], `${method} tangent ${i}`).toEqual(off.tangent[i]);
        expect(on.normal[i], `${method} normal ${i}`).toEqual(off.normal[i]);
        expect(on.binormal[i], `${method} binormal ${i}`).toEqual(off.binormal[i]);
        expect(on.orient[i], `${method} orient ${i}`).toEqual(off.orient[i]);
      }
      // No metric moves, at an end or anywhere.
      expect(on.distance).toEqual(off.distance);
      expect(on.curveU).toEqual(off.curveU);
      expect(on.curvature).toEqual(off.curvature);
      expect(on.curveLength).toBe(off.curveLength);
      // And an end's frame is still a frame: square, unit, right-handed, orient saying the same.
      for (const i of [0, 5]) {
        expect(dot(on.tangent[i]!, on.normal[i]!)).toBeCloseTo(0, 12);
        expect(dot(on.normal[i]!, on.normal[i]!)).toBeCloseTo(1, 12);
        expectVec(on.binormal[i]!, cross(on.tangent[i]!, on.normal[i]!));
        expectVec(rotateByQuat(on.orient[i]!, [0, 0, 1]), on.tangent[i]!);
        expectVec(rotateByQuat(on.orient[i]!, [0, 1, 0]), on.normal[i]!);
      }
    }
  });

  it("Minimise Twist: a planar curve's ends keep the plane's normal, and a roll comes with the frame", () => {
    // A right angle in the XY plane, Up out of it: every turn is about Z, the ends' too.
    const corner: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0]];
    const flat = frameStrip(corner, { closed: false, method: "minimiseTwist", up: [0, 0, 1], extrapolateEnds: true });
    for (const i of [0, 1, 2]) expectVec(flat.normal[i]!, [0, 0, 1]);
    expectVec(flat.tangent[0]!, unit([1.5, -0.5, 0]));
    expectVec(flat.tangent[2]!, unit([-0.5, 1.5, 0]));
    // Rolled a quarter turn the normal is where the binormal was: tangent × Z, at each end's own tangent.
    const rolled = frameStrip(corner, { closed: false, method: "minimiseTwist", up: [0, 0, 1], roll: Math.PI / 2, extrapolateEnds: true });
    expectVec(rolled.normal[0]!, cross(flat.tangent[0]!, [0, 0, 1]));
    expectVec(rolled.normal[2]!, cross(flat.tangent[2]!, [0, 0, 1]));
  });

  it("Fixed Up: an end's normal is Up made square to its NEW tangent, at the angle the walk left it", () => {
    const climb: Vec3[] = [[0, 0, 0], [1, 0.5, 0], [1.5, 1.25, 0.75], [1.25, 2.25, 1.5], [0.5, 2.75, 2.5]];
    const up: Vec3 = [0, 1, 0];
    const leaning = (tangent: Vec3): Vec3 => unit([up[0] - tangent[0] * tangent[1], up[1] - tangent[1] * tangent[1], up[2] - tangent[2] * tangent[1]]);
    const plain = frameStrip(climb, { closed: false, method: "fixedUp", up, extrapolateEnds: true });
    for (const i of [0, 4]) expectVec(plain.normal[i]!, leaning(plain.tangent[i]!));
    // A quarter turn of roll puts the normal on tangent × that.
    const rolled = frameStrip(climb, { closed: false, method: "fixedUp", up, roll: Math.PI / 2, extrapolateEnds: true });
    for (const i of [0, 4]) expectVec(rolled.normal[i]!, cross(rolled.tangent[i]!, leaning(rolled.tangent[i]!)));
  });

  it("Fixed Up: an end that runs along Up keeps its chord's frame; the other end is aimed", () => {
    const mast: Vec3[] = [[0, 0, 0], [0, 1, 0], [0.5, 2, 0], [1.5, 2.5, 0.5], [2.5, 2.5, 1.5]];
    const options = { closed: false, method: "fixedUp", up: [0, 1, 0] as Vec3 } as const;
    const off = frameStrip(mast, options);
    const on = frameStrip(mast, { ...options, extrapolateEnds: true });
    expect(on.tangent[0]).toEqual(off.tangent[0]);
    expect(on.normal[0]).toEqual(off.normal[0]);
    expect(on.orient[0]).toEqual(off.orient[0]);
    expect(on.tangent[4]).not.toEqual(off.tangent[4]);
  });

  it("the ends are RUNS: repeats of the start and of the end take the end's new frame, all of them", () => {
    const padded: Vec3[] = [BENT[0]!, BENT[0]!, BENT[0]!, ...BENT, BENT[5]!, BENT[5]!];
    const bare = frameStrip(BENT, { closed: false, method: "minimiseTwist", up: [0, 1, 0], extrapolateEnds: true });
    const run = frameStrip(padded, { closed: false, method: "minimiseTwist", up: [0, 1, 0], extrapolateEnds: true });
    for (const slot of [0, 1, 2, 3]) {
      expect(run.tangent[slot], `head ${slot}`).toEqual(bare.tangent[0]);
      expect(run.orient[slot], `head ${slot}`).toEqual(bare.orient[0]);
    }
    for (const slot of [8, 9, 10]) {
      expect(run.tangent[slot], `tail ${slot}`).toEqual(bare.tangent[5]);
      expect(run.orient[slot], `tail ${slot}`).toEqual(bare.orient[5]);
    }
    // A point's roll is its own, so within a run the frames differ by exactly their rolls.
    const banked = frameStrip(padded, { closed: false, method: "minimiseTwist", up: [0, 1, 0], rollPerPoint: padded.map((_, slot) => slot * 0.1), extrapolateEnds: true });
    for (const slot of [0, 1, 2, 3]) {
      expect(banked.tangent[slot]).toEqual(bare.tangent[0]);
      const angle = Math.atan2(dot(cross(bare.normal[0]!, banked.normal[slot]!), bare.tangent[0]!), dot(bare.normal[0]!, banked.normal[slot]!));
      expect(angle, `the roll at slot ${slot}`).toBeCloseTo(slot * 0.1, 12);
    }
  });

  it("fewer than two segments with a length keep the chord; a closed strip has no ends", () => {
    const pair: Vec3[] = [[0, 0, 0], [1, 2, 2]];
    expect(frameStrip(pair, { closed: false, method: "minimiseTwist", up: [0, 1, 0], extrapolateEnds: true })).toEqual(
      frameStrip(pair, { closed: false, method: "minimiseTwist", up: [0, 1, 0] }),
    );
    const one: Vec3[] = [[0, 0, 0], [0, 0, 0], [1, 2, 2], [1, 2, 2], [1, 2, 2]];
    expect(frameStrip(one, { closed: false, method: "fixedUp", up: [0, 1, 0], extrapolateEnds: true })).toEqual(frameStrip(one, { closed: false, method: "fixedUp", up: [0, 1, 0] }));
    expect(frameStrip(BENT, { closed: true, method: "minimiseTwist", up: [0, 1, 0], extrapolateEnds: true })).toEqual(
      frameStrip(BENT, { closed: true, method: "minimiseTwist", up: [0, 1, 0] }),
    );
  });

  it("a straight end is exact: collinear first points leave the first frame untouched", () => {
    const hook: Vec3[] = [[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1.5, 0.5, 0], [1.5, 1, 0.5]];
    const off = frameStrip(hook, { closed: false, method: "minimiseTwist", up: [0, 1, 0] });
    const on = frameStrip(hook, { closed: false, method: "minimiseTwist", up: [0, 1, 0], extrapolateEnds: true });
    expect(on.tangent[0]).toEqual([1, 0, 0]);
    expect(on.orient[0]).toEqual(off.orient[0]);
    expect(on.tangent[4]).not.toEqual(off.tangent[4]);
  });

  it("the blocked walk's ends are the whole walk's: the rule does not know about blocks", () => {
    const long: Vec3[] = Array.from({ length: 23 }, (_, i) => {
      const t = Math.min(Math.max(i, 3), 18) * 0.31;
      return [Math.cos(t) * (1 + 0.3 * Math.sin(t * 2.7)), Math.sin(t * 1.3), Math.sin(t * 0.7) + t * 0.1] as Vec3;
    });
    for (const method of ["minimiseTwist", "fixedUp"] as const) {
      const options = { closed: false, method, up: [0.2, 1, -0.3] as Vec3, twist: 0.8, extrapolateEnds: true };
      const whole = frameStrip(long, options);
      const blocked = frameStrip(long, options, 4);
      // The first run is slots 0 to 3, the last 18 to 22: whole blocks of padding either side.
      for (const slot of [0, 1, 2, 3, 18, 19, 20, 21, 22]) {
        expectVec(blocked.tangent[slot]!, whole.tangent[slot]!, 10);
        expectVec(blocked.normal[slot]!, whole.normal[slot]!, 10);
      }
      expect(whole.tangent[0]).toEqual(whole.tangent[3]);
      expect(whole.tangent[18]).toEqual(whole.tangent[22]);
      expect(whole.tangent[0]).not.toEqual(frameStrip(long, { ...options, extrapolateEnds: false }).tangent[0]);
    }
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
 * T1586b slice 7 — RESAMPLE BY CURVATURE: Distance over another measure.
 *
 * A strip is measured in POINTS: so many a metre at each point (one per `turn` of
 * curvature, between the two limits), running straight from one point's density to the
 * next's. A station every 1 of that measure is the whole method. So every expectation here
 * is arithmetic on a line with a curvature WRITTEN ON IT — the curvature is an attribute
 * the method reads, never something it works out, and a test may set it to anything.
 */
describe("Resample by Curvature — a station every point's worth of curve (T1586b slice 7)", () => {
  const four = line(5, 1);
  const shape = { minDistance: 0.125, maxDistance: 0.5, bias: 0.5 };
  const byCurvature = { closed: false, method: "curvature", ...shape } as const;
  const SHARP = 1000;

  it("the Bias is the turn one step may carry: a radian at 0, a tenth at a half, a hundredth at 1", () => {
    expect(resampleTurnPerPoint(0)).toBe(1);
    expect(resampleTurnPerPoint(0.5)).toBeCloseTo(0.1, 15);
    expect(resampleTurnPerPoint(1)).toBeCloseTo(0.01, 15);
    expect(resampleTurnPerPoint(-3)).toBe(1);
    expect(resampleTurnPerPoint(7)).toBeCloseTo(0.01, 15);
  });

  it("the density is a point per turn, never sparser than the Max Distance nor denser than the Min", () => {
    // A straight has no curvature: a point every Max Distance.
    expect(resampleDensity(0, shape)).toBe(2);
    // Curvature 0.5 (a circle of radius 2) at a tenth of a radian a point: a point every 0.2 m.
    expect(resampleDensity(0.5, shape)).toBeCloseTo(5, 12);
    // Turning too hard for the Min: the Min wins.
    expect(resampleDensity(SHARP, shape)).toBe(8);
    expect(resampleDensity(-4, shape)).toBe(2);
    // A Min above the Max is the Max: there is one spacing left.
    expect(resampleDensity(SHARP, { minDistance: 2, maxDistance: 0.5, bias: 0.5 })).toBe(2);
  });

  it("a straight is a point every Max Distance, and a strip that turns hard everywhere a point every Min", () => {
    const straight = resampleStrip(four, { ...byCurvature, slots: 16, curvature: [0, 0, 0, 0, 0] });
    // Exactly what Distance gives at that spacing: the method IS Distance, over another measure.
    expect(straight).toEqual(resampleStrip(four, { closed: false, method: "distance", slots: 16, distance: 0.5 }));
    const tight = resampleStrip(four, { ...byCurvature, slots: 40, curvature: [SHARP, SHARP, SHARP, SHARP, SHARP] });
    expect(tight.positions.slice(0, 33).map((p) => p[0])).toEqual(Array.from({ length: 33 }, (_, k) => k * 0.125));
    expect(tight.live).toEqual(Array.from({ length: 40 }, (_, k) => (k < 33 ? 1 : 0)));
  });

  /**
   * Straight for a metre, then one segment in which the density climbs from 2 a metre to
   * 8, then hard-turning to the end. In points the five input points sit at 0, 2, 7, 15 and
   * 23: the climbing segment is worth 1 × (2 + 8) ÷ 2 = 5. A station s points into it is t
   * of the way along where 2t + 3t² = s, so t = 2s ÷ (2 + √(4 + 12s)): a third of the way
   * for the first, and exactly the far end for the fifth.
   */
  it("where the density climbs along a segment, the stations close up along it by the quadratic's root", () => {
    const curvature = [0, 0, SHARP, SHARP, SHARP];
    const measure = stripDensity(four, false, curvature, shape);
    expect(measure.density).toEqual([2, 2, 8, 8, 8]);
    expect(measure.cumulative).toEqual([0, 2, 7, 15, 23]);
    expect(measure.total).toBe(23);
    const out = resampleStrip(four, { ...byCurvature, slots: 32, curvature });
    const x = out.positions.map((p) => p[0]);
    expect(out.live).toEqual(Array.from({ length: 32 }, (_, k) => (k < 24 ? 1 : 0)));
    expect(x.slice(0, 3)).toEqual([0, 0.5, 1]);
    for (const s of [1, 2, 3, 4]) expect(x[2 + s], `station ${s} of the climb`).toBeCloseTo(1 + (2 * s) / (2 + Math.sqrt(4 + 12 * s)), 12);
    expect(x[3]).toBeCloseTo(1 + 1 / 3, 12);
    expect(x[7]).toBe(2);
    // And from there a point every eighth of a metre to the end.
    expect(x.slice(7, 24)).toEqual(Array.from({ length: 17 }, (_, k) => 2 + k * 0.125));
    for (const padding of x.slice(24)) expect(padding).toBe(4);
  });

  /**
   * The Range is a share of the strip's LENGTH and the Offset is metres, as for every other
   * method — not a share of its points. Half way along this strip is x = 2; half its points
   * are spent by x = 2.56.
   */
  it("the Range is a share of the length and the Offset is metres, whatever the density", () => {
    const curvature = [0, 0, SHARP, SHARP, SHARP];
    const half = resampleStrip(four, { ...byCurvature, slots: 32, curvature, rangeStart: 0.5 });
    expect(half.positions[0]![0]).toBe(2);
    expect(half.positions[1]![0]).toBe(2.125);
    expect(half.live.reduce((sum, flag) => sum + flag, 0)).toBe(17);
    // Half a metre of offset on the straight is one whole point there: the first station is at 0.5.
    const slid = resampleStrip(four, { ...byCurvature, slots: 32, curvature, offset: 0.5 });
    expect(slid.positions.slice(0, 2).map((p) => p[0])).toEqual([0.5, 1]);
    expect(slid.positions[2]![0]).toBeCloseTo(1 + 1 / 3, 12);
    // Anchored at the End, the last slot is on the end and the padding collects at the head.
    const fromEnd = resampleStrip(four, { ...byCurvature, slots: 32, curvature, anchor: "end" });
    expect(fromEnd.positions[31]![0]).toBe(4);
    expect(fromEnd.positions[30]![0]).toBe(3.875);
    expect(fromEnd.live.slice(0, 9)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it("over budget every spacing widens together and the whole strip is still covered", () => {
    const out = resampleStrip(four, { ...byCurvature, slots: 5, curvature: [0, 0, 0, 0, 0] });
    expect(out.live).toEqual([1, 1, 1, 1, 1]);
    expect(out.positions.map((p) => p[0])).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * A 64-gon of radius 2, closed, with the curvature a circle of that radius has: a tenth
   * of a radian a point at curvature one half is a point every 0.2 m of its perimeter.
   * Neighbouring stations are 0.2 m apart along the polygon, so their straight-line
   * distance is 0.2 less at most what a corner of 5.6 degrees cuts: a quarter of a
   * millimetre.
   */
  it("round a circle of radius 2 at a tenth of a radian a point: a point every 0.2 m", () => {
    const polygon: Vec3[] = Array.from({ length: 64 }, (_, i) => [2 * Math.cos((i * Math.PI) / 32), 2 * Math.sin((i * Math.PI) / 32), 0] as Vec3);
    const out = resampleStrip(polygon, { closed: true, method: "curvature", minDistance: 0.02, maxDistance: 0.5, bias: 0.5, slots: 80, curvature: polygon.map(() => 0.5) });
    const live = out.live.reduce((sum, flag) => sum + flag, 0);
    // The perimeter is 64 sides of 4·sin(π/64): 12.56 m, so 62 whole steps of 0.2.
    expect(live).toBe(62);
    for (let k = 0; k + 1 < live; k += 1) {
      const a = out.positions[k]!;
      const b = out.positions[k + 1]!;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1]), `stations ${k} and ${k + 1}`).toBeCloseTo(0.2, 3);
    }
  });

  it("padding in the input is worth nothing, and the blocked order is the whole one", () => {
    const padded: Vec3[] = [[0, 0, 0], [0, 0, 0], [1, 0, 0], [4, 0, 0], [4, 0, 0], [4, 0, 0]];
    const out = resampleStrip(padded, { ...byCurvature, slots: 12, curvature: [0, 0, 0, 0, 0, 0] });
    expect(out.positions.slice(0, 9).map((p) => p[0])).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4]);
    const curvature = [0, 0, SHARP, SHARP, SHARP];
    for (const block of [1, 2, 3]) expect(stripDensity(four, false, curvature, shape, block)).toEqual(stripDensity(four, false, curvature, shape));
    // By Count and by Distance a strip is placed from its lengths alone; by Curvature it is not.
    expect(() => resampleStations(stripLengths(four, false), { ...byCurvature, slots: 4 })).toThrow(/needs the strip's points and curvature/);
  });
});

/**
 * T1586b slice 6 — THE BLOCKED ORDER IS THE WHOLE WALK, CUT UP.
 *
 * A strip longer than one block is walked a block at a time (the design's section 4.3). The
 * whole walk is held to hand-derived values above; here the blocked walk is held to the
 * whole one, on strips cut into blocks of a few points so every seam is somewhere awkward:
 * inside a run of padding, on an exact reversal, across a closing segment, in the middle of
 * a straight run along Up. Where the fixture's numbers are exact the two agree TO THE BIT;
 * elsewhere they agree to rounding, which is all the blocked order may change.
 */
describe("the blocked order — a long strip is the whole walk, cut into blocks (T1586b slice 6)", () => {
  type Options = Parameters<typeof frameStrip>[1];
  const close = (blocked: ReturnType<typeof frameStrip>, whole: ReturnType<typeof frameStrip>, what: string, digits = 9): void => {
    expect(blocked.curveLength, `${what}: length`).toBeCloseTo(whole.curveLength, digits);
    expect(blocked.closingAngle, `${what}: closing angle`).toBeCloseTo(whole.closingAngle, digits);
    whole.tangent.forEach((_, index) => {
      const at = `${what}, point ${index}`;
      for (const name of ["tangent", "normal", "binormal"] as const) {
        (whole[name][index] as Vec3).forEach((value, axis) => expect((blocked[name][index] as Vec3)[axis], `${at}: ${name}[${axis}]`).toBeCloseTo(value, digits));
      }
      // One rotation has two quaternions; the two walks may land either side of a branch.
      const q = whole.orient[index]!;
      const p = blocked.orient[index]!;
      expect(Math.abs(q[0] * p[0] + q[1] * p[1] + q[2] * p[2] + q[3] * p[3]), `${at}: orient`).toBeCloseTo(1, digits);
      expect(blocked.distance[index], `${at}: distance`).toBeCloseTo(whole.distance[index]!, digits);
      expect(blocked.curveU[index], `${at}: curveU`).toBeCloseTo(whole.curveU[index]!, digits);
      expect(blocked.curvature[index], `${at}: curvature`).toBeCloseTo(whole.curvature[index]!, digits);
    });
  };
  /** A strip no walk is flattered by: irregular steps in space, from a fixed sequence. */
  const wander = (count: number, seed: number): Vec3[] => {
    let state = seed;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296 - 0.5;
    };
    const points: Vec3[] = [];
    let at: Vec3 = [0, 0, 0];
    for (let i = 0; i < count; i += 1) {
      points.push(at);
      at = [at[0] + 0.6 + next(), at[1] + next(), at[2] + next()];
    }
    return points;
  };
  const METHODS: ReadonlyArray<Options["method"]> = ["minimiseTwist", "fixedUp"];

  it("lengths: a block's start plus the distance inside it — exactly, where the numbers are exact", () => {
    const steps = line(11, 0.5);
    for (const block of [1, 2, 3, 4, 7]) {
      expect(stripLengths(steps, false, block)).toEqual(stripLengths(steps, false));
    }
    const strip = wander(23, 7);
    const whole = stripLengths(strip, true);
    const blocked = stripLengths(strip, true, 4);
    expect(blocked.total).toBeCloseTo(whole.total, 12);
    whole.cumulative.forEach((value, index) => expect(blocked.cumulative[index]).toBeCloseTo(value, 12));
    // A distance never runs backward across a seam: the search that reads it needs that.
    for (let index = 1; index < 23; index += 1) expect(blocked.cumulative[index]!).toBeGreaterThanOrEqual(blocked.cumulative[index - 1]!);
    expect(blocked.total).toBeGreaterThanOrEqual(blocked.cumulative[22]!);
  });

  it("a strip that fits one block is walked whole: the block size does not reach it", () => {
    const strip = wander(9, 3);
    const options: Options = { closed: true, method: "minimiseTwist", up: UP, twist: 1 };
    expect(frameStrip(strip, options, 9)).toEqual(frameStrip(strip, options));
    expect(frameStrip(strip, options, 4096)).toEqual(frameStrip(strip, options));
  });

  it("a straight line and a planar turn come out exact, seams and all", () => {
    for (const method of METHODS) {
      const straight = frameStrip(line(11, 0.5), { closed: false, method, up: UP }, 4);
      expect(straight, method).toEqual(frameStrip(line(11, 0.5), { closed: false, method, up: UP }));
      expect(straight.distance).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
      expect(straight.tangent[7]).toEqual([1, 0, 0]);
      expect(straight.normal[7]).toEqual([0, 1, 0]);
    }
    // Along +X, up +Y, up +Z, back along −X: a path in a plane whose normal is the seed.
    const planar: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [3, 1, 0], [3, 2, 0], [3, 3, 0], [2, 3, 0], [1, 3, 0], [0, 3, 0]];
    const options: Options = { closed: true, method: "minimiseTwist", up: [0, 0, 1] };
    const blocked = frameStrip(planar, options, 3);
    for (const normal of blocked.normal) expect(normal).toEqual([0, 0, 1]);
    expect(blocked.closingAngle).toBe(0);
    expect(blocked.distance).toEqual(frameStrip(planar, options).distance);
  });

  it("irregular strips in space, open and closed, by both methods, at every block size", () => {
    for (const method of METHODS) {
      for (const closed of [false, true]) {
        for (const block of [1, 2, 3, 4, 5, 7]) {
          for (const seed of [1, 2, 3]) {
            const strip = wander(23, seed);
            const options: Options = { closed, method, up: [0.2, 1, -0.3], roll: 0.4, twist: 2, closeTwist: seed !== 2 };
            close(frameStrip(strip, options, block), frameStrip(strip, options), `${method} ${closed ? "closed" : "open"} block ${block} seed ${seed}`);
          }
        }
      }
    }
  });

  /**
   * Padding is where the seams are hardest: a run of coincident points is written with the
   * turn at the segment that ENDS it, and that segment can be blocks away. Here runs cross
   * a seam, fill a whole block, fill the tail, and (closed) sit on the closing segment.
   */
  it("runs of coincident points across seams, whole blocks of padding, and a padded tail", () => {
    const bare = wander(7, 5);
    const repeat = (point: Vec3, times: number): Vec3[] => Array.from({ length: times }, () => point);
    const padded: Vec3[] = [
      ...repeat(bare[0]!, 3), // a padded head
      bare[1]!,
      ...repeat(bare[2]!, 4), // a run across the seam at 4 and at 8
      bare[3]!,
      ...repeat(bare[4]!, 9), // a whole block of padding, and more
      bare[5]!,
      ...repeat(bare[6]!, 6), // a padded tail over a seam
    ];
    for (const method of METHODS) {
      for (const closed of [false, true]) {
        for (const block of [1, 2, 4, 5]) {
          const options: Options = { closed, method, up: [0.1, 1, 0.2], twist: 1.5 };
          const blocked = frameStrip(padded, options, block);
          close(blocked, frameStrip(padded, options), `${method} ${closed ? "closed" : "open"} block ${block}`);
          // The points of one run share ONE frame, to the bit, whichever blocks wrote them.
          for (let index = 9; index < 17; index += 1) expect(blocked.orient[index + 1], `orient ${index + 1}`).toEqual(blocked.orient[index]);
          for (let index = 19; index < 24; index += 1) {
            expect(blocked.orient[index + 1], `orient ${index + 1}`).toEqual(blocked.orient[index]);
            expect(blocked.distance[index + 1], `distance ${index + 1}`).toBe(blocked.distance[index]);
          }
        }
      }
    }
    const still: Vec3[] = repeat([3, 3, 3], 11);
    expect(frameStrip(still, { closed: false, method: "minimiseTwist", up: UP }, 4)).toEqual(frameStrip(still, { closed: false, method: "minimiseTwist", up: UP }));
  });

  /**
   * A curve doubling straight back has no smallest rotation: the frame turns about its own
   * normal. That keeps the normal and turns the direction round, which mirrors the angle a
   * block's reference is carried at — the one place a block's turn is not a plain rotation.
   */
  it("an exact reversal inside a block and on a seam", () => {
    // Two turns in space first, so the frame that reaches the reversal is not the one a
    // block would pick for itself; then out along +X and straight back.
    const doubled: Vec3[] = [
      [0, 0, 0], [0, 1, 0.5], [1, 2, 0], [2, 2, 1],
      [3, 2, 1], [4, 2, 1], [5, 2, 1], [6, 2, 1], [7, 2, 1],
      [6, 2, 1], [5, 2, 1], [4, 2, 1],
      [4, 3, 1], [4, 3, 2], [5, 4, 3],
    ];
    for (const method of METHODS) {
      for (const block of [2, 3, 4, 5, 6, 7]) {
        const options: Options = { closed: false, method, up: [0.3, 1, 0.2] };
        close(frameStrip(doubled, options, block), frameStrip(doubled, options), `${method} block ${block}`);
      }
    }
  });

  /**
   * Fixed Up where the curve runs straight up for longer than a block: every point there
   * takes the normal of the point before it, so whole blocks hand on what they were handed.
   */
  it("Fixed Up through a run along Up longer than a block hands the normal across every seam", () => {
    // Up is (½, 1, 1) and the run goes along (1, 2, 2): off every axis, so a block's map of
    // the handed normal has no zero in it to hide a mistake.
    const shaft: Vec3[] = [
      [0, 0, 0], [1, 0, 0], [2, 0, 0],
      ...Array.from({ length: 13 }, (_, i) => [3 + i, 2 * (i + 1), 2 * (i + 1)] as Vec3),
      [16, 26, 27], [17, 26, 29],
    ];
    const options: Options = { closed: false, method: "fixedUp", up: [0.5, 1, 1] };
    const whole = frameStrip(shaft, options);
    for (const block of [1, 2, 3, 4, 5]) close(frameStrip(shaft, options, block), whole, `block ${block}`);
    // By hand: the corner into the run leans (−1, 1, 1)/√3, which pressed square to the run
    // is (−4, 1, 1)/(3√2) — and every point of the run takes it from the one before.
    expectVec(whole.tangent[8]!, [1 / 3, 2 / 3, 2 / 3]);
    expectVec(whole.normal[2]!, [-1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]);
    for (let index = 3; index < 15; index += 1) expectVec(whole.normal[index]!, [-4 / (3 * Math.SQRT2), 1 / (3 * Math.SQRT2), 1 / (3 * Math.SQRT2)]);
  });

  /**
   * The corner a summary cannot hold. Up is mapped per point to the tangent itself, so no
   * point from the third on can decide its own normal and whole blocks only hand one on.
   * Inside one of them the curve doubles straight back; there the tangent swings onto the
   * handed normal, which is pressed to nothing and restarts from a world axis. The fold
   * cannot know that from the block's summary — it sees only that the handed normal has
   * vanished — so the blocks after it are walked forward from the last one that is known.
   */
  it("Fixed Up: a handed normal that collapses inside a block is followed exactly", () => {
    // Out along +X, one step straight back, then off into space: after the collapse the
    // handed normal keeps changing, so a block that guessed it instead of following it shows.
    const doubled: Vec3[] = [...line(8, 1), [6, 0, 0], [5.5, 1, 0.5], [5, 1.5, 1.5], [4, 3, 2], [3, 3, 4], [2, 4, 5], [1, 4, 7]];
    const seeded: Options = { closed: false, method: "fixedUp", up: doubled.map(() => UP) };
    const tangents = frameStrip(doubled, { ...seeded, up: [[0, 0, 1], ...doubled.slice(1).map(() => UP)] }).tangent;
    // Point 0 seeds the carried frame with +Z, point 1 decides +Y, and from there Up IS the tangent.
    const up: Vec3[] = tangents.map((tangent, index) => (index === 0 ? [0, 0, 1] : index === 1 ? UP : tangent));
    const options: Options = { closed: false, method: "fixedUp", up };
    const whole = frameStrip(doubled, options);
    // The collapse is real: at the reversal the tangent is the handed normal's own direction.
    expectVec(whole.tangent[7]!, [0, 1, 0]);
    expectVec(whole.normal[6]!, [0, 1, 0]);
    expectVec(whole.normal[7]!, [1, 0, 0]);
    for (const block of [2, 3, 4, 5]) close(frameStrip(doubled, options, block), whole, `block ${block}`);
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

/**
 * T1586b slice 8 — THE ARC CHAIN: arcs end to end, each with a length and a bend.
 *
 * Every expectation follows from the definition and a circle: a section of length L and
 * bend κ is an arc of radius 1 ÷ κ that turns the chain by κL; a bend about the frame's +Y
 * curls toward its +X, and one about +X toward its −Y (the right-hand rule).
 */
describe("the Arc Chain — sections by length and bend (T1586b slice 8)", () => {
  const chain = { closed: false, basis: "arcChain", segments: 4 } as const;
  const ORIGIN: Vec3 = [0, 0, 0];
  const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
  const distance = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

  it("every control point is a section: one span each, and one more point to end the chain", () => {
    expect(curveSpans(3, chain)).toBe(3);
    expect(curveSpans(1, chain)).toBe(1);
    expect(curvePointCount(3, chain)).toBe(13);
    // A chain has a start and an end: a closed claim cannot close it.
    expect(curvePointCount(3, { ...chain, closed: true })).toBe(13);
    const stations = curveStations(3, chain);
    expect(stations.map((station) => station.index)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2]);
    // Attributes blend toward the NEXT section; the last one has none and holds its own.
    expect(stations.map((station) => station.next)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    expect(stations[12]).toMatchObject({ span: 2, u: 1 });
  });

  /**
   * No bend, the identity frame: the chain runs along +Z, and a station is its start plus
   * the lengths before it — sums of dyadic numbers, so exactly.
   */
  it("with no bend it is a straight line of exactly the lengths given, from the first control point", () => {
    const controls: Vec3[] = [[1, 2, 3], [9, 9, 9], [9, 9, 9]];
    const line = evaluateCurve(controls, { ...chain, arcLength: [1, 2, 0.5], bend: [0, 0] });
    expect(line.map((point) => point[2])).toEqual([3, 3.25, 3.5, 3.75, 4, 4.5, 5, 5.5, 6, 6.125, 6.25, 6.375, 6.5]);
    for (const point of line) expect(point.slice(0, 2)).toEqual([1, 2]);
  });

  /**
   * A quarter circle about +Y, then a quarter circle about the frame's +X. The first curls
   * from +Z toward +X on a circle of radius 1 about (1, 0, 0), and ends at (1, 0, 1)
   * heading +X. Its frame has turned with it: the frame's X now points along −Z, its Y is
   * still +Y. So the second, about that X, curls toward −Y on a circle about (1, −1, 1),
   * and ends at (2, −1, 1) heading −Y. Now the frame's Y points along +X and its X still
   * along −Z, so the third, about that Y, curls toward −Z and ends at (2, −2, 0). Each turn
   * is taken in the frame the chain has REACHED, which is what the third one shows: turned
   * about the world's axes instead, it would end somewhere else.
   */
  it("three quarter circles, by hand: each leaves the way the one before it arrived", () => {
    const quarter = Math.PI / 2;
    const points = evaluateCurve([ORIGIN, ORIGIN, ORIGIN], { ...chain, arcLength: quarter, bend: [[0, 1], [1, 0], [0, 1]] });
    points.slice(0, 5).forEach((point, k) => {
      const turned = (k * quarter) / 4;
      expectVec(point, [1 - Math.cos(turned), 0, Math.sin(turned)]);
    });
    points.slice(4, 9).forEach((point, k) => {
      const turned = (k * quarter) / 4;
      expectVec(point, [1 + Math.sin(turned), -(1 - Math.cos(turned)), 1]);
    });
    points.slice(8).forEach((point, k) => {
      const turned = (k * quarter) / 4;
      expectVec(point, [2, -1 - Math.sin(turned), 1 - (1 - Math.cos(turned))]);
    });
    expectVec(points[12]!, [2, -2, 0]);
  });

  /**
   * THE LENGTH IS AN INPUT. A section of length 3 with a bend of (0.3, −0.4) has curvature
   * 0.5: it is 1.5 radians of a circle of radius 2, whose centre is two metres from the
   * start toward (−0.8, −0.6, 0) — the axis crossed with the tangent. Every station is on
   * that circle and the same chord from the last, and the chords add to 3·sinc(1.5 ÷ 8),
   * the length of four chords across 1.5 radians: nothing about the shape changed how much
   * curve was laid.
   */
  it("a section lies on its circle and lays out exactly its length", () => {
    const points = evaluateCurve([ORIGIN], { ...chain, arcLength: 3, bend: [0.3, -0.4] });
    expect(points).toHaveLength(5);
    const centre: Vec3 = [-1.6, -1.2, 0];
    for (const point of points) expect(distance(point, centre)).toBeCloseTo(2, 12);
    const chords = points.slice(1).map((point, k) => distance(point, points[k]!));
    for (const chord of chords) expect(chord).toBeCloseTo(4 * Math.sin(1.5 / 8), 12);
    expect(chords.reduce((sum, chord) => sum + chord, 0)).toBeCloseTo((3 * Math.sin(1.5 / 8)) / (1.5 / 8), 12);
    // And the arc it is: the last station is 1.5 radians round from the first.
    const first = add(points[0]!, scale(centre, -1));
    const last = add(points[4]!, scale(centre, -1));
    expect(Math.acos(dot(first, last) / 4)).toBeCloseTo(1.5, 12);
  });

  it("a joint is continuous in position and in direction", () => {
    const lengths = [1.2, 0.7, 2];
    const bends: Vec2[] = [[0.6, 0.2], [-1.1, 0.4], [0.1, -0.9]];
    const sections = arcChainSections([1, 2, 3], [0, 0, 0, 1], lengths, bends);
    for (let k = 0; k + 1 < sections.length; k += 1) {
      const here = sections[k]!;
      const turned = here.curvature * here.length;
      expectVec(sections[k + 1]!.start, arcPoint(here, here.length));
      // An arc leaves along its tangent and, a turn later, along tangent·cos + inward·sin.
      expectVec(sections[k + 1]!.tangent, add(scale(here.tangent, Math.cos(turned)), scale(here.inward, Math.sin(turned))));
    }
  });

  /**
   * The single Arc is the case of one section. The Arc's solve finds a curvature and a way
   * to leave; hand a one-section chain that frame and that curvature, and it is the same arc
   * to the same far point — so whatever holds for the chain's sections holds for the Arc.
   */
  it("one section with the solved Arc's curvature and frame is that Arc", () => {
    const from: Vec3 = [0.5, 1, -2];
    const to: Vec3 = [2.5, 2, -1];
    const solved = solveArc(from, to, 4, [0.2, 1, 0.3]);
    const arc = evaluateCurve([from, to], { closed: false, basis: "arc", segments: 8, arcLength: 4, bow: [0.2, 1, 0.3] });
    // A frame whose Z is the way the arc leaves and whose X is the side it curls to.
    const startOrient = quatFromFrame(solved.inward, cross(solved.tangent, solved.inward), solved.tangent);
    const section = evaluateCurve([from], { closed: false, basis: "arcChain", segments: 8, arcLength: 4, bend: [0, solved.curvature], startOrient });
    section.forEach((point, k) => expectVec(point, arc[k]!, 10));
    expectVec(section[8]!, to, 6);
  });

  it("the start frame turns the whole chain: (½, ½, ½, ½) carries +Z onto +X", () => {
    const line = evaluateCurve([ORIGIN, ORIGIN], { ...chain, arcLength: 2, bend: [0, 0], startOrient: [0.5, 0.5, 0.5, 0.5] });
    expect(line).toEqual(Array.from({ length: 9 }, (_, k) => [k * 0.5, 0, 0]));
    // That frame's Y is +Z and its X is +Y, so a bend about its Y curls from +X toward +Y.
    const curled = evaluateCurve([ORIGIN], { ...chain, arcLength: Math.PI / 2, bend: [0, 1], startOrient: [0.5, 0.5, 0.5, 0.5] });
    expectVec(curled[4]!, [1, 1, 0]);
  });

  /**
   * WHY A BODY THAT BLENDS BETWEEN TWO POSES IS A CHAIN: a pose is its lengths and bends, a
   * blend of two poses is a blend of those numbers, and the chain is a plain function of
   * them — there is no solve to change its mind. So the chain moves continuously through
   * the blend, a bend passing through nothing included: halve the step and the largest
   * move of any station halves with it.
   */
  it("blending two poses moves the chain continuously: halve the step and the largest move halves", () => {
    const holding = { lengths: [1, 1.5, 0.8], bends: [[0.8, 0], [0.5, 0.6], [-0.2, 1.1]] as Vec2[] };
    const trailing = { lengths: [1.2, 1.1, 1], bends: [[-0.8, 0.3], [0.1, -0.7], [0.9, 0.2]] as Vec2[] };
    const mix = (a: number, b: number, t: number): number => a + (b - a) * t;
    const pose = (t: number): Vec3[] =>
      evaluateCurve([ORIGIN, ORIGIN, ORIGIN], {
        ...chain,
        arcLength: holding.lengths.map((length, k) => mix(length, trailing.lengths[k]!, t)),
        bend: holding.bends.map((bend, k) => [mix(bend[0], trailing.bends[k]![0], t), mix(bend[1], trailing.bends[k]![1], t)] as Vec2),
      });
    const largestMove = (instants: number): number => {
      let largest = 0;
      for (let i = 0; i + 1 < instants; i += 1) {
        const here = pose(i / (instants - 1));
        const there = pose((i + 1) / (instants - 1));
        here.forEach((point, k) => (largest = Math.max(largest, distance(point, there[k]!))));
      }
      return largest;
    };
    const coarse = largestMove(61);
    const fine = largestMove(121);
    expect(coarse / fine).toBeGreaterThan(1.9);
    expect(coarse / fine).toBeLessThan(2.1);
    // The control: the two poses are far apart, so there was something to move through.
    expect(distance(pose(0)[12]!, pose(1)[12]!)).toBeGreaterThan(1);
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
