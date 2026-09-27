import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { expressionSlot } from "../../../examples/documents/builders.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, DOF_WGSL, VIEW } from "../../furnace/screen-space.ts";
import { hazeLights, hazeWgsl } from "../atmosphere.ts";
import { CRT_WGSL, GRADE_WGSL, HALO_WGSL } from "../fx.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { SKIN_ATTRIBUTES, boneParam, skinKernel, yawFor } from "../skin-kernel.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { Chain, cameraParams, vec3 } from "./title-graph.ts";
import { handheld } from "./handheld.ts";
import { TITLE_LENS_WGSL } from "./title.ts";

/**
 * T1407b (ring) — THE RING, the reference's 0:01.6–0:02.3 (frames 39–56, the cut right after
 * the title): a close, low shot up at the figure, a hard white lamp straight behind the head —
 * its glare swallowing the crown — the silhouette edged by it, a blue-grey haze, and the lens's
 * GHOSTS: a huge ring (radius ~800 px at 1920) centred on the far side of the frame's centre
 * from the lamp (the lamp → centre line carried on 1.9 times as far again), a second big ring
 * round the centre, and a small warm disc at the lamp's mirror point. Measured on a high-pass of
 * frame 12 of that range (renders/on-nothing/agents/title/ holds the sheets).
 *
 * The figure stands in the black void the quad shot uses (x = -60), facing the lens, the near
 * hand raised to the face. Its own graph, like the title (document.ts dispatches to it).
 */

type V3 = readonly [number, number, number];

/** The void (the quad shot's stage) and the ring shot's figure, facing the lens (+Z). */
const PLACE: V3 = [-60, 0, 0];
const FACING: V3 = [0, 0, 1];
/** The camera: low, a metre and a quarter off the chest, looking up at the head. */
const EYE: V3 = [-60.03, 1.08, 0.95];
const AIM: V3 = [-60, 1.52, 0];
const FOV = 38;
/** The lamp's bright pass and the halo: a fixed size, whatever the frame's (2.35:1). */
const HOT_SIZE = [480, 204] as const;
/** The lamp: on the line from the lens past the crown, three metres behind. */
const LAMP: V3 = [-60.2, 3.8, -3.0];

/** The figure's pose: square to the lens, chin up a touch, the left hand raised to the mouth. */
const POSE: Record<string, string | number[]> = {
  upperarmR: [0, 0, 0.62],
  // (measured on this rig: x lifts the arm out to the side, y swings it forward). The old
  // pose twisted the upper arm 69 deg about its own axis, folding the elbow backward; this one
  // keeps the elbow down and the forearm up, the hand rising to face height beside the cheek.
  "upperarmL.x": "-0.3",
  "upperarmL.y": "0.6",
  "forearmL.x": "-2.1 - 0.12 * smoothstep(0, 0.7, abstime)",
  "forearmL.y": "0.5",
  "handL.x": "0.35",
  "neck.x": "0.16 + sin(abstime * 3.1) * 0.02",
  "head.x": "0.1",
  "head.y": "-0.12 + sin(abstime * 1.7) * 0.03",
  "chest.x": "0.04",
};

/**
 * LENS GHOSTS: the reflections between a lens's elements make copies of a bright source along
 * the line through the frame's centre, each at its own ratio `f` of the source's offset from
 * the centre (1 = on the source, -1 = mirrored). Each ghost is the aperture's out-of-focus
 * image: a disc with a brighter rim, its colours split. How bright they are follows how bright
 * the source still is where it stands in the frame (sampled from the bright pass), so a lamp the
 * head covers ghosts less. Input = the picture; More = [the bright pass].
 */
