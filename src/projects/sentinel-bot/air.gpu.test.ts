import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { CHAMBERS, chamberAt } from "./path.ts";
import { BEAM_GAIN, HAZE_WGSL, LAMPS_MIRRORED, LAMP_HANGS, LAMP_TONES, lampParameter } from "./tunnel.ts";

/**
 * T1561b — THE LIT AIR HANGS FROM THE LAMP'S PLATE, on a real GPU.
 *
 * A lamp is a plate in the crown that shines down, so the air it lights is a cone under the plate
 * and nothing above it. The owner, 2026-10-06, of the version that lit the air as a bare point
 * would: "this volumetric light as a sphere … it's not a cone from the actual light source down,
 * but it's just like this random sphere". So the claims are about SHAPE, each read from the pixel
 * the pass writes: a ray passing under the plate picks up the beam's own integral, a ray passing
 * the same distance over it picks up nothing, and a ray passing beside it picks up far less than
 * one passing straight under.
 *
 * What a pixel should hold is not the shader's closed form written out again: it is the
 * definition (the cube of the cosine off straight down, over the distance squared, summed along
 * the ray) added up in small steps in float64.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

type Vec = readonly [number, number, number];
/** Odd, so the middle pixel's ray is the camera's own axis. */
const SIZE = 65;
const FAR = 240;
/** A station in the plain bore whose plate is whole (tunnel.ts, LAMP_GAINS). */
const COLD_STATION = 30;
const LAMP = 1.4;
/** Out of the beam of every ray these cameras cast: far under them, where a plate lights nothing above itself. */
const AWAY: Vec = [0, -500, 0];

/** The middle pixel of the air pass over an empty frame: only what the one lamp's plate at `plate` lights. */
async function middlePixel(eye: Vec, aim: Vec, plate: Vec, overrides: Record<string, number> = {}): Promise<number[]> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  // The pass is handed where the LIGHT hangs, which is under its plate.
  const hung: Vec = [plate[0], plate[1] - LAMP_HANGS, plate[2]];
  const lamps = Object.fromEntries(Array.from({ length: LAMPS_MIRRORED * 2 + 1 }, (_, index) => [lampParameter(index), [...(index === LAMPS_MIRRORED ? hung : AWAY)]]));
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        // A Render must draw something: a few points at the origin, and its camera turned away from them, so
        // the frame is black and its depth holds no surface. (The air pass has its own eye and aim.)
        node("grid_unseen", "pointGrid", [0, 0], { cols: 2, rows: 2, count: 4, sizeX: 1, sizeY: 1 }),
        node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
        node("geometry_unseen", "geometry", [0, 0], { mode: "points", material: "material_dot" }, { label: "geometry_unseen" }),
        node("camera_away", "camera", [0, 0], { eye: [0, 0, -50], lookAt: [0, 0, -100] }, { label: "camera_away" }),
        node("render_empty", "render", [0, 0], { scenes: "geometry_unseen", camera: "camera_away", lights: "", depthOutput: true }, { label: "render_empty" }),
        node("wgsl_haze", "customWgslMulti", [0, 0], { source: HAZE_WGSL, eye: [...eye], aim: [...aim], fov: 55, far: FAR, roll: 0, density: 0, color: [0, 0, 0], glow: 1, ...lamps, station: COLD_STATION, lamp: LAMP, eyes: 0, ...overrides }, { label: "wgsl_haze" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [edge("grid-geo", ["grid_unseen", "out"], ["geometry_unseen", "points"]), edge("lit-haze", ["render_empty", "out"], ["wgsl_haze", "input"]), edge("depth-haze", ["render_empty", "depth"], ["wgsl_haze", "more"], 0), edge("haze-out", ["wgsl_haze", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: SIZE, height: SIZE }, workingFormat: "rgba8unorm" }),
    frames: 2,
    outputNodeId: "wgsl_haze",
    outputPortId: "out",
  });
  expect(result.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  const at = (Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2)) * 4;
  return [frame.bytes[at] ?? -1, frame.bytes[at + 1] ?? -1, frame.bytes[at + 2] ?? -1];
}

