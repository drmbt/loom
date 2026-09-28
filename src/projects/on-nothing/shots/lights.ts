import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { boneParam, yawFor } from "../skin-kernel.ts";
import { hazeLights, hazeWgsl } from "../atmosphere.ts";
import { CAR_RIG_ATTRIBUTES } from "../car-rig.ts";
import { DOF_FILL_WGSL, LENS_DOF_WGSL } from "./closeups-fx.ts";
import { armPose, type Pose } from "./gait.ts";
import { addNode, connect, dropParams, finish, setParams, spliceAfter, surgery, type Surgery } from "./splice.ts";

/**
 * T1407b (lights) — THE LIGHT, DETAIL AND ABSTRACT ROWS: the reference's car details, backlit
 * flares, sodium bokeh, floor pools, white frames and defocused inserts. Every row is another
 * CAMERA (and pose, and finish) on a set that already exists, so each take is graph surgery on
 * a stock shot's document (splice.ts), like halo.ts and crt.ts:
 *
 *   take = the EDL row it plays.
 *
 * What each take stands on, and what the reference measured, is written at the take.
 */

type V3 = readonly [number, number, number];

/** The shots a take may stand on, built by document.ts's onNothingDocument (passed in: no import cycle). */
type BaseShot = "tableau" | "ring" | "cyc" | "cyc-wide" | "halo";
export type Build = (facts: OnNothingFacts, options: { shot: BaseShot; take?: number; width?: number; height?: number; audio?: boolean; hdri?: boolean; crt?: boolean }) => ProjectDocument;

export interface LightsOptions {
  readonly take?: number;
  readonly width?: number;
  readonly height?: number;
  readonly audio?: boolean;
  readonly hdri?: boolean;
  readonly crt?: boolean;
}

/** The reference's frame (2.35:1): a vertical fov in degrees as a focal length on a 36 mm-wide sensor. */
const ASPECT = 1920 / 818;
const focalFor = (fovDeg: number): number => 18 / (Math.tan((fovDeg * Math.PI) / 360) * ASPECT);

const f = (v: number, d = 5): string => (v < 0 ? `(${v.toFixed(d)})` : v.toFixed(d));
/** An eased 0 → 1 of abstime over [a, b] s. */
const ease = (a: number, b: number): string => {
  const x = `clamp((abstime - ${f(a)}) / ${f(b - a)}, 0, 1)`;
  return `(${x} ^ 2 * (3 - 2 * ${x}))`;
};
/** Three incommensurate sines: a hand on the camera that never loops inside a shot. */
const wob = (a: number, b: number, c: number, phase: number): string =>
  `(sin(abstime * ${a} + ${f(phase, 3)}) * 0.5 + sin(abstime * ${b} + ${f(phase * 1.7, 3)}) * 0.3 + sin(abstime * ${c} + ${f(phase * 2.3, 3)}) * 0.2)`;

/** A camera key: where the eye and the aim are at time `t` (s); the move eases between keys. */
interface CamKey {
  readonly t: number;
  readonly eye: V3;
  readonly aim: V3;
}

interface CameraMove {
  readonly keys: readonly CamKey[];
  readonly fov: number;
  /** Handheld wander: eye (m) and aim (m at the target). */
  readonly shake: number;
  readonly aimShake: number;
  /** Horizon: degrees at t = 0, degrees per second, and its wander (degrees). */
  readonly roll: number;
  readonly rollRate?: number;
  readonly rollWander?: number;
}

/** The Camera node's parameters for a keyed, handheld move. */
function cameraParams(move: CameraMove): Record<string, StoredParameter> {
  const keys = move.keys;
  const first = keys[0]!;
  const axis = (pick: (key: CamKey) => V3, index: 0 | 1 | 2): string => {
    let expression = f(pick(first)[index]);
    for (let k = 1; k < keys.length; k++) {
      const a = keys[k - 1]!;
      const b = keys[k]!;
      const delta = pick(b)[index] - pick(a)[index];
      if (Math.abs(delta) > 1e-6) expression += ` + ${f(delta)} * ${ease(a.t, b.t)}`;
    }
    return expression;
  };
  const phases = [0.3, 1.1, 2.2, 2.0, 2.7, 0.4];
  const freqs: [number, number, number][] = [[0.9, 2.3, 5.1], [1.3, 3.1, 6.7], [0.7, 1.7, 4.3], [0.7, 1.9, 4.3], [0.8, 2.1, 4.9], [0.6, 1.5, 3.7]];
  const params: Record<string, StoredParameter> = { eye: [...first.eye], lookAt: [...first.aim], fov: move.fov };
  (["eye", "lookAt"] as const).forEach((field, which) => {
    ([0, 1, 2] as const).forEach((index) => {
      const k = which * 3 + index;
      const amplitude = which === 0 ? move.shake : move.aimShake;
      const base = axis((key) => (which === 0 ? key.eye : key.aim), index);
      const [a, b, c] = freqs[k]!;
      params[`${field}.${"xyz"[index]}`] = expressionSlot(`${base} + ${wob(a, b, c, phases[k]!)} * ${f(amplitude)}`, (which === 0 ? first.eye : first.aim)[index]);
    });
  });
  params["roll"] = expressionSlot(`${f(move.roll)} + abstime * ${f(move.rollRate ?? 0)} + ${wob(0.5, 1.4, 3.3, 0.9)} * ${f(move.rollWander ?? 0)}`, move.roll);
  return params;
}

