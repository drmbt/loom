import { describe, expect, it } from "vitest";

import type { GraphNode } from "../../domain/types/graph.ts";
import type { Vec3 } from "../../points/curve.ts";
import { authoredPoints, curveEdge, curveGraph, curveNode, onDawn, type ReadPort } from "./curve-test-support.ts";

/**
 * Sweep (T1587b slices 1 and 3) THROUGH THE RENDER, asserted on pixels.
 *
 * A sweep publishes a grid, and a Geometry in Surface mode draws a grid with the path it
 * always had. These tests hold the four things the design rests on that only a picture can
 * show (`docs/sweep-design-2026-10-05.md`):
 *
 *  - a Ring along a straight path IS the Tube generator's surface, to the byte, lit and
 *    shadowed;
 *  - a kernel AFTER the sweep may write `position`, and the surface is lit by the normal of
 *    the shape it ends up with (the reason for a grid claim over a mesh claim, D1): a tube
 *    clamped to a level plane reads that plane's normal on the flattened part;
 *  - two columns in one place make a hard edge: a Square's face reads one normal across its
 *    whole width;
 *  - a cap closes its end: it covers exactly the outline's pixels in the Depth output, and
 *    every one of them reads the end's normal.
 *
 * Every expectation is an exact byte (§V147). The cameras are orthographic and look along
 * an axis, so a pixel is a known place: 64 pixels across 2 metres, 1/32 m a pixel. The
 * Normal output is `n × 0.5 + 0.5`, so an axis is 0, 128 or 255.
 */

const SIZE = 64;
const NORMAL: ReadPort = { nodeId: "render_shot", portId: "normal" };
const DEPTH: ReadPort = { nodeId: "render_shot", portId: "depth" };

const LINE: ReadonlyArray<Vec3> = [0, 1, 2, 3, 4].map((step): Vec3 => [0, 0, -1 + step * 0.5]);

interface Stage {
  /** The nodes and edges that end in a pointset named by `last`. */
  readonly nodes: ReadonlyArray<GraphNode>;
  readonly edges: ReadonlyArray<ReturnType<typeof curveEdge>>;
  readonly last: string;
}

/** kernel_path → topology_path → frames_path → sweep_skin, optionally → a kernel after it. */
function sweptStage(
  sweep: Record<string, unknown>,
  options: {
    readonly positions?: ReadonlyArray<Vec3>;
    /** A kernel between the sweep and the Geometry, over as many points as the sweep has vertices. */
    readonly after?: { readonly kernel: string; readonly capacity: number };
    readonly outline?: { readonly positions: ReadonlyArray<Vec3>; readonly closed: boolean };
  } = {},
): Stage {
  const positions = options.positions ?? LINE;
  const path = authoredPoints("kernel_path", positions);
  const outline = options.outline === undefined ? undefined : authoredPoints("kernel_outline", options.outline.positions);
  const nodes: GraphNode[] = [
    path.node,
    curveNode("topology_path", "pointTopology", { connectivity: "strips", cols: positions.length, rows: 1 }),
    curveNode("frames_path", "pointCurveFrames"),
    curveNode("sweep_skin", "pointSweep", { uvAlong: "points", ...sweep }),
  ];
  const edges = [
    curveEdge(["kernel_path", "out"], ["topology_path", "points"]),
    curveEdge(["topology_path", "out"], ["frames_path", "points"]),
    curveEdge(["frames_path", "out"], ["sweep_skin", "points"]),
  ];
  if (outline !== undefined) {
    nodes.push(
      outline.node,
      curveNode("topology_outline", "pointTopology", {
        connectivity: "strips",
        cols: options.outline!.positions.length,
        rows: 1,
        wrapU: options.outline!.closed,
      }),
    );
    edges.push(curveEdge(["kernel_outline", "out"], ["topology_outline", "points"]), curveEdge(["topology_outline", "out"], ["sweep_skin", "profile"]));
  }
  if (options.after === undefined) return { nodes, edges, last: "sweep_skin" };
  nodes.push(
    curveNode("kernel_after", "pointKernel", {
      capacity: options.after.capacity,
      seed: 7,
      attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
      kernel: options.after.kernel,
    }),
  );
  edges.push(curveEdge(["sweep_skin", "out"], ["kernel_after", "in"]));
  return { nodes, edges, last: "kernel_after" };
}

