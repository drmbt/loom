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
 * `beat1` flashes the halo, the seams on every hull and the shard embers; through `punch1`
 * (a 50 ms attack) it drives the point light that IS the halo's light and the haze, so the
 * frame punches on a hit rather than strobing (measured: the instant jump was 70% of the
 * frame's luminance in one frame); `tail1` pushes every orbit round, swells the
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
/** The hit with a 50 ms attack (`punch1`): the LIGHT and the haze ride this, so a hit punches rather than strobes. */
const PUNCH = "op('punch1').chan.band109";
const TAIL = "op('tail1').chan.band968";
const LEVEL = "clamp(op('body1').chan.level, 0, 1)";
const HIGHS = "clamp(op('detail1').chan.hatCount, 0, 1)";
const mappedTint: ParameterSlot = { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } };
const mappedEmission: ParameterSlot = { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "emission" } } };

function node(id: string, type: string, position: readonly [number, number], parameters: GraphNode["parameters"], extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

/** The camera's drift, as the numbers the haze pass mirrors (§V316: one vocabulary). */
const CAMERA = { eye: [0, 1, 25.5], lookAt: [0, 0.2, 0], fov: 58 } as const;
// THE CAMERA SWOOPS. A spherical orbit about the ring whose radius breathes 15..27, whose
// azimuth swings ±1.1 rad across the front and whose elevation dips to a low angle looking
// up through the teeth — the reference's shots, one continuous path, on absolute time.
const ORBIT_R = "(21 + 6 * sin(abstime * 0.017))";
const ORBIT_AZ = "(1.1 * sin(abstime * 0.02))";
const ORBIT_EL = "(0.45 * sin(abstime * 0.013 + 1))";
const EYE_X = `${ORBIT_R} * sin(${ORBIT_AZ}) * cos(${ORBIT_EL})`;
const EYE_Y = `${ORBIT_R} * sin(${ORBIT_EL})`;
const EYE_Z = `${ORBIT_R} * cos(${ORBIT_AZ}) * cos(${ORBIT_EL})`;
const AIM_X = "0.8 * sin(abstime * 0.031)";
const AIM_Y = "0.5 * sin(abstime * 0.027)";

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
    node("beat", "valueBeat", [-2500, 800], { threshold: 0.5, retrigger: 0.3, tail: 0.5, decay: "exponential" }, { label: "beat1" }),
    node("punch", "valueLag", [-2500, 1300], { lag: 0.05, releaseRatio: 1 }, { label: "punch1" }),
    node("band968", "valueSelect", [-3100, 1050], { channels: "band968" }, { label: "band968x1" }),
    node("tailRange", "valueRange", [-2800, 1050], { fromLow: 0.4, fromHigh: 0.58, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "tailrange1" }),
    node("tail", "valueTail", [-2500, 1050], { tail: 1.4, decay: "linear" }, { label: "tail1" }),
    // ── Camera, materials, lights ──
    node("cam", "camera", [-700, -700], {
      eye: [...CAMERA.eye], lookAt: [...CAMERA.lookAt], fov: CAMERA.fov, near: 0.1, far: 100,
      "eye.x": expressionSlot(EYE_X, 0), "eye.y": expressionSlot(EYE_Y, 1), "eye.z": expressionSlot(EYE_Z, 25.5),
      "lookAt.x": expressionSlot(AIM_X, 0), "lookAt.y": expressionSlot(AIM_Y, 0.2),
      roll: expressionSlot("sin(abstime * 0.011) * 6", 0),
    }, { label: "cam1" }),
    node("hullPaint", "materialPbr", [-2200, -700], { color: [0.85, 0.85, 0.88, 1], metallic: 0.45, roughness: 0.55 }, { label: "hullpaint1" }),
    node("shardPaint", "materialPbr", [-1900, -700], { color: [0.8, 0.78, 0.76, 1], metallic: 0.2, roughness: 0.7 }, { label: "shardpaint1" }),
    node("seamGlow", "materialUnlit", [-1600, -700], { color: [1, 1, 1, 1] }, { label: "seamglow1" }),
    node("haloMat", "materialUnlit", [-1300, -700], { color: [1, 1, 1, 1] }, { label: "halomat1" }),
    node("haloLight", "light", [-2200, -450], { kind: "point", color: [1, 0.3, 0.08, 1], intensity: expressionSlot(`8 + ${PUNCH} * 110`, 22), position: [0, 0, 0] }, { label: "halolight1" }),
    node("accentLight", "light", [-1900, -450], { kind: "point", color: [0.2, 1, 0.45, 1], intensity: expressionSlot(`8 + ${TAIL} * 50`, 26), position: [12, 5, -8] }, { label: "accentlight1" }),
    node("key", "light", [-1600, -450], { kind: "directional", color: [0.55, 0.62, 0.9, 1], intensity: 0.5, shadows: true, shadowExtent: 34, shadowSoftness: 1, direction: [-0.35, -0.55, -0.75] }, { label: "key1" }),
    node("rim", "light", [-1300, -450], { kind: "directional", color: [1, 0.4, 0.12, 1], intensity: 2.4, shadows: true, shadowExtent: 34, shadowSoftness: 1, direction: [0.15, 0.25, 1] }, { label: "rim1" }),
    // ── The halo ──
    node("haloGrid", "pointGrid", [-2200, -200], { cols: HALO_COLUMNS, rows: HALO_ROWS, count: HALO_CAPACITY, sizeX: 2, sizeY: 2 }, { label: "halogrid1" }),
    node("haloForm", "pointKernel", [-1900, -200], { capacity: HALO_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: HALO_KERNEL, radius: 4.5, tube: 0.12, height: 0, tilt: expressionSlot("sin(abstime * 0.09) * 0.3", 0.1), energy: expressionSlot(PUNCH, 0.1), breath: expressionSlot(TAIL, 0.4) }, { label: "haloform1" }),
    node("haloMesh", "geometry", [-1600, -200], { mode: "surface", material: "halomat1", tint: mappedTint }, { label: "halomesh1" }),
    // ── Post: depth-packed haze, bloom, FXAA ──
    node("shot", "render", [-700, 0], { scenes: "", camera: "cam1", lights: "halolight1 accentlight1 key1 rim1", background: [0, 0, 0, 1], environmentIntensity: 0, environmentTaps: 4, ambientColor: [0.5, 0.55, 0.7, 1], ambientIntensity: 0.008, antialias: "msaa", depthOutput: true }, { label: "shot1" }),
    node("opaqueAlpha", "reorder", [-400, 0], { outa: "one" }, { label: "opaquealpha1" }),
    node("depthPack", "mask", [-100, 0], { channel: "red", apply: "alpha", invert: 0 }, { label: "depthpack1" }),
    node("haze", "customWgsl", [200, 0], {
      source: CRUCIBLE_HAZE_WGSL, far: expressionSlot("op('cam1').par.far", 100), fov: expressionSlot("op('cam1').par.fov", CAMERA.fov),
      eye: [...CAMERA.eye], aim: [...CAMERA.lookAt],
      "eye.x": expressionSlot("op('cam1').par.eye.x", 0), "eye.y": expressionSlot("op('cam1').par.eye.y", 1), "eye.z": expressionSlot("op('cam1').par.eye.z", 25.5),
      "aim.x": expressionSlot("op('cam1').par.lookAt.x", 0), "aim.y": expressionSlot("op('cam1').par.lookAt.y", 0.2), "aim.z": expressionSlot("op('cam1').par.lookAt.z", 0),
      density: 0.007, glow: 0.16, pulse: expressionSlot(PUNCH, 0.1), level: expressionSlot(LEVEL, 0.3),
    }, { label: "haze1", resolution: { mode: "project" } }),
    node("bloom", "customWgsl", [200, 300], { source: RESONANCE_BLOOM_WGSL, threshold: 0.9, strength: 0.16 }, { label: "bloom1", resolution: { mode: "scale", factor: 0.5 } }),
    node("blur", "blur", [500, 300], { size: 18, filter: "gaussian", extend: "hold" }, { label: "blur1" }),
    node("glow", "add", [800, 0], { opacity: 1 }, { label: "glow1", resolution: { mode: "project" } }),
    node("fxaa", "customWgsl", [1100, 0], { source: FXAA_WGSL, amount: 1 }, { label: "fxaa1", resolution: { mode: "project" } }),
    node("out", "output", [1400, 0], { toneMap: "filmic" }, { label: "out1" }),
  ];
  const edges: GraphEdge[] = [
    edge("clip-analysis", ["clip", "out"], ["analysis", "audio"]), edge("analysis-body", ["analysis", "levels"], ["body", "in"]), edge("analysis-detail", ["analysis", "hits"], ["detail", "in"]),
    edge("clip-band109", ["clip", "out"], ["band109", "in"]), edge("band109-range", ["band109", "out"], ["beatRange", "in"]), edge("range-beat", ["beatRange", "out"], ["beat", "in"]), edge("beat-punch", ["beat", "out"], ["punch", "in"]),
    edge("clip-band968", ["clip", "out"], ["band968", "in"]), edge("band968-range", ["band968", "out"], ["tailRange", "in"]), edge("range-tail", ["tailRange", "out"], ["tail", "in"]),
    edge("halo-grid", ["haloGrid", "out"], ["haloForm", "in"]), edge("halo-mesh", ["haloForm", "out"], ["haloMesh", "points"]),
    edge("shot-alpha", ["shot", "out"], ["opaqueAlpha", "in1"]), edge("alpha-depth", ["opaqueAlpha", "out"], ["depthPack", "input"]), edge("depth-pack", ["shot", "depth"], ["depthPack", "mask"]),
    edge("pack-haze", ["depthPack", "out"], ["haze", "input"]), edge("haze-bloom", ["haze", "out"], ["bloom", "input"]), edge("bloom-blur", ["bloom", "out"], ["blur", "input"]),
    edge("blur-glow", ["blur", "out"], ["glow", "in1"]), edge("haze-glow", ["haze", "out"], ["glow", "in2"]), edge("glow-fxaa", ["glow", "out"], ["fxaa", "input"]), edge("fxaa-out", ["fxaa", "out"], ["out", "input"]),
  ];
  const scenes: string[] = ["halomesh1"];
  // Eight swarms: six of the mid-field, two of foreground giants that cut the frame.
  // Three tiers. Inner: tangential modules on a tight ring just outside the halo. Mid:
  // radial teeth. Outer: foreground giants, nearest the lens, sparse. Each tier turns as
  // one, the inner faster than the outer; nothing tumbles.
  const swarms = [
    { tier: 0, near: 6.2, far: 7.6, small: 0.9, large: 1.6, depthNear: -2.5, depthFar: 2.5, speed: 0.006, sectors: 24, accent: 0.35 },
    { tier: 0, near: 6.6, far: 8.2, small: 0.8, large: 1.5, depthNear: -3, depthFar: 3, speed: 0.006, sectors: 24, accent: 0.25 },
    { tier: 1, near: 9, far: 12, small: 1.8, large: 3.2, depthNear: -8, depthFar: 2, speed: 0.0035, sectors: 16, accent: 0.3 },
    { tier: 1, near: 9.5, far: 12.5, small: 1.6, large: 3.0, depthNear: -7, depthFar: 3, speed: 0.0035, sectors: 16, accent: 0.2 },
    { tier: 1, near: 10, far: 13, small: 2.0, large: 3.4, depthNear: -9, depthFar: 1, speed: 0.0035, sectors: 16, accent: 0.25 },
    { tier: 1, near: 9.2, far: 12.2, small: 1.7, large: 3.1, depthNear: -6, depthFar: 4, speed: 0.0035, sectors: 16, accent: 0.3 },
    { tier: 2, near: 13, far: 16, small: 3.5, large: 5.0, depthNear: 2, depthFar: 10, speed: 0.002, sectors: 10, accent: 0.3 },
    { tier: 2, near: 14, far: 17, small: 3.8, large: 5.4, depthNear: 3, depthFar: 11, speed: 0.002, sectors: 10, accent: 0.25 },
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
      node(form, "pointKernel", [-1900, y], { capacity: SHARD_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: SHARD_KERNEL, slot: index, rate: index === 0 ? 0.05 : 0.035, inner: 9, outer: 22 + index * 5, size: index === 0 ? 0.12 : 0.2, burst: expressionSlot(BEAT, 0.1), highs: expressionSlot(HIGHS, 0) }, { label: `${id}form1` }),
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
