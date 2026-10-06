import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../points/mesh.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { HULL_SURFACE_WGSL, hullSurfaceWgsl, lampParameter } from "./surface.ts";
import { LAMPS_MIRRORED, LAMP_TONES } from "./tunnel.ts";

/**
 * T1561b — THE STEEL SHOWS THE LAMPS, on a real GPU, to the byte (§V147).
 *
 * The robot's shell has no diffuse: between two lamps it is whatever it reflects, and what it
 * reflects is the hull material's own picture of the lamps (tunnel.ts, `lampSeen`). So the
 * claim is about a pixel: a level mirror, a camera looking down on it at 45 degrees, and a
 * lamp hung exactly where that pixel's mirror ray goes. No light is in the scene and the
 * ambient is zero, so every byte in the frame is the reflection.
 *
 * The mirror is the top face of the fixture cube (y = 0.5) wearing the hull material as the
 * shell (the file's `loom_heat` 0), new from the works: Wear 0, so the steel is the clean one
 * and the arithmetic below is all of it. The frame is an odd number of pixels across, so the
 * middle pixel's ray is the camera's axis and meets the face at (0, 0.5, 0).
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const SIZE = 65;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
const GLB = encodeFixtureGlb({
  materials: [{ name: "shell", baseColor: [1, 1, 1, 1], roughness: 1, extras: { loom_heat: 0 } }],
  nodes: [{ name: "box", mesh: [cubePrimitive(0)] }],
});
const FACTS = prepareMesh(GLB, "")!.facts;
/** The same cube as an eye lens (the kit's role 1). */
const LENS_GLB = encodeFixtureGlb({
  materials: [{ name: "lens", baseColor: [1, 1, 1, 1], roughness: 1, extras: { loom_heat: 1 } }],
  nodes: [{ name: "box", mesh: [cubePrimitive(0)] }],
});

/** Where the middle pixel's ray meets the mirror, and how high above it the lamp hangs. */
const MET: readonly [number, number, number] = [0, 0.5, 0];
const HEIGHT = 2;
/** Looking down at 45 degrees, the ray leaves at 45 degrees: it crosses the lamp's height this far on. */
const OVERHEAD: readonly [number, number, number] = [MET[0], MET[1] + HEIGHT, MET[2] + HEIGHT];
/** Out of every ray's reach: below the mirror. */
const AWAY: readonly [number, number, number] = [0, -100, 0];
/** A station in the plain bore (cold), and the one every fifteenth is (alarm). */
const COLD_STATION = 30;
const ALARM_STATION = 37;

const LAMPS = 3;
const POOL = 0.05;
const GLOSS = 0.2;
const STEEL = 0.3;

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });

/** What the hull's Texture 1 is fed in these scenes: a checkerboard of two colours, `squares` to a side. */
interface Fed {
  readonly squares: number;
  readonly first: readonly [number, number, number, number];
  readonly second: readonly [number, number, number, number];
}
const PLAIN: Fed = { squares: 8, first: [0, 0, 0, 1], second: [1, 1, 1, 1] };
/** A picture as a camera gives one: RGBA rows from the top, at the size the plan gives the feed. */
type Picture = (size: readonly [number, number]) => Uint8Array;

