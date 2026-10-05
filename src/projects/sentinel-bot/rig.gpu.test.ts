import { beforeAll, describe, expect, it } from "vitest";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";
import { pathAt } from "./path.ts";
import { JOINT_ATTRIBUTES, RIB_BLOCKS, RIB_COUNT, RIB_KERNEL, jointCount, jointKernel, stationsPerTentacle } from "./rig.ts";

/**
 * T1561b — the sentinel's rig, read off the JOINT BUFFER on a real GPU.
 *
 * What a tentacle owes whoever watches it: its rings never stretch or crowd, it never bends
 * tighter than a ring can take, a planted claw stays on its rung, and nothing pops. All four
 * are properties of where the joints are, so they are asserted there, not on pixels.
 *
 * One frame holds a whole walk: a pack of robots in unison (`variety` 0), each a short step
 * further along the tunnel than the last, IS one robot at that many successive instants —
 * the rig is a function of distance travelled, which is the property that makes this exact.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const FACTS = KIT_FIXTURE;
const TENTACLES = FACTS.sockets.length;
const STATIONS = stationsPerTentacle(FACTS);
const PER_ROBOT = jointCount(FACTS);
/** Two full strides at the default 3.2 m: every tentacle plants, holds, lets go and swings twice. */
const SPAN = 6.4;

type Vec = [number, number, number];
const minus = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec): number => Math.hypot(a[0], a[1], a[2]);

interface Walk {
  readonly instants: number;
  readonly step: number;
  /** A joint's place; undefined while it is stowed in the body. */
  at(instant: number, tentacle: number, station: number): Vec | undefined;
  slip(instant: number, tentacle: number, station: number): number;
}

async function walk(instants: number, parameters: Record<string, number> = {}): Promise<Walk> {
  const step = SPAN / instants;
  const robots = Array.from({ length: instants }, (_, index) => [0, 0, index * step] as const);
  // No wave: it is a deliberate departure from the arc, measured on its own below.
  const joints = node("joints", "pointKernel", [0, 0], { capacity: PER_ROBOT * instants, attributes: JOINT_ATTRIBUTES, kernel: jointKernel(FACTS, robots), variety: 0, wave: 0, ...parameters });
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        joints,
        node("mat", "materialUnlit", [0, 0], {}, { label: "mat1" }),
        node("geo", "geometry", [0, 0], { mode: "points", material: "mat1" }, { label: "geo1" }),
        node("cam", "camera", [0, 0], {}, { label: "cam1" }),
        node("shot", "render", [0, 0], { scenes: "geo1", camera: "cam1", lights: "" }),
        node("out", "output", [0, 0], {}),
      ],
      [edge("joints-geo", ["joints", "out"], ["geo", "points"]), edge("shot-out", ["shot", "out"], ["out", "input"])],
    ),
    settings: settings({ outputResolution: { width: 64, height: 64 } }),
    frames: 1,
    outputNodeId: "out",
    probeBuffers: [pointStorageId("joints")],
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const packed = (result.buffers ?? {})[pointStorageId("joints")];
  if (packed === undefined) throw new Error("probe buffers missing");
  const count = PER_ROBOT * instants;
  const read = (attribute: string): { floats: Float32Array; stride: number } => {
    const floats = kernelRegionSlice(joints as never, packed, attribute).floats;
    return { floats, stride: floats.length / count };
  };
  const position = read("position");
  const kind = read("kind");
  const slip = read("slip");
  const slot = (instant: number, tentacle: number, station: number): number => instant * PER_ROBOT + tentacle * STATIONS + station;
  return {
    instants,
    step,
    at(instant, tentacle, station) {
      const index = slot(instant, tentacle, station);
      if ((kind.floats[index * kind.stride] as number) < 0) return undefined;
      const base = index * position.stride;
      return [position.floats[base] as number, position.floats[base + 1] as number, position.floats[base + 2] as number];
    },
    slip: (instant, tentacle, station) => slip.floats[slot(instant, tentacle, station) * slip.stride] as number,
  };
}

