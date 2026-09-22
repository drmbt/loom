import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { document, edge, expressionSlot, graph, node as buildNode, settings } from "./builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../build-showcase-beat.ts";
import { FXAA_WGSL } from "../shaders/fxaa.wgsl.ts";
import { RESONANCE_BLOOM_WGSL } from "../shaders/resonance.wgsl.ts";
import { HALO_CAPACITY, HALO_COLUMNS, HALO_KERNEL, HALO_ROWS, INSTALLATION_ATTRIBUTES } from "../shaders/resonance-installations.ts";
import {
  CRUCIBLE_HAZE_WGSL,
  SHARD_CAPACITY,
  SHARD_COLUMNS,
  SHARD_COUNT,
  SHARD_KERNEL,
  SHARD_ROWS,
  SWARM_ATTRIBUTES,
  SWARM_BODIES,
  SWARM_CAPACITY,
  SWARM_COLUMNS,
  SWARM_KERNEL,
  SWARM_ROWS,
} from "../shaders/crucible.ts";

/**
 * E79 CRUCIBLE (T1349b, second cut) — a void full of machinery around a white-hot ring,
 * driven by two spectrum rows.
 *
 * The first cut inherited E75's hall and put six boxes in it; the owner: *"not even close
 * to the reference … a hundred or two hundred animated meshes and this interesting
 * layout"*. This is its own scene: eight swarm grids of 24 hulls each (two of them the
 * foreground giants that cut the frame), two streams of 900 shards, one torus, three
 * lights, a wide lens that drifts, and a post of depth haze and bloom. No
 * hall, no floor, no projection — a black void.
 *
 * ## The chain IS the example
 *
 *   clip1 ─ band109x1 (Select `band109`) ─ beatrange1 (Range 0.38..0.60, clamp) ─ beat1 (Beat)
 *   clip1 ─ band968x1 (Select `band968`) ─ tailrange1 (Range 0.40..0.58, clamp) ─ tail1 (Tail 1.4 s)
 *
 * `beat1` flashes the halo, the point light that IS the halo's light, the seams on every
 * hull, the shard wave and the haze; `tail1` pushes every orbit round, swells the
 * tube, breathes the green windows and the accent light. `body1.level` breathes the fog and
 * `detail1.hatCount` sparkles the shards — the AudioAnalysis component's two lanes.
 *
 * The bounds are MEASURED on the shipped clip (see the first cut's row): `band109` rests
 * 0.30–0.35 and peaks ~0.60 per kick; `band968` lives in 0.42–0.50.
 *
 * ## Liveliness is structural (§V903)
 *
 * Orbits, tumbles, the shard stream, the ring's travelling heat and the camera all run on
 * `absTime`; silence still moves, the audio adds. Every retained value sits inside its
 * lane's driven range (§V914).
 */
const BEAT = "op('beat1').chan.band109";
const TAIL = "op('tail1').chan.band968";
const LEVEL = "clamp(op('body1').chan.level, 0, 1)";
const HIGHS = "clamp(op('detail1').chan.hatCount, 0, 1)";
const mappedTint: ParameterSlot = { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } };
const mappedEmission: ParameterSlot = { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "emission" } } };