function setCamera(cut: Surgery, move: CameraMove): void {
  const cam = cut.nodes["cam"];
  if (cam === undefined) throw new Error("lights: the base graph has no camera cam.");
  // every expression the base's operator set goes; the keyed move replaces it
  dropParams(cut, "cam", Object.keys(cam.parameters).filter((key) => key.includes(".") || key === "roll" || key === "fov"));
  setParams(cut, "cam", cameraParams(move));
}

/** Pose the base's figure afresh: its mesh, where it stands, which way it faces, and the knobs. */
function poseFigure(cut: Surgery, facts: OnNothingFacts, figure: { area?: "fig" | "figbare" | "fighand"; place: V3; facing: V3; knobs: Record<string, string> }): void {
  if (figure.area !== undefined) {
    const mesh = facts.areas.get(figure.area);
    if (mesh === undefined) throw new Error(`lights: no ${figure.area} in the GLB.`);
    setParams(cut, "fig", { select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts, joints: mesh.joints });
    setParams(cut, "skin", { capacity: mesh.vertices });
  }
  const skin = cut.nodes["skin"];
  if (skin === undefined) throw new Error("lights: the base graph has no skin.");
  dropParams(cut, "skin", Object.keys(skin.parameters).filter((key) => key.includes(".")));
  const pose: Record<string, StoredParameter> = { yaw: yawFor(figure.facing), place: [...figure.place] };
  for (const bone of facts.bones) pose[boneParam(bone)] = [0, 0, 0];
  const known = new Set(facts.bones.map(boneParam));
  for (const [key, value] of Object.entries(figure.knobs)) {
    const [bone] = key.split(".");
    if (bone === undefined || !known.has(bone)) throw new Error(`lights: no bone "${bone}".`);
    pose[key] = expressionSlot(value, 0);
  }
  setParams(cut, "skin", pose);
}

/** A light added to the base's Render (its label: the id lower-cased plus 1). */
function addLight(cut: Surgery, id: string, parameters: Record<string, StoredParameter>): void {
  const label = `${id.toLowerCase()}1`;
  addNode(cut, id, "light", [-2600, 600 - Object.keys(cut.nodes).length * 10], parameters, { label });
  const shot = cut.nodes["shot"];
  if (shot === undefined) throw new Error("lights: the base graph has no Render shot.");
  setParams(cut, "shot", { lights: `${String(shot.parameters["lights"])} ${label}`.trim() });
}

/** Keep only these of the Render's lights (labels). */
function keepLights(cut: Surgery, keep: readonly string[]): void {
  setParams(cut, "shot", { lights: keep.join(" ") });
}

/** The Render's scenes without these labels. */
function dropScenes(cut: Surgery, drop: readonly string[]): void {
  const shot = cut.nodes["shot"];
  if (shot === undefined) throw new Error("lights: the base graph has no Render shot.");
  const scenes = String(shot.parameters["scenes"]).split(" ").filter((label) => label !== "" && !drop.includes(label));
  setParams(cut, "shot", { scenes: scenes.join(" ") });
}

/**
 * The lens's depth of field from the thin-lens equation (closeups-fx.ts) in place of the base's
 * pixel-strength DOF: at a tele CU the soft background and the bokeh are the look.
 */
