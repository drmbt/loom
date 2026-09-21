import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { edge, node as buildNode, expressionSlot } from "./builders.ts";
import { configureResonanceLightPass } from "./resonance.ts";
import { resonanceStage } from "./monument-halls.ts";
import { DEBRIS_ATTRIBUTES, DEBRIS_KERNEL } from "../shaders/resonance-shell.ts";
import {
  HALO_CAPACITY,
  HALO_COLUMNS,
  HALO_KERNEL,
  HALO_ROWS,
  HULL_KERNEL,
  INSTALLATION_ATTRIBUTES,
  INSTALLATION_MIRROR_KERNEL,
  MONOLITH_ATTRIBUTES,
} from "../shaders/resonance-installations.ts";

/**
 * E79 CRUCIBLE (T1349b) — an audio-reactive lit-geometry scene after the owner's Unreal
 * reference: a white-hot ring as the key light in a dark hangar, blocky panelled hulls on
 * an orbit around it, ember debris, red haze. Inspired, not copied: the ring is a torus
 * that faces the eye, the hulls are the monolith face-walk turned tangent to an orbit, the
 * hall is E75's stage with eight tall bays and the projection dimmed to a glow.
 *
 * ## The chain IS the example
 *
 * The reference graph drives everything from two rows of an eighteen-band equaliser on the
 * source node — `109 Hz → Normalize(min, max, clamp) → Beat` and `968 Hz → Normalize →
 * Tail` — and that chain is now expressible here node for node (T1347b, T1348b):
 *
 *   clip1 ─ band109x1 (Select `band109`) ─ beatrange1 (Range 0.40..0.62, clamp) ─ beat1 (Beat)
 *   clip1 ─ band968x1 (Select `band968`) ─ tailrange1 (Range 0.40..0.58, clamp) ─ tail1 (Tail 1.4 s)
 *
 * `beat1` flashes the halo, the point light that IS the halo's light on the hulls, and the
 * hulls' panel seams; `tail1` pushes the orbit round, lifts the bodies and swells the tube.
 *
 * ## The bounds are MEASURED, not guessed (§V914's discipline applied before shipping)
 *
 * On the shipped clip through the app's own offline walk, `band109` rests at 0.30–0.35 and
 * peaks near 0.60 on every kick (beat-locked mean profile, 1800 frames); `band968` lives in
 * 0.42–0.50 with a p90 of 0.61. So the beat Range puts 0.40..0.62 onto 0..1 and Beat's
 * threshold of 0.5 fires at a raw 0.51 — above every rest frame, below every kick — with a
 * 0.3 s hold-off (the clip is 124 bpm, a beat every 0.484 s). The tail Range puts
 * 0.40..0.58 onto 0..1 so the slow lane sweeps most of its span. A different track retunes
 * the four bounds and nothing else; that is what having them on the node's face is for.
 *
 * ## Liveliness is structural (§V903)
 *
 * The orbit turns on `absTime` and the ring's heat travels on `absTime`, so a silent
 * track still moves; the audio adds, it does not carry. Every retained value sits inside
 * the lane's driven range (§V914): halo energy 0.15 against 0..1, drift 0.4 against 0..1,
 * light 8 against 3..63.
 */
const mappedTint: ParameterSlot = { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } };
const mappedEmission: ParameterSlot = { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "emission" } } };
const BEAT = "op('beat1').chan.band109";
const TAIL = "op('tail1').chan.band968";

function node(id: string, type: string, position: readonly [number, number], parameters: GraphNode["parameters"], extra: Partial<GraphNode>): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

