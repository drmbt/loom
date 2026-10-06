import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../domain/types/graph.ts";
import type { PointAttributeType } from "../../points/attributes.ts";
import type { Quat, Vec3 } from "../../points/curve.ts";
import { sweepCapRows, sweepColumnCount, sweepOutline, sweepStrip, type SweepCaps, type SweepPathPoint } from "../../points/sweep.ts";
import {
  authoredPoints,
  curveEdge,
  curveGraph,
  curveNode,
  mappedTo,
  onDawn,
  vecAt,
  type AuthoredAttribute,
  type CurveSession,
  type ReadPort,
} from "./curve-test-support.ts";
import { curveFramesAttributes } from "./point-curve-frames.ts";
import { sweepAttributes } from "./point-sweep.ts";

/**
 * T1587b slice 2 — SEVERAL STRIPS, A SHEET EACH, on a real device.
 *
 * A path of N strips is swept into N sheets of one grid, `grid:{cols}x{rows}x{N}`, and a
 * Geometry draws them all in ONE draw that joins none to the next. Both halves are a
 * VARIANT of a program (the sweep's pass, the Render's grid chunks) that only more than one
 * sheet emits, so the claims here are about that variant:
 *
 *  - N straight strips with a Ring are N Tube generators: their vertices to the bit, and
 *    their lit, Normal and Depth pictures byte for byte, with a shadow cast and received;
 *  - a sweep of N strips is N sweeps of one strip, vertex for vertex and byte for byte,
 *    caps and padding included — so a cap is per sheet and padding draws nothing;
 *  - nothing is drawn between two sheets, and taking one strip away changes that strip's
 *    pixels and no others;
 *  - a kernel after the sweep reads ONE sheet's place (`ctx.dim`) and the surface is lit by
 *    the shape it leaves, sheet by sheet;
 *  - it is one Geometry to a light's caster lists.
 *
 * Every picture expectation is an exact byte or a byte-for-byte comparison (§V147). The
 * cameras are orthographic, so a pixel is a known place.
 */

const SIZE = 96;
const NORMAL: ReadPort = { nodeId: "render_shot", portId: "normal" };
const DEPTH: ReadPort = { nodeId: "render_shot", portId: "depth" };
const FRAMES = curveFramesAttributes({ frame: true, vectors: false, metrics: true });

type Edge = ReturnType<typeof curveEdge>;
interface Stage {
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<Edge>;
  /** The Geometry nodes the Render draws, in order. */
  readonly geometries: ReadonlyArray<string>;
}

interface PathSpec {
  /** One list of points per strip, all of one length. */
  readonly strips: ReadonlyArray<ReadonlyArray<Vec3>>;
  /** A `width` per strip, mapped onto the radius. */
  readonly widths?: ReadonlyArray<number>;
  /** A `color` per strip: an attribute of the path, which every vertex of the strip's sheet carries. */
  readonly colours?: ReadonlyArray<readonly [number, number, number, number]>;
  /** Every strip closes on itself. */
  readonly closed?: boolean;
  /** What the path's Topology node claims, when it is not `strips` of these strips. */
  readonly claim?: Record<string, unknown>;
}

const pathExtras = (spec: PathSpec): AuthoredAttribute[] => [
  ...(spec.widths === undefined ? [] : [{ name: "width", type: "f32" as const, values: spec.strips.flatMap((strip, k) => strip.map(() => spec.widths![k] as number)) }]),
  ...(spec.colours === undefined ? [] : [{ name: "color", type: "vec4f" as const, values: spec.strips.flatMap((strip, k) => strip.map(() => [...spec.colours![k]!])) }]),
];
const pathSchema = (spec: PathSpec): Array<{ name: string; type: PointAttributeType }> => [
  { name: "position", type: "vec3f" },
  ...(spec.widths === undefined ? [] : [{ name: "width", type: "f32" as const }]),
  ...(spec.colours === undefined ? [] : [{ name: "color", type: "vec4f" as const }]),
];

/**
 * kernel → topology (Strips) → Curve Frames → Sweep → [a kernel after it] → Geometry, all
 * suffixed so several chains can stand in one graph.
 */
