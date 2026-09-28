import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import type { OnNothingFacts, PartFacts } from "../scene-facts.ts";
import { markerOf, wgslVec3 } from "../scene-facts.ts";
import { CAR_RIG_ATTRIBUTES } from "../car-rig.ts";
import { CRT_WGSL } from "../fx.ts";
import { boneParam, handPose } from "../skin-kernel.ts";
import { GLASS_COMPOSITE_WGSL, OCCLUDER_WGSL, SURFACE_WGSL } from "../surface.ts";
import { Plate, knob, vectorKnobs, wobble } from "./plate.ts";

/**
 * T1407b (incar) — THE IN-CAR ROWS (docs/on-nothing-shotlist-2026-09-27.md). Built: take 0, row
 * 36 (0:40.832-0:41.500, reference frames 979-994): through the windscreen, close on the figure
 * in the driver's seat in the black tee, a hand up at the wheel — a luminance NEGATIVE, blown, a
 * fine dot screen over it (the skin and the tee white, the lit cabin round him black), torn at
 * its first and last frames, then a glitch (a teal frame; the positive back, dark, the negative
 * holding only on the face) and the face big and tilted, smeared out. See row36Glitch.
 *
 * Take 1, row 45 (0:46.171-0:46.838, frames 1107-1122): through the open door, the figure
 * shirtless and slouched in the front seat, the near hand thrown at the lens pointing, the far
 * hand on the thigh, a passenger beyond with an arm out along the dash, the cabin's cyan strips;
 * out past the B-pillar on the left the room and the white cars' lamps, smeared up. The cabin is
 * moved in front of the car row for it, and the frame is MIRRORED (see MIRROR_X_WGSL).
 *
 * The set is the tableau's (the warehouse, the car row, their lamps, the haze, the streak glass,
 * the grade: document.ts) with the CABIN car added — the GLS with its interior kept, its driver's
 * door a rig part (shut here) and its window down (tools/blender/on-nothing/carint.py) — the
 * figure SEATED in it, and the cabin's panes drawn in their own Render and laid over the frame,
 * so the glass is seen through and mirrors the room. Rows 84, 85 and 91 (the window double
 * exposure, the rolling wide, the inverted close-up) are not built yet.
 */

type V3 = readonly [number, number, number];
type Builder = (facts: OnNothingFacts, options: { shot: "tableau" | "cyc"; width?: number; height?: number; hdri?: boolean; audio?: boolean; crt?: boolean }) => ProjectDocument;

export interface IncarOptions {
  readonly take?: number;
  readonly width?: number;
  readonly height?: number;
  readonly crt?: boolean;
  readonly audio?: boolean;
  readonly hdri?: boolean;
}

/** The cabin's measured facts (carint.py writes them on `stage.cabin`, glTF world metres). */
interface Cabin {
  /** The car's forward (unit, horizontal). */
  readonly forward: V3;
  /** The driver's seat: the cushion's top, front half; the backrest's face at the cushion's height + 0.35 m. */
  readonly seat: V3;
  readonly back: V3;
  readonly passengerSeat: V3;
  readonly wheel: V3;
  readonly windshield: V3;
  readonly dashTop: V3;
}

