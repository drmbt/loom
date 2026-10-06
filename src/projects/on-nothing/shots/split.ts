import type { ProjectDocument } from "../../../domain/types/graph.ts";
import type { StoredParameter } from "../../../domain/types/parameters.ts";
import { edge, node, settings, graph, LIMITS } from "../../../examples/documents/builders.ts";
import { SCHEMA_VERSION } from "../../../domain/types/schemas.ts";
import { SHARED_UNIFORMS_WGSL } from "../../../runtime/backend/shared-uniforms.ts";
import type { OnNothingFacts } from "../scene-facts.ts";
import { Plate, cycKey, knob, soleCycFigure, vectorKnobs, wobble } from "./plate.ts";
import { standingPose } from "./poses.ts";
import { SURFACE_WGSL } from "../surface.ts";
import { CRT_WGSL } from "../fx.ts";

/**
 * T1407b (split) — THE MULTI-MATTE SPLIT SCREEN, the reference's 0:27.6–0:28.9 (31 frames).
 *
 * Measured from the reference, frame by frame (renders/on-nothing/agents/split/notes):
 *
 *  - Two plates, one frame. RIGHT: the feet on a bright floor, the full frame — frame 1 of the
 *    cut shows it alone, and it never moves when the left plate lands. LEFT: the hood ornament
 *    and the top of the grille in the dark warehouse, laid over the left half from frame 2 on.
 *  - The matte is SOFT: the pictures dissolve through a dim, smoky valley, the left one holding
 *    to x ~0.45, the valley's floor at x 0.47 at the top and 0.505 at the bottom (it follows the
 *    grille surround's right edge down and a little right), the right one climbing from ~0.49
 *    to full at ~0.58 (luma 20 → 180 at y = 0.15). Static over the cut.
 *  - Each plate carries its own vignette: the left one centred in its window, black at x = 0.
 *  - LEFT: calm and soft — black lacquer, dim grey chrome bars, the ornament upper left, one
 *    soft streak column rising off the grille top that RETRACTS over the cut (luma 117 → 41 →
 *    14 at y = 0.15), a thin fog. The camera pushes in (ornament +5 %) and drifts.
 *    Cyan-steel: highlights rgb 129,147,150; blacks 6–14.
 *  - RIGHT: the floor at rgb 166,180,177 (cool, green-cyan), a hard light shadow of the
 *    figure thrown up and left, the legs cropped at the frame top, feet at y ≈ 0.35–0.48; the
 *    figure's right foot (screen left) slides out and down over the cut.
 */

/** The ornament of the back-row sedan (glTF metres), measured off the GLB (car3, maybach_s). */
const ORNAMENT: readonly [number, number, number] = [-1.42, 0.912, -7.63];
/** The cut's length in seconds: 31 frames at 23.976. */
export const SPLIT_SECONDS = 31 / 23.976;
/**
 * The one-way fade of the streak columns: most of it over the reference's 1.3 s cut, then on
 * more slowly to 3 s, so a longer clip never holds still or turns back.
 */
const FADE = `(clamp(abstime / ${SPLIT_SECONDS.toFixed(4)}, 0, 1) * 0.75 + clamp(abstime / 3, 0, 1) * 0.25)`;