function thinLens(cut: Surgery, lens: { fov: number; fstop: number; focus: string; focusAt: number; maxCoc: number; rim?: number; catEye?: number; fringe?: number }): void {
  const node = cut.nodes["lens_dof"];
  if (node === undefined) throw new Error("lights: the base graph has no lens_dof.");
  dropParams(cut, "lens_dof", ["aperture", "maxRadius", "focusDistance"]);
  const params: Record<string, StoredParameter> = {
    focal: focalFor(lens.fov),
    fstop: lens.fstop,
    focus: expressionSlot(lens.focus, lens.focusAt),
    maxCoc: lens.maxCoc,
    rim: lens.rim ?? 0.35,
    catEye: lens.catEye ?? 0.45,
    fringe: lens.fringe ?? 0.08,
  };
  setParams(cut, "lens_dof", { source: LENS_DOF_WGSL, ...params });
  // the fill after the gather reads the same lens and camera
  const camera = Object.fromEntries(Object.entries(node.parameters).filter(([key]) => ["eye", "aim", "fov", "far", "roll"].some((k) => key === k || key.startsWith(`${k}.`))));
  const { rim: _rim, catEye: _catEye, fringe: _fringe, ...fill } = params;
  addNode(cut, "dofFill", "customWgslMulti", [-1400, 200], { source: DOF_FILL_WGSL, ...camera, ...fill }, { label: "doffill1" });
  spliceAfter(cut, "lens_dof", "dofFill");
  connect(cut, ["shot", "depth"], ["dofFill", "more"], 0);
}

/**
 * The hero's satin grey as the reference's CUs show it: a light, soft-sheened paint that reads by
 * its own diffuse grey, where the scene's clear coat (metallic 0.85, class 11) only mirrors a black
 * room. A variant of the car's material, worn by that car alone, in the takes that frame it close.
 */
function satinPaint(cut: Surgery, area: string, look: { albedo: number; metallic: number; roughness: number }): void {
  // class 11 (car0's paint) is the satin silver itself since 1e846207, driven by the surface's own knobs
  if (area !== "car0") throw new Error(`lights: satinPaint drives class 11, which only car0 wears (asked for ${area}).`);
  if (cut.nodes["surf"] === undefined) throw new Error("lights: the base graph has no surf.");
  setParams(cut, "surf", { silverAlbedo: look.albedo, silverMetallic: look.metallic, silverRoughness: look.roughness });
}

/**
 * 1 on the given frames of the take (24 fps, frame k spanning [k, k + 1) / 24 s, so every
 * sub-frame of render.ts's shutter sees it), 0 elsewhere: a strobe cut into one shot.
 */
function frameFlash(frames: readonly number[]): string {
  return `min(${frames.map((k) => `clamp((abstime * 24 - ${k} + 0.01) * 1000, 0, 1) * clamp((${k + 1} - abstime * 24 - 0.01) * 1000, 0, 1)`).join(" + ")}, 1)`;
}

/** Translate one car's whole mesh for this take (a Point Transform between its Mesh File In and its Geometry). */
function moveCar(cut: Surgery, facts: OnNothingFacts, area: string, shift: V3, yawDeg = 0): void {
  const edgeId = `mesh-geo-${area}`;
  if (cut.edges[edgeId] === undefined) throw new Error(`lights: no edge ${edgeId} (the car is rigged or gone).`);
  const mesh = facts.areas.get(area as never);
  if (mesh === undefined) throw new Error(`lights: no ${area} in the GLB.`);
  delete cut.edges[edgeId];
  // turned about its own footprint's centre (normals turn with it), then moved
  const b = mesh.bounds;
  const pivot: V3 = [(b.min[0] + b.max[0]) / 2, 0, (b.min[2] + b.max[2]) / 2];
  addNode(cut, `move_${area}`, "pointKernel", [-3450, 0], { capacity: mesh.vertices, attributes: CAR_RIG_ATTRIBUTES, kernel: TURN_CAR_KERNEL, pivot: [...pivot], shift: [...shift], yaw: (yawDeg * Math.PI) / 180 }, { label: `move${area}1` });
  connect(cut, [`mesh_${area}`, "out"], [`move_${area}`, "in"]);
  connect(cut, [`move_${area}`, "out"], [`geo_${area}`, "points"]);
}

/** A parked car turned about +y at a pivot and moved: positions and normals both. */
const TURN_CAR_KERNEL = `// T1407b (lights) — a parked car stood on another mark for one take.
struct Params {
  pivot: vec3f, // @default 0  The turn's centre (world).
  shift: vec3f, // @default 0  The move after the turn (metres).
  yaw: f32, // @default 0  The turn about +y (radians).
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let c = cos(ctx.params.yaw);
  let s = sin(ctx.params.yaw);
  let d = p.position - ctx.params.pivot;
  q.position = ctx.params.pivot + vec3f(c * d.x + s * d.z, d.y, -s * d.x + c * d.z) + ctx.params.shift;
  q.normal = vec3f(c * p.normal.x + s * p.normal.z, p.normal.y, -s * p.normal.x + c * p.normal.z);
  return q;
}`;

