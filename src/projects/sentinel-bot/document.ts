import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../../examples/build-showcase-beat.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import type { KitFacts, Vec3 } from "./kit.ts";
import { PATH, pathExpression } from "./path.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../furnace/post.ts";
import { BODY_ATTRIBUTES, BODY_KERNEL, JOINT_ATTRIBUTES, jointCount, jointKernel } from "./rig.ts";
import { HULL_SURFACE_WGSL } from "./surface.ts";
import { BORE_ATTRIBUTES, BORE_COLUMNS, BORE_KERNEL, BORE_ROWS, BORE_SURFACE_WGSL, HAZE_WGSL, LAMP_SPACING } from "./tunnel.ts";

/**
 * T1561b — THE SENTINEL DOCUMENT: a robot walking, swimming and perching in the tunnel, played
 * from a panel and listening to a track.
 *
 * The data flows the way the finished piece keeps it. One number on the value graph says how
 * far the robot has come; the body and every joint are placed from it on the GPU; the camera
 * reads the same path on the CPU. The PANEL holds the piece's own words — Speed, Crawl, Swim,
 * Perch — and every one of them reaches a parameter as an ordinary expression, where the
 * track's lanes are mixed in.
 *
 * The tunnel is a lit surface inside the Render (tunnel.ts), with a lamp plate in its crown
 * every 12.8 m; the three lamps nearest the robot are real lights and fade in and out with
 * distance, so the set can change without a pop. Air and bloom follow.
 *
 * What is NOT here yet: the joints are drawn as boxes until a mesh can be instanced (§T1581b),
 * and three lamps are all a forward Render affords (§T1589b).
 */

export interface SentinelDocumentOptions {
  readonly width?: number;
  readonly height?: number;
  /** Each robot's place off the pack's own: right, up, ahead (metres). Default: one robot, on the axis. */
  readonly robots?: readonly Vec3[];
}

/** Parameters may be slots (expressions, maps); the shared builder's signature takes values only. */
function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const map = (attribute: string, fallback: number | number[], channel?: string): StoredParameter => ({
  mode: "map",
  bindings: { static: { kind: "static", value: fallback }, map: { kind: "map", attribute, ...(channel === undefined ? {} : { channel }) } },
}) as StoredParameter;

interface Slider {
  readonly name: string;
  readonly caption: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
}

/** The panel's sliders. A slider is named after its channel, so `op('speed').chan.speed` reads the same word twice. */
const ROBOT: readonly Slider[] = [
  { name: "speed", caption: "Speed", value: 3.2, min: 0, max: 9 },
  { name: "crawl", caption: "Crawl", value: 1, min: 0, max: 1 },
  { name: "swim", caption: "Swim", value: 0, min: 0, max: 1 },
  { name: "stride", caption: "Stride", value: 3.2, min: 1.6, max: 4.4 },
  { name: "flare", caption: "Flare", value: 0.25, min: 0, max: 1 },
  { name: "wave", caption: "Wave", value: 0.05, min: 0, max: 0.3 },
  { name: "grip", caption: "Grip", value: 1, min: 0, max: 1 },
];
const SCENE: readonly Slider[] = [
  { name: "bore", caption: "Tunnel", value: 2.6, min: 2.2, max: 3.4 },
  { name: "lamp", caption: "Lamp", value: 26, min: 0, max: 80 },
  { name: "glow", caption: "Eyes", value: 9, min: 0, max: 30 },
  { name: "distance", caption: "Camera distance", value: 7.5, min: -9, max: 12 },
  { name: "react", caption: "Listen", value: 1, min: 0, max: 2 },
  { name: "slider_haze", caption: "Haze", value: 0.035, min: 0, max: 0.12 },
];

/** A control's value. A widget publishes a channel named for its role: `speed`, or `haze` for `slider_haze` (§T1593b names nodes kind_role). */
const on = (name: string): string => `op('${name}').chan.${name.slice(name.indexOf("_") + 1)}`;
const LISTEN = on("react");
const LOW = `(op('levels1').chan.low * ${LISTEN})`;
const HIGH = `(op('levels1').chan.high * ${LISTEN})`;
const KICK = `(op('hits1').chan.kickCount * ${LISTEN})`;
const HAT = `(op('hits1').chan.hatCount * ${LISTEN})`;
const TRAVEL = "op('travel1').chan.value";
const STROKE = "op('stroke1').chan.value";
const SWIM = on("swim");

