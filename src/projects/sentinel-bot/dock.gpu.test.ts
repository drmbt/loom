import { beforeAll, describe, expect, it } from "vitest";
import { mappedTo } from "../../nodes/definitions/curve-test-support.ts";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { BEAM_CAPACITY, BEAM_KERNEL, BEAM_LIGHT_KERNEL, BRIDGE_CAPACITY, BRIDGE_KERNEL, DOCK, DOCK_LAMPS, DOCK_LAMP_KERNEL, DOCK_LIGHT_ATTRIBUTES, DOCK_STRIP_ATTRIBUTES, HALL_ATTRIBUTES, HALL_CAPACITY, HALL_KERNEL, HALL_SURFACE_WGSL, bridgeAt, hallShell } from "./dock.ts";
import { pathAt } from "./path.ts";

/**
 * T1561b — THE DOCK, read off the points its kernels write, on a real GPU.
 *
 * What the place owes whoever flies through it and whoever looks: the hall stands round the line where the
 * rule says and holds still while its window rides along; nothing of it, shell or bridge, comes near what
 * flies down its middle; its lamps hang where its steel is and shine where they are meant to; a searchlight's
 * cone and its Spot are one beam; and out of the dock there is nothing of any of it to draw.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

type Vec = [number, number, number];

interface Read {
  position(point: number): Vec;
  /** A named attribute of a point, as its components. */
  of(name: string, point: number): number[];
}

