import { describe, expect, it } from "vitest";

import type { PointAttributeType } from "../../points/attributes.ts";
import { curvePointCount, evaluateCurve, type CurveBasis, type CurveOptions, type Vec3 } from "../../points/curve.ts";
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
import { authoredCurve, curveAttributes } from "./point-curve.ts";
import { curveFramesAttributes } from "./point-curve-frames.ts";
import { resampleAttributes } from "./point-resample.ts";

/**
 * Curve (T1586b slice 2) on a real device, asserted on READ-BACK POINTS.
 *
 * ## What is asserted for equality, and why it can be (§V147)
 *
 * The node writes every blend as "point + share × difference" and returns a control point's
 * own words where a span starts or ends on one. So on fixtures whose numbers are exact in
 * f32 the results are exact too: a control point comes back TO THE BIT whatever the basis,
 * collinear evenly spaced control points give exactly the line, and a taut Arc's stations
 * are exactly `k × chord ÷ segments`. Those say `toEqual`. Where a result is irrational (a
 * point on a circle, a spline between unevenly spaced points) the expectation is a closed
 * form or the CPU reference, compared at single precision; there are no bands.
 *
 * ## The Arc is the reason this node has tests about LENGTH
 *
 * A spline's length is whatever its control points make it; a body of fixed length needs a
 * curve whose length is an input (the design's section 3.5, the consumer's finding). The
 * tests below hold both halves: an Arc lays out the length it was given whatever its chord,
 * and it moves without a pop — halve the step its end moves by and the largest move of any
 * station halves with it — unless its bow is swept through the chord, which is the one way
 * to make it jump, and the control shows that it does.
 */

const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const minus = (a: readonly number[], b: readonly number[]): number[] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const norm = (a: readonly number[]): number => Math.sqrt(dot(a, a));
const close = (actual: readonly number[], expected: readonly number[], what: string, digits = 5): void => {
  expected.forEach((value, at) => expect(actual[at], `${what}, component ${at} of [${actual.join(", ")}]`).toBeCloseTo(value, digits));
};
const f32 = (point: readonly number[]): number[] => point.map((value) => Math.fround(value));

interface Curved {
  readonly cols: number;
  readonly position: number[][];
  readonly read: (name: string) => Promise<{ floats: Float32Array; words: Uint32Array }>;
}

type Shape = { readonly cols: number; readonly rows: number; readonly closed?: boolean };

/** authored control points → Topology (Strips) → Curve; one frame on Dawn; the curve read back. */
async function curve<T = Curved>(
  controls: ReadonlyArray<Vec3>,
  strips: Shape,
  parameters: Record<string, unknown>,
  extras: ReadonlyArray<AuthoredAttribute> = [],
  also?: (curved: Curved) => Promise<T>,
): Promise<T> {
  const source = authoredPoints("kernel_control", controls, extras);
  const basis = (parameters["basis"] ?? "catmullRom") as CurveBasis;
  const cols = curvePointCount(strips.cols, {
    closed: strips.closed === true,
    basis,
    clamped: parameters["clamped"] !== false,
    segments: Number(parameters["segments"] ?? 16),
  });
  const capacity = cols * strips.rows;
  const sink = drawnTo("curve_spine", capacity);
  const graph = curveGraph(
    [
      source.node,
      curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: strips.cols, rows: strips.rows, wrapU: strips.closed === true }),
      curveNode("curve_spine", "pointCurve", parameters),
      ...sink.nodes,
    ],
    [curveEdge(["kernel_control", "out"], ["topology_strips", "points"]), curveEdge(["topology_strips", "out"], ["curve_spine", "in"]), ...sink.edges],
  );
  const schema = curveAttributes(
    source.schema.map((entry) => ({ name: entry.name, type: entry.type as PointAttributeType })),
    basis,
  );
  return onDawn(graph, async (session) => {
    const read = (name: string) => session.read("curve_spine", schema, capacity, name);
    const floats = (await read("position")).floats;
    const curved: Curved = { cols, position: Array.from({ length: capacity }, (_, index) => vecAt(floats, index)), read };
    return also === undefined ? (curved as T) : also(curved);
  });
}

