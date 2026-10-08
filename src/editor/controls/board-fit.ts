import { controlChannel } from "@nodes/definitions/controls.ts";

/**
 * T1518b — WHAT A BOARD CELL HAS ROOM TO SAY. On the Panel node's canvas body the board is
 * scaled into a 178 px node, so an eight-column cell is ~20 px: a 2-cell toggle read
 * "I.. Off" and the XY pad "To… 0..", both halves cut, neither readable. The rule, in order:
 *
 *   1. SCALE THE TYPE with the cell (`boardBaseFontPx`), shrinking it further — never below
 *      `BOARD_FONT_MIN_PX` — until caption and value fit whole;
 *   2. if they cannot, the CAPTION gives way: it ellipsises at the minimum size and the
 *      value stays whole beside it. A toggle alone may first trade its On/Off text for a
 *      small switch (its state IS the switch, so nothing is hidden) to keep its caption.
 *
 * VNB9 reversed T1518b's order, which dropped the value first and kept the caption whole:
 * on `stage-previz-2` a slider captioned "Side keystone H, ° (squares the floor image)"
 * showed no number at all, and a control whose number cannot be seen cannot be read on
 * stage. The whole caption, and the value, are on the control's hover. Still: the readout
 * never truncates, and the two are never cut together. Decided from arithmetic on the rect and the document, not
 * from a measurement, so jsdom and the browser agree and a test can read the decision.
 * The em widths below are the CSS of a board widget (`control-widget.module.css`, `.board`),
 * and the glyph estimate is deliberately a few percent WIDE of Archivo (measured: "Invert"
 * 2.50 em, "Next hue" 4.00 em, "Top-right pin" 5.50 em; estimated 2.64, 4.12, 5.96), so a
 * fit it promises is a fit the browser draws.
 */

/** The smallest board type: below it a caption is not read, it is guessed. */
export const BOARD_FONT_MIN_PX = 8;
/** The largest board type: `--fs-ui`, the Controls tab's size before T1518b. */
export const BOARD_FONT_MAX_PX = 12;
/** Type scales with the cell: half a cell, clamped to [min, max]. */
const FONT_PER_CELL = 0.5;

/** A board widget's hairline border, both sides, in px — `.track`, `.pad`, `.toggle`, `.button`. */
const BORDER_PX = 2;

/* Em measures of a board widget's chrome, from `control-widget.module.css` (`.board …`). */
/** `.board .overlay` — `padding: 0 0.35em`. */
const OVERLAY_PAD_EM = 0.7;
/** `.overlay .head` — `gap: 0.5em` between caption and value. */
const HEAD_GAP_EM = 0.5;
/** `.board .toggle`/`.button` — `padding: 0 0.2em`. */
const PRESS_PAD_EM = 0.4;
/** `.board .toggle`/`.button` — `gap: 0.25em`. */
const PRESS_GAP_EM = 0.25;
/** `.board .switch` — `width: 2.2em`. */
const SWITCH_EM = 2.2;
/** `.board .mini .switch` — `width: 1.1em`: the switch a toggle keeps when its state text goes. */
const MINI_SWITCH_EM = 1.1;
/** `.board .state`/`.count` — `font-size: 0.85em`, monospace. */
const SMALL_MONO_EM = 0.85;
/** JetBrains Mono's advance. */
const MONO_EM = 0.6;
/** `.label` — `letter-spacing: 0.08em`, uppercase. */
const LABEL_SPACING_EM = 0.08;

const NARROW = new Set("iljtfrI!.,:;'|()- ");
const WIDE = new Set("mwMW");

/** The estimated advance of `text` in the UI font, in em (see the docblock on why it runs wide). */
export function uiTextEm(text: string): number {
  let em = 0;
  for (const glyph of text) {
    if (NARROW.has(glyph)) em += 0.32;
    else if (WIDE.has(glyph)) em += 0.88;
    else if (glyph >= "0" && glyph <= "9") em += 0.58;
    else if (glyph !== glyph.toLowerCase()) em += 0.68;
    else em += 0.56;
  }
  return em;
}