/** One kernel's points, with these parameters; over a grid when `grid` says its size. */
async function points(kernel: string, attributes: string, capacity: number, parameters: Record<string, number>, names: readonly string[], grid?: { cols: number; rows: number }): Promise<Read> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const read = node("kernel_read", "pointKernel", [0, 0], { capacity, attributes, kernel, ...parameters });
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        ...(grid === undefined ? [] : [node("grid_read", "pointGrid", [0, 0], { cols: grid.cols, rows: grid.rows, count: grid.cols * grid.rows, sizeX: 2, sizeY: 2 })]),
        read,
        node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
        node("geometry_read", "geometry", [0, 0], { mode: "points", material: "material_dot" }, { label: "geometry_read" }),
        node("camera_any", "camera", [0, 0], {}, { label: "camera_any" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_read", camera: "camera_any", lights: "" }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [...(grid === undefined ? [] : [edge("grid-read", ["grid_read", "out"], ["kernel_read", "in"])]), edge("read-geo", ["kernel_read", "out"], ["geometry_read", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: 64, height: 64 } }),
    frames: 1,
    outputNodeId: "output_frame",
    probeBuffers: [pointStorageId("kernel_read")],
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const packed = (result.buffers ?? {})[pointStorageId("kernel_read")];
  if (packed === undefined) throw new Error("probe buffers missing");
  const slices = new Map(["position", ...names].map((name) => [name, kernelRegionSlice(read as never, packed, name).floats]));
  const of = (name: string, point: number): number[] => {
    const floats = slices.get(name);
    if (floats === undefined) throw new Error(`attribute ${name} was not read`);
    const stride = floats.length / capacity;
    return Array.from(floats.slice(point * stride, point * stride + stride));
  };
  return { position: (point) => of("position", point).slice(0, 3) as Vec, of };
}

const TRAVEL = 300;
/** The grid's point at column `i` of row `j`. */
const at = (i: number, j: number): number => j * DOCK.cols + i;
/** The world z of the hall's row `j` with the robot `travel` along. */
const rowZ = (j: number, travel: number): number => (Math.floor(travel / DOCK.row) + j - DOCK.behind) * DOCK.row;

describe("the dock (T1561b)", () => {
  it("stands its hall round the line where the rule says, ribs and gantries standing out of the shell, and holds still while its window rides along", async () => {
    const hall = await points(HALL_KERNEL, HALL_ATTRIBUTES, HALL_CAPACITY, { travel: TRAVEL, place: 1 }, ["tint"], { cols: DOCK.cols, rows: DOCK.rows });
    const kinds = [0, 0, 0, 0];
    let nearest = Infinity;
    for (let j = 0; j < DOCK.rows; j += 7) {
      const z = rowZ(j, TRAVEL);
      const line = pathAt(z);
      for (let i = 0; i < DOCK.cols; i += 1) {
        const [what, high, around, along] = hall.of("tint", at(i, j)) as [number, number, number, number];
        const point = hall.position(at(i, j));
        kinds[what] = (kinds[what] as number) + 1;
        // It says where it is: the row's own distance along, and how high over the line.
        expect(Math.abs(along - z)).toBeLessThan(1e-3);
        expect(Math.abs(point[2] - z)).toBeLessThan(1e-3);
        expect(Math.abs(point[1] - line[1] - high)).toBeLessThan(2e-3);
        // Where the rule puts it: on the shell, or standing in from it by what it is.
        const theta = (around - 0.25) * 2 * Math.PI;
        const shell = hallShell(theta);
        const radius = Math.hypot(point[0] - line[0], point[1] - line[1] - DOCK.lift);
        const stands = what === 1 ? DOCK.ribDeep : what === 2 ? DOCK.tierDeep : 0;
        expect([i, j, what, Math.abs(radius - (shell - stands)) < 5e-3]).toEqual([i, j, what, true]);
        if (what === 3) expect(Math.abs(high + DOCK.deck)).toBeLessThan(2e-3);
        // A rib is at a bay's middle and nowhere else.
        if (what === 1) expect(Math.abs(z - (Math.floor(z / DOCK.rib) + 0.5) * DOCK.rib)).toBeLessThan(DOCK.ribWide / 2);
        // What flies is within 4 m of the line and the lens within 10, at heights from 3 m under it to 7 over.
        if (high > -4 && high < 8) nearest = Math.min(nearest, Math.abs(point[0] - line[0]));
      }
    }
    // All four are there: plates, ribs, gantries, deck.
    for (const count of kinds) expect(count).toBeGreaterThan(20);
    // Nothing of the hall within thirty metres of the line at the heights anything flies at.
    expect(nearest).toBeGreaterThan(30);
    // The window rides, the hall does not: a row further on with the robot a row further back is the same steel.
    const slid = await points(HALL_KERNEL, HALL_ATTRIBUTES, HALL_CAPACITY, { travel: TRAVEL + DOCK.row * 5, place: 1 }, ["tint"], { cols: DOCK.cols, rows: DOCK.rows });
    for (const [i, j] of [[0, 40], [37, 90], [101, 200], [150, 12]] as const) expect(slid.position(at(i, j))).toEqual(hall.position(at(i, j + 5)));
    // Out of the dock: every point of it is one point, far under everything.
    const away = await points(HALL_KERNEL, HALL_ATTRIBUTES, HALL_CAPACITY, { travel: TRAVEL, place: 0 }, ["tint"], { cols: DOCK.cols, rows: DOCK.rows });
    for (let point = 0; point < HALL_CAPACITY; point += 997) expect(away.position(point)).toEqual([0, -4000, 0]);
  }, 240_000);

  it("throws its bridges across at every third rib, wall to wall, each at its own height and all of them over what flies", async () => {
    const bridges = await points(BRIDGE_KERNEL, DOCK_STRIP_ATTRIBUTES, BRIDGE_CAPACITY, { travel: TRAVEL, place: 1 }, ["girth"]);
    const heights = new Set<number>();
    for (let bridge = 0; bridge < DOCK.bridges; bridge += 1) {
      const rib = (Math.floor(TRAVEL / (DOCK.rib * DOCK.bridgeEvery)) - 2 + bridge) * DOCK.bridgeEvery;
      const ruled = bridgeAt(rib);
      expect(ruled.there).toBe(true);
      const line = pathAt(ruled.z);
      const [first, last] = [bridges.position(bridge * DOCK.bridgePoints), bridges.position((bridge + 1) * DOCK.bridgePoints - 1)];
      for (const end of [first, last]) {
        expect(Math.abs(end[2] - ruled.z)).toBeLessThan(1e-3);
        expect(Math.abs(end[1] - line[1] - ruled.height)).toBeLessThan(2e-3);
      }
      // Wall to wall at that height: within a metre of the shell both sides.
      const half = Math.sqrt(DOCK.radius ** 2 - (ruled.height - DOCK.lift) ** 2);
      expect(Math.abs(line[0] - first[0] - half)).toBeLessThan(1);
      expect(Math.abs(last[0] - line[0] - half)).toBeLessThan(1);
      // Over what flies: the lens goes 7 m over the line at the most, a bridge's underside is 0.75 m under its middle.
      expect(ruled.height - (bridges.of("girth", bridge * DOCK.bridgePoints)[0] as number)).toBeGreaterThan(10);
      heights.add(Math.round(ruled.height * 10));
    }
    // Each at its own height.
    expect(heights.size).toBeGreaterThan(DOCK.bridges / 2);
    const away = await points(BRIDGE_KERNEL, DOCK_STRIP_ATTRIBUTES, BRIDGE_CAPACITY, { travel: TRAVEL, place: 0 }, ["girth"]);
    for (let point = 0; point < BRIDGE_CAPACITY; point += 1) expect(away.of("girth", point)).toEqual([0]);
  }, 240_000);

  it("hangs three lamps at every rib: a flood in the crown shining straight down, and one under each wall's second gantry turned to the wall; some dead; none out of the dock", async () => {
    const lamps = await points(DOCK_LAMP_KERNEL, DOCK_LIGHT_ATTRIBUTES, DOCK_LAMPS, { travel: TRAVEL, place: 1, power: 180, flood: 2500 }, ["power", "aim", "tint"]);
    let [dead, lit] = [0, 0];
    for (let lamp = 0; lamp < DOCK_LAMPS; lamp += 1) {
      const rib = Math.floor(TRAVEL / DOCK.rib) + Math.floor(lamp / 3) - DOCK.lampRibsBehind;
      const z = (rib + 0.5) * DOCK.rib;
      const line = pathAt(z);
      const point = lamps.position(lamp);
      const [power, aim, tint] = [lamps.of("power", lamp)[0] as number, lamps.of("aim", lamp), lamps.of("tint", lamp)];
      expect(Math.abs(point[2] - z)).toBeLessThan(1e-3);
      const which = lamp % 3;
      if (which === 2) {
        // The flood: on the middle line, a metre under the rib's crown, straight down, cold.
        expect(Math.abs(point[0] - line[0])).toBeLessThan(1e-3);
        expect(Math.abs(point[1] - line[1] - (DOCK.lift + DOCK.radius - DOCK.ribDeep - 1))).toBeLessThan(2e-3);
        // (A vec3f is stored four wide: the first three are it.)
        expect(aim.slice(0, 3).map((part) => Math.round(part * 1e4) / 1e4 + 0)).toEqual([0, -1, 0]);
        expect(tint[2] as number).toBeGreaterThan(tint[0] as number);
        expect([0, 2500]).toContain(power);
      } else {
        // A gantry's lamp: just in from the second gantry's edge and under it, on its own wall, turned to that wall. Sodium.
        const side = which === 1 ? 1 : -1;
        const high = (DOCK.tiers[1] as number) - 1.2;
        const edge = Math.sqrt(DOCK.radius ** 2 - (high - DOCK.lift) ** 2) - DOCK.tierDeep;
        expect(Math.abs(point[1] - line[1] - high)).toBeLessThan(2e-3);
        expect(Math.abs((point[0] - line[0]) * side - (edge - 0.6))).toBeLessThan(2e-3);
        expect((aim[0] as number) * side).toBeGreaterThan(0.3);
        expect(aim[1] as number).toBeLessThan(-0.8);
        expect(tint[0] as number).toBeGreaterThan((tint[2] as number) * 2);
        expect([0, 180]).toContain(power);
      }
      if (power === 0) dead += 1;
      else lit += 1;
    }
    // One in five is dead, by its own lot: some are, most are not.
    expect(dead).toBeGreaterThan(3);
    expect(lit).toBeGreaterThan(DOCK_LAMPS * 0.6);
    const away = await points(DOCK_LAMP_KERNEL, DOCK_LIGHT_ATTRIBUTES, DOCK_LAMPS, { travel: TRAVEL, place: 0, power: 180, flood: 2500 }, ["power"]);
    for (let lamp = 0; lamp < DOCK_LAMPS; lamp += 1) expect(away.of("power", lamp)).toEqual([0]);
  }, 240_000);

  it("a searchlight's cone and its Spot are one beam: from the deck, upward, the same way, and they go about", async () => {
    const beamsAt = async (sweep: number, level = 1): Promise<{ cones: Read; spots: Read }> => ({
      cones: await points(BEAM_KERNEL, DOCK_STRIP_ATTRIBUTES, BEAM_CAPACITY, { travel: TRAVEL, place: 1, sweep, level }, ["girth"]),
      spots: await points(BEAM_LIGHT_KERNEL, DOCK_LIGHT_ATTRIBUTES, DOCK.beams, { travel: TRAVEL, place: 1, sweep, level, power: 900 }, ["power", "aim"]),
    });
    const [here, later] = [await beamsAt(0.3), await beamsAt(1.1)];
    for (let beam = 0; beam < DOCK.beams; beam += 1) {
      const [foot, far] = [here.cones.position(beam * DOCK.beamPoints), here.cones.position((beam + 1) * DOCK.beamPoints - 1)];
      const along = far.map((part, axis) => (part - (foot[axis] as number)) / DOCK.beamLength);
      const aim = here.spots.of("aim", beam);
      // The Spot stands at the cone's foot and shines along it.
      expect(here.spots.position(beam).map((part, axis) => Math.abs(part - (foot[axis] as number)) < 1e-3)).toEqual([true, true, true]);
      expect(along.map((part, axis) => Math.abs(part - (aim[axis] as number)) < 1e-3)).toEqual([true, true, true]);
      expect(here.spots.of("power", beam)).toEqual([900]);
      // On the deck, by a wall, and upward: never across the deck or down into it.
      const line = pathAt(foot[2]);
      expect(Math.abs(foot[1] - line[1] + DOCK.deck - 0.6)).toBeLessThan(2e-3);
      expect(Math.abs(Math.abs(foot[0] - line[0]) - 30)).toBeLessThan(1e-3);
      expect(aim[1] as number).toBeGreaterThan(0.55);
      // A cone: a lamp's glass at the foot, metres across at the far end.
      expect(here.cones.of("girth", beam * DOCK.beamPoints)[0] as number).toBeLessThan(0.5);
      expect(here.cones.of("girth", (beam + 1) * DOCK.beamPoints - 1)[0] as number).toBeGreaterThan(3);
      // It goes about: later it points somewhere else.
      const then = later.spots.of("aim", beam);
      expect(Math.hypot(...aim.map((part, axis) => part - (then[axis] as number)))).toBeGreaterThan(0.1);
    }
    // Put out: no cone to draw and no light.
    const out = await beamsAt(0.3, 0);
    for (let point = 0; point < BEAM_CAPACITY; point += 1) expect(out.cones.of("girth", point)).toEqual([0]);
    for (let beam = 0; beam < DOCK.beams; beam += 1) expect(out.spots.of("power", beam)).toEqual([0]);
  }, 240_000);

  it("the lamps light the hall: a wall is lit under its gantry's lamp, and is black with the lamps cut", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    // From the middle of the hall, level with the line, looking square at the right wall a few metres under its second gantry.
    const rib = Math.floor(TRAVEL / DOCK.rib);
    const z = (rib + 0.5) * DOCK.rib + 5;
    const line = pathAt(z);
    const eye = [line[0], line[1], z];
    const lookAt = [line[0] + 38, line[1] - 1, z];
    const SIZE = 64;
    const seen = async (power: number, flood: number): Promise<number> => {
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: graph(
          [
            node("grid_hall", "pointGrid", [0, 0], { cols: DOCK.cols, rows: DOCK.rows, count: HALL_CAPACITY, sizeX: 2, sizeY: 2 }),
            node("kernel_hall", "pointKernel", [0, 0], { capacity: HALL_CAPACITY, attributes: HALL_ATTRIBUTES, kernel: HALL_KERNEL, travel: TRAVEL, place: 1 }),
            // The steel's own lights off (its gantry lamps, pads and windows are painted light): only what a Light throws on it.
            node("material_hall", "materialWgsl", [0, 0], { model: "pbr", source: HALL_SURFACE_WGSL, lamps: 0, pads: 0, kick: 0, beat: 0, react: 0, robotAt: [0, 0, 0] }, { label: "material_hall" }),
            node("geometry_hall", "geometry", [0, 0], { mode: "surface", material: "material_hall", tint: mappedTo("tint", [0, 0, 0, 0]) as never }, { label: "geometry_hall" }),
            node("kernel_docklamps", "pointKernel", [0, 0], { capacity: DOCK_LAMPS, attributes: DOCK_LIGHT_ATTRIBUTES, kernel: DOCK_LAMP_KERNEL, travel: TRAVEL, place: 1, power, flood }),
            node("light_docklamps", "light", [0, 0], { kind: "spot", mode: "points", direction: mappedTo("aim", [0, -1, 0]) as never, cone: 120, coneSoftness: 0.8, color: mappedTo("tint", [1, 1, 1, 1]) as never, intensity: mappedTo("power", 1) as never, falloff: "inverseSquare", range: 90 }, { label: "light_docklamps" }),
            node("camera_any", "camera", [0, 0], { eye, lookAt, fov: 50, near: 0.1, far: 520 }, { label: "camera_any" }),
            node("render_shot", "render", [0, 0], { scenes: "geometry_hall", camera: "camera_any", lights: "light_docklamps", ambientIntensity: 0, background: [0, 0, 0, 1] }, { label: "render_shot" }),
            node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
          ],
          [
            edge("grid-hall", ["grid_hall", "out"], ["kernel_hall", "in"]),
            edge("hall-geo", ["kernel_hall", "out"], ["geometry_hall", "points"]),
            edge("lamps-light", ["kernel_docklamps", "out"], ["light_docklamps", "points"]),
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
      // How much red light is in the frame.
      return frame.bytes.reduce((sum, byte, index) => (index % 4 === 0 ? sum + byte : sum), 0);
    };
    // Both kinds lit; the gantries' lamps alone (they are what is turned to the wall); and nothing lit.
    const [all, gantries, none] = [await seen(180, 2500), await seen(180, 0), await seen(0, 0)];
    expect(none).toBe(0);
    expect(gantries).toBeGreaterThan(SIZE * SIZE * 2);
    // The floods shine down the middle and reach the wall too, a little: with them there is more.
    expect(all).toBeGreaterThan(gantries);
  }, 240_000);
});