function sweepChain(
  suffix: string,
  spec: PathSpec,
  sweep: Record<string, unknown>,
  after?: { readonly kernel: string; readonly capacity: number; readonly attributes?: ReadonlyArray<unknown> },
  geometry: Record<string, unknown> = {},
): Stage {
  const cols = spec.strips[0]!.length;
  const path = authoredPoints(`kernel_path${suffix}`, spec.strips.flat(), pathExtras(spec));
  const nodes: GraphNode[] = [
    path.node,
    curveNode(`topology_path${suffix}`, "pointTopology", spec.claim ?? { connectivity: "strips", cols, rows: spec.strips.length, ...(spec.closed === true ? { wrapU: true } : {}) }),
    curveNode(`frames_path${suffix}`, "pointCurveFrames"),
    curveNode(`sweep_skin${suffix}`, "pointSweep", { uvAlong: "points", ...(spec.widths === undefined ? {} : { radius: mappedTo("width", 1) }), ...sweep }),
    curveNode(`geometry_skin${suffix}`, "geometry", { mode: "surface", ...geometry }),
  ];
  const edges: Edge[] = [
    curveEdge([`kernel_path${suffix}`, "out"], [`topology_path${suffix}`, "points"]),
    curveEdge([`topology_path${suffix}`, "out"], [`frames_path${suffix}`, "points"]),
    curveEdge([`frames_path${suffix}`, "out"], [`sweep_skin${suffix}`, "points"]),
  ];
  let last = `sweep_skin${suffix}`;
  if (after !== undefined) {
    nodes.push(
      curveNode(`kernel_after${suffix}`, "pointKernel", {
        capacity: after.capacity,
        seed: 7,
        attributes: JSON.stringify(after.attributes ?? [{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: after.kernel,
      }),
    );
    edges.push(curveEdge([last, "out"], [`kernel_after${suffix}`, "in"]));
    last = `kernel_after${suffix}`;
  }
  edges.push(curveEdge([last, "out"], [`geometry_skin${suffix}`, "points"]));
  return { nodes, edges, geometries: [`geometry_skin${suffix}`] };
}

/** The same strips, one Sweep and one Geometry each. */
function singleChains(spec: PathSpec, sweep: Record<string, unknown>, geometry: Record<string, unknown> = {}): Stage {
  const chains = spec.strips.map((strip, k) =>
    sweepChain(
      `_${k}`,
      {
        strips: [strip],
        ...(spec.widths === undefined ? {} : { widths: [spec.widths[k] as number] }),
        ...(spec.colours === undefined ? {} : { colours: [spec.colours[k]!] }),
        ...(spec.closed === true ? { closed: true } : {}),
      },
      sweep,
      undefined,
      geometry,
    ),
  );
  return { nodes: chains.flatMap((chain) => chain.nodes), edges: chains.flatMap((chain) => chain.edges), geometries: chains.flatMap((chain) => chain.geometries) };
}

/** Tube generators, each its own Geometry, moved along Z by its object Transform. */
function tubes(list: ReadonlyArray<{ readonly radius: number; readonly z: number }>, cols: number, rows: number): Stage {
  return {
    nodes: list.flatMap((tube, k) => [
      curveNode(`tube_pipe_${k}`, "pointTube", { count: cols * rows, cols, rows, radius: tube.radius, sizeZ: 2 }),
      curveNode(`geometry_tube_${k}`, "geometry", { mode: "surface", translate: [0, 0, tube.z] }),
    ]),
    edges: list.map((_, k) => curveEdge([`tube_pipe_${k}`, "out"], [`geometry_tube_${k}`, "points"])),
    geometries: list.map((_, k) => `geometry_tube_${k}`),
  };
}

/** One shot of a stage: an orthographic camera, one light, the Normal and Depth outputs on, and a floor if asked. */
function shot(
  stage: Stage,
  camera: { readonly eye: Vec3; readonly lookAt?: Vec3; readonly height: number },
  options: { readonly light?: Record<string, unknown>; readonly floor?: boolean } = {},
) {
  const floor = authoredPoints("kernel_floor", [
    [-6, -1.5, -6],
    [6, -1.5, -6],
    [-6, -1.5, 6],
    [6, -1.5, 6],
  ]);
  const floorNodes: GraphNode[] =
    options.floor === true
      ? [floor.node, curveNode("topology_floor", "pointTopology", { connectivity: "grid", cols: 2, rows: 2 }), curveNode("geometry_floor", "geometry", { mode: "surface" })]
      : [];
  return curveGraph(
    [
      ...stage.nodes,
      ...floorNodes,
      curveNode("camera_main", "camera", { eye: [...camera.eye], lookAt: [...(camera.lookAt ?? [0, 0, 0])], near: 0.1, far: 10, ortho: true, orthoHeight: camera.height }),
      curveNode("light_key", "light", { kind: "directional", direction: [0, -1, 0], intensity: 0.8, shadows: false, ...options.light }),
      curveNode("render_shot", "render", {
        scenes: [...stage.geometries, ...(options.floor === true ? ["geometry_floor"] : [])].join(" "),
        camera: "camera_main",
        lights: "light_key",
        normalOutput: true,
        depthOutput: true,
        background: [0, 0, 0, 1],
      }),
      curveNode("output_probe", "output"),
    ],
    [
      ...stage.edges,
      ...(options.floor === true ? [curveEdge(["kernel_floor", "out"], ["topology_floor", "points"]), curveEdge(["topology_floor", "out"], ["geometry_floor", "points"])] : []),
      curveEdge(["render_shot", "out"], ["output_probe", "input"]),
    ],
  );
}

interface Pictures {
  readonly lit: Uint8Array;
  readonly normal: Uint8Array;
  readonly depth: Uint8Array;
}

async function picturesIn(session: CurveSession): Promise<Pictures> {
  expect(session.plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const lit = await session.readOutput();
  const normal = await session.readPort(NORMAL.nodeId, NORMAL.portId);
  const depth = await session.readPort(DEPTH.nodeId, DEPTH.portId);
  for (const image of [lit, normal, depth]) expect([image.width, image.height, image.bytes.length]).toEqual([SIZE, SIZE, SIZE * SIZE * 4]);
  return { lit: lit.bytes, normal: normal.bytes, depth: depth.bytes };
}
const pictures = (graph: ReturnType<typeof shot>): Promise<Pictures> => onDawn(graph, picturesIn, SIZE, 0, [NORMAL, DEPTH]);

const at = (bytes: Uint8Array, x: number, y: number): number[] => Array.from(bytes.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3));
/** How many pixels of two pictures differ, and the largest step any channel takes. */
const differing = (a: Uint8Array, b: Uint8Array): { pixels: number; largest: number } => {
  let pixels = 0;
  let largest = 0;
  for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
    let moved = 0;
    for (let channel = 0; channel < 4; channel += 1) moved = Math.max(moved, Math.abs((a[pixel * 4 + channel] as number) - (b[pixel * 4 + channel] as number)));
    if (moved > 0) pixels += 1;
    largest = Math.max(largest, moved);
  }
  return { pixels, largest };
};
const SAME = { pixels: 0, largest: 0 };
/** Pixels a picture draws anything on: its depth is nearer than the far plane. */
const drawn = (depth: Uint8Array): number => {
  let count = 0;
  for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((depth[pixel * 4] as number) !== 255) count += 1;
  return count;
};

/** The whole swept buffer of a chain, attribute by attribute, as words. */
async function sweptWords(session: CurveSession, suffix: string, spec: PathSpec, capacity: number): Promise<Record<string, Uint32Array>> {
  const schema = sweepAttributes([...pathSchema(spec), ...FRAMES.map(({ name, type }) => ({ name, type }))]);
  const read: Record<string, Uint32Array> = {};
  for (const name of ["position", "normal", "uv"]) read[name] = new Uint32Array((await session.read(`sweep_skin${suffix}`, schema, capacity, name)).words);
  return read;
}

/* Five points a metre apart along +Z, from z0: every number exact. */
const along = (x: number, y: number, z0: number): Vec3[] => [0, 1, 2, 3, 4].map((step): Vec3 => [x, y, z0 + step * 0.5]);

describe("Sweep, several strips: N straight strips with a Ring are N Tube generators (T1587b slice 2)", () => {
  /* Three strips on one line, end to end with a gap between, each with its own radius. A
     Tube generator lays `cos × radius, sin × radius, z` about the origin, and its Geometry
     moves it along Z; a strip on the Z axis gives the same two numbers and its own z. */
  const TUBES = [
    { radius: 0.25, z: -3 },
    { radius: 0.5, z: 0 },
    { radius: 0.75, z: 3 },
  ];
  const SPEC: PathSpec = { strips: TUBES.map((tube) => along(0, 0, tube.z - 1)), widths: TUBES.map((tube) => tube.radius) };
  const sweep = { profile: "ring", sides: 16 };

  it("lays each sheet's vertices where its Tube's are, to the bit", async () => {
    const swept = await onDawn(shot(sweepChain("", SPEC, sweep), { eye: [5, 0, 0], height: 10 }), async (session) => {
      expect(session.plan.passes.find((pass) => pass.id.includes("sweep_skin:sweep"))?.id).toContain("16x5x3");
      return (await sweptWords(session, "", SPEC, 16 * 5 * 3))["position"]!;
    });
    for (const [k, tube] of TUBES.entries()) {
      const generated = await onDawn(shot(tubes([{ radius: tube.radius, z: 0 }], 16, 5), { eye: [5, 0, 0], height: 10 }), async (session) =>
        new Float32Array((await session.read("tube_pipe_0", [{ name: "position", type: "vec3f" }], 80, "position")).floats),
      );
      const sheet = new Float32Array(swept.buffer, k * 80 * 16, 80 * 4);
      for (let vertex = 0; vertex < 80; vertex += 1) {
        const [x, y, z] = vecAt(generated, vertex) as [number, number, number];
        // The two numbers a Tube and a Ring share are the same bits; z is the Tube's, moved by a whole number.
        expect(vecAt(sheet, vertex), `tube ${k}, vertex ${vertex}`).toEqual([x, y, z + tube.z]);
      }
    }
  }, 240_000);

  it("draws their picture byte for byte: lit, Normal and Depth, with a shadow cast and received", async () => {
    const camera = { eye: [4, 3, 0] as Vec3, height: 10 };
    const sun = { direction: [-0.3, -1, -0.2], shadows: true, shadowExtent: 7 };
    const swept = await pictures(shot(sweepChain("", SPEC, sweep), camera, { floor: true, light: sun }));
    const generated = await pictures(shot(tubes(TUBES, 16, 5), camera, { floor: true, light: sun }));
    expect(differing(swept.lit, generated.lit), "lit").toEqual(SAME);
    expect(differing(swept.normal, generated.normal), "normal").toEqual(SAME);
    expect(differing(swept.depth, generated.depth), "depth").toEqual(SAME);

    /* Equal pictures of nothing would pass, so: all three tubes are in the frame and shaded,
       and their shadows are on the floor (the same shot with the light's shadows off is a
       brighter picture there). */
    const levels = new Set<number>();
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) levels.add(swept.lit[pixel * 4] as number);
    expect(levels.size).toBeGreaterThan(8);
    const unshadowed = await pictures(shot(sweepChain("", SPEC, sweep), camera, { floor: true, light: { ...sun, shadows: false } }));
    let darker = 0;
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((swept.lit[pixel * 4] as number) < (unshadowed.lit[pixel * 4] as number)) darker += 1;
    expect(darker).toBeGreaterThan(40);
  }, 240_000);

  it("is one Geometry to a light's caster lists: left out, none of its sheets casts; and the Tubes left out give the same picture", async () => {
    const camera = { eye: [4, 3, 0] as Vec3, height: 10 };
    const sun = { direction: [-0.3, -1, -0.2], shadows: true, shadowExtent: 7 };
    const casting = await pictures(shot(sweepChain("", SPEC, sweep), camera, { floor: true, light: sun }));
    const excluded = await pictures(shot(sweepChain("", SPEC, sweep), camera, { floor: true, light: { ...sun, shadowExclude: "geometry_skin" } }));
    // Its shadow is gone from the floor.
    expect(differing(casting.lit, excluded.lit).pixels).toBeGreaterThan(40);
    const generated = await pictures(shot(tubes(TUBES, 16, 5), camera, { floor: true, light: { ...sun, shadowExclude: "geometry_tube_0 geometry_tube_1 geometry_tube_2" } }));
    expect(differing(excluded.lit, generated.lit), "lit, nothing casting").toEqual(SAME);
    // Named as the only caster, it casts as it did with no list at all.
    const only = await pictures(shot(sweepChain("", SPEC, sweep), camera, { floor: true, light: { ...sun, shadowCasters: "geometry_skin" } }));
    expect(differing(casting.lit, only.lit), "lit, the sweep the only caster").toEqual(SAME);
  }, 240_000);
});

describe("Sweep, several strips: a sweep of N strips is N sweeps of one (T1587b slice 2)", () => {
  /* Three parallel strips 1.2 m apart. 1.2 is not a number a float holds, so a vertex is a
     rounded sum, and the several-strip program has to round it as the one-strip program does. */
  const PARALLEL: PathSpec = { strips: [along(-1.2, 0, -1), along(0, 0, -1), along(1.2, 0, -1)] };
  const tube = { profile: "ring", sides: 12, radius: 0.4, caps: "both" };
  /** Seen from above and in front: X runs across the picture, 24 pixels a metre. */
  const above = { eye: [0, 4, 3] as Vec3, height: 4 };

  it("writes the same words, vertex for vertex: position, normal and uv, caps included", async () => {
    const capacity = 12 * 9;
    const sheets = await onDawn(shot(sweepChain("", PARALLEL, tube), above), (session) => sweptWords(session, "", PARALLEL, capacity * 3));
    const singles = await onDawn(shot(singleChains(PARALLEL, tube), above), async (session) => {
      const read: Array<Record<string, Uint32Array>> = [];
      for (const k of [0, 1, 2]) read.push(await sweptWords(session, `_${k}`, { strips: [PARALLEL.strips[k]!] }, capacity));
      return read;
    });
    for (const k of [0, 1, 2]) {
      for (const [name, words] of [["position", 4], ["normal", 4], ["uv", 2]] as const) {
        expect(Array.from(sheets[name]!.subarray(k * capacity * words, (k + 1) * capacity * words)), `sheet ${k} ${name}`).toEqual(Array.from(singles[k]![name]!));
      }
    }
  }, 240_000);

  it("draws the same picture byte for byte, and nothing between two sheets", async () => {
    const sheets = await pictures(shot(sweepChain("", PARALLEL, tube), above));
    const singles = await pictures(shot(singleChains(PARALLEL, tube), above));
    expect(differing(sheets.lit, singles.lit), "lit").toEqual(SAME);
    expect(differing(sheets.normal, singles.normal), "normal").toEqual(SAME);
    expect(differing(sheets.depth, singles.depth), "depth").toEqual(SAME);
    /* The tubes are 0.8 m wide and 1.2 m apart: the 0.4 m between two of them is ten pixels
       of the picture, centred 14.4 pixels either side of its middle. Every row of the four
       middle columns of each gap is the background, in every output: no sheet is joined to
       the next. */
    for (const x of [32, 33, 34, 35, 60, 61, 62, 63]) {
      for (let y = 0; y < SIZE; y += 1) {
        expect(at(sheets.lit, x, y), `lit ${x}, ${y}`).toEqual([0, 0, 0]);
        expect(at(sheets.depth, x, y)[0], `depth ${x}, ${y}`).toBe(255);
      }
    }
    // And the tubes themselves are there: three bodies, each a third of what is drawn.
    expect(drawn(sheets.depth)).toBeGreaterThan(1500);
  }, 240_000);

  it("under a casting point light: the six faces of its cube draw every sheet, and the picture is the three sweeps' own", async () => {
    /* A point light's shadow is six depth draws of the Geometry, one a cube face: the depth
       chunk's variant, six times. The lamp is above the middle tube, so the outer two shadow
       the floor on their far sides. */
    const lamp = { kind: "point", position: [0, 2.5, 1], shadows: true, shadowExtent: 8 };
    const sheets = await pictures(shot(sweepChain("", PARALLEL, tube), above, { floor: true, light: lamp }));
    const singles = await pictures(shot(singleChains(PARALLEL, tube), above, { floor: true, light: lamp }));
    expect(differing(sheets.lit, singles.lit), "lit").toEqual(SAME);
    const unshadowed = await pictures(shot(sweepChain("", PARALLEL, tube), above, { floor: true, light: { ...lamp, shadows: false } }));
    let darker = 0;
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((sheets.lit[pixel * 4] as number) < (unshadowed.lit[pixel * 4] as number)) darker += 1;
    expect(darker).toBeGreaterThan(40);
  }, 240_000);

  it("taking one strip away changes that strip's pixels and no others", async () => {
    const three = await pictures(shot(sweepChain("", PARALLEL, tube), above));
    const two = await pictures(shot(sweepChain("", { strips: [PARALLEL.strips[0]!, PARALLEL.strips[2]!] }, tube), above));
    let changed = 0;
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
      const x = pixel % SIZE;
      const same = [0, 1, 2, 3].every((channel) => three.lit[pixel * 4 + channel] === two.lit[pixel * 4 + channel]) && three.depth[pixel * 4] === two.depth[pixel * 4];
      if (same) continue;
      changed += 1;
      // The middle tube is within 0.4 m of the picture's middle: columns 38 to 57.
      expect(x, `pixel ${x}, ${Math.floor(pixel / SIZE)}`).toBeGreaterThanOrEqual(38);
      expect(x).toBeLessThanOrEqual(57);
      // And where it was there is now nothing.
      expect(two.depth[pixel * 4]).toBe(255);
    }
    expect(changed).toBeGreaterThan(400);
    expect(drawn(three.depth) - drawn(two.depth)).toBe(changed);
  }, 240_000);

  it("a cap is each sheet's own: seen end on, three discs with the end's normal and the background between", async () => {
    /* Along the tubes from their far end. An open tube is edge on to an orthographic camera
       on its axis and draws nothing; a capped one shows its cap, 4 m away of a far plane at
       10: byte 102. */
    const end = { eye: [0, 0, 5] as Vec3, height: 4 };
    const capped = await pictures(shot(sweepChain("", PARALLEL, tube), end));
    const open = await pictures(shot(sweepChain("", PARALLEL, { ...tube, caps: "none" }), end));
    expect(drawn(open.depth)).toBe(0);
    for (const x of [19, 48, 77]) {
      // 1.2 m is 28.8 pixels: the three axes are at columns 19.2, 48 and 76.8.
      expect(at(capped.depth, x, 48)[0], `depth at column ${x}`).toBe(102);
      expect(at(capped.normal, x, 48), `normal at column ${x}`).toEqual([128, 128, 255]);
    }
    for (const x of [33, 34, 62, 63]) expect(at(capped.depth, x, 48)[0], `between, column ${x}`).toBe(255);
    const singles = await pictures(shot(singleChains(PARALLEL, tube), end));
    expect(differing(capped.depth, singles.depth), "depth").toEqual(SAME);
    expect(differing(capped.normal, singles.normal), "normal").toEqual(SAME);
    // Three discs of 0.4 m, 9.6 pixels, radius: about 290 pixels each.
    expect(drawn(capped.depth)).toBeGreaterThan(3 * 250);
    expect(drawn(capped.depth)).toBeLessThan(3 * 300);
  }, 240_000);

  it("padding draws nothing: a strip that repeats its end is the shorter strip, and its cap sits on its last real ring", async () => {
    /* Two strips of eight slots. The first is five points and its end three times more
       (§V788); the second is eight points. As two sweeps of one strip they are a strip of
       five and a strip of eight. */
    const short = along(-0.8, 0, -1);
    const long: Vec3[] = [0, 1, 2, 3, 4, 5, 6, 7].map((step): Vec3 => [0.8, 0, -1.75 + step * 0.5]);
    const padded: PathSpec = { strips: [[...short, short[4]!, short[4]!, short[4]!], long] };
    const capped = { profile: "ring", sides: 12, radius: 0.4, caps: "end" };
    const sheets = await pictures(shot(sweepChain("", padded, capped), above));
    const separate: Stage = (() => {
      const a = sweepChain("_a", { strips: [short] }, capped);
      const b = sweepChain("_b", { strips: [long] }, capped);
      return { nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges], geometries: [...a.geometries, ...b.geometries] };
    })();
    const singles = await pictures(shot(separate, above));
    expect(differing(sheets.lit, singles.lit), "lit").toEqual(SAME);
    expect(differing(sheets.normal, singles.normal), "normal").toEqual(SAME);
    expect(differing(sheets.depth, singles.depth), "depth").toEqual(SAME);
    expect(drawn(sheets.depth)).toBeGreaterThan(1000);
  }, 240_000);
});