/** The streak columns' reach (an expression, fraction of the frame height): the base's three chained passes step reach/400, /60, /20. */
function streakReach(cut: Surgery, reach: string): void {
  [400, 60, 20].forEach((div, index) => setParams(cut, `streak${index}`, { step: expressionSlot(`(${reach}) / ${div}`, 0.4 / div) }));
}

/** Every take: the row it plays and what it stands on. */
interface Take {
  readonly base: BaseShot;
  readonly build: (cut: Surgery, facts: OnNothingFacts, options: LightsOptions) => void;
}

const TAKES: Record<number, Take> = {};

// ─────────────────────────────── the car set (the tableau's) ───────────────────────────────

/** The tableau without its figure. */
const noFigure = (cut: Surgery): void => dropScenes(cut, ["figgeo1"]);

/**
 * Row 28 (0:30.45, 17 frames): a tele CU along the satin-grey hero's flank from its front
 * corner — the mirror and the A-pillar top left, the shoulder line running right, the arch low,
 * a soft pool of light on the far wall top centre — then a whip DOWN onto the front wheel arch
 * and the tyre (0.3 s in).
 */
TAKES[28] = {
  base: "tableau",
  build: (cut) => {
    // the hero and its neighbour only: the back row's lamps would sit on the flank's vanishing point
    dropScenes(cut, ["figgeo1", "geocar11", "geocar21", "geocar31", "geocar41", "geolampglint1"]);
    setParams(cut, "shot", { projectors: "" });
    const fov = 10;
    setCamera(cut, {
      keys: [
        { t: 0, eye: [-1.45, 1.1, 1.2], aim: [-0.35, 1.3, -4.0] },
        { t: 0.26, eye: [-1.45, 1.08, 1.15], aim: [-0.37, 1.18, -4.0] },
        { t: 0.4, eye: [-1.8, 1.25, 0.35], aim: [-1.0, 0.9, -1.0] },
      ],
      fov,
      shake: 0.004,
      aimShake: 0.01,
      roll: 3,
      rollRate: -3,
      rollWander: -0.8,
    });
    thinLens(cut, { fov, fstop: 2, focus: `2.9 - 1.4 * ${ease(0.26, 0.4)}`, focusAt: 2.9, maxCoc: 0.04 });
    // a big soft source high beyond the car's tail rakes the flank (the sheen along the shoulder),
    // and a lamp at the far wall throws the soft pool the reference shows over the roofline
    keepLights(cut, []);
    addLight(cut, "rake28", { kind: "point", position: [-2.6, 2.6, -6.5], color: [0.9, 0.95, 1, 1], intensity: 36, shadows: true, shadowExtent: 12, shadowSoftness: 3 });
    addLight(cut, "wall28", { kind: "point", position: [2.4, 3.4, -17.2], color: [0.9, 0.95, 1, 1], intensity: 60 });
    // the reference's lamps are dark here: nothing on the front corner glows
    setParams(cut, "surf", { headGain: 0, tailGain: 0 });
    satinPaint(cut, "car0", { albedo: 0.5, metallic: 0.15, roughness: 0.3 });
    setParams(cut, "env", { roof: 0.08, floor: 0.02, bars: 1 });
    setParams(cut, "shot", { environmentIntensity: 0.3 });
    // the reference's panel sits high (sRGB ~190 on the sheen): a brighter print than the tableau's
    setParams(cut, "grade", { exposure: 0.55 });
    addLight(cut, "fill28", { kind: "point", position: [-2.2, 1.4, 1.5], color: [0.85, 0.92, 1, 1], intensity: 0.5 });
  },
};

/**
 * Row 29 (0:31.16, 18 frames): the hero's face from low front-left, wide — its lamps' columns
 * running up the frame; a white SUV's flank right at the lens on the left edge, blown and
 * streaked; the white car on the right seen three-quarter beyond. Handheld, a slow drift right.
 */
