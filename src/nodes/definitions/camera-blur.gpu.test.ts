import { beforeAll, describe, expect, it } from "vitest";

import { stopsFinalRender } from "../../domain/diagnostics/classes.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { decodeComponents } from "../../tests/headless/pixel-compare.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";

/**
 * Camera Blur on a real device (T1421b, §V147).
 *
 * The picture is a short vertical line one pixel wide at the frame's centre column; the
 * Camera it names moves by expressions of `abstime`, and the node smears the line by the
 * camera's motion over the shutter. Every length is derived, not tuned: a camera at the
 * origin turning at ω rad/s moves a point at infinity at the frame centre by
 * ω / (2 · tan(fov/2) · aspect) of the frame width a second, so a 180° shutter at 24 fps
 * smears the line over W · 0.5 / 24 · ω / (2 · tan 30° · 2) pixels. Checked where the smear
 * must be (lit), where it must not be (the input exactly), that the line's energy is kept, and
 * that the smear is horizontal only. The whip turns 40° a frame, where a frame-to-frame
 * difference would reproject from 40° away: the smear is the LINEARISED length. And a cut
 * inside the node's millisecond is stepped over: the frame after it is the picture, untouched.
 */

const W = 256;
const H = 128;
const FPS = 24;
const TAN_HALF = Math.tan(Math.PI / 6);
const ASPECT = W / H;
const CENTRE = W / 2;
const ROWS = { from: 56, to: 72 };