/** A control's number as every widget prints it. */
export function formatControlValue(value: number): string {
  const magnitude = Math.abs(value);
  return magnitude >= 100 ? value.toFixed(0) : magnitude >= 10 ? value.toFixed(1) : value.toFixed(2);
}

const num = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) ? value : fallback);

/** A stored parameter that is not a plain value (an expression or binding slot) is driven. */
export const isDrivenParameter = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);

/** A control's caption: its Caption, or its channel. */
export function controlCaption(parameters: Readonly<Record<string, unknown>>): string {
  const caption = parameters["caption"];
  return typeof caption === "string" && caption !== "" ? caption : controlChannel(parameters);
}

/**
 * The WIDEST value a widget of this type can print with these parameters, in em — not the
 * current one, so a slider whose value crosses 9.99 → 10.0 does not make its readout come
 * and go mid-drag.
 */
export function boardValueEm(type: string, parameters: Readonly<Record<string, unknown>>): number {
  const min = num(parameters["min"], 0);
  const max = num(parameters["max"], 1);
  const digits = Math.max(formatControlValue(min).length, formatControlValue(max).length, "0.00".length);
  switch (type) {
    case "slider":
      return (isDrivenParameter(parameters["value"]) ? "driven".length : digits) * MONO_EM;
    case "xyPad":
      return (isDrivenParameter(parameters["x"]) || isDrivenParameter(parameters["y"]) ? "driven".length : digits * 2 + 2) * MONO_EM;
    case "toggle":
      // `.state` holds `min-width: 3ch` — "Off" and "On" take the same room.
      return 3 * MONO_EM * SMALL_MONO_EM;
    case "button":
      return (1 + Math.max(2, String(Math.round(num(parameters["presses"], 0))).length)) * MONO_EM * SMALL_MONO_EM;
    default:
      return 0;
  }
}

/** The type size a board cell of `cellPx` starts from. */
export function boardBaseFontPx(cellPx: number): number {
  return Math.min(BOARD_FONT_MAX_PX, Math.max(BOARD_FONT_MIN_PX, cellPx * FONT_PER_CELL));
}

export interface BoardFit {
  /** The type size the item draws at, in px. */
  readonly fontPx: number;
  /** Whether its value (a slider's number, a toggle's On/Off, a button's count) is shown. */
  readonly value: boolean;
  /** `whole`: the caption fits at `fontPx`; `cut`: it does not fit beside the value at the minimum, and ellipsises (VNB9). */
  readonly caption: "whole" | "cut";
}

export interface BoardFitRequest {
  /** A widget type, or `label` for a free text label. */
  readonly kind: string;
  readonly caption: string;
  /** `boardValueEm` for a widget; 0 for a label. */
  readonly valueEm: number;
  /** The item's content width in px. */
  readonly widthPx: number;
  /** The board's cell size in px (scales the type). */
  readonly cellPx: number;
}

/** Em a widget needs on one line: its chrome and caption, plus its value when shown. */
function lineEm(kind: string, captionEm: number, valueEm: number, withValue: boolean): number {
  switch (kind) {
    case "slider":
    case "xyPad":
      return OVERLAY_PAD_EM + captionEm + (withValue ? HEAD_GAP_EM + valueEm : 0);
    case "toggle":
      return PRESS_PAD_EM + captionEm + PRESS_GAP_EM + (withValue ? SWITCH_EM + PRESS_GAP_EM + valueEm : MINI_SWITCH_EM);
    case "button":
      return PRESS_PAD_EM + captionEm + (withValue ? PRESS_GAP_EM + valueEm : 0);
    default:
      return captionEm;
  }
}

const halfPixelFloor = (px: number): number => Math.floor(px * 2) / 2;