TAKES[29] = {
  base: "tableau",
  build: (cut, facts) => {
    noFigure(cut);
    // solved (scratchpad solve.py) against the reference's four lamps, the hero's front wheel and its bumper
    // (the four lamps, the near white car's lamp and the hero's bumper, with the near car moved as below)
    const fov = 15;
    setCamera(cut, {
      keys: [
        { t: 0, eye: [-3.02, 1.12, 5.44], aim: [-1.45, 0.95, 2.89] },
        { t: 0.8, eye: [-2.97, 1.12, 5.4], aim: [-1.4, 0.95, 2.87] },
      ],
      fov,
      shake: 0.012,
      aimShake: 0.025,
      roll: -1.5,
      rollRate: 1.2,
      rollWander: -0.8,
    });
    setParams(cut, "lens_dof", { focusDistance: 6.0, aperture: 0.6 });
    // off the beam's axis the reference's lamps read as small LED blocks, not a glare
    setParams(cut, "surf", { headGain: 0.1 });
    setParams(cut, "haze", { head: 0.03 });
    // a soft key low on the lens's left: the hero's grille, bumper and wheel read grey, the room stays black
    // THE STROBE: on three single frames (752, 755 and 762 of the reference: the row's 5th, 8th
    // and 15th) a key fires from low on the lens's left and the hero stands out grey; between
    // them it is a black face with a chrome grille, lit only by its neighbours' columns.
    const flash = frameFlash([5, 8, 15]);
    // the tableau's low key and face fill would light the hero's face between the flashes
    keepLights(cut, ["sodiumpool1", "sodiuma1", "sodiumb1"]);
    // (behind the lens and a little right of it: the near white car at the frame's edge must not blow out;
    // a trickle between the flashes keeps the hero's silver readable, as the reference's is)
    addLight(cut, "key29", { kind: "point", position: [-2.2, 1.6, 6.8], color: [0.88, 0.94, 1, 1], intensity: expressionSlot(`40 + 100 * ${flash}`, 40) });
    setParams(cut, "grade", { exposure: expressionSlot(`0.05 + 0.45 * ${flash}`, 0.05) });
    // The near white car stands a stride further forward than on the tableau's mark, so its flank
    // fills the frame's left edge at the lens; the far one stands two metres back, three-quarter
    // beyond the hero, as in the reference.
    moveCar(cut, facts, "car1", [0.33, 0, 3.68], -22);
    moveCar(cut, facts, "car2", [0.3, 0, -1.8]);
    // Steady between the flashes: the white neighbours' flanks glow (a lamp in each gap, just
    // behind the hero's face, so it grazes past it), while the hero's black face stays unlit.
    addLight(cut, "gapL29", { kind: "point", position: [-0.95, 1.3, -0.5], color: [0.88, 0.94, 1, 1], intensity: 12 });
    addLight(cut, "gapR29", { kind: "point", position: [1.4, 1.2, -0.9], color: [0.88, 0.94, 1, 1], intensity: 6 });
    // the columns run to the top of the frame (the base's reach is a third of it)
    streakReach(cut, "0.95");
  },
};

/**
 * Row 99 (1:46.52, 9 frames): a dark car panel — a grille's vertical bars running diagonally
 * across the frame, a smooth panel beside them catching one soft highlight — tele, in the dark.
 */
TAKES[99] = {
  base: "tableau",
  build: (cut) => {
    noFigure(cut);
    const fov = 9;
    setCamera(cut, {
      keys: [
        { t: 0, eye: [0.9, 0.8, 1.2], aim: [0.1, 0.75, -0.05] },
        { t: 0.4, eye: [0.88, 0.8, 1.18], aim: [0.12, 0.72, -0.05] },
      ],
      fov,
      shake: 0.003,
      aimShake: 0.006,
      roll: 24,
      rollRate: -2,
      rollWander: -0.5,
    });
    thinLens(cut, { fov, fstop: 2.8, focus: "1.25", focusAt: 1.25, maxCoc: 0.03 });
  },
};

/**
 * Row 106 (1:55.74, 48 frames): a tele CU of a turbine wheel from low beside the car, a soft
 * body panel crossing the right of the frame in the foreground, an amber bokeh over the tyre;
 * a slow track along the car.
 */
TAKES[106] = {
  base: "tableau",
  build: (cut) => {
    noFigure(cut);
    const fov = 17;
    setCamera(cut, {
      keys: [
        { t: 0, eye: [-1.7, 0.42, 0.3], aim: [-1.0, 0.45, -1.0] },
        { t: 2.0, eye: [-1.72, 0.42, 0.05], aim: [-1.0, 0.45, -1.15] },
      ],
      fov,
      shake: 0.003,
      aimShake: 0.006,
      roll: -2,
      rollRate: -0.3,
      rollWander: -0.3,
    });
    thinLens(cut, { fov, fstop: 2, focus: "1.35", focusAt: 1.35, maxCoc: 0.05 });
  },
};

