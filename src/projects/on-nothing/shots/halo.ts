import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
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
 * The flare is MEASURED, not keyed: a two-stage reduction finds the on-axis bright energy
 * and its centroid each frame (so the figure occluding the lamp dims the flare, as in the
 * reference), and one analytic pass draws the veil, the dispersed ring and the ghosts from it.
 */

const INPUT = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
`;

/** Blocks of the first reduction stage (its fixed resolution). */
const GATHER = [60, 26] as const;

/**
 * Stage 1: each texel of a 60×26 target sums an 8×8 grid of the scene over its block, bright-
 * passed and weighted by how near the optical axis it sits. Means, not sums: the target is
 * half-float and a lamp is hundreds in radiance.
 */
export const FLARE_GATHER_WGSL = `struct Params {
  threshold: f32, // @default 6  Radiance where a pixel starts to count as a flare source.
  axis: f32, // @default 0.35  On-axis window (fraction of the frame height): sources further from the centre flare less.
};
${INPUT}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let block = vec2f(1.0 / ${GATHER[0]}.0, 1.0 / ${GATHER[1]}.0);
  var sum = vec3f(0.0);
  for (var j = 0; j < 8; j = j + 1) {
    for (var i = 0; i < 8; i = i + 1) {
      let p = uv + ((vec2f(f32(i), f32(j)) + 0.5) / 8.0 - 0.5) * block;
      let c = textureSampleLevel(inputTexture, inputSampler, p, 0.0).rgb;
      let peak = max(c.r, max(c.g, c.b));
      let over = max(peak - params.threshold, 0.0) / max(peak, 1e-4);
      let q = (p - vec2f(0.5)) * vec2f(aspect, 1.0);
      let onAxis = exp(-dot(q, q) / (2.0 * params.axis * params.axis));
      sum = sum + c * over * onAxis;
    }
  }
  return vec4f(sum / 64.0, 1.0);
}`;

/**
 * Stage 2 (a 2×1 target): texel 0 = the flare source's centroid (uv) and its mean energy;
 * texel 1 = its mean colour (energy per channel).
 */
export const FLARE_SOURCE_WGSL = `struct Params {
  unused: f32, // @default 0  (no parameters)
};
${INPUT}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var rgb = vec3f(0.0);
  var at = vec2f(0.0);
  var total = 0.0;
  for (var j = 0; j < ${GATHER[1]}; j = j + 1) {
    for (var i = 0; i < ${GATHER[0]}; i = i + 1) {
      let c = textureLoad(inputTexture, vec2i(i, j), 0).rgb;
      let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
      rgb = rgb + c;
      at = at + l * (vec2f(f32(i), f32(j)) + 0.5) / vec2f(${GATHER[0]}.0, ${GATHER[1]}.0);
      total = total + l;
    }
  }
  let n = f32(${GATHER[0] * GATHER[1]});
  if (uv.x > 0.5) { return vec4f(rgb / n, 1.0); }
  let centre = select(vec2f(0.5), at / max(total, 1e-6), total > 1e-6);
  return vec4f(centre, total / n, 1.0);
}`;

/**
 * The flare itself, added onto the picture (linear HDR, before the lens): every term scales
 * with the measured on-axis energy, so it breathes with the occlusion. Input = picture,
 * More = [the 2×1 source]. Distances in frame heights, centred on the source.
 */
export const FLARE_WGSL = `struct Params {
  gain: f32, // @default 1  Overall flare strength per unit of measured energy.
  veil: f32, // @default 0.35  The flat veiling glare filling the ring.
  core: f32, // @default 1  The soft glow round the source.
  coreRadius: f32, // @default 0.16  Its 1/e radius.
  radius: f32, // @default 0.8  Ring radius.
  width: f32, // @default 0.018  Ring thickness (sigma).
  dispersion: f32, // @default 0.035  Red-to-blue radius split, fraction of the radius (red outermost).
  ring: f32, // @default 0.25  Ring strength.
  ringSaturation: f32, // @default 0.7  How much of the dispersion's colour the ring keeps.
  glow: f32, // @default 0.2  A wide soft glow round the source (reaching toward the ring).
  ringFacing: f32, // @default 0.6  How much stronger the ring is toward ringAngle than opposite it (0 = even).
  ringAngle: f32, // @default 0.5  Direction the ring is strongest, radians (0 = right, positive = down).
  ghost: f32, // @default 0.2  Peach ghost strength.
  ghostAt: vec2f, // @default 0.2  Peach ghost offset from the source (frame heights, +y down).
  ghostRadius: f32, // @default 0.3  Peach ghost radius.
  dot: f32, // @default 0.4  Small red ring ghost strength.
  dotAt: vec2f, // @default 0.7  Its offset from the source.
  dotRadius: f32, // @default 0.027  Its radius.
  tint: vec3f, // @default 1  Flare colour (multiplies the source's own).
  veilTint: vec3f, // @default 1  Colour of the veil (the glare inside the ring reads cooler than the core).
};
${INPUT}@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

