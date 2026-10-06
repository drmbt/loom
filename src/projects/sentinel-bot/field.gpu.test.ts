import { beforeAll, describe, expect, it } from "vitest";
import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { mappedTo } from "../../nodes/definitions/curve-test-support.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { BOLT_ATTRIBUTES, BOLT_CAPACITY, BOLT_KERNEL, BOLT_SURFACE_WGSL, FIELD, FIELD_ATTRIBUTES, TOWER_CAPACITY, TOWER_KERNEL, TOWER_SURFACE_WGSL, TRUNK_TOWERS, strikeAt, towerAt, type FieldWindow } from "./field.ts";
import { PATH, pathAt } from "./path.ts";
import { BORE_ATTRIBUTES, BORE_KERNEL } from "./tunnel.ts";

/**
 * T1561b — THE FIELDS, read off the strips their kernels write, on a real GPU.
 *
 * What the place owes whoever flies through it and whoever looks: a tower is where the rule says
 * (the same tower whichever way the window has slid, the lap's end included), none of it reaches
 * into the avenue the robots and the camera use, it is covered in pods that are shapes, and out of the fields
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
/** The cell of the ground plan that slot `slot` of a window holds, with the robot `travel` metres along (field.ts, towerOf). */
function cellOf(window: FieldWindow, slot: number, travel: number): { across: number; along: number } {
  return {
    across: Math.floor(pathAt(travel)[0] / FIELD.cell) + (slot % window.across) - Math.floor(window.across / 2),
    along: Math.floor(travel / FIELD.cell) + Math.floor(slot / window.across) - window.behind,
  };
}

/**
 * The towers alone, through their own chain (kernel, strips, frames, Sweep, the trunk's material), from `eye`
 * toward `lookAt`: the frame's bytes, four to a pixel, linear. No light but the pods' own unless `sun` says
 * which way one travels.
 */
async function towersSeen(options: { travel: number; eye: readonly number[]; lookAt: readonly number[]; fov: number; size: number; material: Record<string, number | number[]>; sun?: readonly number[] }): Promise<Uint8Array> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        node("kernel_towers", "pointKernel", [0, 0], { capacity: TOWER_CAPACITY, attributes: FIELD_ATTRIBUTES, kernel: TOWER_KERNEL, travel: options.travel, place: 1 }),
        node("topology_towers", "pointTopology", [0, 0], { connectivity: "strips", cols: FIELD.towerPoints, rows: TRUNK_TOWERS }),
        node("frames_towers", "pointCurveFrames", [0, 0], { method: "minimiseTwist", up: [1, 0, 0] }),
        // As the document sweeps them (document.ts, sweep_towers): the material reads the Sweep's own winding.
        node("sweep_towers", "pointSweep", [0, 0], { profile: "ring", sides: 12, radius: mappedTo("girth", 1) as never }),
        node("material_tower", "materialWgsl", [0, 0], { model: "pbr", source: TOWER_SURFACE_WGSL, glow: 0.4, hueFrom: 0, hueTo: 0.03, low: 0, kick: 0, hat: 0, beat: 0, react: 1, robotAt: [...options.eye], ...options.material }, { label: "material_tower" }),
        node("geometry_towers", "geometry", [0, 0], { mode: "surface", material: "material_tower", tint: mappedTo("tint", [0, 0, 0, 0]) as never }, { label: "geometry_towers" }),
        ...(options.sun === undefined ? [] : [node("light_sun", "light", [0, 0], { kind: "directional", color: [1, 1, 1, 1], direction: [...options.sun], intensity: 3 }, { label: "light_sun" })]),
        node("camera_any", "camera", [0, 0], { eye: [...options.eye], lookAt: [...options.lookAt], fov: options.fov, near: 0.1, far: 520 }, { label: "camera_any" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_towers", camera: "camera_any", lights: options.sun === undefined ? "" : "light_sun", ambientIntensity: 0, background: [0, 0, 0, 1] }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [
        edge("towers-strips", ["kernel_towers", "out"], ["topology_towers", "points"]),
        edge("towers-frames", ["topology_towers", "out"], ["frames_towers", "points"]),
        edge("towers-sweep", ["frames_towers", "out"], ["sweep_towers", "points"]),
        edge("towers-geo", ["sweep_towers", "out"], ["geometry_towers", "points"]),
        edge("shot-out", ["render_shot", "out"], ["output_frame", "input"]),
      ],
    ),
    settings: settings({ outputResolution: { width: options.size, height: options.size }, workingFormat: "rgba8unorm" }),
    frames: 1,
    outputNodeId: "render_shot",
    outputPortId: "out",
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame");
  return frame.bytes;
}

