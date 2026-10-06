/**
 * T1396b — THE PHONE PAGE: the one document the helper serves a phone at `PHONE_PAGE_PATH`.
 *
 * Self-contained by necessity: the helper runs this file from TypeScript source under node,
 * there is no bundler between it and the phone, and the page may fetch nothing but its own
 * endpoints (`PHONE_EVENTS_PATH` down; `PHONE_SET_PATH` and, since §T1397b's Send camera,
 * `PHONE_SIGNAL_PATH` up — the video itself is peer to peer). Inline `<style>`, inline
 * `<script>`, no framework.
 *
 * WHY THE CLIENT IS A STRING CONSTANT and not a function serialised with `.toString()`: the
 * bytes the phone runs are then the bytes the test runs. A function's source text depends
 * on who transformed it — node's type stripping in the helper, esbuild under vitest — and a
 * transform that injects a helper call or renames a binding would pass here and break on the
 * phone. `phone-page.test.ts` loads the served HTML into jsdom and drives the script inside
 * it, which is the only check that string could have.
 *
 * COLOURS COME FROM `src/ui/tokens.css` (§V17): the page reads the declarations it needs out
 * of the app's one palette when it is built, so the phone looks like Loom and this file
 * holds no literal colour. A token that disappears from the palette fails loudly here
 * rather than rendering a page with no colours.
 *
 * T1517b — TABS: a bottom bar with one tab per published Panel and a Camera tab, so the
 * camera is one tap away rather than under every Panel. A Panel with a board (§T1516b) is
 * drawn on a grid of square cells, one column = the page's width / columns; without one,
 * its rows. Tabs only show and hide: a running camera keeps sending under any tab.
 *
 * T1503b — A BANK, A LAYER AND A CUE LIST on a board (§T1398b ruling 12): a strip of preset
 * buttons with the current one lit and a mark on it while its fade runs; a layer's switch
 * and, when the rect has room, its opacity fader (a driven one is shown and does not move);
 * BACK, a large GO and `current ▸ next`, with the cue list to tap a standby from when the
 * rect is three rows or taller. Laid out by the desk's own rules (`board-fit.ts`), so the
 * phone shows the arrangement the owner made. Every press is ONE commit; nothing is lit
 * ahead of Loom's answer for a recall or a GO, because a refused press must light nothing.
 * There is no Store here, and no key this page sends that could become one.
 *
 * T1526b — A REFUSED PRESS IS SAID ON THE CONTROL. Loom tells this phone (`refused`, down
 * its own stream) which control and why; the sentence hangs under that control for about
 * three seconds, out of flow so nothing else moves, and the control is outlined meanwhile.
 * It hangs over whatever is below, so the next press anywhere takes it away (the control
 * under it is being used); a newer refusal replaces it; and what the finger had drawn
 * ahead of Loom's answer (a switch, a fader) goes back to the document's.
 * A refusal about nothing this page shows is the page's notice instead. Also: a layer's
 * switch names its picture, a cue shows its note (in the list, and for the standby beside
 * `current ▸ next`), and the list scrolls ITSELF — never the page — to keep the standby in
 * view when Loom moves it.
 *
 * T1607b — SCROLL TO EVERY CONTROL WITHOUT MOVING ONE, AND PAGES
 * (`docs/phone-panel-scrolling-design-2026-10-05.md`). A touch that lands on a control is
 * not yet the control's. Sliders, faders, toggles and buttons are `touch-action: pan-y`, so
 * the BROWSER scrolls a touch that goes up or down (and says so with `pointercancel`); the
 * script takes a touch only after it has travelled `SLOP` px along the control, further
 * than across it — past the point where the browser has decided. Touch-down never writes:
 * a value moves by the finger's TRAVEL from where the control took it (relative), a toggle
 * flips on release (`click`), a momentary Button is pressed on release or held once a
 * finger has rested `PRESS_MS`. An XY pad owns both axes (`touch-action: none`), so a page
 * that scrolls and shows one grows a rail down its right edge that only ever scrolls. A
 * board with two or more labelled sections gets a pager above the tabs: All, and a page per
 * label drawn so its own columns fill the width. Those rules are `PHONE_PAGE_LOGIC`, plain
 * functions of numbers that the test runs from the same string the phone does.
 *
 * B269 — A BOARD OF NARROW COLUMNS IS NEVER CRUSHED OR CLIPPED. A row is as tall as a column
 * is wide and never lower than a floor (`--row`); what a finger can hit is half the gap
 * more than what is drawn (the reach); a caption that does not fit is elided, a strip of
 * presets scrolls sideways with every name whole.
 *
 * T1647b — THE TOUCH RULE IS ON TRIAL, AND SO IS THE ROW'S HEIGHT. §T1607b's rule above (a
 * slider takes a touch anywhere along it) passed every test and failed in the owner's hand:
 * "still pretty hard to not screw with the sliders when scrolling on mobile". It was decided
 * by reading; the next one is decided by trying. The page holds the candidates as modes of
 * one setting kept on the phone (`TOUCH_MODES`: K a knob only, H hold to grab, L a Play /
 * Scroll lock, G a scroll strip, A as before) and three row heights, chosen at the right
 * end of the tab bar. EVERYTHING MARKED "T1647b trial" IS DELETED WHEN THE OWNER HAS CHOSEN:
 * the mode that stays becomes the rule, its fields become constants, and the table, the
 * two selects, the lock (unless L stays) and the branches nothing reads any more go.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PHONE_EVENTS_PATH,
  PHONE_NAME_MAX_CHARS,
  PHONE_PEER_PARAM,
  PHONE_REASON_MAX_CHARS,
  PHONE_SET_PATH,
  PHONE_SIGNAL_PATH,
  PHONE_TOKEN_PARAM,
} from "./phone-protocol.ts";

/** The palette entries the page uses, by their app name. */
const PHONE_TOKENS = [
  "--bg-void",
  "--bg-panel",
  "--bg-raise",
  "--line",
  "--line-hot",
  "--text",
  "--text-dim",
  "--signal",
  "--error",
  "--ok",
] as const;

/** Shown when the helper answers a write with 403: the token is no longer the door's. */
export const PHONE_EXPIRED_SENTENCE = "This link has expired — scan the QR code again.";

/** T1397b: where the phone keeps the name it sends its camera under (its `localStorage`). */
export const PHONE_NAME_STORAGE_KEY = "loom.phone.cameraName";

/** T1517b: where the phone keeps the tab it last showed (its `localStorage`). */
export const PHONE_TAB_STORAGE_KEY = "loom.phone.tab";

/** T1607b: where the phone keeps the page it last showed of each Panel — a JSON object, tab key → page name. */
export const PHONE_PAGE_STORAGE_KEY = "loom.phone.page";

/**
 * T1647b TRIAL — deleted when the owner has chosen: where the phone keeps what it is trying,
 * a JSON object `{ touch, rows }` (a key of `TOUCH_MODES`, and a row height in px).
 */
export const PHONE_TRIAL_STORAGE_KEY = "loom.phone.trial";

function paletteBlock(): string {
  // A path, not `new URL(…, import.meta.url)`: vite rewrites that form into an asset URL.
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../ui/tokens.css"), "utf8");
  const lines = PHONE_TOKENS.map((name) => {
    const match = new RegExp(`^\\s*${name}:\\s*([^;]+);`, "m").exec(css);
    if (match === null) throw new Error(`phone page: ${name} is not declared in src/ui/tokens.css`);
    return `  ${name}: ${(match[1] ?? "").trim()};`;
  });
  return `:root {\n  color-scheme: dark;\n${lines.join("\n")}\n}`;
}

