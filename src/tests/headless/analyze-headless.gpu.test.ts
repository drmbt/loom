import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { toRgba8 } from "../../runtime/export/image.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * T655 — AN ANALYZE-DRIVEN PARAMETER MOVES OFFLINE, WITH THE ONE-FRAME LATENCY ASSERTABLE.
 *
 * Before this gate the harness never built an analyze channel store, so every offline
 * render of an analyze-driven document ran on fallbacks and reported green — the fourth
 * reader-that-cannot-see (T630, T633, T650). §V461 applies both ways: the fixture must
 * tell "the measurement crossed" from "the fallback stood in", which is why the
 * fallback and the measured value are DIFFERENT numbers and both frames are captured.
 *
 * The chain is §V144's loop shape end to end: image → analyze (GPU reduction) →
 * channelIn (T654's crossing) → valueMath → driven parameter → image. Frame 0 renders
 * before any readback has landed — the picture it shows is the FALLBACK, which is the
 * §V144 latency contract made visible rather than a bug. Frame 3 shows the measurement.
 */

const SIZE = 32;

function analyzeDoc(): GraphDocument {
  const node = (id: string, type: string, extra: Record<string, unknown> = {}) =>
    ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...extra }) as never;
  return {
    revision: 1,
    groups: {},
    nodes: {
      // White is the one swatch whose display→linear decode is exact (1 → 1), so the
      // reduction is 1.0 to the bit and the arithmetic below has no transfer curve in it.
      white: node("white", "solid", { parameters: { color: [1, 1, 1, 1] } }),
      // §V129: the analyze node's NAME is the channel.
      meter: node("meter", "analyze", {
        label: "meter1",
        parameters: { channel: "luminance", operation: "average" },
      }),
      // T654: the crossing. Fallback 0.1 is deliberately far from the measured 1.0.
      gain: node("gain", "channelIn", {
        label: "gain1",
        parameters: { channel: "meter1", fallback: 0.1 },
      }),
      half: node("half", "valueMath", {
        label: "half1",
        parameters: { operation: "multiply", operand: 0.35 },
      }),
      subject: node("subject", "solid", { parameters: { color: [1, 1, 1, 1] } }),
      level: node("level", "level", {
        parameters: {
          brightness: { mode: "driven", bindings: { driven: { kind: "driven", channel: "half1" } } },
        },
      }),
      out: node("out", "output", {}),
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "white", portId: "out" }, target: { nodeId: "meter", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "gain", portId: "out" }, target: { nodeId: "half", portId: "a" } },
      e3: { id: "e3", source: { nodeId: "subject", portId: "out" }, target: { nodeId: "level", portId: "input" } },
      e4: { id: "e4", source: { nodeId: "level", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  } as never;
}

const SETTINGS = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65_535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

/** The display encode the output applies, replicated so expectations are derived, not dialed. */
function displayByte(linear: number): number {
  const encoded = linear <= 0.003_130_8 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055;
  return Math.round(encoded * 255);
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

async function centerBytes() {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: analyzeDoc(),
    settings: SETTINGS,
    frames: 4,
    capture: [0, 3],
    animate: true,
  });
  const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
  return result.frames.map((frame) => {
    const rgba = toRgba8(
      { width: frame.width, height: frame.height, format: frame.format, rowStride: frame.bytes.length / frame.height, bytes: frame.bytes } as never,
      { space } as never,
    ).data;
    const offset = ((SIZE / 2) * SIZE + SIZE / 2) * 4;
    return rgba[offset] ?? -1;
  });
}

describe("T655 — the harness reads analyze channels (§V144 offline)", () => {
  it("frame 0 shows the FALLBACK, frame 3 the measurement — the latency is the contract", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const [first, settled] = await centerBytes();

    // Frame 0: no readback has landed yet, so channelIn answers its fallback:
    // brightness = 0.1 × 0.35 = 0.035 of white. ±1 byte for the f16 round trip.
    expect(Math.abs((first ?? -1) - displayByte(0.1 * 0.35))).toBeLessThanOrEqual(1);

    // Frame 3: the reduction of a white frame is exactly 1.0, and it crossed —
    // analyze → channelIn → valueMath → brightness = 1.0 × 0.35.
    expect(Math.abs((settled ?? -1) - displayByte(0.35))).toBeLessThanOrEqual(1);

    // §V461's two-sided read, stated flat: the two frames DIFFER, so a harness whose
    // seam silently died would redden here even if both assertions above drifted.
    expect(first).not.toBe(settled);
  }, 120_000);

  it("is deterministic: the same run twice, byte-identical (§V44/§V45)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    expect(await centerBytes()).toEqual(await centerBytes());
  }, 120_000);
});

/**
 * T1530b — THE HARNESS RESOLVES OPERATION AT EACH FRAME IT RENDERS.
 *
 * `analyzeChannelEntries` resolves Operation at no frame, and the harness tracked those
 * entries once, so an expression on Operation that moves with time was read at the zero
 * frame for the whole render (live, `useAnalyzeChannels` re-resolves it per frame). The
 * meter reads an 8×8 black/white checker — average 0.5, maximum 1.0, both exact — and its
 * Operation is `(frame >= 3) * 2`: Average (index 0) until frame 3, then Maximum (index 2).
 * Frame 2 shows frame 1's average; frame 5 shows frame 4's maximum. Read at the zero frame
 * it would still be the average.
 */
describe("T1530b — the harness reads Analyze's Operation at the frame it renders", () => {
  it("frame 2 shows the average (0.5 × 0.35), frame 5 the maximum (1.0 × 0.35)", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const doc = analyzeDoc() as unknown as { nodes: Record<string, { type: string; parameters: Record<string, unknown> }> };
    doc.nodes["white"] = { ...doc.nodes["white"]!, type: "checker", parameters: { size: [8, 8] } };
    doc.nodes["meter"]!.parameters = {
      channel: "luminance",
      operation: {
        mode: "expression",
        bindings: {
          static: { kind: "static", value: "average" },
          expression: { kind: "expression", source: "(frame >= 3) * 2" },
        },
      },
    };
    const result = await renderHeadless({
      host: nodeGpuHost(),
      graph: doc as unknown as GraphDocument,
      settings: SETTINGS,
      frames: 6,
      capture: [2, 5],
      animate: true,
    });
    const space = result.plan.outputs.find((o) => o.resourceId === result.outputResourceId)?.space ?? "display";
    const [averaged, maximum] = result.frames.map((frame) => {
      const rgba = toRgba8(
        { width: frame.width, height: frame.height, format: frame.format, rowStride: frame.bytes.length / frame.height, bytes: frame.bytes } as never,
        { space } as never,
      ).data;
      return rgba[((SIZE / 2) * SIZE + SIZE / 2) * 4] ?? -1;
    });
    expect(Math.abs((averaged ?? -1) - displayByte(0.5 * 0.35))).toBeLessThanOrEqual(1);
    expect(Math.abs((maximum ?? -1) - displayByte(1 * 0.35))).toBeLessThanOrEqual(1);
  }, 120_000);
});