function node(id: string, type: string, position: readonly [number, number], parameters: GraphNode["parameters"], extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

/** The camera's drift, as the numbers the haze pass mirrors (§V316: one vocabulary). */
const CAMERA = { eye: [0, 1, 25.5], lookAt: [0, 0.2, 0], fov: 55 } as const;
const EYE_X = "sin(abstime * 0.06) * 3.5";
const EYE_Y = "0.6 + sin(abstime * 0.041) * 2";
const EYE_Z = "25 + cos(abstime * 0.06) * 2";
const AIM_X = "sin(abstime * 0.05) * 0.8";

function crucibleDocumentBuild(): ProjectDocument {
  const nodes: GraphNode[] = [
    // ── Audio: the source, the analysis component, and the chain ──
    node("clip", "audioFileIn", [-3400, 800], {
      file: SHOWCASE_BEAT_FILE, playMode: "timeline", play: true, speed: 1, cue: false, cuePoint: 0,
      trimStart: 0, trimEnd: 0, extend: "loop", volume: 1, monitor: true,
      tempoMode: "declared", bpm: SHOWCASE_BEAT.bpm, beatsPerBar: SHOWCASE_BEAT.beatsPerBar,
      beatOffset: Math.round(SHOWCASE_BEAT_OFFSET_SECONDS * 1000) / 1000,
    }, { label: "clip1" }),
    node("analysis", "component:audioAnalysis@1", [-3100, 500], { envelope: 0.12, window: 16, settle: 0.4, hitDecay: 160 }, { label: "analysis1" }),
    node("body", "valueLag", [-2800, 500], { lag: 1.1, releaseRatio: 3 }, { label: "body1" }),
    node("detail", "valueLag", [-2500, 500], { lag: 0.012, releaseRatio: 3 }, { label: "detail1" }),
    node("band109", "valueSelect", [-3100, 800], { channels: "band109" }, { label: "band109x1" }),
    node("beatRange", "valueRange", [-2800, 800], { fromLow: 0.38, fromHigh: 0.6, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "beatrange1" }),
    node("beat", "valueBeat", [-2500, 800], { threshold: 0.5, retrigger: 0.3, tail: 0.35, decay: "exponential" }, { label: "beat1" }),
    node("band968", "valueSelect", [-3100, 1050], { channels: "band968" }, { label: "band968x1" }),
    node("tailRange", "valueRange", [-2800, 1050], { fromLow: 0.4, fromHigh: 0.58, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "tailrange1" }),
    node("tail", "valueTail", [-2500, 1050], { tail: 1.4, decay: "linear" }, { label: "tail1" }),
    // ── Camera, materials, lights ──
    node("cam", "camera", [-700, -700], {
      eye: [...CAMERA.eye], lookAt: [...CAMERA.lookAt], fov: CAMERA.fov, near: 0.1, far: 100,
      "eye.x": expressionSlot(EYE_X, 0), "eye.y": expressionSlot(EYE_Y, 1), "eye.z": expressionSlot(EYE_Z, 25.5),
      "lookAt.x": expressionSlot(AIM_X, 0),
      roll: expressionSlot("sin(abstime * 0.03) * 5", 0),
    }, { label: "cam1" }),
    node("hullPaint", "materialPbr", [-2200, -700], { color: [0.85, 0.85, 0.88, 1], metallic: 0.45, roughness: 0.55 }, { label: "hullpaint1" }),
    node("shardPaint", "materialPbr", [-1900, -700], { color: [0.8, 0.78, 0.76, 1], metallic: 0.2, roughness: 0.7 }, { label: "shardpaint1" }),
    node("seamGlow", "materialUnlit", [-1600, -700], { color: [1, 1, 1, 1] }, { label: "seamglow1" }),
    node("haloMat", "materialUnlit", [-1300, -700], { color: [1, 1, 1, 1] }, { label: "halomat1" }),
    node("haloLight", "light", [-2200, -450], { kind: "point", color: [1, 0.3, 0.08, 1], intensity: expressionSlot(`12 + ${BEAT} * 160`, 28), position: [0, 0, 0] }, { label: "halolight1" }),
    node("accentLight", "light", [-1900, -450], { kind: "point", color: [0.2, 1, 0.45, 1], intensity: expressionSlot(`8 + ${TAIL} * 50`, 26), position: [12, 5, -8] }, { label: "accentlight1" }),
    node("key", "light", [-1600, -450], { kind: "directional", color: [0.5, 0.6, 0.9, 1], intensity: 0.45, shadows: true, shadowExtent: 34, direction: [-0.4, -0.7, -0.5] }, { label: "key1" }),
    // ── The halo ──
    node("haloGrid", "pointGrid", [-2200, -200], { cols: HALO_COLUMNS, rows: HALO_ROWS, count: HALO_CAPACITY, sizeX: 2, sizeY: 2 }, { label: "halogrid1" }),
    node("haloForm", "pointKernel", [-1900, -200], { capacity: HALO_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: HALO_KERNEL, radius: 4.5, tube: 0.12, height: 0, tilt: expressionSlot("sin(abstime * 0.09) * 0.3", 0.1), energy: expressionSlot(BEAT, 0.1), breath: expressionSlot(TAIL, 0.4) }, { label: "haloform1" }),
    node("haloMesh", "geometry", [-1600, -200], { mode: "surface", material: "halomat1", tint: mappedTint }, { label: "halomesh1" }),
    // ── Post: depth-packed haze, bloom, FXAA ──
    node("shot", "render", [-700, 0], { scenes: "", camera: "cam1", lights: "halolight1 accentlight1 key1", background: [0, 0, 0, 1], environmentIntensity: 0, environmentTaps: 4, ambientColor: [0.5, 0.55, 0.7, 1], ambientIntensity: 0.02, antialias: "msaa", depthOutput: true }, { label: "shot1" }),
    node("opaqueAlpha", "reorder", [-400, 0], { outa: "one" }, { label: "opaquealpha1" }),
    node("depthPack", "mask", [-100, 0], { channel: "red", apply: "alpha", invert: 0 }, { label: "depthpack1" }),
    node("haze", "customWgsl", [200, 0], {
      source: CRUCIBLE_HAZE_WGSL, far: expressionSlot("op('cam1').par.far", 100), fov: expressionSlot("op('cam1').par.fov", CAMERA.fov),
      eye: [...CAMERA.eye], aim: [...CAMERA.lookAt],
      "eye.x": expressionSlot("op('cam1').par.eye.x", 0), "eye.y": expressionSlot("op('cam1').par.eye.y", 1), "eye.z": expressionSlot("op('cam1').par.eye.z", 25.5),
      "aim.x": expressionSlot("op('cam1').par.lookAt.x", 0), "aim.y": expressionSlot("op('cam1').par.lookAt.y", 0.2), "aim.z": expressionSlot("op('cam1').par.lookAt.z", 0),
      density: 0.008, glow: 0.22, pulse: expressionSlot(BEAT, 0.1), level: expressionSlot(LEVEL, 0.3),
    }, { label: "haze1", resolution: { mode: "project" } }),
    node("bloom", "customWgsl", [200, 300], { source: RESONANCE_BLOOM_WGSL, threshold: 0.9, strength: 0.16 }, { label: "bloom1", resolution: { mode: "scale", factor: 0.5 } }),
    node("blur", "blur", [500, 300], { size: 18, filter: "gaussian", extend: "hold" }, { label: "blur1" }),
    node("glow", "add", [800, 0], { opacity: 1 }, { label: "glow1", resolution: { mode: "project" } }),
    node("fxaa", "customWgsl", [1100, 0], { source: FXAA_WGSL, amount: 1 }, { label: "fxaa1", resolution: { mode: "project" } }),
    node("out", "output", [1400, 0], { toneMap: "filmic" }, { label: "out1" }),
  ];
  const edges: GraphEdge[] = [
    edge("clip-analysis", ["clip", "out"], ["analysis", "audio"]), edge("analysis-body", ["analysis", "levels"], ["body", "in"]), edge("analysis-detail", ["analysis", "hits"], ["detail", "in"]),
    edge("clip-band109", ["clip", "out"], ["band109", "in"]), edge("band109-range", ["band109", "out"], ["beatRange", "in"]), edge("range-beat", ["beatRange", "out"], ["beat", "in"]),
    edge("clip-band968", ["clip", "out"], ["band968", "in"]), edge("band968-range", ["band968", "out"], ["tailRange", "in"]), edge("range-tail", ["tailRange", "out"], ["tail", "in"]),
    edge("halo-grid", ["haloGrid", "out"], ["haloForm", "in"]), edge("halo-mesh", ["haloForm", "out"], ["haloMesh", "points"]),
    edge("shot-alpha", ["shot", "out"], ["opaqueAlpha", "in1"]), edge("alpha-depth", ["opaqueAlpha", "out"], ["depthPack", "input"]), edge("depth-pack", ["shot", "depth"], ["depthPack", "mask"]),
    edge("pack-haze", ["depthPack", "out"], ["haze", "input"]), edge("haze-bloom", ["haze", "out"], ["bloom", "input"]), edge("bloom-blur", ["bloom", "out"], ["blur", "input"]),
    edge("blur-glow", ["blur", "out"], ["glow", "in1"]), edge("haze-glow", ["haze", "out"], ["glow", "in2"]), edge("glow-fxaa", ["glow", "out"], ["fxaa", "input"]), edge("fxaa-out", ["fxaa", "out"], ["out", "input"]),
  ];
  const scenes: string[] = ["halomesh1"];
  // Eight swarms: six of the mid-field, two of foreground giants that cut the frame.
  // Annuli around the ring (radius 7–17, the ring is 4.5), spread in depth −14..+9 along
  // Z; the lens drifts at Z 23–27, so the nearest giants cut the frame's edges.
  const swarms = [
    { near: 7.0, far: 14, small: 0.5, large: 2.4, speed: 0.022, accent: 0.3 },
    { near: 7.4, far: 15, small: 0.45, large: 2.1, speed: 0.018, accent: 0.2 },
    { near: 7.8, far: 16, small: 0.55, large: 2.8, speed: 0.016, accent: 0.25 },
    { near: 7.2, far: 14, small: 0.4, large: 1.9, speed: 0.025, accent: 0.3 },
    { near: 8.2, far: 17, small: 0.6, large: 3.0, speed: 0.013, accent: 0.2 },
    { near: 7.6, far: 15, small: 0.45, large: 2.2, speed: 0.02, accent: 0.25 },
    { near: 10, far: 16, small: 2.6, large: 4.4, speed: 0.009, accent: 0.35 },
    { near: 11, far: 17, small: 2.8, large: 4.8, speed: 0.007, accent: 0.3 },
  ] as const;
  swarms.forEach((swarm, index) => {
    const id = `swarm${String(index)}`, grid = `${id}Grid`, form = `${id}Form`, mesh = `${id}Mesh`, glow = `${id}Glow`;
    const y = 100 + index * 250;
    nodes.push(
      node(grid, "pointGrid", [-2200, y], { cols: SWARM_COLUMNS, rows: SWARM_ROWS * SWARM_BODIES, count: SWARM_CAPACITY, sizeX: 2, sizeY: 2 }, { label: `${id}grid1` }),
      node(form, "pointKernel", [-1900, y], { capacity: SWARM_CAPACITY, attributes: SWARM_ATTRIBUTES, kernel: SWARM_KERNEL, slot: index, bodies: SWARM_BODIES, ...swarm, drift: expressionSlot(TAIL, 0.4), burst: expressionSlot(BEAT, 0.1) }, { label: `${id}form1` }),
      node(mesh, "geometry", [-1600, y], { mode: "surface", material: "hullpaint1", tint: mappedTint }, { label: `${id}mesh1` }),
      node(glow, "geometry", [-1300, y], { mode: "beam", endpoint: "end", material: "seamglow1", tint: mappedEmission, scale: 0.02, soft: 1, blend: "additive", group: "p.seam > 0.5" }, { label: `${id}glow1` }),
    );
    edges.push(edge(`${id}-grid`, [grid, "out"], [form, "in"]), edge(`${id}-mesh`, [form, "out"], [mesh, "points"]), edge(`${id}-glow`, [form, "out"], [glow, "points"]));
    scenes.push(`${id}mesh1`, `${id}glow1`);
  });
  for (const index of [0, 1]) {
    const id = `shards${String(index)}`, grid = `${id}Grid`, form = `${id}Form`, mesh = `${id}Mesh`;
    const y = 100 + (swarms.length + index) * 250;
    nodes.push(
      node(grid, "pointGrid", [-2200, y], { cols: SHARD_COLUMNS, rows: SHARD_ROWS * SHARD_COUNT, count: SHARD_CAPACITY, sizeX: 2, sizeY: 2 }, { label: `${id}grid1` }),
      node(form, "pointKernel", [-1900, y], { capacity: SHARD_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: SHARD_KERNEL, slot: index, rate: index === 0 ? 0.05 : 0.035, inner: 5.5, outer: 20 + index * 5, size: index === 0 ? 0.1 : 0.18, burst: expressionSlot(BEAT, 0.1), highs: expressionSlot(HIGHS, 0) }, { label: `${id}form1` }),
      node(mesh, "geometry", [-1600, y], { mode: "surface", material: "shardpaint1", tint: mappedTint }, { label: `${id}mesh1` }),
    );
    edges.push(edge(`${id}-grid`, [grid, "out"], [form, "in"]), edge(`${id}-mesh`, [form, "out"], [mesh, "points"]));
    scenes.push(`${id}mesh1`);
  }
  const shot = nodes.find((entry) => entry.id === "shot")!;
  shot.parameters["scenes"] = scenes.join(" ");
  return document("crucible", "E79 Crucible", settings({ randomSeed: 79, outputResolution: { width: 1280, height: 720 } }), graph(nodes, edges));
}

export const crucibleDocument = crucibleDocumentBuild();
