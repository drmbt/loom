import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { boneParam, yawFor } from "../skin-kernel.ts";
import { carAreas } from "../scene-facts.ts";
import { hazeLights, hazeWgsl } from "../atmosphere.ts";
import { DOF_WGSL } from "../../furnace/screen-space.ts";
import { addNode, connect, dropParams, finish, setParams, spliceAfter, surgery } from "./splice.ts";

/**
 * T1407b (halo) — THE ON-AXIS HALO FLARE, the reference's 0:40.08–0:40.79 (17 frames).
 *
 * What the reference frames measure (ref.mp4 frames 961–977 at 23.976 fps, 1920×818):
 * - a medium close-up; the figure in the black tee, turned three-quarters to frame-left, head
 *   down, one hand thrown up at the lens (huge, soft), the other raised behind the light;
 * - ONE hard source (a headlight) straight down the barrel, just right of the neck at
 *   (930, 470) — 0.075 H below the frame centre — and its two streak columns running up to
 *   the top edge;
 * - a thin RAINBOW RING centred on the source, radius 640–690 px (0.78–0.84 H), about 35 px
 *   thick, red OUTERMOST (peak rgb 81,65,58 over a 60 grey), strongest bottom-right, fading
 *   toward the upper left;
 * - a VEIL: inside the ring the frame reads ~2× brighter than outside (luma 55–100 vs 22–37);
 * - two GHOSTS: a peach blob (r ≈ 0.3 H) down-right of the source, and a small red ring
 *   (r ≈ 22 px) at (+587, +85) px from it;
 * - timing: the flare swells over ~4 frames and dies over ~9 as the figure's head slides
 *   over the source (mean luma 40 → 64 → 32). The camera barely moves (≤ 4 px a frame);
 *   blacks sit at 7–13 / 255, the right side cools to teal (21, 29, 35).
 *
 * Built on the tableau's set and chain (the same room, cars, haze, streaks, grade) and
 * re-aimed: a camera a metre in front of the figure looking back into car 0's left headlight.
 * The flare is the stock On-Axis Flare (T1423b, promoted from this file): MEASURED, not keyed —
 * a two-stage reduction finds the on-axis bright energy and its centroid each frame (so the
 * figure occluding the lamp dims the flare, as in the reference), and one analytic pass draws
 * the veil, the dispersed ring and the ghosts from it.
 */

/**
 * The furnace's bokeh gather, with the golden-angle spiral turned by a per-pixel, per-frame
 * hash: a fixed spiral of 48 taps draws a big circle of confusion as a ring of dots (a lamp's
 * bokeh reads as a sieve); a turning one is noise, which the sub-frames average away.
 */
function softDof(): string {
  const spiral = "    let radius = sqrt(f32(i) / f32(TAPS)) * coc;\n    let angle = f32(i) * 2.39996323;";
  const early = "  if (coc < 0.5) { return centre; }";
  const taps = "const TAPS: u32 = 48u;";
  for (const needle of [spiral, early, taps]) {
    if (!DOF_WGSL.includes(needle)) throw new Error(`softDof: the furnace DOF_WGSL no longer has "${needle.trim()}"; re-derive the soft variant.`);
  }
  return DOF_WGSL.replace(taps, `const TAPS: u32 = 96u;
fn dofHash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}`)
    .replace(early, `${early}
  let spin = dofHash(vec3f(uv * frameU.resolution, f32(frameU.absFrame))) * 6.2831853;
  let jitter = dofHash(vec3f(uv * frameU.resolution + 7.0, f32(frameU.absFrame) * 1.3));`)
    .replace(spiral, "    let radius = sqrt((f32(i) + jitter - 0.5) / f32(TAPS)) * coc;\n    let angle = f32(i) * 2.39996323 + spin;");
}
export const SOFT_DOF_WGSL = softDof();