function v3(value: unknown, what: string): [number, number, number] {
  if (!Array.isArray(value) || value.length < 3 || !value.slice(0, 3).every((entry) => typeof entry === "number")) {
    throw new Error(`incar: stage.cabin carries no ${what} (rebuild the GLB with tools/blender/on-nothing/carint.py).`);
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

export function cabinFacts(facts: OnNothingFacts): Cabin {
  const marker = markerOf(facts, "stage.cabin");
  const x = marker.extras;
  return {
    forward: v3(x?.["loom_dir"], "loom_dir"),
    seat: v3(x?.["loom_seat_fl"], "loom_seat_fl"),
    back: v3(x?.["loom_back_fl"], "loom_back_fl"),
    passengerSeat: v3(x?.["loom_seat_fr"], "loom_seat_fr"),
    wheel: v3(x?.["loom_wheel"], "loom_wheel"),
    windshield: v3(x?.["loom_windshield"], "loom_windshield"),
    dashTop: v3(x?.["loom_dash_top"], "loom_dash_top"),
  };
}

const add = (a: V3, b: V3, k = 1): [number, number, number] => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];

/**
 * The frame in the car's own axes: `at(local)` maps (right, up, forward) metres from the driver's
 * hip to the world. The car faces +Z in these builds, but nothing below assumes it.
 */
function carFrame(cabin: Cabin, shift: V3 = [0, 0, 0]): { hip: V3; at: (local: V3) => [number, number, number] } {
  const f = cabin.forward;
  // the car's right (the driver's right) = forward × up
  const right: V3 = [-f[2], 0, f[0]];
  // The hip joint (the H-point): 11 cm above the cushion's top (the pelvis's own depth), 16 cm
  // ahead of the backrest's face.
  const hip: V3 = [cabin.back[0] + f[0] * 0.16 + shift[0], cabin.seat[1] + 0.11 + shift[1], cabin.back[2] + f[2] * 0.16 + shift[2]];
  const at = (local: V3): [number, number, number] => add(add(add(hip, right, local[0]), [0, 1, 0], local[1]), f, local[2]);
  return { hip, at };
}

/**
 * NEGATIVE: the graded picture turned over (display-referred), as rows 36 and 91 are — the skin
 * and the black tee white, the glare and the stones dark — blown (a gain before the flip lifts
 * the darks into the whites), tinted cold in the mids as the reference's, and a fine dot screen
 * over it (the re-filmed monitor's mask, ~4 px a dot at 1920).
 */
export const NEGATIVE_WGSL = `struct Params {
  amount: f32, // @default 1  0 = the positive, 1 = the negative.
  gain: f32, // @default 1  Gain on the positive's display values before the flip (above 1 sinks its brights into the negative's black).
  gamma: f32, // @default 1  Negative's gamma (above 1 deepens its blacks).
  tint: vec3f, // @default 1  The negative's colour (the reference's is cold, teal in the mids).
  dots: f32, // @default 0.12  Depth of the dot screen.
  pitch: f32, // @default 4  Dot pitch, pixels at 1920 wide.
  wipe: f32, // @default 0  The negative only right of this (uv x; 0 = the whole frame): the glitch's half-turned frames.
  soft: f32, // @default 0.08  The wipe's softness (uv).
  positive: f32, // @default 1  Gain on what stays positive (the glitch's dark frames).
  white: f32, // @default 1  The negative's white (the re-filmed monitor never reaches full white).
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  // the flip happens on the DISPLAY values (the frame is linear until the Output encodes it)
  let raw = pow(max(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb, vec3f(0.0)), vec3f(1.0 / 2.2));
  let c = clamp(raw * params.gain, vec3f(0.0), vec3f(1.0));
  let luma = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let flipped = pow(vec3f(1.0) - mix(c, vec3f(luma), 0.7), vec3f(params.gamma));
  let mids = 4.0 * luma * (1.0 - luma);
  let n = flipped * mix(vec3f(1.0), params.tint, mids) * params.white;
  let turned = params.amount * select(1.0, smoothstep(params.wipe - params.soft, params.wipe + params.soft, uv.x), params.wipe > 0.0);
  var out = mix(clamp(raw * params.positive, vec3f(0.0), vec3f(1.0)), n, turned);
  // the dot screen: a hexagonal grid of soft dots, in pixels of a 1920-wide frame
  let px = uv * frameU.resolution * (1920.0 / max(frameU.resolution.x, 1.0)) / params.pitch;
  let row = floor(px.y);
  let q = vec2f(fract(px.x + 0.5 * (row % 2.0)) - 0.5, fract(px.y) - 0.5);
  let dot = 1.0 - smoothstep(0.2, 0.5, length(q));
  out = out * (1.0 - params.dots + params.dots * dot * 1.4);
  return vec4f(pow(out, vec3f(2.2)), 1.0);
}`;

/**
 * MIRROR: the frame flipped left for right. Row 45's figure sits in the passenger's seat of a
 * car whose opening door is the driver's; the cabin's one rig door is the driver's, so the take
 * is shot from the driver's side and flipped (nothing in frame reads as handed: no text, no badge).
 */
export const MIRROR_X_WGSL = `struct Params {
  unused: f32, // @default 0  (none)
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, vec2f(1.0 - uv.x, uv.y), 0.0);
}`;

/**
 * TAPE TEAR: a band of lines torn sideways and smeared (a tracking error on the re-filmed tape,
 * as the first and last frames of row 36's negative and its glitch frame show), with an RGB
 * split over the frame and a tint. Display-referred, after the negative.
 */
export const TEAR_WGSL = `struct Params {
  amount: f32, // @default 0  The torn lines' largest sideways shift, fraction of the frame width.
  centre: f32, // @default 0.5  Where the torn band sits (uv y, 0 = the top).
  height: f32, // @default 0.2  The band's height (uv).
  smear: f32, // @default 0  Horizontal smear inside the band, fraction of the width.
  split: f32, // @default 0  RGB split over the whole frame, fraction of the width.
  teal: f32, // @default 0  How far the whole frame goes teal (the glitch frame).
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

fn tearHash(n: f32) -> f32 {
  return fract(sin(n * 12.9898 + 78.233) * 43758.5453);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let d = (uv.y - params.centre) / max(params.height * 0.5, 1e-4);
  let band = exp(-d * d * 2.0);
  let line = floor(uv.y * frameU.resolution.y * (818.0 / max(frameU.resolution.y, 1.0)) / 2.0);
  // one tear per output frame (24 fps), whatever the sub-frames
  let seed = floor(frameU.absTime * 24.0 + 0.02) % 997.0;
  let jag = (tearHash(line + seed * 37.0) - 0.5) * 0.5 + sin(uv.y * 47.0 + seed * 1.7) * 0.5 + sin(uv.y * 13.0 - seed) * 0.4;
  let shift = params.amount * band * jag;
  var acc = vec3f(0.0);
  for (var i = 0; i < 8; i = i + 1) {
    let o = shift - params.smear * band * f32(i) / 7.0;
    acc.r = acc.r + textureSampleLevel(inputTexture, inputSampler, vec2f(uv.x + o + params.split, uv.y), 0.0).r;
    acc.g = acc.g + textureSampleLevel(inputTexture, inputSampler, vec2f(uv.x + o, uv.y), 0.0).g;
    acc.b = acc.b + textureSampleLevel(inputTexture, inputSampler, vec2f(uv.x + o - params.split, uv.y), 0.0).b;
  }
  return vec4f(acc / 8.0 * mix(vec3f(1.0), vec3f(0.62, 0.95, 1.0), params.teal), 1.0);
}`;

/**
 * The CABIN'S DOOR: one Point Kernel over the cabin mesh that swings the driver's door part
 * (`cabin_door`, carint.py) about its hinge — a vertical axis through the part's pivot —
 * `open` radians outward (positions and normals). Every other part stands still.
 */
export function doorKernel(parts: readonly PartFacts[]): string {
  const door = parts.find((part) => part.name === "cabin_door");
  if (door === undefined) throw new Error("incar: the cabin has no cabin_door part (rebuild the GLB with carint.py).");
  return `// T1407b (incar) — the cabin's door (generated by src/projects/on-nothing/shots/incar.ts).
struct Params {
  open: f32, // @default 0  How far the driver's door stands open, radians.
};

const DOOR: u32 = ${door.index}u;
const HINGE: vec3f = ${wgslVec3(door.pivot)};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (u32(max(p.surface.w, 0.0) + 0.5) != DOOR) { return q; }
  // outward: the door's rear edge (behind the hinge, -Z) swings toward the car's left (+X)
  let a = -ctx.params.open;
  let r = mat3x3f(vec3f(cos(a), 0.0, -sin(a)), vec3f(0.0, 1.0, 0.0), vec3f(sin(a), 0.0, cos(a)));
  q.position = HINGE + r * (p.position - HINGE);
  q.normal = r * p.normal;
  return q;
}`;
}

/**
 * The CABIN'S SURFACE: the scene's (surface.ts) with the cabin's own classes (carint.py, 60-64)
 * given knobs — the leather's tone (the Maybach's is cream; the negative of row 36 needs the
 * cabin round the figure bright), the trim, the ambient strips' gain.
 */
function cabinSurface(): string {
  const params = "struct Params {\n";
  const fallback = "    default: {}";
  const jewel = "    case 35u: { return jewel(s, p, o); }";
  for (const needle of [params, fallback, jewel]) {
    if (!SURFACE_WGSL.includes(needle)) throw new Error(`incar: surface.ts no longer has "${needle.trim()}"; re-derive the cabin surface.`);
  }
  return SURFACE_WGSL.replace(params, `${params}  leather: vec3f, // @default 0.5  The cabin leather's albedo (class 60).
  trim: vec3f, // @default 0.02  The dash and panel trim's albedo (class 61).
  stripGain: f32, // @default 1  The ambient LED strips' radiance multiplier (class 63).
  lens: f32, // @default 0.004  The sunglasses' albedo (class 34): row 36's lenses glare, so its negative keeps them grey.
  plainChain: f32, // @default 0  1 draws the chain (class 35) as the tee's black cloth: row 36's negative shows no chain.
`).replace(jewel, `    case 35u: {
      if (p.plainChain > 0.5) { o.albedo = vec4f(0.018, 0.018, 0.019, 1.0); o.metallic = 0.0; o.roughness = 0.9; return o; }
      return jewel(s, p, o);
    }
    case 34u: { o.albedo = vec4f(vec3f(p.lens), 1.0); o.roughness = 0.3; }`).replace(fallback, `    case 60u: {
      let n = detailFbm(s.world * 70.0, 3, s.footprint);
      o.albedo = vec4f(p.leather * (0.9 + 0.2 * n.value), 1.0);
      o.roughness = 0.45 + 0.1 * n.value;
      o.normal = detailBump(s.normal, n.gradient * 0.0015, 1.0);
    }
    case 61u: { o.albedo = vec4f(p.trim, 1.0); }
    case 63u: { o.emissive = s.emissive * p.stripGain; }
${fallback}`);
}
export const CABIN_SURFACE_WGSL = cabinSurface();

/** Knobs for every bone: the given ones, zero for the rest (no tableau performance survives); the hands' knobs (skin-kernel.ts handPose: curl, spread, thumb) pass through. */
function seatedPose(facts: OnNothingFacts, values: Record<string, number | string>): Record<string, StoredParameter> {
  const known = new Set(facts.bones.map(boneParam));
  const out: Record<string, StoredParameter> = {};
  for (const bone of known) out[bone] = [0, 0, 0];
  for (const [key, value] of Object.entries(values)) {
    const [bone, axis] = key.split(".");
    if (bone !== undefined && /^(curl|spread|thumb)[LR]$/.test(bone)) {
      out[key] = knob(String(value), typeof value === "number" ? value : 0);
      continue;
    }
    if (bone === undefined || axis === undefined || !known.has(bone)) throw new Error(`incar: no bone knob "${key}".`);
    out[key] = knob(String(value), typeof value === "number" ? value : 0);
  }
  return out;
}

/**
 * SEATED: the pelvis reclined `recline` radians (negative: the torso back), the thighs level
 * along the cushion, the shins down to the footwell, the feet flat. Radians about the rest axes
 * (x = the figure's left, y = up, z = the way it faces; negative x swings a limb forward); a
 * child's knob adds to its parent's, so each is set against the net angle wanted.
 */
function legsSeated(recline: number): Record<string, number> {
  const thigh = -1.5; // net: the thighs forward, a touch up at the knee
  const shin = -0.35; // net: the shins down and a little forward
  const foot = -0.1;
  return {
    "pelvis.x": recline,
    "thighL.x": thigh - recline,
    "thighR.x": thigh - recline,
    "thighL.z": 0.08,
    "thighR.z": -0.08,
    "shinL.x": shin - thigh,
    "shinR.x": shin - thigh,
    "footL.x": foot - shin,
    "footR.x": foot - shin,
  };
}

interface Take {
  /** Which figure: the black tee or shirtless. */
  readonly area: "fig" | "figbare";
  readonly pose: Record<string, number | string>;
  /** The hip, shifted from the driver's H-point (car right, up, forward metres). */
  readonly hipShift?: V3;
  /** Camera eye and aim in the car's frame (right, up, forward from the hip), lens fov, roll. */
  readonly eye: V3;
  readonly aim: V3;
  readonly fov: number;
  readonly roll: string;
  readonly sway: number;
  readonly focus: number;
  readonly negative: boolean;
  /** The cabin leather's albedo, and the ambient strips' gain; the figure's lenses' albedo, and whether it wears its chain. */
  readonly leather: V3;
  readonly lens?: number;
  readonly chain?: boolean;
  readonly strips: number;
  /** The cabin's lights: id, where (car frame from the hip), colour, intensity. */
  readonly lights: readonly (readonly [string, V3, readonly number[], number])[];
  /** Grade exposure (stops) of the positive. */
  readonly exposure: number | string;
  /** How far the driver's door stands open (radians; an expression over abstime may swing it). */
  readonly door: number | string;
  /** The take's own finishing passes and knobs, after the common ones (`at` maps the car's frame to the world). */
  readonly finish?: (plate: Plate, at: (local: V3) => [number, number, number]) => void;
  /** The cabin car's own lamps' radiance (headlights, DRLs, the mirrors' signal strips); unset, the scene's. */
  readonly ownLamps?: number;
  /** Move the whole cabin car (and everything framed by it) by this, glTF metres: another mark in the room. */
  readonly shift?: V3;
  /** Flip the finished frame left for right (see MIRROR_X_WGSL). */
  readonly mirror?: boolean;
  /** A second figure in the passenger's seat: which one, its pose, its hip shifted from that seat's H-point. */
  readonly passenger?: { readonly area: "fig" | "figbare"; readonly pose: Record<string, number | string>; readonly hipShift?: V3 };
}

/** A shot's clock in output frames (24 fps): `after(k)` is 1 from frame k on (sub-frames included). */
const FRAME = "(abstime * 24 + 0.02)";
const after = (k: number): string => `clamp((${FRAME} - ${k}) * 1000, 0, 1)`;
const during = (a: number, b: number): string => `(${after(a)} * (1 - ${after(b)}))`;
/** Sum of `value × during(a, b)` terms, plus a base: a knob that steps frame by frame. */
const steps = (base: number, terms: readonly (readonly [number, number, number])[]): string =>
  `(${base}${terms.map(([a, b, value]) => ` + ${value - base} * ${during(a, b)}`).join("")})`;

/**
 * Row 36's glitch, frame by frame (reference frames 979-994, measured off renders/on-nothing/
 * agents/incar/ref/r36): 0 a tear across the top; 1-8 the steady negative; 9 a tear along the
 * bottom; 10 a teal frame, RGB split and smeared (the glitch); 11-13 the positive back, dark,
 * the negative holding only on the face at the right, the picture jolted up and right; 14 the
 * face big and tilted, negative again; 15 torn and smeared across the middle. The EDL's parts
 * start at frames 0, 10 and 14 of this one clock, so the three clips are one continuous take.
 */
function row36Glitch(plate: Plate, at: (local: V3) => [number, number, number]): void {
  plate.add("tear", "customWgsl", {
    source: TEAR_WGSL,
    amount: knob(steps(0, [[0, 1, 0.05], [9, 10, 0.06], [10, 11, 0.03], [15, 16, 0.12]])),
    centre: knob(steps(0.5, [[0, 1, 0.1], [9, 10, 0.88], [10, 11, 0.85], [15, 16, 0.6]]), 0.5),
    height: knob(steps(0.2, [[0, 1, 0.18], [9, 10, 0.2], [10, 11, 0.3], [15, 16, 0.6]]), 0.2),
    smear: knob(steps(0, [[0, 1, 0.04], [9, 10, 0.05], [10, 11, 0.05], [15, 16, 0.3]])),
    split: knob(steps(0, [[10, 11, 0.012], [11, 14, 0.0015]])),
    teal: knob(steps(0, [[10, 14, 1]])),
  }, { label: "tear1", resolution: { mode: "project" } });
  plate.spliceAfter("negative", "tear");
  // 10-13: the positive back on the left and dark; the negative keeps the face (the right)
  plate.set("negative", {
    wipe: knob(steps(0, [[10, 11, 0.7], [11, 14, 0.52]])),
    positive: knob(steps(1, [[10, 14, 0.22]]), 1),
  });
  // grain is the negative's enemy (the flip and the gain make it snow): the dot screen carries the texture
  plate.set("grade", { exposure: knob(steps(1.5, [[10, 14, 0.6]]), 1.5), grain: 0.006 });
  // the camera: jolted at 11 (the picture slides up and right), then 14-15 in close on the tilted face
  const face = at([0.08, 0.6, 0.08]);
  const cam = plate.node("cam").parameters;
  const slot = (key: string): string => {
    const entry = cam[key] as unknown as { bindings?: { expression?: { source: string } } };
    const source = entry.bindings?.expression?.source;
    if (source === undefined) throw new Error(`incar: cam.${key} is not an expression slot.`);
    return source;
  };
  const jolt = at([0.22, 0.1, 0]);
  const base = at([0, 0, 0]);
  const shift = [jolt[0] - base[0], jolt[1] - base[1], jolt[2] - base[2]];
  const lookAt = (axis: 0 | 1 | 2, key: string): StoredParameter => {
    const close = `${face[axis]}`;
    return knob(`(${slot(key)} + ${shift[axis]} * ${during(11, 14)}) * (1 - ${after(14)}) + ${close} * ${after(14)}`, face[axis]);
  };
  plate.set("cam", {
    "lookAt.x": lookAt(0, "lookAt.x"),
    "lookAt.y": lookAt(1, "lookAt.y"),
    "lookAt.z": lookAt(2, "lookAt.z"),
    fov: knob(`27 - 7 * ${after(14)}`, 27),
    roll: knob(`(${slot("roll")}) * (1 - ${after(14)}) - 20 * ${after(14)}`, 0),
  });
}

const COOL = [0.85, 0.92, 1, 1] as const;

const TAKES: Record<0 | 1, Take> = {
  // row 36: at the windscreen, just outside it, a little toward the door (frame: the figure right
  // of centre, big, the passenger's side and the rear seats beyond on the left)
  0: {
    area: "fig",
    hipShift: [0, -0.05, 0],
    pose: {
      ...legsSeated(-0.15),
      "spine.x": 0.05,
      // the right hand (frame left) up on the wheel's rim, the left arm down in the lap
      "upperarmR.y": 0.95,
      "upperarmR.z": 0.25,
      "forearmR.y": 0.3,
      "forearmR.x": -1.05,
      "upperarmL.z": -0.6,
      "upperarmL.y": -0.3,
      "forearmL.y": -0.6,
      "neck.x": `0.12 + sin(abstime * 3.1) * 0.03`,
      "neck.y": -0.2,
      "head.y": `-0.2 + sin(abstime * 1.7) * 0.05`,
    },
    eye: [-0.12, 0.62, 0.66],
    aim: [0.12, 0.54, 0],
    fov: 27,
    roll: `-4 - abstime * 2.5`,
    sway: 0.012,
    focus: 0.62,
    negative: true,
    leather: [0.62, 0.58, 0.52],
    strips: 1,
    lens: 0.35,
    chain: false,
    // the cabin round the figure lit (a dome over the passenger's side, the far door): it goes
    // black in the negative; the figure itself stays dark (the negative's white)
    lights: [["cabinBack", [0.3, 0.7, -0.9], COOL, 0.8], ["cabinFar", [1.0, 0.3, -0.2], COOL, 0.6]],
    exposure: 1.5,
    door: 0,
    finish: row36Glitch,
  },
  // row 45 (0:46.17, 16 frames): outside the open driver's door, just behind its front edge,
  // looking in and back — the figure shirtless and slouched in the seat, the near (left) hand
  // thrown at the lens with the rings, the far hand on the thigh; the passenger beyond, an arm
  // out along the far door; the open door's inner panel and its cyan strip on the right, the
  // headliner's strip over them; outside on the left the room, the white cars' lamps smeared up.
  1: {
    area: "figbare",
    // slid forward in the seat, slouched: the upper body clears the B-pillar
    hipShift: [0.05, -0.08, 0.3],
    pose: {
      ...legsSeated(-0.5),
      "spine.x": -0.08,
      "chest.x": 0.1,
      // the near (left) hand thrown out at the lens, the far hand on the thigh, the head toward the door
      "upperarmL.x": `-0.1 + sin(abstime * 5.2) * 0.05`,
      "upperarmL.y": 0.5,
      "upperarmL.z": 0.3,
      "forearmL.x": `-0.8 + sin(abstime * 5.2 + 0.6) * 0.06`,
      "upperarmR.z": 0.62,
      "forearmR.x": -0.6,
      // the thrown hand points (index out, the rest in a fist, the thumb up); the far hand lies loose
      ...handPose("L", { curl: 1.35, point: 0.95, thumb: 0.1, thumbOut: 0.5, extra: [0, 0, 0.05, 0.1] }),
      ...handPose("R", { curl: 0.45, spread: 0.08 }),
      "neck.y": 0.4,
      "neck.x": `0.08 + sin(abstime * 2.3) * 0.03`,
    },
    passenger: {
      area: "fig",
      hipShift: [0, -0.04, 0],
      pose: {
        ...legsSeated(-0.3),
        // the far arm out along the dash
        "upperarmR.y": 1.1,
        "upperarmR.z": 0.4,
        "forearmR.y": 0.2,
        "upperarmL.z": -0.55,
        "neck.y": -0.4,
        "neck.x": 0.1,
      },
    },
    eye: [-0.7, 0.45, 0.62],
    aim: [0.4, 0.1, -0.35],
    fov: 72,
    roll: `4 - abstime * 2 + ${wobble(3, -1.2)}`,
    sway: 0.02,
    focus: 0.95,
    negative: false,
    leather: [0.03, 0.028, 0.027],
    strips: 6,
    lens: 0.004,
    // the figure's warm key from outside on the left (the room's sodium), a cool top in the cabin,
    // the strips' cyan spill on the far side
    lights: [["cabinKey", [-0.45, 0.55, 0.95], [1, 0.72, 0.5, 1], 0.6], ["cabinDome", [0.3, 0.75, -0.3], COOL, 0.08], ["cabinStrip", [0.9, 0.1, 0.4], [0.2, 0.9, 1, 1], 0.12], ["passengerKey", [0.6, 0.25, 0.5], COOL, 0.3]],
    exposure: -0.2,
    door: 1.25,
    mirror: true,
    // in front of the car row (its lamps face +z at z = 0): out past the B-pillar the lens sees their fronts
    shift: [4, 0, 9.5],
    // the door mirror's signal strip sits a hand from the lens: not lit in the reference
    ownLamps: 0,
  },
};

/** The tableau's set with the cabin car in it, the figure seated, a take's camera and finish. */
function cabinPlate(facts: OnNothingFacts, build: Builder, options: IncarOptions, take: Take): Plate {
  const plate = new Plate(build(facts, { shot: "tableau", ...(options.width === undefined ? {} : { width: options.width }), ...(options.height === undefined ? {} : { height: options.height }), audio: options.audio === true, hdri: options.hdri === true, crt: false }));
  const cabin = cabinFacts(facts);
  const frame = carFrame(cabin, take.shift);
  const scale = (options.width ?? 1920) / 1920;

  // ── The cabin car: its body (interior and all) in the main Render ──
  const body = facts.areas.get("cabin");
  const panes = facts.areas.get("cabinglass");
  if (body === undefined || panes === undefined) throw new Error("incar: no cabin in the GLB (rebuild it with tools/blender/on-nothing/carint.py).");
  plate.add("mesh_cabin", "meshFileIn", { file: facts.glbUrl, select: body.select, vertices: body.vertices, triangles: body.triangles, parts: body.parts }, { label: "meshcabin1" });
  plate.add("cabinSurf", "materialWgsl", { ...plate.node("surf").parameters, source: CABIN_SURFACE_WGSL, leather: [...take.leather], trim: [0.02, 0.02, 0.021], stripGain: take.strips, lens: take.lens ?? 0.004, plainChain: take.chain === false ? 1 : 0, ...(take.ownLamps === undefined ? {} : { headGain: take.ownLamps }) }, { label: "cabinsurf1" });
  plate.add("geo_cabin", "geometry", { mode: "surface", material: "cabinsurf1" }, { label: "geocabin1" });
  plate.add("door", "pointKernel", { capacity: body.vertices, attributes: CAR_RIG_ATTRIBUTES, kernel: doorKernel(body.partTable), open: knob(take.door, 0) }, { label: "door1" });
  plate.connect("mesh-door", ["mesh_cabin", "out"], ["door", "in"]);
  // the take may move the whole car (its panes too) to another mark in the room
  const carOut: readonly [string, string] = take.shift === undefined ? ["door", "out"] : ["moveCabin", "out"];
  const paneOut: readonly [string, string] = take.shift === undefined ? ["mesh_cabinglass", "out"] : ["movePanes", "out"];
  if (take.shift !== undefined) {
    plate.add("moveCabin", "pointTransform", { translate: [...take.shift], pivot: "origin" }, { label: "movecabin1" });
    plate.connect("door-move", ["door", "out"], ["moveCabin", "points"]);
  }
  plate.connect("door-geo-cabin", carOut, ["geo_cabin", "points"]);
  plate.set("shot", { scenes: `${String(plate.node("shot").parameters["scenes"])} geocabin1` });

  // ── The figure, seated in the driver's seat ──
  const figure = facts.areas.get(take.area);
  if (figure === undefined) throw new Error(`incar: no ${take.area} in the GLB.`);
  plate.set("figGeo", { material: "cabinsurf1" });
  plate.set("fig", { select: figure.select, vertices: figure.vertices, triangles: figure.triangles, parts: figure.parts, joints: figure.joints });
  const pelvis = facts.bones.find((bone) => bone.name === "thigh.L");
  if (pelvis === undefined) throw new Error("incar: the figure has no thigh.L bone.");
  const hip = frame.at(take.hipShift ?? [0, 0, 0]);
  // the rest hip joint's height and depth land on the H-point (the figure faces +Z at rest; the car faces its forward)
  const place: [number, number, number] = [hip[0], hip[1] - pelvis.head[1], hip[2] - pelvis.head[2]];
  const skin = plate.node("skin");
  const kept = Object.fromEntries(Object.entries(skin.parameters).filter(([key]) => ["capacity", "attributes", "kernel"].includes(key)));
  plate.nodes.set("skin", { ...skin, parameters: kept });
  plate.set("skin", { capacity: figure.vertices, yaw: Math.atan2(cabin.forward[0], cabin.forward[2]), place, ...seatedPose(facts, take.pose) });
  if (take.passenger !== undefined) {
    // the passenger: the same kernel on its own figure, the seat's H-point across the car
    const other = facts.areas.get(take.passenger.area);
    if (other === undefined) throw new Error(`incar: no ${take.passenger.area} in the GLB.`);
    const across = Math.hypot(cabin.seat[0] - cabin.passengerSeat[0], cabin.seat[2] - cabin.passengerSeat[2]);
    const seatHip = frame.at(add([across, 0, 0], take.passenger.hipShift ?? [0, 0, 0]));
    plate.add("fig2", "meshFileIn", { file: facts.glbUrl, select: other.select, vertices: other.vertices, triangles: other.triangles, parts: other.parts, joints: other.joints }, { label: "fig21" });
    plate.add("skin2", "pointKernel", { ...kept, capacity: other.vertices, yaw: Math.atan2(cabin.forward[0], cabin.forward[2]), place: [seatHip[0], seatHip[1] - pelvis.head[1], seatHip[2] - pelvis.head[2]], ...seatedPose(facts, take.passenger.pose) }, { label: "skin21" });
    plate.add("figGeo2", "geometry", { mode: "surface", material: "cabinsurf1" }, { label: "figgeo21" });
    plate.connect("fig2-skin2", ["fig2", "out"], ["skin2", "in"]);
    plate.connect("skin2-geo2", ["skin2", "out"], ["figGeo2", "points"]);
    plate.set("shot", { scenes: `${String(plate.node("shot").parameters["scenes"])} figgeo21` });
  }

  // ── The camera ──
  const eye = frame.at(take.eye);
  const aim = frame.at(take.aim);
  plate.clearSlots("cam", "eye");
  plate.clearSlots("cam", "lookAt");
  plate.set("cam", {
    ...vectorKnobs("eye", [`${eye[0]} + ${wobble(1, take.sway)}`, `${eye[1]} + ${wobble(2, take.sway * 0.7)}`, `${eye[2]} + ${wobble(3, take.sway * 0.5)}`], eye),
    ...vectorKnobs("lookAt", [`${aim[0]} + ${wobble(4, take.sway * 1.6)}`, `${aim[1]} + ${wobble(5, take.sway)}`, `${aim[2]}`], aim),
    fov: take.fov,
    near: 0.03,
    roll: knob(take.roll, 0),
  });
  plate.set("lens_dof", { focusDistance: take.focus, aperture: 1.2 * scale, maxRadius: 18 * scale });

  // ── Light inside the cabin: the strips' cyan spill, a dim cool top, the figure's rim ──
  const light = (id: string, at: V3, color: readonly number[], intensity: number): void => {
    plate.add(id, "light", { kind: "point", position: [...at], color: [...color], intensity }, { label: `${id.toLowerCase()}1` });
    plate.set("shot", { lights: `${String(plate.node("shot").parameters["lights"])} ${id.toLowerCase()}1` });
  };
  for (const [id, at, color, intensity] of take.lights) light(id, frame.at(at), color, intensity);
  plate.set("grade", { exposure: knob(take.exposure, 0) });

  // ── The panes: their own Render (the car and the figure as black occluders), laid over ──
  plate.add("mesh_cabinglass", "meshFileIn", { file: facts.glbUrl, select: panes.select, vertices: panes.vertices, triangles: panes.triangles, parts: panes.parts }, { label: "meshcabinglass1" });
  plate.add("paneMat", "materialWgsl", { model: "pbr", source: SURFACE_WGSL }, { label: "panemat1" });
  plate.add("occMat", "materialWgsl", { model: "unlit", source: OCCLUDER_WGSL, roughness: 1 }, { label: "occmat1" });
  plate.add("geo_panes", "geometry", { mode: "surface", material: "panemat1" }, { label: "geopanes1" });
  plate.add("occ_cabin", "geometry", { mode: "surface", material: "occmat1" }, { label: "occcabin1" });
  plate.add("occ_fig", "geometry", { mode: "surface", material: "occmat1" }, { label: "occfig1" });
  if (take.shift !== undefined) {
    plate.add("movePanes", "pointTransform", { translate: [...take.shift], pivot: "origin" }, { label: "movepanes1" });
    plate.connect("panes-move", ["mesh_cabinglass", "out"], ["movePanes", "points"]);
  }
  plate.connect("mesh-geo-panes", paneOut, ["geo_panes", "points"]);
  plate.connect("door-occ-cabin", carOut, ["occ_cabin", "points"]);
  plate.connect("skin-occ-fig", ["skin", "out"], ["occ_fig", "points"]);
  if (take.passenger !== undefined) {
    plate.add("occ_fig2", "geometry", { mode: "surface", material: "occmat1" }, { label: "occfig21" });
    plate.connect("skin2-occ-fig2", ["skin2", "out"], ["occ_fig2", "points"]);
  }
  const envPort = plate.feederOf("shot", "environment").source;
  plate.add("paneShot", "render", {
    scenes: `geopanes1 occcabin1 occfig1${take.passenger === undefined ? "" : " occfig21"}`,
    camera: "cam1",
    lights: "",
    ambientIntensity: 0,
    background: [0, 0, 0, 1],
    antialias: "msaa",
    normalOutput: true,
    environmentIntensity: 1,
    environmentTaps: 16,
  }, { label: "paneshot1" });
  plate.connect("env-paneshot", [envPort.nodeId, envPort.portId], ["paneShot", "environment"]);
  plate.add("panes", "customWgslMulti", { source: GLASS_COMPOSITE_WGSL, refract: 0.002, dispersion: 0.1, reflect: 0.5, tint: 0.6 }, { label: "panes1", resolution: { mode: "project" } });
  plate.spliceAfter("occlusion", "panes", [["paneShot", "out"], ["paneShot", "normal"]]);

  // ── The finish ──
  if (take.negative) {
    plate.add("negative", "customWgsl", { source: NEGATIVE_WGSL, amount: 1, gain: 3, gamma: 1.6, white: 0.9, tint: [0.86, 1.0, 1.02, 1], dots: 0.14, pitch: 4 }, { label: "negative1", resolution: { mode: "project" } });
    plate.spliceAfter("grade", "negative");
  }
  take.finish?.(plate, frame.at);
  if (take.mirror === true) {
    plate.add("mirrorX", "customWgsl", { source: MIRROR_X_WGSL }, { label: "mirrorx1", resolution: { mode: "project" } });
    plate.spliceAfter("grade", "mirrorX");
  }
  if (options.crt === true) {
    plate.add("crt", "customWgsl", { source: CRT_WGSL, amount: 1 }, { label: "crt1", resolution: { mode: "project" } });
    plate.spliceAfter(plate.feederOf("out").source.nodeId, "crt");
  }
  return plate;
}

function finishDocument(plate: Plate, base: ProjectDocument, name: string): ProjectDocument {
  return {
    ...base,
    projectId: `project-on-nothing-${name}`,
    name: `On Nothing · ${name}`,
    graph: { ...base.graph, nodes: Object.fromEntries(plate.nodes), edges: Object.fromEntries(plate.edges) },
  };
}

export function incarDocument(facts: OnNothingFacts, build: Builder, options: IncarOptions): ProjectDocument {
  const take = options.take ?? 0;
  if (take !== 0 && take !== 1) throw new Error(`incar: no take ${take} (0 = row 36, through the windscreen; 1 = row 45, through the open door; rows 84, 85 and 91 are not built yet).`);
  const base = build(facts, { shot: "tableau", ...(options.width === undefined ? {} : { width: options.width }), ...(options.height === undefined ? {} : { height: options.height }) });
  const plate = cabinPlate(facts, build, options, TAKES[take]);
  return finishDocument(plate, base, "incar");
}