export function sentinelDocument(facts: KitFacts, options: SentinelDocumentOptions = {}): ProjectDocument {
  const travel = expressionSlot(TRAVEL, 0);
  const robots = options.robots ?? [[0, 0, 0]];
  /** A point of the tunnel's centreline `ahead` metres from the robot, moved by (dx, dy): three expressions, and what a host with no value graph shows. */
  const onPath = (ahead: string, dx: string, dy: string, retained: readonly [number, number, number]): Record<"x" | "y" | "z", StoredParameter> => {
    const z = `(${TRAVEL} + ${ahead})`;
    const at = pathExpression(z);
    return { x: expressionSlot(`${at.x} + ${dx}`, retained[0]), y: expressionSlot(`${at.y} + ${dy}`, retained[1]), z: expressionSlot(z, retained[2]) };
  };
  const eye = onPath(`(0 - ${on("distance")})`, "op('view').chan.viewX", "op('view').chan.viewY", [1.1, 0.6, -7.5]);
  const aim = onPath("0.6", "0", "0", [0, 0, 0.6]);
  const glow = onPath("0.9", "0", "0", [0, 0, 0.9]);
  /** The lamp station `step` stations from the one the robot is under: where it hangs, and how much of it is lit (1 within half a spacing, 0 a spacing and a half away, so the three in use trade places unseen). */
  const lampAt = (step: number): { position: Record<"x" | "y" | "z", StoredParameter>; near: string } => {
    const z = `((floor(${TRAVEL} / ${LAMP_SPACING}) + ${step + 0.5}) * ${LAMP_SPACING})`;
    const at = pathExpression(z);
    const rest = (step + 0.5) * LAMP_SPACING;
    return {
      position: { x: expressionSlot(at.x, 0), y: expressionSlot(`${at.y} + ${on("bore")} - 0.35`, 2.25), z: expressionSlot(z, rest) },
      near: `clamp(1.5 - abs(${z} - ${TRAVEL}) / ${LAMP_SPACING}, 0, 1)`,
    };
  };
  const lamps = [-1, 0, 1].map(lampAt);
  const boxes = (id: string, kind: number, scale: number, position: readonly [number, number]): GraphNode =>
    node(id, "geometry", position, {
      mode: "instances",
      shape: "box",
      material: "steel1",
      scale: map("tint", scale, "w"),
      orient: map("orient", [0, 0, 0, 1]),
      tint: map("tint", [1, 1, 1, 1]),
      group: `p.kind > ${(kind - 0.5).toFixed(1)} && p.kind < ${(kind + 0.5).toFixed(1)}`,
    }, { label: `${id.toLowerCase()}1` });

  const sliders = [...ROBOT, ...SCENE];
  const controls: GraphNode[] = [
    ...sliders.map((slider, index) => node(slider.name, "slider", [-3600 + (index % 4) * 300, 1500 + Math.floor(index / 4) * 250], { channel: slider.name.slice(slider.name.indexOf("_") + 1), caption: slider.caption, value: slider.value, min: slider.min, max: slider.max, step: 0 }, { label: slider.name })),
    node("perch", "toggle", [-3600, 2250], { channel: "perch", caption: "Perch", on: false }, { label: "perch" }),
    node("view", "xyPad", [-3300, 2250], { channel: "view", caption: "Camera side / height", x: 1.1, y: 0.6, min: -2, max: 2 }, { label: "view" }),
  ];
  const board = serializePanelBoard({
    columns: 12,
    items: [
      { label: "Robot", rect: { x: 0, y: 0, w: 6, h: 1 } },
      ...ROBOT.map((slider, index) => ({ member: slider.name, rect: { x: 0, y: 1 + index, w: 6, h: 1 } })),
      { member: "perch", rect: { x: 0, y: 1 + ROBOT.length, w: 6, h: 1 } },
      { label: "Scene", rect: { x: 6, y: 0, w: 6, h: 1 } },
      ...SCENE.map((slider, index) => ({ member: slider.name, rect: { x: 6, y: 1 + index, w: 6, h: 1 } })),
      { member: "view", rect: { x: 6, y: 1 + SCENE.length, w: 3, h: 3 } },
    ],
  });

  const nodes: GraphNode[] = [
    // ── The track, and the lanes the piece listens to ──
    node("clip", "audioFileIn", [-3600, 600], {
      file: SHOWCASE_BEAT_FILE, playMode: "timeline", play: true, speed: 1, cue: false, cuePoint: 0,
      trimStart: 0, trimEnd: 0, extend: "loop", volume: 1, monitor: true,
      tempoMode: "declared", bpm: SHOWCASE_BEAT.bpm, beatsPerBar: SHOWCASE_BEAT.beatsPerBar,
      beatOffset: Math.round(SHOWCASE_BEAT_OFFSET_SECONDS * 1000) / 1000,
    }, { label: "clip1" }),
    node("pickLevels", "valueSelect", [-3300, 500], { channels: "level low high" }, { label: "picklevels1" }),
    node("smooth", "valueLag", [-3000, 500], { lag: 0.02, releaseRatio: 4 }, { label: "smooth1" }),
    node("rank", "valueNormalize", [-2700, 500], { window: 16 }, { label: "rank1" }),
    // Fast attack, slow release: a level that rises late reads as the picture lagging the music.
    node("levels", "valueLag", [-2400, 500], { lag: 0.03, releaseRatio: 5 }, { label: "levels1" }),
    node("pickHits", "valueSelect", [-3300, 750], { channels: "kickCount snareCount hatCount" }, { label: "pickhits1" }),
    node("hits", "valueLag", [-3000, 750], { lag: 0.001, releaseRatio: 250 }, { label: "hits1" }),

    // ── How far it has come: a rate, eased, integrated, wrapping where the path does ──
    // Perch stops it; a kick shoves it; swimming surges on the snap of each beat and glides between.
    node("rate", "constant", [-2400, 1000], {
      value: expressionSlot(`${on("speed")} * (1 - ${on("perch")}) * (1 + ${KICK} * 0.6) * (1 + ${SWIM} * (sin(clamp(${STROKE} / 0.25, 0, 1) * 3.14159265) * 1.4 - 0.3))`, 3.2),
    }, { label: "rate1" }),
    node("ease", "valueLag", [-2100, 1000], { lag: 0.25, releaseRatio: 1.6 }, { label: "ease1" }),
    node("travel", "valueSpeed", [-1800, 1000], { minimum: 0, maximum: PATH.period, limit: "loop" }, { label: "travel1" }),
    // The swimming beat: one stroke per bar of the track.
    node("strokeRate", "constant", [-2400, 1250], { value: SHOWCASE_BEAT.bpm / 60 / SHOWCASE_BEAT.beatsPerBar }, { label: "strokerate1" }),
    node("stroke", "valueSpeed", [-2100, 1250], { minimum: 0, maximum: 1, limit: "loop" }, { label: "stroke1" }),

    // ── The body ──
    node("robot", "meshFileIn", [-2400, 0], { file: facts.glbUrl, select: facts.robot.select, vertices: facts.robot.vertices, triangles: facts.robot.triangles, parts: facts.robot.parts }, { label: "robot1" }),
    // One kernel and one draw per robot until the body is an object with a transform (T1588b).
    ...robots.flatMap((offset, index) => [
      node(`body${index}`, "pointKernel", [-2100, -index * 150], { capacity: facts.robot.vertices, attributes: BODY_ATTRIBUTES, kernel: BODY_KERNEL, travel, offset: [offset[0], offset[1], offset[2]] }, { label: `body${index}_1` }),
      node(`bodyGeo${index}`, "geometry", [-1800, -index * 150], { mode: "surface", material: "hull1" }, { label: `bodygeo${index}_1` }),
    ]),
    node("hull", "materialWgsl", [-1800, 150], {
      model: "pbr",
      source: HULL_SURFACE_WGSL,
      // The eyes flicker with the hats and swell with the top of the track.
      eyeGlow: expressionSlot(`${on("glow")} * (0.75 + ${HIGH} * 0.6 + ${HAT} * 0.9)`, 9),
    }, { label: "hull1" }),

    // ── The joints: one point each, drawn as boxes until a mesh can be instanced (T1581b) ──
    node("joints", "pointKernel", [-2100, 300], {
      capacity: jointCount(facts) * robots.length,
      attributes: JOINT_ATTRIBUTES,
      kernel: jointKernel(facts, robots),
      travel,
      crawl: expressionSlot(on("crawl"), 1),
      swim: expressionSlot(SWIM, 0),
      stroke: expressionSlot(STROKE, 0),
      stride: expressionSlot(on("stride"), 3.2),
      flare: expressionSlot(on("flare"), 0.25),
      // The low end runs down the tentacles.
      wave: expressionSlot(`${on("wave")} + ${LOW} * 0.08`, 0.05),
      grip: expressionSlot(on("grip"), 1),
      bore: expressionSlot(on("bore"), 2.6),
    }, { label: "joints1" }),
    node("steel", "materialPbr", [-1800, 900], { color: [0.5, 0.52, 0.56, 1], metallic: 0.9, roughness: 0.3 }, { label: "steel1" }),
    boxes("rings", 0, 0.085, [-1800, 300]),
    boxes("hubs", 1, 0.085, [-1800, 450]),
    boxes("claws", 2, 0.085, [-1800, 600]),

    // ── The tunnel: one grid bent into the bore, a window of it riding with the robot ──
    node("grid_bore", "pointGrid", [-2400, 1200], { cols: BORE_COLUMNS, rows: BORE_ROWS, count: BORE_COLUMNS * BORE_ROWS, sizeX: 2, sizeY: 2 }, { label: "grid_bore" }),
    node("kernel_bore", "pointKernel", [-2100, 1200], { capacity: BORE_COLUMNS * BORE_ROWS, attributes: BORE_ATTRIBUTES, kernel: BORE_KERNEL, travel, bore: expressionSlot(on("bore"), 2.6) }, { label: "kernel_bore" }),
    node("material_bore", "materialWgsl", [-2100, 1400], { model: "pbr", source: BORE_SURFACE_WGSL, lamp: expressionSlot(`${on("lamp")} * 0.55 * (0.7 + ${LOW} * 0.8)`, 14) }, { label: "material_bore" }),
    node("geometry_bore", "geometry", [-1800, 1200], { mode: "surface", material: "material_bore", tint: map("tint", [0, 0, 0, 0]) }, { label: "geometry_bore" }),

    // ── Camera and light ──
    node("cam", "camera", [-1500, -600], { eye: [1.1, 0.6, -7.5], lookAt: [0, 0, 0.6], "eye.x": eye.x, "eye.y": eye.y, "eye.z": eye.z, "lookAt.x": aim.x, "lookAt.y": aim.y, "lookAt.z": aim.z, fov: 55, near: 0.05, far: 240 }, { label: "cam1" }),
    // The eyes throw the tentacles' shadows down the walls.
    node("eyes", "light", [-1500, -300], { kind: "point", color: [1, 0.12, 0.06, 1], intensity: expressionSlot(`${on("glow")} * 0.18 * (0.75 + ${HAT} * 0.9)`, 1.6), position: [0, 0, 0.9], "position.x": glow.x, "position.y": glow.y, "position.z": glow.z, falloff: "inverseSquare", range: 14, shadows: true, shadowExtent: 14, shadowSoftness: 1 }, { label: "eyes1" }),
    // The three lamp plates nearest the robot, as lights; they breathe with the low end.
    ...lamps.map((lamp, index) =>
      node(`light_lamp${index}`, "light", [-1500, -150 + index * 150], {
        kind: "point",
        color: [0.62, 0.84, 1, 1],
        intensity: expressionSlot(`${on("lamp")} * ${lamp.near} * (0.7 + ${LOW} * 0.8)`, index === 1 ? 26 : 0),
        position: [0, 2.25, (index - 0.5) * LAMP_SPACING],
        "position.x": lamp.position.x,
        "position.y": lamp.position.y,
        "position.z": lamp.position.z,
        falloff: "inverseSquare",
        range: 30,
        // Only the lamp overhead casts: a cube shadow is six more passes of the whole scene.
        ...(index === 1 ? { shadows: true, shadowExtent: 30, shadowSoftness: 1 } : {}),
      }, { label: `light_lamp${index}` }),
    ),
    node("shot", "render", [-1200, 0], {
      scenes: [...robots.map((_, index) => `bodygeo${index}_1`), "rings1", "hubs1", "claws1", "geometry_bore"].join(" "),
      camera: "cam1",
      lights: ["eyes1", ...lamps.map((_, index) => `light_lamp${index}`)].join(" "),
      ambientColor: [0.5, 0.62, 0.8, 1],
      ambientIntensity: 0.015,
      background: [0, 0, 0, 1],
      antialias: "msaa",
      depthOutput: true,
    }, { label: "shot1" }),
    // ── Air, then bloom: a bright pass and a four-level pyramid (the furnace's, until a stock one exists, T1402b) ──
    node("wgsl_haze", "customWgslMulti", [-900, 0], { source: HAZE_WGSL, density: expressionSlot(on("slider_haze"), 0.035), far: 240 }, { label: "wgsl_haze", resolution: { mode: "project" } }),
    node("wgsl_bright", "customWgsl", [-600, 300], { source: BRIGHT_PASS_WGSL, threshold: 1.4, knee: 1 }, { label: "wgsl_bright", resolution: { mode: "scale", factor: 0.5 } }),
    ...[1, 2, 3, 4].map((level) => node(`wgsl_bloomdown${level}`, "customWgsl", [-300, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, { label: `wgsl_bloomdown${level}`, resolution: { mode: "scale", factor: 0.5 } })),
    ...[0, 1, 2, 3].map((level) => node(`wgsl_bloomup${level}`, "customWgslMulti", [0, 150 + level * 150], { source: BLOOM_UP_WGSL, lower: 1 }, { label: `wgsl_bloomup${level}`, resolution: { mode: "scale", factor: 2 } })),
    node("add_glow", "add", [300, 0], { opacity: 0.4 }, { label: "add_glow", resolution: { mode: "project" } }),
    node("out", "output", [600, 0], { toneMap: "filmic" }, { label: "out1" }),

    // ── The panel: the piece's own words ──
    ...controls,
    node("panel", "panel", [-2400, 2250], { title: "Sentinel", board }, { label: "panel1" }),
  ];

  const edges: GraphEdge[] = [
    edge("clip-levels", ["clip", "out"], ["pickLevels", "in"]),
    edge("levels-smooth", ["pickLevels", "out"], ["smooth", "in"]),
    edge("smooth-rank", ["smooth", "out"], ["rank", "in"]),
    edge("rank-levels", ["rank", "out"], ["levels", "in"]),
    edge("clip-hits", ["clip", "out"], ["pickHits", "in"]),
    edge("hits-lag", ["pickHits", "out"], ["hits", "in"]),
    edge("rate-ease", ["rate", "out"], ["ease", "in"]),
    edge("ease-travel", ["ease", "out"], ["travel", "in"]),
    edge("stroke-rate", ["strokeRate", "out"], ["stroke", "in"]),
    ...robots.flatMap((_, index) => [
      edge(`robot-body${index}`, ["robot", "out"], [`body${index}`, "in"]),
      edge(`body-geo${index}`, [`body${index}`, "out"], [`bodyGeo${index}`, "points"]),
    ]),
    edge("joints-rings", ["joints", "out"], ["rings", "points"]),
    edge("joints-hubs", ["joints", "out"], ["hubs", "points"]),
    edge("joints-claws", ["joints", "out"], ["claws", "points"]),
    edge("grid-bore", ["grid_bore", "out"], ["kernel_bore", "in"]),
    edge("bore-geo", ["kernel_bore", "out"], ["geometry_bore", "points"]),
    edge("shot-haze", ["shot", "out"], ["wgsl_haze", "input"]),
    edge("depth-haze", ["shot", "depth"], ["wgsl_haze", "more"], 0),
    edge("haze-bright", ["wgsl_haze", "out"], ["wgsl_bright", "input"]),
    ...[1, 2, 3, 4].map((level) => edge(`bloom-down${level}`, [level === 1 ? "wgsl_bright" : `wgsl_bloomdown${level - 1}`, "out"], [`wgsl_bloomdown${level}`, "input"])),
    ...[0, 1, 2, 3].flatMap((level) => [
      edge(`bloom-up${level}-lower`, [level === 3 ? "wgsl_bloomdown4" : `wgsl_bloomup${level + 1}`, "out"], [`wgsl_bloomup${level}`, "input"]),
      edge(`bloom-up${level}-own`, [level === 0 ? "wgsl_bright" : `wgsl_bloomdown${level}`, "out"], [`wgsl_bloomup${level}`, "more"], 0),
    ]),
    // The bloom is the FRONT layer: Add's opacity scales in1.
    edge("glow-front", ["wgsl_bloomup0", "out"], ["add_glow", "in1"]),
    edge("glow-back", ["wgsl_haze", "out"], ["add_glow", "in2"]),
    edge("glow-out", ["add_glow", "out"], ["out", "input"]),
    ...controls.map((control, index) => edge(`panel-${control.id}`, [control.id, "out"], ["panel", "controls"], index)),
  ];

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-sentinel-bot",
    name: "Sentinel Bot",
    graph: graph(nodes, edges),
    settings: settings({ outputResolution: { width: options.width ?? 1280, height: options.height ?? 720 }, randomSeed: 23 }),
    assets: [],
    createdAt: "2026-10-05T00:00:00.000Z",
    updatedAt: "2026-10-05T00:00:00.000Z",
  };
}
