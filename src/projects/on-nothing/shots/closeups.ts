import type { GraphEdge, GraphNode, ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { SCHEMA_VERSION } from "../../../domain/types/schemas.ts";
import { LIMITS, edge, expressionSlot, graph, node as buildNode, settings } from "../../../examples/documents/builders.ts";
import { BLOOM_DOWN_WGSL, BLOOM_UP_WGSL, BRIGHT_PASS_WGSL } from "../../furnace/post.ts";
import { GTAO_WGSL } from "../../furnace/screen-space.ts";
import { ENVIRONMENT_HDRI_WGSL, ENVIRONMENT_WGSL, HEADLIGHT_COOKIE_WGSL, hazeLights, hazeWgsl } from "../atmosphere.ts";
import { GLOSSY_SSR_WGSL } from "../reflections.ts";
import type { Area, OnNothingFacts } from "../scene-facts.ts";
import { markerOf } from "../scene-facts.ts";
import { SKIN_ATTRIBUTES, boneParam, skinKernel, yawFor } from "../skin-kernel.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { BLOOM_ADD_WGSL, DOF_FILL_WGSL, LENS_DOF_WGSL, STUDIO_ENV_WGSL } from "./closeups-fx.ts";
import { CLOSEUP_SURFACE_WGSL } from "./closeups-surface.ts";

/**
 * T1407b (closeups) — THE CLOSE-UPS: shots the assignment left unowned
 * (docs/on-nothing-shotlist-2026-09-27.md), each its own graph.
 *
 *  - `pendant` (the reference's 1:37, row 90): a macro of an iced script pendant on its Cuban
 *    chain, a paper-thin plane of focus racking across the letters, every stone a glint and every
 *    glint out of focus a disc; the dark tee behind it and a grey-teal wall beyond.
 *  - `sneaker` (1:42, row 95): a white leather low-top on a black bonnet, the lens a hand above the
 *    paint on a 20 mm, across the bonnet at a white car's lit front three-quarter, the figure in
 *    the dark between them and the headlight smeared up into a column.
 *
 * The chain is the scene's (render → [reflections] → occlusion → [haze] → the LENS'S depth of
 * field → streak → bloom → lens → grade → [CRT]) with the stock Streak, Lens and Film Grade
 * nodes (T1402b), and three things of its own: the close-up surface (closeups-surface.ts), a
 * depth of field from the thin-lens equation (closeups-fx.ts), and a handheld camera whose
 * horizon rolls — the streak glass is on the lens, so the columns roll with the frame, not
 * with the world. Each shot's streaks move ONE way through the cut (they grow, or they
 * retract), never back and forth.
 */

export const CLOSEUP_SHOTS = ["pendant", "sneaker"] as const;
export type CloseupShot = (typeof CLOSEUP_SHOTS)[number];

export function isCloseup(shot: string): shot is CloseupShot {
  return (CLOSEUP_SHOTS as readonly string[]).includes(shot);
}

export interface CloseupOptions {
  readonly shot: CloseupShot;
  readonly width?: number;
  readonly height?: number;
  readonly crt?: boolean;
  /** Reflections from a real HDRI (render.ts --hdri; a Movie File In `hdri`, fed RGBM, as the scene's). */
  readonly hdri?: boolean;
}

type Vec3 = readonly [number, number, number];

function node(id: string, type: string, position: readonly [number, number], parameters: Record<string, StoredParameter>, extra: Partial<GraphNode> = {}): GraphNode {
  return buildNode(id, type, position, {}, { ...extra, parameters });
}

const vec = (v: Vec3): number[] => [v[0], v[1], v[2]];
const add = (a: Vec3, b: Vec3, k = 1): [number, number, number] => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const num = (value: number): string => value.toFixed(5);

function vec3Extra(extras: Readonly<Record<string, unknown>> | undefined, key: string, what: string): [number, number, number] {
  const value = extras?.[key];
  if (!Array.isArray(value) || value.length !== 3 || !value.every((entry) => typeof entry === "number")) {
    throw new Error(`closeups: ${what} carries no "${key}" (rebuild the GLB with tools/blender/on-nothing/closeups.py).`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/**
 * A HANDHELD operator: the eye and the aim each wander on three incommensurate sines per axis
 * (it never loops visibly), the horizon rolls a little and drifts, and the whole rig moves by
 * `drift` metres a second. `size` is the wander in metres (a few millimetres on a macro, a few
 * centimetres on a 20 mm), `roll` its horizon in degrees.
 */
function handheld(eye: Vec3, aim: Vec3, drift: Vec3, size: number, roll: { readonly wander: number; readonly lean: number; readonly start: number }): Record<string, StoredParameter> {
  const wob = (a: number, b: number, c: number, phase: number): string =>
    `(sin(abstime * ${a} + ${phase}) * 0.5 + sin(abstime * ${b} + ${(phase * 1.7).toFixed(3)}) * 0.3 + sin(abstime * ${c} + ${(phase * 2.3).toFixed(3)}) * 0.2)`;
  const axis = (base: number, d: number, k: number, phase: number, freq: readonly [number, number, number]): StoredParameter =>
    expressionSlot(`${num(base)} + abstime * ${num(d)} + ${wob(freq[0], freq[1], freq[2], phase)} * ${num(size * k)}`, base);
  return {
    "eye.x": axis(eye[0], drift[0], 1, 0.3, [0.9, 2.3, 5.1]),
    "eye.y": axis(eye[1], drift[1], 0.7, 1.1, [1.3, 3.1, 6.7]),
    "eye.z": axis(eye[2], drift[2], 0.6, 2.2, [0.7, 1.7, 4.3]),
    "lookAt.x": axis(aim[0], drift[0], 1.4, 2.0, [0.7, 1.9, 4.3]),
    "lookAt.y": axis(aim[1], drift[1], 1.2, 2.7, [0.8, 2.1, 4.9]),
    "lookAt.z": axis(aim[2], drift[2], 0.8, 0.4, [0.6, 1.5, 3.7]),
    roll: expressionSlot(`${num(roll.start)} + abstime * ${num(roll.lean)} + ${wob(0.5, 1.4, 3.3, 0.9)} * ${num(roll.wander)}`, roll.start),
  };
}

interface Look {
  /** Lens: focal length (mm), f-number, focus (metres, may be an expression), largest disc. */
  readonly lens: { readonly focal: number; readonly fstop: number; readonly focus: string; readonly focusAt: number; readonly maxCoc: number };
  /** Streak: length at the cut's start and end (fraction of the frame height), and its source threshold. */
  readonly streak: { readonly from: number; readonly to: number; readonly threshold: number; readonly gain: number; readonly spread: number; readonly falloff: number; readonly striation: number };
  readonly bloom: number;
  readonly grade: Record<string, StoredParameter>;
  readonly lensFx: Record<string, StoredParameter>;
}

/** The shot's length the streaks ramp over, seconds: the cut's duration in the edit. */
const CUT = 2.5;

export function closeupDocument(facts: OnNothingFacts, options: CloseupOptions): ProjectDocument {
  const shot = options.shot;
  const camera = facts.cameras.get(`shot.${shot}`);
  if (camera === undefined) throw new Error(`closeupDocument: the GLB has no camera "shot.${shot}" (rebuild it with closeups.py).`);
  const width = options.width ?? 1920;
  const height = options.height ?? 818;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const scenes: string[] = [];
  const lights: string[] = [];
  const projectors: string[] = [];
  const eye = camera.eye;

  // ── Materials: the close-up props wear their own surface; the scene wears the scene's ──
  const shoe = shot === "sneaker" ? markerOf(facts, "prop.shoe") : undefined;
  const shoeFrame: Record<string, StoredParameter> = shoe === undefined ? {} : {
    shoeOrigin: vec(shoe.position),
    shoeX: vec3Extra(shoe.extras, "loom_x", "prop.shoe"),
    shoeY: vec3Extra(shoe.extras, "loom_y", "prop.shoe"),
    shoeZ: vec3Extra(shoe.extras, "loom_z", "prop.shoe"),
  };
  // the pendant set's far wall glows brightest behind and right of the pendant, as the lens sees it
  const wall = shot === "pendant" ? { wallCentre: vec(add(markerOf(facts, "stage.pendant").position, [-2.0, 0.1, -1.6])), wallGlow: 0.13 } : {};
  nodes.push(node("cusurf", "materialWgsl", [-3000, -700], { model: "pbr", source: CLOSEUP_SURFACE_WGSL, ...shoeFrame, ...wall, grime: 0.35, windowGlow: 0.07 }, { label: "cusurf1" }));
  if (shot === "sneaker") {
    nodes.push(node("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: SURFACE_WGSL, headGain: 1, wet: 0.25, wetGloss: 0.22, dryGloss: 0.66 }, { label: "surf1" }));
  }

  const mesh = (area: Area, material: string, index: number, shift?: Vec3): void => {
    const facts_ = facts.areas.get(area);
    if (facts_ === undefined) throw new Error(`closeupDocument: no "${area}" area in the GLB (rebuild it with closeups.py).`);
    nodes.push(node(`mesh_${area}`, "meshFileIn", [-3600, index * 250], { file: facts.glbUrl, select: facts_.select, vertices: facts_.vertices, triangles: facts_.triangles, parts: facts_.parts }, { label: `mesh${area}1` }));
    nodes.push(node(`geo_${area}`, "geometry", [-3200, index * 250], { mode: "surface", material }, { label: `geo${area}1` }));
    if (shift === undefined) {
      edges.push(edge(`mesh-geo-${area}`, [`mesh_${area}`, "out"], [`geo_${area}`, "points"]));
    } else {
      // the car moved for this shot: its whole mesh translated (normals are unchanged by a shift)
      nodes.push(node(`move_${area}`, "pointTransform", [-3400, index * 250], { translate: vec(shift), pivot: "origin" }, { label: `move${area}1` }));
      edges.push(edge(`mesh-move-${area}`, [`mesh_${area}`, "out"], [`move_${area}`, "points"]));
      edges.push(edge(`move-geo-${area}`, [`move_${area}`, "out"], [`geo_${area}`, "points"]));
    }
    scenes.push(`geo${area}1`);
  };

  let aim: [number, number, number];
  let move: Record<string, StoredParameter>;
  let look: Look;

  if (shot === "pendant") {
    mesh("pend", "cusurf1", 0);
    const stage = markerOf(facts, "stage.pendant").position;
    // the pendant's face looks at +Z (glTF); the lens is 30 cm off, a little right and above
    // the view-plane distance to the pendant; the word is turned, so its nearest letters sit ~3 cm closer
    const reach = (stage[0] - eye[0]) * camera.forward[0] + (stage[1] - eye[1]) * camera.forward[1] + (stage[2] - eye[2]) * camera.forward[2];
    const near = reach - 0.028;
    aim = add(eye, camera.forward, reach);
    // Lights, close: a cool key high left, a sodium rim behind right (the warm hint on the
    // letters' edges) and a cyan kick low left. The far wall carries its own soft glow (the
    // surface's backdrop class): a Render's point light hardly falls off (1/(1 + d²)), so a lamp
    // aimed at the wall would wash the pendant as much.
    const light = (id: string, at: Vec3, color: readonly number[], intensity: number): void => {
      nodes.push(node(id, "light", [-2600, 1000 + lights.length * 100], { kind: "point", position: vec(add(stage, at)), color: [...color], intensity }, { label: `${id}1` }));
      lights.push(`${id}1`);
    };
    light("key", [-0.22, 0.32, 0.3], [0.9, 0.95, 1, 1], 0.35);
    light("rim", [0.28, 0.12, -0.2], [1, 0.52, 0.2, 1], 0.22);
    light("kick", [-0.3, -0.18, 0.12], [0.35, 0.85, 1, 1], 0.08);
    // handheld macro: the rig slides right to left across the word, the horizon leaning
    move = handheld(eye, aim, [-0.012, 0.0015, -0.002], 0.0018, { wander: 1.2, lean: -0.8, start: 1.5 });
    look = {
      // 100 mm at f/2.8, focus racking from the front of the N back into the word
      lens: { focal: 100, fstop: 2.8, focus: `${num(near)} + clamp(abstime / ${CUT}, 0, 1) * 0.035`, focusAt: near, maxCoc: 0.1 },
      streak: { from: 0.08, to: 0.15, threshold: 6, gain: 0.5, spread: 0.002, falloff: 1.4, striation: 0.3 },
      bloom: 0.08,
      grade: { exposure: -0.1, black: 0.03, contrast: 1.2, saturation: 0.7, keepWarm: 0.9, bleach: 0.3, highlightTint: [0.97, 1.01, 1.03, 1], shadowTint: [0.94, 1.02, 1.05, 1], split: 0.5, grain: 0.04, grainSize: 1.3 * (width / 1920) },
      lensFx: { distortion: 0.02, edgeBlur: 0.01, swirl: 0.3, aberration: 0.002, vignette: 0.75, vignetteRound: 0.8 },
    };
  } else {
    // ── The sneaker: the warehouse, the white car, the moved black car, the shoe, the figure ──
    const moved = markerOf(facts, "stage.sneaker");
    const shift = vec3Extra(moved.extras, "loom_car_shift", "stage.sneaker");
    const car = moved.extras?.["loom_car"];
    if (typeof car !== "number") throw new Error("closeups: stage.sneaker carries no loom_car.");
    const drawn: Area[] = ["car1", "car3", `car${car}`];
    mesh("wh", "surf1", 0);
    drawn.forEach((area, index) => mesh(area, "surf1", index + 1, area === `car${car}` ? shift : undefined));
    mesh("shoe", "cusurf1", 5);
    // the figure, standing back in the dark between the white car and the bonnet
    const fig = facts.areas.get("fig");
    if (fig === undefined) throw new Error("closeupDocument: no figure in the GLB.");
    const stage = facts.stages.get("sneaker");
    if (stage === undefined) throw new Error("closeupDocument: no stage.sneaker.");
    const known = new Set(facts.bones.map(boneParam));
    const pose: Record<string, string> = {
      // arms down from the A-pose (the scene's own armsDown), elbows a little bent, the head nodding
      "upperarmL.z": "-0.62",
      "upperarmR.z": "0.62",
      "forearmL.x": "-0.35",
      "forearmR.x": "-0.5",
      "neck.x": "0.1 + sin(abstime * 4.3) * 0.05",
      "head.x": "sin(abstime * 4.3 + 0.5) * 0.04",
      "chest.y": "sin(abstime * 1.1) * 0.05",
      "pelvis.y": "sin(abstime * 0.7) * 0.04",
    };
    const posed: Record<string, StoredParameter> = {};
    for (const [key, value] of Object.entries(pose)) {
      const [bone] = key.split(".");
      if (bone === undefined || !known.has(bone)) throw new Error(`closeups: no bone "${bone}".`);
      if (posed[bone] === undefined) posed[bone] = [0, 0, 0];
      posed[key] = expressionSlot(value, 0);
    }
    nodes.push(node("fig", "meshFileIn", [-3600, 1500], { file: facts.glbUrl, select: fig.select, vertices: fig.vertices, triangles: fig.triangles, parts: fig.parts, joints: fig.joints }, { label: "fig1" }));
    nodes.push(node("skin", "pointKernel", [-3300, 1500], { capacity: fig.vertices, attributes: SKIN_ATTRIBUTES, kernel: skinKernel(facts), yaw: yawFor(stage.facing), place: vec(stage.position), ...posed }, { label: "skin1" }));
    nodes.push(node("figGeo", "geometry", [-3000, 1500], { mode: "surface", material: "surf1" }, { label: "figgeo1" }));
    edges.push(edge("fig-skin", ["fig", "out"], ["skin", "in"]));
    edges.push(edge("skin-geo", ["skin", "out"], ["figGeo", "points"]));
    scenes.push("figgeo1");
    // the white car's low beams: one projector between its lamps, as the scene's cars have
    nodes.push(node("cookieSeed", "ramp", [-3000, 1800], {}, { label: "cookieseed1", resolution: { mode: "fixed", width: 256, height: 128 } }));
    nodes.push(node("cookie", "customWgsl", [-2800, 1800], { source: HEADLIGHT_COOKIE_WGSL }, { label: "cookie1", resolution: { mode: "fixed", width: 256, height: 128 } }));
    edges.push(edge("seed-cookie", ["cookieSeed", "out"], ["cookie", "input"]));
    const lamps = ["lamp.head.3l", "lamp.head.3r"].map((name) => markerOf(facts, name));
    const centre = [0, 1, 2].map((axis) => (lamps[0]!.position[axis]! + lamps[1]!.position[axis]!) / 2) as [number, number, number];
    const dir = vec3Extra(lamps[0]!.extras, "loom_light_dir", "lamp.head.3l");
    nodes.push(node("head3", "projector", [-2600, 1600], { eye: vec(centre), lookAt: vec(add(centre, dir, 2)), throwRatio: 0.5, aspect: 2.4, brightness: 0.6, color: [0.78, 0.92, 1, 1], falloff: true, occlusion: true }, { label: "head31" }));
    edges.push(edge("cookie-head3", ["cookie", "out"], ["head3", "cookie"]));
    projectors.push("head31");
    // sodium high-bays: the warm pool on the floor and the trusses; a cyan LED spill from the
    // left over the white car's flank; a dim key low beside the lens for the shoe
    const light = (id: string, at: Vec3, color: readonly number[], intensity: number, shadow?: { readonly range: number }): void => {
      const casts = shadow === undefined ? {} : { shadows: true, shadowExtent: shadow.range, shadowSoftness: 2 };
      nodes.push(node(id, "light", [-2600, 2000 + lights.length * 100], { kind: "point", position: vec(at), color: [...color], intensity, ...casts }, { label: `${id}1` }));
      lights.push(`${id}1`);
    };
    const shoeAt = shoe!.position;
    light("sodiumPool", [2.5, 5.5, -4.5], [1, 0.5, 0.18, 1], 0.6);
    light("coolTop", [-1.4, 4.5, -7.5], [0.85, 0.93, 1, 1], 1.2);
    light("sodiumFar", [-4, 6.8, -12], [1, 0.52, 0.2, 1], 1.4);
    light("cyan", [-3.2, 1.2, -6.5], [0.3, 0.85, 1, 1], 0.6);
    // the key: a big cool source high on the lens's left (the reference's white car and shoe are
    // lit hard from there, and the black bonnet carries its broad sheen)
    const left: Vec3 = [camera.forward[2], 0, -camera.forward[0]];
    light("key", add(add(eye, left, 1.5), [camera.forward[0] * 1.5, 2.4, camera.forward[2] * 1.5]), [0.88, 0.95, 1, 1], 2.5);
    // the white car's own key, from beyond the frame's left edge onto its nose and flank
    light("carKey", [-1.1, 1.3, -6.4], [0.88, 0.95, 1, 1], 1.6);
    // the room: a cold wash high at the back, so the far wall and the trusses sit at a few percent
    light("room", [0.5, 6.5, -13], [0.8, 0.9, 1, 1], 5);
    // the shoe's key CASTS: the sole's contact shadow on the paint is what seats it (a cube map,
    // six passes, ranged tight round the shoe: at 2.5 m the depth precision streaked the leather)
    light("shoeKey", add(add(shoeAt, left, 0.45), [camera.forward[0] * -0.2, 0.55, camera.forward[2] * -0.2]), [0.9, 0.95, 1, 1], 1.6, { range: 1.0 });
    light("shoeRim", add(shoeAt, [-0.5, 0.25, -0.6]), [1, 0.6, 0.3, 1], 0.12);
    aim = add(eye, camera.forward, 4);
    // handheld 20 mm, a slow creep forward over the bonnet, the horizon rolling one way
    move = handheld(eye, aim, [-0.02, 0.004, -0.045], 0.012, { wander: 1.6, lean: 1.1, start: -2.5 });
    look = {
      // 20 mm wide open: the shoe crisp, the car and the figure soft, the bonnet's lip at the lens a blur
      lens: { focal: 20, fstop: 1.4, focus: "0.7", focusAt: 0.7, maxCoc: 0.03 },
      streak: { from: 0.7, to: 0.58, threshold: 12, gain: 0.55, spread: 0.0, falloff: 0.7, striation: 0.25 },
      bloom: 0.12,
      grade: { exposure: 0.35, black: 0.035, contrast: 1.18, saturation: 0.62, keepWarm: 0.9, bleach: 0.3, highlightTint: [0.96, 1.01, 1.03, 1], shadowTint: [0.95, 1.02, 1.04, 1], split: 0.45, grain: 0.04, grainSize: 1.3 * (width / 1920) },
      lensFx: { distortion: 0.09, edgeBlur: 0.016, swirl: 0.6, aberration: 0.0022, vignette: 0.65, vignetteRound: 0.75 },
    };
  }

  // ── Environment (reflections) ──
  nodes.push(node("envSeed", "ramp", [-2700, 300], {}, { label: "envseed1", resolution: { mode: "fixed", width: 1024, height: 512 } }));
  if (shot === "pendant") {
    // the tent of cards stands round the pendant's face (it looks along +Z), not round the lens:
    // seen this obliquely, the face mirrors the far side of the tent
    const toward = [0.35, 0.1, 1];
    const hdriRoom = options.hdri === true ? 1 : 0;
    nodes.push(node("env", "customWgsl", [-2700, 500], { source: STUDIO_ENV_WGSL, softbox: 3, strip: 6, points: 150, count: 70, size: 0.005, surround: 0.5, cards: 220, room: hdriRoom * 0.6, roomTurn: 0.3, toward }, { label: "env1", resolution: { mode: "fixed", width: 2048, height: 1024 } }));
  } else {
    nodes.push(node("env", "customWgsl", [-2700, 500], { source: ENVIRONMENT_WGSL, bars: 2.5, roof: 0.01 }, { label: "env1", resolution: { mode: "fixed", width: 1024, height: 512 } }));
  }
  const hdri = options.hdri === true;
  if (hdri && shot === "pendant") {
    // the macro's tent over a real room: the HDRI arrives as the studio's input
    nodes.push(node("hdri", "movieFileIn", [-2900, 700], { file: "media/on-nothing/hdri.png" }, { label: "hdri1", resolution: { mode: "fixed", width: 2048, height: 1024 } }));
    edges.push(edge("hdri-env", ["hdri", "out"], ["env", "input"]));
  } else {
    edges.push(edge("seed-env", ["envSeed", "out"], ["env", "input"]));
  }
  if (hdri && shot === "sneaker") {
    // a real room in the reflections: the black paint and the chrome mirror its shapes
    nodes.push(node("hdri", "movieFileIn", [-2900, 700], { file: "media/on-nothing/hdri.png" }, { label: "hdri1", resolution: { mode: "fixed", width: 2048, height: 1024 } }));
    // turned so the room's brightest window does not sit in the paint behind the heel, and SMALL: the
    // Render's IBL has no prefiltered mips (5 diffuse taps, 16 glossy), so a sharp 2k room streaks the
    // matte leather; at 256 × 128 it is its own blur, and the bonnet still mirrors soft shapes
    nodes.push(node("envHdri", "customWgsl", [-2700, 700], { source: ENVIRONMENT_HDRI_WGSL, gain: 1.1, crush: 0.85, turn: 0.35 }, { label: "envhdri1", resolution: { mode: "fixed", width: 256, height: 128 } }));
    edges.push(edge("hdri-env", ["hdri", "out"], ["envHdri", "input"]));
  }

  // ── Camera and the Render ──
  nodes.push(node("cam", "camera", [-2700, -900], { eye: vec(eye), lookAt: aim, fov: camera.fovDeg, near: shot === "pendant" ? 0.01 : 0.03, far: 200, ...move }, { label: "cam1" }));
  const cameraRef = (field: string, fallback: number): StoredParameter => expressionSlot(`op('cam1').par.${field}`, fallback);
  const cameraParams: Record<string, StoredParameter> = {
    eye: vec(eye),
    aim,
    "eye.x": cameraRef("eye.x", eye[0]),
    "eye.y": cameraRef("eye.y", eye[1]),
    "eye.z": cameraRef("eye.z", eye[2]),
    "aim.x": cameraRef("lookAt.x", aim[0]),
    "aim.y": cameraRef("lookAt.y", aim[1]),
    "aim.z": cameraRef("lookAt.z", aim[2]),
    fov: cameraRef("fov", camera.fovDeg),
    far: cameraRef("far", 200),
    roll: cameraRef("roll", 0),
  };
  nodes.push(node("shot", "render", [-2400, 0], {
    scenes: scenes.join(" "),
    camera: "cam1",
    lights: lights.join(" "),
    projectors: projectors.join(" "),
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0,
    background: [0, 0, 0, 1],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    albedoOutput: true,
    // the sneaker's room is a sharp HDRI: the IBL does not blur it by roughness enough, so it stays low
    environmentIntensity: shot === "pendant" ? 1 : 0.12,
    environmentTaps: 16,
  }, { label: "shot1" }));
  edges.push(edge("env-shot", [hdri && shot === "sneaker" ? "envHdri" : "env", "out"], ["shot", "environment"]));

  // ── Screen space ──
  let last: readonly [string, string] = ["shot", "out"];
  const pass = (id: string, source: string, extra: Record<string, StoredParameter>, more: readonly (readonly [string, string])[], position: readonly [number, number]): void => {
    nodes.push(node(id, more.length > 0 ? "customWgslMulti" : "customWgsl", position, { source, ...extra }, { label: `${id.toLowerCase()}1`, resolution: { mode: "project" } }));
    edges.push(edge(`${last[0]}-${id}`, last, [id, "input"]));
    more.forEach((port, index) => edges.push(edge(`${id}-more${index}`, port, [id, "more"], index)));
    last = [id, "out"];
  };
  const stock = (id: string, type: string, parameters: Record<string, StoredParameter>, position: readonly [number, number]): void => {
    nodes.push(node(id, type, position, parameters, { label: `${id.toLowerCase()}1` }));
    edges.push(edge(`${last[0]}-${id}`, last, [id, "input"]));
    last = [id, "out"];
  };
  const depth = ["shot", "depth"] as const;
  const normal = ["shot", "normal"] as const;
  if (shot === "sneaker") {
    // the black bonnet and the damp floor mirror the lamps and the shoe
    pass("reflections", GLOSSY_SSR_WGSL, { ...cameraParams, strength: 1.2, maxDistance: 20, roughnessCutoff: 0.55, thickness: 0.3, blur: 1.2, stretch: 3, keepBright: 3, dimShare: 0.35 }, [depth, normal], [-2100, 0]);
  }
  pass("occlusion", GTAO_WGSL, { ...cameraParams, radius: shot === "pendant" ? 0.006 : 0.08, strength: shot === "pendant" ? 0.7 : 1.1 }, [depth, normal], [-1900, 0]);
  if (shot === "sneaker") {
    // haze in the white car's beams only (the moved car's lamps face away, the others are not drawn)
    const beams = { ...facts, markers: new Map([...facts.markers].filter(([name]) => name.startsWith("lamp.head.3"))) };
    pass("haze", hazeWgsl(hazeLights(beams, ["head"])), { ...cameraParams, density: 0.03, ambient: [0.003, 0.0035, 0.004], anisotropy: 0.72, head: 0.25 }, [depth], [-1700, 0]);
  }
  const lensParams: Record<string, StoredParameter> = {
    ...cameraParams,
    focal: look.lens.focal,
    fstop: look.lens.fstop,
    focus: expressionSlot(look.lens.focus, look.lens.focusAt),
    maxCoc: look.lens.maxCoc,
  };
  pass("dof", LENS_DOF_WGSL, lensParams, [depth], [-1500, 0]);
  pass("dofFill", DOF_FILL_WGSL, lensParams, [depth], [-1400, 0]);
  const scene = last;

  // ── Optics: the streak glass (stock), bloom (the furnace's pyramid) ──
  const t = `clamp(abstime / ${CUT}, 0, 1)`;
  // What the glass smears: only the hottest sources, softened to their glow first, so a lamp's
  // column is one smooth slab as wide as the lamp (the stock Spread copies a thin source sideways
  // three times, which reads as a barcode).
  nodes.push(node("hotStreak", "customWgsl", [-1300, 700], { source: BRIGHT_PASS_WGSL, threshold: look.streak.threshold, knee: look.streak.threshold * 0.3 }, { label: "hotstreak1", resolution: { mode: "scale", factor: 0.5 } }));
  edges.push(edge("scene-hotstreak", scene, ["hotStreak", "input"]));
  // softened over three halvings: a lamp becomes a soft blob as wide as its halo
  nodes.push(node("hotSoft", "customWgsl", [-1200, 700], { source: BLOOM_DOWN_WGSL, clampLuma: 0 }, { label: "hotsoft1", resolution: { mode: "scale", factor: 0.5 } }));
  edges.push(edge("hot-soft", ["hotStreak", "out"], ["hotSoft", "input"]));
  nodes.push(node("hotSofter", "customWgsl", [-1100, 700], { source: BLOOM_DOWN_WGSL, clampLuma: 0 }, { label: "hotsofter1", resolution: { mode: "scale", factor: 0.5 } }));
  edges.push(edge("soft-softer", ["hotSoft", "out"], ["hotSofter", "input"]));
  nodes.push(node("hotSoftest", "customWgsl", [-1000, 700], { source: BLOOM_DOWN_WGSL, clampLuma: 0 }, { label: "hotsoftest1", resolution: { mode: "scale", factor: 0.5 } }));
  edges.push(edge("softer-softest", ["hotSofter", "out"], ["hotSoftest", "input"]));
  stock("streak", "streak", {
    threshold: look.streak.threshold,
    knee: 0.8,
    length: expressionSlot(`${look.streak.from} + (${look.streak.to} - ${look.streak.from}) * ${t}`, look.streak.from),
    angle: 0,
    falloff: look.streak.falloff,
    spread: look.streak.spread,
    tail: 0.04,
    striation: look.streak.striation,
    striationScale: 120,
    gain: look.streak.gain,
    tint: [0.92, 0.98, 1, 1],
  }, [-1200, 0]);
  edges.push(edge("soft-streak", [shot === "sneaker" ? "hotSoftest" : "hotSoft", "out"], ["streak", "bright"]));
  nodes.push(node("bright", "customWgsl", [-1300, 300], { source: BRIGHT_PASS_WGSL, threshold: 1.4, knee: 0.8 }, { label: "bright1", resolution: { mode: "scale", factor: 0.5 } }));
  edges.push(edge("scene-bright", scene, ["bright", "input"]));
  for (const level of [1, 2, 3, 4]) {
    nodes.push(node(`bloomDown${level}`, "customWgsl", [-900, 150 + level * 150], { source: BLOOM_DOWN_WGSL, clampLuma: level === 1 ? 1 : 0 }, { label: `bloomdown${level}1`, resolution: { mode: "scale", factor: 0.5 } }));
    edges.push(edge(`bloom-down${level}`, [level === 1 ? "bright" : `bloomDown${level - 1}`, "out"], [`bloomDown${level}`, "input"]));
  }
  for (const level of [0, 1, 2, 3]) {
    nodes.push(node(`bloomUp${level}`, "customWgslMulti", [-700, 150 + level * 150], { source: BLOOM_UP_WGSL, lower: 1 }, { label: `bloomup${level}1`, resolution: { mode: "scale", factor: 2 } }));
    edges.push(edge(`bloom-up${level}-lower`, [level === 3 ? "bloomDown4" : `bloomUp${level + 1}`, "out"], [`bloomUp${level}`, "input"]));
    edges.push(edge(`bloom-up${level}-own`, [level === 0 ? "bright" : `bloomDown${level}`, "out"], [`bloomUp${level}`, "more"], 0));
  }
  pass("bloom", BLOOM_ADD_WGSL, { gain: look.bloom }, [["bloomUp0", "out"]], [-600, 0]);

  // ── Lens and grade (stock) ──
  stock("lens", "lens", look.lensFx, [-300, 0]);
  stock("grade", "filmGrade", look.grade, [-100, 0]);
  if (options.crt === true) stock("crt", "crt", { amount: 1 }, [500, 0]);
  nodes.push(node("out", "output", [700, 0], { toneMap: "none" }, { label: "out1" }));
  edges.push(edge("last-out", last, ["out", "input"]));

  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: `project-on-nothing-${shot}`,
    name: `On Nothing · ${shot}`,
    graph: graph(nodes, edges),
    settings: settings({
      outputResolution: { width, height },
      randomSeed: 7,
      limits: { ...LIMITS, memoryBudgetBytes: 3_221_225_472 },
    }),
    assets: [],
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
}