export const SPLIT_WGSL = `struct Params {
  seam: f32, // @default 0.47  Where the matte's valley lies, uv x, at the frame's top.
  tilt: f32, // @default 0.035  Seam lean: uv x added per unit of uv y (the reference's runs down and a little right, along the grille's edge).
  softLeft: f32, // @default 0.08  How far into the left plate its dissolve reaches.
  softRight: f32, // @default 0.11  How far into the right plate its dissolve reaches.
  smoke: f32, // @default 0.012  Horizontal smear in the dissolve (uv x at the valley): the haze the two pictures meet in.
  floorLevel: f32, // @default 0.12  What light is left at the bottom of the valley.
  reveal: f32, // @default 1  0 shows the right plate alone (the cut's first frame).
  leftVignette: f32, // @default 0.8  The left plate's own vignette, centred in its window.
  poolCentre: vec2f, // @default 0.5  The floor's pool of light: its centre (uv).
  poolWidth: f32, // @default 0.75  Its falloff width, in frame heights (a gaussian).
  poolTint: vec3f, // @default 1  What the falloff tints toward (the reference's shade is cyan).
};
${SHARED_UNIFORMS_WGSL}
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

// the floor plate, lit by its pool (measured: 180 at the feet, 123 below them, 66 at the right
// edge, 31 in the corner), its shade going cyan
fn floorAt(uv: vec2f, aspect: f32) -> vec3f {
  let d = length((uv - params.poolCentre) * vec2f(aspect, 1.0)) / params.poolWidth;
  let pool = exp(-d * d);
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb * pool * mix(params.poolTint, vec3f(1.0), pool);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = frameU.resolution.x / frameU.resolution.y;
  if (params.reveal < 0.5) { return vec4f(floorAt(uv, aspect), 1.0); }
  // A SOFT matte: the two pictures dissolve into each other through a dim, smoky valley about
  // a fifth of the frame wide, along a line that leans down and right, not a cut.
  let seam = params.seam + params.tilt * uv.y;
  let x = uv.x - seam;
  let near = exp(-(x * x) / (2.0 * 0.05 * 0.05));
  // the smoke: both pictures smeared sideways as they meet (9 taps, widest in the valley)
  let reach = params.smoke * near;
  var left = vec3f(0.0);
  var right = vec3f(0.0);
  for (var k = -4; k <= 4; k = k + 1) {
    let o = vec2f(f32(k) / 4.0 * reach, 0.0);
    left = left + textureSampleLevel(inputTexture1, inputSampler, uv + o, 0.0).rgb;
    right = right + floorAt(uv + o, aspect);
  }
  left = left / 9.0;
  right = right / 9.0;
  // the left plate's own lens: a vignette centred in its window
  let centre = vec2f(seam * 0.5, 0.45);
  let q = (uv - centre) * vec2f(1.0 / seam, 1.0);
  left = left * (1.0 - params.leftVignette * smoothstep(0.15, 0.62, dot(q, q)));
  let wl = smoothstep(0.02, -params.softLeft, x);
  let wr = smoothstep(-0.01, params.softRight, x);
  let valley = mix(params.floorLevel, 1.0, max(wl, wr));
  // a half-level dither: the pool's slow gradient would band in the 8-bit encode
  let n = fract(sin(dot(floor(uv * frameU.resolution), vec2f(12.9898, 78.233)) + frameU.absFrame * 0.618) * 43758.5453) - 0.5;
  return vec4f((left * wl + right * wr) * valley + vec3f(n / 255.0), 1.0);
}`;

/**
 * The stock surface, repainted: the reference's sedan is BLACK lacquer, the GLB's back-row
 * sedan white. Every paint class draws with `paint` as its albedo (clear coat unchanged).
 */
export const BLACK_PAINT_WGSL = SURFACE_WGSL
  .replace("struct Params {\n", "struct Params {\n  paint: f32, // @default 0.012  Paint albedo (linear) for every paint class.\n")
  .replace("fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {", "fn stockSurface(s: SurfaceIn, p: Params) -> SurfaceOut {")
  + `

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = stockSurface(s, p);
  let c = classOf(s);
  if (c >= 10u && c <= 13u) { o.albedo = vec4f(vec3f(p.paint), 1.0); o.metallic = 0.0; }
  return o;
}`;
if (!BLACK_PAINT_WGSL.includes("fn stockSurface") || !BLACK_PAINT_WGSL.includes("paint: f32")) throw new Error("split: SURFACE_WGSL changed shape; BLACK_PAINT_WGSL could not wrap it.");

/**
 * The room the car plate's lacquer and chrome MIRROR (an equirect environment, the stock
 * layout: phi = 0 looks down -z). Black, but for a row of vertical LED tubes low on the
 * horizon round the direction a grazing bonnet reflects (the columns the streak glass lifts)
 * and two soft overhead panels that draw the chrome's edges. Every value is radiance.
 */
