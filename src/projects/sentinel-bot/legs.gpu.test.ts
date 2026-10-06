import { beforeAll, describe, expect, it } from "vitest";
import { ropeAttributes } from "../../nodes/definitions/point-rope.ts";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice, pointRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, expressionSlot, graph, node, settings } from "../../examples/documents/builders.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";
import { JOINT_ATTRIBUTES, jointKernel } from "./rig.ts";

/**
 * T1561b — THE LEGS AS ROPES, read off the Rope's own points frame by frame on a real GPU.
 *
 * The rig says where a tentacle leaves the body, where its claw is and how firmly it holds; a
 * Rope makes the length between. What that owes whoever watches: the rings keep their pitch,
 * the ends that are held are exactly where the rig put them (a planted claw on its rung, a
 * socket on the body), nothing moves faster than a tentacle can, and the rope is the
 * difference: with it held off, every point is the rig's own.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const FACTS = KIT_FIXTURE;
const TENTACLES = FACTS.sockets.length;
const RINGS = FACTS.ringCount;
const POINTS = TENTACLES * RINGS;
const FPS = 60;
/** Metres a second it walks at: the panel's own default. */
const SPEED = 3.2;

type Vec = [number, number, number];
const minus = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);

interface Walked {
  readonly frames: number;
  /** A ring as the Rope left it, and as the rig asked for it. */
  rope(frame: number, tentacle: number, ring: number): Vec;
  rig(frame: number, tentacle: number, ring: number): Vec;
  hold(frame: number, tentacle: number): number;
  /** How firmly every point of the tentacle is pinned to the rig's (its `pin`). */
  pin(frame: number, tentacle: number): number;
  /** Whether the rig has this ring out of the body (a holding tentacle winds its slack in). */
  out(frame: number, tentacle: number, ring: number): boolean;
}

async function walk(frames: number, parameters: Record<string, unknown> = {}, rope: Record<string, unknown> = {}): Promise<Walked> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const strands = node("kernel_ring", "pointKernel", [0, 0], {
    capacity: POINTS,
    attributes: JOINT_ATTRIBUTES,
    kernel: jointKernel(FACTS, [[0, 0, 0]], { first: 0, count: RINGS }, { rope: true }),
    travel: expressionSlot(`abstime * ${SPEED}`, 0),
    variety: 0,
    wave: 0,
    ...parameters,
  } as never);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        strands,
        node("topology_legs", "pointTopology", [0, 0], { connectivity: "strips", cols: RINGS, rows: TENTACLES }),
        // The document's own settings (document.ts, rope_legs).
        node("rope_legs", "pointRope", [0, 0], { updateRate: 240, minSteps: 2, maxSteps: 8, iterations: 8, gravity: 0, damping: 1.5, segmentLength: FACTS.ringPitch, anchorFirst: 1, anchorSecond: 1, anchorLast: { mode: "map", bindings: { static: { kind: "static", value: 0 }, map: { kind: "map", attribute: "hold" } } }, pinAttribute: "pin", anchorMode: "hard", teleportDistance: 100, teleportMode: "carry", ...rope } as never),
        node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
        node("geometry_legs", "geometry", [0, 0], { mode: "points", material: "material_dot" }, { label: "geometry_legs" }),
        node("camera_any", "camera", [0, 0], {}, { label: "camera_any" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_legs", camera: "camera_any", lights: "" }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [edge("legs-strands", ["kernel_ring", "out"], ["topology_legs", "points"]), edge("legs-rope", ["topology_legs", "out"], ["rope_legs", "in"]), edge("legs-geo", ["rope_legs", "out"], ["geometry_legs", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: 32, height: 32 } }),
    frames,
    fps: FPS,
    // Expressions only run when asked (the travel here is one).
    animate: true,
    outputNodeId: "output_frame",
    probeBuffers: [pointStorageId("kernel_ring"), pointStorageId("rope_legs")],
    probeFrames: Array.from({ length: frames }, (_, index) => index),
  } as never);
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const probed = result.bufferFrames;
  if (probed === undefined || probed.length !== frames) throw new Error("the walk was not read frame by frame");
  const read = probed.map((frame) => {
    const kernel = frame.buffers[pointStorageId("kernel_ring")];
    const roped = frame.buffers[pointStorageId("rope_legs")];
    if (kernel === undefined || roped === undefined) throw new Error("a frame's buffers are missing");
    return {
      rig: kernelRegionSlice(strands as never, kernel, "position").floats,
      hold: kernelRegionSlice(strands as never, kernel, "hold").floats,
      pin: kernelRegionSlice(strands as never, kernel, "pin").floats,
      kind: kernelRegionSlice(strands as never, kernel, "kind").floats,
      rope: pointRegionSlice(roped, ropeAttributes({ tension: false }), POINTS, "position").floats,
    };
  });
  const at = (floats: Float32Array, point: number): Vec => {
    const stride = floats.length / POINTS;
    return [floats[point * stride] as number, floats[point * stride + 1] as number, floats[point * stride + 2] as number];
  };
  return {
    frames,
    rope: (frame, tentacle, ring) => at(read[frame]!.rope, tentacle * RINGS + ring),
    rig: (frame, tentacle, ring) => at(read[frame]!.rig, tentacle * RINGS + ring),
    hold: (frame, tentacle) => read[frame]!.hold[tentacle * RINGS + RINGS - 1] as number,
    pin: (frame, tentacle) => read[frame]!.pin[tentacle * RINGS + RINGS - 1] as number,
    out: (frame, tentacle, ring) => (read[frame]!.kind[tentacle * RINGS + ring] as number) > -0.5,
  };
}

