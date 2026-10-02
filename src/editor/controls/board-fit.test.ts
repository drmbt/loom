import { describe, expect, it } from "vitest";
import {
  BOARD_FONT_MAX_PX,
  BOARD_FONT_MIN_PX,
  boardFit,
  boardValueEm,
  cueListBoardLayout,
  layerBoardLayout,
  presetStripGrid,
  uiTextEm,
} from "./board-fit.ts";

/**
 * T1518b — WHAT A BOARD CELL SAYS WHEN IT IS SMALL. The owner's screenshot of E81's Panel on
 * the canvas: a 2-cell toggle reading "I.. Off" and the XY pad "To… 0..", caption and value
 * BOTH cut, so neither could be read. The rule these tests pin, in its order: the type
 * shrinks with the cell (never below the minimum), then the VALUE goes, and only a caption
 * that cannot fit alone at the minimum is cut. A value is whole or absent, never cut.
 *
 * The widths are E81's own: the Panel body is 164px wide (`controlsContentWidth`), eight
 * columns, so a cell is 20.5px and an item `w` cells wide has `w × 20.5 − 2` px.
 */
const CANVAS_CELL = 164 / 8;
const onCanvas = (w: number) => w * CANVAS_CELL - 2;
const TAB_CELL = 52;
const onTab = (w: number) => w * TAB_CELL + (w - 1) * 4;

const fit = (kind: string, caption: string, widthPx: number, cellPx: number, parameters: Record<string, unknown> = {}) =>
  boardFit({ kind, caption, valueEm: kind === "label" ? 0 : boardValueEm(kind, parameters), widthPx, cellPx });

describe("T1518b — the value goes before the caption is cut", () => {
  it("E81's 2-cell toggle on the canvas keeps its whole caption and drops On/Off", () => {
    const toggle = fit("toggle", "Invert", onCanvas(2), CANVAS_CELL);
    expect(toggle.value).toBe(false);
    expect(toggle.caption).toBe("whole");
    expect(toggle.fontPx).toBeGreaterThanOrEqual(BOARD_FONT_MIN_PX);
  });

  it("E81's XY pad on the canvas keeps 'Top-right pin' whole and drops its numbers", () => {
    const pad = fit("xyPad", "Top-right pin", onCanvas(3), CANVAS_CELL);
    expect(pad).toMatchObject({ value: false, caption: "whole" });
  });

  it("a control with room keeps both: E81's 5-cell slider and 3-cell button on the canvas", () => {
    expect(fit("slider", "Heat", onCanvas(5), CANVAS_CELL, { min: 0, max: 2 })).toMatchObject({ value: true, caption: "whole" });
    expect(fit("button", "Next hue", onCanvas(3), CANVAS_CELL)).toMatchObject({ value: true, caption: "whole" });
  });

  it("the same toggle at the Controls tab's cells has room for its switch AND On/Off, at full size", () => {
    expect(fit("toggle", "Invert", onTab(2), TAB_CELL)).toEqual({ fontPx: BOARD_FONT_MAX_PX, value: true, caption: "whole" });
  });
});