/** The largest move any deployed ring makes between successive instants, with the body's own step taken out. */
function largestMove(steps: Walk): number {
  let largest = 0;
  for (let instant = 0; instant + 1 < steps.instants; instant += 1) {
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      for (let ring = 0; ring < FACTS.ringCount; ring += 1) {
        const here = steps.at(instant, tentacle, ring);
        const next = steps.at(instant + 1, tentacle, ring);
        if (here === undefined || next === undefined) continue;
        const move = minus(next, here);
        move[2] -= steps.step;
        largest = Math.max(largest, norm(move));
      }
    }
  }
  return largest;
}

describe("the sentinel's rig — every joint, across two strides", () => {
  beforeAll(() => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  });

  /** A ring is 98 mm across at a 60 mm pitch: under this radius neighbours would run into each other on the inside of the bend. */
  const TIGHTEST = 0.15;
  /** Positions here are within 16 m of the origin, where a float resolves 2e-6 m; a distance between two is good to this. */
  const RESOLUTION = 1e-5;

  it("keeps every ring at its pitch and every bend wider than a ring can take", async () => {
    const steps = await walk(240);
    const pitch = FACTS.ringPitch;
    // Neighbouring joints stand `pitch` apart ALONG an arc, so the straight distance between
    // them is that arc's chord: never more than the pitch, and for the tightest bend allowed
    // never less than pitch·(1 − pitch²/24r²).
    const shortest = pitch * (1 - (pitch * pitch) / (24 * TIGHTEST * TIGHTEST));
    let least = Infinity;
    let most = 0;
    let tightest = Infinity;
    let measured = 0;
    for (let instant = 0; instant < steps.instants; instant += 1) {
      for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
        for (let ring = 0; ring + 2 < FACTS.ringCount; ring += 1) {
          const a = steps.at(instant, tentacle, ring);
          const b = steps.at(instant, tentacle, ring + 1);
          const c = steps.at(instant, tentacle, ring + 2);
          if (a === undefined || b === undefined || c === undefined) continue;
          const first = minus(b, a);
          const second = minus(c, b);
          least = Math.min(least, norm(first), norm(second));
          most = Math.max(most, norm(first), norm(second));
          const cosine = (first[0] * second[0] + first[1] * second[1] + first[2] * second[2]) / (norm(first) * norm(second));
          const turn = Math.acos(Math.min(1, Math.max(-1, cosine)));
          if (turn > 1e-4) tightest = Math.min(tightest, norm(first) / turn);
          measured += 1;
        }
      }
    }
    // Nearly every ring of every tentacle at every instant was out and measured, so the bounds below are not vacuous.
    expect(measured).toBeGreaterThan(0.9 * steps.instants * TENTACLES * (FACTS.ringCount - 2));
    expect(most).toBeLessThanOrEqual(pitch + RESOLUTION);
    expect(least).toBeGreaterThanOrEqual(shortest - RESOLUTION);
    expect(tightest).toBeGreaterThanOrEqual(TIGHTEST);
  }, 120_000);

  it("keeps every planted claw on its rung, and says so when a rung is out of reach", async () => {
    const steps = await walk(240);
    let worst = 0;
    for (let instant = 0; instant < steps.instants; instant += 1) {
      for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) worst = Math.max(worst, steps.slip(instant, tentacle, FACTS.ringCount));
    }
    // The bow's half-turn is bisected to π/2²⁰ ≈ 3e-6 rad over a 3.37 m tentacle: 1e-5 m, plus the float's own resolution.
    expect(worst).toBeLessThanOrEqual(2 * RESOLUTION);
    // The same reading must be able to say "no": plant every claw 4 m ahead of a 3.37 m tentacle and it reports the shortfall.
    const overreached = await walk(24, { lead: 4 });
    let shortfall = 0;
    for (let instant = 0; instant < overreached.instants; instant += 1) {
      for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) shortfall = Math.max(shortfall, overreached.slip(instant, tentacle, FACTS.ringCount));
    }
    expect(shortfall).toBeGreaterThan(0.5);
  }, 120_000);

  it("stands on the same centreline the CPU reads: the tunnel's rings are centred on pathAt", async () => {
    // The WGSL path against its float64 definition, through a consumer: each ring of blocks
    // is laid around the centreline at its own distance, so the mean of a ring IS that point.
    const ribs = node("ribs", "pointKernel", [0, 0], { capacity: RIB_COUNT * RIB_BLOCKS, attributes: JOINT_ATTRIBUTES, kernel: RIB_KERNEL, travel: 333 });
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: graph(
        [
          ribs,
          node("mat", "materialUnlit", [0, 0], {}, { label: "mat1" }),
          node("geo", "geometry", [0, 0], { mode: "points", material: "mat1" }, { label: "geo1" }),
          node("cam", "camera", [0, 0], {}, { label: "cam1" }),
          node("shot", "render", [0, 0], { scenes: "geo1", camera: "cam1", lights: "" }),
          node("out", "output", [0, 0], {}),
        ],
        [edge("ribs-geo", ["ribs", "out"], ["geo", "points"]), edge("shot-out", ["shot", "out"], ["out", "input"])],
      ),
      settings: settings({ outputResolution: { width: 64, height: 64 } }),
      frames: 1,
      outputNodeId: "out",
      probeBuffers: [pointStorageId("ribs")],
    });
    const packed = (result.buffers ?? {})[pointStorageId("ribs")];
    if (packed === undefined) throw new Error("probe buffers missing");
    const floats = kernelRegionSlice(ribs as never, packed, "position").floats;
    const stride = floats.length / (RIB_COUNT * RIB_BLOCKS);
    for (let rib = 0; rib < RIB_COUNT; rib += 1) {
      const mean: Vec = [0, 0, 0];
      for (let block = 0; block < RIB_BLOCKS; block += 1) {
        const base = (rib * RIB_BLOCKS + block) * stride;
        for (let axis = 0; axis < 3; axis += 1) mean[axis] = (mean[axis] as number) + (floats[base + axis] as number) / RIB_BLOCKS;
      }
      const expected = pathAt(mean[2]);
      // At z ≈ 333 m a float resolves 3e-5 m; the mean of 24 such readings is good to that.
      expect(Math.abs(mean[0] - expected[0])).toBeLessThan(1e-4);
      expect(Math.abs(mean[1] - expected[1])).toBeLessThan(1e-4);
    }
  }, 120_000);

  it("swims: every claw lets go and trails behind its socket, flung wide at the top of the beat and drawn in after the snap", async () => {
    /** How far behind its socket each claw trails (metres), and how far off the tunnel's axis the claws stand on average. */
    const trailing = async (stroke: number): Promise<{ behind: number[]; spread: number }> => {
      const pose = await walk(1, { swim: 1, stroke });
      const behind: number[] = [];
      let spread = 0;
      for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
        // Ring 0's joint is the socket (the kit's ring_start is 0); the hub is the claw's wrist.
        const socket = pose.at(0, tentacle, 0);
        const claw = pose.at(0, tentacle, FACTS.ringCount);
        if (socket === undefined || claw === undefined) throw new Error("a swimming tentacle is stowed");
        // Nothing is planted, so nothing can be off its rung.
        expect(pose.slip(0, tentacle, FACTS.ringCount)).toBe(0);
        behind.push(socket[2] - claw[2]);
        const axis = pathAt(claw[2]);
        spread += Math.hypot(claw[0] - axis[0], claw[1] - axis[1]) / TENTACLES;
      }
      return { behind, spread };
    };
    const open = await trailing(0);
    const shut = await trailing(0.3);
    // A 3.18 m tentacle streaming aft: every wrist is well over a metre behind its socket once drawn in, and still behind it when flung open.
    expect(Math.min(...shut.behind)).toBeGreaterThan(1.5);
    expect(Math.min(...open.behind)).toBeGreaterThan(0);
    // The beat is the difference: cut `stroke` and the two poses are one. Open, the claws stand at least a metre further off the axis.
    expect(open.spread - shut.spread).toBeGreaterThan(1);
  }, 120_000);

  it("moves without a pop: halve the step and the largest move halves with it", async () => {
    // A continuous motion's largest move shrinks with the step it is sampled at; a pop does
    // not, it is the same jump however finely you look. So the ratio is 2 for a smooth rig
    // and 1 for one that jumps. (The bracketed two-arc solver this rig replaced read 1.0.)
    const coarse = largestMove(await walk(240));
    const fine = largestMove(await walk(480));
    expect(coarse / fine).toBeGreaterThan(1.7);
    expect(coarse / fine).toBeLessThan(2.3);
  }, 180_000);
});
