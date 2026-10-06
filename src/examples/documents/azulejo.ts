import { settings, node, edge, graph, document } from "./builders.ts";
import { AZULEJO_TILES_WGSL, CITY_NIGHT_WGSL, STAND_IN_FIGURES_WGSL } from "../shaders/azulejo.wgsl.ts";

/**
 * E80 — Azulejo (T1486b). TWO PICTURES AND A PERSON-SHAPED WINDOW BETWEEN THEM.
 *
 *   wgsl_tiles(customWgsl) ─┐ 0
 *   movie_clipa(movieFileIn) ┴─► switch_outer(switch) ─────────────────────────────┐ in2
 *   wgsl_city(customWgsl) ──┐ 0                                             │
 *   movie_clipb(movieFileIn) ┴─► switch_inner(switch) ─► mask_cut(mask) ─► over_wall(over) ─► output1
 *   wgsl_figures(customWgsl) ─┐ 0                    ▲ mask
 *   webcam1 ─► matte1(matte) ┤ 1                    │
 *   webcam1 ─► personmask_seg(personMask) ┴─► switch_shape(switch) ─► blur_soft(blur)
 *
 * ## The reference
 *
 * A projection on the Pavilhão de Portugal in Lisbon: a wall of blue-and-white tiles, the
 * silhouettes of two people standing in front of the camera cut out of it, and a night
 * timelapse of the city playing inside the cut. Three pictures, one of them a mask — which
 * is the whole rig, and the whole rig is stock nodes: a Mask gives the inner layer the
 * shape's coverage as alpha, and Over lays it on the outer layer.
 *
 * ## Every layer is a Switch, and index 0 is an understudy
 *
 * No media ships and no camera is opened by the card, so the file has to show its idea on
 * its own. Each Switch's first input is a stand-in shader (`azulejo.wgsl.ts`): the tiles, the
 * city, and two figures holding hands — the reference's couple. Index 1 on `switch_outer` /
 * `switch_inner` plays a Movie File In (a still or a video); index 1 on `switch_shape` is the browser
 * Matte (MediaPipe, downloaded once with consent), index 2 the Apple Vision Person Mask
 * (desktop, or the device helper on a Mac). Both read `webcam1`.
 *
 * `blur_soft` softens the cut by a few pixels whichever mask is live: a model's edge steps at
 * its own input resolution and a stand-in's is one pixel wide, and neither reads as a
 * projected light edge until it is blurred.
 */
export const azulejoDocument = document(
  "e80-azulejo",
  "E80 Azulejo",
  settings({ randomSeed: 80 }),
  graph(
    [
      // ---- the canvas the three generators take their size from ---------------------
      node("size", "solid", [-1800, 0], { color: [0, 0, 0, 1] }, { label: "solid_size" }),

      // ---- outer layer: the tiles, or your picture -----------------------------------
      node("tiles", "customWgsl", [-1500, -480], { source: AZULEJO_TILES_WGSL, rows: 5, sheen: 0.2 }, { label: "wgsl_tiles" }),
      node("clipA", "movieFileIn", [-1500, -720], { file: "", playMode: "freeRun", speed: 1 }, { label: "movie_clipa" }),
      node("outer", "switch", [-1200, -600], { index: 0 }, { label: "switch_outer" }),

      // ---- inner layer: the city, or your footage ------------------------------------
      node("city", "customWgsl", [-1500, -120], { source: CITY_NIGHT_WGSL, drift: 0.22, lights: 1 }, { label: "wgsl_city" }),
      node("clipB", "movieFileIn", [-1500, 120], { file: "", playMode: "freeRun", speed: 1 }, { label: "movie_clipb" }),
      node("inner", "switch", [-1200, 0], { index: 0 }, { label: "switch_inner" }),

      // ---- the shape: stand-ins, or the people in front of the camera ----------------
      node("figures", "customWgsl", [-1500, 360], { source: STAND_IN_FIGURES_WGSL, sway: 1 }, { label: "wgsl_figures" }),
      node("cam", "webcam", [-1800, 720], {}, { label: "webcam1" }),
      node("matte", "matte", [-1500, 600], { model: "mediapipe-selfie-segmenter" }, { label: "matte1" }),
      node("seg", "personMask", [-1500, 840], { rateLimit: 0.1, invert: false }, { label: "personmask_seg" }),
      node("shape", "switch", [-1200, 600], { index: 0 }, { label: "switch_shape" }),
      node("soft", "blur", [-900, 600], { size: 2, filter: "gaussian", extend: "hold" }, { label: "blur_soft" }),

      // ---- the cut and the wall ------------------------------------------------------
      node("cut", "mask", [-600, 0], { channel: "luminance", apply: "alpha", invert: 0 }, { label: "mask_cut" }),
      node("wall", "over", [-300, -300], { opacity: 1 }, { label: "over_wall" }),
      node("out", "output", [0, -300], {}, { label: "output1" }),
    ],
    [
      edge("e1", ["size", "out"], ["tiles", "input"]),
      edge("e2", ["size", "out"], ["city", "input"]),
      edge("e3", ["size", "out"], ["figures", "input"]),

      edge("e4", ["tiles", "out"], ["outer", "inputs"], 0),
      edge("e5", ["clipA", "out"], ["outer", "inputs"], 1),
      edge("e6", ["city", "out"], ["inner", "inputs"], 0),
      edge("e7", ["clipB", "out"], ["inner", "inputs"], 1),

      edge("e8", ["cam", "out"], ["matte", "input"]),
      edge("e9", ["cam", "out"], ["seg", "input"]),
      edge("e10", ["figures", "out"], ["shape", "inputs"], 0),
      edge("e11", ["matte", "out"], ["shape", "inputs"], 1),
      edge("e12", ["seg", "out"], ["shape", "inputs"], 2),
      edge("e13", ["shape", "out"], ["soft", "input"]),

      edge("e14", ["inner", "out"], ["cut", "input"]),
      edge("e15", ["soft", "out"], ["cut", "mask"]),
      edge("e16", ["cut", "out"], ["wall", "in1"]),
      edge("e17", ["outer", "out"], ["wall", "in2"]),
      edge("e18", ["wall", "out"], ["out", "input"]),
    ],
  ),
);
