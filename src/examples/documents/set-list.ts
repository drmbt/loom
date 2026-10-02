import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";
import { DEVICE_HELPER_PHONE_COMMAND } from "../../devices/helper.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import { serializePresetBank, type Preset } from "../../domain/presets/bank.ts";
import { serializeCueList, type Cue } from "../../domain/presets/cue-list.ts";

/**
 * E82 — Set List. A SET PLAYED FROM BANKS, SHOTS, LAYERS AND A CUE LIST (T1504b, §T1398b S9).
 *
 *   source(noise) ─► layerRings(layer) ─► layerGrid(layer) ─┬─────────────► layerFx(layer) ─► dim(level) ─► pin(cornerPin) ─► onBlack(over) ─► out(output)
 *                      ┆ picture "rings"    ┆ picture "grid" └► shear(displace) ─► glitch(hsv) ┄┄ picture "glitch"    black(solid) ┘
 *   ringsSrc(ramp) ─► rings(hsv)   gridSrc(checker) ─► grid(transform)   tear(noise) ─► shear.disp
 *
 *   looks(presets)  dawn · noon · riot       the two looks' parameters
 *   fx(presets)     clean · dirty · acid     the glitch chain's parameters
 *   shots(presets)  open · cross · drop · out   layer opacities + `on`, each recalling looks / fx presets
 *   set(cueList)    1 open · 2 warm · 3 cross · 4 drop · 5 out, Wrap on
 *   master(slider), keystone(slider) ─► desk(panel "Show desk", Phone on), which also names shots, set and layerFx
 *
 * The owner's words (2026-09-27): "build scenes with presets and shots and layers … input,
 * projection mapping, colorization, glitching FX layers … and then the actual scene itself
 * or multiples". The performance role is a LOOK (ruling 7); the stack reads bottom to top
 * through each Layer's `below`: input → look → look → FX → mapping → output.
 *
 * EVERY LAYER TAKES ITS PICTURE BY NAME (the design doc §3 writes all three that way).
 * When this was written it was also the only way the app offered; since B233 `picture`
 * takes a wire too, and a wire wins over the name. The example stays by name: that is
 * what a preset recalls, and swapping a look is one parameter write.
 *
 * IT SHIPS BEFORE THE FIRST GO: the rings layer ghosted at 0.25 over the input, the grid
 * and FX layers ON at opacity 0, every bank's Current and the list's Current empty. The
 * first GO fires `1 open`: the rings come up and the two idle layers are switched OFF,
 * which takes their chains out of the plan. They ship ON because an example is held to
 * §V25 (`runner.test.ts`, "no dead nodes"): a layer shipped off would ship its whole look
 * pruned, and a reader could not tell that from a wiring mistake.
 *
 * `source` is a Noise so the file needs no hardware; a Webcam (or its device
 * "Phone · <name>") replaces it by taking over the one wire into `layerRings`.
 *
 * NO WINDOW OUT NODE: a Window Out is a display sink that is active only while its window
 * is open, so a headless compile prunes it and §V25's "no dead nodes" (`runner.test.ts`)
 * would name it. The Mapping note says how to add one.
 *
 * Annotations sit BESIDE the nodes they describe (§V389 has no rule for a box that
 * contains nodes). Every node's label is its id, so a bank's target, a cue's bank and the
 * `.md`'s `name(type)` all spell one word.
 */

const LOOKS: readonly Preset[] = [
  {
    name: "dawn",
    values: {
      ringsSrc: { period: 2.5 },
      rings: { hueoffset: 0, saturation: 0.7, value: 1 },
      grid: { r: 0, s: [1, 1] },
    },
  },
  {
    name: "noon",
    values: {
      ringsSrc: { period: 5 },
      rings: { hueoffset: 40, saturation: 1.2, value: 1.1 },
      grid: { r: 15, s: [1.5, 1.5] },
    },
  },
  {
    name: "riot",
    values: {
      ringsSrc: { period: 9 },
      rings: { hueoffset: 120, saturation: 1.8, value: 1.2 },
      // THE WHOLE SLOT (ruling 2): this preset's rotation is an expression, and Recall brings
      // the expression back — the grid rocks — not the angle it happened to read when stored.
      grid: { r: expressionSlot("sin(abstime * 0.7) * 45", 45), s: [0.6, 0.6] },
    },
  },
];