describe("Sweep, several closed strips: a sheet that wraps along the path too (T1587b slice 2)", () => {
  /* Two rings of eight points, half a metre in radius, lying flat 2.4 m apart. Swept with a
     Ring they are two tori: each sheet wraps round the profile AND along the path, so a sheet
     has as many rows of cells as it has rows, and the draw has to count them that way before
     it can say which sheet a vertex is in. */
  const ring = (x: number): Vec3[] => Array.from({ length: 8 }, (_, k): Vec3 => [x + 0.5 * Math.cos((k * Math.PI) / 4), 0, 0.5 * Math.sin((k * Math.PI) / 4)]);
  const RINGS: PathSpec = { strips: [ring(-1.2), ring(1.2)], closed: true };
  const tube = { profile: "ring", sides: 8, radius: 0.2 };
  const above = { eye: [0, 4, 3] as Vec3, height: 4 };

  it("writes each torus as its own strip swept alone, word for word", async () => {
    const capacity = 8 * 8;
    const sheets = await onDawn(shot(sweepChain("", RINGS, tube), above), async (session) => {
      expect(session.plan.passes.find((pass) => pass.id.includes("sweep_skin:sweep"))?.id).toContain("8x8x2");
      return sweptWords(session, "", RINGS, capacity * 2);
    });
    const singles = await onDawn(shot(singleChains(RINGS, tube), above), async (session) => {
      const read: Array<Record<string, Uint32Array>> = [];
      for (const k of [0, 1]) read.push(await sweptWords(session, `_${k}`, { strips: [RINGS.strips[k]!], closed: true }, capacity));
      return read;
    });
    for (const k of [0, 1]) {
      for (const [name, words] of [["position", 4], ["normal", 4], ["uv", 2]] as const) {
        expect(Array.from(sheets[name]!.subarray(k * capacity * words, (k + 1) * capacity * words)), `sheet ${k} ${name}`).toEqual(Array.from(singles[k]![name]!));
      }
    }
  }, 240_000);

  it("draws both tori as two sweeps of one draw them, byte for byte, shadows cast and received, and nothing between", async () => {
    const sun = { direction: [-0.3, -1, -0.2], shadows: true, shadowExtent: 7 };
    const sheets = await pictures(shot(sweepChain("", RINGS, tube), above, { floor: true, light: sun }));
    const singles = await pictures(shot(singleChains(RINGS, tube), above, { floor: true, light: sun }));
    expect(differing(sheets.lit, singles.lit), "lit").toEqual(SAME);
    expect(differing(sheets.normal, singles.normal), "normal").toEqual(SAME);
    expect(differing(sheets.depth, singles.depth), "depth").toEqual(SAME);
    /* Each torus reaches 0.7 m from its own middle, so the half metre either side of the
       picture's middle holds neither: with no floor, the eight middle columns are the background. */
    const bare = await pictures(shot(sweepChain("", RINGS, tube), above));
    for (const x of [44, 45, 46, 47, 48, 49, 50, 51]) for (let y = 0; y < SIZE; y += 1) expect(at(bare.depth, x, y)[0], `between, ${x}, ${y}`).toBe(255);
    // Both are there, and a torus has a hole: its own middle is the background too.
    expect(drawn(bare.depth)).toBeGreaterThan(600);
    expect(at(bare.depth, 19, 48)[0]).toBe(255);
    expect(at(bare.depth, 77, 48)[0]).toBe(255);
    // And the shadows are on the floor.
    const unshadowed = await pictures(shot(sweepChain("", RINGS, tube), above, { floor: true, light: { ...sun, shadows: false } }));
    let darker = 0;
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((sheets.lit[pixel * 4] as number) < (unshadowed.lit[pixel * 4] as number)) darker += 1;
    expect(darker).toBeGreaterThan(40);
  }, 240_000);

  it("Render Surface draws both tori too: each as it draws alone, and nothing more", async () => {
    /** The chain's sweep into a Render Surface, in place of its Geometry and the Render. */
    const surfaced = (stage: Stage, sweeps: ReadonlyArray<string>): Promise<Uint8Array[]> =>
      Promise.all(
        sweeps.map((sweep) =>
          onDawn(
            curveGraph(
              [...stage.nodes.filter((node) => node.type !== "geometry"), curveNode("surface_skin", "renderSurface", { eye: [0, 4, 3], lookAt: [0, 0, 0] }), curveNode("output_probe", "output")],
              [...stage.edges.filter((edge) => !edge.target.nodeId.startsWith("geometry_")), curveEdge([sweep, "out"], ["surface_skin", "points"]), curveEdge(["surface_skin", "out"], ["output_probe", "input"])],
            ),
            async (session) => (await session.readOutput()).bytes,
            SIZE,
          ),
        ),
      );
    const [sheets] = await surfaced(sweepChain("", RINGS, tube), ["sweep_skin"]);
    const [left, right] = await surfaced(singleChains(RINGS, tube), ["sweep_skin_0", "sweep_skin_1"]);
    const covers = (bytes: Uint8Array): number => {
      let count = 0;
      for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((bytes[pixel * 4] as number) > 0) count += 1;
      return count;
    };
    expect(covers(left!)).toBeGreaterThan(100);
    expect(covers(right!)).toBeGreaterThan(100);
    const union = new Uint8Array(left!.length);
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
      const from = (left![pixel * 4] as number) > 0 ? left! : right!;
      union.set(from.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
    }
    expect(differing(sheets!, union)).toEqual(SAME);
  }, 240_000);
});