/** The Tube generator: the surface a Ring along +Z has to be. */
const tubeStage = (cols: number, rows: number, radius: number): Stage => ({
  nodes: [curveNode("tube_reference", "pointTube", { count: cols * rows, cols, rows, radius, sizeZ: 2 })],
  edges: [],
  last: "tube_reference",
});

/** A shot of one surface: an orthographic camera 2 m across, one light, the Normal and Depth outputs on. */
function shot(
  stage: Stage,
  camera: { readonly eye: Vec3; readonly lookAt?: Vec3 },
  options: { readonly light?: Record<string, unknown>; readonly floor?: boolean } = {},
) {
  const floor = authoredPoints("kernel_floor", [
    [-3, -1.5, -3],
    [3, -1.5, -3],
    [-3, -1.5, 3],
    [3, -1.5, 3],
  ]);
  const floorNodes: GraphNode[] =
    options.floor === true
      ? [floor.node, curveNode("topology_floor", "pointTopology", { connectivity: "grid", cols: 2, rows: 2 }), curveNode("geometry_floor", "geometry", { mode: "surface" })]
      : [];
  return curveGraph(
    [
      ...stage.nodes,
      ...floorNodes,
      curveNode("geometry_skin", "geometry", { mode: "surface" }),
      curveNode("camera_main", "camera", { eye: [...camera.eye], lookAt: [...(camera.lookAt ?? [0, 0, 0])], near: 0.1, far: 10, ortho: true, orthoHeight: 2 }),
      curveNode("light_key", "light", { kind: "directional", direction: [0, -1, 0], intensity: 0.8, shadows: false, ...options.light }),
      curveNode("render_shot", "render", {
        scenes: options.floor === true ? "geometry_skin geometry_floor" : "geometry_skin",
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
      curveEdge([stage.last, "out"], ["geometry_skin", "points"]),
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

async function pictures(graph: ReturnType<typeof shot>): Promise<Pictures> {
  return onDawn(
    graph,
    async (session) => {
      expect(session.plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
      const lit = await session.readOutput();
      const normal = await session.readPort(NORMAL.nodeId, NORMAL.portId);
      const depth = await session.readPort(DEPTH.nodeId, DEPTH.portId);
      // One byte a channel, no padding: `at` below indexes on that.
      for (const image of [lit, normal, depth]) expect([image.width, image.height, image.bytes.length]).toEqual([SIZE, SIZE, SIZE * SIZE * 4]);
      return { lit: lit.bytes, normal: normal.bytes, depth: depth.bytes };
    },
    SIZE,
    0,
    [NORMAL, DEPTH],
  );
}

const at = (bytes: Uint8Array, x: number, y: number): number[] => Array.from(bytes.subarray((y * SIZE + x) * 4, (y * SIZE + x) * 4 + 3));

describe("Sweep through the Render: a Ring along a straight path is the Tube (T1587b)", () => {
  it("draws the Tube generator's picture to the byte: lit, and with a shadow cast and received", async () => {
    const eye: Vec3 = [3, 3, 4];
    const sun = { direction: [-0.3, -1, -0.2], shadows: true, shadowExtent: 5 };
    const swept = await pictures(shot(sweptStage({ profile: "ring", sides: 16, radius: 0.5 }), { eye }, { floor: true, light: sun }));
    const tube = await pictures(shot(tubeStage(16, 5, 0.5), { eye }, { floor: true, light: sun }));
    expect(Buffer.compare(swept.lit, tube.lit), "lit").toBe(0);
    expect(Buffer.compare(swept.normal, tube.normal), "normal").toBe(0);
    expect(Buffer.compare(swept.depth, tube.depth), "depth").toBe(0);

    /* Equal pictures of nothing would pass, so: the tube is in the frame, it is shaded (more
       than one level on it), and its shadow is on the floor (the same shot with the light's
       shadows off is a different picture). */
    const levels = new Set<number>();
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) levels.add(swept.lit[pixel * 4] as number);
    expect(levels.size).toBeGreaterThan(8);
    const unshadowed = await pictures(shot(sweptStage({ profile: "ring", sides: 16, radius: 0.5 }), { eye }, { floor: true, light: { ...sun, shadows: false } }));
    let darker = 0;
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((swept.lit[pixel * 4] as number) < (unshadowed.lit[pixel * 4] as number)) darker += 1;
    expect(darker).toBeGreaterThan(50);
  }, 240_000);
});

describe("Sweep through the Render: a kernel after it may write position (T1587b, the design's D1)", () => {
  /* A tube of radius 1 along +Z, and a deck: every vertex below y = −0.5 is put ON that
     level plane. This is a move that is not along the normal — the consumer's deck is
     exactly this clamp — so the sweep's own `normal` attribute says nothing true about the
     flattened part: there it is still the ring's, pointing outward and down at an angle. */
  const DECK = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position.y = max(p.position.y, -0.5);
  return q;
}`;
  /* Seen from below and in front, looking at the middle of the deck. Along the picture's
     middle row a pixel is 1/32 m of X: columns 24 to 39 are within a quarter metre of the
     deck's centre line, well inside the flat part, which reaches ±0.38 m (the sixteenth
     of a turn either side of straight down). */
  const camera = { eye: [0, -3.5, 3] as Vec3, lookAt: [0, -0.5, 0] as Vec3 };
  const tube = { profile: "ring", sides: 16, radius: 1 };

  it("lights the flattened part by the plane's normal, straight down, on every pixel of it", async () => {
    const decked = await pictures(shot(sweptStage(tube, { after: { kernel: DECK, capacity: 16 * LINE.length } }), camera));
    for (let y = 28; y < 36; y += 1) {
      for (let x = 24; x < 40; x += 1) expect(at(decked.normal, x, y), `pixel ${x}, ${y}`).toEqual([128, 0, 128]);
    }
  }, 120_000);

  it("and without the kernel the same pixels read the round tube's normals, which lean", async () => {
    const round = await pictures(shot(sweptStage(tube), camera));
    // On the centre line the round tube faces straight down too; a quarter metre off it, it does not.
    const left = at(round.normal, 24, 32);
    const right = at(round.normal, 39, 32);
    expect(left[0]).toBeLessThan(128 - 20);
    expect(right[0]).toBeGreaterThan(128 + 20);
    expect(left[1]).toBeGreaterThan(0);
    expect(right[1]).toBeGreaterThan(0);
  }, 120_000);
});

describe("Sweep through the Render: hard edges are two columns in one place (T1587b)", () => {
  /* Seen square on from +X: the +X face of a Square of half-width 0.5 fills the picture's
     middle, 32 pixels of Y by 64 of Z. */
  const camera = { eye: [5, 0, 0] as Vec3 };
  const corners: ReadonlyArray<Vec3> = [
    [1, -1, 0],
    [1, 1, 0],
    [-1, 1, 0],
    [-1, -1, 0],
  ];

  it("a Square's face reads its own normal across its whole width", async () => {
    const square = await pictures(shot(sweptStage({ profile: "square", radius: 0.5 }), camera));
    for (let y = 18; y < 46; y += 1) {
      for (let x = 2; x < 62; x += 1) expect(at(square.normal, x, y), `pixel ${x}, ${y}`).toEqual([255, 128, 128]);
    }
  }, 120_000);

  it("the same four corners as a smooth outline shade round: the control", async () => {
    const outline = { positions: corners, closed: true };
    const smooth = await pictures(shot(sweptStage({ profile: "custom", radius: 0.5 }, { outline }), camera));
    // Up the face the normal swings from one corner's to the other's, through +X in the middle.
    const low = at(smooth.normal, 32, 40);
    const high = at(smooth.normal, 32, 23);
    expect(Math.abs((low[1] as number) - (high[1] as number))).toBeGreaterThan(60);
    // With Smooth off it is the Square again, byte for byte.
    const flat = await pictures(shot(sweptStage({ profile: "custom", radius: 0.5, smooth: false }, { outline }), camera));
    const square = await pictures(shot(sweptStage({ profile: "square", radius: 0.5 }), camera));
    expect(Buffer.compare(flat.normal, square.normal)).toBe(0);
    expect(Buffer.compare(flat.lit, square.lit)).toBe(0);
  }, 240_000);
});

describe("Sweep through the Render: Facing turns the normal, not the light (T1587b)", () => {
  /* A Strip is a flat ribbon in the XZ plane, seen from above and in front. */
  const camera = { eye: [0, 3, 3] as Vec3 };

  it("Outward reads +Y, Inward −Y, and both are lit alike: a grid surface is lit on both sides", async () => {
    const outward = await pictures(shot(sweptStage({ profile: "strip", sides: 2, radius: 0.5 }), camera));
    const inward = await pictures(shot(sweptStage({ profile: "strip", sides: 2, radius: 0.5, facing: "inward" }), camera));
    expect(at(outward.normal, 32, 32)).toEqual([128, 255, 128]);
    expect(at(inward.normal, 32, 32)).toEqual([128, 0, 128]);
    expect(Buffer.compare(outward.lit, inward.lit)).toBe(0);
    // And lit at all: the light comes straight down onto it.
    expect(at(outward.lit, 32, 32)[0]).toBeGreaterThan(100);
  }, 120_000);
});

describe("Sweep through the Render: a cap closes its end (T1587b slice 3)", () => {
  /* Seen from behind, square on to the start of the tube: an open tube shows nothing at all
     to an orthographic camera on its axis (its wall is edge on), a capped one shows its cap.
     The cap is 4 m from the camera and the far plane 10, so its depth is 0.4: byte 102. */
  const camera = { eye: [0, 0, -5] as Vec3 };
  const RADIUS = 0.476;
  const SIDES = 12;
  /** Pixels whose centre is inside the 12-sided outline, and how near the nearest centre comes to its edge (pixels). */
  const outlinePixels = (): { inside: Set<number>; margin: number } => {
    const corner = (k: number): [number, number] => [RADIUS * Math.cos((k / SIDES) * 2 * Math.PI) * 32, RADIUS * Math.sin((k / SIDES) * 2 * Math.PI) * 32];
    const inside = new Set<number>();
    let margin = Infinity;
    for (let y = 0; y < SIZE; y += 1) {
      for (let x = 0; x < SIZE; x += 1) {
        const px = x + 0.5 - SIZE / 2;
        const py = y + 0.5 - SIZE / 2;
        let within = true;
        for (let k = 0; k < SIDES; k += 1) {
          const [ax, ay] = corner(k);
          const [bx, by] = corner(k + 1);
          const side = ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) / Math.hypot(bx - ax, by - ay);
          margin = Math.min(margin, Math.abs(side));
          if (side < 0) within = false;
        }
        if (within) inside.add(y * SIZE + x);
      }
    }
    return { inside, margin };
  };

  it("covers exactly the outline's pixels at the end's depth, each with the end's normal", async () => {
    const expected = outlinePixels();
    /* No pixel centre is near enough to an edge for the device's rounding to decide it: the
       nearest is a few thousandths of a pixel off, and an f32 at this size rounds a
       millionth of one. */
    expect(expected.margin).toBeGreaterThan(0.005);
    expect(expected.inside.size).toBeGreaterThan(600);

    const capped = await pictures(shot(sweptStage({ profile: "ring", sides: SIDES, radius: RADIUS, caps: "start" }), camera));
    const covered = new Set<number>();
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
      const depth = capped.depth[pixel * 4] as number;
      if (depth === 102) covered.add(pixel);
      else expect(depth, `pixel ${pixel % SIZE}, ${Math.floor(pixel / SIZE)}`).toBe(255);
    }
    // A regular outline is its own mirror image, so which way X runs on screen does not matter.
    expect([...covered].sort((a, b) => a - b)).toEqual([...expected.inside].sort((a, b) => a - b));
    /* The cap's centre row has no normal of its own (its points coincide), and every pixel
       still reads the end's: −Z, out of the start of the tube. The fragment stage's stand-in
       for a missing normal is +Z, so a pixel that fell back to it would read 255 here. */
    for (const pixel of covered) expect(at(capped.normal, pixel % SIZE, Math.floor(pixel / SIZE)), `pixel ${pixel % SIZE}, ${Math.floor(pixel / SIZE)}`).toEqual([128, 128, 0]);
  }, 120_000);

  it("and without it there is a hole: nothing at that depth", async () => {
    const open = await pictures(shot(sweptStage({ profile: "ring", sides: SIDES, radius: RADIUS }), camera));
    let drawn = 0;
    for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) if ((open.depth[pixel * 4] as number) !== 255) drawn += 1;
    expect(drawn).toBe(0);
    // The other end's cap is 6 m away: Caps: End is not Caps: Start.
    const far = await pictures(shot(sweptStage({ profile: "ring", sides: SIDES, radius: RADIUS, caps: "end" }), camera));
    expect(at(far.depth, 32, 32)[0]).toBe(153);
  }, 120_000);
});