/** The definition, added up: the lit air a ray from `eye` toward `aim` picks up from a plate, per unit of its light. */
function beam(eye: Vec, aim: Vec, plate: Vec): number {
  const toward = [aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]];
  const length = Math.hypot(toward[0]!, toward[1]!, toward[2]!);
  const ray = toward.map((part) => part / length);
  const STEPS = 2_000_000;
  const step = FAR / STEPS;
  let sum = 0;
  for (let index = 0; index < STEPS; index += 1) {
    const t = (index + 0.5) * step;
    const from = [eye[0] + ray[0]! * t - plate[0], eye[1] + ray[1]! * t - plate[1], eye[2] + ray[2]! * t - plate[2]];
    const distance = Math.hypot(from[0]!, from[1]!, from[2]!);
    // Straight down from the plate is cosine 1; level with it or above, nothing.
    const cosine = Math.max(-from[1]! / distance, 0);
    sum += (cosine ** 3 / distance ** 2) * step;
  }
  return sum;
}

function expected(eye: Vec, aim: Vec, plate: Vec): number[] {
  // A hall's lamp is the bigger lamp (tunnel.ts, hallLamp); the pass reads that off where the light hangs.
  const hall = 1 + CHAMBERS.swell * chamberAt(plate[2]);
  return LAMP_TONES.bore.map((channel) => Math.round(Math.min(1, channel * LAMP * hall * BEAM_GAIN * beam(eye, aim, plate)) * 255));
}

describe("the sentinel's lit air hangs from the lamp's plate (T1561b)", () => {
  const EYE: Vec = [0, 0, 0];
  const AHEAD: Vec = [0, 0, 1];

  it("a level ray passing under a plate picks up its beam; passing over it, nothing", async () => {
    const over: Vec = [0, 2, 5];
    const under: Vec = [0, -2, 5];
    const lit = await middlePixel(EYE, AHEAD, over);
    expect(lit).toEqual(expected(EYE, AHEAD, over));
    // A bare point lit the air the same either side of itself: a ball. A plate lights none of the air above it.
    expect(await middlePixel(EYE, AHEAD, under)).toEqual([0, 0, 0]);
    // Cut what drives it and the air is dark: nothing else in the pass lights it.
    expect(await middlePixel(EYE, AHEAD, over, { lamp: 0 })).toEqual([0, 0, 0]);
  }, 120_000);

  it("the beam is a cone: beside the plate at the same distance the air is far dimmer than straight under it", async () => {
    // Two metres from the plate both times: straight under it, and 60 degrees round to the side (a metre under).
    const straight: Vec = [0, 2, 5];
    const aside: Vec = [Math.sqrt(3), 1, 5];
    const [under, beside] = [await middlePixel(EYE, AHEAD, straight), await middlePixel(EYE, AHEAD, aside)];
    expect(beside).toEqual(expected(EYE, AHEAD, aside));
    // The cube of the cosine of 60 degrees is an eighth; the ray's own length along the beam makes it a little more.
    expect((beside[1] as number) / (under[1] as number)).toBeLessThan(0.25);
    expect(beside[1] as number).toBeGreaterThan(0);
  }, 120_000);

  it("a ray that comes down through the plate's height is lit only from there on, and one that climbs out of it only up to there", async () => {
    // From three metres over the plate's height, down through it beside the plate.
    const high: Vec = [0, 5, 0];
    const plate: Vec = [1, 2, 4];
    const down: Vec = [0, 0, 6];
    expect(await middlePixel(high, down, plate)).toEqual(expected(high, down, plate));
    // From under it, climbing out past it.
    const low: Vec = [0, 0, 0];
    const up: Vec = [0, 5, 7];
    expect(await middlePixel(low, up, plate)).toEqual(expected(low, up, plate));
  }, 120_000);
});