describe("Sweep: a grid of several sheets as the PATH (T1587b slice 2)", () => {
  /* A grid's rows are strips, and a grid of sheets has `rows` of them in every sheet. Four
     lines of five points claimed as a grid of 5 × 2 in 2 sheets are the four strips they are
     when claimed as strips of 5 × 4: the same four tubes. */
  const LINES: ReadonlyArray<ReadonlyArray<Vec3>> = [along(-1.5, 0, -1), along(-0.5, 0, -1), along(0.5, 0, -1), along(1.5, 0, -1)];
  const tube = { profile: "ring", sides: 12, radius: 0.3 };
  const above = { eye: [0, 4, 3] as Vec3, height: 4 };

  it("every row of every sheet is swept: four tubes, the same words as four strips give", async () => {
    const capacity = 12 * 5 * 4;
    const asGrid: PathSpec = { strips: LINES, claim: { connectivity: "grid", cols: 5, rows: 2, sheets: 2 } };
    const fromGrid = await onDawn(shot(sweepChain("", asGrid, tube), above), async (session) => {
      expect(session.plan.passes.find((pass) => pass.id.includes("sweep_skin:sweep"))?.id).toContain("12x5x4");
      return sweptWords(session, "", asGrid, capacity);
    });
    const fromStrips = await onDawn(shot(sweepChain("", { strips: LINES }, tube), above), (session) => sweptWords(session, "", { strips: LINES }, capacity));
    for (const name of ["position", "normal", "uv"]) expect(Array.from(fromGrid[name]!), name).toEqual(Array.from(fromStrips[name]!));
    // Not four tubes of nothing: the last sheet's first ring stands on the fourth line's first point.
    const last = new Float32Array(fromGrid["position"]!.buffer, 3 * 60 * 16, 12 * 4);
    expect(vecAt(last, 0)[2]).toBe(-1);
    expect(Math.abs((vecAt(last, 0)[0] as number) - 1.5)).toBeLessThanOrEqual(0.3 + 1e-6);
  }, 240_000);
});