export const GHOSTS_WGSL = `struct Params {
${CAMERA_PARAMS}
  lamp: vec3f, // @default 0  The source's world position.
  gain: f32, // @default 1  Overall ghost brightness.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
// ratio f, radius (frame heights), rim width, fill, colour
const GHOSTS: u32 = 4u;
const G_RATIO = array<f32, 4>(-1.9, -0.1, -1.0, 0.45);
const G_RADIUS = array<f32, 4>(0.98, 0.9, 0.075, 0.05);
const G_RIM = array<f32, 4>(0.022, 0.012, 0.02, 0.012);
const G_FILL = array<f32, 4>(0.05, 0.0, 0.6, 0.5);
const G_COLOR = array<vec3f, 4>(vec3f(0.85, 0.9, 1.0), vec3f(0.7, 0.8, 0.95), vec3f(1.0, 0.55, 0.3), vec3f(0.6, 0.85, 1.0));
const G_GAIN = array<f32, 4>(0.2, 0.09, 0.07, 0.0);

fn ring(d: f32, radius: f32, rim: f32, fill: f32) -> f32 {
  let edge = exp(-pow((d - radius) / rim, 2.0));
  let disc = (1.0 - smoothstep(radius - rim, radius + rim * 0.5, d)) * fill;
  return edge + disc;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let v = makeView();
  let at = project(v, params.lamp);
  if (at.z <= 0.0) { return base; }
  // How much of the source still shows (the head eclipses most of it): the bright pass summed
  // over a patch round where it stands.
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  var seen = vec3f(0.0);
  for (var j = -3; j <= 3; j = j + 1) {
    for (var i = -3; i <= 3; i = i + 1) {
      let o = vec2f(f32(i) / aspect, f32(j)) * 0.012;
      seen = seen + textureSampleLevel(inputTexture1, inputSampler, clamp(at.xy + o, vec2f(0.0), vec2f(1.0)), 0.0).rgb;
    }
  }
  let power = dot(seen / 49.0, vec3f(0.2126, 0.7152, 0.0722));
  var add = vec3f(0.0);
  for (var g = 0u; g < GHOSTS; g = g + 1u) {
    let centre = vec2f(0.5) + (at.xy - vec2f(0.5)) * G_RATIO[g];
    let q = (uv - centre) * vec2f(aspect, 1.0);
    let d = length(q);
    // dispersion: red a little larger than blue
    let r = ring(d, G_RADIUS[g] * 1.012, G_RIM[g], G_FILL[g]);
    let gg = ring(d, G_RADIUS[g], G_RIM[g], G_FILL[g]);
    let b = ring(d, G_RADIUS[g] * 0.988, G_RIM[g], G_FILL[g]);
    add = add + vec3f(r, gg, b) * G_COLOR[g] * G_GAIN[g];
  }
  return vec4f(base.rgb + add * power * params.gain, base.a);
}`;

/**
 * The LAMP itself: a hard round source seen down the barrel, drawn where its world disc projects
 * and nothing nearer covers it (the head eclipses it). HDR radiance, so the bloom, the halo and
 * the ghosts take it from here. Input = the picture; More = [depth].
 */
export const LAMP_DISC_WGSL = `struct Params {
${CAMERA_PARAMS}
  lamp: vec3f, // @default 0  The source's world position.
  size: f32, // @default 0.12  Radius of the lamp's face, metres.
  radiance: f32, // @default 60  Its radiance.
  tint: vec3f, // @default 1  Its colour.
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let v = makeView();
  let ray = rayAt(v, uv);
  let toLamp = params.lamp - params.eye;
  let along = dot(toLamp, ray);
  if (along <= 0.0) { return base; }
  let miss = length(toLamp - ray * along);
  let face = 1.0 - smoothstep(params.size * 0.85, params.size, miss);
  if (face <= 0.0) { return base; }
  let z = viewDepth(uv);
  let lampZ = dot(toLamp, v.forward);
  if (z > 0.0 && z < lampZ) { return base; }
  return vec4f(base.rgb + params.tint * params.radiance * face, base.a);
}`;

export interface RingOptions {
  readonly width?: number;
  readonly height?: number;
  readonly crt?: boolean;
}

