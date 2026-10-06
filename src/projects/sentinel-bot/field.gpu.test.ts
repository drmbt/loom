import { beforeAll, describe, expect, it } from "vitest";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { FIELD, FIELD_ATTRIBUTES, FIELD_TOWERS, POD_CAPACITY, POD_KERNEL, TOWER_CAPACITY, TOWER_KERNEL, towerAt } from "./field.ts";
import { PATH, pathAt } from "./path.ts";
import { BORE_ATTRIBUTES, BORE_KERNEL } from "./tunnel.ts";

/**
 * T1561b — THE FIELDS, read off the strips their kernels write, on a real GPU.
 *
 * What the place owes whoever flies through it and whoever looks: a tower is where the rule says
 * (the same tower whichever way the window has slid, the lap's end included), none of it reaches
 * into the avenue the robots and the camera use, its pods hang on it, and out of the fields
 * there is nothing of it to draw, as in the fields there is nothing of the tunnel.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

interface Strips {
  position(point: number): [number, number, number];
  girth(point: number): number;
}

/** One kernel's points with the robot `travel` metres along, in `place`. */
async function strips(kernel: string, attributes: string, capacity: number, parameters: Record<string, number>, grid?: { cols: number; rows: number }): Promise<Strips> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const points = node("kernel_read", "pointKernel", [0, 0], { capacity, attributes, kernel, ...parameters });
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        ...(grid === undefined ? [] : [node("grid_read", "pointGrid", [0, 0], { cols: grid.cols, rows: grid.rows, count: grid.cols * grid.rows, sizeX: 2, sizeY: 2 })]),
        points,
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
  const position = kernelRegionSlice(points as never, packed, "position").floats;
  const stride = position.length / capacity;
  const girth = attributes === BORE_ATTRIBUTES ? undefined : kernelRegionSlice(points as never, packed, "girth").floats;
  return {
    position: (point) => [position[point * stride] as number, position[point * stride + 1] as number, position[point * stride + 2] as number],
    girth: (point) => (girth === undefined ? 0 : (girth[point] as number)),
  };
}

/** The point of a tower's strip that stands at the height of the line: 70 of its 170 metres up, the eighth of eighteen. */
const AT_THE_LINE = 7;
/** The cell of the ground plan the window's slot `slot` holds, with the robot `travel` metres along (field.ts, towerOf). */
function cellOf(slot: number, travel: number): { across: number; along: number } {
  return {
    across: Math.floor(pathAt(travel)[0] / FIELD.cell) + (slot % FIELD.across) - Math.floor(FIELD.across / 2),
    along: Math.floor(travel / FIELD.cell) + Math.floor(slot / FIELD.across) - FIELD.behind,
  };
}