function crucibleDocumentBuild(): ProjectDocument {
  const doc = resonanceStage("crucible", "crucible", "E79 Crucible", 79);
  delete doc.graph.nodes["backLight"];
  doc.graph.nodes["bloom"]!.parameters["strength"] = 0.22;
  doc.graph.nodes["bloom"]!.parameters["threshold"] = 0.8;
  doc.graph.nodes["room"]!.parameters["haze"] = 0.03;
  doc.graph.nodes["room"]!.parameters["panelBrightness"] = 0.08;
  doc.graph.nodes["room"]!.parameters["exposure"] = 0.5;
  doc.graph.nodes["shot"]!.parameters["environmentIntensity"] = 0.08;
  const nodes: GraphNode[] = [
    // ── The chain: two spectrum rows, each Select → Range → Beat / Tail ──
    node("band109", "valueSelect", [-1900, 1150], { channels: "band109" }, { label: "band109x1" }),
    node("beatRange", "valueRange", [-1600, 1150], { fromLow: 0.38, fromHigh: 0.6, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "beatrange1" }),
    node("beat", "valueBeat", [-1300, 1150], { threshold: 0.5, retrigger: 0.3, tail: 0.35, decay: "exponential" }, { label: "beat1" }),
    node("band968", "valueSelect", [-1900, 1400], { channels: "band968" }, { label: "band968x1" }),
    node("tailRange", "valueRange", [-1600, 1400], { fromLow: 0.4, fromHigh: 0.58, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "tailrange1" }),
    node("tail", "valueTail", [-1300, 1400], { tail: 1.4, decay: "linear" }, { label: "tail1" }),
    // ── Materials and lights ──
    node("haloMat", "materialUnlit", [-2250, -480], { color: [1, 1, 1, 1] }, { label: "halomat1" }),
    node("seamGlow", "materialUnlit", [-2250, -240], { color: [1, 1, 1, 1] }, { label: "seamglow1" }),
    node("hullPaint", "materialPbr", [-2550, -240], { color: [0.7, 0.7, 0.72, 1], metallic: 0.35, roughness: 0.62 }, { label: "hullpaint1" }),
    node("hullKey", "light", [-2850, -560], { kind: "directional", color: [0.6, 0.66, 0.8, 1], intensity: 0.28, shadows: true, shadowExtent: 16, direction: [-0.45, -0.6, -0.65] }, { label: "hullkey1" }),
    node("haloLight", "light", [-2550, -560], { kind: "point", color: [1, 0.3, 0.08, 1], intensity: expressionSlot(`3 + ${BEAT} * 60`, 8), position: [0, 5.6, 0] }, { label: "halolight1" }),
    // ── The halo ──
    node("haloGrid", "pointGrid", [-4300, 0], { cols: HALO_COLUMNS, rows: HALO_ROWS, count: HALO_CAPACITY, sizeX: 2, sizeY: 2 }, { label: "halogrid1" }),
    node("haloForm", "pointKernel", [-4000, 0], { capacity: HALO_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: HALO_KERNEL, radius: 2.7, tube: 0.075, height: 5.6, tilt: 0.12, energy: expressionSlot(BEAT, 0.1), breath: expressionSlot(TAIL, 0.4) }, { label: "haloform1" }),
    node("haloMesh", "geometry", [-3680, 0], { mode: "surface", material: "halomat1", tint: mappedTint }, { label: "halomesh1" }),
    node("haloMirror", "pointKernel", [-3370, 90], { capacity: HALO_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: INSTALLATION_MIRROR_KERNEL }, { label: "halomirror1" }),
    node("haloReflection", "geometry", [-3060, 90], { mode: "surface", material: "halomat1", tint: mappedTint }, { label: "haloreflection1" }),
    // ── Ember debris ──
    node("dustMat", "materialUnlit", [-700, 1500], { color: [1, 0.45, 0.2, 1] }, { label: "dustmat1" }),
    node("debris", "pointKernel", [-1300, 1700], { capacity: 900, seed: 79, attributes: DEBRIS_ATTRIBUTES, kernel: DEBRIS_KERNEL, paletteCycle: 0, rotation: expressionSlot("abstime * 3", 0), expansion: expressionSlot(`clamp(${TAIL} * 0.5 + ${BEAT} * 0.5, 0, 1)`, 0.3), highs: expressionSlot("op('detail1').chan.hatCount", 0) }, { label: "debris1" }),
    node("dust", "geometry", [-1000, 1700], { mode: "points", material: "dustmat1", tint: mappedTint, scale: { mode: "map", bindings: { static: { kind: "static", value: 1 }, map: { kind: "map", attribute: "size" } } }, soft: 1, blend: "additive", group: "p.size < 0.025" }, { label: "dust1" }),
  ];
  const edges: GraphEdge[] = [
    edge("clip-band109", ["clip", "out"], ["band109", "in"]), edge("band109-range", ["band109", "out"], ["beatRange", "in"]), edge("range-beat", ["beatRange", "out"], ["beat", "in"]),
    edge("clip-band968", ["clip", "out"], ["band968", "in"]), edge("band968-range", ["band968", "out"], ["tailRange", "in"]), edge("range-tail", ["tailRange", "out"], ["tail", "in"]),
    edge("halo-grid", ["haloGrid", "out"], ["haloForm", "in"]), edge("halo-mesh", ["haloForm", "out"], ["haloMesh", "points"]), edge("halo-mirror", ["haloForm", "out"], ["haloMirror", "in"]), edge("halo-reflection", ["haloMirror", "out"], ["haloReflection", "points"]),
    edge("debris-dust", ["debris", "out"], ["dust", "points"]),
  ];
  const scenes: string[] = ["halomesh1", "haloreflection1", "dust1"];
  // Six hulls on two interleaved orbits: the near three larger and lower, the far three smaller and higher.
  const hulls = [
    { orbit: 4.3, width: 1.4, depth: 1.0, length: 2.6, height: 5.3 },
    { orbit: 5.4, width: 1.1, depth: 0.8, length: 2.0, height: 6.1 },
    { orbit: 4.3, width: 1.5, depth: 0.95, length: 2.9, height: 5.4 },
    { orbit: 5.4, width: 1.0, depth: 0.75, length: 1.8, height: 6.3 },
    { orbit: 4.3, width: 1.3, depth: 1.05, length: 2.4, height: 5.2 },
    { orbit: 5.4, width: 1.15, depth: 0.85, length: 2.1, height: 6.0 },
  ] as const;
  hulls.forEach((hull, index) => {
    const id = `hull${String(index)}`, grid = `${id}Grid`, form = `${id}Form`, mesh = `${id}Mesh`, mirror = `${id}Mirror`, reflection = `${id}Reflection`, glow = `${id}Glow`;
    const capacity = 129 * 129;
    const y = 300 + index * 230;
    nodes.push(
      node(grid, "pointGrid", [-4300, y], { cols: 129, rows: 129, count: capacity, sizeX: 1, sizeY: 1 }, { label: `${id}grid1` }),
      node(form, "pointKernel", [-4000, y], { capacity, attributes: MONOLITH_ATTRIBUTES, kernel: HULL_KERNEL, slot: index, count: hulls.length, orbit: hull.orbit, height: hull.height, width: hull.width, depth: hull.depth, length: hull.length, speed: 0.035, phase: index, drift: expressionSlot(TAIL, 0.4), burst: expressionSlot(BEAT, 0.1) }, { label: `${id}form1` }),
      node(mesh, "geometry", [-3680, y], { mode: "surface", material: "hullpaint1", tint: mappedTint }, { label: `${id}mesh1` }),
      node(mirror, "pointKernel", [-3370, y + 90], { capacity, attributes: MONOLITH_ATTRIBUTES, kernel: INSTALLATION_MIRROR_KERNEL }, { label: `${id}mirror1` }),
      node(reflection, "geometry", [-3060, y + 90], { mode: "surface", material: "hullpaint1", tint: mappedTint }, { label: `${id}reflection1` }),
      node(glow, "geometry", [-2770, y], { mode: "beam", endpoint: "end", material: "seamglow1", tint: mappedEmission, scale: 0.022, soft: 1, blend: "additive", group: "p.fissure > 0.5" }, { label: `${id}glow1` }),
    );
    edges.push(edge(`${id}-grid`, [grid, "out"], [form, "in"]), edge(`${id}-mesh`, [form, "out"], [mesh, "points"]), edge(`${id}-mirror`, [form, "out"], [mirror, "in"]), edge(`${id}-reflection`, [mirror, "out"], [reflection, "points"]), edge(`${id}-glow`, [form, "out"], [glow, "points"]));
    scenes.push(`${id}mesh1`, `${id}reflection1`, `${id}glow1`);
  });
  for (const entry of nodes) doc.graph.nodes[entry.id] = entry;
  for (const entry of edges) doc.graph.edges[entry.id] = entry;
  doc.graph.nodes["shot"]!.parameters["scenes"] = scenes.join(" ");
  doc.graph.nodes["shot"]!.parameters["lights"] = "hullkey1 halolight1 fill1";
  configureResonanceLightPass(doc);
  return doc;
}

export const crucibleDocument = crucibleDocumentBuild();
