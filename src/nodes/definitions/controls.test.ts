import { describe, expect, it } from "vitest";

import type { GraphDocument } from "../../domain/types/graph.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { flatDocument } from "../../compiler/test-support.ts";
import { NO_FLATTENING } from "../../domain/parameters/node-references.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import type { GraphNode } from "../../domain/types/graph.ts";
import { controlDefaultState, controlNameOf, controlSliderNode, panelTitle, parsePanelLayout, surfaceNameOf } from "./controls.ts";

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
  const result = createValueGraphSession(registry).evaluate(flatDocument(doc), frame, { flattening: NO_FLATTENING });
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

/**
 * T1593b (ruled 2026-10-05) — WHAT A SURFACE CALLS A BANK, A LAYER, A CUE LIST OR A PANEL:
 * the role of its name. One rule, read by the desk's board, the Controls tab, the Layers
 * list and the phone, so they cannot caption one node two ways.
 */
describe("surfaceNameOf — the caption a one-word surface shows", () => {
  const node = (type: string, label?: string): GraphNode =>
    ({ id: "n1", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...(label === undefined ? {} : { label }) }) as GraphNode;

  it("is the role of a name that carries its kind", () => {
    expect(surfaceNameOf(node("presets", "presets_looks"))).toBe("looks");
    expect(surfaceNameOf(node("layer", "layer_lower_third"))).toBe("lower_third");
    expect(surfaceNameOf(node("cueList", "cuelist_set"))).toBe("set");
  });

  it("is the whole name when the rule did not make it: no role, no kind, or no name at all", () => {
    expect(surfaceNameOf(node("presets", "presets1"))).toBe("presets1");
    expect(surfaceNameOf(node("presets", "looks"))).toBe("looks");
    expect(surfaceNameOf(node("layer", "My Layer"))).toBe("My Layer");
    // Unnamed: the id, as `controlNameOf` gives it.
    expect(surfaceNameOf(node("layer"))).toBe("n1");
  });

  it("never changes the node's NAME: the board still stores and finds a member by it", () => {
    expect(controlNameOf(node("presets", "presets_looks"))).toBe("presets_looks");
  });

  /*
   * A look's instance is a bank from outside, and its kind is its component's own name,
   * which only the catalogue holds. With it, `city_downtown` is `downtown`; without it the
   * name is shown whole rather than cut on a guess.
   */
  it("reads a look instance's kind from its component's name, and guesses nothing without the catalogue", () => {
    const instance = node("component:cmp_7@2", "city_downtown");
    const catalogue = { get: (id: string, version: number) => (id === "cmp_7" && version === 2 ? { name: "City" } : undefined) };

    expect(surfaceNameOf(instance, catalogue)).toBe("downtown");
    expect(surfaceNameOf(instance)).toBe("city_downtown");
    // Pinned to a version the catalogue does not hold: the same, whole.
    expect(surfaceNameOf(node("component:cmp_7@9", "city_downtown"), catalogue)).toBe("city_downtown");
    // Named for something else: it does not carry the kind, so it is shown as it is.
    expect(surfaceNameOf(node("component:cmp_7@2", "comp_downtown"), catalogue)).toBe("comp_downtown");
  });

  it("titles a Panel by its Title, and an untitled one by the role of its name", () => {
    const panel = (label: string, title: string): GraphNode => ({ ...node("panel", label), parameters: { title } }) as GraphNode;
    expect(panelTitle(panel("panel_desk", "Front of house"))).toBe("Front of house");
    expect(panelTitle(panel("panel_desk", ""))).toBe("desk");
    expect(panelTitle(panel("panel1", ""))).toBe("panel1");
    expect(panelTitle(panel("desk", ""))).toBe("desk");
  });
});

/**
 * T1619b — where a control stands against its default: the one answer the reset command,
 * the desk's mark and the phone's snapshot all read, so "away" cannot mean two things.
 */
