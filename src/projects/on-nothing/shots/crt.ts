import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { boneParam, yawFor } from "../skin-kernel.ts";
import { carAreas } from "../scene-facts.ts";
import { geometryName } from "../names.ts";
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
 * beams swell with brightness, interlaced in two fields that the shutter half-catches — the
 * stock CRT Tube node (T1423b), promoted from this file.
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
  addNode(cut, "footKey", "light", [-2600, 1300], { kind: "point", position: [place[0] + 0.1, 1.9, place[2] + 0.02], color: [1, 0.97, 0.92, 1], intensity: 6 }, { label: "light_footkey" });
  const shotNode = cut.nodes["shot"];
  if (shotNode === undefined) throw new Error('crtDocument: the base graph has no Render "shot".');
  // The cars stay out of the picture: in the negative their lamps would print as black holes.
  const cars = new Set(carAreas(facts).map(geometryName));
  const scenes = String(shotNode.parameters["scenes"]).split(" ").filter((label) => !cars.has(label));
  setParams(cut, "shot", { scenes: scenes.join(" "), lights: `${String(shotNode.parameters["lights"])} light_footkey` });
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
    roll: expressionSlot("sin(abstime * 0.7) * -1.5", 0),
  });
  // Video, not a lens: no depth of field in the picture, no streaks of its own.
  setParams(cut, "lens_dof", { aperture: 0.05 });
  setParams(cut, "optics", { streak: 0, halo: 0 });
  // The picture as broadcast: the skin a little under, so the tube prints it grey (the reference's median is 63 / 255).
  setParams(cut, "grade", { exposure: 0 });

  // ── Hold at 12 pictures a second, then photograph the tube ──
  const last = feederOf(cut, "out");
  addNode(cut, "hold", "customWgslMulti", [500, 0], { source: HOLD_WGSL, rate: 12 }, { label: "wgsl_hold" });
  addNode(cut, "holdHistory", "feedback", [500, 300], { source: "wgsl_hold" }, { label: "feedback_holdhistory" });
  spliceAfter(cut, last, "hold");
  connect(cut, ["holdHistory", "out"], ["hold", "more"], 0);
  const tubeCam = ease(0, CRT_SECONDS);
  // the stock CRT Tube (T1423b, promoted from this file): the tube photographed by a macro lens
  addNode(cut, "tube", "crtTube", [700, 0], {
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
    roll: expressionSlot(`2.5 - 3.5 * ${tubeCam}`, 0),
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
  }, { label: "crttube1" });
  spliceAfter(cut, "hold", "tube");
  return finish(base, cut, "crt");
}