describe("Curve on Dawn — the bases, at values a person can work out (T1586b)", () => {
  it("Linear keeps the chords: (0,0,0) to (4,0,0) in four segments is exactly 0, 1, 2, 3, 4", async () => {
    const straight = await curve([[0, 0, 0], [4, 0, 0]], { cols: 2, rows: 1 }, { basis: "linear", segments: 4 });
    expect(straight.position).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
    const bent = await curve([[0, 0, 0], [2, 0, 0], [2, 4, 0]], { cols: 3, rows: 1 }, { basis: "linear", segments: 2 });
    expect(bent.position).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [2, 2, 0], [2, 4, 0]]);
  }, 60_000);

  /**
   * WHICH Catmull-Rom it is, pinned by a value only the centripetal one takes — worked out
   * by hand, not by the reference. Control points on a line at 0, 1, 5 and 14 are 1, 4 and
   * 9 apart, so their knot gaps (the square roots) are 1, 2 and 3, and the middle of the
   * span from 1 to 5 by Barry and Goldman's pyramid is A = 2, 3, 2; B = 8/3, 14/5;
   * C = 8/3 + ½·(14/5 − 8/3) = 41/15. Uniform knots give 2.5 there, and chordal ones 3 —
   * which is what Cardinal, the uniform spline, reads on the same points.
   */
  it("Catmull-Rom is centripetal: unevenly spaced control points put a span's middle at 41/15, not 2.5 or 3", async () => {
    const controls: Vec3[] = [[0, 0, 0], [1, 0, 0], [5, 0, 0], [14, 0, 0]];
    const centripetal = await curve(controls, { cols: 4, rows: 1 }, { basis: "catmullRom", segments: 2 });
    expect(centripetal.position[3]![0]).toBeCloseTo(41 / 15, 5);
    const uniform = await curve(controls, { cols: 4, rows: 1 }, { basis: "cardinal", segments: 2 });
    expect(uniform.position[3]![0]).toBeCloseTo(2.5, 5);
  }, 60_000);

  /**
   * The case every interpolating basis must agree on with the line itself. Written "point
   * + share × difference", the differences of differences are zero rather than rounding
   * noise, so the answer is the line TO THE BIT, on the device as on the CPU.
   */
  it("Catmull-Rom and Cardinal give exactly the line through collinear, evenly spaced control points", async () => {
    const controls: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0]];
    const expected = Array.from({ length: 13 }, (_, k) => [k / 4, 0, 0]);
    for (const basis of ["catmullRom", "cardinal"] as const) {
      const out = await curve(controls, { cols: 4, rows: 1 }, { basis, segments: 4 });
      expect(out.position, basis).toEqual(expected);
    }
  }, 60_000);

  it("the interpolating bases return every control point to the bit, however unevenly they are spaced", async () => {
    const controls: Vec3[] = [[0.1, 0.2, 0.3], [1.7, -0.4, 0.9], [1.9, 2.3, -1.1], [-3.3, 0.7, 0.01], [0.4, 0.4, 5.5]];
    for (const basis of ["linear", "catmullRom", "cardinal", "arc"] as const) {
      const out = await curve(controls, { cols: 5, rows: 1 }, { basis, segments: 3, arcLength: 9 });
      // An Arc in reach ends on its far control point only to rounding; every span START is exact.
      const exact = basis === "arc" ? 4 : 5;
      for (let i = 0; i < exact; i += 1) expect(out.position[i * 3], `${basis} control ${i}`).toEqual(f32(controls[i]!));
      if (basis === "arc") close(out.position[12]!, controls[4]!, "the arc's far end");
    }
  }, 60_000);

  /**
   * The corners of a unit square, closed: every knot gap is the same, so centripetal
   * Catmull-Rom is the uniform one, and the middle of the span from (0,0) to (1,0) is
   * (−P0 + 9·P1 + 9·P2 − P3) ÷ 16 = (0.5, −0.125). Cardinal scales the bulge by 1 − Tension.
   */
  it("on a closed unit square the middle of a span bulges out by an eighth, and Tension flattens it", async () => {
    const square: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const middle = async (parameters: Record<string, unknown>): Promise<number[]> =>
      (await curve(square, { cols: 4, rows: 1, closed: true }, { segments: 2, ...parameters })).position[1]!;
    close(await middle({ basis: "catmullRom" }), [0.5, -0.125, 0], "Catmull-Rom", 6);
    close(await middle({ basis: "cardinal", tension: 0 }), [0.5, -0.125, 0], "Cardinal 0", 6);
    close(await middle({ basis: "cardinal", tension: 0.5 }), [0.5, -0.0625, 0], "Cardinal 0.5", 6);
    close(await middle({ basis: "cardinal", tension: 1 }), [0.5, 0, 0], "Cardinal 1", 6);
    // And the strip closes: four control points, two points a span, eight in all; the last
    // span runs from (0, 1) back toward (0, 0).
    const closed = await curve(square, { cols: 4, rows: 1, closed: true }, { basis: "linear", segments: 2 });
    expect(closed.position).toEqual([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1, 0.5, 0], [1, 1, 0], [0.5, 1, 0], [0, 1, 0], [0, 0.5, 0]]);
  }, 60_000);

  /**
   * A uniform cubic B-Spline at a knot is (P0 + 4·P1 + P2) ÷ 6: for (0,0), (6,0), (6,6)
   * that is (5, 1). Clamped, the ends are mirrored and the same sum at an end is the end
   * point itself. Unclamped it is the plain spline: four control points, one span.
   */
  it("a B-Spline passes (P0 + 4·P1 + P2) ÷ 6 at a knot, reaches its ends when clamped, and stops short when not", async () => {
    const clamped = await curve([[0, 0, 0], [6, 0, 0], [6, 6, 0]], { cols: 3, rows: 1 }, { basis: "bspline", segments: 2 });
    close(clamped.position[0]!, [0, 0, 0], "the first end", 6);
    close(clamped.position[2]!, [5, 1, 0], "the knot", 6);
    close(clamped.position[4]!, [6, 6, 0], "the last end", 6);
    const plain = await curve([[0, 0, 0], [6, 0, 0], [6, 6, 0], [0, 6, 0]], { cols: 4, rows: 1 }, { basis: "bspline", clamped: false, segments: 2 });
    expect(plain.position).toHaveLength(3);
    close(plain.position[0]!, [5, 1, 0], "the plain spline's start", 6);
    close(plain.position[2]!, [5, 5, 0], "the plain spline's end", 6);
  }, 60_000);

  it("a Bezier span's middle is (P1 + 3·(P1 + out) + 3·(P2 + in) + P2) ÷ 8, and its handles stay off the curve", async () => {
    const handles: AuthoredAttribute[] = [
      { name: "handleIn", type: "vec3f", values: [[0, 0, 0], [0, 8, 0]] },
      { name: "handleOut", type: "vec3f", values: [[0, 8, 0], [0, 0, 0]] },
      { name: "weight", type: "f32", values: [1, 3] },
    ];
    const out = await curve([[0, 0, 0], [8, 0, 0]], { cols: 2, rows: 1 }, { basis: "bezier", segments: 2 }, handles, async (curved) => ({
      position: curved.position,
      weight: Array.from((await curved.read("weight")).floats),
    }));
    // (0 + 3·(0,8) + 3·(8,8) + (8,0)) ÷ 8 = (4, 6): eighths and whole numbers, so exact.
    expect(out.position).toEqual([[0, 0, 0], [4, 6, 0], [8, 0, 0]]);
    // The read above sliced the buffer WITHOUT the handles: had they been carried, `weight`
    // would sit two regions further on and these would not be 1, 2, 3.
    expect(out.weight).toEqual([1, 2, 3]);
  }, 60_000);
});