describe("T1619b — a control's default, and whether it is away from it", () => {
  const control = (type: string, parameters: Record<string, unknown>) => ({ type, parameters }) as Pick<GraphNode, "type" | "parameters">;
  const driven = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.9" }, static: { kind: "static", value: 0.2 } } };

  it("a control that stores a default and no value publishes the default: nothing stored IS at the default", () => {
    const out = evaluate({ s: { type: "slider", label: "slider_heat", parameters: { channel: "heat", min: 0, max: 2, defaultValue: 1.5 } } });
    expect(out.get("slider_heat")).toEqual({ heat: 1.5 });
    expect(controlDefaultState(control("slider", { min: 0, max: 2, defaultValue: 1.5 }))).toEqual({ defaults: { value: 1.5 }, current: { value: 1.5 }, away: [], driven: [], missing: [] });
  });

  it("a control that stores no default HAS none: it is neither at a default nor away from one, and never reads the type's 0.5 as one", () => {
    expect(controlDefaultState(control("slider", { value: 7, min: 0, max: 10 }))).toEqual({ defaults: {}, current: { value: 7 }, away: [], driven: [], missing: ["value"] });
    // Nothing stored at all: it shows the declared value, and still holds no default.
    expect(controlDefaultState(control("slider", {}))).toEqual({ defaults: {}, current: { value: 0.5 }, away: [], driven: [], missing: ["value"] });
    expect(controlDefaultState(control("toggle", { on: true }))).toMatchObject({ defaults: {}, away: [], missing: ["on"] });
    // A pad may hold one axis's default and not the other's.
    expect(controlDefaultState(control("xyPad", { x: 0.1, y: 0.9, defaultX: 0.5 }))).toMatchObject({ defaults: { x: 0.5 }, away: ["x"], missing: ["y"] });
    // A default an expression drives is not a stored default.
    expect(controlDefaultState(control("slider", { value: 0.3, defaultValue: driven }))).toMatchObject({ defaults: {}, missing: ["value"] });
  });

  it("away is further than a ten-thousandth of the range: float noise is at the default, a hand's move is not", () => {
    const slider = (value: number) => controlDefaultState(control("slider", { value, min: 0, max: 2, defaultValue: 1 }));
    expect(slider(1)?.away).toEqual([]);
    expect(slider(1.0001)?.away).toEqual([]);
    expect(slider(1.001)?.away).toEqual(["value"]);
    // A value written past the range is carried as the edge (`valueEvaluate`), and compared as it.
    expect(controlDefaultState(control("slider", { value: 5, min: 0, max: 2, defaultValue: 2 }))?.away).toEqual([]);
  });

  it("a toggle is away when its state is not its default; a pad per axis; a driven key is never away", () => {
    expect(controlDefaultState(control("toggle", { on: true, defaultOn: false }))).toMatchObject({ defaults: { on: false }, away: ["on"] });
    expect(controlDefaultState(control("toggle", { on: true, defaultOn: true }))?.away).toEqual([]);
    expect(controlDefaultState(control("xyPad", { x: 0.82, y: 0.1, defaultX: 0.82, defaultY: 0.78 }))?.away).toEqual(["y"]);
    expect(controlDefaultState(control("slider", { value: driven, defaultValue: 0.7 }))).toMatchObject({ away: [], driven: ["value"] });
  });

  it("a Button and a Panel hold no default", () => {
    expect(controlDefaultState(control("button", { held: false, presses: 3 }))).toBeNull();
    expect(controlDefaultState(control("panel", { title: "Desk" }))).toBeNull();
  });

  it("hands out ONE schema per default, and the declared one while the default is the declared one: schemas are read per frame", () => {
    const declared = effectiveParameterSchema(controlSliderNode, {});
    expect(effectiveParameterSchema(controlSliderNode, { value: 0.9 })).toBe(declared);
    const moved = effectiveParameterSchema(controlSliderNode, { value: 0.1, defaultValue: 0.8 });
    expect(moved).not.toBe(declared);
    expect(effectiveParameterSchema(controlSliderNode, { value: 0.6, defaultValue: 0.8 })).toBe(moved);
    expect((moved["value"] as { default?: unknown }).default).toBe(0.8);
  });
});
