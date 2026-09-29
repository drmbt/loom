import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";
import { DEVICE_HELPER_PHONE_COMMAND } from "../../devices/helper.ts";

/**
 * E81 — Phone Desk. THE LIVE CONTROLS, WIRED THE WAY A USER WIRES THEM.
 *
 *   rings1(ramp) ─► level1(level) ─► hue1(hsv) ─► pin1(cornerPin) ─► lay1(over) ─► out1(output)
 *                     ▲ brightness     ▲ hueoffset   ▲ pintr.x / pintr.y
 *                     ▲ invert         │             │               bg1(solid) ┘
 *   heat(slider)  invert(toggle)  flash(button)  warp(xyPad)      panel1(panel, Phone on)
 *
 * Four widget nodes (T1388b) drive a small picture, and one Panel lays them out in the
 * Controls pane with `remote` on, so a paired phone gets the same four controls (T1396b).
 * The last stage is Corner Pin (T1491b), the mapping, with its top-right pin on the XY pad:
 * the phone literally drags the corner of the projected picture.
 *
 * EVERY MAPPING IS THE APP'S OWN IDIOM: an expression slot reading `op('<widget>').chan.<ch>`,
 * byte for byte what the Controls pane's map… form writes (`controls-pane.tsx`), with the
 * static binding retained at the widget's own default so a host with no value graph renders
 * the same picture. The widgets are named after their channels (`heat` publishes `heat`),
 * so the expression reads the same word twice and a newcomer sees where each half comes from.
 *
 * The annotate boxes explain the idiom in the network itself. They sit BESIDE the nodes they
 * describe, not behind them: §V389's layout gate (`layout.test.ts`) measures an annotation's
 * `size` like any node's box, and has no rule that lets a box contain nodes.
 *
 * `rings1` drifts on `abstime` so the card moves with nobody at the controls.
 */

const NOTE_WIDTH = 520;

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
      node("panel", "panel", [0, 400], {
        title: "Phone Desk",
        layout: [
          "# Picture",
          "> Heat is brightness. Invert flips it.",
          "heat invert",
          "# Colour",
          "> Each press turns the hue a quarter.",
          "flash",
          "# Mapping",
          "> Drag the picture's top-right corner.",
          "warp",
          "",
        ].join("\n"),
        remote: true,
      }, { label: "panel1" }),

      // ---- the annotations: how to do it yourself --------------------------------------
      node("noteMapping", "annotate", [-1500, -300], {
        title: "Mapping: a parameter follows a control",
        body: [
          "Controls pane: press map… under a widget, pick the node and the parameter.",
          "Or type it into the parameter's expression yourself: op('heat').chan.heat",
          "It is maths: op('flash').chan.flashCount * 90 turns the hue a quarter per press.",
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
      node("noteControls", "annotate", [-1500, 600], {
        title: "Controls",
        body: [
          "A widget is a value node: no picture, one number you set by hand.",
          "Its Channel is the name you read: op('heat').chan.heat.",
          "Drag it here on its node, or on the Panel. Button adds flashCount; XY Pad publishes warpX and warpY.",
        ].join("\n"),
        color: "input",
      }, { label: "notecontrols1", size: { width: 1078, height: 200 } }),
      node("notePanel", "annotate", [240, 260], {
        title: "Panel",
        body: [
          "panel1 lays the widgets out in the Controls pane. Layout, one row per line:",
          "# Heading",
          "> a note",
          "heat invert   (widget names side by side)",
          "Phone on: the panel is published to a paired phone.",
        ].join("\n"),
        color: "composite",
      }, { label: "notepanel1", size: { width: NOTE_WIDTH, height: 260 } }),
      node("notePhone", "annotate", [240, 560], {
        title: "Phone",
        body: [
          `1. Start the helper: ${DEVICE_HELPER_PHONE_COMMAND}`,
          "2. Pair it in Agent → Connections.",
          "3. Press Phone in the Controls pane and scan the QR code.",
          "4. Accept the certificate once. The phone shows this panel and nothing else.",
        ].join("\n"),
        color: "color",
      }, { label: "notephone1", size: { width: NOTE_WIDTH, height: 240 } }),
    ],
    [
      edge("e1", ["rings", "out"], ["level", "input"]),
      edge("e2", ["level", "out"], ["hue", "input"]),
      edge("e3", ["hue", "out"], ["pin", "input"]),
      edge("e4", ["pin", "out"], ["lay", "in1"]),
      edge("e5", ["bg", "out"], ["lay", "in2"]),
      edge("e6", ["lay", "out"], ["out", "input"]),
    ],
  ),
);
