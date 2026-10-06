import { describe, expect, it } from "vitest";
import { DOCK_LIGHT_ATTRIBUTES, DOCK_STRIP_ATTRIBUTES } from "./dock.ts";
import { kernelPoints } from "./kernel-points.ts";
import { SEARCH, SEARCH_CAPACITY, SEARCH_KERNEL, SEARCH_LIGHT_KERNEL, searchParameters } from "./searchlight.ts";

/**
 * T1561b — THE ROBOTS' SEARCHLIGHTS, read off the points their kernels write, on a real GPU.
 *
 * The owner asked for "white lights on the front, like searchlights". What a beam owes: it starts at the face it
 * is handed and goes toward the point it is handed, a cone; its Spot stands at the same face and shines the same
 * way (two kernels, one beam); each robot's is its own; and a robot that is not searching has none.
 */

/** Three robots: where each one's face is, what it looks toward, and how bright its beam is. */
const ENDS = [
  { face: [1, 2, 3], toward: [1, 2, 33], level: 1 },
  { face: [-4, 0.5, -6], toward: [6, 3.5, 20], level: 0.5 },
  { face: [5, -1, -12], toward: [5, -11, -2], level: 0 },
] as const;
const PARAMETERS: Record<string, number | number[]> = Object.fromEntries(ENDS.flatMap((ends, robot) => [[searchParameters(robot).face, [...ends.face]], [searchParameters(robot).toward, [...ends.toward]], [searchParameters(robot).level, ends.level]]));

describe("the robots' searchlights (T1561b)", () => {
  it("a beam goes from the face it is handed toward the point it is handed, opening as it goes; its Spot is the same beam; and no level, no beam", async () => {
    expect(ENDS.length).toBe(SEARCH.robots);
    const cones = await kernelPoints(SEARCH_KERNEL, DOCK_STRIP_ATTRIBUTES, SEARCH_CAPACITY, PARAMETERS, ["girth", "tint"]);
    const spots = await kernelPoints(SEARCH_LIGHT_KERNEL, DOCK_LIGHT_ATTRIBUTES, SEARCH.robots, { ...PARAMETERS, power: 110 }, ["power", "aim", "tint"]);
    for (const [robot, ends] of ENDS.entries()) {
      const first = robot * SEARCH.points;
      const last = first + SEARCH.points - 1;
      const span = ends.toward.map((part, axis) => part - (ends.face[axis] as number));
      const reach = Math.hypot(...span);
      const way = span.map((part) => part / reach);
      // The Spot: at the face, shining the way from the face to the point, as strong as the robot's level says.
      expect(spots.position(robot).map((part, axis) => Math.abs(part - (ends.face[axis] as number)) < 1e-4)).toEqual([true, true, true]);
      expect(spots.of("aim", robot).slice(0, 3).map((part, axis) => Math.abs(part - (way[axis] as number)) < 1e-4)).toEqual([true, true, true]);
      expect(spots.of("power", robot)[0]).toBeCloseTo(110 * ends.level, 4);
      if (ends.level === 0) {
        // Not searching: nothing to draw.
        for (let point = first; point <= last; point += 1) expect(cones.of("girth", point)).toEqual([0]);
        continue;
      }
      // The cone: from the face, SEARCH.length metres the same way, a lens wide at the face and metres across at its end.
      expect(cones.position(first).map((part, axis) => Math.abs(part - (ends.face[axis] as number)) < 1e-4)).toEqual([true, true, true]);
      expect(cones.position(last).map((part, axis) => Math.abs(part - ((ends.face[axis] as number) + (way[axis] as number) * SEARCH.length)) < 1e-3)).toEqual([true, true, true]);
      expect(cones.of("girth", first)[0] as number).toBeLessThan(0.2);
      expect(cones.of("girth", last)[0] as number).toBeGreaterThan(1);
      // How bright it is drawn is the robot's own level.
      expect(cones.of("tint", first)[0]).toBeCloseTo(ends.level, 5);
    }
    // White, a little cold.
    const tint = spots.of("tint", 0);
    expect((tint[2] as number) >= (tint[0] as number) && (tint[0] as number) > 0.7).toBe(true);
  }, 240_000);
});