/** The shot starts at the cut; its 17 frames are 0.71 s. */
export const HALO_SECONDS = 17 / 23.976;

/**
 * The performance, as expressions on the skin kernel's knobs (radians about the rest axes:
 * x = the figure's left, y = up, z = the way it faces; negative x swings a limb forward).
 * The figure faces the lens three-quarters to frame-left, head down; its right hand (frame
 * left) thrown up at the lens, its left hand up behind the light. Over the cut the whole
 * figure leans to frame-right, so its head slides over the lamp and the flare dies.
 */
/** An eased 0 → 1 of `abstime` from `a` to `b` s (the expression grammar has no smoothstep). */
export function ease(a: number, b: number): string {
  const x = `clamp((abstime - ${a}) / ${b - a}, 0, 1)`;
  return `(${x} ^ 2 * (3 - 2 * ${x}))`;
}

function halopose(): Record<string, string> {
  // 0 → 1 over the cut, eased: the lean that carries the head over the lamp
  const lean = ease(0.3, 1.1);
  return {
    // right arm (frame left): swung forward and up at the lens, forearm raised, palm out
    "upperarmR.x": "-1.3 - 0.06 * sin(abstime * 5.0)",
    "upperarmR.y": "0.9",
    "upperarmR.z": "-0.1",
    "forearmR.x": "-0.5 + 0.12 * sin(abstime * 6.0 + 1.0)",
    "handR.x": "1.0",
    // left arm (frame right): rising up past the lamp at the cut, then held high
    "upperarmL.x": "-0.35",
    "upperarmL.z": `0.85 + 0.7 * ${ease(0, 0.3)}`,
    "forearmL.z": "0.45",
    "forearmL.x": "-0.3",
    "handL.x": "-0.3",
    // head down and turned toward frame left
    "neck.x": "0.3",
    "neck.y": "-0.45",
    "head.x": "0.15",
    "head.y": "-0.15",
    // the lean toward frame right (the figure's left: negative z): the head half over the lamp at the
    // cut, clear of it by 0.12 s (the flare swells), then back over it (the flare dies)
    "spine.z": `0.05 - 0.075 * (1 - ${ease(0, 0.12)}) - 0.2 * ${lean}`,
    "chest.z": `-0.1 * ${lean}`,
  };
}

/** The base shot builder (document.ts onNothingDocument), passed in so the shots need not import it back. */
export type Build = (facts: OnNothingFacts, options: { shot: "tableau"; width?: number; height?: number; audio?: boolean; hdri?: boolean; crt?: boolean }) => ProjectDocument;

export interface ShotOptions {
  readonly width?: number;
  readonly height?: number;
  readonly audio?: boolean;
  readonly hdri?: boolean;
  readonly crt?: boolean;
}