describe("Curve on Dawn — attributes ride the curve (T1586b)", () => {
  /**
   * Whatever the basis does to POSITION, every other float attribute is a straight blend
   * between a span's two control points — a radius must not overshoot — and an integer
   * holds the control point at its span's start. On a control point the words are copied,
   * integers included: the strip's last point carries the LAST control point's tag.
   */
  it("floats blend linearly along each span, an integer holds the control point at its span's start", async () => {
    const controls: Vec3[] = [[0, 0, 0], [1, 2, 0], [3, 1, 0]];
    const extras: AuthoredAttribute[] = [
      { name: "radius", type: "f32", values: [1, 2, 4] },
      { name: "tint", type: "vec4f", values: [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 0]] },
      { name: "tag", type: "u32", values: [7, 8, 9] },
      { name: "odd", type: "f32", values: [0.1, 0.7, 1.3] },
    ];
    const out = await curve(controls, { cols: 3, rows: 1 }, { basis: "catmullRom", segments: 4 }, extras, async (curved) => ({
      radius: Array.from((await curved.read("radius")).floats),
      tint: (await curved.read("tint")).floats,
      tag: Array.from((await curved.read("tag")).words),
      odd: Array.from((await curved.read("odd")).floats),
    }));
    expect(out.radius).toEqual([1, 1.25, 1.5, 1.75, 2, 2.5, 3, 3.5, 4]);
    expect(vecAt(out.tint, 2, 4)).toEqual([0.5, 0.5, 0, 1]);
    expect(vecAt(out.tint, 6, 4)).toEqual([0, 0.5, 0.5, 0.5]);
    // The last point is the END of the last span: it reads the last control point, not the one before.
    expect(vecAt(out.tint, 8, 4)).toEqual([0, 0, 1, 0]);
    expect(out.tag).toEqual([7, 7, 7, 7, 8, 8, 8, 8, 9]);
    // To the bit on a control point, even for values f32 cannot hold exactly.
    expect([out.odd[0], out.odd[4], out.odd[8]]).toEqual([Math.fround(0.1), Math.fround(0.7), Math.fround(1.3)]);
  }, 60_000);
});

