import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { edge, graph, named, settings } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * §T1656b ON A REAL DEVICE — a camera with a parent frame draws THE SAME PIXELS as a camera
 * placed by hand at the pose the frame composes.
 *
 * `camera-frame.test.ts` holds that the view MATRIX is the same. This holds the picture:
 * compiler, backend and Dawn, the whole 64 × 64 target read back, byte for byte (§V147: an
 * exact claim, no tolerance). The hand-placed numbers are typed here, not computed by the
 * code under test: with the frame facing +x its back is −x and its right is +z, so every
 * composed coordinate is a sum of the literals below with no rounding in it.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const SIZE = 64;
const SETTINGS = settings({ outputResolution: { width: SIZE, height: SIZE }, workingFormat: "rgba8unorm" });

function shot(camera: Record<string, unknown>): GraphDocument {
  return graph(
    [
      // Boxes on a grid about the origin, lit from one side.
      named("source", "pointGrid", [0, 0], { cols: 4, rows: 3 }),
      named("boxes", "geometry", [400, 0], { mode: "instances", scale: 0.22 }),
      named("key", "light", [800, 0], { kind: "directional", direction: [-0.6, -0.5, -0.4], intensity: 1 }),
      named("rig", "camera", [0, 400], camera as never),
      named("shot", "render", [400, 400], { ambientIntensity: 0.2 }),
      named("final", "output", [800, 400]),
    ],
    [
      edge("e1", ["grid_source", "out"], ["geometry_boxes", "points"]),
      edge("e2", ["geometry_boxes", "out"], ["render_shot", "scenes"]),
      edge("e3", ["camera_rig", "out"], ["render_shot", "camera"]),
      edge("e4", ["light_key", "out"], ["render_shot", "lights"]),
      edge("e5", ["render_shot", "out"], ["output_final", "input"]),
    ],
  );
}

async function render(camera: Record<string, unknown>): Promise<Uint8Array> {
  const plan = compileGraph({ graph: shot(camera), settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
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
    return (await backend.readOutput("target:render_shot:out")).bytes;
  } finally {
    backend.dispose();
  }
}

/** How many of the picture's pixels differ at all, and how many are not the background. */
const differing = (a: Uint8Array, b: Uint8Array): number => {
  let count = 0;
  for (let index = 0; index < a.length; index += 4) {
    if (a[index] !== b[index] || a[index + 1] !== b[index + 1] || a[index + 2] !== b[index + 2] || a[index + 3] !== b[index + 3]) count += 1;
  }
  return count;
};
const drawn = (bytes: Uint8Array): number => {
  let count = 0;
  for (let index = 0; index < bytes.length; index += 4) if (bytes[index]! + bytes[index + 1]! + bytes[index + 2]! > 0) count += 1;
  return count;
};

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

describe("T1656b on a real device — Origin and Heading place the camera, to the byte", () => {
  it("⚑ a framed camera draws the same pixels as a hand-placed one at the composed pose", async () => {
    requireDawn();
    /*
     * Offset: half above and three behind, looking at the frame's own origin.
     * Frame: at (2, 0.25, −1), facing +x. Behind something facing +x is −x, so
     *   Eye     = (2 − 3, 0.25 + 0.5, −1) = (−1, 0.75, −1)
     *   Look At = (2, 0.25, −1)
     */
    const framed = await render({ eye: [0, 0.5, 3], lookAt: [0, 0, 0], origin: [2, 0.25, -1], heading: [1, 0, 0] });
    const byHand = await render({ eye: [-1, 0.75, -1], lookAt: [2, 0.25, -1] });
    expect(differing(framed, byHand)).toBe(0);
    // Not vacuous: there IS a picture (the boxes cover a real share of it)…
    expect(drawn(framed)).toBeGreaterThan(200);
    // …and it is not the picture the bare offset draws: cut the frame and it changes.
    const bare = await render({ eye: [0, 0.5, 3], lookAt: [0, 0, 0] });
    expect(differing(framed, bare)).toBeGreaterThan(200);
  }, 120_000);

  it("turning Heading turns the picture; a heading down −z is no turn at all", async () => {
    requireDawn();
    /*
     * The frame sits OFF the scene's centre, and that is the test's premise, found by its
     * first draft failing: a grid of boxes about the origin is its own image under a half
     * turn about that origin, and the Render's lambert is two-sided (|N·L|), so with the
     * frame AT the centre a heading of +x and one of −x drew the SAME BYTES. A turn about
     * any other point has nothing to hide in.
     */
    const offset = { eye: [1.2, 0.8, 3], lookAt: [0, 0, 0], origin: [0.45, 0.15, 0.3] };
    const none = await render(offset);
    // The frame already faces −z: stating it draws the same bytes as not stating it.
    expect(differing(await render({ ...offset, heading: [0, 0, -4] }), none)).toBe(0);
    // A quarter turn is another picture, and the opposite quarter turn another again.
    const left = await render({ ...offset, heading: [-1, 0, 0] });
    const right = await render({ ...offset, heading: [1, 0, 0] });
    expect(differing(left, none)).toBeGreaterThan(200);
    expect(differing(right, none)).toBeGreaterThan(200);
    expect(differing(left, right)).toBeGreaterThan(200);
    // Only the horizontal part is read: a heading that also climbs draws what the level one draws.
    expect(differing(await render({ ...offset, heading: [1, 5, 0] }), right)).toBe(0);
  }, 120_000);

  it("Origin alone carries the pose without turning it", async () => {
    requireDawn();
    const carried = await render({ eye: [1.2, 0.8, 3], lookAt: [0, 0, 0], origin: [0.5, -0.25, 1] });
    const byHand = await render({ eye: [1.7, 0.55, 4], lookAt: [0.5, -0.25, 1] });
    expect(differing(carried, byHand)).toBe(0);
    expect(drawn(carried)).toBeGreaterThan(100);
  }, 120_000);
});
