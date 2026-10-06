import { beforeAll, describe, expect, it } from "vitest";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { evaluateExpression } from "../../domain/expressions/evaluate.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";
import { CHAMBERS, chamberAt, pathAt } from "./path.ts";
import { FIELD_BERTH, JOINT_ATTRIBUTES, SWIM, jointCount, jointKernel, spinePick, swimLungeExpression } from "./rig.ts";
import { BORE_ATTRIBUTES, BORE_KERNEL, LAMP_HANGS, lampHeightExpression } from "./tunnel.ts";

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
/** The spine of every tentacle: its ring joints, then its hub. Station `ringCount` is the wrist. */
const SPINE = spinePick(FACTS);
const STATIONS = FACTS.ringCount + 1;
const PER_ROBOT = jointCount(FACTS, SPINE);
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
  /** Where a tentacle leaves the body: its first ring's place, which a stowed ring keeps. */
  socket(instant: number, tentacle: number): Vec;
  slip(instant: number, tentacle: number, station: number): number;
  /** How much of a pulse is on the joint: 0 at rest. */
  charge(instant: number, tentacle: number, station: number): number;
}

async function walk(count: number, parameters: Record<string, number | number[]> = {}, places?: ReadonlyArray<readonly [number, number, number]>): Promise<Walk> {
  // Handed places, it is a pack standing in them, not one robot's successive instants.
  const instants = places?.length ?? count;
  const step = SPAN / instants;
  const robots = places ?? Array.from({ length: instants }, (_, index) => [0, 0, index * step] as const);
  // No wave: it is a deliberate departure from the arc, measured on its own below.
  const joints = node("kernel_joints", "pointKernel", [0, 0], { capacity: PER_ROBOT * instants, attributes: JOINT_ATTRIBUTES, kernel: jointKernel(FACTS, robots, SPINE), variety: 0, wave: 0, ...parameters });
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        joints,
        node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
        node("geometry_joints", "geometry", [0, 0], { mode: "points", material: "material_dot" }, { label: "geometry_joints" }),
        node("camera_any", "camera", [0, 0], {}, { label: "camera_any" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_joints", camera: "camera_any", lights: "" }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [edge("joints-geo", ["kernel_joints", "out"], ["geometry_joints", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: 64, height: 64 } }),
    frames: 1,
    outputNodeId: "output_frame",
    probeBuffers: [pointStorageId("kernel_joints")],
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const packed = (result.buffers ?? {})[pointStorageId("kernel_joints")];
  if (packed === undefined) throw new Error("probe buffers missing");
  const points = PER_ROBOT * instants;
  const read = (attribute: string): { floats: Float32Array; stride: number } => {
    const floats = kernelRegionSlice(joints as never, packed, attribute).floats;
    return { floats, stride: floats.length / points };
  };
  const position = read("position");
  const kind = read("kind");
  const slip = read("slip");
  const charge = read("charge");
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
    socket(instant, tentacle) {
      const base = slot(instant, tentacle, 0) * position.stride;
      return [position.floats[base] as number, position.floats[base + 1] as number, position.floats[base + 2] as number];
    },
    slip: (instant, tentacle, station) => slip.floats[slot(instant, tentacle, station) * slip.stride] as number,
    charge: (instant, tentacle, station) => charge.floats[slot(instant, tentacle, station) * charge.stride] as number,
  };
}

/**
 * Where a point is across the tunnel: right and up of the centreline, on the tunnel's own frame at the place
 * along it the point is abreast of. (The tunnel turns by tens of degrees: world x is not "right" in a bend.)
 */
function acrossTunnel(point: Vec): [number, number] {
  const tangentAt = (z: number): Vec => {
    const [ahead, behind] = [pathAt(z + 0.01), pathAt(z - 0.01)];
    const along = minus(ahead, behind);
    const length = norm(along);
    return [along[0] / length, along[1] / length, along[2] / length];
  };
  let z = point[2];
  // Abreast: the centreline's own tangent there has no part in what is left over.
  for (let pass = 0; pass < 8; pass += 1) {
    const [off, tangent] = [minus(point, pathAt(z)), tangentAt(z)];
    z += (off[0] * tangent[0] + off[1] * tangent[1] + off[2] * tangent[2]) / tangent[2];
  }
  const [off, forward] = [minus(point, pathAt(z)), tangentAt(z)];
  // The rig's own frame (path.ts, pathFrame): right is level, up is what is left.
  const level = Math.hypot(forward[2], forward[0]);
  const right: Vec = [forward[2] / level, 0, -forward[0] / level];
  const up: Vec = [forward[1] * right[2] - forward[2] * right[1], forward[2] * right[0] - forward[0] * right[2], forward[0] * right[1] - forward[1] * right[0]];
  return [off[0] * right[0] + off[1] * right[1] + off[2] * right[2], off[0] * up[0] + off[1] * up[1] + off[2] * up[2]];
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
    // Most rings of every tentacle at every instant were out and measured, so the bounds below are not vacuous.
    // (Three quarters: a holding tentacle winds its slack into the body rather than bow more than 92 degrees, and
    // in this bore that is a quarter of its rings on average. It was over nine tenths while a tentacle might bow
    // through a half circle.)
    expect(measured).toBeGreaterThan(0.7 * steps.instants * TENTACLES * (FACTS.ringCount - 2));
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

  it("stands on the same centreline the CPU reads: a plain bore's rings are centred on pathAt", async () => {
    // The WGSL path against its float64 definition, through a consumer: with no relief and no
    // deck every row of the bore is a circle round the centreline at its own distance, so the
    // mean of a row IS that point.
    const COLS = 33;
    const ROWS = 48;
    const bore = node("kernel_bore", "pointKernel", [0, 0], { capacity: COLS * ROWS, attributes: BORE_ATTRIBUTES, kernel: BORE_KERNEL, travel: 350, relief: 0, deck: 2 });
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: graph(
        [
          node("grid_bore", "pointGrid", [0, 0], { cols: COLS, rows: ROWS, count: COLS * ROWS, sizeX: 2, sizeY: 2 }),
          bore,
          node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
          node("geometry_wall", "geometry", [0, 0], { mode: "surface", material: "material_dot" }, { label: "geometry_wall" }),
          node("camera_any", "camera", [0, 0], {}, { label: "camera_any" }),
          node("render_shot", "render", [0, 0], { scenes: "geometry_wall", camera: "camera_any", lights: "" }, { label: "render_shot" }),
          node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
        ],
        [edge("grid-bore", ["grid_bore", "out"], ["kernel_bore", "in"]), edge("bore-geo", ["kernel_bore", "out"], ["geometry_wall", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
      ),
      settings: settings({ outputResolution: { width: 64, height: 64 } }),
      frames: 1,
      outputNodeId: "output_frame",
      probeBuffers: [pointStorageId("kernel_bore")],
    });
    const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
    const packed = (result.buffers ?? {})[pointStorageId("kernel_bore")];
    if (packed === undefined) throw new Error("probe buffers missing");
    const floats = kernelRegionSlice(bore as never, packed, "position").floats;
    const stride = floats.length / (COLS * ROWS);
    let swollen = 0;
    for (let row = 0; row < ROWS; row += 1) {
      const mean: Vec = [0, 0, 0];
      // The last column repeats the first (the seam), so a turn is the first COLS − 1.
      for (let column = 0; column < COLS - 1; column += 1) {
        const base = (row * COLS + column) * stride;
        for (let axis = 0; axis < 3; axis += 1) mean[axis] = (mean[axis] as number) + (floats[base + axis] as number) / (COLS - 1);
      }
      const expected = pathAt(mean[2]);
      // The window is rows at z ≈ 323 to 330 m, up the flare of the hall at 336 m. There a float resolves 3e-5 m; the mean of 32 such readings is good to that.
      expect(Math.abs(mean[0] - expected[0])).toBeLessThan(1e-4);
      expect(Math.abs(mean[1] - expected[1])).toBeLessThan(1e-4);
      // …and the wall stands where the CPU's chamber says: the liner is 5 cm outside a bore of 2.6 m that a hall swells.
      const first = row * COLS * stride;
      const radius = Math.hypot((floats[first] as number) - mean[0], (floats[first + 1] as number) - mean[1], (floats[first + 2] as number) - mean[2]);
      expect(Math.abs(radius - (2.6 * (1 + CHAMBERS.swell * chamberAt(mean[2])) + 0.05))).toBeLessThan(2e-4);
      // A lamp here hangs under THIS wall's crown, hall or bore, by what the document's own expression says:
      // its light, its lit air and its picture in the steel are all placed by it. (At the plain bore's height
      // in a hall they hung 2.3 m under the plate: a ball of lit air with a gap over it.)
      const lamp = evaluateExpression(lampHeightExpression("z", "bore"), { z: mean[2], bore: 2.6 });
      if (!lamp.ok) throw new Error("the lamp's height does not evaluate");
      expect(Math.abs(lamp.value - (mean[1] + radius - 0.05 - LAMP_HANGS))).toBeLessThan(3e-4);
      swollen = Math.max(swollen, chamberAt(mean[2]));
    }
    // The window really did cross into a hall, so the line above was not read on plain bore alone.
    expect(swollen).toBeGreaterThan(0.5);
  }, 120_000);

  it("swims: every claw lets go and trails behind its socket, flung wide at the top of the beat and drawn in after the snap", async () => {
    /** How far behind its socket each claw trails (metres), and how far off the tunnel's axis the claws stand on average. */
    const trailing = async (stroke: number): Promise<{ behind: number[]; spread: number }> => {
      // On rails (Carry 0): adrift, the body noses off the tunnel's heading, and "behind" below is measured along the tunnel.
      const pose = await walk(1, { swim: 1, stroke, carry: 0 });
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
    // The beat reaches the ends a fifth of a bar late (that lag is the drag), so the ends are widest a
    // little after the top of the beat and drawn in by the middle of the bar.
    const open = await trailing(0.15);
    const shut = await trailing(0.55);
    // A 3.18 m tentacle streaming aft: every wrist is well over a metre behind its socket once drawn in (measured 2.85 m), and still behind it when flung open (2.03 m).
    expect(Math.min(...shut.behind)).toBeGreaterThan(1.5);
    expect(Math.min(...open.behind)).toBeGreaterThan(0);
    // The beat is the difference: cut `stroke` and the two poses are one. Open, the claws stand at least a metre further off the axis.
    // Measured: 1.45 m off the axis open, 0.59 m drawn in.
    expect(open.spread - shut.spread).toBeGreaterThan(0.5);
  }, 120_000);

  it("flies in a pack: each robot keeps its own place, takes a hall's room but not its floor, and trails its tail behind ITSELF", async () => {
    // The owner, 2026-10-06, of a pack whose tails were drawn back onto the tunnel's axis: "their tentacles
    // are in a weird pull towards center instead of their own reference". Three robots, one up and out to the
    // right and behind, one down and out to the left further behind; drawn in (Company 1, the bottom of the
    // stroke), on rails so nothing wanders.
    const BERTHS = [[1.5, 0.9, -5.5], [-1.5, -0.85, -11]] as const;
    /** Where each follower stands off the leader, across the tunnel: at their sockets, and at their claws. */
    const apart = async (travel: number, afield = 0): Promise<Array<{ sockets: [number, number]; claws: [number, number] }>> => {
      const pack = await walk(3, { swim: 1, stroke: 0.55, carry: 0, company: 1, travel, afield }, [[0, 0, 0], ...BERTHS]);
      const mean = (robot: number, station: number): [number, number] => {
        const sum: [number, number] = [0, 0];
        for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
          const joint = pack.at(robot, tentacle, station);
          if (joint === undefined) throw new Error("a swimming tentacle is stowed");
          const off = acrossTunnel(joint);
          sum[0] += off[0] / TENTACLES;
          sum[1] += off[1] / TENTACLES;
        }
        return sum;
      };
      const [leaderSockets, leaderClaws] = [mean(0, 0), mean(0, FACTS.ringCount)];
      return BERTHS.map((_, index) => {
        const [sockets, claws] = [mean(index + 1, 0), mean(index + 1, FACTS.ringCount)];
        return { sockets: [sockets[0] - leaderSockets[0], sockets[1] - leaderSockets[1]], claws: [claws[0] - leaderClaws[0], claws[1] - leaderClaws[1]] };
      });
    };
    // Plain bore: the place asked. In unison (Variety 0) the tails are the same shape, so what stands between
    // two of them at the claws is the berth again; drawn onto the axis it was a tenth of it (0.18 m, 0.11 m).
    const bore = await apart(0);
    for (const [index, berth] of BERTHS.entries()) {
      expect(chamberAt(berth[2])).toBe(0);
      for (const axis of [0, 1] as const) {
        expect(Math.abs((bore[index]?.sockets[axis] as number) - berth[axis])).toBeLessThan(0.06);
        expect(Math.abs((bore[index]?.claws[axis] as number) - berth[axis])).toBeLessThan(0.06);
      }
    }
    // In a hall the wall stands 1.9 bore radii off: the places across the tunnel grow by as much, and the one
    // above rises by as much, tails and all. The one below does not sink: a hall's deck is where the bore's is
    // (0.74 of 2.6 m under the axis), and at 1.9 times its depth it flew through the floor (the owner,
    // 2026-10-06: "so far on the floor that it actually clips through").
    const middle = CHAMBERS.spacing / 2;
    const hall = await apart(middle);
    for (const [index, berth] of BERTHS.entries()) {
      // Each stands where the hall is as wide as it is abreast of it: the last of them is still on its flare.
      const roomy = 1 + CHAMBERS.swell * chamberAt(middle + berth[2]);
      expect(roomy).toBeGreaterThan(1.1);
      const asked = [berth[0] * roomy, berth[1] * (berth[1] > 0 ? roomy : 1)];
      for (const axis of [0, 1] as const) {
        expect(Math.abs((hall[index]?.sockets[axis] as number) - (asked[axis] as number))).toBeLessThan(0.06);
        expect(Math.abs((hall[index]?.claws[axis] as number) - (asked[axis] as number))).toBeLessThan(0.06);
      }
    }
    // The leader is on the axis, so the lower one's middle is this far over the deck: a metre, not a hand.
    expect((hall[1]?.sockets[1] as number) + 2.6 * 0.74).toBeGreaterThan(0.9);
    // Out in the fields (field.ts) there is neither wall nor deck: the places grow by more than any hall's, the
    // one below as far down as the one above goes up, and the tails with them.
    const afield = await apart(0, 1);
    const open = 1 + CHAMBERS.swell * FIELD_BERTH;
    expect(open).toBeGreaterThan(2);
    for (const [index, berth] of BERTHS.entries()) {
      for (const axis of [0, 1] as const) {
        expect(Math.abs((afield[index]?.sockets[axis] as number) - berth[axis] * open)).toBeLessThan(0.06);
        expect(Math.abs((afield[index]?.claws[axis] as number) - berth[axis] * open)).toBeLessThan(0.06);
      }
    }
  }, 120_000);

  it("a pack does not swim as one: each robot strokes a part of a bar after the last, as hard as its own count has it, and the document's lunge is the body's", async () => {
    // The owner, 2026-10-06: "the pumping swimming motion of the robots … seems totally in sync between all of them".
    // Three in line astern in plain bore, on rails so only the stroke moves them along the tunnel.
    const line = [[0, 0, 0], [0, 0, -6], [0, 0, -12]] as const;
    const STROKE = 0.3;
    /** How far along the tunnel each body is from where the first stands, by its sockets. */
    const along = async (variety: number): Promise<number[]> => {
      const pack = await walk(3, { swim: 1, stroke: STROKE, carry: 0, variety }, line);
      return line.map((_, robot) => {
        let z = 0;
        for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) z += pack.socket(robot, tentacle)[2] / TENTACLES;
        return z;
      });
    };
    const [unison, apart] = [await along(0), await along(1)];
    // What the document's own expression says each has lunged (the camera and the followers' lights ride it): the kernel's first frame is at time 0.
    const lunge = (robot: number): number => {
      const value = evaluateExpression(swimLungeExpression("stroke", robot), { stroke: STROKE, abstime: 0 });
      if (!value.ok) throw new Error("the lunge does not evaluate");
      return value.value;
    };
    for (const robot of [0, 1, 2]) {
      // In unison every body has the leader's lunge; apart, its own. (The line of the tunnel is not straight: to 3 cm.)
      expect(Math.abs((apart[robot] as number) - (unison[robot] as number) - (lunge(robot) - lunge(0)))).toBeLessThan(0.03);
    }
    // And they really are apart: at this moment of the bar the second is a third of a metre behind where unison has it.
    expect(Math.abs(lunge(1) - lunge(0))).toBeGreaterThan(0.2);
    // The lunge itself is a third of a metre at the most, where it was half: less of a pump.
    expect(SWIM.lunge).toBeLessThan(0.4);
  }, 120_000);

  it("crosses a chamber swimming: told to walk, in the middle of a hall every claw has let go and trails", async () => {
    // A chamber's wall stands 1.9 bore radii off the axis, further than a tentacle reaches, so the
    // rig lets go by itself. The same robot, the same Swim of 0, a hall's middle against plain bore.
    const middle = CHAMBERS.spacing / 2;
    expect([chamberAt(middle), chamberAt(0)]).toEqual([1, 0]);
    const hall = await walk(1, { travel: middle, stroke: 0.3 });
    const bore = await walk(1, { travel: 0, stroke: 0.3 });
    let held = 0;
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      const socket = hall.at(0, tentacle, 0);
      const claw = hall.at(0, tentacle, FACTS.ringCount);
      if (socket === undefined || claw === undefined) throw new Error("a tentacle is stowed in the hall");
      expect(hall.slip(0, tentacle, FACTS.ringCount)).toBe(0);
      expect(socket[2] - claw[2]).toBeGreaterThan(1.5);
      // In the bore it walks: most wrists are within a step of the body, ahead of it or not far behind, not streaming
      // aft. (From the socket's own place: a walking tentacle's first rings are wound into the body.)
      const walking = bore.at(0, tentacle, FACTS.ringCount);
      const from = bore.socket(0, tentacle);
      if (walking !== undefined && from[2] - walking[2] < 1.5) held += 1;
    }
    expect(held).toBeGreaterThan(TENTACLES / 2);
  }, 120_000);

  it("is not on rails: walking it weaves slowly across the tunnel's axis, swimming it is adrift, and Carry is the difference", async () => {
    const INSTANTS = 64;
    /** The middle of the ten sockets at each instant: the body, give or take a constant. */
    const middles = async (parameters: Record<string, number>): Promise<Vec[]> => {
      const pose = await walk(INSTANTS, parameters);
      return Array.from({ length: INSTANTS }, (_, instant) => {
        const sum: Vec = [0, 0, 0];
        for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
          const socket = pose.socket(instant, tentacle);
          sum[0] += socket[0] / TENTACLES;
          sum[1] += socket[1] / TENTACLES;
          sum[2] += socket[2] / TENTACLES;
        }
        return sum;
      });
    };
    /** How far the body is from where it would be on rails, at each instant. */
    const off = async (parameters: Record<string, number>): Promise<number[]> => {
      const carried = await middles({ ...parameters, carry: 1 });
      const rails = await middles({ ...parameters, carry: 0 });
      return carried.map((middle, instant) => norm(minus(middle, rails[instant] as Vec)));
    };
    // Walking with six of the ten on the wall: off the rails by up to some fifteen centimetres, and SLOWLY. From one
    // instant to the next (a tenth of a metre of travel) it moves across the tunnel by under a centimetre: nothing
    // a step, a change of hold or the track could show in. (The owner, 2026-10-06: the sway "looks super jank …
    // very nervous movement back and forth". Two earlier versions read the gait; this one reads only the distance.)
    const walking = await off({ crawl: 0.6 });
    expect(Math.max(...walking)).toBeGreaterThan(0.04);
    expect(Math.max(...walking)).toBeLessThan(0.2);
    expect(Math.max(...walking.slice(1).map((value, index) => Math.abs(value - (walking[index] as number))))).toBeLessThan(0.01);
    // …and it is the same weave whatever the legs are doing: every tentacle holding, or none told to.
    const allHolding = await off({ crawl: 1 });
    expect(Math.max(...walking.map((value, index) => Math.abs(value - (allHolding[index] as number))))).toBeLessThan(1e-4);
    // Swimming: adrift by up to most of a metre across and along (the fan's robots are one robot at 64 places, each with its own count).
    const swimming = await off({ swim: 1, stroke: 0.3 });
    expect(Math.max(...swimming)).toBeGreaterThan(0.3);
    expect(Math.max(...swimming)).toBeLessThan(1.4);
  }, 180_000);

  it("pulses: a kick's pulse is brightest on the ring it has reached, on every tentacle, and gone at rest", async () => {
    // 0.2 s after a kick the crest is 9 m/s × 0.2 s = 1.8 m along: ring 30 at a 0.06 m pitch.
    const SINCE = 0.2;
    const reached = Math.round((9 * SINCE) / FACTS.ringPitch);
    const lit = await walk(1, { crawl: 0, pulse: SINCE });
    const rest = await walk(1, { crawl: 0, pulse: 100 });
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      const charges = Array.from({ length: FACTS.ringCount }, (_, ring) => lit.charge(0, tentacle, ring));
      expect(charges.indexOf(Math.max(...charges))).toBe(reached);
      // At the crest: e^(−1.2 × 0.2), the fade it has had so far. At the socket, 1.8 m behind it, nothing.
      expect(Math.abs((charges[reached] as number) - Math.exp(-1.2 * SINCE))).toBeLessThan(1e-3);
      expect(charges[0] as number).toBeLessThan(0.001);
      // Cut the pulse and every core carries exactly none: the material adds nothing to the ember.
      for (let ring = 0; ring < FACTS.ringCount; ring += 1) expect(rest.charge(0, tentacle, ring)).toBe(0);
    }
  }, 120_000);

  it("shows the track along the cores three more ways: a meter's head, bands that step out on the beat, sparks", async () => {
    // Every tentacle free and at full length, no pulse: ring r is 0.06 r metres from its socket.
    const quiet = { crawl: 0, pulse: 100 };
    const along = (pose: Walk, tentacle: number): number[] => Array.from({ length: FACTS.ringCount }, (_, ring) => pose.charge(0, tentacle, ring));

    // METER at a half: each tentacle's head stands between 0.375 and 0.625 of its length out (each reads a
    // little differently), nothing is lit beyond it, and back at the body there is only the trail: 0.05.
    const meter = await walk(1, { ...quiet, meter: 0.5 });
    const heads = new Set<number>();
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      const charges = along(meter, tentacle);
      const head = charges.indexOf(Math.max(...charges));
      heads.add(head);
      expect(head * FACTS.ringPitch).toBeGreaterThan(0.375 * FACTS.hubDistance - 0.3);
      expect(head * FACTS.ringPitch).toBeLessThan(0.625 * (FACTS.hubDistance + 0.5));
      expect(charges[head] as number).toBeGreaterThan(0.5);
      expect(Math.abs((charges[2] as number) - 0.05)).toBeLessThan(1e-6);
      expect(Math.max(...charges.slice(head + 5))).toBe(0);
    }
    expect(heads.size).toBeGreaterThan(3);

    // CHASE: bands a third of a tentacle apart; a whole number on the phase is the same picture, a half is not.
    const bands = along(await walk(1, { ...quiet, chase: 1, chasePhase: 0.25 }), 0);
    const stepped = along(await walk(1, { ...quiet, chase: 1, chasePhase: 1.25 }), 0);
    const halfway = along(await walk(1, { ...quiet, chase: 1, chasePhase: 0.75 }), 0);
    const crests = bands.filter((value, ring) => ring > 0 && ring < bands.length - 1 && value > 0.5 && value >= (bands[ring - 1] as number) && value > (bands[ring + 1] as number)).length;
    expect(crests).toBe(3);
    expect(Math.max(...bands.map((value, ring) => Math.abs(value - (stepped[ring] as number))))).toBeLessThan(1e-3);
    expect(Math.max(...bands.map((value, ring) => Math.abs(value - (halfway[ring] as number))))).toBeGreaterThan(0.9);

    // SPARK: single cores, wholly lit or not at all, about one in fourteen at any moment.
    const sparks = await walk(1, { ...quiet, spark: 1 });
    const all = Array.from({ length: TENTACLES }, (_, tentacle) => along(sparks, tentacle)).flat();
    expect(all.every((value) => value === 0 || value === 1)).toBe(true);
    const lit = all.filter((value) => value === 1).length / all.length;
    expect(lit).toBeGreaterThan(0.03);
    expect(lit).toBeLessThan(0.12);

    // Cut all three and the cores carry nothing.
    const none = await walk(1, quiet);
    expect(Math.max(...Array.from({ length: TENTACLES }, (_, tentacle) => along(none, tentacle)).flat())).toBe(0);
  }, 180_000);

  it("gestures: a tentacle with nothing to hold reaches out instead of trailing", async () => {
    /** How far behind its socket each wrist is (metres), with every tentacle free. */
    const behind = async (gesture: number): Promise<number[]> => {
      const pose = await walk(1, { crawl: 0, gesture });
      return Array.from({ length: TENTACLES }, (_, tentacle) => {
        const socket = pose.at(0, tentacle, 0);
        const claw = pose.at(0, tentacle, FACTS.ringCount);
        if (socket === undefined || claw === undefined) throw new Error("a free tentacle is stowed");
        return socket[2] - claw[2];
      });
    };
    const trailing = await behind(0);
    const reaching = await behind(1);
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      // Trailing, the wrist streams well aft; gesturing, the neck turns the other way and the same wrist comes at least a metre forward of where it trailed.
      expect(trailing[tentacle] as number).toBeGreaterThan(1.5);
      expect((trailing[tentacle] as number) - (reaching[tentacle] as number)).toBeGreaterThan(1);
    }
  }, 120_000);

  it("looks: turning the head carries every socket round the body's own up, by exactly the angle asked", async () => {
    const ANGLE = 0.5;
    const ahead = await walk(1, { crawl: 0 });
    const turned = await walk(1, { crawl: 0, look: [ANGLE, 0] });
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      const from = ahead.at(0, tentacle, 0);
      const to = turned.at(0, tentacle, 0);
      const socket = FACTS.sockets[tentacle];
      if (from === undefined || to === undefined || socket === undefined) throw new Error("a socket is missing");
      // A point at (x, y, z) in the robot's frame turned about its up axis moves along a chord of the circle of radius √(x² + z²).
      const chord = 2 * Math.hypot(socket[0], socket[2]) * Math.sin(ANGLE / 2);
      expect(Math.abs(norm(minus(to, from)) - chord)).toBeLessThan(RESOLUTION);
    }
  }, 120_000);

  it("moves without a pop: halve the step and the largest move halves with it", async () => {
    // A continuous motion's largest move shrinks with the step it is sampled at; a pop does
    // not, it is the same jump however finely you look. So the ratio is 2 for a smooth rig
    // and 1 for one that jumps. (The bracketed two-arc solver this rig replaced read 1.0.)
    const coarse = largestMove(await walk(240));
    const fine = largestMove(await walk(480));
    // Measured, the largest move of any ring over 2.7 cm of travel: 15.8 cm. (It was 30 cm while the slack's bow
    // could change sides, 25.5 cm before the tentacles stepped in a wave, and 18.8 cm while every claw was in the
    // air for 38 per cent of its step and eased by a smoothstep; now each is up for 46 to 60 per cent and leaves
    // and lands with no acceleration.)
    expect(coarse).toBeLessThan(0.18);
    expect(coarse / fine).toBeGreaterThan(1.7);
    expect(coarse / fine).toBeLessThan(2.3);
    // The same with six of the ten on the wall, the piece's own setting: across these two strides tentacles
    // let go and take hold in turn, a held arc blending into a trail and back. (The owner, 2026-10-05: "the
    // legs can't move jerkily … shouldn't glitch around and teleport".)
    const handingOver = largestMove(await walk(240, { crawl: 0.6 }));
    const handingOverFine = largestMove(await walk(480, { crawl: 0.6 }));
    // Measured: 27 cm against 13.6 cm, a ratio of 1.99.
    expect(handingOver / handingOverFine).toBeGreaterThan(1.7);
    expect(handingOver / handingOverFine).toBeLessThan(2.3);
    // And walking a corkscrew, and attacking (the strikers' throw is on the clock, so along a walk only the holders and the body move).
    for (const move of [{ spiral: 0.5 }, { attack: 1 }]) {
      const ratio = largestMove(await walk(240, move)) / largestMove(await walk(480, move));
      expect(ratio).toBeGreaterThan(1.7);
      expect(ratio).toBeLessThan(2.3);
    }
  }, 360_000);

  it("walks a corkscrew: the body turns about the tunnel's axis as it goes, by the turns asked, and the claws it has planted stay on their rungs", async () => {
    // Half a turn in 16 m: over the walk's 6.4 m the body turns 0.2 of a turn, 72 degrees.
    const INSTANTS = 32;
    const spiral = await walk(INSTANTS, { spiral: 0.5 });
    const straight = await walk(INSTANTS, {});
    /** Which way the first socket stands off the middle of the ten, as an angle about the tunnel (which runs along z near enough over 6.4 m). */
    const bearing = (pose: Walk, instant: number): number => {
      const sockets = Array.from({ length: TENTACLES }, (_, tentacle) => pose.socket(instant, tentacle));
      const middle = sockets.reduce<Vec>((sum, socket) => [sum[0] + socket[0] / TENTACLES, sum[1] + socket[1] / TENTACLES, sum[2] + socket[2] / TENTACLES], [0, 0, 0]);
      const first = sockets[0] as Vec;
      return Math.atan2(first[1] - middle[1], first[0] - middle[0]);
    };
    const unwrap = (angle: number): number => angle - 2 * Math.PI * Math.round(angle / (2 * Math.PI));
    const last = INSTANTS - 1;
    const turned = unwrap(bearing(spiral, last) - bearing(spiral, 0)) - unwrap(bearing(straight, last) - bearing(straight, 0));
    // 0.5 turns per 16 m over the 31 steps between the first and the last instant.
    const asked = 2 * Math.PI * 0.5 * ((SPAN * last) / INSTANTS) / 16;
    // Measured: 1.2209 rad turned against 1.2174 asked.
    expect(Math.abs(unwrap(turned - asked))).toBeLessThan(0.08);
    let worst = 0;
    for (let instant = 0; instant < INSTANTS; instant += 1) for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) worst = Math.max(worst, spiral.slip(instant, tentacle, FACTS.ringCount));
    // Measured: 2.4 micrometres at worst. The rungs go round with the walk, so a held one does not move.
    expect(worst).toBeLessThan(0.02);
  }, 180_000);

  it("attacks: every other tentacle strikes out ahead of the face while the ones between hold the wall", async () => {
    const pose = await walk(1, { attack: 1 });
    const rest = await walk(1, {});
    const offAxis = (point: Vec): number => Math.hypot(point[0] - pathAt(point[2])[0], point[1] - pathAt(point[2])[1]);
    let ahead = 0;
    let held = 0;
    let furthest = -Infinity;
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      const socket = pose.socket(0, tentacle);
      const wrist = pose.at(0, tentacle, FACTS.ringCount);
      if (wrist === undefined) throw new Error("a wrist is stowed");
      // A striker's wrist is well ahead of its socket and near the axis (measured: 1.9 to 3.0 m ahead, 0.2 to 1.1 m
      // off it). A holder's claw is where the gait has it: on its rung, or in the air between two, lifted off the
      // wall (they step in a wave, so at any instant two or three are; one in mid-step was measured 0.9 m ahead
      // and 1.7 m off the axis, which is not a blow).
      const striking = wrist[2] - socket[2] > 1.5 && offAxis(wrist) < 1.3;
      if (striking) ahead += 1;
      else if (pose.slip(0, tentacle, FACTS.ringCount) < 0.02) held += 1;
      furthest = Math.max(furthest, wrist[2] - socket[2]);
    }
    // Measured: the furthest wrist 3.0 m ahead of its socket.
    expect(furthest).toBeGreaterThan(2);
    expect(ahead).toBe(TENTACLES / 2);
    expect(held).toBe(TENTACLES / 2);
    // Without the attack none of them is out ahead inside the bore, and most stand on the wall.
    let striking = 0;
    let onWall = 0;
    for (let tentacle = 0; tentacle < TENTACLES; tentacle += 1) {
      const socket = rest.socket(0, tentacle);
      const wrist = rest.at(0, tentacle, FACTS.ringCount);
      if (wrist === undefined) continue;
      if (wrist[2] - socket[2] > 1.5 && offAxis(wrist) < 1.3) striking += 1;
      if (offAxis(wrist) > 2.2) onWall += 1;
    }
    expect(striking).toBe(0);
    expect(onWall).toBeGreaterThanOrEqual(6);
  }, 120_000);
});
