/**
 * T1647b — THREE PHONE PANELS, FROZEN: the boards `phone-touch.spec.ts` scrolls and pages.
 *
 * The spec used to read sentinel-bot's shipped document for its "real consumer" cases. That
 * project's panels belong to another session, which re-lays them out several times a day, and
 * an engine spec that read them went red three times for changes nobody ran it for (a fourth
 * Panel, a Saved bank, lower rows). So what the spec needs is COPIED here, and it now proves
 * facts about a fixed input: these boards scroll from a slider and write nothing, and this
 * board pages by its labels.
 *
 * What is copied is the PHONE'S view of each Panel — the `PhonePanel` that
 * `buildPhoneSnapshot` made from `projects/sentinel-bot/sentinel.loom.json` at the commit
 * named, its board item for item (rects, captions, values, ranges, handles). Copied on
 * 2026-10-06. Two dates on purpose, so the boards hold both shapes a phone meets:
 *
 *   Lights   at c74efba8 (2026-10-06): 8 columns, EVERY SLIDER THE BOARD'S FULL WIDTH — no
 *            gap to scroll from. That Panel was not published then; it is here as a phone
 *            would have got it with its Phone switch on.
 *   Robot    at 4bb29f77 (2026-10-06): 10 columns, every control 8 wide — INSET, a bare strip
 *            beside them (the project's own stopgap for scrolling) — with two preset strips
 *            and three toggles. The tallest: twenty rows.
 *   Scene    at 4bb29f77 (2026-10-06): the same inset shape, TWO LABELLED SECTIONS (Scene,
 *            Camera), a toggle and an XY PAD.
 *
 * All three are taller than the spec's 375 x 600 phone. `rows` (the legacy text layout a
 * snapshot also carries) is left empty: a Panel with a board is drawn from its board.
 *
 * Nothing here imports the project and nothing here is kept in step with it: if the
 * project's panels change, these are still the boards the cases were made against.
 */
import type { PhonePanel } from "@devices/phone/phone-protocol.ts";

