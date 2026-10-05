import { describe, expect, it } from "vitest";

import type { PointAttributeType } from "../../points/attributes.ts";
import { resampleStrip, type ResampleOptions, type Vec3 } from "../../points/curve.ts";
import {
  authoredPoints,
  curveEdge,
  curveGraph,
  curveNode,
  drawnTo,
  onDawn,
  vecAt,
  type AuthoredAttribute,
  type CurveSession,
} from "./curve-test-support.ts";
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
  readonly position: number[][];
  readonly x: number[];
  readonly live: number[] | undefined;
  readonly floats: (name: string) => Promise<Float32Array>;
}

/** authored points → Topology (Strips) → Resample; one frame on Dawn; the output read back. */
async function resample<T = Resampled>(
  positions: ReadonlyArray<Vec3>,
  strips: { readonly cols: number; readonly rows: number; readonly closed?: boolean },
  parameters: Record<string, unknown>,
  extras: ReadonlyArray<AuthoredAttribute> = [],
  also?: (read: (name: string) => Promise<{ floats: Float32Array; words: Uint32Array }>, result: Resampled) => Promise<T>,
): Promise<T> {
  const source = authoredPoints("kernel_source", positions, extras);
  const byDistance = parameters["method"] === "distance";
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
    const result: Resampled = {
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