describe("Curve on Dawn — the Arc: one arc of a given length per span (T1586b D8)", () => {
  /**
   * A chord of 2 and a length of π is a half circle of radius 1, because sinc(π/2) = 2/π.
   * With the bow on +Y it is the upper half of the unit circle, run from (−1, 0) to (1, 0):
   * station k of n sits at the angle π − kπ/n. Nothing here comes from the implementation.
   */
  it("length π over a chord of 2 is a half circle of radius 1, on the bow's side", async () => {
    const out = await curve([[-1, 0, 0], [1, 0, 0]], { cols: 2, rows: 1 }, { basis: "arc", segments: 8, arcLength: Math.PI, bow: [0, 1, 0] });
    out.position.forEach((point, k) => {
      const angle = Math.PI - (k * Math.PI) / 8;
      close(point, [Math.cos(angle), Math.sin(angle), 0], `station ${k}`);
    });
    expect(out.position[0]).toEqual([-1, 0, 0]);
  }, 60_000);

  it("taut, the stations are exactly k × chord ÷ segments; out of reach, the line keeps its length and stops short", async () => {
    const taut = await curve([[0, 0, 0], [4, 0, 0]], { cols: 2, rows: 1 }, { basis: "arc", segments: 4, arcLength: 4, bow: [0, 1, 0] });
    expect(taut.position).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]]);
    const short = await curve([[0, 0, 0], [4, 0, 0]], { cols: 2, rows: 1 }, { basis: "arc", segments: 4, arcLength: 2, bow: [0, 1, 0] });
    expect(short.position).toEqual([[0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1.5, 0, 0], [2, 0, 0]]);
  }, 60_000);

  it("the bow picks the side, by its part square to the chord: the opposite bow mirrors the arc", async () => {
    const parameters = { basis: "arc", segments: 6, arcLength: 3 };
    const up = await curve([[0, 0, 0], [2, 0, 0]], { cols: 2, rows: 1 }, { ...parameters, bow: [0, 1, 0] });
    const down = await curve([[0, 0, 0], [2, 0, 0]], { cols: 2, rows: 1 }, { ...parameters, bow: [0, -1, 0] });
    const leaning = await curve([[0, 0, 0], [2, 0, 0]], { cols: 2, rows: 1 }, { ...parameters, bow: [5, 0.1, 0] });
    expect(up.position[3]![1]).toBeGreaterThan(0.9);
    up.position.forEach((point, k) => {
      close(down.position[k]!, [point[0]!, -point[1]!, point[2]!], `mirrored station ${k}`, 6);
      close(leaning.position[k]!, point, `a bow leaning along the chord, station ${k}`, 6);
    });
  }, 60_000);

  /**
   * Max Turn caps the bow: 10 metres asked over a chord of 2 with at most a half turn is
   * the half circle again, π laid out and the rest not deployed, still ending on its far
   * point. And in Chords the length follows the span: 1.5 chords over 2 is 3 metres.
   */
  it("Max Turn leaves slack undeployed, and a length in Chords follows the span", async () => {
    const capped = await curve([[-1, 0, 0], [1, 0, 0]], { cols: 2, rows: 1 }, { basis: "arc", segments: 4, arcLength: 10, bow: [0, 1, 0], maxTurn: 180 });
    close(capped.position[2]!, [0, 1, 0], "the top of the half circle");
    close(capped.position[4]!, [1, 0, 0], "the far end");
    const metres = await curve([[0, 0, 0], [2, 0, 0]], { cols: 2, rows: 1 }, { basis: "arc", segments: 4, arcLength: 3, bow: [0, 1, 0] });
    const chords = await curve([[0, 0, 0], [2, 0, 0]], { cols: 2, rows: 1 }, { basis: "arc", segments: 4, arcLength: 1.5, arcLengthUnit: "chords", bow: [0, 1, 0] });
    expect(chords.position).toEqual(metres.position);
  }, 60_000);

  /**
   * A span whose two control points coincide has no chord, so no direction to bow from. With
   * a full turn allowed the length is laid out as a CIRCLE through the point, on the bow's
   * side: 2π metres is radius 1 about the point one metre toward the bow, so station k of 8
   * is 1 − cos(2πk/8) above the point whichever way round the circle runs. With less than a
   * full turn allowed, or a length in Chords, nothing can be laid and every station is the
   * point itself, exactly — never a NaN from dividing by the chord.
   */
  it("with no chord it is a circle through the point on the bow's side, or the point itself when no turn can hold the length", async () => {
    const point: Vec3 = [2, 3, 4];
    const circle = await curve([point, point], { cols: 2, rows: 1 }, { basis: "arc", segments: 8, arcLength: 2 * Math.PI, bow: [0, 1, 0] });
    expect(circle.position[0]).toEqual([2, 3, 4]);
    circle.position.forEach((station, k) => {
      expect(station[1], `height of station ${k}`).toBeCloseTo(3 + 1 - Math.cos((2 * Math.PI * k) / 8), 5);
      expect(norm(minus(station, [2, 4, 4])), `station ${k} on the circle`).toBeCloseTo(1, 5);
    });
    close(circle.position[4]!, [2, 5, 4], "the far side of the circle");
    const reference = evaluateCurve([point, point], { closed: false, basis: "arc", segments: 8, arcLength: 2 * Math.PI, bow: [0, 1, 0] });
    reference.forEach((expected, k) => close(circle.position[k]!, expected, `the reference's station ${k}`));

    const capped = await curve([point, point], { cols: 2, rows: 1 }, { basis: "arc", segments: 8, arcLength: 2 * Math.PI, bow: [0, 1, 0], maxTurn: 180 });
    expect(capped.position).toEqual(Array.from({ length: 9 }, () => [2, 3, 4]));
    const inChords = await curve([point, point], { cols: 2, rows: 1 }, { basis: "arc", segments: 8, arcLength: 1.5, arcLengthUnit: "chords", bow: [0, 1, 0] });
    expect(inChords.position).toEqual(Array.from({ length: 9 }, () => [2, 3, 4]));
  }, 60_000);

  /**
   * Arc Length and Bow in Map mode give each span its own, read at its first control point.
   * Two strips over the same chord: one taut with the bow anywhere, one a half circle
   * bowing to −Y. Cut the two maps and both strips take the node's own values.
   */
  it("Arc Length and Bow in Map mode give each strip its own; cut the maps and both take the node's", async () => {
    const controls: Vec3[] = [[-1, 0, 0], [1, 0, 0], [-1, 5, 0], [1, 5, 0]];
    const extras: AuthoredAttribute[] = [
      { name: "slack", type: "f32", values: [2, 2, Math.PI, Math.PI] },
      { name: "side", type: "vec3f", values: [[0, 1, 0], [0, 1, 0], [0, -1, 0], [0, -1, 0]] },
    ];
    const mapped = await curve(
      controls,
      { cols: 2, rows: 2 },
      { basis: "arc", segments: 2, arcLength: mappedTo("slack", 1), bow: mappedTo("side", [0, 1, 0]) },
      extras,
    );
    expect(mapped.position.slice(0, 3)).toEqual([[-1, 0, 0], [0, 0, 0], [1, 0, 0]]);
    close(mapped.position[4]!, [0, 4, 0], "the second strip's half circle bows to −Y");
    const cut = await curve(controls, { cols: 2, rows: 2 }, { basis: "arc", segments: 2, arcLength: Math.PI, bow: [0, 1, 0] }, extras);
    close(cut.position[1]!, [0, 1, 0], "unmapped, the first strip bows to +Y");
    close(cut.position[4]!, [0, 6, 0], "unmapped, the second strip bows to +Y too");
  }, 60_000);

  /**
   * THE LENGTH TABLE, as far as it is exact (the design's section 3.5), measured by Curve
   * Frames rather than taken from the node's own arithmetic.
   *
   *  - LINEAR keeps the sum of its chords: 3 and 4 make 7, exactly.
   *  - an ARC lays out the length it was GIVEN, whatever its chord: two strips with chords
   *    of 2 and 3 and four metres asked of each. Its stations all sit on ONE circle, of
   *    radius 4 ÷ 2φ, and run from the first control point to the second — an angle of 2φ
   *    at that radius, which is four metres of arc for either chord. The polyline THROUGH
   *    the n stations is the chords of n equal steps, 4·sinc(φ/n), and the curvature Curve
   *    Frames reads at every interior station is the arc's own, 2φ ÷ 4.
   *  - a SPLINE keeps nothing: through the same two points a Catmull-Rom is the chord.
   */
  it("Linear keeps the sum of its chords, an Arc the length it was given, a spline neither", async () => {
    const measured = async (controls: ReadonlyArray<Vec3>, strips: Shape, parameters: Record<string, unknown>) => {
      const source = authoredPoints("kernel_control", controls);
      const cols = curvePointCount(strips.cols, { closed: false, basis: parameters["basis"] as CurveBasis, segments: Number(parameters["segments"]) });
      const capacity = cols * strips.rows;
      const sink = drawnTo("frames_spine", capacity);
      const graph = curveGraph(
        [
          source.node,
          curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: strips.cols, rows: strips.rows }),
          curveNode("curve_spine", "pointCurve", parameters),
          curveNode("frames_spine", "pointCurveFrames"),
          ...sink.nodes,
        ],
        [
          curveEdge(["kernel_control", "out"], ["topology_strips", "points"]),
          curveEdge(["topology_strips", "out"], ["curve_spine", "in"]),
          curveEdge(["curve_spine", "out"], ["frames_spine", "points"]),
          ...sink.edges,
        ],
      );
      const schema = curveFramesAttributes({ frame: true, vectors: false, metrics: true });
      const curveSchema = curveAttributes([{ name: "position", type: "vec3f" }], parameters["basis"] as CurveBasis);
      return onDawn(graph, async (session) => ({
        cols,
        position: (await session.read("curve_spine", curveSchema, capacity, "position")).floats,
        length: Array.from((await session.read("frames_spine", schema, capacity, "curveLength")).floats),
        distance: Array.from((await session.read("frames_spine", schema, capacity, "distance")).floats),
        curvature: Array.from((await session.read("frames_spine", schema, capacity, "curvature")).floats),
      }));
    };

    const linear = await measured([[0, 0, 0], [3, 0, 0], [3, 4, 0]], { cols: 3, rows: 1 }, { basis: "linear", segments: 4 });
    expect(linear.length[0]).toBe(7);
    expect(linear.distance).toEqual([0, 0.75, 1.5, 2.25, 3, 4, 5, 6, 7]);

    const two: Vec3[] = [[0, 0, 0], [2, 0, 0], [0, 5, 0], [3, 5, 0]];
    const SEGMENTS = 16;
    const GIVEN = 4;
    const arcs = await measured(two, { cols: 2, rows: 2 }, { basis: "arc", segments: SEGMENTS, arcLength: GIVEN, bow: [0, 1, 0] });
    [2, 3].forEach((chord, strip) => {
      // φ from the chord and the length, by a bisection of this test's own.
      let low = 0;
      let high = Math.PI;
      for (let i = 0; i < 60; i += 1) {
        const mid = (low + high) / 2;
        if (Math.sin(mid) / mid > chord / GIVEN) low = mid;
        else high = mid;
      }
      const phi = (low + high) / 2;
      const step = phi / SEGMENTS;
      const first = strip * arcs.cols;
      // The circle: its centre is on the chord's bisector, R·cos φ from the chord, away from the bow.
      const radius = GIVEN / (2 * phi);
      const centre = [chord / 2, strip * 5 - radius * Math.cos(phi), 0];
      for (let k = 0; k <= SEGMENTS; k += 1) {
        expect(norm(minus(vecAt(arcs.position, first + k), centre)), `strip ${strip} station ${k} is on the circle`).toBeCloseTo(radius, 4);
      }
      close(vecAt(arcs.position, first + SEGMENTS), [chord, strip * 5, 0], `strip ${strip}: the arc ends on its far control point`);
      expect(arcs.length[first], `strip ${strip}: the polyline through ${SEGMENTS} stations of a ${GIVEN} m arc`).toBeCloseTo((GIVEN * Math.sin(step)) / step, 4);
      for (let k = 1; k < SEGMENTS; k += 1) {
        expect(arcs.curvature[first + k], `strip ${strip} station ${k} curvature`).toBeCloseTo((2 * phi) / GIVEN, 3);
        // Equal steps along the arc are equal chords.
        expect(arcs.distance[first + k]! - arcs.distance[first + k - 1]!).toBeCloseTo(arcs.length[first]! / SEGMENTS, 4);
      }
    });

    const spline = await measured(two, { cols: 2, rows: 2 }, { basis: "catmullRom", segments: SEGMENTS });
    expect(spline.length[0]).toBeCloseTo(2, 5);
    expect(spline.length[spline.cols]).toBeCloseTo(3, 5);
  }, 60_000);

  /**
   * NO POP (the shape of `src/projects/sentinel-bot/rig.gpu.test.ts`). One frame holds a
   * whole motion: every strip is one instant of an arc whose far end travels a path and
   * whose bow turns about the chord. A continuous motion's largest move shrinks with the
   * step it is sampled at; a pop does not — it is the same jump however finely you look.
   * So halving the step gives a ratio of 2 for a smooth arc and 1 for one that jumps.
   *
   * The bow here is KEPT OFF THE CHORD (it turns in the plane square to the chord's mean
   * direction). The control sweeps a bow THROUGH the chord with the ends held still: the
   * arc flips to the other side between two instants, and the ratio reads 1.
   */
  it("moves without a pop while the bow is kept off the chord: halve the step and the largest move halves", async () => {
    const SEGMENTS = 8;
    const motion = async (instants: number, sweptThroughChord: boolean): Promise<number> => {
      const controls: Vec3[] = [];
      const bows: number[][] = [];
      for (let i = 0; i < instants; i += 1) {
        const t = i / (instants - 1);
        if (sweptThroughChord) {
          // The ends hold still; the bow turns in the chord's own plane, through the chord.
          controls.push([0, 0, 0], [2, 0, 0]);
          const angle = -0.6 + 1.2 * t;
          bows.push([Math.cos(angle), Math.sin(angle), 0], [0, 1, 0]);
        } else {
          // The far end travels (the chord stays between 2.2 and 2.9, always short of the 3 m
          // arc); the bow turns a third of a turn about X, which the chord never leaves by much.
          controls.push([0, 0, 0], [2.2 + 0.6 * Math.sin(3 * t), 0.5 * t, 0.3 * Math.cos(2 * t) - 0.3]);
          const angle = (2 * Math.PI * t) / 3;
          bows.push([0, Math.cos(angle), Math.sin(angle)], [0, 1, 0]);
        }
      }
      const out = await curve(
        controls,
        { cols: 2, rows: instants },
        { basis: "arc", segments: SEGMENTS, arcLength: 3, bow: mappedTo("side", [0, 1, 0]) },
        [{ name: "side", type: "vec3f", values: bows }],
      );
      let largest = 0;
      for (let i = 0; i + 1 < instants; i += 1) {
        for (let k = 0; k <= SEGMENTS; k += 1) {
          largest = Math.max(largest, norm(minus(out.position[(i + 1) * out.cols + k]!, out.position[i * out.cols + k]!)));
        }
      }
      return largest;
    };

    const coarse = await motion(61, false);
    const fine = await motion(121, false);
    expect(coarse / fine).toBeGreaterThan(1.8);
    expect(coarse / fine).toBeLessThan(2.2);

    // THE CONTROL: a bow swept through the chord flips the arc's side between two instants.
    const coarseFlip = await motion(61, true);
    const fineFlip = await motion(121, true);
    expect(coarseFlip / fineFlip).toBeGreaterThan(0.9);
    expect(coarseFlip / fineFlip).toBeLessThan(1.1);
    // And the jump is the arc's whole bulge, twice over: far larger than any smooth step.
    expect(coarseFlip).toBeGreaterThan(10 * coarse);
  }, 120_000);
});