/** T1518b — the rule in the docblock, for one board item. */
export function boardFit({ kind, caption, valueEm, widthPx, cellPx }: BoardFitRequest): BoardFit {
  const label = kind === "label";
  const captionEm = label ? uiTextEm(caption.toUpperCase()) + LABEL_SPACING_EM * caption.length : uiTextEm(caption);
  const room = widthPx - (label ? 0 : BORDER_PX);
  const base = boardBaseFontPx(cellPx);
  const hasValue = !label && valueEm > 0;
  // VNB9: only a toggle may drop its value text, because its switch still shows the state.
  const tries = !hasValue ? [false] : kind === "toggle" ? [true, false] : [true];
  for (const withValue of tries) {
    const em = lineEm(kind, captionEm, valueEm, withValue);
    const fontPx = halfPixelFloor(Math.min(base, room / Math.max(em, 0.01)));
    if (fontPx >= BOARD_FONT_MIN_PX) return { fontPx, value: withValue, caption: "whole" };
  }
  return { fontPx: BOARD_FONT_MIN_PX, value: hasValue && kind !== "toggle", caption: "cut" };
}

/* ------------------------------------------------------------------ T1501b */

/** How a board's cells are sized: the tab's fixed cells with a gap, or the canvas body's scaled ones. */
export interface BoardCells {
  readonly cellPx: number;
  /** The content width, in px, of an item `w` cells wide. */
  readonly widthOf: (w: number) => number;
}

/** A board rect's size, in whole cells. */
interface Cells {
  readonly w: number;
  readonly h: number;
}

/**
 * T1501b — A BANK'S STRIP: one button per preset, spread over the rows its rect has. A 4×1
 * strip of six presets is six narrow buttons; give it a second row and it is 3 + 3. Never
 * more rows than presets, so two presets in a 4×2 rect are two tall buttons, not a gap.
 */
export function presetStripGrid(count: number, rows: number): { readonly rows: number; readonly perRow: number } {
  const used = Math.max(1, Math.min(rows, count));
  return { rows: used, perRow: Math.max(1, Math.ceil(count / used)) };
}

/** Cells a board layer needs across before its fader sits BESIDE its switch: two for each. */
const LAYER_FADER_BESIDE_COLUMNS = 4;

/**
 * T1501b — A LAYER ON A BOARD is its switch, plus its opacity fader when the rect has room:
 * `stacked` under the switch from two rows up, `beside` it on one row from four cells
 * across. A smaller rect — the 2×1 a layer lands at — is the `switch` alone.
 */
export type LayerBoardLayout = "switch" | "stacked" | "beside";

export function layerBoardLayout(size: Cells): LayerBoardLayout {
  if (size.h >= 2) return "stacked";
  return size.w >= LAYER_FADER_BESIDE_COLUMNS ? "beside" : "switch";
}

/** Cells a board cue list needs across before the cue names sit BESIDE its buttons. */
const CUE_NAMES_BESIDE_COLUMNS = 6;

/**
 * T1501b — A CUE LIST ON A BOARD is BACK and GO, plus where the set is — the current cue
 * and the one standing by — when the rect has room: `stacked` above the buttons from two
 * rows up (the 4×2 a list lands at), `beside` them on one row from six cells across. A
 * smaller rect is the `buttons` alone: the names go before a button does.
 */
export type CueBoardLayout = "buttons" | "stacked" | "beside";

export function cueListBoardLayout(size: Cells): CueBoardLayout {
  if (size.h >= 2) return "stacked";
  return size.w >= CUE_NAMES_BESIDE_COLUMNS ? "beside" : "buttons";
}

/** Rows a board cue list needs before it shows the cues themselves, to tap a standby from. */
const CUE_LIST_ROWS = 3;

/**
 * T1527b — the desk's tap-a-cue list, by the phone page's rule (§T1503b, `buildCueList`
 * in `phone-page.ts`): a STACKED list three rows or taller lists its cues between the
 * names and the buttons, the list taking every row the two do not.
 */
export function cueListShowsCues(size: Cells): boolean {
  return cueListBoardLayout(size) === "stacked" && size.h >= CUE_LIST_ROWS;
}
