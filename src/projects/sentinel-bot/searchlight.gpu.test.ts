import { describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { sentinelDocument } from "./document.ts";
import { kernelPoints, type KernelSource, type Vec } from "./kernel-points.ts";
import { KIT_FIXTURE } from "./kit.fixture.ts";
import { JOINT_ATTRIBUTES, jointKernel } from "./rig.ts";
import { SEARCH, SEARCH_KERNEL, SEARCH_LIGHT_ATTRIBUTES, SEARCH_LIGHT_KERNEL, SEARCH_STRIP_ATTRIBUTES, searchLevel } from "./searchlight.ts";

/**
 * T1561b — THE ROBOTS' SEARCHLIGHTS, on a real GPU: read off the points their kernels write, and off a lit wall.
 *
 * The owner asked for "white lights on the front, like searchlights", and of the first build: "the front spot light
 * … is detached from the body … the body sway and what not is not translated to the spot light and thus it
 * suddenly floats", "it should look around with the face of the robot rather than look around detached". That
 * build handed a beam its two ends as expressions, a second saying of where a robot is. What a beam owes now: its
 * Spot stands at the face of the body AS THE RIG HAS PUT IT and shines the way that body faces, whatever the rig
 * is doing to it; its cone of lit air is on that same line (two kernels, one beam); turning the head turns it; and
 * a robot that is not searching, or not out, has none.
 */

const add = (a: Vec, b: Vec, scale = 1): Vec => [a[0] + b[0] * scale, a[1] + b[1] * scale, a[2] + b[2] * scale];
const cross = (a: Vec, b: Vec): Vec => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec, b: Vec): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const apart = (a: Vec, b: Vec): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** A vector of a body's own frame in the world: turned by its quaternion (x y z w). */
const turned = (by: readonly number[], v: Vec): Vec => {
  const axis: Vec = [by[0] as number, by[1] as number, by[2] as number];
  return add(v, cross(axis, add(cross(axis, v), v, by[3] as number)), 2);
};
const FORWARD: Vec = [0, 0, 1];

/** A pack of three in its places, the middle one half bright, the last not searching. */
const ROBOTS: readonly Vec[] = [[0, 0, 0], [1.6, 0.5, -5.5], [-1.4, -0.6, -11]];
const LEVELS = [1, 0.5, 0] as const;
const LEVEL_PARAMETERS: Record<string, number> = Object.fromEntries(LEVELS.map((level, robot) => [searchLevel(robot), level]));
/** How far ahead of a body's middle its face is, here. */
const FACE = 0.7;
const POWER = 110;
/**
 * A rig with everything on it that moves a body off the tunnel's line: adrift and swimming, its head turned (as far
 * as a perched robot scans: further than its drifting nose can turn it back), rolled, rearing.
 */
const RIG = { travel: 37, swim: 1, carry: 1, look: [0.6, -0.2], roll: 0.2, attack: 0.6, stroke: 0.3, variety: 1 };
/** The same rig on its rails, looking straight on. */
const REST = { travel: 37, swim: 0, carry: 0, look: [0, 0], roll: 0, attack: 0, stroke: 0.3, variety: 1 };
/** Several instants: the rig is on the clock (its drift, its strokes), and a beam that is the body's is the body's at every one. */
const INSTANTS = [1, 40, 173] as const;

/** The hull's points, one a robot: what the Spots read. */
const hull = (rig: Record<string, number | number[]>, robots: readonly Vec[] = ROBOTS): KernelSource => ({ kernel: jointKernel(KIT_FIXTURE, robots, "body"), attributes: JOINT_ATTRIBUTES, parameters: rig, names: ["orient", "kind"] });
/** The rig's points along each nose: what the cones read. */
const noses = (rig: Record<string, number | number[]>): KernelSource => ({ kernel: jointKernel(KIT_FIXTURE, ROBOTS, { axis: [FACE, FACE + SEARCH.length], count: SEARCH.points }), attributes: JOINT_ATTRIBUTES, parameters: rig, names: ["kind", "along"] });
const spotsOver = (rig: Record<string, number | number[]>, frames = 1) => kernelPoints(SEARCH_LIGHT_KERNEL, SEARCH_LIGHT_ATTRIBUTES, ROBOTS.length, { ...LEVEL_PARAMETERS, face: FACE, power: POWER }, ["power", "aim", "tint"], hull(rig), frames);
const conesOver = (rig: Record<string, number | number[]>, frames = 1) => kernelPoints(SEARCH_KERNEL, SEARCH_STRIP_ATTRIBUTES, ROBOTS.length * SEARCH.points, LEVEL_PARAMETERS, ["girth", "tint"], noses(rig), frames);

