import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { srgbToLinear } from "../../domain/parameters/resolve.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { HAZE_WGSL } from "./air.ts";
import { FLOOD_TONE, floodAt } from "./dock.ts";
import { strikeAt } from "./field.ts";
import { CHAMBERS, chamberAt, pathAt } from "./path.ts";
import { BEAM_GAIN, LAMPS_MIRRORED, LAMP_HANGS, LAMP_TONES, lampParameter } from "./tunnel.ts";

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
async function middlePixel(eye: Vec, aim: Vec, plate: Vec, overrides: Record<string, number | number[]> = {}): Promise<number[]> {
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

/**
 * THE FIELDS' AIR (air.ts, fieldAir): thin, with mist lying low, and lightning in it.
 *
 * The owner, 2026-10-06, of the fields without it: "a bit lost on the bottom. maybe needs some haze or fog down
 * there." The claims are what the mist is FOR: a view down into it is closed and a view up out of it is open;
 * lightning lights the air where it struck and not elsewhere; and with no air at all the pass adds nothing.
 * The mist's top is in billows, so what a closed view holds is not one number: it is the mist's own colour
 * somewhere in the range the billows give it, and the bounds here are that range.
 */
describe("the fields' air: mist low down, and lightning in it (T1561b)", () => {
  /** The air's colour as the parameter is written: four numbers, encoded. The pass is handed it linear. */
  const AIR = [0.2, 0.4, 0.6];
  /** On the line, a hundred metres along: the height the robots fly at. */
  const Z = 100;
  const ON_THE_LINE: Vec = [pathAt(Z)[0], pathAt(Z)[1], Z];
  const down: Vec = [ON_THE_LINE[0], ON_THE_LINE[1] - 100, ON_THE_LINE[2] + 30];
  const up: Vec = [ON_THE_LINE[0], ON_THE_LINE[1] + 100, ON_THE_LINE[2] + 30];
  /** The fields with nothing lit but the air itself: no lamp, no pods' light, no lightning. */
  const fields = { place: 1, lamp: 0, color: [...AIR, 1], podColor: [0, 0, 0, 1], flash: 0, travel: 0, strike: 0 };

  it("a view down into the mist is closed by it, a view up out of it is nearly open, and with no mist both are", async () => {
    const [closed, open] = [await middlePixel(ON_THE_LINE, down, AWAY, { ...fields, mist: 1 }), await middlePixel(ON_THE_LINE, up, AWAY, { ...fields, mist: 1 })];
    // Closed: the pixel is the mist's own colour, between its darkest (0.4 of the air's) and its brightest (2.7).
    for (const [channel, written] of AIR.entries()) {
      const air = srgbToLinear(written);
      expect([channel, (closed[channel] as number) >= Math.floor(0.4 * air * 255)]).toEqual([channel, true]);
      expect([channel, (closed[channel] as number) <= Math.ceil(Math.min(1, 2.7 * air) * 255)]).toEqual([channel, true]);
    }
    // Open: the mist's top is FIELD.mistTop below the line and it thins by e every FIELD.mistFade metres up, so a ray going up crosses next to none of it.
    expect(open[2] as number).toBeLessThan((closed[2] as number) / 4);
    // Cut the mist and nothing closes either view: the pass adds nothing to an empty frame.
    expect(await middlePixel(ON_THE_LINE, down, AWAY, { ...fields, mist: 0 })).toEqual([0, 0, 0]);
    expect(await middlePixel(ON_THE_LINE, up, AWAY, { ...fields, mist: 0 })).toEqual([0, 0, 0]);
    // …and in the tunnel there is no mist to look down into, whatever the slider says.
    expect(await middlePixel(ON_THE_LINE, down, AWAY, { ...fields, place: 0, mist: 1 })).toEqual([0, 0, 0]);
  }, 240_000);

  it("lightning lights the air where it struck: a lens held on the strike sees it, and sees nothing of a strike that is somewhere else", async () => {
    const [strike, travel] = [2, 300];
    const ruled = strikeAt(strike, travel);
    const middle = ruled.start.map((part, axis) => (part + (ruled.end[axis] as number)) / 2) as [number, number, number];
    // Thirty metres off, level with it, looking past it twelve metres over its middle (straight at it the air is
    // white); no mist, so only the strike's own glow is there to see.
    const eye: Vec = [middle[0], middle[1], middle[2] - 30];
    const past: Vec = [middle[0], middle[1] + 12, middle[2]];
    const at = { ...fields, mist: 0, color: [0, 0, 0, 1], travel };
    const lit = await middlePixel(eye, past, AWAY, { ...at, strike, flash: 1 });
    expect(lit[2] as number).toBeGreaterThan(15);
    // Cold light: more blue in it than red.
    expect(lit[2] as number).toBeGreaterThan(lit[0] as number);
    // Cut the flash, and the air is dark.
    expect(await middlePixel(eye, past, AWAY, { ...at, strike, flash: 0 })).toEqual([0, 0, 0]);
    // Another strike is in another place: this lens sees a small part of its glow. (The first after it that is a
    // hundred metres or more from this one: lit air falls off slowly, as one over the distance a ray passes at.)
    const far = Array.from({ length: 40 }, (_, index) => strike + 1 + index).find((number) => {
      const there = strikeAt(number, travel);
      return Math.hypot(...there.start.map((part, axis) => (part + (there.end[axis] as number)) / 2 - (middle[axis] as number))) > 100;
    });
    if (far === undefined) throw new Error("no strike of the next forty is a hundred metres from this one");
    const other = await middlePixel(eye, past, AWAY, { ...at, strike: far, flash: 1 });
    expect(other[2] as number).toBeLessThan((lit[2] as number) / 4);
  }, 240_000);
});

/**
 * THE DOCK'S AIR (air.ts, lampNow): the lamps the pass is handed there are the crown's floods, and the lit air
 * under one is that flood's, cold white, whatever tone the tunnel's lamp of that number has; a dead flood lights
 * none. The beam's shape is the tunnel's own (a plate shining down), proved above.
 */
describe("the dock's air: a cone under every flood that burns (T1561b)", () => {
  const EYE: Vec = [0, 0, 0];
  const AHEAD: Vec = [0, 0, 1];
  const over: Vec = [0, 2, 5];
  /** A rib whose flood burns and one whose flood is dead, by the dock's own lot. */
  const ribs = Array.from({ length: 40 }, (_, rib) => rib);
  const [burning, dead] = [ribs.find((rib) => floodAt(rib).burns), ribs.find((rib) => !floodAt(rib).burns)];

  it("in the dock the lit air is the flood's, cold white, and a dead flood's is none; out of it, the tunnel's lamp's as before", async () => {
    if (burning === undefined || dead === undefined) throw new Error("the first forty ribs hold no burning flood, or no dead one");
    const beamed = beam(EYE, AHEAD, over);
    const lit = await middlePixel(EYE, AHEAD, over, { dock: 1, station: burning });
    // The flood's own colour times the beam: no hall's swell in it, no tunnel tone.
    expect(lit).toEqual(FLOOD_TONE.map((channel) => Math.round(Math.min(1, channel * LAMP * BEAM_GAIN * beamed) * 255)));
    // Cold: more blue in it than red, where the tunnel's lamp at that number is whatever its plate is.
    expect(lit[2] as number).toBeGreaterThan(lit[0] as number);
    // A dead flood: dark air under it.
    expect(await middlePixel(EYE, AHEAD, over, { dock: 1, station: dead })).toEqual([0, 0, 0]);
    // The same two numbers with the dock off are tunnel stations, and the cold station's lamp is the tunnel's own.
    expect(await middlePixel(EYE, AHEAD, over, { dock: 0 })).toEqual(expected(EYE, AHEAD, over));
    // The chase is the tunnel's: in the dock it moves nothing.
    expect(await middlePixel(EYE, AHEAD, over, { dock: 1, station: burning, chaseAt: 3.3, chase: 1 })).toEqual(lit);
  }, 240_000);
});