describe("the fields (T1561b)", () => {
  it("stands every tower where the rule puts it, whichever way the window has slid and over the lap's end, and none where the rule has an avenue", async () => {
    expect((-FIELD.below + ((FIELD.below + FIELD.above) * AT_THE_LINE) / (FIELD.towerPoints - 1))).toBe(0);
    // Mid-lap, one cell further on (every tower in a different slot), and with the window across the lap's end.
    for (const travel of [300, 300 + FIELD.cell, PATH.period - 20]) {
      const towers = await strips(TOWER_KERNEL, FIELD_ATTRIBUTES, TOWER_CAPACITY, { travel, place: 1 });
      let standing = 0;
      for (let slot = 0; slot < FIELD_TOWERS; slot += 1) {
        const { across, along } = cellOf(slot, travel);
        const ruled = towerAt(across, along);
        const foot = towers.position(slot * FIELD.towerPoints + AT_THE_LINE);
        if (!ruled.stands) {
          // In the avenue: not there. Every point of the strip is one point, with no radius to sweep.
          for (let point = 0; point < FIELD.towerPoints; point += 1) expect([travel, slot, towers.girth(slot * FIELD.towerPoints + point)]).toEqual([travel, slot, 0]);
          expect(foot[1]).toBeLessThan(-1000);
          continue;
        }
        standing += 1;
        // The CPU's tower and the GPU's are the same tower: a float's rounding apart at up to a kilometre from the origin.
        expect(Math.abs(foot[0] - ruled.x)).toBeLessThan(2e-3);
        expect(Math.abs(foot[2] - ruled.z)).toBeLessThan(2e-3);
        expect(Math.abs(foot[1] - pathAt(ruled.z)[1])).toBeLessThan(2e-3);
      }
      // Most cells hold one: an avenue two cells wide of an eleven-cell window, and the rule really did decide both ways.
      expect(standing).toBeGreaterThan(FIELD_TOWERS * 0.6);
      expect(standing).toBeLessThan(FIELD_TOWERS);
    }
  }, 240_000);

  it("keeps every trunk out of the avenue through the heights the robots and the camera use", async () => {
    const travel = 300;
    const towers = await strips(TOWER_KERNEL, FIELD_ATTRIBUTES, TOWER_CAPACITY, { travel, place: 1 });
    let nearest = Infinity;
    for (let slot = 0; slot < FIELD_TOWERS; slot += 1) {
      for (let point = 0; point < FIELD.towerPoints; point += 1) {
        // Whatever the GPU drew a trunk of, whether or not the rule on the CPU would have: a strip with a radius.
        if (towers.girth(slot * FIELD.towerPoints + point) === 0) continue;
        const at = towers.position(slot * FIELD.towerPoints + point);
        const above = at[1] - pathAt(at[2])[1];
        // The pack flies within 3 m of the line's height and the camera within 11.
        if (Math.abs(above) > 30) continue;
        nearest = Math.min(nearest, Math.abs(at[0] - pathAt(at[2])[0]) - towers.girth(slot * FIELD.towerPoints + point));
      }
    }
    // A metre inside the avenue's edge at the worst (a trunk leans, and swells): the furthest a field shot stands
    // off the line is 10.1 m (camera.test.ts holds that).
    expect(nearest).toBeGreaterThan(FIELD.avenue - 1);
    expect(nearest).toBeLessThan(FIELD.avenue + 6);
  }, 240_000);

  it("hangs every pod on its own tower, running outward, and none on a tower that is not there", async () => {
    const travel = 300;
    const pods = await strips(POD_KERNEL, FIELD_ATTRIBUTES, POD_CAPACITY, { travel, place: 1 });
    let hung = 0;
    for (let slot = 0; slot < FIELD_TOWERS; slot += 1) {
      const { across, along } = cellOf(slot, travel);
      const tower = towerAt(across, along);
      for (let pod = 0; pod < FIELD.pods; pod += 7) {
        const first = (slot * FIELD.pods + pod) * FIELD.podPoints;
        const [foot, tip] = [pods.position(first), pods.position(first + FIELD.podPoints - 1)];
        if (!tower.stands) {
          expect(pods.girth(first + 2)).toBe(0);
          expect(foot[1]).toBeLessThan(-1000);
          continue;
        }
        hung += 1;
        const off = (point: readonly number[]): number => Math.hypot((point[0] as number) - tower.x, (point[2] as number) - tower.z);
        // Its foot is at the trunk's skin (the trunk is 0.7 to 1.7 of its radius thick there and leans a metre at most), its far end further out.
        expect(off(foot)).toBeGreaterThan(tower.radius * 0.45);
        expect(off(foot)).toBeLessThan(tower.radius * 1.7 + 1);
        expect(off(tip) - off(foot)).toBeGreaterThan(0.5);
        // In the band it is meant to hang in.
        const above = foot[1] - pathAt(tower.z)[1];
        expect(above).toBeGreaterThan(FIELD.podsFrom - 0.01);
        expect(above).toBeLessThan(FIELD.podsTo + 0.01);
        // A spindle: its middle has a radius, its ends next to none.
        expect(pods.girth(first + 2)).toBeGreaterThan(0.3);
        expect(pods.girth(first)).toBeLessThan(0.05);
      }
    }
    expect(hung).toBeGreaterThan(100);
  }, 240_000);

  it("is not there in the tunnel, and the tunnel is not there in the fields", async () => {
    const towers = await strips(TOWER_KERNEL, FIELD_ATTRIBUTES, TOWER_CAPACITY, { travel: 300, place: 0 });
    for (let point = 0; point < TOWER_CAPACITY; point += 5) expect(towers.girth(point)).toBe(0);
    const pods = await strips(POD_KERNEL, FIELD_ATTRIBUTES, POD_CAPACITY, { travel: 300, place: 0 });
    for (let point = 0; point < POD_CAPACITY; point += 31) expect(pods.girth(point)).toBe(0);
    // The wall: a ring of it is metres across in the tunnel, and in the fields every point of it is one point.
    const COLS = 33;
    const ROWS = 24;
    const across = async (place: number): Promise<number> => {
      const wall = await strips(BORE_KERNEL, BORE_ATTRIBUTES, COLS * ROWS, { travel: 300, place }, { cols: COLS, rows: ROWS });
      let widest = 0;
      const first = wall.position(0);
      for (let point = 0; point < COLS * ROWS; point += 1) widest = Math.max(widest, Math.hypot(...wall.position(point).map((part, axis) => part - (first[axis] as number))));
      return widest;
    };
    expect(await across(0)).toBeGreaterThan(4);
    expect(await across(1)).toBe(0);
  }, 240_000);
});