const FX: readonly Preset[] = [
  { name: "clean", values: { shear: { weight: [0, 0] }, glitch: { hueoffset: 0, saturation: 1, value: 1 } } },
  { name: "dirty", values: { shear: { weight: [0.15, 0] }, glitch: { hueoffset: -30, saturation: 1.6, value: 1.1 } } },
  { name: "acid", values: { shear: { weight: [0.05, 0.05] }, glitch: { hueoffset: 140, saturation: 2, value: 1 } } },
];

const SHOTS: readonly Preset[] = [
  {
    name: "open",
    values: { layerRings: { opacity: 1 }, layerGrid: { opacity: 0 }, layerFx: { opacity: 0 } },
    on: { layerRings: true, layerGrid: false, layerFx: false },
    recalls: [
      { bank: "looks", preset: "dawn" },
      { bank: "fx", preset: "clean" },
    ],
    morph: { seconds: 2, curve: "smooth" },
  },
  {
    // The crossfade idiom (the design doc §7.3): switch the upper layer ON — a cut, at the
    // start — and morph its opacity up from the 0 the previous shot left it at.
    name: "cross",
    values: { layerGrid: { opacity: 1 } },
    on: { layerGrid: true },
    morph: { seconds: 2, curve: "smooth" },
  },
  {
    // No morph of its own and the bank's Morph is 0: a cut.
    name: "drop",
    values: { layerFx: { opacity: 0.85 } },
    on: { layerRings: false, layerFx: true },
    recalls: [
      { bank: "looks", preset: "riot" },
      { bank: "fx", preset: "dirty" },
    ],
  },
  {
    // Fades the grid and the FX away and leaves both layers ON at 0 (ruling 13: switching a
    // faded layer off is the performer's next cue — here `1 open`, which the list wraps to).
    name: "out",
    values: { layerRings: { opacity: 1 }, layerGrid: { opacity: 0 }, layerFx: { opacity: 0 } },
    on: { layerRings: true },
    recalls: [{ bank: "looks", preset: "dawn" }],
    morph: { seconds: 4, curve: "smooth" },
  },
];

const CUES: readonly Cue[] = [
  // No morph of its own: the shot's 2 s.
  { name: "1 open", bank: "shots", preset: "open", note: "rings alone" },
  // A cue can fire a look's preset directly; nothing but the looks moves.
  { name: "2 warm", bank: "looks", preset: "noon", morph: { seconds: 4, curve: "smooth" }, note: "the looks go to noon" },
  // The cue's morph beats the shot's own 2 s.
  { name: "3 cross", bank: "shots", preset: "cross", morph: { seconds: 1, curve: "linear" }, note: "grid fades in over the rings" },
  { name: "4 drop", bank: "shots", preset: "drop", note: "cut: rings off, riot, glitch on" },
  { name: "5 out", bank: "shots", preset: "out", note: "back to the rings; GO again wraps to 1" },
];

/** T1516b — the Show desk's board: eight columns, five rows. */
const SHOW_DESK_BOARD = serializePanelBoard({
  columns: 8,
  items: [
    { label: "Shots", rect: { x: 0, y: 0, w: 8, h: 1 } },
    { member: "shots", rect: { x: 0, y: 1, w: 8, h: 1 } },
    { member: "set", rect: { x: 0, y: 2, w: 4, h: 2 } },
    { label: "Glitch FX", rect: { x: 4, y: 2, w: 4, h: 1 } },
    { member: "layerFx", rect: { x: 4, y: 3, w: 4, h: 1 } },
    { member: "master", rect: { x: 0, y: 4, w: 4, h: 1 } },
    { member: "keystone", rect: { x: 4, y: 4, w: 4, h: 1 } },
  ],
});

