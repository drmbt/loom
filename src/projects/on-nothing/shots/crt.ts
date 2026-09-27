import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { boneParam, yawFor } from "../skin-kernel.ts";
import { carAreas } from "../scene-facts.ts";
import { ease, type Build, type ShotOptions } from "./halo.ts";
import { addNode, connect, dropParams, feederOf, finish, setParams, spliceAfter, surgery } from "./splice.ts";

/**
 * T1407b (crt) — THE CRT RE-SCAN MACRO, the reference's 0:51.42–0:52.29 (22 frames).
 *
 * What the reference frames measure (ref.mp4 frames 1233–1254, 1920×818):
 * - the whole frame is the TUBE'S PICTURE, no bezel: a macro of a negative-looking torso
 *   (a pale band of rolled fabric across the top, grey skin, the hands black, a chain), soft
 *   and contrasty, as if cut from low-resolution video;
 * - a fine luminance GRID over everything: rows every 3.46 px at the top of the frame and
 *   3.28 px at the bottom (the scanlines, 818 / 3.4 ≈ 240 in frame: half the tube's 480, so
 *   the camera sees half the screen's height), columns every 6.1–6.2 px (the mask triads,
 *   ≈ 310 across the frame), modulation ≈ ±10 % (rows) and ±7 % (columns), the SAME phase in
 *   R, G and B (the camera resolves the triads as luminance, not colour);
 * - the row period shrinking down the frame is perspective: the camera looks down at the
 *   glass about 15–18° off its normal, so the frame's bottom is farther than its top — and the
 *   top of the frame falls out of focus first (a macro's thin depth of field on a curved tube);
 * - the picture on the tube updates on EVERY OTHER frame (phase correlation 0.5–0.7 between
 *   frame pairs, ~0.1 across): 12 pictures a second;
 * - levels: luma p1 ≈ 10, p50 60–100, p99 ≈ 210 / 255 — no pure black, no clipped white —
 *   and a cool cast (mean rgb 84, 89, 95).
 *
 * The method is the reference's: a picture is rendered (the tableau's set, re-aimed on the
 * figure's torso), held at 12 fps, and PHOTOGRAPHED ON A MODELLED TUBE. The tube pass is a ray
 * tracer: a thin-lens macro camera (aperture samples → real depth of field) looks through a
 * curved glass faceplate (refracted, with a Fresnel reflection of the room) onto a curved
 * phosphor surface carrying an aperture grille of R, G, B stripes, lit by scanlines whose
 * beams swell with brightness, interlaced in two fields that the shutter half-catches.
 */

const INPUT = `${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
`;

/** The shot's 22 frames at 23.976 fps. */
export const CRT_SECONDS = 22 / 23.976;

/**
 * SAMPLE AND HOLD: the picture changes only when `rate` ticks over (12 a second); between
 * ticks this pass returns its own previous output. Input = picture, More = [its own history].
 */
export const HOLD_WGSL = `struct Params {
  rate: f32, // @default 12  Pictures a second.
};
${INPUT}@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let now = floor(frameU.absTime * params.rate + 1e-3);
  let before = floor((frameU.absTime - frameU.deltaTime) * params.rate + 1e-3);
  if (now == before && frameU.absFrame > 0.5) {
    return textureSampleLevel(inputTexture1, inputSampler, uv, 0.0);
  }
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
}`;

/**
 * THE TUBE, PHOTOGRAPHED. Input: the held picture (linear display light, as the grade hands
 * it on). Output: the macro camera's finished frame (linear display light for the Output).
 * Units are millimetres; the tube is a 4:3 face `tubeSize` wide, its phosphor on a sphere of
 * radius `curvature` (apex at z = 0, +z toward the camera), behind `glass` of faceplate.
 */