const STYLE = String.raw`
* { box-sizing: border-box; }
html, body {
  margin: 0;
  background: var(--bg-void);
  color: var(--text);
  font: 16px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
  overscroll-behavior: none;
  -webkit-text-size-adjust: 100%;
}
body {
  /* --pad is the page gutter; --bar the bottom tab bar's height above the safe area.
     T1607b: --pager is the pager's height while a Panel has pages, --rail what the scroll
     rail takes from the right gutter while it shows; both 0 otherwise. */
  --pad: 12px;
  --bar: 64px;
  --gap: 6px;
  --pager: 0px;
  --rail: 0px;
  /* B269: the least a board's row may be DRAWN. Not a guideline's number: at 30 px the owner
     called his sliders crunched, at 39 to 45 "a smidge too chunky", so it sits between, and
     which of 32, 36 and 44 it is to be is his to try (§T1647b's trial). What a finger can
     HIT is more than what is drawn: half of --gap all round (the reach rules below). */
  --row: 36px;
  /* B269: 100vh on a phone is the viewport with the browser's bars AWAY — taller than what
     shows while they are there, so a page that fits scrolled anyway. 100dvh is what shows now
     (MDN, "Viewport-percentage lengths": the dynamic viewport); the vh line stays for a
     browser without it. Read from the documentation, not seen on a phone. */
  min-height: 100vh;
  min-height: 100dvh;
  padding: calc(var(--pad) + env(safe-area-inset-top)) calc(var(--pad) + var(--rail) + env(safe-area-inset-right))
    calc(var(--bar) + var(--pager) + var(--pad) + env(safe-area-inset-bottom)) calc(var(--pad) + env(safe-area-inset-left));
  touch-action: manipulation;
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
  -webkit-tap-highlight-color: transparent;
}
#status {
  position: sticky;
  top: env(safe-area-inset-top);
  z-index: 2;
  margin: 0 0 12px;
  padding: 10px 14px;
  border: 1px solid var(--line-hot);
  border-radius: 10px;
  background: var(--bg-raise);
  color: var(--text-dim);
  font-size: 14px;
}
#notice {
  position: fixed;
  left: calc(var(--pad) + env(safe-area-inset-left));
  right: calc(var(--pad) + env(safe-area-inset-right));
  bottom: calc(var(--bar) + var(--pager) + var(--pad) + env(safe-area-inset-bottom));
  z-index: 4;
  padding: 14px 16px;
  border: 1px solid var(--error);
  border-radius: 12px;
  background: var(--bg-raise);
  color: var(--text);
  font-size: 15px;
}
#notice.final { top: 40%; bottom: auto; text-align: center; font-size: 18px; }
[hidden] { display: none !important; }
.empty { color: var(--text-dim); text-align: center; margin-top: 30vh; }
/* T1517b: the bottom tab bar — one tab per Panel, then Camera. */
#tabs {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 3;
  display: flex;
  gap: 4px;
  min-height: calc(var(--bar) + env(safe-area-inset-bottom));
  padding: 6px calc(8px + env(safe-area-inset-right)) calc(6px + env(safe-area-inset-bottom)) calc(8px + env(safe-area-inset-left));
  border-top: 1px solid var(--line);
  background: var(--bg-panel);
  overflow-x: auto;
  scrollbar-width: none;
}
#tabs::-webkit-scrollbar { display: none; }
#tabs button {
  flex: 1 1 0;
  min-width: 72px;
  max-width: 220px;
  min-height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 0 10px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
}
#tabs button[aria-selected="true"] { background: var(--bg-raise); color: var(--text); box-shadow: inset 0 -3px 0 var(--signal); }
#tabs .tabname { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#tabs .dot { flex: none; width: 9px; height: 9px; border-radius: 50%; background: var(--signal); }
#tabs .dot.live { background: var(--ok); }
/*
 * T1607b: the pager — the shown Panel's labelled sections as pages, directly above the tab
 * bar so every way round the surface is under one thumb. Shown only for a board with pages.
 */
body.paged { --pager: 52px; }
#pager {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(var(--bar) + env(safe-area-inset-bottom));
  z-index: 3;
  display: flex;
  gap: 6px;
  height: var(--pager);
  padding: 4px calc(8px + env(safe-area-inset-right)) 4px calc(8px + env(safe-area-inset-left));
  border-top: 1px solid var(--line);
  background: var(--bg-panel);
  overflow-x: auto;
  scrollbar-width: none;
}
#pager::-webkit-scrollbar { display: none; }
#pager button {
  flex: 1 0 auto;
  min-width: 56px;
  max-width: 200px;
  min-height: 44px;
  padding: 0 12px;
  border: 1px solid var(--line);
  border-radius: 22px;
  background: transparent;
  color: var(--text-dim);
  font: inherit;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
#pager button[aria-selected="true"] { border-color: var(--signal); background: var(--bg-raise); color: var(--text); }
/*
 * T1607b: the scroll rail. An XY pad owns every touch that lands on it (touch-action:
 * none), so a page that scrolls and shows one keeps this strip at its right edge: it
 * handles nothing, which leaves a touch on it to the browser to scroll. The thumb says
 * where the page is. The body is inset by --rail while it shows, so no control lies under it.
 */
body.railed { --rail: 28px; }
#rail {
  position: fixed;
  top: 0;
  right: 0;
  bottom: calc(var(--bar) + var(--pager) + env(safe-area-inset-bottom));
  z-index: 2;
  width: calc(32px + env(safe-area-inset-right));
  border-left: 1px solid var(--line);
  background: var(--bg-panel);
  touch-action: pan-y;
}
#rail .railthumb {
  position: absolute;
  left: 13px;
  width: 6px;
  min-height: 24px;
  border-radius: 3px;
  background: var(--text-dim);
}
.panel { margin: 0; }
.panel > h2 { margin: 16px 0 8px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); }
.panel > h2:first-child { margin-top: 4px; }
.panel > p { margin: 8px 0; color: var(--text-dim); font-size: 15px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
.w { position: relative; flex: 1 1 140px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
/* Full width on a phone, side by side once two fit. */
.w.slider { flex: 1 1 280px; }
.w.xyPad { flex: 1 1 240px; max-width: 480px; }
.cap { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; color: var(--text-dim); }
.cap .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap .val { flex: none; color: var(--text); font-variant-numeric: tabular-nums; }
/*
 * T1607b: a touch that goes up or down from a control is the BROWSER's — it scrolls, and
 * says so with pointercancel; one that goes along it is the control's. An XY pad is the
 * exception: both axes are its own. .held is a control that has taken a touch.
 */
.ctl { touch-action: pan-y; user-select: none; -webkit-user-select: none; }
.ctl.pad { touch-action: none; }
.ctl.held, .fader.held { border-color: var(--signal); }
.track {
  position: relative;
  height: 56px;
  border: 1px solid var(--line-hot);
  border-radius: 12px;
  background: var(--bg-raise);
  overflow: hidden;
}
.fill { position: absolute; left: 0; top: 0; bottom: 0; background: color-mix(in srgb, var(--signal) 45%, transparent); }
/* B269: the handle is moved back by its own share of its width (transform, set with left),
   so at either end of the track it is whole, not half cut off by the track's edge. */
.thumb { position: absolute; top: 0; bottom: 0; width: 4px; background: var(--signal); }
button.ctl {
  min-height: 56px;
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--line-hot);
  border-radius: 12px;
  background: var(--bg-raise);
  color: var(--text);
  font: inherit;
  font-weight: 600;
}
button.ctl.on { border-color: var(--signal); background: color-mix(in srgb, var(--signal) 30%, var(--bg-raise)); }
button.ctl .name { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button.ctl .state { display: block; font-size: 13px; font-weight: 400; color: var(--text-dim); }
button.ctl.on .state { color: var(--text); }
.pad {
  position: relative;
  width: 100%;
  aspect-ratio: 1 / 1;
  min-height: 48px;
  border: 1px solid var(--line-hot);
  border-radius: 12px;
  background: var(--bg-raise);
}
.pad .puck {
  position: absolute;
  width: 36px;
  height: 36px;
  margin: -18px 0 0 -18px;
  border: 3px solid var(--signal);
  border-radius: 50%;
  background: color-mix(in srgb, var(--signal) 30%, transparent);
  pointer-events: none;
}
.stopped .ctl { opacity: 0.4; }
/*
 * T1526b: Loom refused this control's press. The sentence hangs under the control, out of
 * flow — no other control moves — and takes no touch; the outline is the refused state.
 * Both go after a few seconds. .end hangs it from the control's right edge instead, for a
 * control on the right half of the screen.
 */
.w.refused { z-index: 3; outline: 1px solid var(--error); outline-offset: 1px; border-radius: 10px; }
.w > .said {
  position: absolute;
  z-index: 3;
  top: calc(100% + 4px);
  left: 0;
  width: max-content;
  min-width: 100%;
  max-width: min(300px, 86vw);
  padding: 6px 8px;
  border: 1px solid var(--error);
  border-radius: 8px;
  background: var(--bg-raise);
  color: var(--text);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.3;
  white-space: normal;
  text-align: left;
  pointer-events: none;
}
.w > .said.end { left: auto; right: 0; }
/*
 * T1517b: a Panel's BOARD (T1516b) — the owner's arrangement on a grid of cells, one column
 * = the page's width / columns. A row is as tall as a column is wide (square cells), read
 * from the wrapper's inline size (cqi); the vw line before it is for a browser without
 * container units. Each item sits at its rect through grid-column / grid-row.
 *
 * B269: ...AND NEVER LOWER THAN A FINGER NEEDS (--row). The column count is the author's,
 * chosen at a desk; ten columns on a 375 px phone made a column, and so every slider, toggle
 * and preset button, 30 px tall. A board whose columns are narrower than --row keeps its
 * columns and gets taller rows: it grows and scrolls, it is never squeezed.
 */
.boardwrap { container-type: inline-size; }
.board {
  display: grid;
  gap: var(--gap);
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  grid-auto-rows: max(var(--row), calc((100vw - 2 * var(--pad) - var(--rail) - (var(--cols) - 1) * var(--gap)) / var(--cols)));
  grid-auto-rows: max(var(--row), calc((100cqi - (var(--cols) - 1) * var(--gap)) / var(--cols)));
}
.board .w { position: relative; display: block; min-height: 0; }
.board .w > .ctl { position: absolute; inset: 0; width: auto; height: auto; min-height: 0; aspect-ratio: auto; border-radius: 10px; }
.board .w > .cap {
  position: absolute;
  z-index: 1;
  left: 10px;
  right: 10px;
  top: 0;
  bottom: 0;
  align-items: center;
  color: var(--text);
  pointer-events: none;
}
/* B269: a pad narrower than its caption and value side by side puts the value on a line of
   its own, so the caption has the pad's whole width before it is elided. */
.board .w.xyPad > .cap { top: 6px; bottom: auto; flex-wrap: wrap; row-gap: 0; }
.board .w.xyPad > .cap .name { max-width: 100%; }
/* The slider's handle passes under its caption and value: each sits on a chip of the
   page's ground, so the line never cuts through the text. */
.board .w.slider > .cap .name, .board .w.slider > .cap .val {
  padding: 1px 6px;
  border-radius: 6px;
  background-color: var(--bg-void);
}
.board .w > button.ctl { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2px 6px; overflow: hidden; font-size: 14px; }
.board .w > button.ctl .name { max-width: 100%; }
/* A grid item is sized by the grid, so it can be its own size container: a cell too short
   for two lines keeps the caption, and the button's On colour says its state.
   B269: written as "show the state where there is room", not "hide it where there is not".
   A browser without container queries (Safari before 16, MDN) ignores the whole block: it
   used to show both lines in a one-row button, cut off top and bottom; now it shows the
   caption alone. Read from the documentation, not seen on a phone. */
.board .w > button.ctl .state { display: none; font-size: 11px; }
.board .w.toggle, .board .w.button { container-type: size; }
@container (min-height: 47px) { .board .w > button.ctl .state { display: block; } }
/*
 * B269: WHAT A FINGER CAN HIT IS NOT WHAT IS DRAWN. A row may be drawn lower than a finger
 * is wide (--row), so a control answers from half of --gap all round it as well: its hit
 * area is its rect plus the gap, and two controls side by side or one above the other share
 * the gap between them exactly, neither's reaching into the other's. (REACH in the script
 * is the same half gap.) The strip of the reach belongs to the item, not to the control
 * inside it, so each builder hands a touch that lands there on (see reach()).
 */
.board .w.slider::before, .board .w.toggle::before, .board .w.button::before, .board .w.xyPad::before {
  content: "";
  position: absolute;
  inset: calc(var(--gap) / -2);
}
.board .w.slider { touch-action: pan-y; }
.board .w.xyPad { touch-action: none; }
.board .label {
  display: flex;
  align-items: flex-end;
  min-width: 0;
  padding: 0 2px 4px;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-dim);
}
/* B269: the heading's text is one line that ends in an ellipsis. Bare text in the flex box
   above wrapped instead, and its upper lines were cut off at the top of the cell. */
.board .label > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/*
 * T1503b: a bank, a layer and a cue list on a board. .press is every button in them; the
 * parts share the item's rect the way the desk's do (data-layout).
 */
.board .w .press {
  position: relative;
  min-width: 0;
  min-height: 0;
  padding: 2px 6px;
  border: 1px solid var(--line-hot);
  border-radius: 8px;
  background: var(--bg-raise);
  color: var(--text);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board .w .press.on { border-color: var(--signal); background: color-mix(in srgb, var(--signal) 30%, var(--bg-raise)); }
.board .w .press:active { background: color-mix(in srgb, var(--signal) 45%, var(--bg-raise)); }
.board .w .press:disabled { opacity: 0.4; }
.stopped .press, .stopped .fader { opacity: 0.4; }
/*
 * A bank's strip: the desk's rows and buttons-per-row (--rows, --per). B269: a preset is
 * recalled by its NAME, so a button is never narrower than its name (min-content) or than a
 * finger (--row); a strip with more of them than its row holds scrolls sideways inside its
 * own rect — it used to shrink every button until six of them read "res…". The strip is its
 * own box inside the item so that the item does not clip: a refusal's sentence still hangs
 * under it.
 */
.board .w.preset > .strip {
  position: absolute;
  /* The reach (above): the strip is the row plus half a gap above and below; a press in
     that margin is the press of the button it is over. */
  inset: calc(var(--gap) / -2) 0;
  padding: calc(var(--gap) / 2) 0;
  display: grid;
  gap: 2px;
  grid-template-columns: repeat(var(--per), minmax(min-content, 1fr));
  grid-template-rows: repeat(var(--rows), minmax(0, 1fr));
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: none;
}
.board .w.preset > .strip::-webkit-scrollbar { display: none; }
.board .w.preset .press { min-width: var(--row); }
.board .w.preset .none { align-self: center; color: var(--text-dim); font-size: 13px; }
/* The fade mark: a bar along the foot of the preset being faded to, until the fade ends. */
.board .w .press.fading::after {
  content: "";
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 3px;
  background: var(--signal);
  animation: fademark 0.7s ease-in-out infinite alternate;
}
@keyframes fademark { from { opacity: 0.2; } to { opacity: 1; } }
.board .w.layer { display: grid; gap: 2px; grid-template-columns: minmax(0, 1fr); grid-auto-rows: minmax(0, 1fr); }
.board .w.layer[data-layout="beside"] { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.board .w.layer .sw .state { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--text-dim); }
.board .w.layer .sw.on .state { color: var(--text); }
/* T1526b: what the layer shows, beside its name — where the switch has the width for it. */
.board .w.layer .sw .pic { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--text-dim); }
.board .w.layer[data-layout="switch"] .sw .pic { display: none; }
.fader {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  min-width: 0;
  min-height: 0;
  padding: 0 8px;
  border: 1px solid var(--line-hot);
  border-radius: 8px;
  background: var(--bg-raise);
  font-size: 13px;
  overflow: hidden;
  touch-action: pan-y;
}
.fader .lbl, .fader .val { position: relative; z-index: 1; white-space: nowrap; }
.fader .lbl { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--text-dim); }
.fader .val { font-variant-numeric: tabular-nums; }
/* Driven by the document: said, drawn without a level, and it does not take a finger. */
.fader.driven { border-style: dashed; touch-action: auto; }
.fader.driven .fill, .fader.driven .thumb { display: none; }
.fader.driven .val { color: var(--text-dim); }
.board .w.cueList { display: flex; flex-direction: column; gap: 2px; }
.board .w.cueList[data-layout="beside"] { flex-direction: row; }
.w.cueList .cues {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 0;
  min-height: 26px;
  padding: 0 6px;
  border-radius: 8px;
  background: var(--bg-panel);
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
}
.w.cueList[data-layout="beside"] .cues { flex: 1 1 0; }
.w.cueList .cues .now, .w.cueList .cues .next { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.w.cueList .cues .arrow { flex: none; color: var(--text-dim); }
.w.cueList .cues .next { color: var(--signal); }
/* position: the rows' offsets are measured from the list, which scrolls itself to its standby (T1526b). */
.w.cueList .cuelist { position: relative; flex: 2 1 0; min-height: 0; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
.w.cueList .cuelist .press { flex: 0 0 34px; text-align: left; }
.w.cueList .cuelist .press.standby { border-color: var(--signal); }
/* T1526b: a cue's note, dim beside its name; no note, no gap. */
.w.cueList .note { margin-left: 8px; font-weight: 400; color: var(--text-dim); }
.w.cueList .cues .note { min-width: 0; margin-left: 0; overflow: hidden; text-overflow: ellipsis; }
.w.cueList .note:empty { display: none; }
/* §T1544b: what a following list switches in the structure — read-only, like the inspector's line. */
.w.cueList .structure { flex: none; font-size: 11px; color: var(--text-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.w.cueList .structure:empty { display: none; }
.w.cueList .gobar { flex: 1 1 0; min-height: 0; display: flex; gap: 2px; }
.w.cueList .gobar .back { flex: 1 1 0; }
.w.cueList .gobar .go { flex: 2 1 0; border-color: var(--signal); font-size: 20px; letter-spacing: 0.04em; }
/* T1397b + T1517b: the Camera tab — the preview fills what the tab bar leaves. */
#camera {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: calc(100vh - var(--bar) - 2 * var(--pad) - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  height: calc(100dvh - var(--bar) - 2 * var(--pad) - env(safe-area-inset-top) - env(safe-area-inset-bottom));
  min-height: 320px;
}
.stage {
  position: relative;
  flex: 1 1 auto;
  min-height: 160px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--bg-panel);
  overflow: hidden;
}
#camPreview { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; background: var(--bg-void); }
.camstate {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  margin: 0;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--bg-void) 70%, transparent);
  color: var(--text-dim);
  font-size: 14px;
  text-align: center;
}
.stage.idle .camstate { top: 50%; bottom: auto; transform: translateY(-50%); background: none; font-size: 15px; }
.camctl { display: flex; gap: 8px; }
.seg { display: flex; gap: 6px; min-width: 0; }
.camctl .seg:first-child { flex: 2 1 0; }
.camctl .seg:last-child { flex: 3 1 0; }
.seg button.ctl { flex: 1 1 0; min-width: 0; min-height: 48px; padding: 4px 2px; font-size: 15px; }
#camGo { flex: none; min-height: 52px; }
.field { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 14px; color: var(--text-dim); }
.field input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 10px;
  background: var(--bg-panel);
  color: var(--text);
  /* 16px keeps iOS from zooming the page when the field takes focus. */
  font: inherit;
  font-size: 16px;
  user-select: text;
  -webkit-user-select: text;
}
/*
 * T1647b TRIAL — DELETED WHEN THE OWNER HAS CHOSEN (with TOUCH_MODES and the trial block of
 * the script). Everything a mode changes in what is drawn, or in what the browser is told
 * to do with a touch, is here, under a class the script puts on the body.
 */
/* K: the KNOB — the part of a slider or a fader that takes a touch, drawn as wide as it is
   to a finger (56 px is GRIP, and the clamp() is knobAt: the knob is whole at both ends) —
   and a pad that scrolls from everywhere but its puck, whose own hit area is GRIP across. */
.grip { display: none; }
body.knobs .grip {
  display: block;
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: clamp(28px, var(--at), calc(100% - 28px));
  width: 56px;
  margin-left: -28px;
  border: 2px solid var(--signal);
  border-radius: 9px;
  background: color-mix(in srgb, var(--signal) 20%, transparent);
  pointer-events: none;
  /* UNDER the caption's and the value's chips, as the handle is (.board .w.slider > .cap):
     drawn above them it covered the caption wherever the value sat under the text. */
}
body.knobs .fader.driven .grip { display: none; }
body.knobs .ctl.pad, body.knobs .board .w.xyPad { touch-action: pan-y; }
body.knobs .pad .puck { pointer-events: auto; touch-action: none; }
body.knobs .pad .puck::after { content: ""; position: absolute; inset: -13px; }
/* G: the rail of §T1607b as a STRIP a thumb wide (GRIP), on every view that scrolls, on the side chosen. */
body.gutter.railed { --rail: 52px; }
body.gutter #rail { width: calc(56px + env(safe-area-inset-right)); }
body.gutter #rail .railthumb { left: 25px; }
body.railleft {
  padding-right: calc(var(--pad) + env(safe-area-inset-right));
  padding-left: calc(var(--pad) + var(--rail) + env(safe-area-inset-left));
}
body.railleft #rail { right: auto; left: 0; width: calc(56px + env(safe-area-inset-left)); border-left: 0; border-right: 1px solid var(--line); }
body.railleft #rail .railthumb { left: auto; right: 25px; }
/* L: the SWITCH, at the left end of the tab bar — fixed, so it is in reach scrolled or not,
   upright or sideways. In Scroll the board takes no touch at all (a touch falls through to
   the page, which scrolls) and is dimmed; the tab bar and the pager answer as ever. */
#lock {
  position: fixed;
  left: 0;
  bottom: 0;
  z-index: 4;
  width: calc(60px + env(safe-area-inset-left));
  height: calc(var(--bar) + 1px + env(safe-area-inset-bottom));
  padding: 6px 4px calc(6px + env(safe-area-inset-bottom)) calc(4px + env(safe-area-inset-left));
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 2px;
  border: 0;
  border-top: 1px solid var(--line);
  border-right: 1px solid var(--line);
  background: var(--bg-panel);
  color: var(--text-dim);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
}
#lock span { display: block; padding: 3px 0; border-radius: 7px; }
#lock[aria-pressed="false"] .play, #lock[aria-pressed="true"] .scroll { background: var(--bg-raise); color: var(--text); box-shadow: inset 0 0 0 1px var(--signal); }
body.locking #tabs { padding-left: calc(68px + env(safe-area-inset-left)); }
body.scrollonly #panels { pointer-events: none; }
body.scrollonly #panels .w { opacity: 0.45; }
/* The two choices, at the right end of the tab bar: a native select lies over each line. */
#trial {
  position: fixed;
  right: 0;
  bottom: 0;
  z-index: 4;
  width: calc(64px + env(safe-area-inset-right));
  height: calc(var(--bar) + 1px + env(safe-area-inset-bottom));
  padding: 4px env(safe-area-inset-right) calc(4px + env(safe-area-inset-bottom)) 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--line);
  border-left: 1px solid var(--line);
  background: var(--bg-panel);
}
#trial label { position: relative; flex: 1 1 0; display: flex; align-items: center; justify-content: space-between; gap: 4px; padding: 0 6px; color: var(--text-dim); font-size: 11px; }
#trial b { color: var(--text); font-size: 13px; }
#trial select { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; font-size: 16px; }
#tabs { padding-right: calc(72px + env(safe-area-inset-right)); }
`;

