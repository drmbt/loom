import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { edge, expressionSlot, graph, named, settings } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * §T1674b ON A REAL DEVICE — a pass that turns a pixel back into a view ray, from the
 * camera's channels, draws THE SAME PIXELS whether the rig lives on Origin and Heading or
 * the same pose is written plainly into Eye and Look At.
 *
 * This is the consumer's shape (sentinel-bot's lit air, its focus by distance): a Custom
 * WGSL takes no camera, so it reads the camera node by expression. Read through
 * `par.eye` it got the offset and the air went out; the last case here is that cut, and it
 * holds both halves of the row: the picture differs AND the compile says why.
 *
 * Compiler, backend and Dawn, the whole 64 × 64 target read back, byte for byte (§V147).
 * The frame faces +x, so every composed coordinate is a sum of the literals with no
 * rounding in it and the two cameras' channels are the same numbers exactly.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const SIZE = 64;
const SETTINGS = settings({ outputResolution: { width: SIZE, height: SIZE }, workingFormat: "rgba8unorm" });

/** A floor of unit tiles at y = 0, seen along the ray of each pixel: what a screen-space pass rebuilds. */
const FLOOR_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  seenFrom: vec3f,
  seenAhead: vec3f,
  seenRight: vec3f,
  seenUp: vec3f,
  seenFov: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let under = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let reach = tan(radians(params.seenFov) * 0.5);
  let across = (uv.x * 2.0 - 1.0) * reach;
  let above = (1.0 - uv.y * 2.0) * reach;
  let ray = normalize(params.seenAhead + params.seenRight * across + params.seenUp * above);
  // Above the horizon there is no floor: the input, which is black.
  if (ray.y > -0.001) { return vec4f(under.rgb * frameU.resolution.x * 0.0, 1.0); }
  let hit = params.seenFrom + ray * (-params.seenFrom.y / ray.y);
  let tile = floor(hit.xz);
  let odd = abs(tile.x + tile.y) % 2.0;
  return vec4f(0.25 + 0.5 * odd, fract(hit.x), fract(hit.z), 1.0);
}`;

type Read = (channel: string) => string;
/** The pose, read off the camera node as the channels give it. */
const BY_CHANNEL: Read = (channel) => `op('camera_rig').chan.${channel}`;
/** THE CUT: the eye read as `par.eye`, the way the consumer's passes read it before the frame existed. */
const EYE_BY_PARAMETER: Read = (channel) =>
  channel.startsWith("eye") ? `op('camera_rig').par.eye.${channel.slice(3).toLowerCase()}` : BY_CHANNEL(channel);

function floor(camera: Record<string, unknown>, read: Read): GraphDocument {
  const from = (field: string, part: string): Record<string, unknown> =>
    Object.fromEntries((["x", "y", "z"] as const).map((axis) => [`${field}.${axis}`, expressionSlot(read(`${part}${axis.toUpperCase()}`), 0)]));
  return graph(
    [
      named("rig", "camera", [0, 400], camera as never),
      named("black", "solid", [0, 0], { color: [0, 0, 0, 1] }),
      named(
        "floor",
        "customWgsl",
        [400, 0],
        {
          source: FLOOR_WGSL,
          ...from("seenFrom", "eye"),
          ...from("seenAhead", "forward"),
          ...from("seenRight", "right"),
          ...from("seenUp", "up"),
          seenFov: expressionSlot(read("fov"), 0),
        } as never,
      ),
      named("final", "output", [800, 0]),
    ],
    [
      edge("e1", ["solid_black", "out"], ["wgsl_floor", "input"]),
      edge("e2", ["wgsl_floor", "out"], ["output_final", "input"]),
    ],
  );
}

async function render(document: GraphDocument): Promise<{ bytes: Uint8Array; diagnostics: readonly RuntimeDiagnostic[] }> {
  const plan = compileGraph({ graph: document, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [SIZE, SIZE],
    });
    return { bytes: (await backend.readOutput("target:wgsl_floor:out")).bytes, diagnostics: plan.diagnostics };
  } finally {
    backend.dispose();
  }
}

const differing = (a: Uint8Array, b: Uint8Array): number => {
  let count = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) count += 1;
  }
  return count;
};
/** Pixels that are floor and not the black above the horizon. */
const floored = (bytes: Uint8Array): number => {
  let count = 0;
  for (let index = 0; index < bytes.length; index += 4) if (bytes[index]! > 0) count += 1;
  return count;
};
const notComposed = (diagnostics: readonly RuntimeDiagnostic[]): RuntimeDiagnostic[] =>
  diagnostics.filter((entry) => entry.code === "parameter.reference.notComposed");

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

/*
 * The rig: an offset half above and three behind, looking a little down at the frame's own
 * origin; the frame at (2, 1.25, −1) facing +x. Behind something facing +x is −x, so
 *   Eye     = (2 − 3, 1.25 + 0.5, −1) = (−1, 1.75, −1)
 *   Look At = (2, 1.25, −1)
 */
const ON_THE_FRAME = { eye: [0, 0.5, 3], lookAt: [0, 0, 0], origin: [2, 1.25, -1], heading: [1, 0, 0], fov: 50 };
const BY_HAND = { eye: [-1, 1.75, -1], lookAt: [2, 1.25, -1], fov: 50 };

describe("T1674b on a real device — a view ray rebuilt from the camera's channels", () => {
  it("⚑ the rig on Origin and Heading and the same pose written plainly draw the same pixels", async () => {
    requireDawn();
    const framed = await render(floor(ON_THE_FRAME, BY_CHANNEL));
    const byHand = await render(floor(BY_HAND, BY_CHANNEL));
    expect(differing(framed.bytes, byHand.bytes)).toBe(0);
    // Not vacuous: the floor fills a real share of the picture and the horizon is in it.
    expect(floored(framed.bytes)).toBeGreaterThan(1000);
    expect(floored(framed.bytes)).toBeLessThan(SIZE * SIZE);
    // And the channels are what a reader is told to use: nothing is said about either.
    expect(notComposed(framed.diagnostics)).toEqual([]);
    expect(notComposed(byHand.diagnostics)).toEqual([]);
  }, 120_000);

  it("⚑ cut the read back to par.eye: the picture differs, AND the compile says why and what to read", async () => {
    requireDawn();
    const framed = await render(floor(ON_THE_FRAME, BY_CHANNEL));
    const cut = await render(floor(ON_THE_FRAME, EYE_BY_PARAMETER));
    // The offset's eye is at height 0.5, not 1.75: the floor is seen from somewhere else.
    expect(differing(framed.bytes, cut.bytes)).toBeGreaterThan(1000);
    const said = notComposed(cut.diagnostics);
    expect(said.map((entry) => entry.nodeId)).toEqual(["wgsl_floor", "wgsl_floor", "wgsl_floor"]);
    expect(said.map((entry) => entry.suggestion)).toEqual([
      "Read op('camera_rig').chan.eyeX for where the camera is in the world.",
      "Read op('camera_rig').chan.eyeY for where the camera is in the world.",
      "Read op('camera_rig').chan.eyeZ for where the camera is in the world.",
    ]);
    // On a camera with no frame the same read IS the eye: the same pixels, and nothing said.
    const plain = await render(floor(BY_HAND, EYE_BY_PARAMETER));
    const plainByChannel = await render(floor(BY_HAND, BY_CHANNEL));
    expect(differing(plain.bytes, plainByChannel.bytes)).toBe(0);
    expect(notComposed(plain.diagnostics)).toEqual([]);
  }, 120_000);

  it("the channels follow Heading: turned a quarter, the floor is seen along another axis", async () => {
    requireDawn();
    const east = await render(floor(ON_THE_FRAME, BY_CHANNEL));
    const north = await render(floor({ ...ON_THE_FRAME, heading: [0, 0, 1] }, BY_CHANNEL));
    expect(differing(east.bytes, north.bytes)).toBeGreaterThan(1000);
    // Facing +z, behind is −z: Eye (2, 1.75, −4), Look At (2, 1.25, −1).
    const byHand = await render(floor({ eye: [2, 1.75, -4], lookAt: [2, 1.25, -1], fov: 50 }, BY_CHANNEL));
    expect(differing(north.bytes, byHand.bytes)).toBe(0);
  }, 120_000);
});