export const TUBE_WGSL = `struct Params {
  tubeSize: vec2f, // @default 400  Visible face, width × height, mm.
  curvature: f32, // @default 1100  Radius of the phosphor (and faceplate) sphere, mm.
  glass: f32, // @default 12  Faceplate thickness, mm.
  lines: f32, // @default 480  Visible scanlines.
  triads: f32, // @default 350  RGB triads across the face.
  aim: vec2f, // @default 0.5  Where the camera looks on the face (u, v; v down).
  distance: f32, // @default 350  Lens to target, mm.
  pitch: f32, // @default 15  Camera above the face's normal, degrees (it looks down at the glass).
  yaw: f32, // @default 0  Camera to the side of the normal, degrees.
  roll: f32, // @default 0  Camera roll, degrees.
  fov: f32, // @default 24  Vertical field of view, degrees.
  aperture: f32, // @default 6  Lens aperture radius, mm (depth of field).
  focus: f32, // @default 0  Focus offset beyond the target, mm.
  beamDark: f32, // @default 0.15  Beam sigma of a dark line, in line pitches.
  beamBright: f32, // @default 0.27  Beam sigma of a bright line (a bright line swells).
  grille: f32, // @default 0.75  Share of a triad's third each phosphor stripe fills.
  field: f32, // @default 0.55  Brightness of the field NOT being scanned now (phosphor persistence).
  halation: f32, // @default 0.12  Light scattered in the faceplate (phosphor bloom).
  invert: f32, // @default 1  1 shows the picture as a negative.
  contrast: f32, // @default 1.6  Contrast of the picture on the tube.
  pivot: f32, // @default 0.5  Level of the (inverted) picture that lands on mid-grey.
  unlit: f32, // @default 0.02  The unlit phosphor's glow (the tube is never black).
  reflection: f32, // @default 0.5  Room reflected in the faceplate (× Fresnel).
  exposure: f32, // @default 0.35  Camera exposure (linear gain before the shoulder; low, so a lit phosphor never clips).
  gain: f32, // @default 1.3  Display gain after the shoulder.
  lift: f32, // @default 0.035  Display-level black lift.
  tint: vec3f, // @default 1  Camera's colour cast.
  saturation: f32, // @default 0.35  Chroma kept.
  grain: f32, // @default 0.02  Grain.
};
${INPUT}
const SAMPLES: i32 = 16;
const PI: f32 = 3.14159265;

fn hash(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

/** Nearest positive hit of a ray with a sphere centred on (0, 0, -R); -1 if none. */
fn sphere(o: vec3f, d: vec3f, r: f32, far: bool) -> f32 {
  let c = vec3f(0.0, 0.0, -params.curvature);
  let oc = o - c;
  let b = dot(oc, d);
  let h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) { return -1.0; }
  let s = sqrt(h);
  return select(-b - s, -b + s, far);
}

/** A point on the phosphor for face coordinates (u, v). */
fn facePoint(uv: vec2f) -> vec3f {
  let x = (uv.x - 0.5) * params.tubeSize.x;
  let y = (0.5 - uv.y) * params.tubeSize.y;
  let r = params.curvature;
  return vec3f(x, y, sqrt(max(r * r - x * x - y * y, 0.0)) - r);
}

/** The picture as the tube shows it: negative, contrasty, on the face's 4:3 (cropped from the source). */
fn picture(uv: vec2f) -> vec3f {
  let size = vec2f(textureDimensions(inputTexture));
  let crop = (4.0 / 3.0) / (size.x / size.y);
  let at = vec2f(0.5 + (uv.x - 0.5) * crop, uv.y);
  var c = pow(max(textureSampleLevel(inputTexture, inputSampler, at, 0.0).rgb, vec3f(0.0)), vec3f(1.0 / 2.2));
  c = mix(c, 1.0 - c, params.invert);
  c = clamp((c - params.pivot) * params.contrast + 0.5, vec3f(0.0), vec3f(1.0));
  return pow(c, vec3f(2.2));
}

/** Light leaving the phosphor at face coordinates uv (scanlines, fields, grille). */
fn phosphor(uv: vec2f, fieldNow: f32) -> vec3f {
  let lineF = uv.y * params.lines;
  let line = floor(lineF);
  let du = 0.8 / (params.triads * 3.0);
  var light = vec3f(0.0);
  for (var k = -1; k <= 1; k = k + 1) {
    let ln = line + f32(k);
    let yc = (ln + 0.5) / params.lines;
    // the video's limited bandwidth: a short horizontal smear along the line
    let c = (picture(vec2f(uv.x - du, yc)) + picture(vec2f(uv.x, yc)) * 2.0 + picture(vec2f(uv.x + du, yc))) * 0.25;
    let peak = max(c.r, max(c.g, c.b));
    let sigma = mix(params.beamDark, params.beamBright, sqrt(clamp(peak, 0.0, 1.0)));
    let y = lineF - (ln + 0.5);
    let fieldW = select(params.field, 1.0, (i32(ln) & 1) == i32(fieldNow));
    light = light + c * exp(-(y * y) / (2.0 * sigma * sigma)) / (sigma * 2.5066) * fieldW;
  }
  // aperture grille: three phosphor stripes a triad, each lit only in its own colour
  let t = fract(uv.x * params.triads) * 3.0;
  let stripe = floor(t);
  let across = (fract(t) - 0.5) / max(params.grille, 0.05);
  let fill = smoothstep(0.5, 0.35, abs(across));
  var mask = vec3f(0.0);
  mask[i32(stripe)] = fill * 3.0 / max(params.grille, 0.05);
  // the halation: the glass scatters a little of the picture around each point
  let halo = picture(uv + vec2f(0.004, 0.0)) + picture(uv - vec2f(0.004, 0.0)) + picture(uv + vec2f(0.0, 0.005)) + picture(uv - vec2f(0.0, 0.005));
  return light * mask + halo * 0.25 * params.halation + vec3f(params.unlit);
}

/** The room in the faceplate: a dark studio, one soft window high on the left. */
fn room(d: vec3f) -> vec3f {
  let win = exp(-pow(length(d - normalize(vec3f(-0.5, 0.6, 0.6))) / 0.35, 2.0));
  return vec3f(0.004, 0.005, 0.006) + vec3f(0.25, 0.27, 0.3) * win;
}

fn rotate(v: vec3f, axis: vec3f, angle: f32) -> vec3f {
  return v * cos(angle) + cross(axis, v) * sin(angle) + axis * dot(axis, v) * (1.0 - cos(angle));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = frameU.resolution;
  let aspect = size.x / max(size.y, 1.0);
  // The camera: back from the target along the face's normal, swung up by pitch and aside by yaw.
  let aimAt = facePoint(params.aim);
  let normal = normalize(aimAt - vec3f(0.0, 0.0, -params.curvature));
  var back = rotate(normal, vec3f(1.0, 0.0, 0.0), -radians(params.pitch));
  back = rotate(back, vec3f(0.0, 1.0, 0.0), radians(params.yaw));
  let eye = aimAt + back * params.distance;
  let forward = -back;
  var up = normalize(vec3f(0.0, 1.0, 0.0) - forward * forward.y);
  up = rotate(up, forward, radians(params.roll));
  let right = normalize(cross(forward, up));
  let tanHalf = tan(radians(params.fov) * 0.5);
  let focal = params.distance + params.focus;
  let fieldNow = floor(frameU.absTime * 59.94) % 2.0;

  var sum = vec3f(0.0);
  let seed = vec3f(uv * size, frameU.absFrame);
  for (var s = 0; s < SAMPLES; s = s + 1) {
    let j = vec2f(hash(seed + f32(s) * 1.7), hash(seed + f32(s) * 3.1 + 11.0)) - 0.5;
    let p = uv + j / size;
    let ndc = vec2f(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0);
    let dir = normalize(forward + right * ndc.x * tanHalf * aspect + up * ndc.y * tanHalf);
    // thin lens: a point on the aperture, aimed through the plane of focus
    let a = (f32(s) + hash(seed + 5.0)) * 2.39996323;
    let rr = sqrt((f32(s) + 0.5) / f32(SAMPLES)) * params.aperture;
    let lens = eye + (right * cos(a) + up * sin(a)) * rr;
    let inFocus = eye + dir * (focal / dot(dir, forward));
    let ray = normalize(inFocus - lens);
    // the faceplate: refract in, then find the phosphor behind it
    let t1 = sphere(lens, ray, params.curvature + params.glass, false);
    if (t1 < 0.0) { continue; }
    let p1 = lens + ray * t1;
    let n1 = normalize(p1 - vec3f(0.0, 0.0, -params.curvature));
    let inside = refract(ray, n1, 1.0 / 1.52);
    let t2 = sphere(p1, inside, params.curvature, false);
    if (t2 < 0.0) { continue; }
    let p2 = p1 + inside * t2;
    let face = vec2f(p2.x / params.tubeSize.x + 0.5, 0.5 - p2.y / params.tubeSize.y);
    var light = vec3f(0.0);
    if (all(face >= vec2f(0.0)) && all(face <= vec2f(1.0))) { light = phosphor(face, fieldNow); }
    let cosi = clamp(dot(-ray, n1), 0.0, 1.0);
    let fresnel = 0.04 + 0.96 * pow(1.0 - cosi, 5.0);
    sum = sum + light * (1.0 - fresnel) + room(reflect(ray, n1)) * fresnel * params.reflection;
  }
  var c = sum / f32(SAMPLES);
  // the camera's grade: a soft shoulder, a cool cast, little chroma, blacks lifted, grain
  c = c * params.exposure / (vec3f(1.0) + c * params.exposure * 0.25);
  c = pow(c, vec3f(1.0 / 2.2)) * params.tint * params.gain;
  let y = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  c = mix(vec3f(y), c, params.saturation);
  c = c + vec3f(params.lift) * (1.0 - c);
  let n = hash(vec3f(floor(uv * size / 1.3), frameU.absFrame * 1.7)) + hash(vec3f(floor(uv * size / 1.3) + 17.0, frameU.absFrame)) - 1.0;
  c = clamp(c + vec3f(n) * params.grain * (0.4 + 0.6 * (1.0 - y)), vec3f(0.0), vec3f(1.0));
  return vec4f(pow(c, vec3f(2.2)), 1.0);
}`;