/**
 * T1607b — THE PAGE'S GESTURE AND PAGING RULES, as plain functions of numbers: no DOM, no
 * state. They are the first thing inside the client below, and `phone-page.test.ts` runs
 * this same string on its own, so each rule is tested as the bytes the phone runs.
 *
 * `SLOP` is how far a touch travels along a control before the control takes it. It is
 * deliberately ABOVE the distance at which a browser decides a touch is a scroll (8 dp on
 * Android, 10 pt on iOS): by the time a control moves, the browser has already had its say,
 * so a control never starts and is then cancelled. `PRESS_MS` is iOS's own wait before a
 * touch inside a scroll view is the content's (`delaysContentTouches`).
 */
export const PHONE_PAGE_LOGIC = String.raw`
  var SLOP = 12;
  var PRESS_MS = 150;

  function tidy(v) { return parseFloat(v.toPrecision(12)); }

  /*
   * T1647b TRIAL — DELETED WHEN THE OWNER HAS CHOSEN. §T1607b's rule (a slider takes a touch
   * anywhere along it once it has gone SLOP sideways) failed in the owner's hand: "still
   * pretty hard to not screw with the sliders when scrolling on mobile". It was reasoned
   * from browsers' rules and never held; so is anything written here. These are the
   * candidates, to be TRIED on a phone in one sitting: one row stays, and the table, the
   * Touch control that picks from it and every branch that reads a field nobody uses go.
   *
   * A mode says what must be true BEFORE a slider, fader or XY pad may take a touch. What
   * happens after is the same in all of them: SLOP of travel the control's way takes it,
   * and the value moves by the travel from there (claims, nudge).
   *
   *   from   "knob": the touch must LAND on the control's knob — its handle, or a pad's
   *          puck — and the rest of the control is the page's to scroll. "any": anywhere.
   *   rest   ms the finger must first rest where it landed, within REST px. A finger that
   *          moves sooner is let go: it scrolls. 0: no wait.
   *   strip  "right" | "left": that edge of every view that scrolls is a strip that only
   *          ever scrolls; the board is inset beside it. "": none.
   *   lock   the page has a Play / Scroll switch; in Scroll no control answers.
   *
   * A combination is one more row. K with the strip on the left would be
   * { letter: "K+G", from: "knob", rest: 0, strip: "left", lock: false }.
   */
  var TOUCH_MODES = {
    knob: { letter: "K", says: "Knob only: drag from the handle", from: "knob", rest: 0, strip: "", lock: false },
    hold: { letter: "H", says: "Hold to grab: rest, then drag", from: "any", rest: 200, strip: "", lock: false },
    lock: { letter: "L", says: "Lock: a Play / Scroll switch", from: "any", rest: 0, strip: "", lock: true },
    gutter: { letter: "G", says: "Scroll strip on the right", from: "any", rest: 0, strip: "right", lock: false },
    gutterleft: { letter: "G", says: "Scroll strip on the left", from: "any", rest: 0, strip: "left", lock: false },
    now: { letter: "A", says: "As before: drag anywhere", from: "any", rest: 0, strip: "", lock: false },
    knobgutter: { letter: "K+G", says: "Knob only, and a strip on the right", from: "knob", rest: 0, strip: "right", lock: false },
    knobhold: { letter: "K+H", says: "Knob only, after a short rest", from: "knob", rest: 100, strip: "", lock: false }
  };
  var TOUCH_DEFAULT = "knob";
  /*
   * REST: how far a resting finger may wander and still be resting — Android's own touch
   * slop, 8 dp. The rests themselves: 200 ms is between the 150 ms iOS holds a touch back
   * inside a scroll view and the 250 ms the web's drag libraries wait before a press is a
   * grab; the short one is Android's 100 ms tap timeout, the least that tells a press from
   * the start of a scroll.
   *
   * GRIP: how wide a knob is to a finger — and a strip to a thumb. 56 px is 9 mm, the size
   * measured as enough for a thumb (9.2 mm, Parhi, Karlson and Bederson 2006), above Apple's
   * 44 pt and Material's 48 dp minimums. It is NOT the row's height: a row may be lower.
   */
  var REST = 8;
  var GRIP = 56;

  /*
   * Where a knob's hit area is centred, px along a track that is length px long, for a
   * value share of the way along it: on the value, but kept whole inside the track, so at
   * either end the knob is the last GRIP px. The page draws it with the same rule (.grip).
   */
  function knobAt(share, length) {
    var half = GRIP / 2, at = share * length;
    if (at > length - half) at = length - half;
    return at < half ? half : at;
  }
  /* Is a touch at a on that knob, centred at b? */
  function grips(a, b) { return Math.abs(a - b) <= GRIP / 2; }

  /*
   * Is a touch that has travelled (dx, dy) px since it landed on a control the control's?
   * A slider or fader ("x") takes it once it has gone SLOP along the track AND further
   * along than across — the browser's own rule for "this is not a vertical scroll". A pad
   * ("xy") owns both axes: any SLOP of travel.
   */
  function claims(axes, dx, dy) {
    var ax = Math.abs(dx), ay = Math.abs(dy);
    if (axes === "xy") return ax * ax + ay * ay >= SLOP * SLOP;
    return ax >= SLOP && ax > ay;
  }

  /*
   * RELATIVE DRAG: a value moved by a finger's travel along a track length px long that
   * spans min..max. It stops at the ends and forgets the overshoot, so a finger that comes
   * back moves the value at once.
   */
  function nudge(value, travel, length, min, max) {
    var lo = Math.min(min, max), hi = Math.max(min, max);
    var v = value + (travel / Math.max(length, 1)) * (max - min);
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* What a slider shows and sends for a dragged value: on its step, inside its range. */
  function settle(v, step, min, max) {
    if (step > 0) v = Math.round(v / step) * step;
    var lo = Math.min(min, max), hi = Math.max(min, max);
    return tidy(v < lo ? lo : v > hi ? hi : v);
  }

  /*
   * A BOARD'S LABELLED SECTIONS, AS PAGES. cells is the board as drawn: { label, x, y, w, h }
   * in whole grid cells, label a string for a label and null for a control. A control
   * belongs to the nearest label above it that it overlaps across (the most overlap wins,
   * then the one placed first). A page is the box round one label and its controls, and
   * names its cells by index; pages run left to right, then down, the way sections drawn
   * as columns read. Fewer than two labels with controls: no pages — the board is one
   * page already.
   */
  function pagesOf(cells) {
    var pages = [];
    var byLabel = {};
    cells.forEach(function (cell, index) {
      if (cell.label !== null) return;
      var best = -1, bestBottom = -1, bestOver = 0;
      cells.forEach(function (label, at) {
        if (label.label === null || label.label === "") return;
        var over = Math.min(cell.x + cell.w, label.x + label.w) - Math.max(cell.x, label.x);
        var bottom = label.y + label.h;
        if (over <= 0 || bottom > cell.y) return;
        if (bottom > bestBottom || (bottom === bestBottom && over > bestOver)) { best = at; bestBottom = bottom; bestOver = over; }
      });
      if (best < 0) return;
      var page = byLabel[best];
      if (!page) {
        var head = cells[best];
        page = byLabel[best] = { name: head.label, at: best, x: head.x, y: head.y, right: head.x + head.w, bottom: head.y + head.h, cells: [best] };
        pages.push(page);
      }
      page.cells.push(index);
      page.x = Math.min(page.x, cell.x);
      page.y = Math.min(page.y, cell.y);
      page.right = Math.max(page.right, cell.x + cell.w);
      page.bottom = Math.max(page.bottom, cell.y + cell.h);
    });
    if (pages.length < 2) return [];
    pages.sort(function (a, b) {
      var p = cells[a.at], q = cells[b.at];
      return p.x - q.x || p.y - q.y || a.at - b.at;
    });
    return pages.map(function (p) { return { name: p.name, x: p.x, y: p.y, w: p.right - p.x, h: p.bottom - p.y, cells: p.cells }; });
  }
`;

/**
 * The client. Plain ES2017, no template literals, so it can sit inside `String.raw` as is.
 * `CONFIG` is declared ahead of it by `phonePageHtml` from the protocol's constants.
 */