/** The keystone the file ships at: how far each top pin is pulled in, as a fraction of the width. */
const KEYSTONE = 0.12;

/** Rows: the stack, look A and the FX chain under it, look B under that, then the desk. */
const LOOK_A_Y = 250;
const LOOK_B_Y = 500;
const DESK_Y = 780;
const NOTE_Y = -190;
/**
 * Under the bank row. A bank's box is its header — plus, on `looks` and `fx`, the "+ panel"
 * button a bank off the one Panel draws (T1527b: 63px, not 34), which is what this clears.
 */
const DESK_NOTE_Y = 890;

export const setListDocument = document(
  "e82-set-list",
  "E82 Set List",
  settings({ randomSeed: 82 }),
  graph(
    [
      // ---- the input: whatever feeds the bottom `below` --------------------------------
      node("source", "noise", [-2400, 0], {
        type: "simplex3d",
        mono: false,
        period: 0.8,
        harmon: 2,
        // 0.5 + 0.5·n·amp + offset: a dim, slowly drifting field around 0.14.
        amp: 0.4,
        offset: -0.36,
        speed: 0.12,
      }, { label: "source" }),

      // ---- look A: rings -------------------------------------------------------------
      node("ringsSrc", "ramp", [-2400, LOOK_A_Y], {
        type: "radial",
        interp: "linear",
        period: 2.5,
        stops: [
          { position: 0, color: [0.02, 0.03, 0.08, 1] },
          { position: 0.3, color: [0.1, 0.35, 0.9, 1] },
          { position: 0.55, color: [0.95, 0.25, 0.55, 1] },
          { position: 0.8, color: [1, 0.75, 0.2, 1] },
          { position: 1, color: [0.02, 0.03, 0.08, 1] },
        ],
      }, { label: "ringsSrc", parameters: { phase: expressionSlot("abstime * 0.04", 0) } }),
      node("rings", "hsv", [-2100, LOOK_A_Y], { hueoffset: 0, saturation: 0.7, value: 1 }, { label: "rings" }),

      // ---- look B: grid --------------------------------------------------------------
      node("gridSrc", "checker", [-2400, LOOK_B_Y], {
        size: [8, 4.5],
        color1: [0.22, 0.28, 0.5, 1],
        color2: [1, 0.95, 0.8, 1],
      }, { label: "gridSrc" }),
      node("grid", "transform", [-2100, LOOK_B_Y], { r: 0, s: [1, 1], extend: "repeat" }, { label: "grid" }),

      // ---- the stack: each layer's first input is the stack below it --------------------
      // Picture is a NAME (the dashed line on the canvas): only the named node renders.
      node("layerRings", "layer", [-1800, 0], { picture: "rings", opacity: 0.25, blend: "screen" }, { label: "layerRings" }),
      // On at 0: it shows nothing and still renders the grid, until a shot switches it off.
      node("layerGrid", "layer", [-1500, 0], { picture: "grid", opacity: 0, blend: "multiply" }, { label: "layerGrid" }),

      // ---- the FX layer: the stack through a glitch, mixed back by Opacity (wet/dry) -----
      node("tear", "noise", [-1500, LOOK_B_Y], {
        type: "random",
        mono: true,
        period: 1,
        harmon: 0,
        amp: 1,
        offset: 0,
        // Wide and flat: rows of one value, so the Displace shears the picture row by row.
        s: [8, 0.04, 1],
        speed: 3,
      }, { label: "tear" }),
      node("shear", "displace", [-1200, LOOK_A_Y], { weight: [0, 0], sourcex: "red", sourcey: "red", extend: "repeat" }, { label: "shear" }),
      node("glitch", "hsv", [-900, LOOK_A_Y], { hueoffset: 0, saturation: 1, value: 1 }, { label: "glitch" }),
      // Replace: the picture IS the result, so Opacity mixes the glitched stack back over the clean one.
      node("layerFx", "layer", [-900, 0], { picture: "glitch", opacity: 0, blend: "replace" }, { label: "layerFx" }),

      // ---- master, mapping, out ---------------------------------------------------------
      node("dim", "level", [-600, 0], {}, {
        label: "dim",
        parameters: { brightness: expressionSlot("op('master').chan.master", 1) },
      }),
      node("pin", "cornerPin", [-300, 0], {
        pintl: [KEYSTONE, 1],
        pintr: [1 - KEYSTONE, 1],
        extend: "zero",
        feather: 0,
      }, {
        label: "pin",
        // A vector is mapped per component (§V113): each top pin's x reads the slider.
        parameters: {
          "pintl.x": expressionSlot("op('keystone').chan.keystone", KEYSTONE),
          "pintr.x": expressionSlot("1 - op('keystone').chan.keystone", 1 - KEYSTONE),
        },
      }),
      // Outside the pinned quad the Corner Pin is transparent; a projector shows that as black.
      node("black", "solid", [0, LOOK_A_Y], { color: [0, 0, 0, 1] }, { label: "black" }),
      node("onBlack", "over", [0, 0], { opacity: 1 }, { label: "onBlack" }),
      node("out", "output", [300, 0], {}, { label: "out" }),

      // ---- the banks, the cue list -------------------------------------------------------
      node("looks", "presets", [-2400, DESK_Y], {
        targets: "ringsSrc.period rings grid.r grid.s",
        presets: serializePresetBank({ version: 1, presets: LOOKS }),
      }, { label: "looks" }),
      node("fx", "presets", [-2180, DESK_Y], {
        targets: "shear.weight glitch",
        presets: serializePresetBank({ version: 1, presets: FX }),
      }, { label: "fx" }),
      node("shots", "presets", [-1960, DESK_Y], {
        targets: "layerRings.opacity layerGrid.opacity layerFx.opacity",
        presets: serializePresetBank({ version: 1, presets: SHOTS }),
      }, { label: "shots" }),
      node("set", "cueList", [-1520, DESK_Y], {
        wrap: true,
        keys: true,
        cues: serializeCueList({ version: 1, cues: CUES }),
      }, { label: "set" }),

      // ---- the desk: two sliders by wire; the bank, the list and the layer by name -------
      node("master", "slider", [-1000, DESK_Y], { channel: "master", caption: "Master", value: 1, min: 0, max: 1.5, step: 0 }, { label: "master" }),
      node("keystone", "slider", [-780, DESK_Y], { channel: "keystone", caption: "Keystone", value: KEYSTONE, min: 0, max: 0.4, step: 0 }, { label: "keystone" }),
      node("desk", "panel", [-560, DESK_Y], { title: "Show desk", remote: true, board: SHOW_DESK_BOARD }, { label: "desk" }),

      // ---- the annotations ----------------------------------------------------------------
      node("noteLooks", "annotate", [-2960, LOOK_A_Y], {
        title: "Looks",
        body: [
          "A look is a picture a layer shows by name: here rings (ringsSrc into rings) and grid (gridSrc into grid).",
          "source stands in for a camera. Wire a Webcam there instead, or pick its device Phone · <name>.",
          "A look can be any chain, or a component you saved.",
        ].join("\n"),
        color: "generator",
      }, { label: "noteLooks", size: { width: 520, height: 140 } }),
      node("noteLayers", "annotate", [-1800, NOTE_Y], {
        title: "Layers",
        body: [
          "The stack runs left to right through Below. Picture names the look a layer adds (the dashed line).",
          "Off is bypass: the stack passes through and the look stops rendering, so an off layer costs nothing.",
          "Opacity is the fade. At 0 the look still renders until you switch the layer off.",
          "layerFx shows glitch, the stack run through the effect, with Replace: its Opacity is the wet/dry.",
        ].join("\n"),
        color: "composite",
      }, { label: "noteLayers", size: { width: 600, height: 140 } }),
      node("noteMapping", "annotate", [-600, NOTE_Y], {
        title: "Mapping: Corner Pin",
        body: [
          "pin is the last stage: it pins the picture's corners onto your surface.",
          "Drag the pins on its preview tile. The Keystone slider pulls the two top pins in.",
          "For a projector, add a Window Out, set its Source to onBlack and open it on that screen.",
        ].join("\n"),
        color: "output",
      }, { label: "noteMapping", size: { width: 460, height: 140 } }),
      node("noteBanks", "annotate", [-2400, DESK_NOTE_Y], {
        title: "Banks: Store and Recall",
        body: [
          "A Presets node is a bank. Targets lists what it holds: a node, or node.key.",
          "Store saves the targets under a name. Recall writes them back in one undo step.",
          "A preset keeps the whole slot: riot holds an expression for the grid's rotation, and Recall brings the expression back.",
          "looks holds both looks' settings; fx holds the glitch chain's.",
        ].join("\n"),
        color: "value",
      }, { label: "noteBanks", size: { width: 400, height: 180 } }),
      node("noteShots", "annotate", [-1960, DESK_NOTE_Y], {
        title: "Shots",
        body: [
          "A shot is a preset that sets layers and recalls other banks' presets in the same step.",
          "drop switches layerRings off and layerFx on, sets the FX to 0.85, and recalls looks riot and fx dirty.",
          "Its own values win over what it recalls. A shot with a morph fades everything it changed together.",
        ].join("\n"),
        color: "color",
      }, { label: "noteShots", size: { width: 400, height: 180 } }),
      node("noteCues", "annotate", [-1520, DESK_NOTE_Y], {
        title: "Cue list",
        body: [
          "set is the running order: each cue names a bank and a preset, with its own morph time.",
          "GO fires the next cue and moves on; BACK fires the one before. Wrap goes round after the last.",
          "Press GO on the Show desk, or use the GO key and the BACK key (Help lists them under Shortcuts).",
          "1 open fades over 2 s, 2 warm over 4 s, 3 cross over 1 s, 4 drop cuts, 5 out fades over 4 s.",
        ].join("\n"),
        color: "temporal",
      }, { label: "noteCues", size: { width: 460, height: 220 } }),
      node("notePhone", "annotate", [-340, DESK_Y], {
        title: "Show desk and phone",
        body: [
          "desk shows the shots, GO and BACK, the FX layer's switch and fader, and two sliders.",
          "Drop a bank, a layer or a cue list on a Panel to add it; arrange it with the pencil.",
          `1. Start the helper: ${DEVICE_HELPER_PHONE_COMMAND}`,
          "2. Pair it in Agent → Connections.",
          "3. Press the phone icon on desk's header and scan the QR code.",
          "The phone gets this desk and nothing else in the project.",
        ].join("\n"),
        color: "input",
      }, { label: "notePhone", size: { width: 540, height: 180 } }),
    ],
    [
      // The stack.
      edge("e1", ["source", "out"], ["layerRings", "below"]),
      edge("e2", ["layerRings", "out"], ["layerGrid", "below"]),
      edge("e3", ["layerGrid", "out"], ["layerFx", "below"]),
      edge("e4", ["layerFx", "out"], ["dim", "input"]),
      edge("e5", ["dim", "out"], ["pin", "input"]),
      edge("e6", ["pin", "out"], ["onBlack", "in1"]),
      edge("e14", ["black", "out"], ["onBlack", "in2"]),
      edge("e15", ["onBlack", "out"], ["out", "input"]),
      // The looks. Their layers name them: `rings`, `grid`.
      edge("e7", ["ringsSrc", "out"], ["rings", "input"]),
      edge("e8", ["gridSrc", "out"], ["grid", "input"]),
      // The FX chain reads the stack; `layerFx` names its end, `glitch`.
      edge("e9", ["layerGrid", "out"], ["shear", "source"]),
      edge("e10", ["tear", "out"], ["shear", "disp"]),
      edge("e11", ["shear", "out"], ["glitch", "input"]),
      // The desk's wired members, in order.
      edge("e12", ["master", "out"], ["desk", "controls"], 0),
      edge("e13", ["keystone", "out"], ["desk", "controls"], 1),
    ],
  ),
);