/** The figure on the tube: hands working at the waistband, 12 poses a second. */
function footagePose(): Record<string, string> {
  return {
    // arms down to the sides, elbows bent forward, the hands meeting at the belly
    "upperarmL.z": "-0.45",
    "upperarmR.z": "0.45",
    "upperarmL.x": "-0.2",
    "upperarmR.x": "-0.25",
    "forearmL.x": `-0.15 - 0.1 * sin(abstime * 7.0)`,
    "forearmR.x": `-0.2 - 0.1 * sin(abstime * 6.0 + 1.3)`,
    "forearmL.y": "-1.05",
    "forearmR.y": "1.05",
    "handL.x": "0.4",
    "handR.x": "0.45",
    "chest.x": "0.08",
    "neck.x": "0.25",
    "pelvis.y": `0.1 * sin(abstime * 2.0)`,
  };
}


export function crtDocument(facts: OnNothingFacts, options: ShotOptions, build: Build): ProjectDocument {
  // The picture on the tube: rendered small (standard definition), as the video it stands for.
  const base = build(facts, { ...options, shot: "tableau" });
  const cut = surgery(base);

  // ── The footage: the bare-chested figure, facing its camera, hands at the waistband ──
  const stage = facts.stages.get("tableau");
  if (stage === undefined) throw new Error("crtDocument: the GLB has no stage.tableau.");
  const place: [number, number, number] = [stage.position[0], stage.position[1], stage.position[2]];
  const pose: Record<string, StoredParameter> = { yaw: yawFor([0.2, 0, 1]), place };
  for (const bone of facts.bones) pose[boneParam(bone)] = [0, 0, 0];
  const known = new Set(facts.bones.map(boneParam));
  for (const [key, value] of Object.entries(footagePose())) {
    const [bone] = key.split(".");
    if (bone === undefined || !known.has(bone)) throw new Error(`crtDocument: no bone "${bone}".`);
    pose[key] = expressionSlot(value, 0);
  }
  const skin = cut.nodes["skin"];
  if (skin === undefined) throw new Error("crtDocument: the base graph has no skin.");
  dropParams(cut, "skin", Object.keys(skin.parameters).filter((key) => key.includes(".")));
  setParams(cut, "skin", pose);
  // A hard top light: it grazes down the belly (the form reads in greys) and leaves the hands, turned to the lens, in their own shadow.
  addNode(cut, "footKey", "light", [-2600, 1300], { kind: "point", position: [place[0] + 0.1, 1.9, place[2] + 0.02], color: [1, 0.97, 0.92, 1], intensity: 6 }, { label: "footkey1" });
  const shotNode = cut.nodes["shot"];
  if (shotNode === undefined) throw new Error('crtDocument: the base graph has no Render "shot".');
  // The cars stay out of the picture: in the negative their lamps would print as black holes.
  const cars = new Set(carAreas(facts).map((area) => `geo${area}1`));
  const scenes = String(shotNode.parameters["scenes"]).split(" ").filter((label) => !cars.has(label));
  setParams(cut, "shot", { scenes: scenes.join(" "), lights: `${String(shotNode.parameters["lights"])} footkey1` });
  // The footage camera: tight on the belly and the hands (the torso fills the tube's width), a hand-held video camera's drift.
  const eye: [number, number, number] = [place[0] + 0.06, 1.18, place[2] + 1.25];
  const aim: [number, number, number] = [place[0], 1.06, place[2]];
  setParams(cut, "cam", {
    eye,
    lookAt: aim,
    fov: 28,
    "eye.x": expressionSlot(`${eye[0]} + sin(abstime * 1.3) * 0.01`, eye[0]),
    "eye.y": expressionSlot(`${eye[1]} + sin(abstime * 1.7 + 1) * 0.008`, eye[1]),
    "eye.z": expressionSlot(`${eye[2]}`, eye[2]),
    "lookAt.x": expressionSlot(`${aim[0]} + sin(abstime * 0.9) * 0.015`, aim[0]),
    "lookAt.y": expressionSlot(`${aim[1]}`, aim[1]),
    "lookAt.z": expressionSlot(`${aim[2]}`, aim[2]),
    roll: expressionSlot("sin(abstime * 0.7) * 1.5", 0),
  });
  // Video, not a lens: no depth of field in the picture, no streaks of its own.
  setParams(cut, "lens_dof", { aperture: 0.05 });
  setParams(cut, "optics", { streak: 0, halo: 0 });
  // The picture as broadcast: the skin a little under, so the tube prints it grey (the reference's median is 63 / 255).
  setParams(cut, "grade", { exposure: 0 });

  // ── Hold at 12 pictures a second, then photograph the tube ──
  const last = feederOf(cut, "out");
  addNode(cut, "hold", "customWgslMulti", [500, 0], { source: HOLD_WGSL, rate: 12 }, { label: "hold1" });
  addNode(cut, "holdHistory", "feedback", [500, 300], { source: "hold1" }, { label: "holdhistory1" });
  spliceAfter(cut, last, "hold");
  connect(cut, ["holdHistory", "out"], ["hold", "more"], 0);
  const tubeCam = ease(0, CRT_SECONDS);
  addNode(cut, "tube", "customWgsl", [700, 0], {
    source: TUBE_WGSL,
    tubeSize: [400, 300],
    curvature: 1100,
    glass: 12,
    lines: 480,
    triads: 350,
    // the macro drifts: a slow push in, the horizon turning one way, the aim wandering down the torso
    aim: [0.47, 0.4],
    "aim.x": expressionSlot(`0.47 + 0.02 * ${tubeCam}`, 0.47),
    "aim.y": expressionSlot(`0.4 + 0.03 * ${tubeCam}`, 0.4),
    distance: expressionSlot(`360 - 30 * ${tubeCam}`, 360),
    pitch: 16,
    yaw: -4,
    roll: expressionSlot(`-2.5 + 3.5 * ${tubeCam}`, 0),
    fov: 24,
    aperture: 3.5,
    focus: 0,
    beamDark: 0.12,
    beamBright: 0.2,
    grille: 0.95,
    field: 0.88,
    halation: 0.12,
    invert: 1,
    contrast: 1.8,
    // shown as a NEGATIVE (the reference's pale cloth and black hands): the lit hands print black, the shadowed belly grey, the black cloth pale
    pivot: 0.8,
    unlit: 0.005,
    reflection: 0.5,
    exposure: 1.0,
    gain: 0.9,
    lift: 0.0,
    tint: [0.93, 0.98, 1.05, 1],
    saturation: 0.35,
    grain: 0.02,
  }, { label: "tube1" });
  spliceAfter(cut, "hold", "tube");
  return finish(base, cut, "crt");
}