export const SPLIT_ENV_WGSL = `struct Params {
  tubes: f32, // @default 4  Radiance of the horizon tubes.
  tubeFrom: f32, // @default 0.3  First tube azimuth (radians from -z toward +x).
  tubeTo: f32, // @default 1.9  Last tube azimuth.
  tubeCount: f32, // @default 9  Tubes across that span.
  tubeTop: f32, // @default 0.4  Where the tubes end (sine of the elevation).
  tubeWidth: f32, // @default 0.1  Half-width of a tube, as a share of its slot (large = soft banks of light).
  sodium: f32, // @default 1  Every fifth tube is an old sodium practical: its warm radiance.
  panel: f32, // @default 2  Radiance of the overhead panel.
  wall: f32, // @default 1  Radiance of the broad soft wall behind the lens (the chrome's faces mirror it).
  wallDir: vec3f, // @default 0  Where that wall is (unit direction, world).
  room: f32, // @default 0.004  The room's own radiance.
  roof: f32, // @default 0.2  A soft glow high overhead (the chrome's upper faces mirror it; a grazing bonnet does not).
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let unused = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).a * 0.0;
  let phi = (uv.x - 0.5) * 6.2831853;
  let theta = uv.y * 3.1415927;
  let d = vec3f(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
  var radiance = vec3f(params.room) * (0.4 + 0.6 * smoothstep(-0.2, 0.6, d.y)) + vec3f(0.9, 0.95, 1.0) * params.roof * smoothstep(0.35, 0.9, d.y);
  // horizon tubes: slim, vertical, from just below the horizon to 25 degrees up
  let span = params.tubeTo - params.tubeFrom;
  let slot = (phi - params.tubeFrom) / span * params.tubeCount;
  let inside = step(0.0, slot) * step(slot, params.tubeCount);
  let across = abs(fract(slot) - 0.5);
  let tube = smoothstep(params.tubeWidth, params.tubeWidth * 0.3, across) * smoothstep(-0.06, 0.0, d.y) * (1.0 - smoothstep(params.tubeTop - 0.05, params.tubeTop, d.y)) * inside;
  let warm = step(3.5, fract(floor(slot) / 5.0 + 0.01) * 5.0);
  radiance = radiance + mix(vec3f(0.85, 0.96, 1.0) * params.tubes, vec3f(1.0, 0.5, 0.16) * params.sodium, warm) * tube;
  // a soft overhead panel over the car's nose, and a broad soft wall behind the lens
  let a = pow(max(dot(d, normalize(vec3f(0.35, 1.0, -0.35))), 0.0), 60.0);
  let b = max(dot(d, normalize(params.wallDir)), 0.0);
  radiance = radiance + vec3f(0.92, 0.97, 1.0) * (params.panel * smoothstep(0.55, 0.75, a) + params.wall * smoothstep(0.55, 0.9, b));
  return vec4f(radiance + vec3f(unused), 1.0);
}`;

export interface SplitOptions {
  readonly width?: number;
  readonly height?: number;
  readonly hdri?: boolean;
  readonly audio?: boolean;
  /** The CRT re-scan over the composite (never inside a plate: one tube, one frame). */
  readonly crt?: boolean;
}

type Builder = (facts: OnNothingFacts, options: { shot: "tableau" | "cyc"; width?: number; height?: number; hdri?: boolean; audio?: boolean; crt?: boolean }) => ProjectDocument;

