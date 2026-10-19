import { beforeAll, describe, expect, it } from "vitest";

import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { decodeHalf } from "../runtime/export/pixel-format.ts";
import { renderHeadless, type RenderedFrame } from "../tests/headless/render-harness.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { listExamples } from "./catalogue.ts";
import { requireExample } from "./runner.ts";

/**
 * E89 CYMATICS — the claims are the physics, read off the simulation's own state texture.
 *
 * A picture of lit water says little about whether the water obeys anything: a noise field
 * under the same lamps looks like water too. So the first two claims read `wgsl_height`'s
 * float state (r is the surface height) and assert what a shaken dish does that a noise
 * field does not:
 *
 *  1. THE FARADAY THRESHOLD. Shaking parametrically pumps the wave at half the drive
 *     frequency, and viscosity damps it; below the threshold the surface stays at the noise
 *     floor, above it the standing wave grows by orders of magnitude. The meniscus is off,
 *     so the only way for the surface to move is the instability.
 *  2. THE NOTE SETS THE SCALE. With the shaking off and only the meniscus pumping, waves run
 *     in from the wall at the drive frequency; with surface tension off the medium has one
 *     wave speed, so an octave up halves the wavelength and doubles the crests across the
 *     dish.
 *
 * The third is the owner's baseline for the picture: nothing but the liquid is lit. The
 * fourth is the panel's promise: every slider on it reaches the picture.
 */

const FILE = "E89-Cymatics.loom.json";
const SIM = 512;

function example() {
  const file = listExamples().find((entry) => entry.fileName === FILE);
  if (file === undefined) throw new Error(`${FILE} is not shipped`);
  return requireExample(file);
}

/** The shipped graph with some parameters pinned to plain values (an expression slot becomes static). */
function withParameters(graph: GraphDocument, overrides: Readonly<Record<string, Readonly<Record<string, number>>>>): GraphDocument {
  const copy = structuredClone(graph) as GraphDocument;
  for (const [nodeId, parameters] of Object.entries(overrides)) {
    const node = copy.nodes[nodeId];
    if (node === undefined) throw new Error(`${FILE} has no node ${nodeId}`);
    Object.assign(node.parameters, parameters);
  }
  return copy;
}

async function capture(graph: GraphDocument, nodeId: string, frames: number, size = 256): Promise<RenderedFrame> {
  const { document } = example();
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...document.settings, outputResolution: { width: size, height: size } },
    frames,
    capture: [frames - 1],
    outputNodeId: nodeId,
    fps: 60,
    animate: true,
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  expect(errors, `${FILE} rendered with errors`).toEqual([]);
  const frame = result.frames[0];
  if (frame === undefined) throw new Error("no frame captured");
  return frame;
}

/** The surface heights (channel r), row-major, decoded from the rgba16float state. */
function heights(frame: RenderedFrame): Float32Array {
  expect(frame.format).toBe("rgba16float");
  expect([frame.width, frame.height]).toEqual([SIM, SIM]);
  const half = new Uint16Array(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength / 2);
  const out = new Float32Array(frame.width * frame.height);
  for (let pixel = 0; pixel < out.length; pixel += 1) out[pixel] = decodeHalf(half[pixel * 4] ?? 0);
  // Row 0's first cells are the oscillators' bookkeeping, outside the dish; they are not water.
  for (let x = 0; x < 3; x += 1) out[x] = 0;
  return out;
}

function rms(field: Float32Array): number {
  let sum = 0;
  for (const value of field) sum += value * value;
  return Math.sqrt(sum / field.length);
}

/** Sign changes of the height along the middle row, inside 80% of the radius. */
function crestsAcross(field: Float32Array): number {
  const y = SIM / 2;
  const reach = Math.floor(SIM * 0.47 * 0.8);
  let changes = 0;
  let previous = 0;
  for (let x = SIM / 2 - reach; x <= SIM / 2 + reach; x += 1) {
    const value = field[y * SIM + x] ?? 0;
    if (value !== 0 && previous !== 0 && Math.sign(value) !== Math.sign(previous)) changes += 1;
    if (value !== 0) previous = value;
  }
  return changes;
}

