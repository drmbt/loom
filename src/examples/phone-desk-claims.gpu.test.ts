import { beforeAll, describe, expect, it } from "vitest";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { BackendCapabilities } from "../domain/types/backend.ts";
import { compileGraph } from "../compiler/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { CONTROL_WIDGET_TYPES, PANEL_INPUT, boardRectsOverlap, controlChannel, panelBoard, panelLayout, panelMembers, parsePanelBoard } from "../nodes/definitions/controls.ts";
import { incomingEdgesInOrder } from "../domain/graph/edge-order.ts";
import { ANNOTATE_TYPE } from "../nodes/definitions/annotate.ts";
import { DEVICE_HELPER_PHONE_COMMAND } from "../devices/helper.ts";
import { phoneDeskDocument } from "./documents/phone-desk.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../tests/headless/render-harness.ts";
import { decodeHalf } from "../tests/headless/pixel-compare.ts";

/**
 * E81 — Phone Desk on Dawn: every control is WIRED, asserted from pixels.
 *
 * Each claim renders the shipped graph with one widget moved — the way a hand or a phone
 * moves it, by writing the widget node's own parameters — through the real value graph
 * (`animate: true`: the widget evaluates, `op('<widget>').chan.<ch>` resolves, the animator
 * pushes the uniform). So what is asserted is what differs if the mapping expression were cut:
 * with no wire from the widget, every variant below renders the retained value and every
 * claim fails.
 *
 * Intermediate stages are read in the working format (linear rgba16float). Each stored value
 * is off by at most ONE half-float step (`step(v)`, the spacing of halves at v): half a step of
 * rounding, and up to half a step more from the level shader's `pow(c, 1/gamma)`, which Metal
 * evaluates through log2/exp2 and does not round correctly even at gamma 1 (measured: a value
 * on a rounding boundary lands one step low). Every tolerance below is that bound, summed over
 * the values it compares (§V147: derived, not a band).
 */
let unavailable: string | undefined;
beforeAll(async () => {
  unavailable = (await probeDawn()).error;
}, 60_000);

const WIDTH = 160;
const HEIGHT = 90;
/** The spacing of rgba16float values at v (10 mantissa bits; the subnormal spacing below 2^-14). */
function step(v: number): number {
  const magnitude = Math.abs(v);
  return magnitude < 2 ** -14 ? 2 ** -24 : 2 ** (Math.floor(Math.log2(magnitude)) - 10);
}
const PIXELS = WIDTH * HEIGHT;

/** The shipped graph with the named widgets' parameters overridden. */
function moved(widgets: Record<string, Record<string, number | boolean>>): GraphDocument {
  const graph = structuredClone(phoneDeskDocument.graph);
  for (const [id, values] of Object.entries(widgets)) Object.assign(graph.nodes[id]!.parameters, values);
  return graph;
}

/** `nodeId`'s output on frame 0, rgba16float decoded, four values per pixel. */
async function render(graph: GraphDocument, nodeId: string): Promise<Float64Array> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: { ...phoneDeskDocument.settings, outputResolution: { width: WIDTH, height: HEIGHT } },
    frames: 1,
    outputNodeId: nodeId,
    animate: true,
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[0]!;
  expect(frame.format).toBe("rgba16float");
  const bits = new Uint16Array(frame.bytes.buffer, frame.bytes.byteOffset, frame.bytes.byteLength / 2);
  return Float64Array.from(bits, decodeHalf);
}

/** Pixels whose rgb differ at all. */
function differing(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let count = 0;
  for (let index = 0; index < PIXELS; index += 1) {
    if ([0, 1, 2].some((channel) => a[index * 4 + channel] !== b[index * 4 + channel])) count += 1;
  }
  return count;
}