fn band(d: f32, r: f32, w: f32) -> f32 {
  let x = (d - r) / w;
  return exp(-0.5 * x * x);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let size = vec2f(textureDimensions(inputTexture));
  let aspect = size.x / size.y;
  let src = textureLoad(inputTexture1, vec2i(0, 0), 0);
  let energy = src.z * params.gain;
  if (energy <= 1e-5) { return base; }
  let hue = textureLoad(inputTexture1, vec2i(1, 0), 0).rgb / max(src.z, 1e-5);
  let colour = mix(vec3f(1.0), hue / max(max(hue.r, max(hue.g, hue.b)), 1e-4), 0.5) * params.tint;
  let p = (uv - src.xy) * vec2f(aspect, 1.0);
  let d = length(p);
  // The veil: a dome filling the ring, rolling off toward it; the core and a wide glow on top.
  let veil = params.veil * (1.0 - smoothstep(params.radius * 0.25, params.radius * 1.0, d));
  let core = params.core * exp(-d / params.coreRadius) + params.glow * exp(-d / (params.radius * 0.45));
  // The ring: each channel on its own radius, red outermost, warm; stronger toward ringAngle.
  let a = atan2(p.y, p.x);
  let facing = max(1.0 + params.ringFacing * cos(a - params.ringAngle), 0.0);
  let r = params.radius;
  var ring = vec3f(
    band(d, r * (1.0 + params.dispersion), params.width),
    band(d, r, params.width) * 0.62,
    band(d, r * (1.0 - params.dispersion), params.width) * 0.48,
  );
  ring = mix(vec3f(dot(ring, vec3f(0.2126, 0.7152, 0.0722))), ring, params.ringSaturation) * params.ring * facing;
  // Ghosts: a peach blob and a small red ring, riding with the source.
  let g = length(p - params.ghostAt);
  let ghost = vec3f(1.0, 0.72, 0.52) * params.ghost * (1.0 - smoothstep(params.ghostRadius * 0.35, params.ghostRadius, g));
  let k = length(p - params.dotAt);
  let dotRing = vec3f(1.0, 0.22, 0.16) * params.dot * (band(k, params.dotRadius, params.dotRadius * 0.22) + 0.35 * (1.0 - smoothstep(0.0, params.dotRadius, k)));
  let flare = (vec3f(veil) * params.veilTint + vec3f(core) * colour + ring * colour + ghost + dotRing) * energy;
  return vec4f(base.rgb + flare, base.a);
}`;

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
  addNode(cut, "flareGather", "customWgsl", [-1300, 700], { source: FLARE_GATHER_WGSL, threshold: 6, axis: 0.35 }, { label: "flaregather1", resolution: { mode: "fixed", width: GATHER[0], height: GATHER[1] } });
  addNode(cut, "flareSource", "customWgsl", [-1100, 700], { source: FLARE_SOURCE_WGSL }, { label: "flaresource1", resolution: { mode: "fixed", width: 2, height: 1 } });
  connect(cut, ["lens_dof", "out"], ["flareGather", "input"]);
  connect(cut, ["flareGather", "out"], ["flareSource", "input"]);
  addNode(cut, "flare", "customWgslMulti", [-400, 0], {
    source: FLARE_WGSL,
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
  connect(cut, ["flareSource", "out"], ["flare", "more"], 0);

  return finish(base, cut, "halo");
}