const settings: ProjectSettings = {
  outputResolution: { width: W, height: H },
  workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const LINE = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = floor(uv * vec2f(textureDimensions(inputTexture)));
  let lit = p.x == ${CENTRE}.0 && p.y >= ${ROWS.from}.0 && p.y < ${ROWS.to}.0;
  return select(vec4f(0.0, 0.0, 0.0, 1.0), vec4f(1.0), lit);
}`;

/** A constant depth of `z` world units under a far plane of 100: R = z / far. */
const depthAt = (z: number): string => `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return vec4f(${(z / 100).toFixed(6)}, 0.0, 0.0, 1.0);
}`;

function node(id: string, type: string, parameters: Record<string, StoredParameter>, label?: string): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }) } as GraphNode;
}

function graph(camera: Record<string, StoredParameter>, blur: Record<string, StoredParameter> = {}, depth?: number): GraphDocument {
  const nodes: Record<string, GraphNode> = {
    seed: node("seed", "solid", { color: [0, 0, 0, 1] }),
    fix: node("fix", "customWgsl", { source: LINE }),
    cam: node("cam", "camera", { eye: [0, 0, 0], lookAt: [0, 0, -10], fov: 60, ...camera }, "cam1"),
    fx: node("fx", "cameraBlur", { camera: "cam1", shutter: 0.5, maxBlur: 4, ...blur }),
    out: node("out", "output", {}),
  };
  const edges: GraphDocument["edges"] = {
    e1: { id: "e1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "fix", portId: "input" } },
    e2: { id: "e2", source: { nodeId: "fix", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
    e3: { id: "e3", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  if (depth !== undefined) {
    nodes["deep"] = node("deep", "customWgsl", { source: depthAt(depth) });
    edges["d1"] = { id: "d1", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "deep", portId: "input" } };
    edges["d2"] = { id: "d2", source: { nodeId: "deep", portId: "out" }, target: { nodeId: "fx", portId: "depth" } };
  }
  return { revision: 1, nodes, edges, groups: {} };
}

/** A yaw of `yaw` radians (an expression of abstime) about +y from looking down -z. */
const turning = (yaw: string): Record<string, StoredParameter> => ({
  "lookAt.x": expressionSlot(`sin(${yaw}) * 10`, 0),
  "lookAt.z": expressionSlot(`-cos(${yaw}) * 10`, -10),
});

async function render(document: GraphDocument, frame = 6): Promise<(x: number, y: number) => number> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: document,
    settings,
    fps: FPS,
    frames: frame + 1,
    capture: [frame],
    outputNodeId: "fx",
    animate: true,
  });
  // §T1641b: by class, not by code. No error, nothing that can never take effect, nothing waiting.
  expect(result.diagnostics.filter(stopsFinalRender)).toEqual([]);
  const out = result.frames[0]!;
  const pixels = decodeComponents(out.bytes, out.format);
  return (x, y) => pixels[(y * W + x) * 4]!;
}

/** The smear length in pixels a turn of ω rad/s gives at the centre, 180° at 24 fps. */
const smearOfTurn = (omega: number): number => (W * 0.5 * omega) / FPS / (2 * TAN_HALF * ASPECT);

/**
 * `length` is the smear at the centre. A TURN moves a pixel off the axis faster, by
 * 1 + tan²φ at its view angle φ (d(x/z)/dθ), and each pixel gathers along its own motion, so
 * its reach is scaled by that; a sideways TRAVEL past a flat wall moves every pixel alike.
 */
function expectSmear(at: (x: number, y: number) => number, length: number, turn: boolean): void {
  for (let y = ROWS.from; y < ROWS.to; y += 1) {
    let sum = 0;
    for (let x = 0; x < W; x += 1) {
      const value = at(x, y);
      sum += value;
      const tanPhi = (((x + 0.5) / W) * 2 - 1) * TAN_HALF * ASPECT;
      const half = (length / 2) * (turn ? 1 + tanPhi * tanPhi : 1);
      const d = Math.abs(x + 0.5 - (CENTRE + 0.5));
      if (d <= half - 1.5) expect(value, `row ${y}: ${x} is inside the smear`).toBeGreaterThan(0);
      if (d >= half + 1.5) expect(value, `row ${y}: ${x} is past the smear`).toBe(0);
    }
    // The line's energy (one pixel of 1.0) is spread, not lost or made. 32 samples a pixel,
    // jittered per pixel: exact while they sit within the tent of a bilinear read of each other
    // (a smear under 32 px), within 5% where a longer smear spaces them wider than the line.
    expect(Math.abs(sum - 1), `row ${y}: energy ${sum}`).toBeLessThan(length <= 32 ? 0.02 : 0.05);
  }
  // Horizontal only: the rows above and below the line stay black at every column.
  for (const y of [ROWS.from - 2, ROWS.to + 1]) for (let x = 0; x < W; x += 1) expect(at(x, y), `row ${y}: ${x}`).toBe(0);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);
const requireDawn = (): void => {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
};

describe("Camera Blur on a real device (T1421b)", () => {
  it("a pan smears the picture sideways over exactly the shutter's share of the turn", async () => {
    requireDawn();
    const at = await render(graph(turning("abstime * 4")));
    expectSmear(at, smearOfTurn(4), true);
    // Not vacuous: a still camera leaves the line a line.
    const still = await render(graph({}));
    expect(still(CENTRE, 64)).toBe(1);
    expect(still(CENTRE + 2, 64)).toBe(0);
  }, 60_000);

  it("a whip at 40° a frame smears along its instantaneous turn: the linearised length", async () => {
    requireDawn();
    const omega = ((40 * Math.PI) / 180) * FPS;
    expectSmear(await render(graph(turning(`abstime * ${omega}`))), smearOfTurn(omega), true);
  }, 60_000);

  it("steps over a cut inside its millisecond: the frame after the cut is the picture, untouched", async () => {
    requireDawn();
    // Frame 6 is at 0.25 s; the cut is 0.4 ms before it, inside the derivative's reach behind.
    const cut = await render(graph(turning(`(abstime > 0.2496) * 0.5`)));
    for (let x = 0; x < W; x += 1) expect(cut(x, 64), `${x}`).toBe(x === CENTRE ? 1 : 0);
  }, 60_000);

  it("a travelling camera blurs by the Depth input's distance, and not at all at infinity", async () => {
    requireDawn();
    const truck: Record<string, StoredParameter> = {
      "eye.x": expressionSlot("abstime * 20", 0),
      "lookAt.x": expressionSlot("abstime * 20", 0),
    };
    // 20 m/s sideways past a wall 5 m away: 20 / 5 rad/s of apparent turn at the centre.
    expectSmear(await render(graph(truck, {}, 5)), smearOfTurn(20 / 5), false);
    // Unwired, every pixel is a point at infinity, which a camera's travel does not move.
    const far = await render(graph(truck));
    for (let x = 0; x < W; x += 1) expect(far(x, 64), `${x}`).toBe(x === CENTRE ? 1 : 0);
  }, 60_000);

  /*
   * §T1656b: the camera's path is its WORLD path. Origin and Heading are composed into the
   * pose before the two samples either side of the frame are taken, so a camera CARRIED by
   * its Origin, or TURNED by its Heading, blurs exactly as one whose Eye and Look At do the
   * moving, with Eye and Look At themselves standing still.
   */
  it("a camera carried by its Origin blurs as one whose Eye and Look At travel (T1656b)", async () => {
    requireDawn();
    // The travelling case above, with the travel moved to Origin: 20 m/s past a wall 5 m away.
    const carried: Record<string, StoredParameter> = { "origin.x": expressionSlot("abstime * 20", 0) };
    expectSmear(await render(graph(carried, {}, 5)), smearOfTurn(20 / 5), false);
    // Not vacuous: at infinity the same carried camera leaves the line a line.
    const far = await render(graph(carried));
    for (let x = 0; x < W; x += 1) expect(far(x, 64), `${x}`).toBe(x === CENTRE ? 1 : 0);
  }, 60_000);

  it("a camera turned by its Heading pans as one whose Look At turns (T1656b)", async () => {
    requireDawn();
    // The pan above, with the turn moved to Heading. The frame's forward is its −z, so a
    // heading of (sin θ, 0, −cos θ) turns the unmoved camera by θ: 4 rad/s, as there.
    const turned: Record<string, StoredParameter> = {
      "heading.x": expressionSlot("sin(abstime * 4)", 0),
      "heading.z": expressionSlot("-cos(abstime * 4)", -1),
    };
    expectSmear(await render(graph(turned)), smearOfTurn(4), true);
  }, 60_000);
});