const CLIENT = String.raw`
(function () {
  "use strict";
${PHONE_PAGE_LOGIC}
  var EXPIRED = CONFIG.expired;
  var token = new URLSearchParams(location.search).get(CONFIG.param) || "";
  var query = "?" + CONFIG.param + "=" + encodeURIComponent(token);
  var panelsEl = document.getElementById("panels");
  var statusEl = document.getElementById("status");
  var noticeEl = document.getElementById("notice");

  var lastSeq = -Infinity;
  var snapshot = null;
  var signature = "";
  var stopped = false;
  var views = {};      // handle -> { widget, el, update }
  var overrides = {};  // handle -> { values, acked }: what a finger set, shown over snapshots
  var drags = {};      // pointerId -> a touch that began on a control (T1607b, see touch())
  var rule = TOUCH_MODES[TOUCH_DEFAULT];  // T1647b trial: the mode in force (applyTrial)
  var playing = true;  // T1647b trial (L): false while the lock says Scroll
  var wanted = {};     // handle -> latest live values, waiting for the next frame
  var frameAsked = false;
  var queue = [];      // [{ handle, live, commit }] in send order; latest value per slot only
  var inFlight = false;
  var noticeTimer = 0;
  var refusals = {};   // handle -> { line, timer }: Loom's sentence for a refused press, on its control
  var REFUSED_MS = 3000;
  var source = null;
  var phone = "";      // this stream's id, from its "hello"; every write names it

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function format(v) {
    var m = Math.abs(v);
    return m >= 100 ? v.toFixed(0) : m >= 10 ? v.toFixed(1) : v.toFixed(2);
  }

  /* ---------------------------------------------------------------- status and notices */

  function setStatus(text) {
    statusEl.textContent = text;
    statusEl.hidden = text === "";
  }
  function flash(text) {
    if (stopped) return;
    noticeEl.textContent = text;
    noticeEl.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(function () { noticeEl.hidden = true; }, 4000);
  }
  function stop(reason) {
    if (stopped) return;
    stopped = true;
    clearTimeout(noticeTimer);
    queue = [];
    wanted = {};
    drags = {};
    if (source) source.close();
    // T1397b: the door is gone, and with it the page the camera was sending to.
    camStop(false, "");
    setStatus("");
    noticeEl.textContent = reason;
    noticeEl.className = "final";
    noticeEl.hidden = false;
    document.body.classList.add("stopped");
  }

  /* ---------------------------------------------------------------------------- writes */

  function lastEntry(handle) {
    for (var i = queue.length - 1; i >= 0; i--) if (queue[i].handle === handle) return queue[i];
    return null;
  }
  function openEntry(handle) {
    var e = lastEntry(handle);
    if (e === null || e.commit !== null) {
      e = { handle: handle, live: null, commit: null };
      queue.push(e);
    }
    return e;
  }
  function pending(handle) { return lastEntry(handle) !== null || wanted[handle] !== undefined; }

  function wantLive(handle, values) {
    if (stopped) return;
    wanted[handle] = values;
    if (!frameAsked) {
      frameAsked = true;
      requestAnimationFrame(onFrame);
    }
  }
  function onFrame() {
    frameAsked = false;
    for (var h in wanted) openEntry(h).live = wanted[h];
    wanted = {};
    pump();
  }
  function commit(handle, values) {
    if (stopped) return;
    clearRefusals();
    if (wanted[handle] !== undefined) {
      openEntry(handle).live = wanted[handle];
      delete wanted[handle];
    }
    openEntry(handle).commit = values;
    pump();
  }
  /* Does a touch HOLD this control — one the control has taken, not one that only landed on it? */
  function holding(handle) {
    for (var id in drags) if (drags[id].handle === handle && drags[id].live) return true;
    return false;
  }
  function acknowledged(handle) {
    if (holding(handle)) return;
    if (pending(handle)) return;
    if (overrides[handle]) overrides[handle].acked = true;
  }

  function pump() {
    // No id yet (or the last one was refused): hold the queue until the stream says hello.
    if (inFlight || stopped || queue.length === 0 || phone === "") return;
    var e = queue[0];
    var set;
    if (e.live !== null) {
      set = { handle: e.handle, values: e.live, phase: "live" };
      e.live = null;
      if (e.commit === null) queue.shift();
    } else {
      set = { handle: e.handle, values: e.commit, phase: "commit" };
      queue.shift();
    }
    inFlight = true;
    fetch(CONFIG.set + query + "&" + CONFIG.peer + "=" + encodeURIComponent(phone), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(set),
    })
      .then(function (response) {
        if (response.status === 403) { stop(EXPIRED); return; }
        if (response.status === 409) {
          // The helper does not know this stream: put the write back, get a new id, resend.
          queue.unshift(set.phase === "live"
            ? { handle: set.handle, live: set.values, commit: null }
            : { handle: set.handle, live: null, commit: set.values });
          phone = "";
          connect();
          return;
        }
        if (response.ok) return;
        return response.text().then(
          function (text) { flash(text || "Loom refused that change."); },
          function () { flash("Loom refused that change."); }
        );
      }, function () {
        flash("Could not reach Loom — check the wifi.");
      })
      .then(function () {
        inFlight = false;
        if (set.phase === "commit") acknowledged(set.handle);
        pump();
      });
  }

  /* ------------------------------------------------------- refused presses (T1526b) */

  /*
   * Loom tells THIS phone when it refused a press: the control (the handle the snapshot
   * gave) and its sentence. The sentence hangs under the control for REFUSED_MS, out of
   * flow so nothing else moves, and the control is outlined. Out of flow means OVER what
   * is below it, so the next press — on any control — takes every sentence away: the
   * person has moved on, and the control they are pressing may be the one under it. A
   * newer refusal of the same control replaces its sentence; a redraw of the page keeps it.
   */
  function own(map, key) { return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined; }
  function clearRefusal(handle) {
    var r = own(refusals, handle);
    if (!r) return;
    clearTimeout(r.timer);
    delete refusals[handle];
    if (r.line.parentNode) r.line.parentNode.removeChild(r.line);
    var v = own(views, handle);
    if (v) v.el.classList.remove("refused");
  }
  function clearRefusals() {
    for (var h in refusals) clearRefusal(h);
  }
  function drawRefusal(handle) {
    var r = own(refusals, handle);
    var v = own(views, handle);
    if (!r || !v) return;
    v.el.classList.add("refused");
    v.el.appendChild(r.line);
    // A control on the right half of the screen hangs its sentence leftwards, onto the screen.
    var rect = box(v.el);
    r.line.classList.toggle("end", rect.left + rect.width / 2 > window.innerWidth / 2);
  }
  function onRefused(event) {
    var reason = String(event.reason || "") || "Loom refused that.";
    var handle = typeof event.handle === "string" ? event.handle : "";
    var v = own(views, handle);
    // Nothing on this page to say it on (the control is no longer published): the notice.
    if (!v) { flash(reason); return; }
    clearRefusal(handle);
    var line = el("div", "said", reason);
    line.setAttribute("role", "alert");
    refusals[handle] = { line: line, timer: setTimeout(function () { clearRefusal(handle); }, REFUSED_MS) };
    drawRefusal(handle);
    // What the finger drew ahead of Loom's answer is not what the document holds: back to
    // the snapshot's — unless the finger is still down, or a later write of it is on its way.
    if (holding(handle)) return;
    if (pending(handle)) return;
    delete overrides[handle];
    redraw(handle);
  }

  /* --------------------------------------------------------------------------- widgets */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }
  function current(handle) {
    var v = views[handle];
    var o = overrides[handle];
    var out = {};
    for (var k in v.widget) out[k] = v.widget[k];
    if (o) for (var j in o.values) out[j] = o.values[j];
    return out;
  }
  function setLocal(handle, values) {
    var o = overrides[handle];
    if (!o) o = overrides[handle] = { values: {}, acked: false };
    o.acked = false;
    for (var k in values) o.values[k] = values[k];
    redraw(handle);
  }
  function box(node) { return node.getBoundingClientRect(); }
  function share(v, min, max) { return max === min ? 0 : clamp01((v - min) / (max - min)); }
  /* B269: a handle s% of the way along its track — and back by s% of its own width, so it is whole at both ends. */
  function handleAt(thumb, s) {
    thumb.style.left = s + "%";
    thumb.style.transform = "translateX(-" + s + "%)";
  }
  /*
   * B269: THE REACH. On a board a control answers from half the gap round what is drawn of
   * it (the stylesheet's ::before on the item, REACH px = half of --gap). A touch there
   * lands on the ITEM, not on the control inside it — so the item hands on exactly those:
   * events whose target is the item itself.
   */
  var REACH = 3;
  function reach(root, type, handle) {
    root.addEventListener(type, function (event) { if (event.target === root) handle(event); });
  }

  function capture(target, event) {
    try { if (target.setPointerCapture) target.setPointerCapture(event.pointerId); } catch (x) { /* already gone */ }
  }

  function buildSlider(w) {
    var root = el("div", "w slider");
    var cap = el("div", "cap");
    var name = el("span", "name", w.caption);
    var val = el("span", "val");
    cap.appendChild(name);
    cap.appendChild(val);
    var track = el("div", "ctl track");
    track.setAttribute("role", "slider");
    track.setAttribute("aria-label", w.caption);
    var fill = el("div", "fill");
    var thumb = el("div", "thumb");
    var grip = el("div", "grip");
    track.appendChild(fill);
    track.appendChild(thumb);
    track.appendChild(grip);
    root.appendChild(cap);
    root.appendChild(track);
    var view = { widget: w, el: root, target: track };
    view.update = function () {
      var c = current(w.handle);
      var s = share(c.value, c.min, c.max) * 100;
      fill.style.width = s + "%";
      handleAt(thumb, s);
      grip.style.setProperty("--at", s + "%");
      val.textContent = format(c.value);
      track.setAttribute("aria-valuemin", String(c.min));
      track.setAttribute("aria-valuemax", String(c.max));
      track.setAttribute("aria-valuenow", String(c.value));
    };
    // T1607b: what a drag needs of a control — where it starts (unrounded), where a
    // finger's travel takes it, and what that shows and sends.
    view.axes = "x";
    view.raw = function () { return { value: current(w.handle).value }; };
    view.nudged = function (raw, dx) {
      var c = views[w.handle].widget;
      return { value: nudge(raw.value, dx, box(views[w.handle].target).width, c.min, c.max) };
    };
    view.shown = function (raw) {
      var c = views[w.handle].widget;
      return { value: settle(raw.value, c.step, c.min, c.max) };
    };
    // T1647b trial (K): did this touch land on the knob — the drawn grip, GRIP wide round the value?
    view.onKnob = function (event) {
      var c = current(w.handle);
      var r = box(views[w.handle].target);
      return grips(event.clientX - r.left, knobAt(share(c.value, c.min, c.max), r.width));
    };
    track.addEventListener("pointerdown", function (event) { touch(w.handle, event, track, "drag"); });
    reach(root, "pointerdown", function (event) { touch(w.handle, event, track, "drag"); });
    return view;
  }

  function buildPad(w) {
    var root = el("div", "w xyPad");
    var cap = el("div", "cap");
    var val = el("span", "val");
    cap.appendChild(el("span", "name", w.caption));
    cap.appendChild(val);
    var pad = el("div", "ctl pad");
    pad.setAttribute("role", "group");
    pad.setAttribute("aria-label", w.caption);
    var puck = el("div", "puck");
    pad.appendChild(puck);
    root.appendChild(cap);
    root.appendChild(pad);
    var view = { widget: w, el: root, target: pad };
    view.update = function () {
      var c = current(w.handle);
      puck.style.left = share(c.x, c.min, c.max) * 100 + "%";
      puck.style.top = (1 - share(c.y, c.min, c.max)) * 100 + "%";
      val.textContent = format(c.x) + ", " + format(c.y);
    };
    view.axes = "xy";
    view.raw = function () { var c = current(w.handle); return { x: c.x, y: c.y }; };
    view.nudged = function (raw, dx, dy) {
      var c = views[w.handle].widget;
      var r = box(views[w.handle].target);
      // y up: a finger moving up the screen raises it.
      return { x: nudge(raw.x, dx, r.width, c.min, c.max), y: nudge(raw.y, -dy, r.height, c.min, c.max) };
    };
    view.shown = function (raw) { return { x: tidy(raw.x), y: tidy(raw.y) }; };
    // T1647b trial (K): on the puck — GRIP across, round where it is drawn.
    view.onKnob = function (event) {
      var c = current(w.handle);
      var r = box(views[w.handle].target);
      return grips(event.clientX - r.left, share(c.x, c.min, c.max) * r.width) &&
        grips(event.clientY - r.top, (1 - share(c.y, c.min, c.max)) * r.height);
    };
    pad.addEventListener("pointerdown", function (event) { touch(w.handle, event, pad, "drag"); });
    reach(root, "pointerdown", function (event) { touch(w.handle, event, pad, "drag"); });
    return view;
  }

  function buildToggle(w) {
    var root = el("div", "w toggle");
    var b = el("button", "ctl");
    b.type = "button";
    var label = el("span", "name", w.caption);
    var state = el("span", "state");
    b.appendChild(label);
    b.appendChild(state);
    root.appendChild(b);
    var view = { widget: w, el: root, target: b };
    view.update = function () {
      var on = current(w.handle).on === true;
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      state.textContent = on ? "On" : "Off";
    };
    function flip() {
      if (stopped) return;
      var next = !(current(w.handle).on === true);
      setLocal(w.handle, { on: next });
      commit(w.handle, { on: next });
    }
    b.addEventListener("click", flip);
    reach(root, "click", flip);
    return view;
  }

  function buildButton(w) {
    var root = el("div", "w button");
    var b = el("button", "ctl");
    b.type = "button";
    var state = el("span", "state");
    b.appendChild(el("span", "name", w.caption));
    b.appendChild(state);
    root.appendChild(b);
    var view = { widget: w, el: root, target: b };
    view.update = function () {
      var held = current(w.handle).held === true;
      b.classList.toggle("on", held);
      b.setAttribute("aria-pressed", held ? "true" : "false");
      state.textContent = held ? "Held" : "Press";
    };
    b.addEventListener("pointerdown", function (event) { touch(w.handle, event, b, "hold"); });
    reach(root, "pointerdown", function (event) { touch(w.handle, event, b, "hold"); });
    b.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    return view;
  }

  /*
   * T1607b: A TOUCH THAT LANDS ON A CONTROL IS NOT YET THE CONTROL'S, and writes nothing.
   * The browser may still take it for a scroll (touch-action: pan-y), and says so with
   * pointercancel. What makes it the control's — live, below — depends on the control:
   *
   *  "drag" (slider, fader, XY pad): once it has travelled far enough the control's way
   *    (claims). From THERE the value moves by the finger's travel, starting from what the
   *    control shows: it never jumps to the finger, and a tap on it does nothing.
   *  "hold" (momentary Button): once the finger has rested PRESS_MS. A shorter tap is a
   *    press sent on release, inside the button; a scroll that starts first sends nothing.
   *
   * A touch the browser takes back after that (pointercancel) ends where it is: the value
   * the hand moved it to stays (Android's rule for a SeekBar), a held button lets go.
   *
   * T1647b trial: before any of that a "drag" control must be ALLOWED the touch by the mode
   * in force (TOUCH_MODES): it landed on the knob, where the mode asks for that, and it has
   * rested, where the mode asks for that.
   */
  function touch(handle, event, target, mode) {
    if (stopped) return;
    // T1647b trial (K): a touch that lands off the knob is never the control's. Nothing is
    // kept of it and nothing is asked of the browser: the page scrolls from there.
    if (mode === "drag" && rule.from === "knob" && !views[handle].onKnob(event)) return;
    event.preventDefault();
    capture(target, event);
    var id = event.pointerId;
    var d = { handle: handle, target: target, mode: mode, x: event.clientX, y: event.clientY, rested: mode === "hold" || rule.rest === 0, live: false, raw: null, last: null, moved: false, timer: 0 };
    drags[id] = d;
    if (mode !== "hold") {
      // T1647b trial (H): the control may take this touch only once the finger has rested
      // on it; the outline arriving is how the hand is told that it has.
      if (!d.rested) d.timer = setTimeout(function () {
        if (drags[id] !== d || stopped) return;
        d.rested = true;
        d.target.classList.add("held");
      }, rule.rest);
      return;
    }
    d.timer = setTimeout(function () {
      if (drags[id] !== d || stopped || !views[handle]) return;
      take(d);
      setLocal(handle, { held: true });
      wantLive(handle, { held: true });
    }, PRESS_MS);
  }
  function take(d) {
    d.live = true;
    clearRefusals();
    d.target.classList.add("held");
  }
  function same(a, b) {
    for (var k in a) if (a[k] !== b[k]) return false;
    return true;
  }
  /* The finger went on to here: move the value by that travel. True when what the control shows changed. */
  function slide(d, v, event) {
    d.raw = v.nudged(d.raw, event.clientX - d.x, event.clientY - d.y);
    d.x = event.clientX;
    d.y = event.clientY;
    var values = v.shown(d.raw);
    if (same(values, d.last)) return false;
    d.last = values;
    d.moved = true;
    setLocal(d.handle, values);
    return true;
  }
  window.addEventListener("pointermove", function (event) {
    var d = drags[event.pointerId];
    var v = d ? views[d.handle] : null;
    if (!d || stopped || !v || d.mode === "hold") return;
    if (d.live) {
      if (slide(d, v, event)) wantLive(d.handle, d.last);
      return;
    }
    var dx = event.clientX - d.x, dy = event.clientY - d.y;
    if (!d.rested) {
      // T1647b trial (H): it moved before it had rested, so it is not grabbing. Let it go.
      if (dx * dx + dy * dy > REST * REST) {
        clearTimeout(d.timer);
        delete drags[event.pointerId];
      }
      return;
    }
    if (!claims(v.axes, dx, dy)) return;
    take(d);
    d.raw = v.raw();
    d.last = v.shown(d.raw);
    d.x = event.clientX;
    d.y = event.clientY;
  });
  /* Is the pointer on this control — what is drawn of it, or its reach (B269)? */
  function inside(target, event) {
    var r = box(target);
    return event.clientX >= r.left - REACH && event.clientX <= r.right + REACH && event.clientY >= r.top - REACH && event.clientY <= r.bottom + REACH;
  }
  function end(event, cancelled) {
    var d = drags[event.pointerId];
    if (!d) return;
    delete drags[event.pointerId];
    clearTimeout(d.timer);
    d.target.classList.remove("held");
    var v = views[d.handle];
    if (stopped || !v) return;
    if (d.mode === "hold") {
      if (!d.live) {
        // A tap. A cancel is the browser scrolling; a lift outside the button is a change of mind.
        if (cancelled || !inside(d.target, event)) return;
        wantLive(d.handle, { held: true });
      }
      setLocal(d.handle, { held: false });
      commit(d.handle, { held: false });
      return;
    }
    if (!d.live) return;
    // A cancel carries no position: the value stays where the last move left it. A touch
    // that never changed what the control shows wrote nothing, and has nothing to commit.
    if (!cancelled) slide(d, v, event);
    if (d.moved) commit(d.handle, d.last);
  }
  window.addEventListener("pointerup", function (event) { end(event, false); });
  window.addEventListener("pointercancel", function (event) { end(event, true); });

  /* ------------------------------------------- banks, layers, cue lists (T1503b) */

  /*
   * A press is ONE commit. For a recall, a GO, a BACK and a standby nothing is drawn ahead
   * of Loom's answer: the lit preset and the cue names are the document's, and they change
   * when the next snapshot says so. A layer's switch and fader behave like a toggle and a
   * slider — shown at once, live then commit — and say the STATE asked for, never "flip".
   * The layouts are the desk's (board-fit.ts): the same rect shows the same parts.
   */
  function press(handle, values) {
    if (stopped) return;
    commit(handle, values);
  }
  function pressButton(cls, text) {
    var b = el("button", "press" + (cls ? " " + cls : ""), text);
    b.type = "button";
    return b;
  }
  function cells(rect, key) {
    var v = rect ? Math.floor(Number(rect[key])) : 1;
    return v === v && v >= 1 ? v : 1;
  }

  function buildPreset(w, rect) {
    var root = el("div", "w preset");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", w.caption);
    var names = Array.isArray(w.presets) ? w.presets : [];
    var rows = Math.max(1, Math.min(cells(rect, "h"), names.length));
    root.style.setProperty("--rows", String(rows));
    root.style.setProperty("--per", String(Math.max(1, Math.ceil(names.length / rows))));
    // B269: the buttons sit in a strip of their own, which scrolls sideways when their
    // names do not fit the rect; the item itself clips nothing.
    var strip = el("div", "strip");
    root.appendChild(strip);
    var buttons = names.map(function (name) {
      var b = pressButton("", String(name));
      b.setAttribute("data-preset", String(name));
      b.addEventListener("click", function () { press(w.handle, { recall: name }); });
      strip.appendChild(b);
      return b;
    });
    if (buttons.length === 0) strip.appendChild(el("span", "none", "No presets"));
    // The reach: a press in the strip's margin, above or below a button, is that button's.
    reach(strip, "click", function (event) {
      for (var i = 0; i < buttons.length; i++) if (inside(buttons[i], event)) { buttons[i].click(); return; }
    });
    var view = { widget: w, el: root };
    view.update = function () {
      var c = views[w.handle].widget;
      buttons.forEach(function (b) {
        var lit = b.getAttribute("data-preset") === c.current;
        b.classList.toggle("on", lit);
        b.classList.toggle("fading", lit && c.morphing === true);
        b.setAttribute("aria-pressed", lit ? "true" : "false");
      });
    };
    return view;
  }

  function buildLayer(w, rect) {
    var layout = cells(rect, "h") >= 2 ? "stacked" : cells(rect, "w") >= 4 ? "beside" : "switch";
    var root = el("div", "w layer");
    root.setAttribute("data-layout", layout);
    var sw = pressButton("sw");
    sw.appendChild(el("span", "lbl", w.caption));
    // T1526b: what the layer shows, beside its name.
    var pic = el("span", "pic");
    sw.appendChild(pic);
    var state = el("span", "state");
    sw.appendChild(state);
    root.appendChild(sw);
    var fader = null, fill = null, thumb = null, grip = null, val = null;
    if (layout !== "switch") {
      fader = el("div", "fader");
      fader.setAttribute("role", "slider");
      fader.setAttribute("aria-label", w.caption + " opacity");
      fader.setAttribute("aria-valuemin", "0");
      fader.setAttribute("aria-valuemax", "1");
      fill = el("div", "fill");
      thumb = el("div", "thumb");
      grip = el("div", "grip");
      val = el("span", "val");
      fader.appendChild(fill);
      fader.appendChild(thumb);
      fader.appendChild(grip);
      fader.appendChild(el("span", "lbl", "Opacity"));
      fader.appendChild(val);
      root.appendChild(fader);
      fader.addEventListener("pointerdown", function (event) {
        // Driven by the document: shown, and a finger does not move it.
        if (views[w.handle].widget.opacityWritable !== true) return;
        touch(w.handle, event, fader, "drag");
      });
    }
    var view = { widget: w, el: root, target: fader };
    view.update = function () {
      var c = current(w.handle);
      var on = c.on === true;
      sw.classList.toggle("on", on);
      sw.setAttribute("aria-pressed", on ? "true" : "false");
      state.textContent = on ? "On" : "Off";
      pic.textContent = typeof c.picture === "string" ? c.picture : "";
      pic.hidden = pic.textContent === "";
      if (fader === null) return;
      var free = c.opacityWritable === true;
      var s = free ? clamp01(c.opacity) * 100 : 0;
      fader.classList.toggle("driven", !free);
      fader.setAttribute("aria-disabled", free ? "false" : "true");
      if (free) fader.setAttribute("aria-valuenow", String(c.opacity));
      else fader.removeAttribute("aria-valuenow");
      fill.style.width = s + "%";
      handleAt(thumb, s);
      grip.style.setProperty("--at", s + "%");
      val.textContent = free ? format(c.opacity) : "driven";
    };
    view.axes = "x";
    view.raw = function () { return { opacity: clamp01(current(w.handle).opacity) }; };
    view.nudged = function (raw, dx) {
      return { opacity: nudge(raw.opacity, dx, box(views[w.handle].target).width, 0, 1) };
    };
    view.shown = function (raw) { return { opacity: tidy(raw.opacity) }; };
    // T1647b trial (K): on the fader's knob.
    view.onKnob = function (event) {
      var r = box(views[w.handle].target);
      return grips(event.clientX - r.left, knobAt(clamp01(current(w.handle).opacity), r.width));
    };
    sw.addEventListener("click", function () {
      if (stopped) return;
      var next = !(current(w.handle).on === true);
      setLocal(w.handle, { on: next });
      commit(w.handle, { on: next });
    });
    return view;
  }

  function buildCueList(w, rect) {
    var h = cells(rect, "h");
    var layout = h >= 2 ? "stacked" : cells(rect, "w") >= 6 ? "beside" : "buttons";
    var root = el("div", "w cueList");
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", w.caption);
    root.setAttribute("data-layout", layout);
    var now = null, next = null, nextNote = null;
    if (layout !== "buttons") {
      var line = el("div", "cues");
      now = el("span", "now");
      next = el("span", "next");
      // T1526b: the standby's note — what the operator wrote to read before pressing GO.
      nextNote = el("span", "note");
      line.appendChild(now);
      line.appendChild(el("span", "arrow", "▸"));
      line.appendChild(next);
      line.appendChild(nextNote);
      root.appendChild(line);
    }
    // Three rows or more: the list itself, a cue a row — a tap stands that cue by.
    var cueButtons = [];
    var cueNotes = [];
    var list = null;
    if (layout === "stacked" && h >= 3) {
      list = el("div", "cuelist");
      (Array.isArray(w.cues) ? w.cues : []).forEach(function (name) {
        var b = pressButton("cue", String(name));
        b.setAttribute("data-cue", String(name));
        b.addEventListener("click", function () { press(w.handle, { standby: name }); });
        var note = el("span", "note");
        b.appendChild(note);
        list.appendChild(b);
        cueButtons.push(b);
        cueNotes.push(note);
      });
      root.appendChild(list);
    }
    // §T1544b: the structure a following list switches at its cue times — a note, nothing to press.
    var structureNote = el("div", "structure");
    root.appendChild(structureNote);
    var bar = el("div", "gobar");
    var back = pressButton("back", "BACK");
    var go = pressButton("go", "GO");
    back.addEventListener("click", function () { press(w.handle, { back: true }); });
    go.addEventListener("click", function () { press(w.handle, { go: true }); });
    bar.appendChild(back);
    bar.appendChild(go);
    root.appendChild(bar);
    var view = { widget: w, el: root };
    view.update = function () {
      var c = views[w.handle].widget;
      // T1526b: one note per cue, in the order of the cues.
      var names = Array.isArray(c.cues) ? c.cues : [];
      var notes = Array.isArray(c.notes) ? c.notes : [];
      function noteOf(index) { return index >= 0 && typeof notes[index] === "string" ? notes[index] : ""; }
      // T1508b: a list that follows the timeline is shown, not driven: where the playhead
      // has it, with every press off and the reason on them.
      var following = c.following === true;
      root.setAttribute("data-following", following ? "true" : "false");
      if (now !== null) {
        now.textContent = (following ? "⏱ " : "") + (c.current || "—");
        next.textContent = c.next || "—";
        nextNote.textContent = noteOf(names.indexOf(c.next));
      }
      cueNotes.forEach(function (note, index) { note.textContent = noteOf(index); });
      var structure = following && Array.isArray(c.structure) ? c.structure : [];
      structureNote.textContent = structure.length > 0 ? "⏱ Switches at its cue times: " + structure.join(", ") : "";
      // What Loom would refuse is not offered: GO past the end, BACK before the first cue.
      go.disabled = c.canGo !== true;
      back.disabled = c.canBack !== true;
      var reason = following ? "Follows the timeline: move the playhead in Loom." : "";
      go.title = reason;
      back.title = reason;
      cueButtons.forEach(function (b) {
        b.disabled = following;
        b.title = reason;
        var name = b.getAttribute("data-cue");
        b.classList.toggle("on", name === c.current);
        b.classList.toggle("standby", name === c.next);
        b.setAttribute("aria-pressed", name === c.next ? "true" : "false");
      });
    };
    /*
     * T1526b: the list keeps its standby in view. It scrolls ITSELF (scrollTop), never the
     * page — a GO pressed at the desk must not move this phone's screen under a finger —
     * and only when Loom MOVED the standby: a list the owner scrolled stays where they
     * left it. A list not laid out yet (another tab is showing) waits until it is.
     */
    var followed;
    view.follow = function () {
      var c = views[w.handle].widget;
      if (list === null || c.next === followed || list.clientHeight === 0) return;
      followed = c.next;
      for (var i = 0; i < cueButtons.length; i++) {
        var b = cueButtons[i];
        if (b.getAttribute("data-cue") !== c.next) continue;
        if (b.offsetTop < list.scrollTop) list.scrollTop = b.offsetTop;
        else if (b.offsetTop + b.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = b.offsetTop + b.offsetHeight - list.clientHeight;
      }
    };
    return view;
  }

  var BUILDERS = {
    slider: buildSlider,
    toggle: buildToggle,
    button: buildButton,
    xyPad: buildPad,
    preset: buildPreset,
    layer: buildLayer,
    cueList: buildCueList,
  };

  /* ------------------------------------------------------------------------- snapshots */

  /* A Panel's board (T1516b) when it carries a usable one; its rows otherwise. */
  function boardOf(p) { return p.board && Array.isArray(p.board.items) ? p.board : null; }
  function widgetsOf(p) {
    var out = [];
    var board = boardOf(p);
    if (board) board.items.forEach(function (item) { if (item.kind === "widget" && item.widget) out.push(item.widget); });
    else (p.rows || []).forEach(function (r) { if (r.kind === "widgets") r.widgets.forEach(function (w) { out.push(w); }); });
    return out;
  }

  function shape(panels) {
    return JSON.stringify(panels.map(function (p) {
      var board = boardOf(p);
      if (board) {
        return [p.title, board.columns, board.items.map(function (item) {
          var r = item.rect || {};
          var w = item.widget || {};
          // T1503b: a bank's presets and a list's cues are its buttons — a new name redraws.
          return [item.kind, r.x, r.y, r.w, r.h, item.text, w.kind, w.handle, w.caption, w.presets, w.cues];
        })];
      }
      return [p.title, (p.rows || []).map(function (r) {
        return r.kind === "widgets"
          ? r.widgets.map(function (w) { return [w.kind, w.handle, w.caption]; })
          : [r.kind, r.text];
      })];
    }));
  }

  /* T1526b: every cue list on the page keeps its standby in view (see buildCueList). */
  function follow() {
    for (var h in views) if (views[h].follow) views[h].follow();
  }

  /*
   * T1669b: A CONTROL IS REDRAWN WHEN WHAT IT SHOWS HAS CHANGED, and not otherwise.
   *
   * Loom answers every value a finger sends with a snapshot of EVERY published control, at
   * the rate the finger moves. Each one used to redraw them all: on a project of 55
   * controls, 202 DOM writes for every move of one slider (measured, T1669b), 194 of them
   * on controls nothing had happened to, and as much script again as the move itself.
   *
   * What a control shows is current(handle): what the last snapshot says of it, under what
   * a finger has drawn ahead of Loom. redraw() is the ONE way a view is drawn after it is
   * built, and it draws only when that has changed since the view last drew. So a snapshot
   * that says nothing new of a control writes nothing; the echo of a finger's own move
   * writes nothing either (the finger's drawing stands over it); and a control whose
   * finger-drawn value Loom has answered goes to the snapshot's, because what it shows
   * changed when the finger's drawing was let go.
   */
  function redraw(handle) {
    var v = views[handle];
    var now = JSON.stringify(current(handle));
    if (now === v.drew) return;
    v.drew = now;
    v.update();
  }

  function place(handle, w, rect) {
    var build = BUILDERS[w.kind];
    if (!build) return null;
    var view = build(w, rect);
    views[handle] = view;
    redraw(handle);
    // T1526b: a refusal still showing stays on its control through a redraw.
    drawRefusal(handle);
    return view.el;
  }

  function drawRows(section, rows) {
    rows.forEach(function (r) {
      if (r.kind === "heading") section.appendChild(el("h2", "", r.text));
      else if (r.kind === "text") section.appendChild(el("p", "", r.text));
      else if (r.kind === "widgets") {
        var row = el("div", "row");
        r.widgets.forEach(function (w) {
          var node = place(w.handle, w);
          if (node) row.appendChild(node);
        });
        section.appendChild(row);
      }
    });
  }

  /*
   * T1517b: the board on a grid of square cells. A rect is in whole cells from the top-left
   * one; it becomes grid lines (1-based) and spans, kept inside the board's columns.
   */
  function whole(v, lo, hi) {
    v = Math.floor(Number(v));
    if (!(v === v)) v = lo;
    return v < lo ? lo : v > hi ? hi : v;
  }
  function drawBoard(section, board) {
    var cols = whole(board.columns, 1, 64);
    var wrap = el("div", "boardwrap");
    var grid = el("div", "board");
    // T1607b: what is drawn where, kept so a page can show a section of it (lay).
    var cells = [];
    board.items.forEach(function (item) {
      var node = null;
      if (item.kind === "label") {
        // B269: the text in a span of its own, which elides (a bare text node wraps and is cut).
        node = el("div", "label");
        node.appendChild(el("span", "", String(item.text || "")));
      }
      else if (item.kind === "widget" && item.widget) node = place(item.widget.handle, item.widget, item.rect);
      if (node === null) return;
      var r = item.rect || {};
      var x = whole(r.x, 0, cols - 1);
      cells.push({
        node: node,
        label: item.kind === "label" ? String(item.text || "").trim() : null,
        x: x,
        y: whole(r.y, 0, 9999),
        w: whole(r.w, 1, cols - x),
        h: whole(r.h, 1, 9999)
      });
      grid.appendChild(node);
    });
    wrap.appendChild(grid);
    section.appendChild(wrap);
    return { grid: grid, cols: cols, cells: cells, pages: pagesOf(cells) };
  }

  /* ----------------------------------------------------- pages and the rail (T1607b) */

  /*
   * PAGES. A board with labelled sections (pagesOf) can be shown one section at a time:
   * the pager above the tab bar offers All — the board as its owner drew it — and a page
   * per label. A page is the same grid with the other cells hidden and its own moved to
   * its top-left corner, so ITS columns fill the width; no control is built twice, and one
   * that is held keeps its touch. The phone remembers the page per Panel (by name, like the
   * tab: a section that is gone shows All without forgetting the choice) and, for this
   * visit, how far every tab and page was scrolled.
   */
  var pagerEl = document.getElementById("pager");
  var railEl = document.getElementById("rail");
  var railThumb = railEl.firstChild;
  var boards = {};     // tab key -> what drawBoard returned
  var pageChosen = readPages();
  var offsets = {};    // view (tab + page) -> how far it was scrolled
  var viewShown = "";  // the view showing now
  var tabShown = "";   // the tab showing now

  function readPages() {
    try {
      var kept = JSON.parse(localStorage.getItem(CONFIG.pageKey) || "{}");
      return kept && typeof kept === "object" && !Array.isArray(kept) ? kept : {};
    } catch (x) { return {}; }
  }
  function keepPages() {
    try { localStorage.setItem(CONFIG.pageKey, JSON.stringify(pageChosen)); } catch (x) { /* storage off: this visit only */ }
  }
  function pageOf(tab) {
    var board = own(boards, tab);
    var name = own(pageChosen, tab);
    if (!board || typeof name !== "string") return null;
    for (var i = 0; i < board.pages.length; i++) if (board.pages[i].name === name) return board.pages[i];
    return null;
  }
  function lay(board, page) {
    board.grid.style.setProperty("--cols", String(page ? page.w : board.cols));
    board.cells.forEach(function (cell, index) {
      var on = page === null || page.cells.indexOf(index) >= 0;
      cell.node.hidden = !on;
      if (!on) return;
      cell.node.style.gridColumn = (cell.x - (page ? page.x : 0) + 1) + " / span " + cell.w;
      cell.node.style.gridRow = (cell.y - (page ? page.y : 0) + 1) + " / span " + cell.h;
    });
  }
  function showPager(tab) {
    var board = own(boards, tab);
    var pages = board ? board.pages : [];
    var page = pageOf(tab);
    pagerEl.textContent = "";
    pagerEl.hidden = pages.length === 0;
    document.body.classList.toggle("paged", pages.length > 0);
    if (board) lay(board, page);
    if (pages.length === 0) return;
    // Chip 0 is All; chip n is pages[n - 1].
    [null].concat(pages).forEach(function (p, index) {
      var b = el("button", "", p ? p.name : "All");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-page", String(index));
      b.setAttribute("aria-selected", p === page ? "true" : "false");
      pagerEl.appendChild(b);
    });
  }
  pagerEl.addEventListener("click", function (event) {
    var b = event.target && event.target.closest ? event.target.closest("button[data-page]") : null;
    var board = own(boards, tabShown);
    if (b === null || !board) return;
    var page = board.pages[Number(b.getAttribute("data-page")) - 1];
    leave();
    if (page) pageChosen[tabShown] = page.name;
    else delete pageChosen[tabShown];
    keepPages();
    showTab();
  });

  /* How far the page is scrolled: remembered on the way out of a view, put back on the way in. */
  function scroller() { return document.scrollingElement || document.documentElement; }
  function leave() {
    if (viewShown !== "") offsets[viewShown] = scroller().scrollTop;
  }
  function arrive() {
    var page = pageOf(tabShown);
    viewShown = tabShown + "\n" + (page ? page.name : "");
    // Only when it differs: a redraw of the view a finger is scrolling must not touch its scroll.
    var s = scroller();
    var kept = own(offsets, viewShown) || 0;
    if (s.scrollTop !== kept) s.scrollTop = kept;
  }

  /*
   * THE RAIL. Every control but an XY pad lets a touch that goes up or down scroll the
   * page; a pad takes every touch that lands on it. So when the view scrolls AND shows a
   * pad, a strip at the right edge is kept clear of controls: nothing listens on it, which
   * leaves a touch there to the browser. Whether the view scrolls is asked of the page
   * WITHOUT the rail — the rail makes the board narrower and so shorter, and asking with
   * it on could flip the answer back and forth.
   */
  function rail() {
    document.body.classList.remove("railed");
    var pads = panelsEl.querySelectorAll(".pad");
    var shown = false;
    for (var i = 0; i < pads.length; i++) if (pads[i].closest("[hidden]") === null) shown = true;
    // T1647b trial: (K) a pad lets a scroll through everywhere but its puck, so it traps
    // nothing; (G) every view of a Panel that scrolls has the strip, pad or no pad.
    var wanted = (shown && rule.from !== "knob") || (rule.strip !== "" && !panelsEl.hidden);
    var s = scroller();
    var on = wanted && s.scrollHeight > s.clientHeight + 1;
    document.body.classList.toggle("railed", on);
    railEl.hidden = !on;
    railMark();
  }
  function railMark() {
    if (railEl.hidden) return;
    var s = scroller();
    var total = Math.max(s.scrollHeight, 1);
    railThumb.style.top = (s.scrollTop / total) * 100 + "%";
    railThumb.style.height = Math.min(1, s.clientHeight / total) * 100 + "%";
  }
  window.addEventListener("scroll", railMark, { passive: true });
  window.addEventListener("resize", rail);

  /* ------------------------------ the Touch trial (T1647b) — DELETED WHEN THE OWNER HAS CHOSEN */

  /*
   * Two choices kept on this phone (one localStorage entry), made on the page itself, at the
   * right end of the tab bar: HOW A CONTROL TAKES A TOUCH (TOUCH_MODES) and HOW TALL A ROW
   * IS DRAWN (ROWS — the floor of §B269). The owner tries each on his phone in one sitting;
   * the one that stays becomes the page's rule and this block, #trial, #lock, their styles
   * and the table go.
   */
  var ROWS = [32, 36, 44];
  var ROWS_DEFAULT = 36;
  var touchEl = document.getElementById("touchMode");
  var rowsEl = document.getElementById("rowsMode");
  var lockEl = document.getElementById("lock");
  var trial = { touch: TOUCH_DEFAULT, rows: ROWS_DEFAULT };

  function option(select, value, text) {
    var o = el("option", "", text);
    o.value = String(value);
    select.appendChild(o);
  }
  for (var key in TOUCH_MODES) option(touchEl, key, TOUCH_MODES[key].letter + " \u00b7 " + TOUCH_MODES[key].says);
  ROWS.forEach(function (px) { option(rowsEl, px, px + " px rows"); });

  /* Every touch in hand ends where it is, as if the browser had taken it back. */
  function letGo() {
    for (var id in drags) end({ pointerId: id }, true);
  }
  /* (L) Play: the mode's rules. Scroll: no control answers, and a touch anywhere scrolls. */
  function play(on) {
    letGo();
    playing = on;
    document.body.classList.toggle("scrollonly", !on);
    lockEl.setAttribute("aria-pressed", on ? "false" : "true");
  }
  function applyTrial() {
    if (!own(TOUCH_MODES, trial.touch)) trial.touch = TOUCH_DEFAULT;
    if (ROWS.indexOf(trial.rows) < 0) trial.rows = ROWS_DEFAULT;
    rule = TOUCH_MODES[trial.touch];
    touchEl.value = trial.touch;
    rowsEl.value = String(trial.rows);
    document.getElementById("touchNow").textContent = rule.letter;
    document.getElementById("rowsNow").textContent = String(trial.rows);
    var body = document.body;
    body.style.setProperty("--row", trial.rows + "px");
    body.classList.toggle("knobs", rule.from === "knob");
    body.classList.toggle("gutter", rule.strip !== "");
    body.classList.toggle("railleft", rule.strip === "left");
    body.classList.toggle("locking", rule.lock);
    lockEl.hidden = !rule.lock;
    play(true);
    rail();
  }
  function keepTrial() {
    try { localStorage.setItem(CONFIG.trialKey, JSON.stringify(trial)); } catch (x) { /* storage off: this visit only */ }
    applyTrial();
  }
  touchEl.addEventListener("change", function () { trial.touch = touchEl.value; keepTrial(); });
  rowsEl.addEventListener("change", function () { trial.rows = Number(rowsEl.value); keepTrial(); });
  lockEl.addEventListener("click", function () { play(!playing); });
  /* (L) In Scroll nothing on a board answers: not a touch, not a tap, not a key. */
  function gate(event) {
    if (playing) return;
    event.stopPropagation();
    event.preventDefault();
  }
  panelsEl.addEventListener("pointerdown", gate, true);
  panelsEl.addEventListener("click", gate, true);
  try {
    var kept = JSON.parse(localStorage.getItem(CONFIG.trialKey) || "{}");
    if (kept && typeof kept.touch === "string") trial.touch = kept.touch;
    if (kept && typeof kept.rows === "number") trial.rows = kept.rows;
  } catch (x) { /* nothing kept, or not ours: the defaults */ }
  applyTrial();

  function render() {
    var panels = snapshot.panels;
    var next = shape(panels);
    if (next === signature) {
      panels.forEach(function (p) {
        widgetsOf(p).forEach(function (w) {
          if (!views[w.handle]) return;
          views[w.handle].widget = w;
          // T1669b: only where what the control shows has changed (see redraw).
          redraw(w.handle);
        });
      });
      follow();
      return;
    }
    signature = next;
    // T1607b: the redraw is the same view — it comes back where it was scrolled.
    leave();
    views = {};
    boards = {};
    panelsEl.textContent = "";
    var list = [];
    if (panels.length === 0) {
      panelsEl.appendChild(el("p", "empty", "Nothing is published to this phone yet. The Camera tab works without it."));
      list.push({ key: TAB_NONE, label: "Controls" });
    }
    var seen = {};
    panels.forEach(function (p) {
      var title = String(p.title || "") || "Panel";
      // Two Panels may share a title: the second is its own tab all the same.
      var key = "panel:" + title;
      seen[key] = (seen[key] || 0) + 1;
      if (seen[key] > 1) key += "#" + seen[key];
      var section = el("section", "panel");
      section.setAttribute("role", "tabpanel");
      section.setAttribute("aria-label", title);
      section.setAttribute("data-tab", key);
      var board = boardOf(p);
      if (board) {
        boards[key] = drawBoard(section, board);
        lay(boards[key], pageOf(key));
      } else drawRows(section, p.rows || []);
      panelsEl.appendChild(section);
      list.push({ key: key, label: title });
    });
    list.push({ key: TAB_CAMERA, label: "Camera" });
    buildTabs(list);
  }

  /* ------------------------------------------------------------------- tabs (T1517b) */

  /*
   * One tab per Panel, then Camera. The tab the owner last chose is kept on the phone; a
   * Panel that is no longer published shows the first tab instead (without forgetting the
   * choice, so the Panel's tab comes back if the Panel does). Switching only shows and
   * hides: a running camera keeps sending, a held control keeps its gesture.
   */
  var TAB_CAMERA = "camera";
  var TAB_NONE = "panels";
  var tabsEl = document.getElementById("tabs");
  var tabs = [];
  var chosen = readTab();

  function readTab() {
    try { return localStorage.getItem(CONFIG.tabKey) || ""; } catch (x) { return ""; }
  }
  function keepTab(key) {
    try { localStorage.setItem(CONFIG.tabKey, key); } catch (x) { /* storage off: this visit only */ }
  }
  function buildTabs(list) {
    tabs = list;
    tabsEl.textContent = "";
    list.forEach(function (t) {
      var b = el("button", "");
      b.type = "button";
      b.setAttribute("role", "tab");
      b.setAttribute("data-tab", t.key);
      b.setAttribute("aria-label", t.label);
      b.appendChild(el("span", "tabname", t.label));
      if (t.key === TAB_CAMERA) {
        var dot = el("span", "dot");
        dot.hidden = true;
        b.appendChild(dot);
      }
      tabsEl.appendChild(b);
    });
    showTab();
    camRender();
  }
  function showTab() {
    var shown = tabs.length > 0 ? tabs[0].key : TAB_CAMERA;
    for (var i = 0; i < tabs.length; i++) if (tabs[i].key === chosen) shown = chosen;
    var buttons = tabsEl.querySelectorAll("button[data-tab]");
    for (var j = 0; j < buttons.length; j++) {
      var on = buttons[j].getAttribute("data-tab") === shown;
      buttons[j].setAttribute("aria-selected", on ? "true" : "false");
    }
    var reveal = camEl.hidden && shown === TAB_CAMERA;
    panelsEl.hidden = shown === TAB_CAMERA;
    camEl.hidden = shown !== TAB_CAMERA;
    // iOS may pause a preview that was out of view: the Camera tab coming back resumes it.
    if (reveal && cam.pc !== null && camPreview.srcObject) {
      var playing = camPreview.play ? camPreview.play() : null;
      if (playing && typeof playing.catch === "function") playing.catch(function () { /* the next tap will do */ });
    }
    var sections = panelsEl.querySelectorAll("section[data-tab]");
    for (var k = 0; k < sections.length; k++) sections[k].hidden = sections[k].getAttribute("data-tab") !== shown;
    // T1607b: the shown Panel's page and pager, the rail if this view needs one, and the
    // view back where it was scrolled — in that order, each changes what the next measures.
    tabShown = shown;
    showPager(shown);
    rail();
    arrive();
    // A list that was drawn while its tab was hidden finds its standby now.
    follow();
  }
  tabsEl.addEventListener("click", function (event) {
    var b = event.target && event.target.closest ? event.target.closest("button[data-tab]") : null;
    if (b === null) return;
    leave();
    chosen = b.getAttribute("data-tab");
    keepTab(chosen);
    showTab();
  });

  function onSnapshot(s) {
    if (!s || typeof s.seq !== "number" || !Array.isArray(s.panels)) return;
    if (s.seq < lastSeq) return;
    lastSeq = s.seq;
    for (var h in overrides) if (overrides[h].acked) delete overrides[h];
    snapshot = s;
    render();
  }

  /* ------------------------------------------------------------------ camera (T1397b) */

  /*
   * SEND CAMERA. This phone OFFERS (it has the camera), Loom's page ANSWERS, and the video
   * then goes phone -> page directly on the wifi. The helper relays the handshake only:
   * our offer, ICE candidates and bye go up CONFIG.signal one POST at a time, in order;
   * the page's answer, candidates and bye come down this page's own event stream.
   * iceServers is empty on purpose: on one wifi the host candidates are enough, and a
   * STUN server would be a stranger on the internet learning where this phone is.
   *
   * The NAME is what a Webcam node's phone:NAME device matches. Kept in localStorage so it
   * survives the next session on the same door address; the default is the phone's model
   * as its browser reports it.
   */
  var camEl = document.getElementById("camera");
  var camName = document.getElementById("camName");
  var camGo = document.getElementById("camGo");
  var camPreview = document.getElementById("camPreview");
  var camStateEl = document.getElementById("camState");
  var camStageEl = document.getElementById("camStage");
  var SIZES = { "480": [854, 480], "720": [1280, 720], "1080": [1920, 1080] };
  // What the camera is asked for: this phone's buttons set it, and so does the desk's
  // "request" (a Webcam node's Capture parameters) — the latest from either end wins.
  // 0 is unasked; exact is the node's Require.
  var cam = {
    facing: "environment",
    width: 1280,
    height: 720,
    frameRate: 0,
    exact: false,
    stream: null,
    pc: null,
    opening: false,
    ticket: 0,        // bumped by every start, retune and stop: a late camera is stopped, not used
    offered: false,
    early: [],        // our candidates found before the offer left
    remoteIce: [],    // the page's candidates that came before its answer was applied
    signals: [],      // our signals, sent one at a time, in order
    signalling: false,
    said: ""          // a sentence that replaces the state line (a refusal, a failure)
  };

  function readName() {
    try { return localStorage.getItem(CONFIG.nameKey) || ""; } catch (x) { return ""; }
  }
  function keepName(value) {
    try { localStorage.setItem(CONFIG.nameKey, value); } catch (x) { /* storage off: this visit only */ }
  }
  function modelName() {
    var ua = navigator.userAgent || "";
    if (/iPad/.test(ua)) return "iPad";
    if (/iPhone/.test(ua)) return "iPhone";
    // A reduced Android agent says "K" where the model was; one letter names nothing.
    var android = /Android [^;)]*; ([^;)]+?)(?: Build\/[^;)]*)?\)/.exec(ua);
    if (android && android[1] && android[1].length > 1) return android[1];
    if (/Android/.test(ua)) return "Android";
    return "Phone";
  }
  function sendingName() { return (camName.value.trim() || modelName()).slice(0, CONFIG.nameMax); }
  camName.value = (readName() || modelName()).slice(0, CONFIG.nameMax);
  camName.addEventListener("change", function () {
    var value = camName.value.trim().slice(0, CONFIG.nameMax);
    camName.value = value;
    keepName(value);
  });

  function stopTracks(stream) {
    if (stream) stream.getTracks().forEach(function (track) { track.stop(); });
  }
  function words(error) {
    var name = error && error.name;
    if (name === "NotAllowedError") return "Camera access was refused. Allow the camera for this page in the browser's settings, then try again.";
    if (name === "NotFoundError" || name === "OverconstrainedError") return "This phone has no camera that matches.";
    if (name === "NotReadableError") return "The camera is busy — another app may be using it.";
    return "The camera could not be opened" + (error && error.message ? ": " + error.message : ".");
  }
  function camSize() {
    var track = cam.stream && cam.stream.getVideoTracks()[0];
    var s = track && track.getSettings ? track.getSettings() : null;
    return s && s.width && s.height ? " — " + s.width + "×" + s.height : "";
  }
  function camLine() {
    if (cam.said !== "") return cam.said;
    if (stopped) return "";
    if (cam.opening) return "Opening the camera…";
    if (cam.pc === null) return phone === "" ? "Waiting for Loom…" : "Not sending.";
    var state = cam.pc.connectionState;
    if (state === "connected") return "Sending to Loom" + camSize() + ".";
    if (state === "disconnected") return "Connection interrupted — waiting for it to come back…";
    if (state === "failed") return "The connection to Loom failed. Stop and start again.";
    return "Connecting to Loom…";
  }
  function camRender() {
    var busy = cam.pc !== null || cam.opening;
    camGo.textContent = busy ? "Stop camera" : "Start camera";
    camGo.classList.toggle("on", busy);
    camGo.disabled = stopped || (phone === "" && !busy);
    camName.disabled = busy || stopped;
    var choices = camEl.querySelectorAll("button[data-facing], button[data-res]");
    for (var i = 0; i < choices.length; i++) {
      var b = choices[i];
      var size = SIZES[b.getAttribute("data-res")];
      var on = b.getAttribute("data-facing") === cam.facing ||
        (size !== undefined && size[0] === cam.width && size[1] === cam.height);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    }
    camStateEl.textContent = camLine();
    camStageEl.classList.toggle("idle", camPreview.hidden);
    // T1517b: the Camera tab says it is live from any tab.
    var dot = tabsEl.querySelector(".dot");
    if (dot) {
      dot.hidden = !busy;
      dot.classList.toggle("live", cam.pc !== null && cam.pc.connectionState === "connected");
    }
  }
  function camSay(text) {
    cam.said = text;
    camRender();
  }

  function camOpen() {
    // Preferences unless the desk asked for Require; facing always a preference, so a
    // phone with one camera still opens. An unasked member is left to the phone.
    var how = cam.exact ? "exact" : "ideal";
    var video = { facingMode: { ideal: cam.facing } };
    if (cam.width > 0) { video.width = {}; video.width[how] = cam.width; }
    if (cam.height > 0) { video.height = {}; video.height[how] = cam.height; }
    if (cam.frameRate > 0) { video.frameRate = {}; video.frameRate[how] = cam.frameRate; }
    return navigator.mediaDevices.getUserMedia({ video: video, audio: false });
  }

  /* The desk's Webcam node asked for a facing, a size or a rate: take it, re-open if live. */
  function camRequest(m) {
    var before = [cam.facing, cam.width, cam.height, cam.frameRate, cam.exact].join();
    if (m.facing === "user" || m.facing === "environment") cam.facing = m.facing;
    if (m.width > 0 || m.height > 0) { cam.width = m.width; cam.height = m.height; }
    cam.frameRate = m.frameRate;
    cam.exact = m.exact === true;
    // Asked for what it already has (a desk re-opening its node): no camera blink.
    if ([cam.facing, cam.width, cam.height, cam.frameRate, cam.exact].join() !== before) camRetune();
    camRender();
  }

  function camStart() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      camSay("This browser cannot open a camera on this page.");
      return;
    }
    if (typeof RTCPeerConnection === "undefined") {
      camSay("This browser cannot send video to Loom (it has no WebRTC).");
      return;
    }
    var ticket = ++cam.ticket;
    cam.opening = true;
    cam.said = "";
    camRender();
    camOpen().then(function (stream) {
      if (ticket !== cam.ticket || stopped) { stopTracks(stream); return; }
      cam.opening = false;
      cam.stream = stream;
      camPreview.muted = true;
      camPreview.srcObject = stream;
      camPreview.hidden = false;
      camOffer();
    }, function (error) {
      if (ticket !== cam.ticket) return;
      cam.opening = false;
      camSay(words(error));
    });
  }

  function camOffer() {
    var pc = new RTCPeerConnection({ iceServers: [] });
    cam.pc = pc;
    cam.offered = false;
    cam.early = [];
    cam.remoteIce = [];
    cam.stream.getVideoTracks().forEach(function (track) { pc.addTrack(track, cam.stream); });
    pc.onicecandidate = function (event) {
      if (cam.pc !== pc || !event.candidate) return;
      var ice = {
        kind: "ice",
        candidate: event.candidate.candidate,
        sdpMid: event.candidate.sdpMid,
        sdpMLineIndex: event.candidate.sdpMLineIndex
      };
      if (cam.offered) signal(ice);
      else cam.early.push(ice);
    };
    pc.onconnectionstatechange = function () { if (cam.pc === pc) camRender(); };
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () {
        if (cam.pc !== pc) return;
        signal({ kind: "offer", sdp: pc.localDescription.sdp, name: sendingName() });
        cam.offered = true;
        cam.early.splice(0).forEach(signal);
      })
      .catch(function (error) {
        if (cam.pc === pc) camStop(true, "Could not start sending: " + String((error && error.message) || error));
      });
    camRender();
  }

  /* Front/back or a new size while sending: the same connection, a new track. */
  function camRetune() {
    var pc = cam.pc;
    if (pc === null || cam.stream === null) return;
    var ticket = ++cam.ticket;
    // Stopped FIRST: a phone generally will not open a second camera while one runs.
    stopTracks(cam.stream);
    camOpen().then(function (stream) {
      if (cam.pc !== pc || ticket !== cam.ticket) { stopTracks(stream); return; }
      cam.stream = stream;
      camPreview.srcObject = stream;
      return pc.getSenders()[0].replaceTrack(stream.getVideoTracks()[0]).then(camRender);
    }).catch(function (error) {
      if (cam.pc === pc) camStop(true, words(error));
    });
  }

  function camStop(tell, reason) {
    cam.ticket++;
    cam.opening = false;
    var pc = cam.pc;
    cam.pc = null;
    if (pc !== null) {
      // A reason goes with it when the phone did not choose to stop, so the desk can say why.
      if (tell && cam.offered) signal(reason ? { kind: "bye", reason: reason.slice(0, CONFIG.reasonMax) } : { kind: "bye" });
      pc.close();
    }
    cam.offered = false;
    cam.early = [];
    cam.remoteIce = [];
    stopTracks(cam.stream);
    cam.stream = null;
    camPreview.srcObject = null;
    camPreview.hidden = true;
    cam.said = reason;
    camRender();
  }

  function addIce(pc, m) {
    pc.addIceCandidate({ candidate: m.candidate, sdpMid: m.sdpMid, sdpMLineIndex: m.sdpMLineIndex })
      .catch(function () { /* one unusable candidate is not a failed connection */ });
  }
  function camSignal(message) {
    if (message && message.kind === "request") {
      camRequest(message);
      return;
    }
    var pc = cam.pc;
    if (pc === null || !message) return;
    if (message.kind === "answer") {
      pc.setRemoteDescription({ type: "answer", sdp: message.sdp }).then(function () {
        if (cam.pc !== pc) return;
        cam.remoteIce.splice(0).forEach(function (m) { addIce(pc, m); });
      }, function (error) {
        if (cam.pc === pc) camStop(true, "Loom's answer did not fit: " + String((error && error.message) || error));
      });
    } else if (message.kind === "ice") {
      if (pc.remoteDescription) addIce(pc, message);
      else cam.remoteIce.push(message);
    } else if (message.kind === "bye") {
      camStop(false, String(message.reason || "Loom stopped receiving this camera."));
    }
  }

  /* A new stream is a new phone to the page, which dropped the old one's camera: offer again. */
  function camHello(was) {
    if (cam.pc !== null && was !== phone) {
      var old = cam.pc;
      cam.pc = null;
      old.close();
      cam.signals = [];
      camOffer();
      return;
    }
    camRender();
    pumpSignals();
  }

  function signal(message) {
    cam.signals.push(message);
    pumpSignals();
  }
  function pumpSignals() {
    if (cam.signalling || stopped || phone === "" || cam.signals.length === 0) return;
    var message = cam.signals.shift();
    cam.signalling = true;
    fetch(CONFIG.signal + query + "&" + CONFIG.peer + "=" + encodeURIComponent(phone), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(message)
    })
      .then(function (response) {
        if (response.status === 403) { stop(EXPIRED); return; }
        if (response.status === 409) {
          // The stream this handshake ran under is gone; the next hello offers afresh.
          cam.signals = [];
          phone = "";
          connect();
          return;
        }
        if (response.ok) return;
        return response.text().then(
          function (text) { camStop(true, text || "Loom refused the camera."); },
          function () { camStop(true, "Loom refused the camera."); }
        );
      }, function () {
        camStop(true, "Could not reach Loom — check the wifi.");
      })
      .then(function () {
        cam.signalling = false;
        pumpSignals();
      });
  }

  camEl.addEventListener("click", function (event) {
    var b = event.target && event.target.closest ? event.target.closest("button") : null;
    if (b === null || stopped) return;
    var facing = b.getAttribute("data-facing");
    var res = b.getAttribute("data-res");
    if (facing) {
      if (facing !== cam.facing) { cam.facing = facing; camRetune(); }
      camRender();
    } else if (res) {
      var size = SIZES[res];
      if (size[0] !== cam.width || size[1] !== cam.height) {
        cam.width = size[0];
        cam.height = size[1];
        camRetune();
      }
      camRender();
    } else if (b === camGo) {
      if (cam.pc !== null || cam.opening) camStop(true, "");
      else camStart();
    }
  });
  // Before the first snapshot: the Panel area (saying it is connecting) and Camera.
  buildTabs([{ key: TAB_NONE, label: "Controls" }, { key: TAB_CAMERA, label: "Camera" }]);

  /* ---------------------------------------------------------------------------- events */

  function connect() {
    if (source) source.close();
    var mine = new EventSource(CONFIG.events + query);
    source = mine;
    mine.onopen = function () { if (!stopped && source === mine) setStatus(""); };
    mine.onerror = function () {
      if (stopped || source !== mine) return;
      setStatus(mine.readyState === 2
        ? "Disconnected. Reload the page, or scan the QR code again."
        : "Connection lost — reconnecting…");
    };
    mine.onmessage = function (message) {
      var event;
      try { event = JSON.parse(message.data); } catch (x) { return; }
      if (stopped || !event || source !== mine) return;
      if (event.type === "hello") {
        // A browser's own reconnect is a new stream too, and says a new id.
        var was = phone;
        phone = String(event.phone || "");
        pump();
        camHello(was);
      }
      else if (event.type === "snapshot") onSnapshot(event.snapshot);
      else if (event.type === "signal") camSignal(event.message);
      else if (event.type === "refused") onRefused(event);
      else if (event.type === "closed") stop(String(event.reason || "Loom closed this door."));
    };
  }
  connect();
})();
`;