/**
 * Row 1, part a (0:00.00, 8 frames, before the title): close past the hero's grille (the left
 * quarter of the frame) at its lamp, the white neighbour's lamps beyond — each lamp's LEDs
 * drawn up into short columns — drifting for three frames; then a WHIP (frame 3 a violent
 * smear up and across) into a featureless grey-teal smear (frames 4–7, sRGB ~45–55) that the
 * title's grille lands out of.
 */
TAKES[1] = {
  base: "tableau",
  build: (cut, facts) => {
    noFigure(cut);
    // the white neighbour stands back, so its lamps read as the smaller blocks beyond the hero's
    moveCar(cut, facts, "car2", [0.2, 0, -2.6]);
    const fov = 24;
    setCamera(cut, {
      keys: [
        { t: 0, eye: [0.05, 0.85, 1.05], aim: [1.9, 0.95, -1.5] },
        { t: 0.1, eye: [0.03, 0.85, 1.05], aim: [2.0, 0.9, -1.5] },
        // the whip: up and across, hard, then on through the dark room
        { t: 0.2, eye: [0.0, 0.92, 1.0], aim: [5.0, 2.8, 0.2] },
        { t: 0.34, eye: [0.0, 0.97, 0.95], aim: [5.5, 3.4, 3.8] },
      ],
      fov,
      shake: 0.006,
      aimShake: 0.02,
      roll: -6,
      rollRate: -30,
      rollWander: -1,
    });
    setParams(cut, "lens_dof", { focusDistance: 1.5, aperture: 1.1 });
    setParams(cut, "surf", { headGain: 0.6 });
    // the glass: short columns off each LED, not the tableau's tall slabs
    streakReach(cut, "0.3");
    // the whip's smear, image-space (a --final render adds the real sub-frame motion blur on top):
    // nothing for three frames, a violent smear on frame 3, the grey wash after
    setParams(cut, "lens", { whip: expressionSlot(`0.45 * clamp((abstime * 24 - 2.5) / 1.5, 0, 1)`, 0) });
    // the smear is the room averaged: a grey-teal wash lifts the blacks as the whip runs
    setParams(cut, "grade", { lift: expressionSlot(`0.06 + 0.17 * clamp((abstime * 24 - 3) / 1.5, 0, 1)`, 0.06), exposure: 1.0, shadowTint: [0.9, 1.03, 1.07, 1], split: 0.6 });
  },
};

/**
 * Row 70 (1:13.95, 73 frames): the floor from above on a long lens — two headlight pools on dry
 * concrete, black between them, the figure's shadow crossing them.
 */
TAKES[70] = {
  base: "tableau",
  build: (cut, facts) => {
    const fov = 20;
    setCamera(cut, {
      keys: [
        { t: 0, eye: [0.0, 6.5, 5.2], aim: [0.0, 0, 4.9] },
        { t: 3.1, eye: [0.05, 6.5, 5.1], aim: [0.05, 0, 4.8] },
      ],
      fov,
      shake: 0.01,
      aimShake: 0.012,
      roll: 0,
      rollRate: -1,
      rollWander: -0.5,
    });
    // the figure walks across between the car and the pools: only its shadow reaches the frame
    const stage = facts.stages.get("tableau")!.position;
    poseFigure(cut, facts, { place: [stage[0] - 1.2, 0, stage[2] + 1.0], facing: [1, 0, 0], knobs: { "upperarmL.z": "-0.62", "upperarmR.z": "0.62" } });
    setParams(cut, "lens_dof", { focusDistance: 6.5, aperture: 0.2 });
  },
};

// ─────────────────────── backlit flares (the ring shot's void, lamp and ghosts) ───────────────────────

/** The ring shot's figure mark (ring.ts PLACE: the black void at x = −60). */
const VOID: V3 = [-60, 0, 0];

/**
 * Move the ring shot's hard lamp: its point light, its visible disc, the ghosts' source and the
 * haze's cone (aimed down the lens, as ring.ts aims it).
 */
