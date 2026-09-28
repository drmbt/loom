import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { ParameterSlot } from "../../domain/types/parameters.ts";
import { document, edge, expressionSlot, graph, node as buildNode, settings } from "./builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../build-showcase-beat.ts";
import { FXAA_WGSL } from "../shaders/fxaa.wgsl.ts";
import { RESONANCE_BLOOM_WGSL, RESONANCE_DOF_WGSL } from "../shaders/resonance.wgsl.ts";
import { HALO_CAPACITY, HALO_COLUMNS, HALO_KERNEL, HALO_ROWS, INSTALLATION_ATTRIBUTES } from "../shaders/resonance-installations.ts";
import {
  CORE_BELTS,
  CORE_BELT_ROWS,
  CORE_CAPACITY,
  CORE_COLUMNS,
  CORE_KERNEL,
  CRUCIBLE_HAZE_WGSL,
  HEART_CAPACITY,
  HEART_COLUMNS,
  HEART_KERNEL,
  HEART_ROWS,
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
 * `beat1` flashes the halo, lights the core's plate edges, the strips and the shard
 * embers; `tail1` twists and squares the core; through `punch1` the belts split and the heart
 * heats, and
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
/**
 * Five spectrum rows, five lanes, five lights (T1349b): the reference's reactivity is not one
 * flash — different parts of the structure light to different parts of the music. Bounds are
 * the clip's measured occupied ranges (p50..p90 through the offline walk): band380 0.32..0.78,
 * band1300 0.48..0.56, band3400 0.28..0.32.
 */
const LANES = {
  band109: BEAT,
  band968: "op('tail1').chan.band968",
  band380: "op('tail380x1').chan.band380",
  band1300: "op('beat1300x1').chan.band1300",
  band3400: "op('tail3400x1').chan.band3400",
} as const;
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
// THE CAMERA PUSHES IN. A slow orbit about the ring: radius 21..29, azimuth ±0.55 rad, a
// low angle (0.13..0.37 rad) looking slightly up at the core — one continuous path, on
// absolute time, nothing hurried.
const ORBIT_R = "(23 - 5 * sin(abstime * 0.01))";
const ORBIT_AZ = "(0.8 * sin(abstime * 0.011))";
const ORBIT_EL = "(0.2 + 0.25 * sin(abstime * 0.008))";
const EYE_X = `${ORBIT_R} * sin(${ORBIT_AZ}) * cos(${ORBIT_EL})`;
const EYE_Y = `${ORBIT_R} * sin(${ORBIT_EL})`;
const EYE_Z = `${ORBIT_R} * cos(${ORBIT_AZ}) * cos(${ORBIT_EL})`;
const AIM_X = "0.4 * sin(abstime * 0.017)";
const AIM_Y = "0.3 * sin(abstime * 0.013)";

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
    node("band380", "valueSelect", [-3400, 1300], { channels: "band380" }, { label: "band380x1" }),
    node("range380", "valueRange", [-3100, 1300], { fromLow: 0.32, fromHigh: 0.78, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "range380x1" }),
    node("tail380", "valueTail", [-2800, 1300], { tail: 0.6, decay: "exponential" }, { label: "tail380x1" }),
    node("band1300", "valueSelect", [-3400, 1550], { channels: "band1300" }, { label: "band1300x1" }),
    node("range1300", "valueRange", [-3100, 1550], { fromLow: 0.46, fromHigh: 0.58, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "range1300x1" }),
    node("beat1300", "valueBeat", [-2800, 1550], { threshold: 0.55, retrigger: 0.15, tail: 0.3, decay: "exponential" }, { label: "beat1300x1" }),
    node("band3400", "valueSelect", [-3400, 1800], { channels: "band3400" }, { label: "band3400x1" }),
    node("range3400", "valueRange", [-3100, 1800], { fromLow: 0.27, fromHigh: 0.33, toLow: 0, toHigh: 1, outside: "clamp" }, { label: "range3400x1" }),
    node("tail3400", "valueTail", [-2800, 1800], { tail: 0.35, decay: "linear" }, { label: "tail3400x1" }),
    // ── Camera, materials, lights ──
    node("cam", "camera", [-700, -700], {
      eye: [...CAMERA.eye], lookAt: [...CAMERA.lookAt], fov: CAMERA.fov, near: 0.1, far: 100,
      "eye.x": expressionSlot(EYE_X, 0), "eye.y": expressionSlot(EYE_Y, 1), "eye.z": expressionSlot(EYE_Z, 25.5),
      "lookAt.x": expressionSlot(AIM_X, 0), "lookAt.y": expressionSlot(AIM_Y, 0.2),
      roll: expressionSlot("sin(abstime * 0.006) * -3", 0),
    }, { label: "cam1" }),
    node("hullPaint", "materialPbr", [-2200, -700], { color: [0.8, 0.82, 0.88, 1], metallic: 0.55, roughness: 0.5 }, { label: "hullpaint1" }),
    node("seamGlow", "materialUnlit", [-1600, -700], { color: [1, 1, 1, 1] }, { label: "seamglow1" }),
    node("haloMat", "materialUnlit", [-1300, -700], { color: [1, 1, 1, 1] }, { label: "halomat1" }),
    node("haloLight", "light", [-2200, -450], { kind: "point", color: [1, 0.3, 0.08, 1], intensity: expressionSlot(`24 + ${PUNCH} * 90`, 34), position: [0, 0, 0] }, { label: "halolight1" }),
    node("accentLight", "light", [-1900, -450], { kind: "point", color: [0.2, 1, 0.45, 1], intensity: expressionSlot(`8 + ${TAIL} * 50`, 26), position: [12, 5, -8] }, { label: "accentlight1" }),
    // Three more lights on three more rows, placed AMONG the hulls so each lights its own
    // corner of the structure: amber deep left on the 380 Hz tail, white-blue high right on
    // the 1.3 kHz beat, cyan low behind on the 3.4 kHz tail.
    node("amberLight", "light", [-1000, -950], { kind: "point", color: [1, 0.55, 0.15, 1], intensity: expressionSlot(`4 + ${LANES.band380} * 70`, 25), position: [-11, -2, -8] }, { label: "amberlight1" }),
    node("flashLight", "light", [-700, -950], { kind: "point", color: [0.8, 0.85, 1, 1], intensity: expressionSlot(`${LANES.band1300} * 90`, 12), position: [9, 8, 2] }, { label: "flashlight1" }),
    node("cyanLight", "light", [-400, -950], { kind: "point", color: [0.3, 0.7, 1, 1], intensity: expressionSlot(`3 + ${LANES.band3400} * 60`, 20), position: [3, -9, -12] }, { label: "cyanlight1" }),
    node("key", "light", [-1600, -450], { kind: "directional", color: [0.55, 0.62, 0.9, 1], intensity: 0.5, shadows: true, shadowExtent: 34, shadowSoftness: 1, direction: [-0.35, -0.55, -0.75] }, { label: "key1" }),
    node("rim", "light", [-1300, -450], { kind: "directional", color: [1, 0.4, 0.12, 1], intensity: 2.4, shadows: true, shadowExtent: 34, shadowSoftness: 1, direction: [0.15, 0.25, 1] }, { label: "rim1" }),
    // ── The halo ──
    node("haloGrid", "pointGrid", [-2200, -200], { cols: HALO_COLUMNS, rows: HALO_ROWS, count: HALO_CAPACITY, sizeX: 2, sizeY: 2 }, { label: "halogrid1" }),
    node("haloForm", "pointKernel", [-1900, -200], { capacity: HALO_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: HALO_KERNEL, radius: 4.5, tube: 0.12, height: 0, tilt: expressionSlot("sin(abstime * 0.09) * 0.3", 0.1), energy: expressionSlot(PUNCH, 0.1), breath: expressionSlot(TAIL, 0.4) }, { label: "haloform1" }),
    node("haloMesh", "geometry", [-1600, -200], { mode: "surface", material: "halomat1", tint: mappedTint }, { label: "halomesh1" }),
    // ── The core: eight counter-rotating belts of plates inside the ring, over a lava heart ──
    // Own kernels (`CORE_KERNEL`, `HEART_KERNEL`). The belts turn against each other on
    // absolute time; the punch splits them apart along the axis and lights their edges; the
    // Tail lane twists the stack and squares the sphere toward a superellipsoid. The heart
    // flows and cracks white-hot through the punch. This is the thing that SHIFTS.
    node("coreMat", "materialPbr", [-1000, -450], { color: [0.55, 0.56, 0.62, 1], metallic: 0.8, roughness: 0.35 }, { label: "coremat1" }),
    node("heartMat", "materialUnlit", [-700, -450], { color: [1, 1, 1, 1] }, { label: "heartmat1" }),
    node("coreGrid", "pointGrid", [-2200, 2600], { cols: CORE_COLUMNS, rows: CORE_BELT_ROWS * CORE_BELTS, count: CORE_CAPACITY, sizeX: 2, sizeY: 2 }, { label: "coregrid1" }),
    node("coreForm", "pointKernel", [-1900, 2600], { capacity: CORE_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: CORE_KERNEL, radius: 3.3, segments: 14, spin: 0.05, split: expressionSlot(PUNCH, 0.1), morph: expressionSlot(TAIL, 0.3), ember: expressionSlot(BEAT, 0.1) }, { label: "coreform1" }),
    node("coreMesh", "geometry", [-1600, 2600], { mode: "surface", material: "coremat1", tint: mappedTint }, { label: "coremesh1" }),
    node("heartGrid", "pointGrid", [-2200, 2850], { cols: HEART_COLUMNS, rows: HEART_ROWS, count: HEART_CAPACITY, sizeX: 2, sizeY: 2 }, { label: "heartgrid1" }),
    node("heartForm", "pointKernel", [-1900, 2850], { capacity: HEART_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: HEART_KERNEL, radius: 2.7, flow: 0.12, heat: expressionSlot(PUNCH, 0.1) }, { label: "heartform1" }),
    node("heartMesh", "geometry", [-1600, 2850], { mode: "surface", material: "heartmat1", tint: mappedTint }, { label: "heartmesh1" }),
    // ── Post: depth-packed haze, bloom, FXAA ──
    node("shot", "render", [-700, 0], { scenes: "", camera: "cam1", lights: "halolight1 accentlight1 amberlight1 flashlight1 cyanlight1 key1 rim1", background: [0, 0, 0, 1], environmentIntensity: 0, environmentTaps: 4, ambientColor: [0.5, 0.55, 0.7, 1], ambientIntensity: 0.012, antialias: "msaa", depthOutput: true }, { label: "shot1" }),
    node("opaqueAlpha", "reorder", [-400, 0], { outa: "one" }, { label: "opaquealpha1" }),
    node("depthPack", "mask", [-100, 0], { channel: "red", apply: "alpha", invert: 0 }, { label: "depthpack1" }),
    node("haze", "customWgsl", [200, 0], {
      source: CRUCIBLE_HAZE_WGSL, far: expressionSlot("op('cam1').par.far", 100), fov: expressionSlot("op('cam1').par.fov", CAMERA.fov),
      eye: [...CAMERA.eye], aim: [...CAMERA.lookAt],
      "eye.x": expressionSlot("op('cam1').par.eye.x", 0), "eye.y": expressionSlot("op('cam1').par.eye.y", 1), "eye.z": expressionSlot("op('cam1').par.eye.z", 25.5),
      "aim.x": expressionSlot("op('cam1').par.lookAt.x", 0), "aim.y": expressionSlot("op('cam1').par.lookAt.y", 0.2), "aim.z": expressionSlot("op('cam1').par.lookAt.z", 0),
      density: 0.012, glow: 0.14, pulse: expressionSlot(PUNCH, 0.1), level: expressionSlot(LEVEL, 0.3),
    }, { label: "haze1", resolution: { mode: "project" } }),
    // Depth of field: focus rides the lens's own orbit radius, so the ring stays sharp and
    // the nearest giants and the far teeth soften — the reference's shallow look.
    node("lens", "customWgsl", [500, 0], { source: RESONANCE_DOF_WGSL, chromatic: 0.25, focusDistance: expressionSlot(ORBIT_R, 21), focusRange: 5, strength: 0.09, maxRadius: 1.8, far: expressionSlot("op('cam1').par.far", 100) }, { label: "lens1", resolution: { mode: "project" } }),
    node("bloom", "customWgsl", [200, 300], { source: RESONANCE_BLOOM_WGSL, threshold: 0.9, strength: 0.16 }, { label: "bloom1", resolution: { mode: "scale", factor: 0.5 } }),
    node("blur", "blur", [800, 300], { size: 18, filter: "gaussian", extend: "hold" }, { label: "blur1" }),
    node("glow", "add", [1100, 0], { opacity: 1 }, { label: "glow1", resolution: { mode: "project" } }),
    node("fxaa", "customWgsl", [1400, 0], { source: FXAA_WGSL, amount: 1 }, { label: "fxaa1", resolution: { mode: "project" } }),
    node("out", "output", [1700, 0], { toneMap: "filmic" }, { label: "out1" }),
  ];
  const edges: GraphEdge[] = [
    edge("clip-analysis", ["clip", "out"], ["analysis", "audio"]), edge("analysis-body", ["analysis", "levels"], ["body", "in"]), edge("analysis-detail", ["analysis", "hits"], ["detail", "in"]),
    edge("clip-band109", ["clip", "out"], ["band109", "in"]), edge("band109-range", ["band109", "out"], ["beatRange", "in"]), edge("range-beat", ["beatRange", "out"], ["beat", "in"]), edge("beat-punch", ["beat", "out"], ["punch", "in"]),
    edge("clip-band968", ["clip", "out"], ["band968", "in"]), edge("band968-range", ["band968", "out"], ["tailRange", "in"]), edge("range-tail", ["tailRange", "out"], ["tail", "in"]),
    edge("clip-band380", ["clip", "out"], ["band380", "in"]), edge("band380-range", ["band380", "out"], ["range380", "in"]), edge("range380-tail", ["range380", "out"], ["tail380", "in"]),
    edge("clip-band1300", ["clip", "out"], ["band1300", "in"]), edge("band1300-range", ["band1300", "out"], ["range1300", "in"]), edge("range1300-beat", ["range1300", "out"], ["beat1300", "in"]),
    edge("clip-band3400", ["clip", "out"], ["band3400", "in"]), edge("band3400-range", ["band3400", "out"], ["range3400", "in"]), edge("range3400-tail", ["range3400", "out"], ["tail3400", "in"]),
    edge("halo-grid", ["haloGrid", "out"], ["haloForm", "in"]), edge("halo-mesh", ["haloForm", "out"], ["haloMesh", "points"]),
    edge("core-grid", ["coreGrid", "out"], ["coreForm", "in"]), edge("core-mesh", ["coreForm", "out"], ["coreMesh", "points"]),
    edge("heart-grid", ["heartGrid", "out"], ["heartForm", "in"]), edge("heart-mesh", ["heartForm", "out"], ["heartMesh", "points"]),
    edge("shot-alpha", ["shot", "out"], ["opaqueAlpha", "in1"]), edge("alpha-depth", ["opaqueAlpha", "out"], ["depthPack", "input"]), edge("depth-pack", ["shot", "depth"], ["depthPack", "mask"]),
    edge("pack-haze", ["depthPack", "out"], ["haze", "input"]), edge("haze-lens", ["haze", "out"], ["lens", "input"]), edge("lens-bloom", ["lens", "out"], ["bloom", "input"]), edge("bloom-blur", ["bloom", "out"], ["blur", "input"]),
    edge("blur-glow", ["blur", "out"], ["glow", "in1"]), edge("lens-glow", ["lens", "out"], ["glow", "in2"]), edge("glow-fxaa", ["glow", "out"], ["fxaa", "input"]), edge("fxaa-out", ["fxaa", "out"], ["out", "input"]),
  ];
  const scenes: string[] = ["halomesh1", "coremesh1", "heartmesh1"];
  // Eight swarms: six of the mid-field, two of foreground giants that cut the frame.
  // A HIERARCHY OF SCALES, which is what the reference has: a hundred small modules hugging
  // the ring, three dozen mid hulls spread deep behind it, a handful of giants in front.
  // Each tier's lit strips ride their own spectrum row (see the lanes above).
  const swarms = [
    { tier: 0, near: 6.4, far: 8.2, small: 0.7, large: 1.4, depthNear: -4, depthFar: 3, speed: 0.003, sectors: 20, accent: 0.2, density: 0.85, lane: "band380" },
    { tier: 0, near: 6.8, far: 8.8, small: 0.6, large: 1.3, depthNear: -5, depthFar: 2, speed: 0.0035, sectors: 20, accent: 0.15, density: 0.85, lane: "band380" },
    { tier: 0, near: 7.2, far: 9.2, small: 0.8, large: 1.6, depthNear: -6, depthFar: 1, speed: 0.0025, sectors: 20, accent: 0.2, density: 0.8, lane: "band1300" },
    { tier: 1, near: 10, far: 14, small: 2.2, large: 3.8, depthNear: -20, depthFar: -3, speed: 0.0015, sectors: 12, accent: 0.15, density: 0.6, lane: "band1300" },
    { tier: 1, near: 10.5, far: 14.5, small: 2.0, large: 3.6, depthNear: -14, depthFar: 1, speed: 0.0015, sectors: 12, accent: 0.12, density: 0.55, lane: "band3400" },
    { tier: 2, near: 14, far: 18, small: 4.5, large: 7.0, depthNear: 1, depthFar: 9, speed: 0.001, sectors: 6, accent: 0.15, density: 0.35, lane: "band3400" },
  ] as const;
  swarms.forEach((swarm, index) => {
    const { lane: _lane, ...tierParameters } = swarm;
    const id = `swarm${String(index)}`, grid = `${id}Grid`, form = `${id}Form`, mesh = `${id}Mesh`, glow = `${id}Glow`;
    const y = 100 + index * 250;
    nodes.push(
      node(grid, "pointGrid", [-2200, y], { cols: SWARM_COLUMNS, rows: SWARM_ROWS * SWARM_BODIES, count: SWARM_CAPACITY, sizeX: 2, sizeY: 2 }, { label: `${id}grid1` }),
      node(form, "pointKernel", [-1900, y], { capacity: SWARM_CAPACITY, attributes: SWARM_ATTRIBUTES, kernel: SWARM_KERNEL, slot: index, bodies: SWARM_BODIES, ...tierParameters, drift: expressionSlot(LANES[swarm.lane], 0.3), burst: expressionSlot(BEAT, 0.1) }, { label: `${id}form1` }),
      node(mesh, "geometry", [-1600, y], { mode: "surface", material: "hullpaint1", tint: mappedTint }, { label: `${id}mesh1` }),
      node(glow, "geometry", [-1300, y], { mode: "beam", endpoint: "end", material: "seamglow1", tint: mappedEmission, scale: 0.045, soft: 0.6, blend: "additive", group: "p.seam > 0.5" }, { label: `${id}glow1` }),
    );
    edges.push(edge(`${id}-grid`, [grid, "out"], [form, "in"]), edge(`${id}-mesh`, [form, "out"], [mesh, "points"]), edge(`${id}-glow`, [form, "out"], [glow, "points"]));
    scenes.push(`${id}mesh1`, `${id}glow1`);
  });
  {
    // Dust: four hundred motes drifting outward beside the ring, tiny and slow — not blocks.
    const y = 100 + swarms.length * 250;
    nodes.push(
      node("dustGrid", "pointGrid", [-2200, y], { cols: SHARD_COLUMNS, rows: SHARD_ROWS * SHARD_COUNT, count: SHARD_CAPACITY, sizeX: 2, sizeY: 2 }, { label: "dustgrid1" }),
      node("dustForm", "pointKernel", [-1900, y], { capacity: SHARD_CAPACITY, attributes: INSTALLATION_ATTRIBUTES, kernel: SHARD_KERNEL, slot: 0, rate: 0.03, inner: 9, outer: 24, size: 0.05, burst: expressionSlot(BEAT, 0.1), highs: expressionSlot(HIGHS, 0) }, { label: "dustform1" }),
      node("dustMesh", "geometry", [-1600, y], { mode: "surface", material: "hullpaint1", tint: mappedTint }, { label: "dustmesh1" }),
    );
    edges.push(edge("dust-grid", ["dustGrid", "out"], ["dustForm", "in"]), edge("dust-mesh", ["dustForm", "out"], ["dustMesh", "points"]));
    scenes.push("dustmesh1");
  }
  const shot = nodes.find((entry) => entry.id === "shot")!;
  shot.parameters["scenes"] = scenes.join(" ");
  return document("crucible", "E79 Crucible", settings({ randomSeed: 79, outputResolution: { width: 1280, height: 720 } }), graph(nodes, edges));
}

export const crucibleDocument = crucibleDocumentBuild();
