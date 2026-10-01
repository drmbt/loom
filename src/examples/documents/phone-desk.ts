import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";
import { DEVICE_HELPER_PHONE_COMMAND } from "../../devices/helper.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";

/**
 * E81 — Phone Desk. THE LIVE CONTROLS, WIRED THE WAY A USER WIRES THEM.
 *
 *   rings1(ramp) ─► level1(level) ─► hue1(hsv) ─► pin1(cornerPin) ─► lay1(over) ─► out1(output)
 *                     ▲ brightness     ▲ hueoffset   ▲ pintr.x / pintr.y
 *                     ▲ invert         │             │               bg1(solid) ┘
 *   heat(slider)  invert(toggle)  flash(button)  warp(xyPad) ─► panel1(panel, Phone on)
 *        └──────────────┴──────────────┴──── out → controls, in this order ──┘
 *
 * Four widget nodes (T1388b) drive a small picture, and one Panel shows them with `remote`
 * on, so a paired phone gets the same four controls (T1396b). The widgets join the Panel
 * the way T1512b made the idiom: WIRED into its `controls` input, the edge order being the
 * order on the Panel, with the Layout text left empty (the override is for documents laid
 * out before the wiring existed). The last stage is Corner Pin (T1491b), the mapping, with
 * its top-right pin on the XY pad: the phone literally drags the corner of the projected
 * picture.
 *
 * EVERY MAPPING IS THE APP'S OWN IDIOM: an expression slot reading `op('<widget>').chan.<ch>`,
 * the slot a binding from the parameter writes (T1514b's "Control from Panel" / "Drive
 * from ▸"), with the static binding retained at the widget's own default so a host with no
 * value graph renders the same picture. The widgets are named after their channels (`heat` publishes `heat`),
 * so the expression reads the same word twice and a newcomer sees where each half comes from.
 *
 * The annotate boxes explain the idiom in the network itself. They sit BESIDE the nodes they
 * describe, not behind them: §V389's layout gate (`layout.test.ts`) measures an annotation's
 * `size` like any node's box, and has no rule that lets a box contain nodes.
 *
 * `rings1` drifts on `abstime` so the card moves with nobody at the controls.
 */

/** T1516b — the Panel's board: eight columns, three rows. */
const PHONE_DESK_BOARD = serializePanelBoard({
  columns: 8,
  items: [
    { label: "Picture", rect: { x: 0, y: 0, w: 5, h: 1 } },
    { member: "heat", rect: { x: 0, y: 1, w: 5, h: 1 } },
    { member: "invert", rect: { x: 0, y: 2, w: 2, h: 1 } },
    { member: "flash", rect: { x: 2, y: 2, w: 3, h: 1 } },
    { member: "warp", rect: { x: 5, y: 0, w: 3, h: 3 } },
  ],
});

const NOTE_WIDTH = 520;
/** Below the tallest widget, the XY pad, whose square body makes it ~340px tall (`node-box.ts`). */
const NOTE_CONTROLS_Y = 800;