let palette: string | null = null;

/** The phone page, whole. The helper serves this string as `text/html; charset=utf-8`. */
export function phonePageHtml(): string {
  palette ??= paletteBlock();
  const config = JSON.stringify({
    param: PHONE_TOKEN_PARAM,
    peer: PHONE_PEER_PARAM,
    events: PHONE_EVENTS_PATH,
    set: PHONE_SET_PATH,
    expired: PHONE_EXPIRED_SENTENCE,
    signal: PHONE_SIGNAL_PATH,
    nameKey: PHONE_NAME_STORAGE_KEY,
    tabKey: PHONE_TAB_STORAGE_KEY,
    pageKey: PHONE_PAGE_STORAGE_KEY,
    trialKey: PHONE_TRIAL_STORAGE_KEY,
    nameMax: PHONE_NAME_MAX_CHARS,
    reasonMax: PHONE_REASON_MAX_CHARS,
  });
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
    '<meta name="color-scheme" content="dark">',
    '<meta name="referrer" content="no-referrer">',
    // A data: icon so the browser does not ask the door for /favicon.ico.
    '<link rel="icon" href="data:,">',
    "<title>Loom remote</title>",
    `<style>\n${palette}\n${STYLE}</style>`,
    "</head>",
    "<body>",
    '<div id="status" role="status" hidden></div>',
    '<main id="panels"><p class="empty">Connecting to Loom…</p></main>',
    // T1397b: outside `#panels`, which every snapshot redraws. T1517b: the Camera tab.
    '<section id="camera" role="tabpanel" aria-label="Send camera" hidden>',
    '<div id="camStage" class="stage idle">',
    '<video id="camPreview" muted playsinline autoplay hidden></video>',
    '<p id="camState" class="camstate" role="status"></p>',
    "</div>",
    '<div class="camctl">',
    '<div class="seg" role="group" aria-label="Camera">',
    '<button type="button" class="ctl" data-facing="user">Front</button>',
    '<button type="button" class="ctl" data-facing="environment">Back</button>',
    "</div>",
    '<div class="seg" role="group" aria-label="Resolution">',
    '<button type="button" class="ctl" data-res="480">480p</button>',
    '<button type="button" class="ctl" data-res="720">720p</button>',
    '<button type="button" class="ctl" data-res="1080">1080p</button>',
    "</div>",
    "</div>",
    '<button id="camGo" type="button" class="ctl">Start camera</button>',
    `<label class="field">Sends as <input id="camName" type="text" maxlength="${String(PHONE_NAME_MAX_CHARS)}" autocomplete="off" spellcheck="false"></label>`,
    "</section>",
    // T1607b: the scroll rail (shown beside a pad on a page that scrolls) and the pager.
    '<div id="rail" aria-hidden="true" hidden><div class="railthumb"></div></div>',
    '<nav id="pager" role="tablist" aria-label="Pages of this panel" hidden></nav>',
    '<nav id="tabs" role="tablist" aria-label="Panels and camera"></nav>',
    // T1647b TRIAL — deleted when the owner has chosen: the lock's switch (mode L) and the two choices.
    '<button id="lock" type="button" aria-label="Scroll only: no control answers" aria-pressed="false" hidden><span class="play">Play</span><span class="scroll">Scroll</span></button>',
    '<div id="trial">',
    '<label>Touch <b id="touchNow"></b><select id="touchMode" aria-label="How a control takes a touch (trial)"></select></label>',
    '<label>Rows <b id="rowsNow"></b><select id="rowsMode" aria-label="How tall a row is drawn (trial)"></select></label>',
    "</div>",
    '<div id="notice" role="alert" hidden></div>',
    `<script>\nvar CONFIG = ${config};\n${CLIENT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