describe("Sweep, several strips: what a material is handed, sheet by sheet (T1587b slice 2)", () => {
  /* Three parallel tubes, each strip of the path with a colour of its own. The Sweep copies
     a path point's attributes to every vertex of its ring, and the Geometry's Tint is mapped
     to the colour: that is how a material tells one strand from another. */
  const STRANDS: PathSpec = {
    strips: [along(-1.2, 0, -1), along(0, 0, -1), along(1.2, 0, -1)],
    colours: [[1, 0, 0, 1], [0, 1, 0, 1], [0, 0, 1, 1]],
  };
  const tube = { profile: "ring", sides: 12, radius: 0.4 };
  const above = { eye: [0, 4, 3] as Vec3, height: 4 };
  const unlit = (stage: Stage): Stage => ({
    ...stage,
    nodes: [...stage.nodes, curveNode("material_flat", "materialUnlit", { color: [1, 1, 1, 1] })],
  });
  const tinted = { material: "material_flat", tint: mappedTo("color", [1, 1, 1, 1]) };

  it("a Tint mapped to a path attribute colours each sheet by its own strip", async () => {
    const sheets = await pictures(shot(unlit(sweepChain("", STRANDS, tube, undefined, tinted)), above));
    // The three axes are at columns 19.2, 48 and 76.8: red, green, blue, and nothing of a neighbour's.
    expect(at(sheets.lit, 19, 48)).toEqual([255, 0, 0]);
    expect(at(sheets.lit, 48, 48)).toEqual([0, 255, 0]);
    expect(at(sheets.lit, 77, 48)).toEqual([0, 0, 255]);
    // Every drawn pixel is one of the three, whole: no vertex reads another sheet's colour.
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
      if ((sheets.depth[pixel * 4] as number) === 255) continue;
      const colour = Array.from(sheets.lit.subarray(pixel * 4, pixel * 4 + 3));
      const x = pixel % SIZE;
      expect(colour, `pixel ${x}, ${Math.floor(pixel / SIZE)}`).toEqual(x < 34 ? [255, 0, 0] : x < 62 ? [0, 255, 0] : [0, 0, 255]);
    }
    // The wire cut: with the map gone every sheet is the material's own white.
    const plain = await pictures(shot(unlit(sweepChain("", STRANDS, tube, undefined, { material: "material_flat" })), above));
    expect(at(plain.lit, 19, 48)).toEqual([255, 255, 255]);
    expect(at(plain.lit, 77, 48)).toEqual([255, 255, 255]);
  }, 240_000);

  it("glass refracts through every sheet as through each strip swept alone", async () => {
    const glass = (stage: Stage): Stage => ({ ...stage, nodes: [...stage.nodes, curveNode("material_glass", "materialGlass", {})] });
    const floor = { floor: true, light: { direction: [-0.3, -1, -0.2] } };
    const sheets = await pictures(shot(glass(sweepChain("", STRANDS, tube, undefined, { material: "material_glass" })), above, floor));
    const singles = await pictures(shot(glass(singleChains(STRANDS, tube, { material: "material_glass" })), above, floor));
    expect(differing(sheets.lit, singles.lit), "lit").toEqual(SAME);
    // And it is drawn: the floor seen through three tubes is not the floor seen through none.
    const bare = await pictures(shot({ nodes: [], edges: [], geometries: [] }, above, floor));
    expect(differing(sheets.lit, bare.lit).pixels).toBeGreaterThan(300);
  }, 240_000);
});