describe("Curve on Dawn — the reference, and the node's own table (T1586b D7)", () => {
  /** Irregular control points in space, every basis, open and closed: the GPU places what the CPU reference places. */
  it("agrees with the CPU reference on two unlike strips, basis by basis, open and closed", async () => {
    const stripA: Vec3[] = [[0, 0, 0], [1, 0.25, 0], [1.5, 1, 0.5], [1, 2, 1.5], [0, 2.5, 1], [-1, 2, 0]];
    const stripB: Vec3[] = [[4, 0, 0], [4, 1, 0], [5, 1, 1], [5, 3, 1], [3, 3, 2], [3, 0, -1]];
    const handleIn: Vec3[] = [[0, 0.2, 0], [-0.3, 0, 0.1], [0, -0.4, 0], [0.2, 0.2, 0], [0, 0, -0.5], [0.1, 0, 0]];
    const handleOut: Vec3[] = [[0.3, 0, 0], [0.2, 0.2, 0], [0, 0.5, 0.1], [-0.4, 0, 0], [0, -0.2, 0.2], [0, 0.3, 0]];
    const handles: AuthoredAttribute[] = [
      { name: "handleIn", type: "vec3f", values: [...handleIn, ...handleIn] },
      { name: "handleOut", type: "vec3f", values: [...handleOut, ...handleOut] },
    ];
    const cases: Array<{ parameters: Record<string, unknown>; options: Omit<CurveOptions, "closed"> }> = [
      { parameters: { basis: "linear", segments: 5 }, options: { basis: "linear", segments: 5 } },
      { parameters: { basis: "catmullRom", segments: 5 }, options: { basis: "catmullRom", segments: 5 } },
      { parameters: { basis: "cardinal", segments: 5, tension: 0.3 }, options: { basis: "cardinal", segments: 5, tension: 0.3 } },
      { parameters: { basis: "bspline", segments: 5 }, options: { basis: "bspline", segments: 5 } },
      { parameters: { basis: "bspline", segments: 5, clamped: false }, options: { basis: "bspline", segments: 5, clamped: false } },
      { parameters: { basis: "bezier", segments: 5 }, options: { basis: "bezier", segments: 5, handlesIn: handleIn, handlesOut: handleOut } },
      {
        parameters: { basis: "arc", segments: 5, arcLength: 1.4, arcLengthUnit: "chords", bow: [0.2, -1, 0.4], maxTurn: 200 },
        options: { basis: "arc", segments: 5, arcLength: 1.4, arcLengthUnit: "chords", bow: [0.2, -1, 0.4], maxTurn: (200 * Math.PI) / 180 },
      },
    ];
    for (const entry of cases) {
      for (const closed of [false, true]) {
        const out = await curve([...stripA, ...stripB], { cols: 6, rows: 2, closed }, entry.parameters, entry.options.basis === "bezier" ? handles : []);
        [stripA, stripB].forEach((strip, row) => {
          const expected = evaluateCurve(strip, { ...entry.options, closed });
          expect(out.cols, `${entry.options.basis} point count`).toBe(expected.length);
          expected.forEach((point, k) =>
            close(out.position[row * out.cols + k]!, point, `${JSON.stringify(entry.parameters)} ${closed ? "closed" : "open"} strip ${row} point ${k}`, 4),
          );
        });
      }
    }
  }, 180_000);

  /**
   * A curve typed into the node. What a CPU reader will evaluate (`authoredCurve` and the
   * reference) is what the GPU writes, and each control point's scale and roll are
   * published, blended along the span — 90 degrees and a scale of 2 at the second point.
   */
  it("a table is the curve its CPU reader evaluates, with scale and roll published", async () => {
    const parameters = { basis: "catmullRom", segments: 4, points: "[[0, 0, 0], [1, 2, 0, 2, 90], [3, 1, 1], [4, 4, 0, 0.5]]" };
    const authored = authoredCurve(parameters);
    if ("error" in authored) throw new Error(authored.error);
    const expected = evaluateCurve(authored.points.map((point) => point.position), authored.options);
    const capacity = expected.length;
    const sink = drawnTo("curve_path", capacity);
    const graph = curveGraph([curveNode("curve_path", "pointCurve", parameters), ...sink.nodes], sink.edges);
    const schema = curveAttributes(undefined, "catmullRom");
    await onDawn(graph, async (session) => {
      const position = (await session.read("curve_path", schema, capacity, "position")).floats;
      expect(capacity).toBe(13);
      expected.forEach((point, k) => close(vecAt(position, k), point, `point ${k}`));
      expect(vecAt(position, 4)).toEqual([1, 2, 0]);
      const scale = Array.from((await session.read("curve_path", schema, capacity, "scale")).floats);
      const roll = Array.from((await session.read("curve_path", schema, capacity, "roll")).floats);
      expect(scale).toEqual([1, 1.25, 1.5, 1.75, 2, 1.75, 1.5, 1.25, 1, 0.875, 0.75, 0.625, 0.5]);
      expect(roll).toEqual([0, 22.5, 45, 67.5, 90, 67.5, 45, 22.5, 0, 0, 0, 0, 0]);
    });
  }, 60_000);

  /**
   * THE WIRE CUT. The same node, with a table typed into it: wired, it draws the control
   * set's curve and the table is not read; with the wire cut, the table's curve appears.
   */
  it("a wired control set wins over the table; cut the wire and the table's curve appears", async () => {
    const parameters = { basis: "linear", segments: 2, points: "[[0, 9, 0], [4, 9, 0]]" };
    const wiredCurve = await curve([[0, 0, 0], [2, 0, 0]], { cols: 2, rows: 1 }, parameters);
    expect(wiredCurve.position).toEqual([[0, 0, 0], [1, 0, 0], [2, 0, 0]]);
    const sink = drawnTo("curve_spine", 3);
    const cut = curveGraph([curveNode("curve_spine", "pointCurve", parameters), ...sink.nodes], sink.edges);
    const schema = curveAttributes(undefined, "linear");
    const position = await onDawn(cut, async (session) => (await session.read("curve_spine", schema, 3, "position")).floats);
    expect([vecAt(position, 0), vecAt(position, 1), vecAt(position, 2)]).toEqual([[0, 9, 0], [2, 9, 0], [4, 9, 0]]);
  }, 60_000);

  /**
   * The chain the family is for: Curve → Resample → Curve Frames. A taut 4-metre Arc
   * resampled every half metre is nine rings at exact stations, each facing down the line.
   */
  it("Curve → Resample → Curve Frames: rings every half metre along a taut arc, exactly", async () => {
    const source = authoredPoints("kernel_control", [[0, 0, 0], [4, 0, 0]]);
    const sink = drawnTo("frames_rings", 12);
    const graph = curveGraph(
      [
        source.node,
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 2, rows: 1 }),
        curveNode("curve_spine", "pointCurve", { basis: "arc", segments: 8, arcLength: 4 }),
        curveNode("resample_rings", "pointResample", { method: "distance", distance: 0.5, maxPoints: 12 }),
        curveNode("frames_rings", "pointCurveFrames", { vectors: true }),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_control", "out"], ["topology_strips", "points"]),
        curveEdge(["topology_strips", "out"], ["curve_spine", "in"]),
        curveEdge(["curve_spine", "out"], ["resample_rings", "points"]),
        curveEdge(["resample_rings", "out"], ["frames_rings", "points"]),
        ...sink.edges,
      ],
    );
    await onDawn(graph, async (session) => {
      const rings = resampleAttributes([{ name: "position", type: "vec3f" }], true);
      const position = (await session.read("resample_rings", rings, 12, "position")).floats;
      const live = Array.from((await session.read("resample_rings", rings, 12, "live")).floats);
      expect(Array.from({ length: 12 }, (_, k) => position[k * 4])).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4, 4, 4]);
      expect(live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0]);
      const frames = curveFramesAttributes({ frame: true, vectors: true, metrics: true });
      const tangent = (await session.read("frames_rings", frames, 12, "tangent")).floats;
      for (let k = 0; k < 12; k += 1) expect(vecAt(tangent, k)).toEqual([1, 0, 0]);
    });
  }, 60_000);

  /**
   * §V170: the whole chain keeps nothing between frames, so frame N rendered on its own is
   * frame N after frames 0 to N−1, byte for byte. The control points move with the timeline
   * clock, so a Curve that read last frame's control points would show: rendered directly,
   * frame 5 would have nothing behind it to read.
   */
  it("seek: under moving control points, frame 5 rendered directly is frame 5 after frames 0 to 4, byte for byte", async () => {
    const MOVING = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // timeline-anchored: the fixture's position in the piece is the point of the test.
  let i = f32(ctx.index % 4u);
  q.position = vec3f(i, sin(ctx.time * 3.0 + i), f32(ctx.index / 4u));
  return q;
}`;
    const POSITION = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
    const sink = drawnTo("frames_spine", 24);
    const graph = curveGraph(
      [
        curveNode("kernel_control", "pointKernel", { capacity: 8, seed: 7, attributes: POSITION, kernel: MOVING }),
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 4, rows: 2 }),
        curveNode("curve_spine", "pointCurve", { basis: "catmullRom", segments: 4 }),
        curveNode("resample_rings", "pointResample", { method: "distance", distance: 0.4, maxPoints: 12 }),
        curveNode("frames_spine", "pointCurveFrames", { vectors: true }),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_control", "out"], ["topology_strips", "points"]),
        curveEdge(["topology_strips", "out"], ["curve_spine", "in"]),
        curveEdge(["curve_spine", "out"], ["resample_rings", "points"]),
        curveEdge(["resample_rings", "out"], ["frames_spine", "points"]),
        ...sink.edges,
      ],
    );
    const curveSchema = curveAttributes([{ name: "position", type: "vec3f" }], "catmullRom");
    const resampleSchema = resampleAttributes([{ name: "position", type: "vec3f" }], true);
    const framesSchema = curveFramesAttributes({ frame: true, vectors: true, metrics: true });
    const snapshot = async (session: CurveSession): Promise<number[]> => [
      ...(await session.read("curve_spine", curveSchema, 26, "position")).words,
      ...(await session.read("resample_rings", resampleSchema, 24, "position")).words,
      ...(await session.read("resample_rings", resampleSchema, 24, "live")).words,
      ...(await session.read("frames_spine", framesSchema, 24, "orient")).words,
      ...(await session.read("frames_spine", framesSchema, 24, "distance")).words,
    ];
    const direct = await onDawn(graph, snapshot, 16, 5);
    const played = await onDawn(graph, async (session) => {
      for (let frame = 1; frame <= 5; frame += 1) session.renderFrame(frame);
      return snapshot(session);
    });
    const still = await onDawn(graph, snapshot);
    expect(played).toEqual(direct);
    // The control: the control points really moved between frame 0 and frame 5.
    expect(still).not.toEqual(direct);
  }, 60_000);
});