/** In tab order, as a phone lists them. */
export const FROZEN_PANELS: readonly PhonePanel[] = [
  {
    title: "Lights",
    rows: [],
    board: {
      columns: 8,
      rows: 12,
      items: [
        { kind: "label", rect: { x: 0, y: 0, w: 8, h: 1 }, text: "Lights" },
        { kind: "widget", rect: { x: 0, y: 1, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_huefrom", caption: "Colour from (hue)", value: 0, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 2, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_hueto", caption: "Colour to (hue)", value: 0.03, min: 0, max: 1.5, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 3, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_spread", caption: "Colour spread", value: 0.6, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 4, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_hueshift", caption: "Colour follows level", value: 0.4, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 5, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_glow", caption: "Eyes", value: 9, min: 0, max: 30, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 6, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_eyehits", caption: "Eyes on drums", value: 0.6, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 7, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_eyesweep", caption: "Eye sweep (beat)", value: 0.25, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 8, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_legs", caption: "Leg lights", value: 1, min: 0, max: 3, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 9, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_meter", caption: "Leg meter (lows)", value: 0.7, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 10, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_chase", caption: "Leg chase (beat)", value: 0.3, min: 0, max: 2, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 11, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_spark", caption: "Leg spark (hats)", value: 0.6, min: 0, max: 2, step: 0 } },
      ],
    },
  },
  {
    title: "Robot",
    rows: [],
    board: {
      columns: 10,
      rows: 20,
      items: [
        { kind: "label", rect: { x: 0, y: 0, w: 10, h: 1 }, text: "Robot" },
        { kind: "widget", rect: { x: 0, y: 1, w: 8, h: 1 }, widget: { kind: "preset", handle: "presets_robot", caption: "robot", presets: ["reset_robot"], current: null, morphing: false } },
        { kind: "widget", rect: { x: 0, y: 2, w: 8, h: 1 }, widget: { kind: "preset", handle: "presets_all", caption: "all", presets: ["reset_all"], current: null, morphing: false } },
        { kind: "widget", rect: { x: 0, y: 3, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_speed", caption: "Speed", value: 3.2, min: 0, max: 9, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 4, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_crawl", caption: "Crawl", value: 0.6, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 5, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_swim", caption: "Swim", value: 0, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 6, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_stride", caption: "Stride", value: 3.2, min: 1.6, max: 4.4, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 7, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_flare", caption: "Flare", value: 0.25, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 8, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_wave", caption: "Wave", value: 0.05, min: 0, max: 0.3, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 9, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_grip", caption: "Grip", value: 1, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 10, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_gesture", caption: "Gesture", value: 0.6, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 11, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_spiral", caption: "Spiral (turns / 16 m)", value: 0, min: 0, max: 1.5, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 12, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_attack", caption: "Attack", value: 0, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 13, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_pack", caption: "Pack", value: 1, min: 1, max: 3, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 14, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_weight", caption: "Leg weight", value: 0, min: 0, max: 9.8, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 15, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_drag", caption: "Leg drag", value: 1.5, min: 0, max: 6, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 16, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_follow", caption: "Leg follow", value: 0.4, min: 0, max: 1, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 17, w: 8, h: 1 }, widget: { kind: "toggle", handle: "toggle_perch", caption: "Perch", on: false } },
        { kind: "widget", rect: { x: 0, y: 18, w: 8, h: 1 }, widget: { kind: "toggle", handle: "toggle_follow", caption: "Follow the track", on: true } },
        { kind: "widget", rect: { x: 0, y: 19, w: 8, h: 1 }, widget: { kind: "toggle", handle: "toggle_ropes", caption: "Rope legs", on: false } },
      ],
    },
  },
  {
    title: "Scene",
    rows: [],
    board: {
      columns: 10,
      rows: 19,
      items: [
        { kind: "label", rect: { x: 0, y: 0, w: 10, h: 1 }, text: "Scene" },
        { kind: "widget", rect: { x: 0, y: 1, w: 8, h: 1 }, widget: { kind: "preset", handle: "presets_scene", caption: "scene", presets: ["reset_scene"], current: null, morphing: false } },
        { kind: "widget", rect: { x: 0, y: 2, w: 8, h: 1 }, widget: { kind: "preset", handle: "presets_all", caption: "all", presets: ["reset_all"], current: null, morphing: false } },
        { kind: "widget", rect: { x: 0, y: 3, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_bore", caption: "Tunnel", value: 2.6, min: 2.2, max: 3.4, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 4, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_lamp", caption: "Lamp", value: 26, min: 0, max: 80, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 5, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_distance", caption: "Camera distance", value: 7.5, min: -9, max: 12, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 6, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_react", caption: "Listen", value: 1, min: 0, max: 2, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 7, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_haze", caption: "Haze", value: 0.04, min: 0, max: 0.12, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 8, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_focus", caption: "Depth of field", value: 0.5, min: 0, max: 1.5, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 9, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_pump", caption: "Focus on the kick", value: 0.6, min: 0, max: 2, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 10, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_grain", caption: "Grain", value: 0.06, min: 0, max: 0.2, step: 0 } },
        { kind: "widget", rect: { x: 0, y: 11, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_fields", caption: "Fields", value: 0, min: 0, max: 1, step: 0 } },
        { kind: "label", rect: { x: 0, y: 12, w: 10, h: 1 }, text: "Camera" },
        { kind: "widget", rect: { x: 0, y: 13, w: 8, h: 1 }, widget: { kind: "slider", handle: "slider_shot", caption: "Shot (chase, lead, flank, post, circle, face, shoulder, eye, under, tail, wake, tailside, tailtop, tips, tailround, packfront, packquarter, packrear, packunder, fieldwide, fieldside, fieldlow, fieldhigh)", value: 0, min: 0, max: 22, step: 1 } },
        { kind: "widget", rect: { x: 0, y: 14, w: 8, h: 1 }, widget: { kind: "toggle", handle: "toggle_cuts", caption: "Cut on the bars", on: true } },
        { kind: "widget", rect: { x: 2, y: 15, w: 4, h: 4 }, widget: { kind: "xyPad", handle: "xypad_view", caption: "Chase side / height", x: 1.1, y: 0.6, min: -2, max: 2 } },
      ],
    },
  },
];