function ringLamp(cut: Surgery, facts: OnNothingFacts, lamp: V3, lens: V3, look: { radiance?: number; size?: number; haze?: number; color?: V3 } = {}): void {
  setParams(cut, "lamp", { position: [...lamp] });
  setParams(cut, "lampDisc", { lamp: [...lamp], ...(look.radiance === undefined ? {} : { radiance: look.radiance }), ...(look.size === undefined ? {} : { size: look.size }) });
  setParams(cut, "ghosts", { lamp: [...lamp] });
  const d = [lens[0] - lamp[0], lens[1] - lamp[1], lens[2] - lamp[2]];
  const l = Math.hypot(d[0]!, d[1]!, d[2]!);
  const marker = {
    name: "lamp.back.lights",
    position: [...lamp] as [number, number, number],
    direction: [0, 0, 0] as [number, number, number],
    extras: { loom_light_kind: "back", loom_light_color: [...(look.color ?? [0.78, 0.9, 1.0])], loom_light_lumens: 9000, loom_light_cone_deg: 70, loom_light_dir: d.map((c) => c / l) },
  };
  setParams(cut, "haze", { source: hazeWgsl(hazeLights({ ...facts, markers: new Map([[marker.name, marker]]) }, ["back"])), ...(look.haze === undefined ? {} : { density: look.haze }) });
}

/**
 * Row 18, part a (0:17.39, 2 frames, 417–418): the BLOWN FLARE FRAME — a head in profile (facing
 * frame-left) with a hard lamp just behind it, the frame washed by one huge pale ghost disc
 * (centre ~0.6 W, radius ~0.9 H, its right rim cutting the frame at 0.82 W), a warm oval ghost
 * at the lamp (0.28 W), a cold teal ground at the right.
 */
TAKES[18] = {
  base: "ring",
  build: (cut, facts) => {
    poseFigure(cut, facts, {
      place: VOID,
      facing: [0, 0, 1],
      knobs: { "upperarmL.z": "-0.62", "upperarmR.z": "0.62", "neck.x": "-0.08", "head.x": "-0.05", "head.y": "0.1" },
    });
    // tele from the figure's right: the face looks frame-left
    const eye: V3 = [VOID[0] + 1.05, 1.6, 0.12];
    const aim: V3 = [VOID[0], 1.63, 0.1];
    const fov = 17;
    setCamera(cut, { keys: [{ t: 0, eye, aim }, { t: 0.1, eye: [eye[0], eye[1] + 0.01, eye[2] - 0.01], aim }], fov, shake: 0.004, aimShake: 0.006, roll: 2, rollRate: -6 });
    // the lamp: just peeking past the back of the head (frame x ≈ 0.72), so the lens's mirror
    // ghost lands warm at 0.28 and the big centre ghost washes the whole face
    ringLamp(cut, facts, [VOID[0] - 3.15, 1.68, -0.62], eye, { radiance: 80, size: 0.2, haze: 0.06 });
    setParams(cut, "dof", { focusDistance: 1.05, aperture: 3.5 });
    // the veil: the ghosts at half again their ring-shot gain, the print pushed up
    // The reference's table: no big mirrored disc on the left (ghost 0 off); the one huge veil
    // sits right of centre (0.6 W, toward the source), filled, radius ~0.9 H; the warm oval at
    // the lamp's mirror point stays.
    setParams(cut, "ghosts", {
      gain: 0.45,
      ratio: [-1.9, 0.0, -1.0, 0.45],
      radius: [0.98, 0.78, 0.12, 0.05],
      rim: [0.022, 0.03, 0.03, 0.012],
      fill: [0.05, 0.35, 0.7, 0.5],
      strength: [0, 0.028, 0.05, 0],
    });
    setParams(cut, "optics", { bloom: 0.2, halo: 0 });
    setParams(cut, "grade", { exposure: 0.7, saturation: 0.7, keepWarm: 1 });
  },
};

/**
 * Row 46 (0:46.84, 15 frames, 1123–1137): a held MCU — the figure square to the lens, head bowed
 * in the beanie, both hands up at the temples, the chain on the chest; a cold teal backlight in
 * the haze just over the crown (sRGB ~140,175,180 there, ~40 at the frame's middle, blacks ~10);
 * one BIG thin warm ring round the frame (centre ~(0.49, 0.3), radius ~0.87 H, orange outermost)
 * and the arc of a second, lower one crossing the chest (y ~0.72–0.9).
 */
