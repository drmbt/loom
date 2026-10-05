import { describe, expect, it } from "vitest";

import type { PointAttributeType } from "../../points/attributes.ts";
import { frameStrip, resampleStrip, type ResampleOptions, type Vec3 } from "../../points/curve.ts";
import {
  authoredPoints,
  curveEdge,
  curveGraph,
  curveNode,
  drawnTo,
  formulaPoints,
  onDawn,
  vecAt,
  type AuthoredAttribute,
  type CurveSession,
} from "./curve-test-support.ts";
import { curveAttributes } from "./point-curve.ts";
import { curveFramesAttributes } from "./point-curve-frames.ts";
import { resampleAttributes } from "./point-resample.ts";

/**
 * Resample (T1586b slice 4) on a real device, asserted on READ-BACK POINTS.
 *
 * ## The fixtures are arithmetically exact, on purpose (§V147)
 *
 * A line whose points sit on whole numbers has segments of length exactly 1, a cumulative
 * length of 0, 1, 2 … and stations at halves and quarters whose blend factors are exact in
 * f32. So there is no band to hide in: a station is at 1.5 or the test fails, and a `live`
 * flag is 1 or 0. Where the input is irregular the expectation is the CPU reference
 * (`points/curve.ts`), which is itself checked against hand values in its own test.
 *
 * Nothing here hands the node a count: points are authored by a kernel, a Topology node
 * claims the strips, and Resample reads the claim and the lengths off the GPU.
 */

const LINE_OF_FOUR: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [3, 0, 0], [4, 0, 0]];

interface Resampled {
  /** The input points, as the device holds them. */
  readonly source: Vec3[];
  readonly position: number[][];
  readonly x: number[];
  readonly live: number[] | undefined;
  readonly floats: (name: string) => Promise<Float32Array>;
}

type Strips = { readonly cols: number; readonly rows: number; readonly closed?: boolean };
type Also<T> = (read: (name: string) => Promise<{ floats: Float32Array; words: Uint32Array }>, result: Resampled) => Promise<T>;

/** authored points → Topology (Strips) → Resample; one frame on Dawn; the output read back. */
const resample = <T = Resampled>(
  positions: ReadonlyArray<Vec3>,
  strips: Strips,
  parameters: Record<string, unknown>,
  extras: ReadonlyArray<AuthoredAttribute> = [],
  also?: Also<T>,
): Promise<T> => resampleFrom(authoredPoints("kernel_source", positions, extras), strips, parameters, also);

/** A source of `strips` → Topology (Strips) → Resample; one frame on Dawn; the output read back. */
async function resampleFrom<T = Resampled>(
  source: ReturnType<typeof authoredPoints>,
  strips: Strips,
  parameters: Record<string, unknown>,
  also?: Also<T>,
): Promise<T> {
  // By Distance and by Curvature the strip is allocated Max Points slots and publishes live.
  const byDistance = parameters["method"] === "distance" || parameters["method"] === "curvature";
  const colsOut = Number(byDistance ? (parameters["maxPoints"] ?? 256) : (parameters["count"] ?? 64));
  const capacity = colsOut * strips.rows;
  const sink = drawnTo("resample_rings", capacity);
  const graph = curveGraph(
    [
      source.node,
      curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: strips.cols, rows: strips.rows, wrapU: strips.closed === true }),
      curveNode("resample_rings", "pointResample", parameters),
      ...sink.nodes,
    ],
    [curveEdge(["kernel_source", "out"], ["topology_strips", "points"]), curveEdge(["topology_strips", "out"], ["resample_rings", "points"]), ...sink.edges],
  );
  const schema = resampleAttributes(
    source.schema.map((entry) => ({ name: entry.name, type: entry.type as PointAttributeType })),
    byDistance,
  );
  return onDawn(graph, async (session) => {
    const read = (name: string) => session.read("resample_rings", schema, capacity, name);
    const floats = (await read("position")).floats;
    const position = Array.from({ length: capacity }, (_, index) => vecAt(floats, index));
    const count = strips.cols * strips.rows;
    const input = (await session.read("kernel_source", source.schema, count, "position")).floats;
    const result: Resampled = {
      source: Array.from({ length: count }, (_, index) => vecAt(input, index) as unknown as Vec3),
      position,
      x: position.map((point) => point[0] as number),
      live: byDistance ? Array.from((await read("live")).floats) : undefined,
      floats: async (name) => (await read(name)).floats,
    };
    return also === undefined ? (result as T) : also(read, result);
  });
}