/** A clean single tone: no harmonics, no second tone, no sweep, no song. */
const CLEAN_TONE = { harmonic2: 0, harmonic3: 0, tone: 0 } as const;

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

describe("E89 Cymatics — the dish obeys its physics", () => {
  it(
    "the Faraday threshold: below it the shaken surface stays at the noise floor, above it a standing wave grows",
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { document } = example();
      const at = (drive: number) =>
        withParameters(document.graph, {
          wgsl_momentum: { ...CLEAN_TONE, frequency: 29.14, drive, dishSize: 1 },
          wgsl_height: { rim: 0, splash: 0, noise: 1 },
        });
      const below = rms(heights(await capture(at(0.02), "wgsl_height", 240)));
      const above = rms(heights(await capture(at(0.8), "wgsl_height", 240)));
      expect(above, `above the threshold the surface must stand up (below ${below}, above ${above})`).toBeGreaterThan(10 * below);
    },
    600_000,
  );

  it(
    "the note sets the scale: an octave up puts twice the crests across the dish",
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { document } = example();
      const at = (frequency: number) =>
        withParameters(document.graph, {
          wgsl_momentum: { ...CLEAN_TONE, frequency, drive: 0, tension: 0, dishSize: 1 },
          wgsl_height: { rim: 0.6, rimFocus: 0, splash: 0, noise: 0 },
        });
      const low = crestsAcross(heights(await capture(at(29.14), "wgsl_height", 200)));
      const high = crestsAcross(heights(await capture(at(58.27), "wgsl_height", 200)));
      expect(low, "the low note must draw a pattern at all").toBeGreaterThan(6);
      const ratio = high / low;
      expect(ratio, `crests ${low} → ${high}`).toBeGreaterThan(1.7);
      expect(ratio, `crests ${low} → ${high}`).toBeLessThan(2.3);
    },
    600_000,
  );

  it(
    "nothing but the liquid is lit: every pixel outside the dish is exactly black",
    async () => {
      if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
      const { document } = example();
      const frame = await capture(document.graph, "wgsl_surface", 120);
      const half = new Uint16Array(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength / 2);
      // Straight down from 3.7 through a 36° lens, a frame half-height covers 3.7·tan 18° of
      // ground; the liquid reaches at most 1.03 of the dish radius (the lobes). Past that, plus
      // the sub-samples' reach, nothing may be lit.
      const disc = 1.03 / (3.7 * Math.tan((18 * Math.PI) / 180));
      let lit = 0;
      let outside = 0;
      let inside = 0;
      for (let y = 0; y < frame.height; y += 1) {
        for (let x = 0; x < frame.width; x += 1) {
          const nx = ((x + 0.5) / frame.width) * 2 - 1;
          const ny = ((y + 0.5) / frame.height) * 2 - 1;
          const r = Math.hypot(nx, ny);
          const at = (y * frame.width + x) * 4;
          const sum = decodeHalf(half[at] ?? 0) + decodeHalf(half[at + 1] ?? 0) + decodeHalf(half[at + 2] ?? 0);
          if (r > disc + 0.03) {
            outside += 1;
            if (sum !== 0) lit += 1;
          } else if (r < disc * 0.8 && sum > 0.02) {
            inside += 1;
          }
        }
      }
      expect(outside).toBeGreaterThan(0);
      expect(lit, "lit pixels outside the dish").toBe(0);
      expect(inside, "the liquid itself must be lit").toBeGreaterThan(100);
    },
    600_000,
  );

  it("every slider on the panel drives something in the picture", () => {
    const { document } = example();
    const nodes = Object.values(document.graph.nodes);
    const sources = JSON.stringify(nodes.map((node) => node.parameters));
    const widgets = nodes.filter((node) => ["slider", "toggle", "button"].includes(node.type));
    expect(widgets.length).toBeGreaterThan(20);
    for (const widget of widgets) {
      const wired = Object.values(document.graph.edges).some(
        (edge) => edge.source.nodeId === widget.id && edge.target.nodeId === "panel_cymatics" && edge.target.portId === "controls",
      );
      expect(wired, `${widget.id} is on the panel`).toBe(true);
      expect(sources.includes(`op('${widget.id}')`), `${widget.id} is read by an expression`).toBe(true);
    }
  });
});