/** Hue in turns and chroma of a linear rgb pixel — the standard hexcone, written out here. */
function hueOf(r: number, g: number, b: number): { hue: number; max: number; chroma: number } {
  const max = Math.max(r, g, b);
  const chroma = max - Math.min(r, g, b);
  if (chroma === 0) return { hue: 0, max, chroma };
  const sixth = max === r ? ((g - b) / chroma + 6) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
  return { hue: sixth / 6, max, chroma };
}

/** Signed distance of point p from the line a→b, positive on the left (a CCW quad's inside). */
function leftOf(a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  return (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / Math.hypot(dx, dy);
}

describe("E81 Phone Desk — each widget drives what its annotation says it drives", () => {
  it("the Heat slider scales level1's brightness: at 1.5 every value is three times its value at 0.5", async () => {
    expect(unavailable).toBeUndefined();
    const low = await render(moved({ heat: { value: 0.5 } }), "level");
    const high = await render(moved({ heat: { value: 1.5 } }), "level");
    let lit = 0;
    for (let index = 0; index < PIXELS; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const a = low[index * 4 + channel]!;
        const b = high[index * 4 + channel]!;
        expect(Math.abs(b - 3 * a), `pixel ${index} channel ${channel}: ${b} vs 3 × ${a}`).toBeLessThanOrEqual(step(b) + 3 * step(a));
        if (a > 0.01) lit += 1;
      }
    }
    // Not a black frame scaled by three: most of the picture carries light.
    expect(lit).toBeGreaterThan(PIXELS * 0.8);
    // And it reaches the output: brighter wherever the picture is lit.
    const outLow = await render(moved({ heat: { value: 0.5 } }), "out");
    const outHigh = await render(moved({ heat: { value: 1.5 } }), "out");
    let brighter = 0;
    for (let index = 0; index < PIXELS; index += 1) {
      const sum = (frame: Float64Array) => frame[index * 4]! + frame[index * 4 + 1]! + frame[index * 4 + 2]!;
      if (sum(outHigh) > sum(outLow)) brighter += 1;
    }
    expect(brighter).toBeGreaterThan(PIXELS * 0.5);
  }, 120_000);

  it("the Invert toggle flips level1: on, every value is one minus its value off", async () => {
    expect(unavailable).toBeUndefined();
    const off = await render(moved({ invert: { on: false } }), "level");
    const on = await render(moved({ invert: { on: true } }), "level");
    for (let index = 0; index < PIXELS; index += 1) {
      for (let channel = 0; channel < 3; channel += 1) {
        const a = off[index * 4 + channel]!;
        const b = on[index * 4 + channel]!;
        expect(Math.abs(a + b - 1), `pixel ${index} channel ${channel}: ${a} + ${b}`).toBeLessThanOrEqual(step(a) + step(b));
      }
    }
    expect(differing(off, on)).toBeGreaterThan(PIXELS * 0.9);
  }, 120_000);

  it("each press of the Next hue button turns hue1 a quarter turn, and four presses come back round", async () => {
    expect(unavailable).toBeUndefined();
    const none = await render(moved({ flash: { presses: 0 } }), "hue");
    const one = await render(moved({ flash: { presses: 1 } }), "hue");
    const four = await render(moved({ flash: { presses: 4 } }), "hue");
    let measured = 0;
    for (let index = 0; index < PIXELS; index += 1) {
      const before = hueOf(none[index * 4]!, none[index * 4 + 1]!, none[index * 4 + 2]!);
      const after = hueOf(one[index * 4]!, one[index * 4 + 1]!, one[index * 4 + 2]!);
      // Grey has no hue to turn; only pixels with real chroma testify.
      if (before.chroma < 0.3 * before.max || before.max < 0.02) continue;
      const turned = (((after.hue - before.hue) % 1) + 1) % 1;
      // One step of error in each of r, g, b (≤ step(max)) moves a hexcone hue by at most
      // (4/6)·step(max)/chroma turns per frame — numerator and denominator of the sextant
      // ratio each off by two steps; two frames compared, so twice that. (Hue rotation keeps
      // max, so both frames share it.)
      const bound = ((4 / 3) * step(before.max)) / before.chroma;
      expect(Math.abs(turned - 0.25), `pixel ${index}: turned ${turned}`).toBeLessThanOrEqual(bound);
      measured += 1;
    }
    expect(measured).toBeGreaterThan(PIXELS * 0.3);
    expect(differing(none, one)).toBeGreaterThan(PIXELS * 0.5);
    for (let index = 0; index < PIXELS * 4; index += 1) {
      if (index % 4 === 3) continue;
      const a = none[index]!;
      const b = four[index]!;
      expect(Math.abs(a - b), `value ${index}: ${a} vs ${b}`).toBeLessThanOrEqual(step(a) + step(b));
    }
  }, 120_000);

  it("the Warp pad moves pin1's top-right corner: the covered region is the quad the pad names", async () => {
    expect(unavailable).toBeUndefined();
    const probe = { x: Math.floor(WIDTH * 0.95), y: Math.floor(HEIGHT * 0.05) }; // near the top-right
    const coverageAtProbe: number[] = [];
    for (const [tx, ty] of [
      [1, 1],
      [0.82, 0.78],
      [0.5, 0.55],
    ] as const) {
      const pinned = await render(moved({ warp: { x: tx, y: ty } }), "pin");
      const quad = [
        [0, 0],
        [1, 0],
        [tx, ty],
        [0, 1],
      ] as const;
      let inside = 0;
      let outside = 0;
      for (let y = 0; y < HEIGHT; y += 1) {
        for (let x = 0; x < WIDTH; x += 1) {
          // Row 0 is the top; the node's corners are y-up.
          const point = [(x + 0.5) / WIDTH, 1 - (y + 0.5) / HEIGHT] as const;
          const distance = Math.min(...quad.map((corner, i) => leftOf(corner, quad[(i + 1) % 4]!, point)));
          // f32 in the shader and f64 here disagree only within rounding of an edge.
          if (Math.abs(distance) < 1e-4) continue;
          const alpha = pinned[(y * WIDTH + x) * 4 + 3]!;
          if (distance > 0) {
            expect(alpha, `inside ${x},${y} with the pin at ${tx},${ty}`).toBe(1);
            inside += 1;
          } else {
            expect(alpha, `outside ${x},${y} with the pin at ${tx},${ty}`).toBe(0);
            outside += 1;
          }
        }
      }
      expect(inside).toBeGreaterThan(PIXELS * 0.4);
      if (tx < 1) expect(outside).toBeGreaterThan(0);
      coverageAtProbe.push(pinned[(probe.y * WIDTH + probe.x) * 4 + 3]!);
    }
    // At the frame's corner the probe is covered; pulled in, the corner leaves it bare.
    expect(coverageAtProbe).toEqual([1, 0, 0]);
  }, 120_000);
});

