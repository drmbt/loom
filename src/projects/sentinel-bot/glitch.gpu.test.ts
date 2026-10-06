import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";
import { GLITCH_WGSL } from "./glitch.ts";

/**
 * T1561b — THE GLITCH, on a real GPU: what it does to a picture, and that at nothing it does nothing.
 *
 * It sits at the end of the piece's chain on every frame of it, and on all but a few seconds of a track its
 * amount is 0. So the first thing it owes is to be invisible there: the picture through it is the picture, to
 * the bit. Then: up, it tears bands sideways (rows of the picture are no longer their own rows), more of it the
 * further up; and it does not hold still.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const SIZE = 64;

/** A checkerboard through the glitch at `amount` (or not through it at all), at the last of `frames` frames at 60 a second: its bytes, four to a pixel. */
async function through(amount: number | null, frames = 1): Promise<Uint8Array> {
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        node("checker_board", "checker", [0, 0], { size: [8, 8] }, { label: "checker_board" }),
        ...(amount === null ? [] : [node("wgsl_glitch", "customWgsl", [0, 0], { source: GLITCH_WGSL, amount, bands: 26 }, { label: "wgsl_glitch" })]),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      amount === null ? [edge("board-out", ["checker_board", "out"], ["output_frame", "input"])] : [edge("board-glitch", ["checker_board", "out"], ["wgsl_glitch", "input"]), edge("glitch-out", ["wgsl_glitch", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: SIZE, height: SIZE }, workingFormat: "rgba8unorm" }),
    frames,
    animate: true,
    outputNodeId: amount === null ? "checker_board" : "wgsl_glitch",
    outputPortId: "out",
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame");
  return frame.bytes;
}

/** How many rows of one picture are not the same row of another. */
function rowsChanged(a: Uint8Array, b: Uint8Array): number {
  let changed = 0;
  for (let y = 0; y < SIZE; y += 1) {
    let same = true;
    for (let at = y * SIZE * 4; at < (y + 1) * SIZE * 4 && same; at += 1) same = a[at] === b[at];
    if (!same) changed += 1;
  }
  return changed;
}

describe("the sentinel's glitch (T1561b)", () => {
  it("at nothing it is not there: the picture through it is the picture, to the bit", async () => {
    const [bare, off] = [await through(null), await through(0)];
    // The board is a board: both its colours are in it.
    expect(new Set(bare.filter((_, index) => index % 4 === 0)).size).toBeGreaterThan(1);
    expect(Array.from(off)).toEqual(Array.from(bare));
  }, 120_000);

  it("up, it tears the picture's rows, more of them the further up, and never the same way two ticks running", async () => {
    const bare = await through(null);
    const [half, full] = [await through(0.5), await through(1)];
    // Rows of the picture are no longer their own rows.
    expect(rowsChanged(full, bare)).toBeGreaterThan(SIZE / 2);
    expect(rowsChanged(half, bare)).toBeGreaterThan(4);
    // Further up, more of the picture is moved: count the pixels that are not what they were.
    const moved = (bytes: Uint8Array): number => bytes.reduce((count, byte, index) => (byte !== bare[index] ? count + 1 : count), 0);
    expect(moved(full)).toBeGreaterThan(moved(half) * 1.2);
    // The colours come apart: somewhere a pixel that was grey (the board is black and white) has red and blue that differ.
    let split = 0;
    for (let at = 0; at < full.length; at += 4) if (full[at] !== full[at + 2]) split += 1;
    expect(split).toBeGreaterThan(20);
    // It does not hold still: a thirtieth of a second on (the third frame at sixty a second) it is torn another way.
    const later = await through(1, 3);
    expect(Array.from(later)).not.toEqual(Array.from(full));
    // …and the same moment is the same tear: it is drawn from the clock, not from chance.
    expect(Array.from(await through(1))).toEqual(Array.from(full));
  }, 120_000);
});