describe("the robots' searchlights (T1561b)", () => {
  it("a Spot stands at the face of the body as the rig has put it and shines the way it faces, at every instant", async () => {
    for (const frames of INSTANTS) {
      const [spots, rest] = [await spotsOver(RIG, frames), await spotsOver(REST, frames)];
      for (const [robot, level] of LEVELS.entries()) {
        const body = spots.source!.position(robot);
        const forward = turned(spots.source!.of("orient", robot), FORWARD);
        expect(apart(spots.position(robot), add(body, forward, FACE))).toBeLessThan(1e-4);
        expect(apart(spots.of("aim", robot).slice(0, 3) as Vec, forward)).toBeLessThan(1e-5);
        expect(spots.of("power", robot)[0]).toBeCloseTo(POWER * level, 4);
        // …and that says something: this rig has the body well off where it rides at rest, and turned from it (a
        // fifth of a radian is six metres at the far end of a beam). A beam told its ends by anything that did
        // not know of the head's turn or the drift would be this far out.
        const atRest = turned(rest.source!.of("orient", robot), FORWARD);
        expect(Math.acos(dot(forward, atRest))).toBeGreaterThan(0.2);
        expect(apart(spots.position(robot), rest.position(robot))).toBeGreaterThan(0.2);
      }
      // White, a little cold.
      const tint = spots.of("tint", 0);
      expect((tint[2] as number) >= (tint[0] as number) && (tint[0] as number) > 0.7).toBe(true);
    }
  }, 480_000);

  it("turning the head turns the beam, by as much", async () => {
    const [ahead, turnedRight] = [await spotsOver(REST), await spotsOver({ ...REST, look: [0.3, 0] })];
    for (const robot of ROBOTS.keys()) {
      const [was, is] = [ahead.of("aim", robot).slice(0, 3) as Vec, turnedRight.of("aim", robot).slice(0, 3) as Vec];
      expect(Math.acos(dot(was, is))).toBeCloseTo(0.3, 4);
      // The body has not moved; the Spot has gone round with the face, a face's distance from the body's middle.
      expect(apart(ahead.source!.position(robot), turnedRight.source!.position(robot))).toBeLessThan(1e-5);
      expect(apart(ahead.position(robot), turnedRight.position(robot))).toBeCloseTo(2 * FACE * Math.sin(0.15), 4);
    }
  }, 240_000);

  it("the cone of lit air is on the Spot's own line, opening as it goes; and no level, no beam", async () => {
    for (const frames of INSTANTS) {
      const [cones, spots] = [await conesOver(RIG, frames), await spotsOver(RIG, frames)];
      for (const [robot, level] of LEVELS.entries()) {
        const first = robot * SEARCH.points;
        const last = first + SEARCH.points - 1;
        if (level === 0) {
          // Not searching: nothing to draw.
          for (let point = first; point <= last; point += 1) expect(cones.of("girth", point)).toEqual([0]);
          continue;
        }
        // From the Spot's foot, SEARCH.length metres the way the Spot shines: two kernels over two of the rig's picks, one beam.
        const [foot, way] = [spots.position(robot), spots.of("aim", robot).slice(0, 3) as Vec];
        for (let point = first; point <= last; point += 1) expect(apart(cones.position(point), add(foot, way, ((point - first) / (SEARCH.points - 1)) * SEARCH.length))).toBeLessThan(1e-3);
        // A lens wide at the face and metres across at its end.
        expect(cones.of("girth", first)[0] as number).toBeLessThan(0.2);
        expect(cones.of("girth", last)[0] as number).toBeGreaterThan(1);
        // How bright it is drawn is the robot's own level.
        expect(cones.of("tint", first)[0]).toBeCloseTo(level, 5);
      }
    }
  }, 480_000);

  it("a robot of the pack that is not out has no beam, whatever its level", async () => {
    // Only the leader is out (the rig's Pack at 1): the second's level is still a half.
    const alone = { ...RIG, pack: 1 };
    const [spots, cones] = [await spotsOver(alone), await conesOver(alone)];
    expect(spots.of("power", 0)[0]).toBeCloseTo(POWER, 4);
    expect(spots.of("power", 1)).toEqual([0]);
    for (let point = SEARCH.points; point < 2 * SEARCH.points; point += 1) expect(cones.of("girth", point)).toEqual([0]);
    expect(cones.of("girth", SEARCH.points - 1)[0] as number).toBeGreaterThan(1);
  }, 240_000);

  /**
   * THROUGH THE REAL STACK, with the piece's own Light (its node, as the document builds it): a wall twelve metres
   * ahead of one robot, square to the way it rides, seen from behind it. The lit patch is where the FACE looks.
   */
  it("the lit patch on a wall goes where the head turns, and only while the Spots read the hull's points", async () => {
    const dawnError = (await probeDawn()).error;
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const ONE: readonly Vec[] = [[0, 0, 0]];
    const SIZE = 65;
    const AHEAD = 12;
    const BEHIND = 6;
    const TURN = 0.3;
    // Where the body is and how it sits, at rest: the wall and the camera are placed by that.
    const rest = await kernelPoints(jointKernel(KIT_FIXTURE, ONE, "body"), JOINT_ATTRIBUTES, 1, REST, ["orient"]);
    const [body, orient] = [rest.position(0), rest.of("orient", 0)];
    const [right, up, forward] = [turned(orient, [1, 0, 0]), turned(orient, [0, 1, 0]), turned(orient, FORWARD)];
    const wall = add(body, forward, AHEAD);
    const light = sentinelDocument(KIT_FIXTURE).graph.nodes["light_search" as never] as unknown as { parameters: Record<string, unknown> };
    /** Where the light is in the frame (the mean column of it, 0 at the left), and how much there is. `half`: only the wall's half on the body's +x is there, lit by the room. */
    const seen = async (look: number, options: { wired?: boolean; half?: boolean } = {}): Promise<{ column: number; light: number }> => {
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: graph(
          [
            node("kernel_hull", "pointKernel", [0, 0], { capacity: 1, attributes: JOINT_ATTRIBUTES, kernel: jointKernel(KIT_FIXTURE, ONE, "body"), ...REST, look: [look, 0] }),
            node("kernel_searchlights", "pointKernel", [0, 0], { capacity: 1, attributes: SEARCH_LIGHT_ATTRIBUTES, kernel: SEARCH_LIGHT_KERNEL, [searchLevel(0)]: 1, face: FACE, power: 4000 }),
            node("light_search", "light", [0, 0], light.parameters as never, { label: "light_search" }),
            node("grid_wall", "pointGrid", [0, 0], { cols: 24, rows: 24, count: 576, sizeX: 2, sizeY: 2 }),
            node("kernel_wall", "pointKernel", [0, 0], {
              capacity: 576,
              attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
              kernel: `struct Params {
  middle: vec3f, // @default [0, 0, 0]
  right: vec3f, // @default [1, 0, 0]
  up: vec3f, // @default [0, 1, 0]
  half: f32, // @default 0
};
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let across = mix(p.position.x, abs(p.position.x), ctx.params.half);
  q.position = ctx.params.middle + ctx.params.right * across * 14.0 + ctx.params.up * p.position.y * 14.0;
  return q;
}`,
              middle: wall,
              right,
              up,
              half: options.half === true ? 1 : 0,
            }),
            node("material_wall", "materialPbr", [0, 0], { color: [1, 1, 1, 1], roughness: 1, metallic: 0 }, { label: "material_wall" }),
            node("geometry_wall", "geometry", [0, 0], { mode: "surface", material: "material_wall" }, { label: "geometry_wall" }),
            node("camera_behind", "camera", [0, 0], { eye: add(body, forward, -BEHIND), lookAt: wall, fov: 60, near: 0.1, far: 200 }, { label: "camera_behind" }),
            node("render_shot", "render", [0, 0], { scenes: "geometry_wall", camera: "camera_behind", lights: options.half === true ? "" : "light_search", ambientColor: [1, 1, 1, 1], ambientIntensity: options.half === true ? 1 : 0, background: [0, 0, 0, 1] }, { label: "render_shot" }),
            node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
          ],
          [
            ...(options.wired === false ? [] : [edge("search-body", ["kernel_hull", "out"], ["kernel_searchlights", "in"])]),
            edge("search-light", ["kernel_searchlights", "out"], ["light_search", "points"]),
            edge("grid-wall", ["grid_wall", "out"], ["kernel_wall", "in"]),
            edge("wall-geo", ["kernel_wall", "out"], ["geometry_wall", "points"]),
            edge("shot-out", ["render_shot", "out"], ["output_frame", "input"]),
          ],
        ),
        settings: settings({ outputResolution: { width: SIZE, height: SIZE }, workingFormat: "rgba8unorm" }),
        frames: 1,
        outputNodeId: "render_shot",
        outputPortId: "out",
      });
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
      const frame = result.frames[0];
      if (frame === undefined) throw new Error("no frame");
      let [sum, weighted] = [0, 0];
      for (let pixel = 0; pixel < SIZE * SIZE; pixel += 1) {
        const value = frame.bytes[pixel * 4 + 1] ?? 0;
        sum += value;
        weighted += value * (pixel % SIZE);
      }
      return { column: sum === 0 ? Number.NaN : weighted / sum, light: sum };
    };
    const middle = (SIZE - 1) / 2;
    // Which side of the frame the body's +x is on, from behind it: the half of the wall that is there, lit by the room.
    const side = Math.sign((await seen(0, { half: true })).column - middle);
    expect(Math.abs(side)).toBe(1);
    // Looking straight on, the patch is in the middle of the frame.
    const straight = await seen(0);
    expect(straight.light).toBeGreaterThan(1000);
    expect(Math.abs(straight.column - middle)).toBeLessThan(0.75);
    // The head turned toward the body's +x (the rig's Look x), the patch is on that side; turned the other way, on
    // the other; by what the turn is at that distance: tan(turn) × the wall's distance from the face, in pixels of
    // a frame whose half height is the camera's distance × tan(30°).
    const [toward, away] = [await seen(TURN), await seen(-TURN)];
    const pixels = ((AHEAD - FACE) * Math.tan(TURN)) / ((AHEAD + BEHIND) * Math.tan(Math.PI / 6)) * (SIZE / 2);
    expect((toward.column - middle) * side).toBeGreaterThan(pixels - 1.5);
    expect((toward.column - middle) * side).toBeLessThan(pixels + 1.5);
    expect((away.column - middle) * side).toBeGreaterThan(-pixels - 1.5);
    expect((away.column - middle) * side).toBeLessThan(-pixels + 1.5);
    // Cut the wire from the hull's points and nothing of the body reaches the Spot: it does not go with the head.
    const [cut, cutTurned] = [await seen(0, { wired: false }), await seen(TURN, { wired: false })];
    expect(cutTurned).toEqual(cut);
  }, 480_000);
});

describe("the searchlights are told nothing of where a robot is (T1561b)", () => {
  it("in the document their kernels read the rig's points, and the only thing driven on them is how bright each is", () => {
    const built = sentinelDocument(KIT_FIXTURE).graph;
    const wires = Object.values(built.edges).map((wire) => `${wire.source.nodeId}.${wire.source.portId} > ${wire.target.nodeId}.${wire.target.portId}`);
    // The Spots over the hull's own points; the cones over the rig's points along the nose.
    expect(wires).toContain("kernel_hull.out > kernel_searchlights.in");
    expect(wires).toContain("kernel_searchline.out > kernel_search.in");
    const levels = Array.from({ length: SEARCH.robots }, (_, robot) => searchLevel(robot));
    for (const id of ["kernel_search", "kernel_searchlights"]) {
      const parameters = (built.nodes[id as never] as unknown as { parameters: Record<string, unknown> }).parameters;
      // Anything on them that is not a plain value is an expression or a binding: a second saying of something.
      const driven = Object.entries(parameters).filter(([, value]) => typeof value === "object" && value !== null && !Array.isArray(value)).map(([name]) => name);
      expect(driven.filter((name) => !levels.includes(name))).toEqual([]);
    }
  });
});
