import { beforeAll, describe, expect, it } from "vitest";
import { crucibleDocument } from "./documents/crucible.ts";
import { starterComponentsView } from "./component-files.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { pointStorageId } from "../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../nodes/definitions/test-support.ts";
import { toRgba8 } from "../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../runtime/export/pixel-format.ts";

/**
 * T1349b — E79 on Dawn: what the two lanes DO to the picture, as render differences.
 *
 * The lanes are pinned to their retained values here (no audio on the seam) and then set by
 * hand at each end of their driven range, so each claim is "this lane at 1 against this lane
 * at 0" on the same frame — the §V903 test of a drive: what differs if the edge were cut.
 * Second cut (the tunnel): the ring sits on the lens axis at frame 0, the hulls are eight
 * swarm grids, the shards two streams.
 */
let unavailable: string | undefined;
beforeAll(async () => {
  unavailable = (await probeDawn()).error;
}, 60_000);

const WIDTH = 320;
const HEIGHT = 180;

const PROBED = ["swarm0Form", "swarm5Form", "dustForm", "haloForm", "coreForm"] as const;
const FIXED = ["swarm0Form", "swarm5Form", "dustForm"] as const;

async function render(lanes: { beat?: number; tail?: number; light?: number }, probe = false) {
  const graph = structuredClone(crucibleDocument.graph);
  // Pin the lanes: every consumer of `beat1` / `tail1` reads the constant instead.
  for (const node of Object.values(graph.nodes)) {
    for (const [key, slot] of Object.entries(node.parameters)) {
      if (typeof slot !== "object" || slot === null || !("bindings" in slot)) continue;
      const expression = (slot as { bindings: { expression?: { source?: string } } }).bindings.expression?.source ?? "";
      if (lanes.beat !== undefined && (expression.includes("op('beat1')") || expression.includes("op('punch1')")) && !expression.includes("op('tail1')")) {
        node.parameters[key] = expression.startsWith("24 + ") ? (lanes.light ?? 24 + lanes.beat * 90) : lanes.beat;
      } else if (lanes.tail !== undefined && expression.includes("op('tail1')") && !expression.includes("op('beat1')")) {
        // The accent light reads `8 + tail * 50`; everything else reads the lane itself.
        node.parameters[key] = expression.startsWith("8 + ") ? 8 + lanes.tail * 50 : lanes.tail;
      }
    }
  }
  const result = await renderHeadless({
    host: nodeGpuHost(),
    components: await starterComponentsView(),
    graph,
    settings: { ...crucibleDocument.settings, outputResolution: { width: WIDTH, height: HEIGHT } },
    frames: 1,
    outputNodeId: "out",
    ...(probe ? { probeBuffers: PROBED.map((id) => pointStorageId(id)) } : {}),
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  const space = result.plan.outputs.find((o) => o.nodeId === "out")!.space;
  const pixels = toRgba8({ width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * BYTES_PER_PIXEL[frame.format] }, { space }).data;
  const positions = probe ? Object.fromEntries(PROBED.map((id) => [id, Array.from(kernelRegionSlice(graph.nodes[id]!, result.buffers![pointStorageId(id)]!, "position").floats)])) : undefined;
  return { pixels, positions };
}

/** Mean of a channel over a rectangle, in display bytes. */
function mean(pixels: Uint8ClampedArray | Uint8Array, rect: { x0: number; x1: number; y0: number; y1: number }, channel: number): number {
  let sum = 0;
  let count = 0;
  for (let y = rect.y0; y < rect.y1; y += 1) {
    for (let x = rect.x0; x < rect.x1; x += 1) {
      sum += pixels[(y * WIDTH + x) * 4 + channel]!;
      count += 1;
    }
  }
  return sum / count;
}

describe("E79 Crucible — the lanes reach the picture (T1349b)", () => {
  it("no lane moves a hull, giant or shard (the teleport the owner saw); the halo swells a little and the core is the one thing that opens", async (ctx) => {
    if (unavailable) { ctx.skip(); return; }
    // Motion is structural (absTime); the audio lights things. A lane in a position term
    // makes geometry jump on every hit — the shard stream's phase carried one and the
    // owner reported blocks teleporting on the beat. This is the regression, pinned.
    const rest = await render({ beat: 0, tail: 0 }, true);
    const hit = await render({ beat: 1, tail: 1 }, true);
    for (const id of FIXED) expect(hit.positions![id], id).toEqual(rest.positions![id]);
    // The halo is the one body a lane may touch: its tube swells 12% on the hit and 25%
    // over the tail, through the 50 ms punch — a bound, not a jump. Tube 0.12 × 37% = 0.044.
    let swell = 0;
    for (let index = 0; index < rest.positions!["haloForm"]!.length; index += 1) swell = Math.max(swell, Math.abs(hit.positions!["haloForm"]![index]! - rest.positions!["haloForm"]![index]!));
    expect(swell).toBeGreaterThan(0.02);
    expect(swell).toBeLessThan(0.05);
    // The CORE is the one body built to move with the music: the Tail lane opens its
    // fragments, the Beat lane kicks them. More than a unit of travel on the outer cells.
    let opened = 0;
    for (let index = 0; index < rest.positions!["coreForm"]!.length; index += 1) opened = Math.max(opened, Math.abs(hit.positions!["coreForm"]![index]! - rest.positions!["coreForm"]![index]!));
    expect(opened).toBeGreaterThan(1);
  }, 120_000);

  it("the beat lane at 1 makes the halo band brighter and whiter than at 0", async (ctx) => {
    if (unavailable) { ctx.skip(); return; }
    // The light is pinned at its floor in both, so this claim is the RING's emission alone;
    // the light has its own claim below (at 114 it floods the tunnel red, which would pull
    // the band's green-to-red ratio down and hide the hue move).
    const off = await render({ beat: 0, light: 24 });
    const on = await render({ beat: 1, light: 24 });
    // The ring: at frame 0 the lens sits on the axis 25.5 out, so the torus (radius 4.5)
    // is a circle of ~31 px radius about the frame's centre at 320×180.
    const ring = { x0: 110, x1: 210, y0: 50, y1: 130 };
    expect(mean(on.pixels, ring, 0)).toBeGreaterThan(mean(off.pixels, ring, 0) + 8);
    // Whiter: the green-to-red ratio rises, because ember (1, 0.12, 0.02) → hot (1, 0.78, 0.5)
    // is a hue move and not only a gain.
    expect(mean(on.pixels, ring, 1) / mean(on.pixels, ring, 0)).toBeGreaterThan(mean(off.pixels, ring, 1) / mean(off.pixels, ring, 0) + 0.1);
  }, 120_000);

  it("the halo light alone — ring emission and seams held at 0 — lights the hulls of the tunnel", async (ctx) => {
    if (unavailable) { ctx.skip(); return; }
    // The point light at the ring's centre is the lane's second destination: at the hit it
    // goes 24 → 114 and every hull face turned toward the ring catches it, across the frame.
    const dim = await render({ beat: 0, light: 24 });
    const lit = await render({ beat: 0, light: 114 });
    const whole = { x0: 0, x1: WIDTH, y0: 0, y1: HEIGHT };
    expect(mean(lit.pixels, whole, 0)).toBeGreaterThan(mean(dim.pixels, whole, 0) + 2);
  }, 120_000);

  it("the tail lane lights the strips and the green accent: more green in the frame at 1 than at 0, and byte-equal at the same value", async (ctx) => {
    if (unavailable) { ctx.skip(); return; }
    // Third cut: the tail lane no longer moves geometry (motion is structural, the tiers
    // turn on absTime); it breathes the lit strips on every hull and the green accent
    // light. So the claim is colour: the frame's green mean rises, and the green-to-red
    // ratio rises with it — the red halo light is pinned, so only the green sources moved.
    const rest = await render({ tail: 0, beat: 0 });
    const swelled = await render({ tail: 1, beat: 0 });
    const again = await render({ tail: 0, beat: 0 });
    const whole = { x0: 0, x1: WIDTH, y0: 0, y1: HEIGHT };
    expect(mean(swelled.pixels, whole, 1)).toBeGreaterThan(mean(rest.pixels, whole, 1) + 2);
    expect(mean(swelled.pixels, whole, 1) / mean(swelled.pixels, whole, 0)).toBeGreaterThan(mean(rest.pixels, whole, 1) / mean(rest.pixels, whole, 0));
    expect(Array.from(again.pixels)).toEqual(Array.from(rest.pixels));
  }, 120_000);
});