/** The LEFT plate: the back-row sedan's ornament and grille top in the dark warehouse. */
function carPlate(facts: OnNothingFacts, build: Builder, options: SplitOptions): Plate {
  const plate = new Plate(build(facts, { ...options, shot: "tableau", crt: false, hdri: false, audio: false }));
  // the depth of field is in pixels: scale it with the frame (--final renders at 2x)
  const scale = (options.width ?? 1920) / 1920;
  // the sedan in black lacquer
  const surf = plate.node("surf");
  plate.add("splitPaint", "materialWgsl", { ...surf.parameters, source: BLACK_PAINT_WGSL, paint: 0.012, headGain: 0 }, { label: "material_splitpaint" });
  plate.set("geo_car3", { material: "material_splitpaint" });
  // no figure in this plate
  plate.remove("fig", "skin", "figGeo");
  plate.dropFromList("shot", "scenes", "geometry_fig");
  // The camera: above and to the car's left of the ornament, looking down across the grille,
  // on a long-ish lens; a slow push (the ornament grows 5 % over the cut) with handheld sway.
  const [ox, oy, oz] = ORNAMENT;
  // FITTED to the reference (frame 56): the ornament's centre at uv (0.143, 0.30), 0.1 wide, the
  // grille's top at the centre line at (0.30, 0.70), its line through (0, 0.82) and (0.46, 0.62)
  // (a least-squares camera solve; residuals under 0.03 but for the grille's far end). The fit
  // puts the lens LOW — a hand above bonnet height, 1.2 m off the car's front corner, looking
  // back across the nose — so the bonnet runs away at a grazing angle and mirrors the room's
  // lights, which the streak glass lifts into the wall of columns. (loom's roll turns the
  // other way from the solver's: the solve said +9.9 deg.)
  const eye = [-2.623, 1.031, -6.801] as const;
  const look = [-1.004, 0.81, -7.433] as const;
  // the push never stops: 6 % of the way a second (the reference's cut is 1.3 s; clips run longer)
  const push = `(abstime * 0.06)`;
  plate.clearSlots("cam", "eye");
  plate.clearSlots("cam", "lookAt");
  plate.set("cam", {
    ...vectorKnobs("eye", [
      `${eye[0]} + (${look[0]} - ${eye[0]}) * ${push} + ${wobble(1, 0.006)}`,
      `${eye[1]} + (${look[1]} - ${eye[1]}) * ${push} + ${wobble(2, 0.004)}`,
      `${eye[2]} + (${look[2]} - ${eye[2]}) * ${push}`,
    ], [eye[0], eye[1], eye[2]]),
    ...vectorKnobs("lookAt", [
      `${look[0]} + ${wobble(3, 0.008)}`,
      // tilting up a touch as it pushes: the grille sinks in the frame, as the reference's
      `${look[1]} + ${wobble(4, 0.006)} + abstime * 0.005`,
      `${look[2]}`,
    ], [look[0], look[1], look[2]]),
    fov: 16,
    // a Dutch tilt that keeps drifting one way, and the operator's sway on top
    roll: knob(`9.9 - abstime * 0.8 + ${wobble(5, -1.2)}`, 9.9),
  });
  // Light: the room stays black; a cool soft top from in front of the car catches the bar tops
  // and the surround; a hard point just above the camera puts the surround's highlight where
  // the streak glass lifts it into columns — and it dims through the cut, so they retract.
  for (const id of ["fill", "carKey", "sodiumPool", "sodiumA", "sodiumB"]) if (plate.has(id)) plate.remove(id);
  plate.add("splitTop", "light", { kind: "point", position: [ox - 0.2, oy + 1.6, oz + 1.6], color: [0.82, 0.94, 1, 1], intensity: 1.6 }, { label: "light_splittop" });
  plate.add("splitGlint", "light", { kind: "point", position: [ox - 0.3, oy + 0.9, oz + 1.25], color: [0.85, 0.95, 1, 1], intensity: knob(`1.5 * (1 - ${FADE} * 0.85)`, 1.5) }, { label: "light_splitglint" });
  // no headlight projectors: the sedan's own sits behind its grille and floods the bars from inside
  plate.set("shot", { lights: "light_splittop light_splitglint", projectors: "", environmentIntensity: 0.8 });
  // the room the lacquer mirrors at a grazing angle: a ring of vertical LED bars in the dark
  const env = plate.node("env");
  plate.nodes.set("env", { ...env, parameters: {} });
  plate.set("env", { source: SPLIT_ENV_WGSL, tubes: 2.6, tubeFrom: -0.4, tubeTo: 2.6, tubeCount: 7, tubeTop: 0.75, tubeWidth: 0.32, sodium: 0.2, panel: 2, wall: 1.2, wallDir: [-0.85, 0.25, 0.45], room: 0.004, roof: 1.2 });
  // the lamp glass shell would draw the sedan's headlight cover as a hot band in the corner
  if (plate.nodes.has("geo_lampglint")) plate.dropFromList("shot", "scenes", "geometry_lampglint");
  // focus on the ornament; the grille's far half falls soft
  plate.set("lens_dof", { focusDistance: 1.47, aperture: 2.2 * scale, maxRadius: 22 * scale });
  // CALM and SOFT, as the reference's (the owner: "not overpowered by the lights"): a thin even
  // fog over the whole plate (in-scatter that grows with depth), no headlight cones in it
  plate.set("haze", { density: 0.08, ambient: [0.03, 0.036, 0.04], head: 0 });
  // The streak columns RETRACT through the cut (never jitter): the reach falls to a third.
  const reach = 0.42;
  const reachExpr = `(${reach} * (1 - 0.65 * ${FADE}))`;
  ([[0, 400], [1, 60], [2, 20]] as const).forEach(([index, div]) => plate.set(`streak${index}`, { step: knob(`${reachExpr} / ${div}`, reach / div) }));
  // one soft column: the streaks' own source is main's clipped-lamps pass; the bloom stays soft
  plate.set("optics", { streak: 0.7, bloom: 0.25 });
  plate.set("streakSrc", { threshold: 2.2 });
  plate.set("lens", { vignette: 0, distortion: 0.02 });
  plate.set("grade", { exposure: 0.35, black: 0.03, contrast: 1.2, saturation: 0.7, steel: [0.9, 1.02, 1.05], shadowTint: [0.92, 1.02, 1.05, 1], split: 0.6 });
  return plate;
}