export function ringDocument(facts: OnNothingFacts, options: RingOptions): ProjectDocument {
  const chain = new Chain(["shot", "out"]);
  chain.add("surf", "materialWgsl", [-3000, -600], { model: "pbr", source: SURFACE_WGSL }, { label: "surf1" });

  // ── The figure, posed by the skin kernel ──
  const mesh = facts.areas.get("fig");
  if (mesh === undefined) throw new Error("ringDocument: no figure in the GLB.");
  const known = new Set(facts.bones.map(boneParam));
  const pose: Record<string, StoredParameter> = {};
  for (const [key, value] of Object.entries(POSE)) {
    if (Array.isArray(value)) {
      pose[key] = value;
      continue;
    }
    const [bone] = key.split(".");
    if (bone === undefined || !known.has(bone)) throw new Error(`ringDocument: no bone "${bone}".`);
    if (pose[bone] === undefined) pose[bone] = [0, 0, 0];
    pose[key] = expressionSlot(String(value), 0);
  }
  chain.add("fig", "meshFileIn", [-3600, 1200], { file: facts.glbUrl, select: mesh.select, vertices: mesh.vertices, triangles: mesh.triangles, parts: mesh.parts, joints: mesh.joints });
  chain.add("skin", "pointKernel", [-3300, 1200], { capacity: mesh.vertices, attributes: SKIN_ATTRIBUTES, kernel: skinKernel(facts), yaw: yawFor(FACING), place: vec3(PLACE), ...pose });
  chain.add("figGeo", "geometry", [-3000, 1200], { mode: "surface", material: "surf1" }, { label: "figgeo1" });
  chain.link(["fig", "out"], ["skin", "in"]);
  chain.link(["skin", "out"], ["figGeo", "points"]);

  // ── Light: the lamp behind the head (a point, for the rims it cuts), two grazing rims ──
  const lights: string[] = [];
  const point = (id: string, position: V3, color: readonly number[], intensity: number): void => {
    chain.add(id, "light", [-2600, 1800 + lights.length * 80], { kind: "point", position: vec3(position), color: [...color], intensity });
    lights.push(`${id.toLowerCase()}1`);
  };
  const cold = [0.82, 0.93, 1, 1];
  point("lamp", LAMP, cold, 40);
  point("rimL", [PLACE[0] - 0.45, 1.65, PLACE[2] - 0.5], cold, 0.8);
  point("rimR", [PLACE[0] + 0.45, 1.55, PLACE[2] - 0.5], cold, 0.6);

  // ── Camera and the Render ──
  const operator = handheld(EYE, AIM, { tiltIn: 2.2, tilt: -0.6, settle: 0.9, shake: 0.35, creep: 0.04 });
  chain.add("cam", "camera", [-2700, -900], { eye: vec3(EYE), lookAt: vec3(AIM), fov: FOV, near: 0.05, far: 200, ...operator }, { label: "cam1" });
  chain.add("shot", "render", [-2400, 0], {
    scenes: "figgeo1",
    camera: "cam1",
    lights: lights.join(" "),
    projectors: "",
    ambientColor: [1, 1, 1, 1],
    ambientIntensity: 0,
    background: [0, 0, 0, 1],
    antialias: "msaa",
    depthOutput: true,
    normalOutput: true,
    albedoOutput: true,
    environmentIntensity: 0,
  }, { label: "shot1" });

  const cam = cameraParams(EYE, AIM, FOV);
  const depth = ["shot", "depth"] as const;
  // The haze: the lamp as a cone aimed down the lens, blue-grey.
  const direction = [EYE[0] - LAMP[0], EYE[1] - LAMP[1], EYE[2] - LAMP[2]];
  const length = Math.hypot(...direction);
  const lampMarker = {
    name: "lamp.back.ring",
    position: LAMP as [number, number, number],
    direction: [0, 0, 0] as [number, number, number],
    extras: { loom_light_kind: "back", loom_light_color: [0.78, 0.9, 1.0], loom_light_lumens: 9000, loom_light_cone_deg: 70, loom_light_dir: direction.map((c) => c / length) },
  };
  chain.pass("haze", hazeWgsl(hazeLights({ ...facts, markers: new Map([[lampMarker.name, lampMarker]]) }, ["back"])), { ...cam, density: 0.03, ambient: [0.001, 0.0016, 0.002], anisotropy: 0.85, back: 1.5, core: 0.15 }, [depth], [-1900, 0]);
  chain.pass("lampDisc", LAMP_DISC_WGSL, { ...cam, lamp: vec3(LAMP), size: 0.16, radiance: 300, tint: [0.9, 0.96, 1, 1] }, [depth], [-1800, 0]);
  // The lamp as the lens's first element sees it — before the depth of field spreads it thin:
  // what the halo and the ghosts are made of.
  const lampLit = chain.last;
  chain.pass("dof", DOF_WGSL, { ...cam, focusDistance: 1.35, aperture: 2.2, maxRadius: 22 }, [depth], [-1700, 0]);

  // ── Optics: bloom, the halo round the lamp, the ghosts ──
  const scene = chain.last;
  const glow = chain.bloom(scene, 1.2, -1500);
  // The lamp's bright pass at a FIXED size, softened: the ring taps and the ghosts' brightness
  // probe sample it at fixed spacings in frame units, so it must not get sharper when the frame
  // is rendered larger. At a scale of the frame, render.ts --final (2x) halved the lamp's size
  // in texels against the ring's tap spacing — the rings broke into dots and the ghosts' probe
  // missed the eclipsed lamp between its taps (T1429b).
  chain.add("hot", "customWgsl", [-1300, 700], { source: HALO_BRIGHT, threshold: 30 }, { resolution: { mode: "fixed", width: HOT_SIZE[0], height: HOT_SIZE[1] } });
  chain.link(lampLit, ["hot", "input"]);
  chain.add("hotSoft", "blur", [-1200, 700], { size: 3, filter: "gaussian", extend: "zero" });
  chain.link(["hot", "out"], ["hotSoft", "input"]);
  chain.add("halo", "customWgsl", [-1100, 700], { source: HALO_WGSL, radius: 0.22, width: 0.08, dispersion: 0.04, axis: 0.9, gain: 0.03 }, { resolution: { mode: "fixed", width: HOT_SIZE[0], height: HOT_SIZE[1] } });
  chain.link(["hotSoft", "out"], ["halo", "input"]);
  chain.pass("optics", `struct Params {
  bloom: f32, // @default 0.3  Bloom glow added back.
  halo: f32, // @default 1  Halo ring added back.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let b = textureSampleLevel(inputTexture1, inputSampler, uv, 0.0).rgb;
  let h = textureSampleLevel(inputTexture2, inputSampler, uv, 0.0).rgb;
  return vec4f(base.rgb + b * params.bloom + h * params.halo, base.a);
}`, { bloom: 0.35, halo: 1 }, [glow, ["halo", "out"]], [-700, 0]);
  chain.pass("ghosts", GHOSTS_WGSL, { ...cam, lamp: vec3(LAMP), gain: 0.3 }, [["hotSoft", "out"]], [-500, 0]);
  chain.pass("lens", TITLE_LENS_WGSL, { k: 0.05, edgeBlur: 0.025, swirl: 0.8, aberration: 0.004, vignette: 0.7 }, [], [-300, 0]);
  chain.pass("grade", GRADE_WGSL, { exposure: 0.2, black: 0.035, contrast: 1.15, saturation: 0.55, keepWarm: 0.6, bleach: 0.2, steel: [0.94, 1.0, 1.05], shadowTint: [0.9, 1.0, 1.08, 1], split: 0.5, grain: 0.03 }, [], [-100, 0]);
  if (options.crt === true) chain.pass("crt", CRT_WGSL, { amount: 1 }, [], [500, 0]);
  chain.add("out", "output", [700, 0], { toneMap: "none" }, { label: "out1" });
  chain.link(chain.last, ["out", "input"]);
  return chain.document("ring", options.width ?? 1920, options.height ?? 818);
}

/** The halo's and ghosts' source: only what is far above white (the lamp's face). */
const HALO_BRIGHT = `struct Params {
  threshold: f32, // @default 6  Radiance where the lamp begins.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let c = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  let m = max(c.r, max(c.g, c.b));
  return vec4f(c * clamp((m - params.threshold) / max(m, 1e-4), 0.0, 1.0), 1.0);
}`;
