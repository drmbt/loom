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
  /* --pad is the page gutter; --bar the bottom tab bar's height above the safe area. */
  --pad: 12px;
  --bar: 64px;
  --gap: 6px;
  min-height: 100vh;
  padding: calc(var(--pad) + env(safe-area-inset-top)) calc(var(--pad) + env(safe-area-inset-right))
    calc(var(--bar) + var(--pad) + env(safe-area-inset-bottom)) calc(var(--pad) + env(safe-area-inset-left));
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
  bottom: calc(var(--bar) + var(--pad) + env(safe-area-inset-bottom));
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
.panel { margin: 0; }
.panel > h2 { margin: 16px 0 8px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); }
.panel > h2:first-child { margin-top: 4px; }
.panel > p { margin: 8px 0; color: var(--text-dim); font-size: 15px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
.w { flex: 1 1 140px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
/* Full width on a phone, side by side once two fit. */
.w.slider { flex: 1 1 280px; }
.w.xyPad { flex: 1 1 240px; max-width: 480px; }
.cap { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; color: var(--text-dim); }
.cap .name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap .val { flex: none; color: var(--text); font-variant-numeric: tabular-nums; }
.ctl { touch-action: none; user-select: none; -webkit-user-select: none; }
.track {
  position: relative;
  height: 56px;
  border: 1px solid var(--line-hot);
  border-radius: 12px;
  background: var(--bg-raise);
  overflow: hidden;
}
.fill { position: absolute; left: 0; top: 0; bottom: 0; background: color-mix(in srgb, var(--signal) 45%, transparent); }
.thumb { position: absolute; top: 0; bottom: 0; width: 4px; margin-left: -2px; background: var(--signal); }
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
 * T1517b: a Panel's BOARD (T1516b) — the owner's arrangement on a grid of square cells,
 * one column = the page's width / columns. The row height is that same column width, read
 * from the wrapper's inline size (cqi); the vw line before it is for a browser without
 * container units. Each item sits at its rect through grid-column / grid-row.
 */
.boardwrap { container-type: inline-size; }
.board {
  display: grid;
  gap: var(--gap);
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  grid-auto-rows: calc((100vw - 2 * var(--pad) - (var(--cols) - 1) * var(--gap)) / var(--cols));
  grid-auto-rows: calc((100cqi - (var(--cols) - 1) * var(--gap)) / var(--cols));
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
.board .w.xyPad > .cap { top: 6px; bottom: auto; }
/* The slider's handle passes under its caption and value: each sits on a chip of the
   page's ground, so the line never cuts through the text. */
.board .w.slider > .cap .name, .board .w.slider > .cap .val {
  padding: 1px 6px;
  border-radius: 6px;
  background-color: var(--bg-void);
}
.board .w > button.ctl { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 2px 6px; overflow: hidden; font-size: 14px; }
.board .w > button.ctl .name { max-width: 100%; }
.board .w > button.ctl .state { font-size: 11px; }
/* A grid item is sized by the grid, so it can be its own size container: a cell too short
   for two lines keeps the caption, and the button's On colour says its state. */
.board .w.toggle, .board .w.button { container-type: size; }
@container (max-height: 46px) { button.ctl .state { display: none; } }
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
`;

/**
 * The client. Plain ES2017, no template literals, so it can sit inside `String.raw` as is.
 * `CONFIG` is declared ahead of it by `phonePageHtml` from the protocol's constants.
 */
const CLIENT = String.raw`
(function () {
  "use strict";
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
  var drags = {};      // pointerId -> { handle, last }
  var wanted = {};     // handle -> latest live values, waiting for the next frame
  var frameAsked = false;
  var queue = [];      // [{ handle, live, commit }] in send order; latest value per slot only
  var inFlight = false;
  var noticeTimer = 0;
  var source = null;
  var phone = "";      // this stream's id, from its "hello"; every write names it

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function format(v) {
    var m = Math.abs(v);
    return m >= 100 ? v.toFixed(0) : m >= 10 ? v.toFixed(1) : v.toFixed(2);
  }
  function tidy(v) { return parseFloat(v.toPrecision(12)); }

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
    if (wanted[handle] !== undefined) {
      openEntry(handle).live = wanted[handle];
      delete wanted[handle];
    }
    openEntry(handle).commit = values;
    pump();
  }
  function acknowledged(handle) {
    for (var id in drags) if (drags[id].handle === handle) return;
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
    views[handle].update();
  }
  function box(node) { return node.getBoundingClientRect(); }

  function sliderValue(w, x, rect) {
    var v = w.min + clamp01((x - rect.left) / Math.max(rect.width, 1)) * (w.max - w.min);
    if (w.step > 0) v = Math.round(v / w.step) * w.step;
    var lo = Math.min(w.min, w.max), hi = Math.max(w.min, w.max);
    return tidy(v < lo ? lo : v > hi ? hi : v);
  }
  function padValues(w, x, y, rect) {
    var span = w.max - w.min;
    return {
      x: tidy(w.min + clamp01((x - rect.left) / Math.max(rect.width, 1)) * span),
      y: tidy(w.min + clamp01(1 - (y - rect.top) / Math.max(rect.height, 1)) * span),
    };
  }
  function share(v, min, max) { return max === min ? 0 : clamp01((v - min) / (max - min)); }

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
    track.appendChild(fill);
    track.appendChild(thumb);
    root.appendChild(cap);
    root.appendChild(track);
    var view = { widget: w, el: root, target: track };
    view.update = function () {
      var c = current(w.handle);
      var s = share(c.value, c.min, c.max) * 100;
      fill.style.width = s + "%";
      thumb.style.left = s + "%";
      val.textContent = format(c.value);
      track.setAttribute("aria-valuemin", String(c.min));
      track.setAttribute("aria-valuemax", String(c.max));
      track.setAttribute("aria-valuenow", String(c.value));
    };
    view.valuesAt = function (event) {
      return { value: sliderValue(views[w.handle].widget, event.clientX, box(views[w.handle].target)) };
    };
    track.addEventListener("pointerdown", function (event) { begin(w.handle, event, track); });
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
    view.valuesAt = function (event) {
      return padValues(views[w.handle].widget, event.clientX, event.clientY, box(views[w.handle].target));
    };
    pad.addEventListener("pointerdown", function (event) { begin(w.handle, event, pad); });
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
    b.addEventListener("click", function () {
      if (stopped) return;
      var next = !(current(w.handle).on === true);
      setLocal(w.handle, { on: next });
      commit(w.handle, { on: next });
    });
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
    var view = { widget: w, el: root, target: b, momentary: true };
    view.update = function () {
      var held = current(w.handle).held === true;
      b.classList.toggle("on", held);
      b.setAttribute("aria-pressed", held ? "true" : "false");
      state.textContent = held ? "Held" : "Press";
    };
    view.valuesAt = function () { return { held: true }; };
    b.addEventListener("pointerdown", function (event) { begin(w.handle, event, b); });
    b.addEventListener("contextmenu", function (event) { event.preventDefault(); });
    return view;
  }

  function begin(handle, event, target) {
    if (stopped) return;
    event.preventDefault();
    capture(target, event);
    var values = views[handle].valuesAt(event);
    drags[event.pointerId] = { handle: handle, last: values };
    setLocal(handle, values);
    wantLive(handle, values);
  }
  window.addEventListener("pointermove", function (event) {
    var d = drags[event.pointerId];
    if (!d || stopped || !views[d.handle] || views[d.handle].momentary) return;
    var values = views[d.handle].valuesAt(event);
    d.last = values;
    setLocal(d.handle, values);
    wantLive(d.handle, values);
  });
  function end(event, cancelled) {
    var d = drags[event.pointerId];
    if (!d) return;
    delete drags[event.pointerId];
    if (stopped || !views[d.handle]) return;
    var v = views[d.handle];
    var values = v.momentary ? { held: false } : cancelled ? d.last : v.valuesAt(event);
    setLocal(d.handle, values);
    commit(d.handle, values);
  }
  window.addEventListener("pointerup", function (event) { end(event, false); });
  window.addEventListener("pointercancel", function (event) { end(event, true); });

  var BUILDERS = { slider: buildSlider, toggle: buildToggle, button: buildButton, xyPad: buildPad };

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
          return [item.kind, r.x, r.y, r.w, r.h, item.text, w.kind, w.handle, w.caption];
        })];
      }
      return [p.title, (p.rows || []).map(function (r) {
        return r.kind === "widgets"
          ? r.widgets.map(function (w) { return [w.kind, w.handle, w.caption]; })
          : [r.kind, r.text];
      })];
    }));
  }

  function place(handle, w) {
    var build = BUILDERS[w.kind];
    if (!build) return null;
    var view = build(w);
    views[handle] = view;
    view.update();
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
    grid.style.setProperty("--cols", String(cols));
    board.items.forEach(function (item) {
      var node = null;
      if (item.kind === "label") node = el("div", "label", String(item.text || ""));
      else if (item.kind === "widget" && item.widget) node = place(item.widget.handle, item.widget);
      if (node === null) return;
      var r = item.rect || {};
      var x = whole(r.x, 0, cols - 1);
      var y = whole(r.y, 0, 9999);
      node.style.gridColumn = (x + 1) + " / span " + whole(r.w, 1, cols - x);
      node.style.gridRow = (y + 1) + " / span " + whole(r.h, 1, 9999);
      grid.appendChild(node);
    });
    wrap.appendChild(grid);
    section.appendChild(wrap);
  }

  function render() {
    var panels = snapshot.panels;
    var next = shape(panels);
    if (next === signature) {
      panels.forEach(function (p) {
        widgetsOf(p).forEach(function (w) {
          if (views[w.handle]) { views[w.handle].widget = w; views[w.handle].update(); }
        });
      });
      return;
    }
    signature = next;
    views = {};
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
      if (board) drawBoard(section, board);
      else drawRows(section, p.rows || []);
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
  }
  tabsEl.addEventListener("click", function (event) {
    var b = event.target && event.target.closest ? event.target.closest("button[data-tab]") : null;
    if (b === null) return;
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
    '<nav id="tabs" role="tablist" aria-label="Panels and camera"></nav>',
    '<div id="notice" role="alert" hidden></div>',
    `<script>\nvar CONFIG = ${config};\n${CLIENT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