/** The angle a tentacle turns through at each ring that is out, radians: 0 along a straight run. */
function turns(walked: Walked, frame: number, tentacle: number): number[] {
  const found: number[] = [];
  for (let ring = 0; ring + 2 < RINGS; ring += 1) {
    if (!walked.out(frame, tentacle, ring)) continue;
    const [a, b, c] = [walked.rope(frame, tentacle, ring), walked.rope(frame, tentacle, ring + 1), walked.rope(frame, tentacle, ring + 2)];
    const [u, v] = [minus(b, a), minus(c, b)];
    found.push(Math.acos(Math.min(1, Math.max(-1, (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (norm(u) * norm(v))))));
  }
  return found;
}

/** The rope is let settle for half a second before anything is read off it. */
const SETTLED = 30;

describe("the sentinel's legs as ropes (T1561b)", () => {
  it("walking: a tentacle on a rung is the rig's own arc; one that holds nothing is a rope drawn after its shape, at its own pitch, without a fold", async () => {
    // Twelve seconds at the piece's own Crawl: six of the ten hold, and which six moves round the body, so
    // tentacles let go and take hold inside the walk.
    const frames = 720;
    const walked = await walk(frames, { crawl: 0.6 });
    let held = 0;
    let loose = 0;
    let handing = 0;
    let fastest = 0;
    let sharpest = 0;
    let lagging = 0;
    let stretch = 0;
    let offRig = 0;
    let secondOff = 0;
    let lagDrawn = 0;
    let gripping = 0;
    for (let frame = SETTLED; frame < frames; frame += 1) {
      for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
        const pin = walked.pin(frame, tentacle);
        // The socket is the body's, whatever the rest is doing, and so is the next ring out, to within 2 mm: the
        // rig's own first two rings are up to 2.5 per cent nearer each other than a ring is long (a trailing
        // tentacle's shape keeps its length only roughly), and of two anchors the Rope cannot both keep, the
        // earlier holds.
        expect(norm(minus(walked.rope(frame, tentacle, 0), walked.rig(frame, tentacle, 0)))).toBe(0);
        secondOff = Math.max(secondOff, norm(minus(walked.rope(frame, tentacle, 1), walked.rig(frame, tentacle, 1))));
        if (pin >= 1) {
          held += 1;
          // Holding the wall: every ring where the rig put it (how near is asserted below, once for the walk)…
          for (let ring = 0; ring < RINGS; ring += 1) offRig = Math.max(offRig, norm(minus(walked.rope(frame, tentacle, ring), walked.rig(frame, tentacle, ring))));
          // …and a claw that has all of its rung is on it exactly: that end is an Anchor's.
          if (walked.hold(frame, tentacle) >= 1) {
            gripping += 1;
            expect([frame, tentacle, norm(minus(walked.rope(frame, tentacle, RINGS - 1), walked.rig(frame, tentacle, RINGS - 1)))]).toEqual([frame, tentacle, 0]);
          }
          continue;
        }
        if (pin <= 0) loose += 1;
        else handing += 1;
        const socketMoved = minus(walked.rope(frame, tentacle, 0), walked.rope(frame - 1, tentacle, 0));
        // (The first segment is two held points: it is as long as the rig made it.)
        for (let ring = 1; ring + 1 < RINGS; ring += 1) {
          if (!walked.out(frame, tentacle, ring) || !walked.out(frame, tentacle, ring + 1)) continue;
          const [a, b] = [walked.rope(frame, tentacle, ring), walked.rope(frame, tentacle, ring + 1)];
          stretch = Math.max(stretch, Math.abs(norm(minus(b, a)) / FACTS.ringPitch - 1));
          fastest = Math.max(fastest, norm(minus(minus(a, walked.rope(frame - 1, tentacle, ring)), socketMoved)) * FPS);
          lagging = Math.max(lagging, norm(minus(a, walked.rig(frame, tentacle, ring))));
          if (ring < RINGS - 16 && pin <= 0) lagDrawn = Math.max(lagDrawn, norm(minus(a, walked.rig(frame, tentacle, ring))));
        }
        if (pin <= 0 && frame >= 240) sharpest = Math.max(sharpest, ...turns(walked, frame, tentacle));
      }
    }
    // All three were in the walk: holding, loose, and being handed back to the rig as it takes the wall.
    expect(held).toBeGreaterThan(1000);
    expect(loose).toBeGreaterThan(500);
    expect(handing).toBeGreaterThan(50);
    expect(gripping).toBeGreaterThan(500);
    // A holding tentacle is the rig's arc: no ring of it further from the rig's point than this (measured 10 cm,
    // in the frame one is handed back, closing to nothing over a fifth of a second; a held ring swung fast on a
    // step trails by millimetres, the Rope's Pin Attribute being a very stiff pull and not a hold to the bit).
    expect(offRig).toBeLessThan(0.15);
    // The second ring out: within a centimetre (measured 8 mm). The rig's own first two rings are up to 2.5 per
    // cent nearer each other than a ring is long (a trailing shape keeps its length only roughly), and of two
    // anchors the Rope cannot both keep, the earlier holds.
    expect(secondOff).toBeLessThan(0.012);
    // A rope keeps its length (measured: within two hundredths of a per cent).
    expect(stretch).toBeLessThan(0.005);
    // It IS a rope: the rings it is drawn by are up to a hand's breadth from where the rig's shape has them
    // (measured 13 cm), and its last rings, which run free, a good deal further (1.5 m)…
    expect(lagDrawn).toBeGreaterThan(0.05);
    expect(lagDrawn).toBeLessThan(0.3);
    expect(lagging).toBeGreaterThan(lagDrawn);
    // …and never thrown: against its own socket no ring moves faster than this (measured 5.3 m/s).
    expect(fastest).toBeLessThan(8);
    // A loose tentacle does not fold: no ring turns from the last by more than this (measured 31 degrees; the rig's
    // own shape is 14 at its sharpest). NOT claimed, and measured: a tentacle in the few frames of being handed
    // back kinks at the socket, 59 degrees, which is the Rope's bend limit's to stop (§T1585b).
    expect((sharpest * 180) / Math.PI).toBeLessThan(40);
  }, 600_000);

  it("swimming: every tentacle is rope, streaming aft and following its shape late; Follow says how late", async () => {
    const frames = 600;
    const swim = async (follow: number): Promise<{ lag: number; behind: number; sharpest: number; stretch: number }> => {
      const swum = await walk(frames, { swim: 1, stroke: 0.55, carry: 0, follow });
      let lag = 0;
      let behind = Infinity;
      let sharpest = 0;
      let stretch = 0;
      // Settled: four seconds in (the rope starts on the rig's own points, at rest in a body that is moving).
      for (let frame = 240; frame < frames; frame += 1) {
        for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
          expect(swum.pin(frame, tentacle)).toBe(0);
          behind = Math.min(behind, swum.rope(frame, tentacle, 0)[2] - swum.rope(frame, tentacle, RINGS - 1)[2]);
          sharpest = Math.max(sharpest, ...turns(swum, frame, tentacle));
          for (let ring = 1; ring + 1 < RINGS; ring += 1) {
            stretch = Math.max(stretch, Math.abs(norm(minus(swum.rope(frame, tentacle, ring + 1), swum.rope(frame, tentacle, ring))) / FACTS.ringPitch - 1));
            // Up to where it is still drawn to its shape: the last rings run free.
            if (ring < RINGS - 16) lag = Math.max(lag, norm(minus(swum.rope(frame, tentacle, ring), swum.rig(frame, tentacle, ring))));
          }
        }
      }
      return { lag, behind, sharpest, stretch };
    };
    const [slack, piece, tight] = [await swim(0.05), await swim(0.4), await swim(0.95)];
    // Towed, it streams aft: every claw well over two metres behind its socket at every frame (measured 2.9 m).
    expect(piece.behind).toBeGreaterThan(2.5);
    // Its length kept, and smooth: no ring turns from the last by more than this (measured 8 degrees).
    expect(piece.stretch).toBeLessThan(0.005);
    expect((piece.sharpest * 180) / Math.PI).toBeLessThan(20);
    // Late, and Follow is how late: barely drawn it is half as far again from its shape (measured 12 cm against 7).
    expect(piece.lag).toBeGreaterThan(0.03);
    expect(slack.lag).toBeGreaterThan(piece.lag * 1.3);
    // Drawn as firmly as can be it gets no nearer, and buckles: the shape the rig gives a trailing tentacle is a few
    // centimetres shorter than the tentacle, and a rope held to every point of a shorter curve has nowhere to put
    // the rest (measured 31 degrees between rings against 8). Which is why Follow is not 1.
    expect(tight.lag).toBeGreaterThan(piece.lag * 0.8);
    expect(tight.sharpest).toBeGreaterThan(piece.sharpest * 2);
  }, 600_000);

  it("is the difference: with the Rope held off (Reset) every ring is the rig's own at every frame", async () => {
    const frames = 90;
    const off = await walk(frames, { swim: 1, stroke: 0.55, carry: 0 }, { reset: true });
    const on = await walk(frames, { swim: 1, stroke: 0.55, carry: 0 });
    let apart = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
        for (let ring = 0; ring < RINGS; ring += 1) {
          expect(norm(minus(off.rope(frame, tentacle, ring), off.rig(frame, tentacle, ring)))).toBe(0);
          apart = Math.max(apart, norm(minus(on.rope(frame, tentacle, ring), on.rig(frame, tentacle, ring))));
        }
      }
    }
    expect(apart).toBeGreaterThan(0.1);
  }, 300_000);
});