export function haloDocument(facts: OnNothingFacts, options: ShotOptions, build: Build): ProjectDocument {
  const base = build(facts, { ...options, shot: "tableau" });
  const cut = surgery(base);

  // ── The figure: the black tee, facing the lens three-quarters to frame-left ──
  const tee = facts.areas.get("fig");
  if (tee === undefined) throw new Error("haloDocument: no figure (fig) in the GLB.");
  setParams(cut, "fig", { select: tee.select, vertices: tee.vertices, triangles: tee.triangles, parts: tee.parts, joints: tee.joints });
  const stage = facts.stages.get("tableau");
  if (stage === undefined) throw new Error("haloDocument: the GLB has no stage.tableau.");
  // Twice as far from the car as the tableau's mark (8 m, not 4): from a metre in front of the
  // figure the two headlights then close to a head's width apart — one peeks beside the neck,
  // its twin sits behind the head.
  const place: [number, number, number] = [stage.position[0], stage.position[1], stage.position[2] + 4.3];
  const facing: [number, number, number] = [-Math.sin(0.3), 0, Math.cos(0.3)];
  const pose: Record<string, StoredParameter> = { capacity: tee.vertices, yaw: yawFor(facing), place };
  for (const bone of facts.bones) pose[boneParam(bone)] = [0, 0, 0];
  const known = new Set(facts.bones.map(boneParam));
  for (const [key, value] of Object.entries(halopose())) {
    const [bone] = key.split(".");
    if (bone === undefined || !known.has(bone)) throw new Error(`haloDocument: no bone "${bone}".`);
    pose[key] = expressionSlot(value, 0);
  }
  // Drop every per-axis expression the tableau's performance set, then pose afresh.
  const skin = cut.nodes["skin"];
  if (skin === undefined) throw new Error("haloDocument: the base graph has no skin.");
  dropParams(cut, "skin", Object.keys(skin.parameters).filter((key) => key.includes(".")));
  setParams(cut, "skin", pose);

  // ── The set: car 0 alone behind the figure (the reference shows one lamp and dark haze) ──
  const drop = carAreas(facts).filter((area) => area !== "car0");
  const shotNode = cut.nodes["shot"];
  if (shotNode === undefined) throw new Error('haloDocument: the base graph has no Render "shot".');
  const scenes = String(shotNode.parameters["scenes"]).split(" ").filter((label) => !drop.some((area) => label === `geo${area}1`));
  // Lit from behind only: car 0's projector, a rim on the head and shoulders, the sodium practicals.
  addNode(cut, "rim", "light", [-2600, 1300], { kind: "point", position: [place[0] + 0.35, 1.85, place[2] - 0.9], color: [0.85, 0.95, 1, 1], intensity: 2.2 }, { label: "rimhalo1" });
  addNode(cut, "rimWarm", "light", [-2600, 1350], { kind: "point", position: [place[0] - 0.6, 1.5, place[2] - 0.7], color: [1, 0.62, 0.32, 1], intensity: 1.1 }, { label: "rimwarm1" });
  setParams(cut, "shot", { scenes: scenes.join(" "), projectors: "head01", lights: "rimhalo1 rimwarm1 sodiuma1 sodiumb1" });
  const oneCar: OnNothingFacts = { ...facts, markers: new Map([...facts.markers].filter(([name]) => !name.startsWith("lamp.head.") || name.startsWith("lamp.head.0"))) };
  setParams(cut, "haze", { source: hazeWgsl(hazeLights(oneCar, ["head"])), density: 0.05, ambient: [0.036, 0.09, 0.108] });

  // ── The camera: 1 m in front of the figure, looking back into car 0's left headlight ──
  const lamp = facts.markers.get("lamp.head.0l");
  if (lamp === undefined) throw new Error("haloDocument: no lamp.head.0l in the GLB.");
  const light = lamp.position;
  // The ray from the lamp past the neck, just above the shoulder, carried on toward the lens.
  const beside: [number, number, number] = [place[0] + 0.1, 1.5, place[2] + 0.05];
  const ray = [beside[0] - light[0], beside[1] - light[1], beside[2] - light[2]];
  const t = 1.0 / Math.hypot(ray[0]!, ray[1]!, ray[2]!);
  const eye: [number, number, number] = [beside[0] + ray[0]! * t, beside[1] + ray[1]! * t, beside[2] + ray[2]! * t];
  // The lamp sits 0.075 H below the frame centre: aim that far above it.
  const fov = 34;
  const toLamp = [light[0] - eye[0], light[1] - eye[1], light[2] - eye[2]];
  const span = Math.hypot(toLamp[0]!, toLamp[1]!, toLamp[2]!);
  const d = toLamp.map((v) => v / span);
  const upAlong = [-d[0]! * d[1]!, 1 - d[1]! * d[1]!, -d[2]! * d[1]!];
  const upLength = Math.hypot(upAlong[0]!, upAlong[1]!, upAlong[2]!);
  const lift = 0.15 * Math.tan((fov * Math.PI) / 360);
  const aim = [0, 1, 2].map((axis) => eye[axis]! + (d[axis]! + (upAlong[axis]! / upLength) * lift) * span) as [number, number, number];
  const wob = (a: number, b: number, phase: number) => `(sin(abstime * ${a} + ${phase}) * 0.6 + sin(abstime * ${b} + ${phase * 1.7}) * 0.4)`;
  setParams(cut, "cam", {
    eye,
    lookAt: aim,
    fov,
    "eye.x": expressionSlot(`${eye[0]} + ${wob(2.1, 5.3, 0.4)} * 0.004`, eye[0]),
    "eye.y": expressionSlot(`${eye[1]} + ${wob(1.7, 4.1, 1.3)} * 0.003`, eye[1]),
    "eye.z": expressionSlot(`${eye[2]} - abstime * 0.015`, eye[2]),
    "lookAt.x": expressionSlot(`${aim[0]} + ${wob(1.3, 3.7, 2.2)} * 0.02`, aim[0]),
    "lookAt.y": expressionSlot(`${aim[1]} + ${wob(1.1, 2.9, 0.7)} * 0.015`, aim[1]),
    "lookAt.z": expressionSlot(`${aim[2]}`, aim[2]),
    // the operator's horizon: a slow turn one way through the cut, plus a breath
    roll: expressionSlot(`-1.5 + abstime * 1.8 + ${wob(1.9, 4.7, 0.2)} * 0.3`, 0),
  });

  // ── Depth of field: focus on the neck; the thrown hand near the lens goes very soft ──
  const px = (options.width ?? 1920) / 1920;
  setParams(cut, "lens_dof", { source: SOFT_DOF_WGSL, focusDistance: 1.15, aperture: 3 * px, maxRadius: 40 * px });

  // ── Streaks: the lamp's columns run to the top edge; growing one way through the cut ──
  // (the base's three passes step reach/400, reach/60, reach/20 — document.ts)
  const reach = `(0.7 * (0.85 + 0.15 * clamp(abstime / ${HALO_SECONDS.toFixed(3)}, 0, 1)))`;
  // Only the lamp streaks and blooms: a chain glint at arm's length must not throw a column.
  // The lamp's column is as wide as its glow (≈ 90 px of 1920 in the reference).
  setParams(cut, "bright", { threshold: 4 });
  setParams(cut, "streak0", { spread: 0.009 });
  // The reference's blacks sit at 7–13 / 255 under the veil, never at zero.
  setParams(cut, "grade", { lift: 0.035, black: 0.02 });
  [400, 60, 20].forEach((div, index) => setParams(cut, `streak${index}`, { step: expressionSlot(`${reach} / ${div}`, 0.7 / div) }));

  // ── The flare: measured, then drawn (replaces the tableau's generic ring) ──
  setParams(cut, "optics", { halo: 0, bloom: 0.3 });
  addNode(cut, "flare", "flare", [-400, 0], {
    // measured on the lamp before the optics (the lens's depth of field, not its streaks)
    threshold: 6,
    axis: 0.35,
    gain: 12,
    veil: 0.5,
    core: 3,
    coreRadius: 0.07,
    radius: 0.8,
    width: 0.022,
    dispersion: 0.03,
    ring: 0.1,
    ringSaturation: 0.7,
    glow: 0.5,
    ringFacing: 0.8,
    ringAngle: 0.6,
    ghost: 0.6,
    ghostAt: [0.15, 0.12],
    ghostRadius: 0.18,
    dot: 0.25,
    dotAt: [0.72, 0.1],
    dotRadius: 0.027,
    tint: [1, 0.9, 0.8, 1],
    veilTint: [0.97, 0.98, 1.02, 1],
  }, { label: "flare1" });
  spliceAfter(cut, "optics", "flare");
  connect(cut, ["lens_dof", "out"], ["flare", "source"]);

  return finish(base, cut, "halo");
}