/** `wide`: the frame's width, when it is not square (an odd number, so the middle pixel is still the camera's axis). */
async function middlePixel(overrides: Record<string, unknown> = {}, scene: { glb?: Uint8Array; fed?: Fed; picture?: Picture; wide?: number } = {}): Promise<number[]> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const lamps = Object.fromEntries(Array.from({ length: LAMPS_MIRRORED * 2 + 1 }, (_, index) => [lampParameter(index), index === LAMPS_MIRRORED ? OVERHEAD : AWAY]));
  const fed = scene.fed ?? PLAIN;
  const nodes = [
    node("mesh_cube", "meshFileIn", { vertices: FACTS.vertices, triangles: FACTS.triangles, parts: FACTS.parts }, "mesh_cube"),
    // The hull's surface names a texture (its lenses' picture), so it has one wired wherever it is used.
    // …a checkerboard, or (`picture`) a camera, which is what the piece wires there: the harness gives it the picture.
    scene.picture === undefined
      ? node("checker_feed", "checker", { size: [fed.squares, fed.squares], color1: [...fed.first], color2: [...fed.second] }, "checker_feed")
      : node("webcam_feed", "webcam", { imageFit: "stretch" }, "webcam_feed"),
    node("material_hull", "materialWgsl", { model: "pbr", source: HULL_SURFACE_WGSL, ...lamps, station: COLD_STATION, lamps: LAMPS, pool: POOL, deck: 0.2, gloss: GLOSS, steel: STEEL, wear: 0, ...overrides }, "material_hull"),
    node("geometry_mirror", "geometry", { mode: "surface", material: "material_hull" }, "geometry_mirror"),
    node("camera_above", "camera", { eye: [0, MET[1] + 2, -2], lookAt: [...MET] }, "camera_above"),
    node("render_shot", "render", { scenes: "geometry_mirror", camera: "camera_above", lights: "", ambientColor: [1, 1, 1, 1], ambientIntensity: 0 }, "render_shot"),
    node("output_frame", "output", {}, "output_frame"),
  ];
  const document = {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "mesh_cube", portId: "out" }, target: { nodeId: "geometry_mirror", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "render_shot", portId: "out" }, target: { nodeId: "output_frame", portId: "input" } },
      e3: { id: "e3", source: { nodeId: scene.picture === undefined ? "checker_feed" : "webcam_feed", portId: "out" }, target: { nodeId: "material_hull", portId: "texture1" } },
    },
    groups: {},
  } as never as GraphDocument;
  const wide = scene.wide ?? SIZE;
  const result = await renderHeadless({ host: nodeGpuHost(), graph: document, settings: { ...SETTINGS, outputResolution: { width: wide, height: SIZE } }, frames: 2, outputNodeId: "render_shot", outputPortId: "out", meshes: { mesh_cube: scene.glb ?? GLB }, ...(scene.picture === undefined ? {} : { pictures: { webcam_feed: scene.picture } }) });
  expect(result.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  const at = (Math.floor(SIZE / 2) * wide + Math.floor(wide / 2)) * 4;
  return [frame.bytes[at] ?? -1, frame.bytes[at + 1] ?? -1, frame.bytes[at + 2] ?? -1];
}

/**
 * The material's own arithmetic for that pixel. `seen` is how much of the lamp the ray
 * meets: 1 for the plate plus the pool of lit liner at that spot.
 */
function expected(tone: readonly number[], seen: number): number[] {
  // The ray runs HEIGHT up and HEIGHT along before it is at the lamp's height.
  const air = Math.exp(-Math.hypot(HEIGHT, HEIGHT) * 0.035);
  // Schlick at 45 degrees.
  const graze = (1 - Math.SQRT1_2) ** 5;
  const steel = [STEEL * 0.92, STEEL * 0.96, STEEL * 1.05];
  // A rough mirror shows less: the square of how smooth it is.
  const polish = (1 - GLOSS) ** 2;
  return tone.map((channel, index) => Math.round(Math.min(1, channel * seen * air * LAMPS * (steel[index]! + (1 - steel[index]!) * graze) * polish) * 255));
}

describe("the sentinel's steel shows the lamps (T1561b)", () => {
  it("a lamp hung on the pixel's mirror ray is seen there, in the tone of its station", async () => {
    // Dead centre of the plate: all of it, and the whole of the pool round it.
    expect(await middlePixel()).toEqual(expected(LAMP_TONES.bore, 1 + POOL));
    // The same lamp at an alarm station is red, not cold.
    expect(await middlePixel({ station: ALARM_STATION })).toEqual(expected(LAMP_TONES.alarm, 1 + POOL));
  }, 120_000);

  it("the highlight is where the lamp is: a metre aside, the pixel has only the lit liner; with no lamp radiance, nothing", async () => {
    // A metre across is past the plate's edge (0.2 m, softened by the mirror's roughness to 0.38 m).
    const aside = await middlePixel({ [lampParameter(LAMPS_MIRRORED)]: [OVERHEAD[0] + 1, OVERHEAD[1], OVERHEAD[2]] });
    expect(aside).toEqual(expected(LAMP_TONES.bore, Math.exp(-1 / 3) * POOL));
    // A lamp below the mirror is round a bend of the tunnel: not seen at all.
    expect(await middlePixel({ [lampParameter(LAMPS_MIRRORED)]: [...AWAY] })).toEqual([0, 0, 0]);
    // Cut what drives the brightness and the steel is black: there is no other light on it.
    expect(await middlePixel({ lamps: 0 })).toEqual([0, 0, 0]);
  }, 120_000);
});