describe("Resample on Dawn — by Distance, into a fixed allocation (T1586b D2)", () => {
  /**
   * A length of 4 at half-unit spacing is nine stations, 0 to 4. Sixteen slots are
   * allocated, so seven are spare: they REPEAT the last live station and are flagged 0.
   * Nothing downstream needs a count — the repeats are segments of no length (§V788).
   */
  it("a point every 0.5 over a length of 4: nine live, and the spare slots repeat the last one", async () => {
    const out = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { method: "distance", distance: 0.5, maxPoints: 16 });
    expect(out.x).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4, 4, 4, 4, 4, 4, 4]);
    expect(out.live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    for (const point of out.position) expect(point.slice(1)).toEqual([0, 0]);
  }, 60_000);

  /**
   * Anchored at the END the last slot is always on the curve's end — the claw reaches its
   * rung — and the spare slots collect at the HEAD, repeating the first live station. A
   * count could not say this: the live points are not a prefix even of one strip.
   */
  it("anchored at the End: the last slot is on the end and the padding is at the head", async () => {
    const out = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { method: "distance", distance: 0.75, maxPoints: 8, anchor: "end" });
    expect(out.x).toEqual([0.25, 0.25, 0.25, 1, 1.75, 2.5, 3.25, 4]);
    expect(out.live).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
  }, 60_000);

  /** D6: a strip that needs 41 stations and has 5 slots widens its spacing; it is not cut at 0.4. */
  it("over budget the spacing widens and the whole curve is still covered", async () => {
    const out = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { method: "distance", distance: 0.1, maxPoints: 5 });
    expect(out.x).toEqual([0, 1, 2, 3, 4]);
    expect(out.live).toEqual([1, 1, 1, 1, 1]);
  }, 60_000);

  it("Offset slides every station by exactly that much, and the one pushed off the end stops being live", async () => {
    const out = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { method: "distance", distance: 0.5, maxPoints: 12, offset: 0.25 });
    expect(out.x.slice(0, 8)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75, 3.25, 3.75]);
    expect(out.live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
    // The spare slots repeat the last LIVE station (3.75), not the curve's end.
    expect(out.x.slice(8)).toEqual([3.75, 3.75, 3.75, 3.75]);
  }, 60_000);

  /** A closed strip counts its closing side, and its stations go round: eight on a unit square. */
  it("a closed unit square at 0.5: the corners and the edge midpoints, and the last side is the closing one", async () => {
    const square: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]];
    const out = await resample(square, { cols: 4, rows: 1, closed: true }, { method: "distance", distance: 0.5, maxPoints: 12 });
    expect(out.position.slice(0, 8)).toEqual([
      [0, 0, 0], [0.5, 0, 0], [1, 0, 0], [1, 0.5, 0], [1, 1, 0], [0.5, 1, 0], [0, 1, 0], [0, 0.5, 0],
    ]);
    expect(out.live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0]);
    for (const spare of [8, 9, 10, 11]) expect(out.position[spare]).toEqual([0, 0.5, 0]);
  }, 60_000);

  it("two strips of different length in one pointset each get their own live run", async () => {
    const long: Vec3[] = [[0, 0, 0], [1, 0, 0], [2, 0, 0], [4, 0, 0]];
    const short: Vec3[] = [[0, 5, 0], [0.5, 5, 0], [1, 5, 0], [2, 5, 0]];
    const out = await resample([...long, ...short], { cols: 4, rows: 2 }, { method: "distance", distance: 0.5, maxPoints: 10 });
    expect(out.live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]);
    expect(out.x.slice(0, 10)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4]);
    expect(out.x.slice(10)).toEqual([0, 0.5, 1, 1.5, 2, 2, 2, 2, 2, 2]);
    // The second strip stayed on its own line: no station read the first strip's points.
    for (const point of out.position.slice(10)) expect(point[1]).toBe(5);
  }, 60_000);
});

describe("Resample on Dawn — by Count (T1586b section 3.3)", () => {
  const UNEVEN: Vec3[] = [[0, 0, 0], [1, 0, 0], [4, 0, 0]];

  /**
   * Notch's Length and Knots, on a strip whose two segments are 1 and 3 long. Even Length
   * steps evenly in metres; Even Parameter gives each segment the same number of new
   * points, so they bunch on the short one.
   */
  it("Even Length is even in metres; Even Parameter is even in the input's own points", async () => {
    const byLength = await resample(UNEVEN, { cols: 3, rows: 1 }, { method: "count", count: 5, spacing: "length" });
    expect(byLength.x).toEqual([0, 1, 2, 3, 4]);
    const byParameter = await resample(UNEVEN, { cols: 3, rows: 1 }, { method: "count", count: 5, spacing: "parameter" });
    expect(byParameter.x).toEqual([0, 0.5, 1, 2.5, 4]);
    expect(byLength.live).toBeUndefined();
  }, 60_000);

  it("Range uses part of the strip: a quarter to three quarters of a length of 4 is 1, 2, 3", async () => {
    const out = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { method: "count", count: 3, rangeStart: 0.25, rangeEnd: 0.75 });
    expect(out.x).toEqual([1, 2, 3]);
    // Animated from the start, the same control draws the curve on: half of it is 0, 1, 2.
    const half = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { method: "count", count: 3, rangeEnd: 0.5 });
    expect(half.x).toEqual([0, 1, 2]);
  }, 60_000);

  /**
   * Float attributes are interpolated with the points; an integer takes the EARLIER
   * point's, because a blend of two ids is not an id. The weight runs 0 to 8 over a length
   * of 4, so it reads exactly twice the x it sits at.
   */
  it("carries every attribute: floats blend exactly, an integer takes the earlier point's", async () => {
    const ends: Vec3[] = [[0, 0, 0], [4, 0, 0]];
    const extras: AuthoredAttribute[] = [
      { name: "weight", type: "f32", values: [0, 8] },
      { name: "tint", type: "vec4f", values: [[1, 0, 0, 1], [0, 1, 0, 0]] },
      { name: "tag", type: "u32", values: [7, 9] },
    ];
    const out = await resample(ends, { cols: 2, rows: 1 }, { method: "count", count: 5 }, extras, async (read, result) => ({
      x: result.x,
      weight: Array.from((await read("weight")).floats),
      tintFloats: (await read("tint")).floats,
      tag: Array.from((await read("tag")).words),
    }));
    expect(out.x).toEqual([0, 1, 2, 3, 4]);
    expect(out.weight).toEqual([0, 2, 4, 6, 8]);
    expect(vecAt(out.tintFloats, 1, 4)).toEqual([0.75, 0.25, 0, 0.75]);
    expect(vecAt(out.tintFloats, 2, 4)).toEqual([0.5, 0.5, 0, 0.5]);
    expect(vecAt(out.tintFloats, 4, 4)).toEqual([0, 1, 0, 0]);
    // Stations 0 to 3 are on the first segment; the last one sits on the second point itself.
    expect(out.tag).toEqual([7, 7, 7, 7, 9]);
  }, 60_000);
});