describe("E81 Phone Desk — the Panel and the notes", () => {
  const nodes = Object.values(phoneDeskDocument.graph.nodes);
  const widgets = nodes.filter((node) => CONTROL_WIDGET_TYPES.has(node.type));

  it("ships one of each widget, each read by an expression in exactly a binding's spelling", () => {
    expect(widgets.map((node) => node.type).sort()).toEqual([...CONTROL_WIDGET_TYPES].sort());
    const sources = nodes.flatMap((node) =>
      Object.values(node.parameters).flatMap((stored) =>
        typeof stored === "object" && stored !== null && "mode" in stored && stored.mode === "expression" && stored.bindings.expression?.kind === "expression"
          ? [stored.bindings.expression.source]
          : [],
      ),
    );
    for (const widget of widgets) {
      // `op('<name>').chan.<channel>` — the slot a binding from the parameter writes (T1514b),
      // with the name it resolves (label) and the widget's own channel, suffixed where the
      // type publishes more.
      const read = `op('${widget.label ?? widget.id}').chan.${controlChannel(widget.parameters)}`;
      expect(sources.some((source) => source.includes(read)), `${widget.label} drives nothing`).toBe(true);
    }
  });

  it("has one Panel titled Phone Desk, published to phones, showing all four widgets in the order they are wired", () => {
    const panels = nodes.filter((node) => node.type === "panel");
    expect(panels).toHaveLength(1);
    const panel = panels[0]!;
    expect(panel.parameters["title"]).toBe("Phone Desk");
    expect(panel.parameters["remote"]).toBe(true);
    const graph = phoneDeskDocument.graph;
    // T1512b's idiom: membership is the wiring, with no Layout override to replace it.
    expect(panel.parameters["layout"] ?? "").toBe("");
    expect(panelLayout(graph, panel).source).toBe("wiring");
    const wired = incomingEdgesInOrder(graph, panel.id, PANEL_INPUT).map((edge) => edge.source.nodeId);
    const shown = panelMembers(graph, panel).map((node) => node.id);
    // The order on the Panel IS the wiring order, and every widget is on it.
    expect(shown).toEqual(wired);
    expect(shown).toEqual(["heat", "invert", "flash", "warp"]);
    expect([...shown].sort()).toEqual(widgets.map((node) => node.id).sort());
  });

  /**
   * T1516b — the Panel is ARRANGED, not flowed: every widget sits at a rect its stored board
   * names (a deliberate layout a newcomer can read the idea off), on one shared grid, with no
   * two items on the same cell, and the board fits the eight columns it declares.
   */
  it("has a stored board placing every widget deliberately, with no overlaps", () => {
    const graph = phoneDeskDocument.graph;
    const panel = nodes.find((node) => node.type === "panel")!;
    const stored = parsePanelBoard(panel.parameters["board"]);
    const storedMembers = stored.items.flatMap((item) => ("member" in item ? [item.member] : []));
    expect([...storedMembers].sort()).toEqual(panelMembers(graph, panel).map((node) => node.label).sort());
    const board = panelBoard(graph, panel)!;
    expect(board.columns).toBe(8);
    expect(board.items.some((item) => item.kind === "label")).toBe(true);
    for (const [index, item] of board.items.entries()) {
      expect(item.rect.x + item.rect.w).toBeLessThanOrEqual(board.columns);
      for (const other of board.items.slice(index + 1)) expect(boardRectsOverlap(item.rect, other.rect), `${item.key} on ${other.key}`).toBe(false);
    }
  });

  it("tells the reader the helper command the product builds", () => {
    const bodies = nodes.filter((node) => node.type === ANNOTATE_TYPE).map((node) => String(node.parameters["body"]));
    expect(bodies.some((body) => body.includes(DEVICE_HELPER_PHONE_COMMAND))).toBe(true);
  });

  it("renders the same plan with the notes removed", () => {
    const capabilities: BackendCapabilities = {
      tier: "B",
      features: [],
      formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
      timestampQuery: false,
      limits: { maxTextureDimension2D: 8192 },
    };
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const notes = nodes.filter((node) => node.type === ANNOTATE_TYPE).map((node) => node.id);
    expect(notes).toHaveLength(5);
    const bare = structuredClone(phoneDeskDocument.graph);
    for (const id of notes) delete bare.nodes[id];
    const compile = (graph: GraphDocument) =>
      compileGraph({ graph, settings: phoneDeskDocument.settings, registry, capabilities });
    const withNotes = compile(phoneDeskDocument.graph);
    const without = compile(bare);
    expect(withNotes.ok).toBe(true);
    expect(withNotes.signature).toBe(without.signature);
    expect(withNotes.passes).toEqual(without.passes);
    expect(withNotes.outputs).toEqual(without.outputs);
    expect([...withNotes.pruned].sort()).toEqual([...notes, "panel"].sort());
  });
});