describe("Sweep, several strips: bent strips against the reference (T1587b slice 2)", () => {
  /* Two unlike strips that leave their planes, so every frame is a different rotation. */
  const BENT: PathSpec = {
    strips: [
      [[0, 0, 0], [0.5, 0.25, 1], [1.25, 1, 1.5], [1.5, 2, 1.5], [1, 2.75, 2.25], [0.25, 3, 3.5]],
      [[4, 0, 0], [4, 1, 0.5], [5, 1, 1], [5, 3, 1], [3, 3, 2], [3, 0, -1]],
    ],
    widths: [0.5, 1.5],
  };
  const CASES: ReadonlyArray<{ readonly name: string; readonly sweep: Record<string, unknown>; readonly caps: SweepCaps; readonly inward: boolean; readonly flat: boolean }> = [
    { name: "a Ring of seven, capped at both ends", sweep: { profile: "ring", sides: 7, caps: "both", uvAlong: "stretch" }, caps: "both", inward: false, flat: false },
    { name: "a Ring of five with flat sides, facing inward, capped at its start", sweep: { profile: "ring", sides: 5, smooth: false, facing: "inward", caps: "start", uvAlong: "stretch" }, caps: "start", inward: true, flat: true },
  ];
  for (const entry of CASES) {
    it(`every sheet is the reference's strip: ${entry.name}`, async () => {
      const sides = entry.flat ? 5 : 7;
      const outline = sweepOutline("ring", sides, !entry.flat);
      const columns = sweepColumnCount(outline);
      const capRows = sweepCapRows(entry.caps, false);
      const rows = capRows.start + 6 + capRows.end;
      await onDawn(shot(sweepChain("", BENT, { radius: mappedTo("width", 0.2), ...entry.sweep }), { eye: [5, 5, 5], height: 10 }), async (session) => {
        const schema = sweepAttributes([...pathSchema(BENT), ...FRAMES.map(({ name, type }) => ({ name, type }))]);
        const capacity = columns * rows * 2;
        const read = async (name: string) => (await session.read("sweep_skin", schema, capacity, name)).floats;
        const position = await read("position");
        const normal = await read("normal");
        const uv = await read("uv");
        const width = await read("width");
        const points = (await session.read("kernel_path", pathSchema(BENT), 12, "position")).floats;
        const frame = async (name: string) => (await session.read("frames_path", FRAMES, 12, name)).floats;
        const orient = await frame("orient");
        const distance = await frame("distance");
        const curveU = await frame("curveU");
        const curveLength = await frame("curveLength");
        for (const strip of [0, 1]) {
          const path: SweepPathPoint[] = Array.from({ length: 6 }, (_, index) => {
            const slot = strip * 6 + index;
            return {
              position: vecAt(points, slot) as unknown as Vec3,
              orient: vecAt(orient, slot, 4) as unknown as Quat,
              scale: BENT.widths![strip] as number,
              distance: distance[slot] as number,
              curveU: curveU[slot] as number,
              curveLength: curveLength[slot] as number,
            };
          });
          const expected = sweepStrip(path, { outline, inward: entry.inward, radius: 0.2, caps: entry.caps, pathClosed: false, uvAlong: "stretch", uvLength: 1 });
          expect(expected).toHaveLength(columns * rows);
          expected.forEach((vertex, local) => {
            const slot = strip * columns * rows + local;
            vertex.position.forEach((value, axis) => expect(vecAt(position, slot)[axis], `strip ${strip} position ${local}`).toBeCloseTo(value, 5));
            vertex.normal.forEach((value, axis) => expect(vecAt(normal, slot)[axis], `strip ${strip} normal ${local}`).toBeCloseTo(value, 5));
            expect(uv[slot * 2], `strip ${strip} uv.x ${local}`).toBeCloseTo(vertex.uv[0], 5);
            expect(uv[slot * 2 + 1], `strip ${strip} uv.y ${local}`).toBeCloseTo(vertex.uv[1], 5);
            // What a ring carries is its own strip's path point's.
            expect(width[slot], `strip ${strip} width ${local}`).toBe(BENT.widths![strip]);
          });
        }
      });
    }, 120_000);
  }
});