describe("the fields (T1561b)", () => {
  it("stands every tower where the rule puts it, whichever way the window has slid and over the lap's end, and none where the rule has an avenue", async () => {
    expect((-FIELD.below + ((FIELD.below + FIELD.above) * AT_THE_LINE) / (FIELD.towerPoints - 1))).toBe(0);
    // Mid-lap, one cell further on (every tower in a different slot), and with the window across the lap's end.
    for (const travel of [300, 300 + FIELD.cell, PATH.period - 20]) {
      const towers = await strips(TOWER_KERNEL, FIELD_ATTRIBUTES, TOWER_CAPACITY, { travel, place: 1 });
      let standing = 0;
      for (let slot = 0; slot < TRUNK_TOWERS; slot += 1) {
        const { across, along } = cellOf(FIELD.trunks, slot, travel);
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
      // Most cells hold one: an avenue two cells wide of a window twenty-one wide, and the rule really did decide both ways.
      expect(standing).toBeGreaterThan(TRUNK_TOWERS * 0.8);
      expect(standing).toBeLessThan(TRUNK_TOWERS);
    }
  }, 240_000);

  it("keeps every trunk out of the avenue through the heights the robots and the camera use", async () => {
    const travel = 300;
    const towers = await strips(TOWER_KERNEL, FIELD_ATTRIBUTES, TOWER_CAPACITY, { travel, place: 1 });
    let nearest = Infinity;
    for (let slot = 0; slot < TRUNK_TOWERS; slot += 1) {
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

  it("draws a strike of lightning where the rule puts it, up a tower's flank or across to the next, forks and all, and nothing of it without a flash", async () => {
    // One of each kind (field.ts, STRIKE_KINDS), and one with the robot at the lap's end.
    const kinds: string[] = [];
    for (const [strike, travel] of [[1, 300], [2, 300], [3, 300], [133, PATH.period - 20]] as const) {
      const ruled = strikeAt(strike, travel);
      kinds.push(ruled.kind);
      expect(ruled.live).toBe(true);
      const bolts = await strips(BOLT_KERNEL, BOLT_ATTRIBUTES, BOLT_CAPACITY, { travel, place: 1, strike, flash: 1 });
      const gap = (a: readonly number[], b: readonly number[]): number => Math.hypot((a[0] as number) - (b[0] as number), (a[1] as number) - (b[1] as number), (a[2] as number) - (b[2] as number));
      const reach = gap(ruled.start, ruled.end);
      if (ruled.kind === "flank") {
        // Up one tower: tens of metres, nearly straight up.
        expect(reach).toBeGreaterThan(29);
        expect(reach).toBeLessThan(58);
        expect(ruled.end[1] - ruled.start[1]).toBeGreaterThan(reach * 0.95);
      } else {
        // Two towers that stand next to each other: a cell apart, give or take where each stands in its cell.
        expect(reach).toBeGreaterThan(8);
        expect(reach).toBeLessThan(FIELD.cell * 2);
      }
      // It is held at both ends where the rule says (the GPU's tower and the CPU's are the same tower), and
      // between them it wanders but does not leave.
      expect([strike, gap(bolts.position(0), ruled.start) < 0.02]).toEqual([strike, true]);
      expect([strike, gap(bolts.position(FIELD.boltPoints - 1), ruled.end) < 0.02]).toEqual([strike, true]);
      let strays = 0;
      for (let point = 1; point < FIELD.boltPoints - 1; point += 1) {
        const at = bolts.position(point);
        const along = point / (FIELD.boltPoints - 1);
        const straight = ruled.start.map((part, axis) => part + ((ruled.end[axis] as number) - part) * along);
        strays = Math.max(strays, gap(at, straight));
        expect(bolts.girth(point)).toBeGreaterThan(0.25);
      }
      // It is kinked (a straight rod is not lightning), by no more than an arc between two towers is.
      expect(strays).toBeGreaterThan(0.6);
      expect(strays).toBeLessThan(FIELD.cell * 0.45);
      // Each fork leaves the arc and goes down, thinning to nothing.
      for (let fork = 1; fork < FIELD.bolts; fork += 1) {
        const first = fork * FIELD.boltPoints;
        const [root, tip] = [bolts.position(first), bolts.position(first + FIELD.boltPoints - 1)];
        expect(Math.min(gap(root, ruled.start), gap(root, ruled.end))).toBeLessThan(reach);
        expect(tip[1]).toBeLessThan(root[1] - Math.min(reach, FIELD.cell) * 0.2);
        expect(bolts.girth(first)).toBeGreaterThan(0.12);
        expect(bolts.girth(first + FIELD.boltPoints - 1)).toBeLessThan(1e-6);
      }
      // No flash, or the tunnel: nothing to draw.
      for (const off of [{ flash: 0, place: 1 }, { flash: 1, place: 0 }]) {
        const none = await strips(BOLT_KERNEL, BOLT_ATTRIBUTES, BOLT_CAPACITY, { travel, strike, ...off });
        for (let point = 0; point < BOLT_CAPACITY; point += 1) expect([off, point, none.girth(point)]).toEqual([off, point, 0]);
      }
    }
    expect(kinds.slice(0, 3).sort()).toEqual(["along", "flank", "outward"]);
  }, 240_000);

  it("the strike is light on the screen: a lens held on the arc's middle sees it, and sees nothing with no flash", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    // An arc across to the next tower (field.ts, STRIKE_KINDS).
    const [strike, travel] = [2, 300];
    const ruled = strikeAt(strike, travel);
    const middle = ruled.start.map((part, axis) => (part + (ruled.end[axis] as number)) / 2) as [number, number, number];
    const span = ruled.end.map((part, axis) => part - (ruled.start[axis] as number));
    // Off to one side of the arc, level with it, far enough that the whole arc is in the frame.
    const reach = Math.hypot(...span);
    const side = [span[2] as number, 0, -(span[0] as number)].map((part) => (part / Math.hypot(span[0] as number, span[2] as number)) * reach * 1.2);
    const eye = middle.map((part, axis) => part + (side[axis] as number));
    const seen = async (flash: number): Promise<number> => {
      const result = await renderHeadless({
        host: nodeGpuHost(),
        graph: graph(
          [
            node("kernel_bolts", "pointKernel", [0, 0], { capacity: BOLT_CAPACITY, attributes: BOLT_ATTRIBUTES, kernel: BOLT_KERNEL, travel, place: 1, strike, flash }),
            node("topology_bolts", "pointTopology", [0, 0], { connectivity: "strips", cols: FIELD.boltPoints, rows: FIELD.bolts }),
            node("frames_bolts", "pointCurveFrames", [0, 0], { method: "minimiseTwist", up: [0, 1, 0] }),
            node("sweep_bolts", "pointSweep", [0, 0], { profile: "ring", sides: 5, radius: mappedTo("girth", 1) as never }),
            node("material_bolt", "materialWgsl", [0, 0], { model: "pbr", source: BOLT_SURFACE_WGSL, glow: 90 }, { label: "material_bolt" }),
            node("geometry_bolts", "geometry", [0, 0], { mode: "surface", material: "material_bolt", tint: mappedTo("tint", [0, 0, 0, 0]) as never }, { label: "geometry_bolts" }),
            node("camera_any", "camera", [0, 0], { eye, lookAt: middle, fov: 60, near: 0.1, far: 400 }, { label: "camera_any" }),
            node("render_shot", "render", [0, 0], { scenes: "geometry_bolts", camera: "camera_any", lights: "", background: [0, 0, 0, 1] }, { label: "render_shot" }),
            node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
          ],
          [
            edge("bolts-strips", ["kernel_bolts", "out"], ["topology_bolts", "points"]),
            edge("bolts-frames", ["topology_bolts", "out"], ["frames_bolts", "points"]),
            edge("bolts-sweep", ["frames_bolts", "out"], ["sweep_bolts", "points"]),
            edge("bolts-geo", ["sweep_bolts", "out"], ["geometry_bolts", "points"]),
            edge("shot-out", ["render_shot", "out"], ["output_frame", "input"]),
          ],
        ),
        settings: settings({ outputResolution: { width: 96, height: 96 } }),
        frames: 1,
        outputNodeId: "output_frame",
      });
      const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
      if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
      const frame = result.frames[0];
      if (frame === undefined) throw new Error("no frame");
      // How many pixels of the frame are lit at all: any colour byte that is not zero, whatever the target's format.
      const stride = frame.bytes.length / (frame.width * frame.height);
      const colour = (stride / 4) * 3;
      let lit = 0;
      for (let pixel = 0; pixel < frame.bytes.length; pixel += stride) if (frame.bytes.subarray(pixel, pixel + colour).some((byte) => byte !== 0)) lit += 1;
      return lit;
    };
    // The arc is 0.6 m thick and crosses most of a frame that is 1.4 arcs wide: a band of pixels, not a speck.
    expect(await seen(1)).toBeGreaterThan(96);
    expect(await seen(0)).toBe(0);
  }, 240_000);

  it("a tower is covered in pods that answer the track each in its own way: more lit the louder, a kick's ring from the robot, a hat's few", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
    const travel = 300;
    // In the avenue, on the line, looking across and ahead: a dozen towers from 15 m off to past a hundred.
    const here = pathAt(travel);
    const eye = [here[0], here[1], travel];
    const lookAt = [here[0] + 60, here[1], travel + 60];
    /** The frame's bytes with only the towers in it and no light but their own. */
    const shot = (light: Record<string, number | number[]>): Promise<Uint8Array> => towersSeen({ travel, eye, lookAt, fov: 60, size: 128, material: light });
    /** How much red light is in a frame, and how many of its pixels have any. */
    const red = (bytes: Uint8Array): number => bytes.reduce((sum, byte, index) => (index % 4 === 0 ? sum + byte : sum), 0);
    const lit = (bytes: Uint8Array): number => bytes.reduce((count, byte, index) => (index % 4 === 0 && byte > 0 ? count + 1 : count), 0);

    const quiet = await shot({});
    // The towers are in the frame and lit by nothing but their pods: thousands of pixels of them, and with the
    // pods' light cut, not one.
    expect(lit(quiet)).toBeGreaterThan(2000);
    expect(lit(await shot({ glow: 0 }))).toBe(0);
    // Pods, not a glowing trunk: what is as much as half as bright as the brightest pod is a small part of what is lit
    // at all (the rest is the pods' wash on the machinery between them, and towers too far off to show one pod).
    const brightest = quiet.reduce((most, byte, index) => (index % 4 === 0 ? Math.max(most, byte) : most), 0);
    const bright = quiet.reduce((count, byte, index) => (index % 4 === 0 && byte >= brightest / 2 ? count + 1 : count), 0);
    expect(bright).toBeGreaterThan(10);
    expect(bright).toBeLessThan(lit(quiet) * 0.3);

    // THE LOW END: the louder, the more of them are lit. Each has its own level, so half way is in between.
    const [half, loud] = [await shot({ low: 0.65 }), await shot({ low: 1 })];
    expect(red(half)).toBeGreaterThan(red(quiet) * 1.1);
    expect(red(loud)).toBeGreaterThan(red(half) * 1.1);

    // A KICK is a ring from the robot. Just struck, it is at the robot, where no tower is: nothing yet. A fifth
    // died away it is 30 m out, in among the near towers. And it is the ROBOT's: a robot a kilometre off flares
    // nothing here, to the byte.
    const ring = await shot({ kick: 0.8 });
    expect(red(ring)).toBeGreaterThan(red(quiet) * 1.1);
    expect(Array.from(await shot({ kick: 0.8, robotAt: [eye[0] as number, eye[1] as number, travel + 1000] }))).toEqual(Array.from(quiet));
    // …and it goes out: later, the near towers are quiet again and it is the far ones that flare.
    const later = await shot({ kick: 0.4 });
    expect(Array.from(later)).not.toEqual(Array.from(ring));

    // A HAT flares a few, and other ones the next beat.
    const [three, four] = [await shot({ hat: 1, beat: 3 }), await shot({ hat: 1, beat: 4 })];
    expect(red(three)).toBeGreaterThan(red(quiet));
    expect(Array.from(three)).not.toEqual(Array.from(four));
    // With no hat the beat's count changes nothing.
    expect(Array.from(await shot({ beat: 4 }))).toEqual(Array.from(quiet));

    // Listen at 0: nothing the track does shows.
    const deaf = await shot({ react: 0 });
    expect(Array.from(await shot({ react: 0, low: 1, kick: 0.8, hat: 1, beat: 4 }))).toEqual(Array.from(deaf));
  }, 600_000);

  it("a pod is a shape standing out of the trunk: a light from one side falls on that side of it", async () => {
    // The owner, 2026-10-06, of pods that were lit dots painted on the trunk: "the pods are not really structures,
    // visible structures at all … not plastic enough". A painted dot is the same on both its sides whatever lights
    // it. A shape that stands out of the trunk is bright on the side the light is on; one sunk INTO it (which is
    // what this looks like if the lattice's columns are counted the wrong way round the trunk) on the other.
    const travel = 300;
    // The nearest tower on the line's right, and a lens level with the line looking straight at its skin.
    let tower = towerAt(1, Math.floor(travel / FIELD.cell));
    for (let across = 0; across <= 3 && !tower.stands; across += 1) tower = towerAt(across, Math.floor(travel / FIELD.cell));
    expect(tower.stands).toBe(true);
    const level = pathAt(tower.z)[1] + 2;
    const SIZE = 96;
    const dark = { glow: 0 };
    // Which way is the picture's left: looking along +x it is −z. Not taken on trust (a first version of this
    // test had it the other way round): held by the trunk itself, which is a round thing whatever its pods are.
    // From thirty metres off, where a pod is a few pixels, a light that travels from −z to +z leaves the trunk's
    // left half the brighter.
    const leftward = [0.5, 0, 0.87];
    const rightward = [0.5, 0, -0.87];
    const halves = (bytes: Uint8Array, from = 0, to = SIZE, top = 0, bottom = SIZE): [number, number] => {
      let [left, right] = [0, 0];
      const middle = (from + to) / 2;
      for (let y = top; y < bottom; y += 1) for (let x = from; x < to; x += 1) {
        const value = bytes[(y * SIZE + x) * 4 + 1] as number;
        if (x < middle) left += value;
        else right += value;
      }
      return [left, right];
    };
    const far = [tower.x - 30, level, tower.z];
    const trunk = halves(await towersSeen({ travel, eye: far, lookAt: [tower.x, level, tower.z], fov: 20, size: SIZE, material: dark, sun: leftward }));
    expect(trunk[0]).toBeGreaterThan(trunk[1] * 1.3);

    // Close: 2.6 m off the skin, a frame two metres across, so a pod is half of it. Where one is: the pods' own
    // light, with nothing else on, and the brightest of it.
    const near = [tower.x - tower.radius * 1.7 - 2.6, level, tower.z];
    const view = { travel, eye: near, lookAt: [tower.x, level, tower.z], fov: 42, size: SIZE };
    const own = await towersSeen({ ...view, material: { glow: 2 } });
    let [best, bestX, bestY] = [0, 0, 0];
    // …away from the frame's edge, so both its sides are in the picture.
    for (let y = 20; y < SIZE - 20; y += 1) for (let x = 20; x < SIZE - 20; x += 1) {
      // A pod's middle: the brightest five-by-five of its own light.
      let sum = 0;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) sum += own[((y + dy) * SIZE + x + dx) * 4] as number;
      if (sum > best) [best, bestX, bestY] = [sum, x, y];
    }
    expect(best).toBeGreaterThan(25 * 20);
    // The same pod with its own light off and a light from the left, then from the right: sixteen pixels either
    // side of its middle, eight above and below.
    const sides = async (sun: readonly number[]): Promise<[number, number]> => halves(await towersSeen({ ...view, material: dark, sun }), bestX - 16, bestX + 16, bestY - 8, bestY + 8);
    const [fromLeft, fromRight] = [await sides(leftward), await sides(rightward)];
    expect(fromLeft[0]).toBeGreaterThan(fromLeft[1] * 1.5);
    expect(fromRight[1]).toBeGreaterThan(fromRight[0] * 1.5);
    // With no light and no glow there is nothing there to see: the two pictures above are of the light.
    expect((await towersSeen({ ...view, material: dark })).some((byte, index) => index % 4 !== 3 && byte > 0)).toBe(false);
  }, 600_000);

  it("is not there in the tunnel, and the tunnel is not there in the fields", async () => {
    const towers = await strips(TOWER_KERNEL, FIELD_ATTRIBUTES, TOWER_CAPACITY, { travel: 300, place: 0 });
    for (let point = 0; point < TOWER_CAPACITY; point += 5) expect(towers.girth(point)).toBe(0);
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