/** The RIGHT plate: the figure's feet on the white floor, from above, a hard shadow thrown up-left. */
function floorPlate(facts: OnNothingFacts, build: Builder, options: SplitOptions): Plate {
  // the white limbo (shots/cyc.ts): its walker's wardrobe (wide cropped trousers, chunky shoes)
  // is the reference's split-screen figure too
  const plate = new Plate(build(facts, { ...options, shot: "cyc", crt: false, hdri: false, audio: false }));
  plate.bypass("trail");
  // The figure stands still at the origin (inside the key's shadow volume), facing the lens,
  // and shuffles its right foot out and back.
  const skin = soleCycFigure(plate);
  // (the wardrobe's soles sit 2.4 cm under the rest figure's floor: lift it onto the floor)
  plate.set(skin, { place: [0, 0.022, 0], yaw: 0, ...standingPose(facts) });
  // contact: a tight, strong occlusion under the soles (the reference's shoes sit in a dark rim)
  plate.set("occlusion", { radius: 0.22, strength: 1.3 });
  // The camera, FITTED to the reference (frame 56): the shoes' toes and heels at uv (0.745, 0.45),
  // (0.74, 0.36), (0.625, 0.41), (0.665, 0.31), the trouser hems near 0.27, the knees just past
  // the top edge (a solve at a fixed 24 deg; residuals under 0.03 but for the hem). A long lens
  // from 2.6 m, 35 deg down: the floor fills the frame below the feet.
  const eye = [0.321, 1.44, 2.35] as const;
  const look = [-0.504, -0.33, 0.134] as const;
  plate.clearSlots("cam", "eye");
  plate.clearSlots("cam", "lookAt");
  plate.set("cam", {
    ...vectorKnobs("eye", [`${eye[0]} + ${wobble(6, 0.005)}`, `${eye[1]} + ${wobble(7, 0.004)}`, `${eye[2]}`], [eye[0], eye[1], eye[2]]),
    ...vectorKnobs("lookAt", [`${look[0]} + ${wobble(8, 0.006)}`, `${look[1]}`, `${look[2]} + ${wobble(9, 0.005)}`], [look[0], look[1], look[2]]),
    fov: 24,
    // (the solve's +3.5 deg: loom's roll turns the solve's way since schema 5, T1433b)
    roll: knob(`3.5 - abstime * 0.6 + ${wobble(10, -0.9)}`, 3.5),
  });
  // A hard key from the right and a little behind the lens: the legs' shadows run up and left
  // across the floor from the shoes, crisp, as the reference's; little fill, so they read dark.
  cycKey(plate, { intensity: 4.6, shadowSoftness: 1, direction: [-0.35, -0.55, -0.76], shadowExtent: 2.5 });
  plate.set("shot", { ambientIntensity: 0.3 });
  // the plate's falloff is the pool of light, drawn in the matte composite (SPLIT_WGSL)
  plate.set("lens", { vignette: 0, distortion: 0.02 });
  plate.set("finish", { exposure: -1.2, vignette: 0, broad: 0 });
  return plate;
}