describe("Sweep, several strips: a kernel after it works a sheet at a time (T1587b slice 2)", () => {
  const PAIR: PathSpec = { strips: [along(-1, 0, -1), along(1, 0, -1)] };
  const tube = { profile: "ring", sides: 16, radius: 0.6 };

  it("ctx.dim is ONE sheet's: its columns, its rows, the slot's row in its own sheet, and which sheet", async () => {
    const WHERE = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.place = vec4f(f32(ctx.dim.i), f32(ctx.dim.j), f32(ctx.dim.sheet), f32(ctx.dim.cols * 1000u + ctx.dim.rows * 10u + ctx.dim.sheets));
  return q;
}`;
    const attributes = [
      { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
      { name: "place", type: "vec4f", default: [0, 0, 0, 0] },
    ];
    const stage = sweepChain("", PAIR, tube, { kernel: WHERE, capacity: 16 * 5 * 2, attributes });
    await onDawn(shot(stage, { eye: [0, 4, 3], height: 4 }), async (session) => {
      const place = (await session.read("kernel_after", attributes as never, 160, "place")).floats;
      for (let slot = 0; slot < 160; slot += 1) {
        // 16 columns, 5 rows a sheet, 2 sheets.
        expect(vecAt(place, slot, 4), `slot ${slot}`).toEqual([slot % 16, Math.floor(slot / 16) % 5, Math.floor(slot / 80), 16 * 1000 + 5 * 10 + 2]);
      }
    });
  }, 120_000);

  it("a deck clamped into every sheet is lit by the plane's normal, and the pixels between two sheets are the background", async () => {
    /* The consumer's move: every vertex below y = −0.3 is put ON that level plane, which is
       not a move along the normal. The flat part of each tube then reads the plane's normal,
       straight down, because each sheet's normal is worked out from its own neighbours. */
    const DECK = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.y = max(p.position.y, -0.3);
  return q;
}`;
    /* Seen from below and in front, looking at the plane: X across, 24 pixels a metre. The
       tubes are at ±1 m (columns 24 and 72). Five vertices of each ring are below the plane
       and are put on it; the three middle ones have both neighbours on it too, so between
       them, 0.23 m either side of the tube's own line, the normal is the plane's exactly. */
    const below = { eye: [0, -3.3, 3] as Vec3, lookAt: [0, -0.3, 0] as Vec3, height: 4 };
    const decked = await pictures(shot(sweepChain("", PAIR, tube, { kernel: DECK, capacity: 16 * 5 * 2 }), below));
    for (const centre of [24, 72]) {
      for (let y = 44; y < 52; y += 1) {
        for (let x = centre - 4; x < centre + 4; x += 1) expect(at(decked.normal, x, y), `pixel ${x}, ${y}`).toEqual([128, 0, 128]);
      }
    }
    for (let y = 0; y < SIZE; y += 1) for (const x of [46, 47, 48, 49]) expect(at(decked.depth, x, y)[0], `between, ${x}, ${y}`).toBe(255);
    // Without the kernel the same pixels lean as a round tube's do.
    const round = await pictures(shot(sweepChain("", PAIR, tube), below));
    expect(at(round.normal, 16, 48)[0]).toBeLessThan(128 - 20);
    expect(at(round.normal, 31, 48)[0]).toBeGreaterThan(128 + 20);
  }, 240_000);
});

