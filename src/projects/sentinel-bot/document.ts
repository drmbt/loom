import type { GraphEdge, GraphNode, ProjectDocument } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { edge, expressionSlot, graph, node as buildNode, settings } from "../../examples/documents/builders.ts";
import { SHOWCASE_BEAT, SHOWCASE_BEAT_FILE, SHOWCASE_BEAT_OFFSET_SECONDS } from "../../examples/build-showcase-beat.ts";
import { serializePanelBoard } from "../../nodes/definitions/controls.ts";
import { CAMERA_DEFAULTS, CAMERA_STATEMENTS, SHOTS } from "./camera.ts";
import type { KitFacts, MeshSelectionFacts, Vec3 } from "./kit.ts";
import { PATH, pathExpression } from "./path.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../furnace/post.ts";
import { SSR_WGSL } from "../furnace/screen-space.ts";
import { JOINT_ATTRIBUTES, jointCount, jointKernel, type Pick } from "./rig.ts";
import { HULL_SURFACE_WGSL } from "./surface.ts";
import { BORE_ATTRIBUTES, BORE_COLUMNS, BORE_KERNEL, BORE_ROWS, BORE_SURFACE_WGSL, HAZE_WGSL, LAMP_SPACING, lampToneExpression } from "./tunnel.ts";

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
 * The robot is the kit's meshes instanced on the rig's points (§T1581b): a ring at every ring
 * joint, a hub and eight phalanges at every claw, the hull at each robot's own point.
 *
 * What is NOT here yet: three lamps are all a forward Render affords (§T1589b).
 */

export interface SentinelDocumentOptions {
  readonly width?: number;
  readonly height?: number;
  /** Each robot's place off the pack's own: right, up, ahead (metres). Default: the leader alone. The camera follows the first. */
  readonly robots?: readonly Vec3[];
  /**
   * What the frame may cost. `live` (the default) is what holds 60 frames a second in the app
   * and is what build.ts writes; `offline` spends what a render that is not watched live can.
   *
   * Measured in the app at 1280×720 with the kit's meshes instanced (one robot, documents
   * back to back, the control repeated):
   *   everything (two-phalanx fingers, the eyes' shadow, reflections)   41 to 44 fps
   *   no shadow-casting light                                           54 to 57 fps
   *   no shadow, and the claw one rigid piece instead of nine           60 fps   <- live
   *   no shadow, no reflections                                         60 fps
   *   the eyes' shadow kept, no reflections                             37 to 43 fps
   * A point light's shadow is six more sweeps of every piece, and each piece is a draw of its
   * own in each sweep; per-light caster lists and culled instances (§T1598b, §T1592b) are
   * what bring the shadow and the articulated claw back to the live tier.
   */
  readonly tier?: "live" | "offline";
  /** The two things a tier decides, each on its own, for measuring one without the other. Unset, the tier decides. */
  readonly shadows?: boolean;
  readonly hingedClaws?: boolean;
}

/**
 * A leader on the axis and two behind it, staggered: far enough apart that no two can reach
 * the same rung. The document's default is the leader alone, because that is what holds 60
 * frames a second today: measured in the app at 1280×720 with two shadow-casting lights, one
 * robot ran 55 to 59 fps and three 50 to 52. Each robot is a 152,490-vertex kernel and a
 * 213k-triangle hull drawn again in every cube-shadow sweep; an instanced hull with culling
 * (§T1581b, §T1592b) is what makes a pack cheap.
 */