describe("Resample on Dawn — padding in, the reference, and the chain (T1586b)", () => {
  /**
   * §V788 from the consuming side: a strip that arrives PADDED (a Resample by Distance
   * upstream) is resampled as if the padding were not there, because a segment of no
   * length holds no station. The second node reads no count and no `live`.
   */
  it("a padded strip resamples like the bare one", async () => {
    const source = authoredPoints("kernel_source", LINE_OF_FOUR);
    const sink = drawnTo("resample_even", 5);
    const graph = curveGraph(
      [
        source.node,
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 5, rows: 1 }),
        curveNode("resample_padded", "pointResample", { method: "distance", distance: 0.75, maxPoints: 12, anchor: "end" }),
        curveNode("resample_even", "pointResample", { method: "count", count: 5 }),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_source", "out"], ["topology_strips", "points"]),
        curveEdge(["topology_strips", "out"], ["resample_padded", "points"]),
        curveEdge(["resample_padded", "out"], ["resample_even", "points"]),
        ...sink.edges,
      ],
    );
    const x = await onDawn(graph, async (session) => {
      // The second Resample publishes no `live` of its own, and must not carry the first one's.
      const schema = resampleAttributes([{ name: "position", type: "vec3f" }], false);
      const floats = (await session.read("resample_even", schema, 5, "position")).floats;
      return Array.from({ length: 5 }, (_, index) => floats[index * 4] as number);
    });
    // The padded strip's live part runs from 0.25 to 4: five even stations over 3.75.
    expect(x).toEqual([0.25, 1.1875, 2.125, 3.0625, 4]);
  }, 60_000);

  /** Irregular strips in space, every method: the GPU places what the CPU reference places. */
  it("agrees with the CPU reference on irregular strips, method by method", async () => {
    const stripA: Vec3[] = [[0, 0, 0], [1, 0.25, 0], [1.5, 1, 0.5], [1, 2, 1.5], [0, 2.5, 1], [-1, 2, 0]];
    const stripB: Vec3[] = [[4, 0, 0], [4, 1, 0], [5, 1, 1], [5, 3, 1], [3, 3, 2], [3, 0, -1]];
    const cases: Array<{ parameters: Record<string, unknown>; options: Omit<ResampleOptions, "closed">; closed?: boolean }> = [
      { parameters: { method: "count", count: 9 }, options: { method: "count", spacing: "length", slots: 9 } },
      { parameters: { method: "count", count: 9, spacing: "parameter", rangeStart: 0.1, rangeEnd: 0.9 }, options: { method: "count", spacing: "parameter", slots: 9, rangeStart: 0.1, rangeEnd: 0.9 } },
      { parameters: { method: "distance", distance: 0.7, maxPoints: 24, offset: 0.2 }, options: { method: "distance", slots: 24, distance: 0.7, offset: 0.2 } },
      { parameters: { method: "distance", distance: 0.7, maxPoints: 24, anchor: "end", rangeStart: 0.2 }, options: { method: "distance", slots: 24, distance: 0.7, anchor: "end", rangeStart: 0.2 } },
      { parameters: { method: "distance", distance: 0.9, maxPoints: 24, offset: 0.4 }, options: { method: "distance", slots: 24, distance: 0.9, offset: 0.4 }, closed: true },
      { parameters: { method: "count", count: 7, offset: 1.3 }, options: { method: "count", spacing: "length", slots: 7, offset: 1.3 }, closed: true },
    ];
    for (const entry of cases) {
      const closed = entry.closed === true;
      const out = await resample([...stripA, ...stripB], { cols: 6, rows: 2, closed }, entry.parameters);
      const slots = entry.options.slots;
      [stripA, stripB].forEach((strip, row) => {
        const expected = resampleStrip(strip, { ...entry.options, closed });
        for (let k = 0; k < slots; k += 1) {
          const what = `${JSON.stringify(entry.parameters)} strip ${row} slot ${k}`;
          expected.positions[k]!.forEach((value, axis) => expect(out.position[row * slots + k]![axis], what).toBeCloseTo(value, 4));
          if (out.live !== undefined) expect(out.live[row * slots + k], `${what} live`).toBe(expected.live[k]);
        }
      });
    }
  }, 120_000);

  /**
   * "The tip of every tentacle" as a pointset: a Count of 1 on the END of the range, after
   * Curve Frames. A station exactly on an input point copies its words untouched, so the
   * tip is the strip's last point TO THE BIT, frame and all.
   */
  it("Count 1 at the end of the range is each strip's last point, bit for bit, with its frame", async () => {
    const stripA: Vec3[] = [[0, 0, 0], [1, 0.25, 0], [1.5, 1, 0.5], [1, 2, 1.5]];
    const stripB: Vec3[] = [[4, 0, 0], [4, 1, 0], [5, 1, 1], [5, 3, 1]];
    const source = authoredPoints("kernel_source", [...stripA, ...stripB]);
    const sink = drawnTo("resample_tip", 2);
    const graph = curveGraph(
      [
        source.node,
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 4, rows: 2 }),
        curveNode("frames_spine", "pointCurveFrames"),
        curveNode("resample_tip", "pointResample", { method: "count", count: 1, rangeStart: 1, rangeEnd: 1 }),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_source", "out"], ["topology_strips", "points"]),
        curveEdge(["topology_strips", "out"], ["frames_spine", "points"]),
        curveEdge(["frames_spine", "out"], ["resample_tip", "points"]),
        ...sink.edges,
      ],
    );
    const measured = curveFramesAttributes({ frame: true, vectors: false, metrics: true });
    const tipSchema = resampleAttributes(
      [{ name: "position", type: "vec3f" }, ...measured.map((entry) => ({ name: entry.name, type: entry.type }))],
      false,
    );
    await onDawn(graph, async (session) => {
      for (const attribute of measured) {
        const source = (await session.read("frames_spine", measured, 8, attribute.name)).words;
        const tip = (await session.read("resample_tip", tipSchema, 2, attribute.name)).words;
        const stride = source.length / 8;
        for (const strip of [0, 1]) {
          const last = strip * 4 + 3;
          expect(Array.from(tip.subarray(strip * stride, (strip + 1) * stride)), `${attribute.name} of strip ${strip}`).toEqual(
            Array.from(source.subarray(last * stride, (last + 1) * stride)),
          );
        }
      }
      const position = (await session.read("resample_tip", tipSchema, 2, "position")).floats;
      expect(vecAt(position, 0)).toEqual([1, 2, 1.5]);
      expect(vecAt(position, 1)).toEqual([5, 3, 1]);
    });
  }, 60_000);

  /**
   * §V170: the family keeps nothing between frames, so frame N rendered on its own is frame
   * N after frames 0 to N−1, byte for byte. The source moves with the timeline clock, so a
   * stale buffer would show.
   */
  it("seek: frame 5 rendered directly is frame 5 after frames 0 to 4, byte for byte", async () => {
    const MOVING = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // timeline-anchored: the fixture's position in the piece is the point of the test.
  let i = f32(ctx.index % 6u);
  q.position = vec3f(i * 0.5, sin(ctx.time * 3.0 + i), f32(ctx.index / 6u));
  return q;
}`;
    const POSITION = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);
    const sink = drawnTo("frames_spine", 20);
    const graph = curveGraph(
      [
        curveNode("kernel_source", "pointKernel", { capacity: 12, seed: 7, attributes: POSITION, kernel: MOVING }),
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 6, rows: 2 }),
        curveNode("resample_rings", "pointResample", { method: "distance", distance: 0.4, maxPoints: 10 }),
        curveNode("frames_spine", "pointCurveFrames", { vectors: true }),
        ...sink.nodes,
      ],
      [
        curveEdge(["kernel_source", "out"], ["topology_strips", "points"]),
        curveEdge(["topology_strips", "out"], ["resample_rings", "points"]),
        curveEdge(["resample_rings", "out"], ["frames_spine", "points"]),
        ...sink.edges,
      ],
    );
    const framesSchema = curveFramesAttributes({ frame: true, vectors: true, metrics: true });
    const resampleSchema = resampleAttributes([{ name: "position", type: "vec3f" }], true);
    const snapshot = async (session: CurveSession): Promise<number[]> => [
      ...(await session.read("resample_rings", resampleSchema, 20, "position")).words,
      ...(await session.read("resample_rings", resampleSchema, 20, "live")).words,
      ...(await session.read("frames_spine", framesSchema, 20, "orient")).words,
      ...(await session.read("frames_spine", framesSchema, 20, "distance")).words,
    ];
    const direct = await onDawn(graph, snapshot, 16, 5);
    const played = await onDawn(graph, async (session) => {
      for (let frame = 1; frame <= 5; frame += 1) session.renderFrame(frame);
      return snapshot(session);
    });
    const still = await onDawn(graph, snapshot);
    expect(played).toEqual(direct);
    // The control: the source really moved between frame 0 and frame 5.
    expect(still).not.toEqual(direct);
  }, 60_000);
});

/**
 * T1586b slice 6 — INPUT STRIPS LONGER THAN ONE BLOCK.
 *
 * Past 1,024 points a strip's lengths are taken by many walks at once: every block sums
 * itself, one pass per strip turns the sums into each block's start, and every point adds
 * its block's start (`nodes/shaders/curve-resample.wgsl.ts`). The emit pass reads the same
 * distances either way. So what is held here is that a station which falls in a later
 * block is found where it belongs: exactly, on a line whose numbers are exact, and against
 * the reference in its blocked order on curves with padding laid across the seams.
 */
describe("Resample on Dawn — input strips longer than one block (T1586b slice 6)", () => {
  /**
   * Half-unit steps along +X for 2,500 points, 1,249.5 long: three blocks. Every length is
   * a multiple of a half below 2²⁴, so each block's sum, each block's start (512, 1,024)
   * and their sums with a point's distance inside its block are all exact, and a station at
   * a multiple of 2.5 lands ON an input point and copies it.
   */
  it("a point every 2.5 along 2,500 points of line: 500 stations, exactly, through both seams", async () => {
    const line = formulaPoints("kernel_source", 2500, "  q.position = vec3f(f32(i) * 0.5, 0.0, 0.0);");
    const out = await resampleFrom(line, { cols: 2500, rows: 1 }, { method: "distance", distance: 2.5, maxPoints: 512 });
    expect(out.x).toEqual(Array.from({ length: 512 }, (_, k) => Math.min(k, 499) * 2.5));
    expect(out.live).toEqual(Array.from({ length: 512 }, (_, k) => (k < 500 ? 1 : 0)));
    // By Count, five points at the quarters of the length: between input points, in three blocks.
    const quarters = await resampleFrom(line, { cols: 2500, rows: 1 }, { method: "count", count: 5 });
    expect(quarters.position).toEqual([[0, 0, 0], [312.375, 0, 0], [624.75, 0, 0], [937.125, 0, 0], [1249.5, 0, 0]]);
  }, 120_000);

  /**
   * A curve with no symmetry, 3,500 points a strip, with padding where the seams are: a run
   * of coincident points across the seam at 1,024, a run that fills the whole third block,
   * and a padded tail. Two strips, so a block's start is found by strip as well as by block.
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

  it("agrees with the blocked reference on two unlike strips with padding across the seams", async () => {
    const wander = formulaPoints("kernel_source", 7000, WANDER);
    const cases: Array<{ parameters: Record<string, unknown>; options: Omit<ResampleOptions, "closed"> }> = [
      { parameters: { method: "count", count: 300 }, options: { method: "count", spacing: "length", slots: 300 } },
      {
        parameters: { method: "distance", distance: 0.07, maxPoints: 900, anchor: "end", offset: 0.02, rangeStart: 0.1, rangeEnd: 0.95 },
        options: { method: "distance", slots: 900, distance: 0.07, anchor: "end", offset: 0.02, rangeStart: 0.1, rangeEnd: 0.95 },
      },
    ];
    for (const entry of cases) {
      for (const closed of [false, true]) {
        const out = await resampleFrom(wander, { cols: 3500, rows: 2, closed }, entry.parameters);
        const cols = entry.options.slots;
        for (const strip of [0, 1]) {
          const expected = resampleStrip(out.source.slice(strip * 3500, (strip + 1) * 3500), { ...entry.options, closed });
          expected.positions.forEach((point, k) => {
            point.forEach((value, axis) =>
              expect(out.position[strip * cols + k]![axis], `${JSON.stringify(entry.parameters)} ${closed ? "closed" : "open"} strip ${strip} slot ${k} axis ${axis}`).toBeCloseTo(value, 4),
            );
          });
          if (out.live !== undefined) expect(out.live.slice(strip * cols, (strip + 1) * cols)).toEqual(expected.live);
        }
      }
    }
  }, 240_000);

  /**
   * The family end to end on long strips: a Curve typed into the node (six points at 512
   * segments: 2,561 points), resampled to a point every 5 cm into 1,500 slots, and measured.
   * Each stage is held to the reference run on what the stage before it WROTE, so an error
   * has one place to be.
   */
  it("Curve → Resample → Curve Frames with every strip longer than a block", async () => {
    const curve = { basis: "catmullRom", segments: 512, points: "[[0, 0, 0], [3, 1, 0], [5, 4, 2], [2, 6, 3], [-1, 4, 5], [-2, 0, 6]]" };
    const sink = drawnTo("frames_rings", 1500);
    const graph = curveGraph(
      [
        curveNode("curve_path", "pointCurve", curve),
        curveNode("resample_rings", "pointResample", { method: "distance", distance: 0.05, maxPoints: 1500 }),
        curveNode("frames_rings", "pointCurveFrames", { vectors: true }),
        ...sink.nodes,
      ],
      [curveEdge(["curve_path", "out"], ["resample_rings", "points"]), curveEdge(["resample_rings", "out"], ["frames_rings", "points"]), ...sink.edges],
    );
    await onDawn(graph, async (session) => {
      const vectors = (floats: Float32Array, count: number): Vec3[] => Array.from({ length: count }, (_, index) => vecAt(floats, index) as unknown as Vec3);
      const path = vectors((await session.read("curve_path", curveAttributes(undefined, "catmullRom"), 2561, "position")).floats, 2561);
      const ringSchema = resampleAttributes([{ name: "position", type: "vec3f" }, { name: "roll", type: "f32" }, { name: "scale", type: "f32" }], true);
      const rings = vectors((await session.read("resample_rings", ringSchema, 1500, "position")).floats, 1500);
      const live = Array.from((await session.read("resample_rings", ringSchema, 1500, "live")).floats);
      const placed = resampleStrip(path, { closed: false, method: "distance", slots: 1500, distance: 0.05 });
      expect(live).toEqual(placed.live);
      // A curve through its control points is at least as long as the chords between them
      // (19.39 m), so at 5 cm it has more than 387 rings — and fewer than its 1,500 slots.
      const ringCount = live.reduce((sum, flag) => sum + flag, 0);
      expect(ringCount).toBeGreaterThan(387);
      expect(ringCount).toBeLessThan(1500);
      placed.positions.forEach((point, k) => point.forEach((value, axis) => expect(rings[k]![axis], `ring ${k} axis ${axis}`).toBeCloseTo(value, 4)));

      const frameSchema = curveFramesAttributes({ frame: true, vectors: true, metrics: true });
      const expected = frameStrip(rings, { closed: false, method: "minimiseTwist", up: [0, 1, 0] });
      const tangent = (await session.read("frames_rings", frameSchema, 1500, "tangent")).floats;
      const normal = (await session.read("frames_rings", frameSchema, 1500, "normal")).floats;
      const distance = (await session.read("frames_rings", frameSchema, 1500, "distance")).floats;
      for (let k = 0; k < 1500; k += 1) {
        expected.tangent[k]!.forEach((value, axis) => expect(vecAt(tangent, k)[axis], `tangent ${k}`).toBeCloseTo(value, 4));
        expected.normal[k]!.forEach((value, axis) => expect(vecAt(normal, k)[axis], `normal ${k}`).toBeCloseTo(value, 4));
        expect(distance[k], `distance ${k}`).toBeCloseTo(expected.distance[k]!, 4);
      }
      // What the chain is for: the live rings are 5 cm apart along the curve.
      expect(distance[ringCount - 1]! / ((ringCount - 1) * 0.05)).toBeCloseTo(1, 3);
    });
  }, 120_000);

  /**
   * §V170, with scratch in it: the blocks' starts live in a buffer that outlasts the frame.
   * Frame 5 rendered on its own is frame 5 after frames 0 to 4, byte for byte.
   */
  it("seek: under a moving long curve, frame 5 rendered directly is frame 5 after frames 0 to 4", async () => {
    const moving = formulaPoints(
      "kernel_source",
      3000,
      // timeline-anchored: the fixture's position in the piece is the point of the test.
      "  let t = f32(i % 1500u) * 0.01;\n  q.position = vec3f(t * 2.0, sin(ctx.time * 3.0 + t), cos(t * 1.3 + ctx.time) + f32(i / 1500u));",
    );
    const sink = drawnTo("resample_rings", 800);
    const graph = curveGraph(
      [
        moving.node,
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 1500, rows: 2 }),
        curveNode("resample_rings", "pointResample", { method: "distance", distance: 0.1, maxPoints: 400 }),
        ...sink.nodes,
      ],
      [curveEdge(["kernel_source", "out"], ["topology_strips", "points"]), curveEdge(["topology_strips", "out"], ["resample_rings", "points"]), ...sink.edges],
    );
    const schema = resampleAttributes([{ name: "position", type: "vec3f" }], true);
    const snapshot = async (session: CurveSession): Promise<number[]> => [
      ...(await session.read("resample_rings", schema, 800, "position")).words,
      ...(await session.read("resample_rings", schema, 800, "live")).words,
    ];
    const direct = await onDawn(graph, snapshot, 16, 5);
    const played = await onDawn(graph, async (session) => {
      for (let frame = 1; frame <= 5; frame += 1) session.renderFrame(frame);
      return snapshot(session);
    });
    const still = await onDawn(graph, snapshot);
    expect(played).toEqual(direct);
    // The control: the curve really moved between frame 0 and frame 5.
    expect(still).not.toEqual(direct);
  }, 120_000);
});

/**
 * T1586b slice 7 — RESAMPLE BY CURVATURE on a real device.
 *
 * The method READS how a strip turns from an f32 attribute, so the first tests write that
 * attribute by hand onto a straight line: the arithmetic is then exact, and a spacing is
 * the Max, the Min, or the root of a quadratic a person can write down. Then the real
 * chain — a polygon, measured by Curve Frames, resampled — and the reference on strips
 * with no symmetry.
 */
describe("Resample on Dawn — by Curvature: closer together where the strip turns (T1586b slice 7)", () => {
  const SHARP = 1000;
  const curved = { method: "curvature", minDistance: 0.125, maxDistance: 0.5, bias: 0.5 };
  const turning = (values: number[]): AuthoredAttribute => ({ name: "curvature", type: "f32", values });

  it("a straight is a point every Max Distance, a strip that turns hard everywhere a point every Min — exactly", async () => {
    const straight = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { ...curved, maxPoints: 16 }, [turning([0, 0, 0, 0, 0])]);
    expect(straight.x).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4, 4, 4, 4, 4, 4, 4]);
    expect(straight.live).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0]);
    const tight = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { ...curved, maxPoints: 40 }, [turning([SHARP, SHARP, SHARP, SHARP, SHARP])]);
    expect(tight.x.slice(0, 33)).toEqual(Array.from({ length: 33 }, (_, k) => k * 0.125));
    expect(tight.live).toEqual(Array.from({ length: 40 }, (_, k) => (k < 33 ? 1 : 0)));
  }, 60_000);

  /**
   * Straight for a metre, one segment in which the density climbs from 2 a metre to 8, then
   * hard-turning to the end. The climbing segment is worth (2 + 8) ÷ 2 = 5 points, and a
   * station s points into it is t of the way along where 2t + 3t² = s: t = 2s ÷ (2 + √(4 +
   * 12s)). A mark that is ten times x at every input point reads ten times x at every
   * station, so every attribute was read at the same place the position was.
   */
  it("where the density climbs along a segment the stations close up by the quadratic's root, attributes with them", async () => {
    const out = await resample(
      LINE_OF_FOUR,
      { cols: 5, rows: 1 },
      { ...curved, maxPoints: 32 },
      [turning([0, 0, SHARP, SHARP, SHARP]), { name: "mark", type: "f32", values: [0, 10, 20, 30, 40] }],
      async (read, result) => ({ ...result, mark: Array.from((await read("mark")).floats) }),
    );
    expect(out.live).toEqual(Array.from({ length: 32 }, (_, k) => (k < 24 ? 1 : 0)));
    expect(out.x.slice(0, 3)).toEqual([0, 0.5, 1]);
    for (const s of [1, 2, 3, 4]) expect(out.x[2 + s], `station ${s} of the climb`).toBeCloseTo(1 + (2 * s) / (2 + Math.sqrt(4 + 12 * s)), 5);
    expect(out.x[7]).toBe(2);
    expect(out.x.slice(7, 24)).toEqual(Array.from({ length: 17 }, (_, k) => 2 + k * 0.125));
    out.x.forEach((x, k) => expect(out.mark[k], `mark at slot ${k}`).toBeCloseTo(10 * x, 4));
  }, 60_000);

  /**
   * The Range is a share of the strip's LENGTH and the Offset is metres, as for every
   * method: half way along this strip is x = 2, though half its points are spent by 2.56.
   * Over budget, every spacing widens together and the strip is still covered to its end.
   */
  it("the Range is a share of the length, the Offset is metres, and over budget the strip is still covered", async () => {
    const extras = [turning([0, 0, SHARP, SHARP, SHARP])];
    const half = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { ...curved, maxPoints: 32, rangeStart: 0.5 }, extras);
    expect(half.x.slice(0, 3)).toEqual([2, 2.125, 2.25]);
    expect(half.live!.reduce((sum, flag) => sum + flag, 0)).toBe(17);
    const slid = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { ...curved, maxPoints: 32, offset: 0.5 }, extras);
    expect(slid.x.slice(0, 2)).toEqual([0.5, 1]);
    expect(slid.x[2]).toBeCloseTo(1 + 1 / 3, 5);
    const fromEnd = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { ...curved, maxPoints: 32, anchor: "end" }, extras);
    expect(fromEnd.x.slice(30)).toEqual([3.875, 4]);
    expect(fromEnd.live!.slice(0, 9)).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1]);
    const tight = await resample(LINE_OF_FOUR, { cols: 5, rows: 1 }, { ...curved, maxPoints: 5 }, [turning([0, 0, 0, 0, 0])]);
    expect(tight.x).toEqual([0, 1, 2, 3, 4]);
    expect(tight.live).toEqual([1, 1, 1, 1, 1]);
  }, 60_000);

  /**
   * THE REAL CHAIN, and the wire cut. A 64-gon of radius 2, closed, measured by Curve
   * Frames: every corner sits on that circle, so its curvature reads one half. At a tenth
   * of a radian a point that is a point every 0.2 m of perimeter — 62 of them — and
   * neighbours are 0.2 m apart along the polygon, so at most a quarter of a millimetre less
   * in a straight line across one of its corners.
   *
   * Point the node at an attribute that is zero instead and the same curve is a point
   * every Max Distance: the spacing came from the curvature, through the attribute.
   */
  it("a circle measured by Curve Frames is a point every turn's worth of arc; read a flat attribute and it is every Max Distance", async () => {
    const polygon: Vec3[] = Array.from({ length: 64 }, (_, i) => [2 * Math.cos((i * Math.PI) / 32), 2 * Math.sin((i * Math.PI) / 32), 0] as Vec3);
    const along = async (curvatureAttribute: string): Promise<{ live: number; gaps: number[] }> => {
      const source = authoredPoints("kernel_source", polygon, [{ name: "flat", type: "f32", values: polygon.map(() => 0) }]);
      const sink = drawnTo("resample_rings", 80);
      const graph = curveGraph(
        [
          source.node,
          curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 64, rows: 1, wrapU: true }),
          curveNode("frames_measure", "pointCurveFrames", { frame: false }),
          curveNode("resample_rings", "pointResample", { method: "curvature", minDistance: 0.02, maxDistance: 0.5, bias: 0.5, maxPoints: 80, curvatureAttribute }),
          ...sink.nodes,
        ],
        [
          curveEdge(["kernel_source", "out"], ["topology_strips", "points"]),
          curveEdge(["topology_strips", "out"], ["frames_measure", "points"]),
          curveEdge(["frames_measure", "out"], ["resample_rings", "points"]),
          ...sink.edges,
        ],
      );
      const schema = resampleAttributes(
        [
          { name: "position", type: "vec3f" },
          { name: "flat", type: "f32" },
          { name: "distance", type: "f32" },
          { name: "curveU", type: "f32" },
          { name: "curveLength", type: "f32" },
          { name: "curvature", type: "f32" },
        ],
        true,
      );
      return onDawn(graph, async (session) => {
        const position = (await session.read("resample_rings", schema, 80, "position")).floats;
        const live = Array.from((await session.read("resample_rings", schema, 80, "live")).floats).reduce((sum, flag) => sum + flag, 0);
        const gaps: number[] = [];
        for (let k = 0; k + 1 < live; k += 1) {
          const a = vecAt(position, k);
          const b = vecAt(position, k + 1);
          gaps.push(Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!));
        }
        return { live, gaps };
      });
    };
    const turned = await along("curvature");
    expect(turned.live).toBe(62);
    turned.gaps.forEach((gap, k) => expect(gap, `stations ${k} and ${k + 1}`).toBeCloseTo(0.2, 3));
    // The perimeter is 12.56 m: 25 whole steps of the Max Distance.
    const flat = await along("flat");
    expect(flat.live).toBe(25);
    flat.gaps.forEach((gap, k) => expect(gap, `flat stations ${k} and ${k + 1}`).toBeCloseTo(0.5, 2));
  }, 60_000);

  /** Curvature with no pattern on strips with no symmetry: the device places what the CPU reference places. */
  it("agrees with the CPU reference on two unlike strips, open and closed, from either end", async () => {
    const stripA: Vec3[] = [[0, 0, 0], [1, 0.25, 0], [1.5, 1, 0.5], [1, 2, 1.5], [0, 2.5, 1], [-1, 2, 0]];
    const stripB: Vec3[] = [[4, 0, 0], [4, 1, 0], [5, 1, 1], [5, 3, 1], [3, 3, 2], [3, 0, -1]];
    const turns = [0.05, 0.9, 0.3, 2.5, 0.01, 0.6, 1.2, 0, 0.4, 3, 0.2, 0.7];
    const cases: Array<{ parameters: Record<string, unknown>; options: Omit<ResampleOptions, "closed" | "curvature"> }> = [
      {
        parameters: { method: "curvature", minDistance: 0.05, maxDistance: 0.6, bias: 0.4, maxPoints: 96 },
        options: { method: "curvature", minDistance: 0.05, maxDistance: 0.6, bias: 0.4, slots: 96 },
      },
      {
        parameters: { method: "curvature", minDistance: 0.1, maxDistance: 0.4, bias: 0.6, maxPoints: 64, anchor: "end", offset: 0.07, rangeStart: 0.15, rangeEnd: 0.9 },
        options: { method: "curvature", minDistance: 0.1, maxDistance: 0.4, bias: 0.6, slots: 64, anchor: "end", offset: 0.07, rangeStart: 0.15, rangeEnd: 0.9 },
      },
    ];
    for (const entry of cases) {
      for (const closed of [false, true]) {
        const out = await resample([...stripA, ...stripB], { cols: 6, rows: 2, closed }, entry.parameters, [turning(turns)]);
        const cols = entry.options.slots;
        [stripA, stripB].forEach((strip, row) => {
          const expected = resampleStrip(strip, { ...entry.options, closed, curvature: turns.slice(row * 6, row * 6 + 6) });
          expect(out.live!.slice(row * cols, (row + 1) * cols), `${closed ? "closed" : "open"} strip ${row} live`).toEqual(expected.live);
          expected.positions.forEach((point, k) =>
            point.forEach((value, axis) =>
              expect(out.position[row * cols + k]![axis], `${JSON.stringify(entry.parameters)} ${closed ? "closed" : "open"} strip ${row} slot ${k}`).toBeCloseTo(value, 4),
            ),
          );
        });
      }
    }
  }, 120_000);

  /**
   * Strips longer than one block are measured by many walks at once. Half-unit steps along
   * +X for 2,500 points with no curvature, and a Max Distance of 2: half a point a metre,
   * so every sum is a multiple of a quarter and a station every 2 m lands on an input
   * point in every block, exactly. And on a curve with no symmetry and a curvature of its
   * own, with padding across the seams, the device agrees with the reference in its
   * blocked order.
   */
  it("input strips longer than one block: exact along a line through both seams, and the reference on a padded curve", async () => {
    const line = formulaPoints("kernel_source", 2500, "  q.position = vec3f(f32(i) * 0.5, 0.0, 0.0);\n  q.curvature = 0.0;", [{ name: "curvature", type: "f32" }]);
    const even = await resampleFrom(line, { cols: 2500, rows: 1 }, { method: "curvature", minDistance: 0.5, maxDistance: 2, maxPoints: 640 });
    expect(even.x).toEqual(Array.from({ length: 640 }, (_, k) => Math.min(k, 624) * 2));
    expect(even.live).toEqual(Array.from({ length: 640 }, (_, k) => (k < 625 ? 1 : 0)));

    const wander = formulaPoints(
      "kernel_source",
      7000,
      `  let j = i / 3500u;
  var s = i % 3500u;
  if (s >= 1020u) { s = 1020u; }
  if (i % 3500u >= 1030u) { s = i % 3500u - 10u; }
  if (i % 3500u >= 2040u) { s = 2030u; }
  if (i % 3500u >= 3080u) { s = i % 3500u - 1050u; }
  let t = f32(s) * 0.013 + f32(j) * 1.7;
  q.position = vec3f(cos(t) * (1.0 + 0.3 * sin(t * 2.7)), sin(t * 1.3) * 0.8 + 0.2 * cos(t * 3.1), sin(t * 0.7) + f32(s) * 0.001);
  q.curvature = 1.5 + 1.4 * sin(t * 2.1);`,
      [{ name: "curvature", type: "f32" }],
    );
    const parameters = { method: "curvature", minDistance: 0.03, maxDistance: 0.2, bias: 0.5, maxPoints: 1400 };
    const sink = drawnTo("resample_rings", 2800);
    const graph = curveGraph(
      [
        wander.node,
        curveNode("topology_strips", "pointTopology", { connectivity: "strips", cols: 3500, rows: 2 }),
        curveNode("resample_rings", "pointResample", parameters),
        ...sink.nodes,
      ],
      [curveEdge(["kernel_source", "out"], ["topology_strips", "points"]), curveEdge(["topology_strips", "out"], ["resample_rings", "points"]), ...sink.edges],
    );
    const schema = resampleAttributes([{ name: "position", type: "vec3f" }, { name: "curvature", type: "f32" }], true);
    await onDawn(graph, async (session) => {
      const position = (await session.read("resample_rings", schema, 2800, "position")).floats;
      const live = Array.from((await session.read("resample_rings", schema, 2800, "live")).floats);
      const input = (await session.read("kernel_source", wander.schema, 7000, "position")).floats;
      const turns = (await session.read("kernel_source", wander.schema, 7000, "curvature")).floats;
      for (const strip of [0, 1]) {
        const points = Array.from({ length: 3500 }, (_, k) => vecAt(input, strip * 3500 + k) as unknown as Vec3);
        const expected = resampleStrip(points, {
          closed: false,
          method: "curvature",
          minDistance: 0.03,
          maxDistance: 0.2,
          bias: 0.5,
          slots: 1400,
          curvature: Array.from(turns.subarray(strip * 3500, (strip + 1) * 3500)),
        });
        expect(live.slice(strip * 1400, (strip + 1) * 1400), `strip ${strip} live`).toEqual(expected.live);
        // More than a point every Max Distance would give, fewer than the slots: the density is at work.
        const count = expected.live.reduce((sum, flag) => sum + flag, 0);
        expect(count).toBeGreaterThan(300);
        expect(count).toBeLessThan(1400);
        expected.positions.forEach((point, k) =>
          point.forEach((value, axis) => expect(vecAt(position, strip * 1400 + k)[axis], `strip ${strip} slot ${k} axis ${axis}`).toBeCloseTo(value, 3)),
        );
      }
    });
  }, 240_000);
});