describe("a grid of several sheets from a Topology node (T1587b slice 2)", () => {
  /* Two flat squares, a metre apart, facing the camera: eight points, the second square's
     four after the first's. As ONE grid of two columns by four rows the second row of the
     first square is joined to the first row of the second; as two SHEETS it is not. */
  const SQUARES: Vec3[] = [
    [-1.5, -0.5, 0], [-0.5, -0.5, 0], [-1.5, 0.5, 0], [-0.5, 0.5, 0],
    [0.5, -0.5, 0], [1.5, -0.5, 0], [0.5, 0.5, 0], [1.5, 0.5, 0],
  ];
  const squares = (claim: Record<string, unknown>): Stage => ({
    nodes: [
      authoredPoints("kernel_squares", SQUARES).node,
      curveNode("topology_squares", "pointTopology", { connectivity: "grid", ...claim }),
      curveNode("geometry_skin", "geometry", { mode: "surface" }),
    ],
    edges: [curveEdge(["kernel_squares", "out"], ["topology_squares", "points"]), curveEdge(["topology_squares", "out"], ["geometry_skin", "points"])],
    geometries: ["geometry_skin"],
  });
  const front = { eye: [0, 0, 5] as Vec3, height: 4 };

  it("the Render draws two sheets as two squares; as one grid it joins them", async () => {
    const sheets = await pictures(shot(squares({ cols: 2, rows: 2, sheets: 2 }), front, { light: { direction: [0, 0, -1] } }));
    const joined = await pictures(shot(squares({ cols: 2, rows: 4 }), front, { light: { direction: [0, 0, -1] } }));
    // A square is 24 pixels a side: 576 pixels each.
    expect(drawn(sheets.depth)).toBe(2 * 24 * 24);
    expect(at(sheets.depth, 48, 48)[0]).toBe(255);
    expect(at(sheets.normal, 24, 48)).toEqual([128, 128, 255]);
    expect(at(sheets.normal, 72, 48)).toEqual([128, 128, 255]);
    /* The control: one grid of four rows has a third piece, from the first square's top edge
       to the second's bottom edge. Pixel (52, 50) is 0.19 m right of the middle and 0.10 m
       below it: inside that piece, and between the two squares. */
    expect(drawn(joined.depth)).toBeGreaterThan(drawn(sheets.depth));
    expect(at(joined.depth, 52, 50)[0]).not.toBe(255);
    expect(at(sheets.depth, 52, 50)[0]).toBe(255);
  }, 120_000);

  it("Render Surface draws them the same way: the two sheets are the two squares, each drawn alone, and nothing more", async () => {
    const drawnBy = async (points: ReadonlyArray<Vec3>, claim: Record<string, unknown>): Promise<Uint8Array> =>
      onDawn(
        curveGraph(
          [
            authoredPoints("kernel_squares", points).node,
            curveNode("topology_squares", "pointTopology", { connectivity: "grid", ...claim }),
            curveNode("surface_skin", "renderSurface", { eye: [0, 0, 5], lookAt: [0, 0, 0] }),
            curveNode("output_probe", "output"),
          ],
          [curveEdge(["kernel_squares", "out"], ["topology_squares", "points"]), curveEdge(["topology_squares", "out"], ["surface_skin", "points"]), curveEdge(["surface_skin", "out"], ["output_probe", "input"])],
        ),
        async (session) => (await session.readOutput()).bytes,
        SIZE,
      );
    const covers = (bytes: Uint8Array): number => {
      let count = 0;
      for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((bytes[pixel * 4] as number) > 0) count += 1;
      return count;
    };
    const sheets = await drawnBy(SQUARES, { cols: 2, rows: 2, sheets: 2 });
    const left = await drawnBy(SQUARES.slice(0, 4), { cols: 2, rows: 2 });
    const right = await drawnBy(SQUARES.slice(4), { cols: 2, rows: 2 });
    expect(covers(left)).toBeGreaterThan(50);
    expect(covers(right)).toBeGreaterThan(50);
    // Each pixel is the left square's, the right square's, or the background's: never anything else.
    const union = new Uint8Array(left.length);
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
      const from = (left[pixel * 4] as number) > 0 ? left : right;
      union.set(from.subarray(pixel * 4, pixel * 4 + 4), pixel * 4);
    }
    expect(differing(sheets, union)).toEqual(SAME);
    // The control: one grid of four rows covers more, the piece that joins them.
    const joined = await drawnBy(SQUARES, { cols: 2, rows: 4 });
    expect(covers(joined)).toBeGreaterThan(covers(sheets));
  }, 120_000);
});