export const phoneDeskDocument = document(
  "e81-phone-desk",
  "E81 Phone Desk",
  settings({ randomSeed: 81 }),
  graph(
    [
      // ---- the picture: rings → level → hue → corner pin → out -----------------------
      node("rings", "ramp", [-1500, 0], {
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
      }, { label: "rings1", parameters: { phase: expressionSlot("abstime * 0.04", 0) } }),
      // Each mapping is an expression slot, retained at the widget's default (T897's idiom).
      node("level", "level", [-1200, 0], {}, {
        label: "level1",
        parameters: {
          brightness: expressionSlot("op('heat').chan.heat", 1),
          invert: expressionSlot("op('invert').chan.invert", 0),
        },
      }),
      node("hue", "hsv", [-900, 0], {}, {
        label: "hue1",
        parameters: { hueoffset: expressionSlot("op('flash').chan.flashCount * 90", 0) },
      }),
      node("pin", "cornerPin", [-600, 0], {
        pintr: [0.82, 0.78],
        extend: "zero",
        feather: 0,
      }, {
        label: "pin1",
        // A vector is mapped per component (§V113): `pintr.x` and `pintr.y`, each its own slot.
        parameters: {
          "pintr.x": expressionSlot("op('warp').chan.warpX", 0.82),
          "pintr.y": expressionSlot("op('warp').chan.warpY", 0.78),
        },
      }),
      // Outside the pinned quad the Corner Pin is transparent; a projector shows that as black.
      node("bg", "solid", [-300, 216], { color: [0, 0, 0, 1] }, { label: "bg1" }),
      node("lay", "over", [-300, 0], { opacity: 1 }, { label: "lay1" }),
      node("out", "output", [0, 0], {}, { label: "out1" }),

      // ---- the controls: value nodes, each one a channel ------------------------------
      node("heat", "slider", [-1500, 400], { channel: "heat", caption: "Heat", value: 1, min: 0, max: 2, step: 0 }, { label: "heat" }),
      node("invert", "toggle", [-1200, 400], { channel: "invert", caption: "Invert", on: false }, { label: "invert" }),
      node("flash", "button", [-900, 400], { channel: "flash", caption: "Next hue", held: false, presses: 0 }, { label: "flash" }),
      node("warp", "xyPad", [-600, 400], { channel: "warp", caption: "Top-right pin", x: 0.82, y: 0.78, min: 0, max: 1 }, { label: "warp" }),

      // ---- the surface a phone sees ---------------------------------------------------
      // T1512b: the widgets JOIN the Panel by their wires (e7–e10, below). Layout stays
      // empty — the override would replace the wiring and the board.
      // T1516b: and they SIT where its board says — the pad a square on the right, the
      // slider a bar under a label, the toggle and button side by side under it — the
      // arrangement the pencil writes (on the Panel, or in the Controls tab), and the one the phone draws.
      node("panel", "panel", [0, 400], { title: "Phone Desk", remote: true, board: PHONE_DESK_BOARD }, { label: "panel1" }),

      // ---- the annotations: how to do it yourself --------------------------------------
      node("noteMapping", "annotate", [-1500, -300], {
        title: "Mapping: a parameter follows a control",
        body: [
          "Right-click a parameter in the Inspector → Control from Panel: it makes the control, binds it and adds it to the Panel.",
          "Drive from ▸ binds a control you already have. A bound parameter shows ← Heat.",
          "Underneath is an expression: op('heat').chan.heat. It is maths: op('flash').chan.flashCount * 90 turns the hue a quarter per press.",
        ].join("\n"),
        color: "value",
      }, { label: "notemapping1", size: { width: 740, height: 240 } }),
      node("noteSurface", "annotate", [-680, -300], {
        title: "Mapping to a surface: Corner Pin",
        body: [
          "pin1 pins the picture's four corners onto the output.",
          "Drag the pins on its preview tile to fit a wall.",
          "The top-right pin reads the pad: pintr x is op('warp').chan.warpX, y is op('warp').chan.warpY.",
        ].join("\n"),
        color: "output",
      }, { label: "notesurface1", size: { width: 858, height: 240 } }),
      node("noteControls", "annotate", [-1500, NOTE_CONTROLS_Y], {
        title: "Controls",
        body: [
          "A widget is a value node: no picture, one number you set by hand, read as op('heat').chan.heat.",
          "Heat is brightness and Invert flips it. Next hue turns the hue a quarter. Top-right pin drags the picture's corner.",
          "Drag it on its node or on the Panel. Button adds flashCount; XY Pad publishes warpX and warpY.",
        ].join("\n"),
        color: "input",
      }, { label: "notecontrols1", size: { width: 1078, height: 200 } }),
      node("notePanel", "annotate", [240, 260], {
        title: "Panel",
        body: [
          "A widget joins panel1 by a wire: its out into the Panel's Controls, or drop the widget on the Panel.",
          "The Panel is a board: the pencil on the Panel or in the Controls tab moves and sizes each control and adds labels.",
          "Its body on the canvas is the same board, live. The Controls tab is a bigger view of it.",
          "The phone icon on its header publishes it to a paired phone.",
        ].join("\n"),
        color: "composite",
      }, { label: "notepanel1", size: { width: NOTE_WIDTH, height: 260 } }),
      node("notePhone", "annotate", [240, 560], {
        title: "Phone",
        body: [
          `1. Start the helper: ${DEVICE_HELPER_PHONE_COMMAND}`,
          "2. Pair it in Agent → Connections.",
          "3. Press the phone icon on panel1's header and scan the QR code.",
          "4. Accept the certificate once. The phone shows this panel and nothing else.",
          "A phone can also be a camera: in a Webcam node pick the device Phone · <name>.",
        ].join("\n"),
        color: "color",
      }, { label: "notephone1", size: { width: NOTE_WIDTH, height: 260 } }),
    ],
    [
      edge("e1", ["rings", "out"], ["level", "input"]),
      edge("e2", ["level", "out"], ["hue", "input"]),
      edge("e3", ["hue", "out"], ["pin", "input"]),
      edge("e4", ["pin", "out"], ["lay", "in1"]),
      edge("e5", ["bg", "out"], ["lay", "in2"]),
      edge("e6", ["lay", "out"], ["out", "input"]),
      // The Panel's members, in the order it shows them (`panelLayout`, T1512b).
      edge("e7", ["heat", "out"], ["panel", "controls"], 0),
      edge("e8", ["invert", "out"], ["panel", "controls"], 1),
      edge("e9", ["flash", "out"], ["panel", "controls"], 2),
      edge("e10", ["warp", "out"], ["panel", "controls"], 3),
    ],
  ),
);