describe("T1518b — the order: type first, then the value, then the caption", () => {
  it("shrinks the type to keep the value before it gives the value up", () => {
    // Wide enough for "Heat 0.00" only below the base size: the value stays, smaller.
    const base = fit("slider", "Heat", 400, CANVAS_CELL);
    const squeezed = fit("slider", "Heat", 50, CANVAS_CELL);
    expect(squeezed.value).toBe(true);
    expect(squeezed.fontPx).toBeLessThan(base.fontPx);
    expect(squeezed.fontPx).toBeGreaterThanOrEqual(BOARD_FONT_MIN_PX);
    // A little narrower and it no longer fits at the minimum: the value goes, the caption grows back.
    const dropped = fit("slider", "Heat", 40, CANVAS_CELL);
    expect(dropped).toMatchObject({ value: false, caption: "whole" });
    expect(dropped.fontPx).toBeGreaterThan(squeezed.fontPx);
  });

  it("cuts a caption only when it cannot fit alone at the minimum size — and then shows no value", () => {
    expect(fit("toggle", "A very long caption indeed", onCanvas(1), CANVAS_CELL)).toEqual({ fontPx: BOARD_FONT_MIN_PX, value: false, caption: "cut" });
  });

  it("what it promises fits: the line it sizes is no wider than the cell", () => {
    // The 2-cell canvas toggle: padding 0.4em + caption + gap 0.25em + mini switch 1.1em, plus the 2px border.
    const toggle = fit("toggle", "Invert", onCanvas(2), CANVAS_CELL);
    expect(toggle.fontPx * (0.4 + uiTextEm("Invert") + 0.25 + 1.1) + 2).toBeLessThanOrEqual(onCanvas(2));
  });

  it("type scales with the cell: a wider Panel node draws the same board larger, up to the maximum", () => {
    const small = fit("label", "Picture", onCanvas(5), CANVAS_CELL);
    const large = fit("label", "Picture", 5 * 40 - 2, 40);
    expect(small.fontPx).toBe(10);
    expect(large.fontPx).toBe(BOARD_FONT_MAX_PX);
  });
});

describe("T1518b — a readout does not come and go mid-drag", () => {
  it("sizes a slider's value for the widest number its range can print, not the current one", () => {
    const low = boardValueEm("slider", { min: 0, max: 200, value: 0.5 });
    const high = boardValueEm("slider", { min: 0, max: 200, value: 150 });
    expect(low).toBe(high);
    // …and a driven slider for the word it prints instead.
    expect(boardValueEm("slider", { min: 0, max: 1, value: { mode: "expression" } })).toBeCloseTo("driven".length * 0.6, 6);
  });
});

/**
 * T1501b — what a bank, a layer and a cue list show at the rect the owner gave them. The
 * rule is the board's own: the essential thing stays (the presets, the switch, GO and
 * BACK) and the rest joins when there is room for it.
 */
describe("T1501b — what a bank, a layer and a cue list have room for", () => {
  it("a bank spreads its presets over the rows it has, and never leaves a row empty", () => {
    expect(presetStripGrid(4, 1)).toEqual({ rows: 1, perRow: 4 });
    // Six on one row are six slivers; a second row makes them 3 + 3.
    expect(presetStripGrid(6, 1)).toEqual({ rows: 1, perRow: 6 });
    expect(presetStripGrid(6, 2)).toEqual({ rows: 2, perRow: 3 });
    expect(presetStripGrid(5, 2)).toEqual({ rows: 2, perRow: 3 });
    // Two presets in a three-row rect are two rows, not two buttons over a blank row.
    expect(presetStripGrid(2, 3)).toEqual({ rows: 2, perRow: 1 });
  });

  it("a layer is its switch at 2×1, with the fader under it from two rows and beside it from four cells", () => {
    expect(layerBoardLayout({ w: 2, h: 1 })).toBe("switch");
    expect(layerBoardLayout({ w: 3, h: 1 })).toBe("switch");
    expect(layerBoardLayout({ w: 4, h: 1 })).toBe("beside");
    expect(layerBoardLayout({ w: 2, h: 2 })).toBe("stacked");
    expect(layerBoardLayout({ w: 1, h: 3 })).toBe("stacked");
  });

  it("a cue list keeps BACK and GO at any size; the cue names join above them at two rows, beside them from six cells", () => {
    expect(cueListBoardLayout({ w: 2, h: 1 })).toBe("buttons");
    expect(cueListBoardLayout({ w: 5, h: 1 })).toBe("buttons");
    expect(cueListBoardLayout({ w: 6, h: 1 })).toBe("beside");
    expect(cueListBoardLayout({ w: 4, h: 2 })).toBe("stacked");
  });
});