/** The split-screen document: both plates in one graph, the matte composite, the Output. */
export function splitDocument(facts: OnNothingFacts, build: Builder, options: SplitOptions): ProjectDocument {
  const left = carPlate(facts, build, options).prefixed("car");
  const right = floorPlate(facts, build, options).prefixed("floor");
  const outs = [...left.edges, ...right.edges].filter((entry) => entry.target.nodeId.endsWith("_out"));
  const leftLast = left.edges.find((entry) => entry.target.nodeId === "car_out");
  const rightLast = right.edges.find((entry) => entry.target.nodeId === "floor_out");
  if (leftLast === undefined || rightLast === undefined) throw new Error("splitDocument: a plate has no Output.");
  const nodes = [...left.nodes, ...right.nodes].filter((entry) => entry.id !== "car_out" && entry.id !== "floor_out");
  const edges = [...left.edges, ...right.edges].filter((entry) => !outs.includes(entry));
  const matte: Record<string, StoredParameter> = {
    source: SPLIT_WGSL,
    // MEASURED on frames 53-80 (10 % grid over frame 59): the valley's floor at x 0.47 at the
    // top, 0.505 at the bottom (along the grille surround's right edge); the left picture holds
    // to x ~0.45, the right one climbs from ~0.49 to full at ~0.58
    seam: 0.47,
    tilt: 0.035,
    softLeft: 0.08,
    softRight: 0.11,
    smoke: 0.012,
    floorLevel: 0.12,
    // the cut's first frame is the floor plate alone
    reveal: knob("clamp(abstime * 100 - 3, 0, 1)", 1),
    leftVignette: 0.8,
    poolCentre: [0.66, 0.35],
    poolWidth: 0.75,
    poolTint: [0.8, 1.0, 1.08, 1],
  };
  nodes.push(node("split", "customWgslMulti", [900, 0], {}, { parameters: matte, label: "wgsl_split", resolution: { mode: "project" } }));
  nodes.push(node("out", "output", [1100, 0], {}, { parameters: { toneMap: "none" }, label: "output1" }));
  edges.push(edge("floor-split", [rightLast.source.nodeId, rightLast.source.portId], ["split", "input"]));
  edges.push(edge("car-split", [leftLast.source.nodeId, leftLast.source.portId], ["split", "more"], 0));
  if (options.crt === true) {
    nodes.push(node("crt", "customWgsl", [1000, 0], {}, { parameters: { source: CRT_WGSL, amount: 1 }, label: "wgsl_crt", resolution: { mode: "project" } }));
    edges.push(edge("split-crt", ["split", "out"], ["crt", "input"]));
    edges.push(edge("crt-out", ["crt", "out"], ["out", "input"]));
  } else {
    edges.push(edge("split-out", ["split", "out"], ["out", "input"]));
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    projectId: "project-on-nothing-split",
    name: "On Nothing · split",
    graph: graph(nodes, edges),
    settings: settings({
      outputResolution: { width: options.width ?? 1920, height: options.height ?? 818 },
      randomSeed: 7,
      // two plates, each a full chain: --final (2x) needs about 3.2 GB
      limits: { ...LIMITS, memoryBudgetBytes: 5_368_709_120 },
    }),
    assets: [],
    createdAt: "2026-09-27T00:00:00.000Z",
    updatedAt: "2026-09-27T00:00:00.000Z",
  };
}
