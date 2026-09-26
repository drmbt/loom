import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { parsePanelLayout } from "./controls.ts";

/**
 * T1388b — a live control publishes what it shows under the name it was given, and that
 * name is what a parameter elsewhere reads. Driven through the real value session: a slider
 * named `heat` at 0.7 is channel `heat` = 0.7, clamped to its range; a toggle is 1/0; a held
 * button is 1 with its press count beside it; an XY pad is <name>X / <name>Y; and a
 * parameter elsewhere reading op('fader1').chan.heat receives 0.7.
 */
const registry = createNodeRegistry(allNodeDefinitions).view();
const frame = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 } as const;

function evaluate(nodes: Record<string, { type: string; label: string; parameters: Record<string, unknown> }>): Map<string, Record<string, number>> {
  const doc = {
    revision: 1,
    groups: {},
    edges: {},
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, n]) => [id, { id, type: n.type, definitionVersion: 1, position: { x: 0, y: 0 }, label: n.label, parameters: n.parameters }]),
    ),
  } as unknown as GraphDocument;
  const result = createValueGraphSession(registry).evaluate(doc, frame);
  expect(result.diagnostics).toEqual([]);
  return result.byName as Map<string, Record<string, number>>;
}

describe("T1388b — live controls publish under the name they were given", () => {
  it("slider, toggle, button and XY pad each publish their value on their own channel", () => {
    const out = evaluate({
      s: { type: "slider", label: "fader1", parameters: { channel: "heat", value: 0.7, min: 0, max: 1 } },
      over: { type: "slider", label: "fader2", parameters: { channel: "over", value: 5, min: 0, max: 2 } },
      t: { type: "toggle", label: "toggle1", parameters: { channel: "strobe", on: true } },
      b: { type: "button", label: "button1", parameters: { channel: "cut", held: true, presses: 3 } },
      xy: { type: "xyPad", label: "pad1", parameters: { channel: "aim", x: 0.25, y: 0.75, min: 0, max: 1 } },
    });
    expect(out.get("fader1")).toEqual({ heat: 0.7 });
    // The range is a limit: a value written past it publishes the edge.
    expect(out.get("fader2")).toEqual({ over: 2 });
    expect(out.get("toggle1")).toEqual({ strobe: 1 });
    expect(out.get("button1")).toEqual({ cut: 1, cutCount: 3 });
    expect(out.get("pad1")).toEqual({ aimX: 0.25, aimY: 0.75 });
  });

  it("a name that is not an identifier falls back to `value`, so it can still be addressed", () => {
    const out = evaluate({ s: { type: "slider", label: "fader1", parameters: { channel: "two words", value: 0.2 } } });
    expect(out.get("fader1")).toEqual({ value: 0.2 });
  });

  it("a Panel's layout reads as headings, notes and rows of widget names", () => {
    expect(parsePanelLayout("# Furnace\n> the melt\nheat glitch, cut\n\n# Camera\npad1")).toEqual([
      { kind: "heading", text: "Furnace" },
      { kind: "text", text: "the melt" },
      { kind: "widgets", names: ["heat", "glitch", "cut"] },
      { kind: "heading", text: "Camera" },
      { kind: "widgets", names: ["pad1"] },
    ]);
  });
});
