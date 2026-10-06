import { beforeAll, describe, expect, it } from "vitest";
import { mappedTo } from "../../nodes/definitions/curve-test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { kernelPoints, type KernelPoints } from "./kernel-points.ts";
import { PATH, pathAt } from "./path.ts";
import { CAVE_ATTRIBUTES, CAVE_CAPACITY, CAVE_KERNEL, FIRE_ATTRIBUTES, FIRE_KERNEL, FLAME_CAPACITY, FLAME_KERNEL, FORMATION, FORMATIONS, FORMATION_CAPACITY, FORMATION_KERNEL, ROCK_SURFACE_WGSL, TEMPLE, TEMPLE_STRIP_ATTRIBUTES } from "./temple.ts";

/**
 * T1561b — THE TEMPLE, read off the points its kernels write, on a real GPU.
 *
 * What the place owes whoever flies through it and whoever looks: the cave stands clear of what flies down its
 * middle, holds still while its window rides along and is the same cave the next time round the lap; what has
 * grown in it hangs from the roof or stands on the floor and none of it in the avenue; every fire sits on a
 * stalagmite's tip, its flame and its light in one place, and flares on the kick; and out of the temple there is
 * nothing of any of it to draw.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const TRAVEL = 300;
const GRID = { cols: TEMPLE.cols, rows: TEMPLE.rows };
const at = (i: number, j: number): number => j * TEMPLE.cols + i;
const rowZ = (j: number, travel: number): number => (Math.floor(travel / TEMPLE.row) + j - TEMPLE.behind) * TEMPLE.row;

describe("the temple (T1561b)", () => {
  it("stands its cave round the line clear of what flies, a floor under it and a roof over it, still while its window rides and the same cave next time round", async () => {
    const cave = await kernelPoints(CAVE_KERNEL, CAVE_ATTRIBUTES, CAVE_CAPACITY, { travel: TRAVEL, place: 1 }, ["tint"], GRID);
    let [nearest, lowestRoof, highestFloor, floors] = [Infinity, Infinity, -Infinity, 0];
    const radii = new Set<number>();
    for (let j = 0; j < TEMPLE.rows; j += 5) {
      const z = rowZ(j, TRAVEL);
      const line = pathAt(z);
      for (let i = 0; i < TEMPLE.cols; i += 1) {
        const [floored, high, , along] = cave.of("tint", at(i, j)) as [number, number, number, number];
        const point = cave.position(at(i, j));
        // It says where it is.
        expect(Math.abs(along - z)).toBeLessThan(1e-3);
        expect(Math.abs(point[1] - line[1] - high)).toBeLessThan(2e-3);
        const off = Math.abs(point[0] - line[0]);
        // What flies is within 4 m of the line and the lens within 10, at heights from 3 m under it to 7 over.
        if (high > -4 && high < 8) nearest = Math.min(nearest, off);
        // Over the avenue: the roof's height; under it: the floor's.
        if (off < TEMPLE.avenue && high > 0) lowestRoof = Math.min(lowestRoof, high);
        if (off < TEMPLE.avenue && high < 0) highestFloor = Math.max(highestFloor, high);
        if (floored > 0.1) {
          floors += 1;
          // The floor is called the floor only well under the line.
          expect(high).toBeLessThan(-4);
        }
        radii.add(Math.round(Math.hypot(point[0] - line[0], point[1] - line[1] - TEMPLE.lift)));
      }
    }
    // Nothing of the rock within fifteen metres of the line at the heights anything flies at; twenty of roof over
    // the avenue and seven of air under the line.
    expect(nearest).toBeGreaterThan(15);
    expect(lowestRoof).toBeGreaterThan(20);
    expect(highestFloor).toBeLessThan(-7);
    expect(floors).toBeGreaterThan(200);
    // A cave, not a pipe: its radius is many different radii.
    expect(radii.size).toBeGreaterThan(12);
    // The window rides, the cave does not.
    const slid = await kernelPoints(CAVE_KERNEL, CAVE_ATTRIBUTES, CAVE_CAPACITY, { travel: TRAVEL + TEMPLE.row * 5, place: 1 }, ["tint"], GRID);
    for (const [i, j] of [[0, 40], [37, 90], [101, 200], [150, 12]] as const) expect(slid.position(at(i, j))).toEqual(cave.position(at(i, j + 5)));
    // The lap's end is no seam: a lap on, the same rock (the line and the noise both come round), to a float's rounding at a kilometre.
    const lapped = await kernelPoints(CAVE_KERNEL, CAVE_ATTRIBUTES, CAVE_CAPACITY, { travel: TRAVEL + PATH.period, place: 1 }, ["tint"], GRID);
    for (const [i, j] of [[3, 40], [37, 90], [101, 200], [150, 12], [80, 250]] as const) {
      const [here, there] = [cave.position(at(i, j)), lapped.position(at(i, j))];
      expect([Math.abs(there[0] - here[0]) < 5e-3, Math.abs(there[1] - here[1]) < 5e-3, Math.abs(there[2] - here[2] - PATH.period) < 5e-3]).toEqual([true, true, true]);
    }
    // Out of the temple: one point, far under everything.
    const away = await kernelPoints(CAVE_KERNEL, CAVE_ATTRIBUTES, CAVE_CAPACITY, { travel: TRAVEL, place: 0 }, ["tint"], GRID);
    for (let point = 0; point < CAVE_CAPACITY; point += 997) expect(away.position(point)).toEqual([0, -4000, 0]);
  }, 240_000);

  it("grows its formations from the roof down and the floor up, each thinning to its point, columns with a waist, and none in the avenue", async () => {
    const grown = await kernelPoints(FORMATION_KERNEL, TEMPLE_STRIP_ATTRIBUTES, FORMATION_CAPACITY, { travel: TRAVEL, place: 1 }, ["girth", "tint"]);
    const kinds = [0, 0, 0, 0];
    let nearest = Infinity;
    for (let slot = 0; slot < FORMATIONS; slot += 1) {
      const first = slot * TEMPLE.points;
      const last = first + TEMPLE.points - 1;
      const kind = Math.round(grown.of("tint", first)[0] as number);
      kinds[kind] = (kinds[kind] as number) + 1;
      const girth = (point: number): number => grown.of("girth", point)[0] as number;
      if (kind === FORMATION.none) {
        for (let point = first; point <= last; point += 1) expect(girth(point)).toBe(0);
        continue;
      }
      const [foot, tip] = [grown.position(first), grown.position(last)];
      const line = pathAt(foot[2]);
      // Straight up and down, give or take its wander, which is none at its ends.
      expect(Math.hypot(tip[0] - foot[0], tip[2] - foot[2])).toBeLessThan(1e-3);
      if (kind === FORMATION.stalactite) {
        // It hangs: its foot is in the roof, well over the line, and its point is below that and still clear of the floor.
        expect(foot[1] - line[1]).toBeGreaterThan(12);
        expect(tip[1]).toBeLessThan(foot[1] - 3);
        expect(tip[1] - line[1]).toBeGreaterThan(-9);
        expect(girth(last)).toBeLessThan(1e-6);
        expect(girth(first)).toBeGreaterThan(0.6);
      } else if (kind === FORMATION.stalagmite) {
        // It stands: its foot is in the floor, under the line (by the walls the floor has come up, and it stands
        // on that), and its point is over that.
        expect(foot[1] - line[1]).toBeLessThan(-3);
        expect(tip[1]).toBeGreaterThan(foot[1] + 2);
        expect(girth(last)).toBeLessThan(1e-6);
        expect(girth(first)).toBeGreaterThan(0.8);
      } else {
        // A column: floor to roof, thick at both ends and thinner between.
        expect(foot[1] - line[1]).toBeLessThan(-3);
        expect(tip[1] - line[1]).toBeGreaterThan(12);
        const waist = girth(first + Math.floor(TEMPLE.points / 2));
        expect(waist).toBeLessThan(girth(first) * 0.6);
        expect(waist).toBeLessThan(girth(last) * 0.6);
        expect(waist).toBeGreaterThan(0.25);
      }
      // None in the avenue, at any height: its side is never nearer the line than the avenue's edge, less its wander.
      for (let point = first; point <= last; point += 1) {
        const here = grown.position(point);
        nearest = Math.min(nearest, Math.abs(here[0] - pathAt(here[2])[0]) - girth(point));
      }
    }
    expect(nearest).toBeGreaterThan(TEMPLE.avenue - 1.5);
    // All three grow here, and the cells in the avenue and out past the walls hold none.
    for (const kind of [FORMATION.stalactite, FORMATION.stalagmite, FORMATION.column]) expect(kinds[kind]).toBeGreaterThan(8);
    expect(kinds[FORMATION.none]).toBeGreaterThan(FORMATIONS * 0.2);
    const away = await kernelPoints(FORMATION_KERNEL, TEMPLE_STRIP_ATTRIBUTES, FORMATION_CAPACITY, { travel: TRAVEL, place: 0 }, ["girth", "tint"]);
    for (let point = 0; point < FORMATION_CAPACITY; point += 7) expect(away.of("girth", point)).toEqual([0]);
  }, 240_000);

  it("a fire sits on a stalagmite's tip, its flame and its light in one place; it burns higher with the low end and flares on the kick; and Listen at 0 it does neither", async () => {
    const track = { kick: 0, low: 0, react: 1 };
    const grown = await kernelPoints(FORMATION_KERNEL, TEMPLE_STRIP_ATTRIBUTES, FORMATION_CAPACITY, { travel: TRAVEL, place: 1 }, ["girth", "tint"]);
    const flames = await kernelPoints(FLAME_KERNEL, TEMPLE_STRIP_ATTRIBUTES, FLAME_CAPACITY, { travel: TRAVEL, place: 1, ...track }, ["girth", "tint"]);
    const firesAt = (heard: Record<string, number>, place = 1): Promise<KernelPoints> => kernelPoints(FIRE_KERNEL, FIRE_ATTRIBUTES, FORMATIONS, { travel: TRAVEL, place, power: 240, ...track, ...heard }, ["power", "tint"]);
    const [rest, kicked, low, deaf] = [await firesAt({}), await firesAt({ kick: 1 }), await firesAt({ low: 1 }), await firesAt({ kick: 1, low: 1, react: 0 })];
    let [burning, dark] = [0, 0];
    for (let slot = 0; slot < FORMATIONS; slot += 1) {
      const kind = Math.round(grown.of("tint", slot * TEMPLE.points)[0] as number);
      const power = rest.of("power", slot)[0] as number;
      const flameGirth = flames.of("girth", slot * TEMPLE.flamePoints + 1)[0] as number;
      if (kind !== FORMATION.stalagmite) {
        // No fire on anything else, and none where nothing stands.
        expect([slot, power, flameGirth]).toEqual([slot, 0, 0]);
        continue;
      }
      if (power === 0) {
        dark += 1;
        expect(flameGirth).toBe(0);
        continue;
      }
      burning += 1;
      const tip = grown.position(slot * TEMPLE.points + TEMPLE.points - 1);
      // The flame's root is the stalagmite's tip, and the light is in the flame: two fifths of its height up.
      expect(flames.position(slot * TEMPLE.flamePoints).map((part, axis) => Math.abs(part - (tip[axis] as number)) < 1e-3)).toEqual([true, true, true]);
      expect(rest.position(slot).map((part, axis) => Math.abs(part - ((tip[axis] as number) + (axis === 1 ? TEMPLE.flameTall * 0.4 : 0))) < 1e-3)).toEqual([true, true, true]);
      // A flame: a tongue, wider low down, nothing at its tip, standing up from its root.
      expect(flameGirth).toBeGreaterThan(0.4);
      expect(flames.of("girth", slot * TEMPLE.flamePoints + TEMPLE.flamePoints - 1)).toEqual([0]);
      expect(flames.position(slot * TEMPLE.flamePoints + TEMPLE.flamePoints - 1)[1]).toBeGreaterThan(tip[1] + 1);
      // Firelight: more red in it than blue, by far.
      const tint = rest.of("tint", slot);
      expect(tint[0] as number).toBeGreaterThan((tint[2] as number) * 4);
      // The kick: 1 + 1.6 of what it is at rest, to the float (the same frame, so the same flicker). The low end: 1.5.
      expect((kicked.of("power", slot)[0] as number) / power).toBeCloseTo(2.6, 4);
      expect((low.of("power", slot)[0] as number) / power).toBeCloseTo(1.5, 4);
      // Listen at 0: it burns as it does at rest, whatever the track does.
      expect((deaf.of("power", slot)[0] as number) / power).toBeCloseTo(1, 5);
    }
    // Two stalagmites in five carry one: some do, and more do not.
    expect(burning).toBeGreaterThan(8);
    expect(dark).toBeGreaterThan(burning * 0.6);
    // Out of the temple no fire burns.
    const away = await firesAt({}, 0);
    for (let slot = 0; slot < FORMATIONS; slot += 1) expect(away.of("power", slot)).toEqual([0]);
  }, 240_000);

  it("the fires light the rock, and with them cut the cave is black", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    // From the line, looking down the cave: its floor, walls and roof ahead.
    const line = pathAt(TRAVEL);
    const eye = [line[0], line[1], TRAVEL];
    const lookAt = [pathAt(TRAVEL + 40)[0], pathAt(TRAVEL + 40)[1] - 6, TRAVEL + 40];
    const SIZE = 64;
    const seen = async (power: number): Promise<number> => {
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: graph(
          [
            node("grid_cave", "pointGrid", [0, 0], { cols: TEMPLE.cols, rows: TEMPLE.rows, count: CAVE_CAPACITY, sizeX: 2, sizeY: 2 }),
            node("kernel_cave", "pointKernel", [0, 0], { capacity: CAVE_CAPACITY, attributes: CAVE_ATTRIBUTES, kernel: CAVE_KERNEL, travel: TRAVEL, place: 1 }),
            node("material_rock", "materialWgsl", [0, 0], { model: "pbr", source: ROCK_SURFACE_WGSL, wet: 0.5 }, { label: "material_rock" }),
            node("geometry_cave", "geometry", [0, 0], { mode: "surface", material: "material_rock", tint: mappedTo("tint", [0, 0, 0, 0]) as never }, { label: "geometry_cave" }),
            node("kernel_fires", "pointKernel", [0, 0], { capacity: FORMATIONS, attributes: FIRE_ATTRIBUTES, kernel: FIRE_KERNEL, travel: TRAVEL, place: 1, kick: 0, low: 0, react: 1, power }),
            node("light_fires", "light", [0, 0], { kind: "point", mode: "points", color: mappedTo("tint", [1, 1, 1, 1]) as never, intensity: mappedTo("power", 1) as never, falloff: "inverseSquare", range: 60 }, { label: "light_fires" }),
            node("camera_any", "camera", [0, 0], { eye, lookAt, fov: 70, near: 0.1, far: 520 }, { label: "camera_any" }),
            node("render_shot", "render", [0, 0], { scenes: "geometry_cave", camera: "camera_any", lights: "light_fires", ambientIntensity: 0, background: [0, 0, 0, 1] }, { label: "render_shot" }),
            node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
          ],
          [
            edge("grid-cave", ["grid_cave", "out"], ["kernel_cave", "in"]),
            edge("cave-geo", ["kernel_cave", "out"], ["geometry_cave", "points"]),
            edge("fires-light", ["kernel_fires", "out"], ["light_fires", "points"]),
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
      return frame.bytes.reduce((sum, byte, index) => (index % 4 === 0 ? sum + byte : sum), 0);
    };
    const [lit, twice, cut] = [await seen(240), await seen(480), await seen(0)];
    expect(cut).toBe(0);
    expect(lit).toBeGreaterThan(SIZE * SIZE * 2);
    // More fire, more light on the rock.
    expect(twice).toBeGreaterThan(lit * 1.3);
  }, 240_000);
});