/**
 * THE LENSES AS SCREENS (surface.ts, lensAt). The owner, 2026-10-06: a camera's picture "projected onto the
 * robots' eye lenses", blended with the eye lights, with an opacity mix. The claims are the wire and the mix: what
 * is fed shows in a lens as far as Eye Feed says and not at all at 0; it shows in a LENS and not in the steel
 * beside it; and it is the picture that is fed, so another picture is another pixel.
 */
describe("the sentinel's lenses show what they are fed (T1561b)", () => {
  /** One colour everywhere: whatever the lens's line jumps to and whatever part of the picture the pixel is in, it reads this. */
  const flat = (colour: readonly [number, number, number, number]): Fed => ({ squares: 1, first: colour, second: colour });
  const [WHITE, DARK, GREEN] = [flat([1, 1, 1, 1]), flat([0, 0, 0, 1]), flat([0, 1, 0, 1])];
  /** How wide the test's lens is: its face's radius, metres. */
  const FACE = 0.5;
  /**
   * The surface, told of one lens, placed so that the pixel (which looks at the cube's top, at MET) is at `across` of
   * it: 0 its middle, 1 its rim, +x the robot's left and +y up, as the surface has them.
   */
  const screen = (across: readonly [number, number] = [0, 0]): string => hullSurfaceWgsl([{ position: [MET[0] - across[0] * FACE, MET[1] - across[1] * FACE, MET[2]], face: FACE }]);
  /** A lens with its own glow up, no lamp to mirror, and nothing of the drums or the sweep in it. */
  const LENS = { lamps: 0, eyeGlow: 2, eyeHits: 0, eyeSweep: 0, hueFrom: 0, hueTo: 0 };
  const lens = (eyeFeed: number, fed: Fed, eyeGlow = LENS.eyeGlow): Promise<number[]> => middlePixel({ source: screen(), ...LENS, eyeGlow, eyeFeed }, { glb: LENS_GLB, fed });

  it("a lens shows the picture as far as Eye Feed says: none of it at 0, where it burns with its own light whatever is fed", async () => {
    const [own, ownFedDark] = [await lens(0, WHITE), await lens(0, DARK)];
    // Its own light: red (the range's hue is 0), and the same whatever is on the wire.
    expect(own[0] as number).toBeGreaterThan(40);
    expect(ownFedDark).toEqual(own);
    // All the way up, a dark picture puts the lens out and a white one lights it: it is the picture now.
    const [dark, white] = [await lens(1, DARK), await lens(1, WHITE)];
    expect(dark).toEqual([0, 0, 0]);
    expect(white[0] as number).toBeGreaterThan(60);
    // …but not as the lamp behind the glass burns: a picture's white is a share of that (surface.ts, FEED), so its greys are there to read.
    expect(white[0] as number).toBeLessThan(own[0] as number);
    // Half way is between the two.
    const half = await lens(0.5, DARK);
    expect(half[0] as number).toBeLessThan(own[0] as number);
    expect(half[0] as number).toBeGreaterThan(dark[0] as number);
  }, 240_000);

  it("it is the picture's own colour that shows, half of it, over the lens's light", async () => {
    // A green picture in a red lens: green that the lens's own light has none of. (With the glow up: a picture is dim beside a lamp.)
    const [own, green] = [await lens(0, GREEN, 6), await lens(1, GREEN, 6)];
    expect(green[1] as number).toBeGreaterThan((own[1] as number) + 30);
    // …and still more the lens's red than the picture's green: the face stays this robot's face.
    expect(green[0] as number).toBeGreaterThan(green[1] as number);
  }, 240_000);

  /**
   * WHICH PART OF THE PICTURE IS WHERE, with a camera on the wire (what the piece wires there). The first build of
   * this showed the middle half of the picture, mirrored: the kit gave each lens the half length of its barrel for
   * a radius, and the surface took the robot's +x for its right. No test saw it, because every picture above is
   * one colour.
   */
  /** The frame these are seen in, and so the camera's picture, is twice as wide as high: what beside a lens's square is there to get wrong. */
  const WIDE = SIZE * 2 - 1;
  /**
   * White where `lit` says, black elsewhere, stretched over the camera's whole picture. `lit` is asked in the
   * picture's MIDDLE SQUARE: 0 to 1 across from its left and down from its top, and below 0 or above 1 across is
   * what a wide picture has beside that square.
   */
  const painted = (lit: (across: number, down: number) => boolean, alpha = 255): Picture => ([wide, high]) => {
    const bytes = new Uint8Array(wide * high * 4);
    for (let row = 0; row < high; row += 1) {
      for (let column = 0; column < wide; column += 1) {
        const value = lit((((column + 0.5) / wide - 0.5) * WIDE) / SIZE + 0.5, (row + 0.5) / high) ? 255 : 0;
        bytes.set([value, value, value, alpha], (row * wide + column) * 4);
      }
    }
    return bytes;
  };
  const [ALL, NONE] = [painted(() => true), painted(() => false)];
  /** What the pixel is at that place of the lens, with that picture on the camera. */
  const seenAt = (across: readonly [number, number], picture: Picture, eyeFeed = 1): Promise<number[]> => middlePixel({ source: screen(across), ...LENS, eyeFeed }, { glb: LENS_GLB, picture, wide: WIDE });

  it("the picture is the right way round to whoever faces the robot, and upright", async () => {
    // The robot looks along +z with +y up, so its right hand is at -x: and that is the LEFT of whoever faces it.
    const [right, left, up, down] = [[-0.5, 0], [0.5, 0], [0, 0.5], [0, -0.5]] as const;
    // What a place of the lens is with white there, and with black: the grain and the scan lines are the place's own.
    for (const place of [right, left, up, down]) expect((await seenAt(place, ALL))[0] as number).toBeGreaterThan(((await seenAt(place, NONE))[0] as number) + 30);
    // A picture that is white on its left half only: lit on the robot's right, dark on its left.
    const leftHalf = painted((across) => across < 0.5);
    expect(await seenAt(right, leftHalf)).toEqual(await seenAt(right, ALL));
    expect(await seenAt(left, leftHalf)).toEqual(await seenAt(left, NONE));
    // White on its top half only: lit above the lens's middle, dark below.
    const topHalf = painted((_, fromTop) => fromTop < 0.5);
    expect(await seenAt(up, topHalf)).toEqual(await seenAt(up, ALL));
    expect(await seenAt(down, topHalf)).toEqual(await seenAt(down, NONE));
  }, 480_000);

  it("a lens shows ALL of the picture across its face, and a wide picture is not squeezed into it", async () => {
    // Seven tenths of the way to the rim, on the side that shows the picture's left: fifteen hundredths in from the
    // left of the picture's middle square. (A line of the picture jumps seven hundredths at most: still in that quarter.)
    const place = [-0.7, 0] as const;
    const [white, black] = [await seenAt(place, ALL), await seenAt(place, NONE)];
    expect(white[0] as number).toBeGreaterThan((black[0] as number) + 30);
    expect(await seenAt(place, painted((across) => across >= 0 && across < 0.25))).toEqual(white);
    // The quarter beside it is not there. (With the lens twice as wide as its face, it was.)
    expect(await seenAt(place, painted((across) => across >= 0.25 && across < 0.5))).toEqual(black);
    // What a wide picture has beside its middle square is in no lens: the lens is round, and shows the middle.
    // (Squeezed in whole, this place of the lens would be out there: the quarter above would be dark and this lit.)
    expect(await seenAt(place, painted((across) => across < 0 || across > 1))).toEqual(black);
  }, 480_000);

  it("a clear frame is no picture: with the camera off a lens keeps its own light, at any Eye Feed", async () => {
    const off = painted(() => true, 0);
    const own = await seenAt([0, 0], off, 0);
    expect(own[0] as number).toBeGreaterThan(40);
    expect(await seenAt([0, 0], off, 1)).toEqual(own);
    // (The same frame, opaque, is the picture: see above.)
    expect(await seenAt([0, 0], ALL, 1)).not.toEqual(own);
  }, 240_000);

  it("only a lens is a screen: the steel beside it shows nothing of the picture at any Eye Feed", async () => {
    const steel = (eyeFeed: number, fed: Fed): Promise<number[]> => middlePixel({ eyeFeed }, { fed });
    const plain = await steel(0, WHITE);
    expect(await steel(1, WHITE)).toEqual(plain);
    expect(await steel(1, DARK)).toEqual(plain);
    // (The steel's pixel is the lamp in the mirror, as the tests above have it: not black.)
    expect(plain).toEqual(expected(LAMP_TONES.bore, 1 + POOL));
  }, 240_000);
});

