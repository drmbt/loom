import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import { prepareMesh } from "../../points/mesh.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { HULL_SURFACE_WGSL, lampParameter } from "./surface.ts";
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
 * shell (the file's `loom_heat` 0). The frame is an odd number of pixels across, so the
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

async function middlePixel(overrides: Record<string, unknown> = {}): Promise<number[]> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const lamps = Object.fromEntries(Array.from({ length: LAMPS_MIRRORED * 2 + 1 }, (_, index) => [lampParameter(index), index === LAMPS_MIRRORED ? OVERHEAD : AWAY]));
  const nodes = [
    node("mesh", "meshFileIn", { vertices: FACTS.vertices, triangles: FACTS.triangles, parts: FACTS.parts }, "mesh1"),
    node("mat", "materialWgsl", { model: "pbr", source: HULL_SURFACE_WGSL, ...lamps, station: COLD_STATION, lamps: LAMPS, pool: POOL, deck: 0.2, gloss: GLOSS, steel: STEEL, ...overrides }, "mat1"),
    node("geo", "geometry", { mode: "surface", material: "mat1" }, "geo1"),
    node("cam", "camera", { eye: [0, MET[1] + 2, -2], lookAt: [...MET] }, "cam1"),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "", ambientColor: [1, 1, 1, 1], ambientIntensity: 0 }, "shot1"),
    node("out", "output", {}, "out1"),
  ];
  const document = {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "mesh", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never as GraphDocument;
  const result = await renderHeadless({ host: nodeGpuHost(), graph: document, settings: SETTINGS, frames: 2, outputNodeId: "shot", outputPortId: "out", meshes: { mesh: GLB } });
  expect(result.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message)).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  const at = (Math.floor(SIZE / 2) * SIZE + Math.floor(SIZE / 2)) * 4;
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
  return tone.map((channel, index) => Math.round(Math.min(1, channel * seen * air * LAMPS * (steel[index]! + (1 - steel[index]!) * graze) * (1 - GLOSS)) * 255));
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