export const PACK: readonly Vec3[] = [
  [0, 0, 0],
  [0.7, 0.35, -8.4],
  [-0.6, -0.25, -15.6],
];

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
  { name: "slider_gesture", caption: "Gesture", value: 0.6, min: 0, max: 1 },
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
  const robots = options.robots ?? PACK.slice(0, 1);
  const offline = options.tier === "offline";
  const shadows = options.shadows ?? offline;
  const hingedClaws = options.hingedClaws ?? offline;
  // Perched, it eases to a stop (below) and its head scans the tunnel on two slow counts, so the sweep never repeats on the bar.
  const PERCHED = "op('lag_perched').chan.value";
  const look: Record<string, StoredParameter> = {
    look: [0, 0],
    "look.x": expressionSlot(`${PERCHED} * (0.55 * sin(abstime * 0.5) + 0.2 * sin(abstime * 1.3))`, 0),
    "look.y": expressionSlot(`${PERCHED} * 0.22 * sin(abstime * 0.37 + 1)`, 0),
  };
  /** A point of the tunnel's centreline `ahead` metres from the robot, moved by (dx, dy): three expressions, and what a host with no value graph shows. */
  const onPath = (ahead: string, dx: string, dy: string, retained: readonly [number, number, number]): Record<"x" | "y" | "z", StoredParameter> => {
    const z = `(${TRAVEL} + ${ahead})`;
    const at = pathExpression(z);
    return { x: expressionSlot(`${at.x} + ${dx}`, retained[0]), y: expressionSlot(`${at.y} + ${dy}`, retained[1]), z: expressionSlot(z, retained[2]) };
  };
  // Where the camera rides is the rig's (camera.ts); a hand never holds a camera dead still.
  const RIG = (channel: string): string => `op('expression_camera').chan.${channel}`;
  const eye = onPath(RIG("ahead"), `${RIG("right")} + 0.02 * sin(abstime * 2.3)`, `${RIG("up")} + 0.015 * sin(abstime * 1.7 + 1)`, [1.1, 0.6, -7.5]);
  // Chasing, it looks down the tunnel past the robot; every other shot looks at the robot.
  const aim = onPath(`(0.3 + 3 * (${RIG("pick")} == 0))`, "0", "0", [0, 0, 3.3]);
  const glow = onPath("0.9", "0", "0", [0, 0, 0.9]);
  /** The lamp station `step` stations from the one the robot is under: where it hangs, and how much of it is lit (1 within half a spacing, 0 a spacing and a half away, so the three in use trade places unseen). */
  const lampAt = (step: number): { position: Record<"x" | "y" | "z", StoredParameter>; near: string; tone: readonly [string, string, string] } => {
    const station = `(floor(${TRAVEL} / ${LAMP_SPACING}) + ${step})`;
    const z = `((floor(${TRAVEL} / ${LAMP_SPACING}) + ${step + 0.5}) * ${LAMP_SPACING})`;
    const at = pathExpression(z);
    const rest = (step + 0.5) * LAMP_SPACING;
    return {
      position: { x: expressionSlot(at.x, 0), y: expressionSlot(`${at.y} + ${on("bore")} - 0.35`, 2.25), z: expressionSlot(z, rest) },
      near: `clamp(1.5 - abs(${z} - ${TRAVEL}) / ${LAMP_SPACING}, 0, 1)`,
      // The light is the colour of the plate it hangs under (tunnel.ts, LAMP_TONES).
      tone: lampToneExpression(station),
    };
  };
  const lamps = [-1, 0, 1].map(lampAt);
  const swimming: Record<string, StoredParameter> = { swim: expressionSlot(SWIM, 0), stroke: expressionSlot(STROKE, 0) };
  /**
   * The robot's pieces: each a mesh from the kit, and the points of the rig it is drawn on.
   * The kit holds every piece at the origin in its own joint frame (the hull in the robot's),
   * so the file's world IS the shape's frame and Frame stays at World. Each piece has a
   * kernel of its own writing exactly its points (rig.ts, Pick); a Group predicate over one
   * shared pointset would hand every draw every point.
   */
  const pieces: ReadonlyArray<{ readonly role: string; readonly shape: MeshSelectionFacts; readonly pick: Pick }> = [
    { role: "hull", shape: facts.robot, pick: "body" },
    { role: "ring", shape: facts.ring, pick: { first: 0, count: facts.ringCount } },
    // The claw: live, one rigid piece on the wrist; offline, its cone and eight phalanges, each hinged (see `tier`).
    ...(hingedClaws
      ? [{ role: "hub", shape: facts.hub, pick: { first: facts.ringCount, count: 1 } }, ...facts.phalanxMeshes.map((shape, which) => ({ role: `phalanx${which}`, shape, pick: { first: facts.ringCount + 1 + which, count: 1 } }))]
      : [{ role: "claw", shape: facts.claw, pick: { first: facts.ringCount, count: 1 } }]),
  ];
  const pieceNodes = (rig: Record<string, StoredParameter>): GraphNode[] =>
    pieces.flatMap((piece, index) => [
      node(`mesh_${piece.role}`, "meshFileIn", [-2700, index * 150], { file: facts.glbUrl, select: piece.shape.select, vertices: piece.shape.vertices, triangles: piece.shape.triangles, parts: piece.shape.parts }, { label: `mesh_${piece.role}` }),
      node(`kernel_${piece.role}`, "pointKernel", [-2400, index * 150], { capacity: jointCount(facts, piece.pick) * robots.length, attributes: JOINT_ATTRIBUTES, kernel: jointKernel(facts, robots, piece.pick), ...rig }, { label: `kernel_${piece.role}` }),
      node(`geometry_${piece.role}`, "geometry", [-1800, index * 150], {
        mode: "instances",
        shape: "mesh",
        material: "hull1",
        orient: map("orient", [0, 0, 0, 1]),
        // A ring still stowed in the body is not drawn.
        group: "p.kind > -0.5",
      }, { label: `geometry_${piece.role}` }),
    ]);

  const sliders = [...ROBOT, ...SCENE];
  const controls: GraphNode[] = [
    ...sliders.map((slider, index) => node(slider.name, "slider", [-3600 + (index % 4) * 300, 1500 + Math.floor(index / 4) * 250], { channel: slider.name.slice(slider.name.indexOf("_") + 1), caption: slider.caption, value: slider.value, min: slider.min, max: slider.max, step: 0 }, { label: slider.name })),
    node("perch", "toggle", [-3600, 2250], { channel: "perch", caption: "Perch", on: false }, { label: "perch" }),
    node("view", "xyPad", [-3300, 2250], { channel: "view", caption: "Chase side / height", x: 1.1, y: 0.6, min: -2, max: 2 }, { label: "view" }),
    node("slider_shot", "slider", [-3000, 2250], { channel: "shot", caption: `Shot (${SHOTS.join(", ")})`, value: 0, min: 0, max: SHOTS.length - 1, step: 1 }, { label: "slider_shot" }),
    node("toggle_cuts", "toggle", [-2700, 2250], { channel: "cuts", caption: "Cut on the bars", on: true }, { label: "toggle_cuts" }),
  ];
  const board = serializePanelBoard({
    columns: 12,
    items: [
      { label: "Robot", rect: { x: 0, y: 0, w: 6, h: 1 } },
      ...ROBOT.map((slider, index) => ({ member: slider.name, rect: { x: 0, y: 1 + index, w: 6, h: 1 } })),
      { member: "perch", rect: { x: 0, y: 1 + ROBOT.length, w: 6, h: 1 } },
      { label: "Camera", rect: { x: 0, y: 2 + ROBOT.length, w: 6, h: 1 } },
      { member: "slider_shot", rect: { x: 0, y: 3 + ROBOT.length, w: 6, h: 1 } },
      { member: "toggle_cuts", rect: { x: 0, y: 4 + ROBOT.length, w: 6, h: 1 } },
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
    // Perch stops it; a kick shoves it. (The lunge of a swimming stroke is the rig's own, on the
    // GPU: the rate cannot read how far it has come without the value graph closing a loop,
    // and a loop there is dropped whole.)
    node("rate", "constant", [-2400, 1000], {
      value: expressionSlot(`${on("speed")} * (1 - ${on("perch")}) * (1 + ${KICK} * 0.6)`, 3.2),
    }, { label: "rate1" }),
    node("ease", "valueLag", [-2100, 1000], { lag: 0.25, releaseRatio: 1.6 }, { label: "ease1" }),
    // Perch, eased: how perched it is, 0 to 1, for the head and the tentacles it frees.
    node("constant_perch", "constant", [-2400, 1125], { value: expressionSlot(on("perch"), 0) }, { label: "constant_perch" }),
    node("lag_perched", "valueLag", [-2100, 1125], { lag: 0.6, releaseRatio: 1 }, { label: "lag_perched" }),
    node("travel", "valueSpeed", [-1800, 1000], { minimum: 0, maximum: PATH.period, limit: "loop" }, { label: "travel1" }),
    // The swimming beat: one stroke per bar of the track.
    node("strokeRate", "constant", [-2400, 1250], { value: SHOWCASE_BEAT.bpm / 60 / SHOWCASE_BEAT.beatsPerBar }, { label: "strokerate1" }),
    node("stroke", "valueSpeed", [-2100, 1250], { minimum: 0, maximum: 1, limit: "loop" }, { label: "stroke1" }),

    // ── The robot: for each piece a mesh of the kit, the rig's points of that piece, and the draw (T1581b) ──
    node("hull", "materialWgsl", [-1800, 150], {
      model: "pbr",
      source: HULL_SURFACE_WGSL,
      // The eyes flicker with the hats and swell with the top of the track.
      eyeGlow: expressionSlot(`${on("glow")} * (0.75 + ${HIGH} * 0.6 + ${HAT} * 0.9)`, 9),
    }, { label: "hull1" }),

    ...pieceNodes({
      travel,
      ...look,
      // Perched, the last three tentacles to take the wall let go of it and feel about.
      crawl: expressionSlot(`${on("crawl")} * (1 - 0.3 * ${PERCHED})`, 1),
      gesture: expressionSlot(`${on("slider_gesture")} * (0.5 + 0.5 * ${PERCHED}) * (0.7 + ${LOW} * 0.6)`, 0.3),
      // A hat clacks the idle claws.
      snap: expressionSlot(HAT, 0),
      ...swimming,
      stride: expressionSlot(on("stride"), 3.2),
      flare: expressionSlot(on("flare"), 0.25),
      // The low end runs down the tentacles.
      wave: expressionSlot(`${on("wave")} + ${LOW} * 0.08`, 0.05),
      grip: expressionSlot(on("grip"), 1),
      bore: expressionSlot(on("bore"), 2.6),
    }),

    // ── The tunnel: one grid bent into the bore, a window of it riding with the robot ──
    node("grid_bore", "pointGrid", [-2400, 1200], { cols: BORE_COLUMNS, rows: BORE_ROWS, count: BORE_COLUMNS * BORE_ROWS, sizeX: 2, sizeY: 2 }, { label: "grid_bore" }),
    node("kernel_bore", "pointKernel", [-2100, 1200], { capacity: BORE_COLUMNS * BORE_ROWS, attributes: BORE_ATTRIBUTES, kernel: BORE_KERNEL, travel, bore: expressionSlot(on("bore"), 2.6) }, { label: "kernel_bore" }),
    node("material_bore", "materialWgsl", [-2100, 1400], { model: "pbr", source: BORE_SURFACE_WGSL, lamp: expressionSlot(`${on("lamp")} * 0.55 * (0.7 + ${LOW} * 0.8)`, 14) }, { label: "material_bore" }),
    node("geometry_bore", "geometry", [-1800, 1200], { mode: "surface", material: "material_bore", tint: map("tint", [0, 0, 0, 0]) }, { label: "geometry_bore" }),

    // ── Camera and light ──
    node("expression_camera", "valueExpression", [-1800, -600], { expressions: CAMERA_STATEMENTS, defaults: CAMERA_DEFAULTS }, { label: "expression_camera" }),
    // A kick punches the lens in.
    node("cam", "camera", [-1500, -600], { eye: [1.1, 0.6, -7.5], lookAt: [0, 0, 3.3], "eye.x": eye.x, "eye.y": eye.y, "eye.z": eye.z, "lookAt.x": aim.x, "lookAt.y": aim.y, "lookAt.z": aim.z, fov: expressionSlot(`${RIG("lens")} - ${KICK} * 2.5`, 55), near: 0.05, far: 240 }, { label: "cam1" }),
    // Offline, the eyes throw the tentacles' shadows down the walls; live, no light casts (see `tier`).
    node("eyes", "light", [-1500, -300], { kind: "point", color: [1, 0.12, 0.06, 1], intensity: expressionSlot(`${on("glow")} * 0.18 * (0.75 + ${HAT} * 0.9)`, 1.6), position: [0, 0, 0.9], "position.x": glow.x, "position.y": glow.y, "position.z": glow.z, falloff: "inverseSquare", range: 14, ...(shadows ? { shadows: true, shadowExtent: 14, shadowSoftness: 1 } : {}) }, { label: "eyes1" }),
    // The three lamp plates nearest the robot, as lights; they breathe with the low end.
    ...lamps.map((lamp, index) =>
      node(`light_lamp${index}`, "light", [-1500, -150 + index * 150], {
        kind: "point",
        color: [0.62, 0.84, 1, 1],
        "color.r": expressionSlot(lamp.tone[0], 0.62),
        "color.g": expressionSlot(lamp.tone[1], 0.84),
        "color.b": expressionSlot(lamp.tone[2], 1),
        intensity: expressionSlot(`${on("lamp")} * ${lamp.near} * (0.7 + ${LOW} * 0.8)`, index === 1 ? 26 : 0),
        position: [0, 2.25, (index - 0.5) * LAMP_SPACING],
        "position.x": lamp.position.x,
        "position.y": lamp.position.y,
        "position.z": lamp.position.z,
        falloff: "inverseSquare",
        range: 30,
        // Offline, the lamp overhead casts too.
        ...(shadows && index === 1 ? { shadows: true, shadowExtent: 30, shadowSoftness: 1 } : {}),
      }, { label: `light_lamp${index}` }),
    ),
    node("shot", "render", [-1200, 0], {
      scenes: [...pieces.map((piece) => `geometry_${piece.role}`), "geometry_bore"].join(" "),
      camera: "cam1",
      lights: ["eyes1", ...lamps.map((_, index) => `light_lamp${index}`)].join(" "),
      ambientColor: [0.5, 0.62, 0.8, 1],
      ambientIntensity: 0.015,
      background: [0, 0, 0, 1],
      antialias: "msaa",
      depthOutput: true,
      normalOutput: true,
    }, { label: "shot1" }),
    // ── Reflections: the wet deck and the wet streaks mirror the eyes and the lamps (the furnace's
    // screen-space pass, until a stock one exists, T1372b). It reads the camera off the camera node. ──
    node("wgsl_reflect", "customWgslMulti", [-1050, 0], {
      source: SSR_WGSL,
      eye: [1.1, 0.6, -7.5],
      aim: [0, 0, 3.3],
      ...Object.fromEntries((["x", "y", "z"] as const).flatMap((axis) => [[`eye.${axis}`, expressionSlot(`op('cam1').par.eye.${axis}`, 0)], [`aim.${axis}`, expressionSlot(`op('cam1').par.lookAt.${axis}`, 0)]])),
      fov: expressionSlot("op('cam1').par.fov", 55),
      far: 240,
      roll: 0,
      // Only the wettest surfaces mirror, and not at full strength: the pass is jittered and
      // has no temporal filter here, so anything more reads as sparkle.
      strength: 0.6,
      maxDistance: 30,
      thickness: 0.5,
      roughnessCutoff: 0.26,
    }, { label: "wgsl_reflect", resolution: { mode: "project" } }),
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
    edge("perch-ease", ["constant_perch", "out"], ["lag_perched", "in"]),
    edge("stroke-rate", ["strokeRate", "out"], ["stroke", "in"]),
    // What the camera rig reads: how far the robot has come, the track's bars, and the panel.
    ...["travel", "clip", "slider_shot", "toggle_cuts", "distance", "view"].map((source, index) => edge(`camera-${source}`, [source, "out"], ["expression_camera", "in"], index)),
    ...pieces.flatMap((piece) => [
      edge(`${piece.role}-shape`, [`mesh_${piece.role}`, "out"], [`geometry_${piece.role}`, "mesh"]),
      edge(`${piece.role}-points`, [`kernel_${piece.role}`, "out"], [`geometry_${piece.role}`, "points"]),
    ]),
    edge("grid-bore", ["grid_bore", "out"], ["kernel_bore", "in"]),
    edge("bore-geo", ["kernel_bore", "out"], ["geometry_bore", "points"]),
    edge("shot-reflect", ["shot", "out"], ["wgsl_reflect", "input"]),
    edge("depth-reflect", ["shot", "depth"], ["wgsl_reflect", "more"], 0),
    edge("normal-reflect", ["shot", "normal"], ["wgsl_reflect", "more"], 1),
    edge("reflect-haze", ["wgsl_reflect", "out"], ["wgsl_haze", "input"]),
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
