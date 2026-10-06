import type { GraphEdge, GraphNode } from "../../domain/types/graph.ts";
import { edge, expressionSlot, node } from "../../examples/documents/builders.ts";
import type { StageFacts } from "./facts.ts";
import { chan, grey } from "./slots.ts";
import { TEST_FX_WGSL } from "./test-content.ts";

/**
 * Stage previz — the pixel lines and strobes on ONE feed (VN12).
 *
 * Resolume sends one 1920 x 1080 Syphon stream (`syphonFX`). Its TOP half is the 63 pixel lines
 * as seen from the house, its BOTTOM half the 38 strobes in plan; the map is layout.py's
 * (`fx_texel_bar`, `fx_texel_strobe`) and is baked into the GLB as uvs: every pixel-line pixel
 * and every strobe window is a quad whose uvs all name one texel, and an unlit material whose
 * albedo map is the feed shows exactly that texel there. So nothing here knows the map — moving
 * a fixture in layout.py and rebuilding moves its sample with it.
 *
 * The feed follows the Source fader with the projector feeds: 0 live Syphon, 1 test content
 * (`TEST_FX_WGSL`), 2 the pixel-map template the build writes (`fx-pixel-map.png`, the same
 * picture to load as a reference layer in Resolume). Levels: the LEDs fader for the pixel lines,
 * Strobe level for the strobes.
 */

export const FX_MAP_URL = "media/stage-previz/fx-pixel-map.png";

const FX_POSITIONS = {
  syphon: [-4400, 3920], test: [-4400, 4080], map: [-4400, 4240], feed: [-4100, 4080],
  strobeMesh: [-4400, 4440], strobeMaterial: [-4100, 4440], strobeGeometry: [-3800, 4440], note: [-3500, 3920],
} as const;

/** Wire the FX feed into a session: nodes the session already has keep their own settings. */
export function applyFx(nodes: Record<string, GraphNode>, edges: Record<string, GraphEdge>, facts: StageFacts): void {
  const put = (entry: GraphNode): void => {
    nodes[entry.id] = entry;
  };
  const wire = (entry: GraphEdge): void => {
    edges[entry.id] = entry;
  };
  const ensure = (entry: GraphNode): void => {
    if (nodes[entry.id] === undefined) put(entry);
  };
  ensure(node("syphonFX", "syphonIn", FX_POSITIONS.syphon, { source: "" }, { label: "syphonFX" }));
  ensure(node("testFX", "customWgsl", FX_POSITIONS.test, { source: TEST_FX_WGSL, speed: 0.25, level: 1 }, { label: "testFX" }));
  ensure(node("fxMap", "movieFileIn", FX_POSITIONS.map, { file: FX_MAP_URL }, { label: "fxMap" }));
  put(node("feedFX", "switch", FX_POSITIONS.feed, {}, { label: "feedFX", parameters: { index: expressionSlot(chan("source"), 1) } }));
  if (nodes["blank"] !== undefined) wire(edge("e-blank-testFX", ["blank", "out"], ["testFX", "input"]));
  wire(edge("e-syphonFX-feedFX", ["syphonFX", "out"], ["feedFX", "inputs"], 0));
  wire(edge("e-testFX-feedFX", ["testFX", "out"], ["feedFX", "inputs"], 1));
  wire(edge("e-fxMap-feedFX", ["fxMap", "out"], ["feedFX", "inputs"], 2));

  // The pixel lines: the `led` area the session already draws, now reading the feed.
  const matLed = nodes["matLed"];
  if (matLed !== undefined) put({ ...matLed, parameters: { ...matLed.parameters, color: expressionSlot(`${chan("leds")} * 2`, grey(2)) } });
  wire(edge("e-feedFX-matLed", ["feedFX", "out"], ["matLed", "albedo"]));

  // The strobes: their windows on the grated decks, a mesh area of their own.
  const strobe = facts.areas.strobe;
  put(node("meshStrobe", "meshFileIn", FX_POSITIONS.strobeMesh, { file: facts.glbUrl, select: strobe.select, vertices: strobe.vertices, triangles: strobe.triangles }, { label: "meshStrobe" }));
  put(node("matStrobe", "materialUnlit", FX_POSITIONS.strobeMaterial, {}, { label: "matStrobe", parameters: { color: expressionSlot(`${chan("strobes")} * 4`, grey(2)) } }));
  put(node("geoStrobe", "geometry", FX_POSITIONS.strobeGeometry, { mode: "surface", material: "matStrobe" }, { label: "geoStrobe" }));
  wire(edge("e-meshStrobe-geoStrobe", ["meshStrobe", "out"], ["geoStrobe", "points"]));
  wire(edge("e-feedFX-matStrobe", ["feedFX", "out"], ["matStrobe", "albedo"]));
  const stage = nodes["stage"];
  if (stage !== undefined) {
    const scenes = String(stage.parameters["scenes"] ?? "").split(/\s+/).filter(Boolean);
    if (!scenes.includes("geoStrobe")) put({ ...stage, parameters: { ...stage.parameters, scenes: [...scenes, "geoStrobe"].join(" ") } });
  }

  put(node("noteFX", "annotate", FX_POSITIONS.note, {
    title: "Pixel lines + strobes: one feed",
    body: [
      "Resolume → Syphon: pick the server in syphonFX. ONE 1920 x 1080 stream drives all 63 pixel lines and 38 strobes.",
      "Top half: the pixel lines seen from the house (30' across = 1920 px; one texel row per bar row).",
      "Bottom half: the strobes in plan, downstage at the bottom (48' across = 1920 px; the riser's back edge at the middle).",
      "Template: fx-pixel-map.png (+ .svg labelled, .csv every texel) beside the session — Source 2 shows it on the rig. Send it at 1920 x 1080, filling the frame.",
      "Levels: LEDs (pixel lines), Strobe level (strobes).",
    ].join("\n"),
    color: "input",
  }, { label: "noteFX", size: { width: 620, height: 170 } }));
}
