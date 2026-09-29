/**
 * T1396b — THE PHONE PAGE: the one document the helper serves a phone at `PHONE_PAGE_PATH`.
 *
 * Self-contained by necessity: the helper runs this file from TypeScript source under node,
 * there is no bundler between it and the phone, and the page may fetch nothing but its two
 * endpoints (`PHONE_EVENTS_PATH` down, `PHONE_SET_PATH` up). Inline `<style>`, inline
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
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { PHONE_EVENTS_PATH, PHONE_PEER_PARAM, PHONE_SET_PATH, PHONE_TOKEN_PARAM } from "./phone-protocol.ts";

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
  min-height: 100vh;
  padding: calc(12px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
    calc(24px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
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
  left: calc(12px + env(safe-area-inset-left));
  right: calc(12px + env(safe-area-inset-right));
  bottom: calc(12px + env(safe-area-inset-bottom));
  z-index: 3;
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
.panel {
  margin: 0 0 16px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 14px;
  background: var(--bg-panel);
}
.panel > h1 { margin: 0 0 10px; font-size: 17px; font-weight: 600; }
.panel > h2 { margin: 16px 0 8px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-dim); }
.panel > p { margin: 8px 0; color: var(--text-dim); font-size: 15px; }
.row { display: flex; flex-wrap: wrap; gap: 12px; margin: 10px 0; }
.w { flex: 1 1 140px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
/* Full width on a phone, side by side once two fit. */
.w.slider { flex: 1 1 280px; }
.w.xyPad { flex: 1 1 240px; max-width: 480px; }
.cap { display: flex; justify-content: space-between; gap: 8px; font-size: 14px; color: var(--text-dim); }
.cap .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cap .val { color: var(--text); font-variant-numeric: tabular-nums; }
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

  function shape(panels) {
    return JSON.stringify(panels.map(function (p) {
      return [p.title, p.rows.map(function (r) {
        return r.kind === "widgets"
          ? r.widgets.map(function (w) { return [w.kind, w.handle, w.caption]; })
          : [r.kind, r.text];
      })];
    }));
  }

  function render() {
    var panels = snapshot.panels;
    var next = shape(panels);
    if (next === signature) {
      panels.forEach(function (p) {
        p.rows.forEach(function (r) {
          if (r.kind === "widgets") r.widgets.forEach(function (w) {
            if (views[w.handle]) { views[w.handle].widget = w; views[w.handle].update(); }
          });
        });
      });
      return;
    }
    signature = next;
    views = {};
    panelsEl.textContent = "";
    if (panels.length === 0) {
      panelsEl.appendChild(el("p", "empty", "Nothing is published to this phone yet."));
      return;
    }
    panels.forEach(function (p) {
      var section = el("section", "panel");
      section.appendChild(el("h1", "", p.title));
      p.rows.forEach(function (r) {
        if (r.kind === "heading") section.appendChild(el("h2", "", r.text));
        else if (r.kind === "text") section.appendChild(el("p", "", r.text));
        else if (r.kind === "widgets") {
          var row = el("div", "row");
          r.widgets.forEach(function (w) {
            var build = BUILDERS[w.kind];
            if (!build) return;
            var view = build(w);
            views[w.handle] = view;
            view.update();
            row.appendChild(view.el);
          });
          section.appendChild(row);
        }
      });
      panelsEl.appendChild(section);
    });
  }

  function onSnapshot(s) {
    if (!s || typeof s.seq !== "number" || !Array.isArray(s.panels)) return;
    if (s.seq < lastSeq) return;
    lastSeq = s.seq;
    for (var h in overrides) if (overrides[h].acked) delete overrides[h];
    snapshot = s;
    render();
  }

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
        phone = String(event.phone || "");
        pump();
      }
      else if (event.type === "snapshot") onSnapshot(event.snapshot);
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
    '<div id="notice" role="alert" hidden></div>',
    `<script>\nvar CONFIG = ${config};\n${CLIENT}</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