TAKES[46] = {
  base: "ring",
  build: (cut, facts) => {
    // both hands up at the temples, elbows out and forward, the head bowed into them
    const arms: Pose = {
      ...armPose(facts.bones, "L", { flex: 90, out: 15, elbow: 160, inward: 75, wrist: [0.3, 0, 0.1] }),
      ...armPose(facts.bones, "R", { flex: 90, out: 15, elbow: 160, inward: 75, wrist: [0.3, 0, -0.1] }),
    };
    const knobs: Record<string, string> = { "neck.x": "0.38 + 0.02 * sin(abstime * 3.3)", "head.x": "0.22", "chest.x": "0.08" };
    for (const [bone, v] of Object.entries(arms)) (["x", "y", "z"] as const).forEach((axis, i) => (knobs[`${bone}.${axis}`] = v[i]!.toFixed(4)));
    poseFigure(cut, facts, { place: VOID, facing: [0, 0, 1], knobs });
    // an MCU from 1.6 m, the figure left of centre (0.37 W), the crown at the frame's top edge
    const eye: V3 = [VOID[0] + 0.13, 1.45, 1.6];
    const aim: V3 = [VOID[0] + 0.13, 1.52, 0];
    const fov = 20;
    setCamera(cut, { keys: [{ t: 0, eye, aim }, { t: 0.63, eye: [eye[0] - 0.01, eye[1], eye[2] - 0.02], aim }], fov, shake: 0.003, aimShake: 0.006, roll: -1.2, rollRate: 0.8, rollWander: -0.3 });
    // the lamp behind the crown (just right of it, just above the frame): its glow in the teal
    // haze; the head hides its face; its ghosts are the rings
    ringLamp(cut, facts, [VOID[0] + 0.13, 2.27, -2.6], eye, { radiance: 60, size: 0.05, haze: 0.045, color: [0.55, 0.88, 0.98] });
    setParams(cut, "lamp", { color: [0.6, 0.9, 1, 1] });
    setParams(cut, "dof", { focusDistance: 1.6, aperture: 1.6 });
    // the big ring centred at (0.49, 0.3) and the lower arc crossing the chest: the lamp's ghosts (placed by eye against frame 1130)
    setParams(cut, "ghosts", {
      gain: 1,
      ratio: [-2.6, 0.5, -1.0, 0.45],
      radius: [0.84, 0.87, 0.075, 0.05],
      rim: [0.022, 0.018, 0.02, 0.012],
      fill: [0, 0, 0, 0],
      strength: [0.009, 0.011, 0, 0],
      tint: [1.3, 0.8, 0.55],
    });
    setParams(cut, "optics", { halo: 0 });
    setParams(cut, "grade", { exposure: 0.1, lift: 0.03, shadowTint: [0.88, 1.02, 1.1, 1], steel: [0.9, 1.02, 1.06], split: 0.6, saturation: 0.75, keepWarm: 1 });
  },
};

export const LIGHTS_TAKES: readonly number[] = Object.keys(TAKES).map(Number);

export function lightsDocument(facts: OnNothingFacts, options: LightsOptions, build: Build): ProjectDocument {
  const takeId = options.take ?? 28;
  const take = TAKES[takeId];
  if (take === undefined) throw new Error(`lights: no take ${takeId} (takes are EDL rows: ${LIGHTS_TAKES.join(", ")}).`);
  const base = build(facts, { ...options, shot: take.base, take: 0 });
  const cut = surgery(base);
  take.build(cut, facts, options);
  return finish(base, cut, `lights-${takeId}`);
}

// ───────────────────────── the tableau's glass, measured (row 17a) ─────────────────────────

/** The reach (frame heights) that just clears the frame's top edge from the tableau's lamps (they stand at ~0.78 H). */
export const TABLEAU_TOP = 0.85;

/**
 * Row 17a (0:15.39–16.52, 27 frames): how far the tableau's columns reach, frame by frame, as a
 * share of the way to the frame's top edge (the reference's lamps stand at 0.56 of the height).
 * Measured with the contiguous run of pixels over sRGB 70 above the lamp line: frames 0–1 are
 * the cut's flash (full height), frame 2 barely 0.18, then the glass shoots to the TOP by frame
 * 4, holds to 7, and retracts steadily to a quarter by frame 20, where it stays.
 */
export function tableauReach(top: number): string {
  const n = "floor(abstime * 24 + 0.001)";
  const rise = `clamp(0.18 + (${n} - 2) * 0.42, 0, 1)`;
  const fall = `(1 - 0.75 * clamp((${n} - 7) / 13, 0, 1))`;
  return `(${top} * max(clamp(2 - ${n}, 0, 1), min(${rise}, ${fall})))`;
}
