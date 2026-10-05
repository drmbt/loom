import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { pathWgsl } from "./path.ts";

/**
 * T1561b — THE TUNNEL: a bore the robots climb, as geometry inside the Render.
 *
 * It is a lit surface, not a raymarched backdrop, so the robots' lights fall on it, its lamps
 * fall on them, and a tentacle's shadow lands on a wall that is really there
 * (docs/td-notch-mechanisms-2026-10-05.md: neither TouchDesigner nor Notch gives a raymarched
 * pass the scene's lights unless the renderer takes it natively).
 *
 * One grid, bent: columns run round the bore, rows along it. A window of it rides with the
 * robots and its rows are laid at fixed distances, so the wall stands still while the window
 * slides and nothing swims. The relief is a function of the angle and the distance: a rib
 * every 1.6 m, pipes and cable runs along the walls, plates set a little in or out, a flat deck
 * to stand on. Until a swept surface and instanced modules exist (§T1587b, §T1581b) this grid
 * IS the tunnel; when they do, the ribs and pipes become modules and this the liner behind them.
 */

/** Columns round the bore and rows along it: 6.5 cm by 15 cm cells, a window of 115 m. */
export const BORE_COLUMNS = 256;
export const BORE_ROWS = 768;
const ROW_SPACING = 0.15;
/** Rows of the window that lie behind the robots. */
const ROWS_BEHIND = 180;
/** Metres between ribs, and between the lamps in the crown. */
export const RIB_SPACING = 1.6;
export const LAMP_SPACING = 12.8;

export const BORE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  // What the wall is here, for its material: r 0 liner, 1 rib, 2 pipe, 3 deck; g the plate's own random; b the angle round the bore (0 to 1); a the distance along it, metres.
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);

/** Where the pipes and cable runs sit round the bore (radians, 0 = the right wall, π/2 = the crown), and how far each stands off the liner. */
const RUNS: ReadonlyArray<readonly [angle: number, width: number, height: number]> = [
  [0.42, 0.075, 0.13],
  [0.62, 0.035, 0.07],
  [0.7, 0.035, 0.07],
  [2.5, 0.09, 0.15],
  [2.74, 0.03, 0.06],
  [1.18, 0.028, 0.055],
  [1.98, 0.028, 0.055],
  [3.55, 0.05, 0.1],
  [5.85, 0.05, 0.1],
];

export const BORE_KERNEL = `// T1561b — the tunnel's bore (src/projects/sentinel-bot/tunnel.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the tunnel, metres.
  bore: f32, // @default 2.6  Radius the claws plant on, metres: the ribs' crests.
  relief: f32, // @default 1  How much of the ribs, pipes and plates stands off the liner: 0 is a plain pipe.
  deck: f32, // @default 0.74  How far below the axis the flat deck lies, as a share of the radius; 1 or more is no deck.
};
${pathWgsl()}
const ROW: f32 = ${ROW_SPACING.toFixed(5)};
const RIB: f32 = ${RIB_SPACING.toFixed(5)};
const RUNS: u32 = ${RUNS.length}u;
const RUN = array<vec3f, ${RUNS.length}>(${RUNS.map((run) => `vec3f(${run[0].toFixed(4)}, ${run[1].toFixed(4)}, ${run[2].toFixed(4)})`).join(", ")});

fn plate(a: u32, b: u32) -> f32 {
  let x = (a * 747796405u) ^ (b * 2891336453u);
  let w = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return f32((w >> 22u) ^ w) / 4294967295.0;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  // Rows stand at whole multiples of the row spacing, so the wall holds still while the window slides along it.
  let z = (floor(ctx.params.travel / ROW) + f32(ctx.dim.j) - ${ROWS_BEHIND}.0) * ROW;
  // The seam is under the deck: the first and last column are the same line.
  let around = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  let theta = (around - 0.25) * 6.2831853;
  let wall = pathFrame(z);
  let radial = wall.right * cos(theta) + wall.up * sin(theta);

  let liner = ctx.params.bore + 0.05;
  var radius = liner;
  var what = 0.0;
  // Plates: a panel every rib bay and every eighth of a turn, set a little in or out.
  let bay = floor(z / RIB);
  let panel = plate(u32(bay - floor(bay / 600.0) * 600.0), u32(around * 8.0));
  radius = radius - (panel - 0.5) * 0.05 * ctx.params.relief;
  // Pipes and cable runs along the wall.
  let angle = theta - 6.2831853 * floor(theta / 6.2831853);
  for (var i = 0u; i < RUNS; i = i + 1u) {
    let across = abs(angle - RUN[i].x) / RUN[i].y;
    if (across < 1.0) {
      radius = min(radius, liner - RUN[i].z * sqrt(1.0 - across * across) * ctx.params.relief);
      what = 2.0;
    }
  }
  // Ribs: a ring that stands in to the radius the claws plant on.
  let alongBay = abs(z - (bay + 0.5) * RIB);
  let rib = 1.0 - smoothstep(0.08, 0.17, alongBay);
  if (rib > 0.0) {
    radius = min(radius, mix(radius, ctx.params.bore - 0.12, rib * ctx.params.relief));
    what = mix(what, 1.0, step(0.5, rib));
  }
  // The deck: nothing hangs below it.
  let floorAt = ctx.params.bore * ctx.params.deck;
  if (sin(theta) < 0.0 && radius * -sin(theta) > floorAt) {
    radius = floorAt / -sin(theta);
    what = 3.0;
  }
  q.position = wall.origin + radial * radius;
  q.tint = vec4f(what, panel, around, z);
  return q;
}`;

/**
 * The wall's surface. Dark and WET: the highlights carry the picture, so most of this is
 * about where the roughness drops (streaks running down from the crown, a film on the deck)
 * and how the relief catches a lamp. The lamps themselves are plates in the crown that glow.
 */
export const BORE_SURFACE_WGSL = `// @use surface-detail
struct Params {
  wet: f32, // @default 0.7  How much of the wall carries a film of water.
  grime: f32, // @default 0.6  Rust and soot in the recesses.
  lamp: f32, // @default 14  Radiance of the lamp plates in the crown.
  lampColor: vec3f, // @default [0.62, 0.84, 1]  Their colour.
};

const LAMP: f32 = ${LAMP_SPACING.toFixed(5)};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let what = s.tint.r;
  let around = s.tint.b;
  let along = s.tint.a;
  let coarse = detailFbm(s.world * 1.7, 4, s.footprint);
  let fine = detailFbm(s.world * 13.0, 3, s.footprint);
  // Water runs down from the crown in streaks and pools on the deck.
  let streak = detailFbm(vec3f(around * 90.0, along * 0.6, 3.0), 3, s.footprint).value;
  let film = clamp(p.wet * (0.35 + 0.9 * smoothstep(0.42, 0.7, streak) + 0.5 * step(2.5, what)), 0.0, 1.0);
  let recess = smoothstep(0.35, 0.75, coarse.value);

  var albedo = vec3f(0.035, 0.038, 0.042);
  var rough = 0.72;
  var metal = 0.0;
  if (what > 2.5) {
    // The deck: plate steel.
    albedo = vec3f(0.03, 0.031, 0.033);
    rough = 0.5;
    metal = 0.85;
  } else if (what > 1.5) {
    // Pipes and cable runs: painted, chipped.
    albedo = mix(vec3f(0.05, 0.055, 0.06), vec3f(0.07, 0.03, 0.02), step(0.55, s.tint.g));
    rough = 0.45;
    metal = 0.4;
  } else if (what > 0.5) {
    // Ribs: bare steel.
    albedo = vec3f(0.045, 0.046, 0.05);
    rough = 0.4;
    metal = 0.9;
  }
  let rust = recess * p.grime;
  albedo = mix(albedo, vec3f(0.07, 0.028, 0.012), rust * 0.6) * (1.0 - 0.45 * rust);
  rough = mix(rough + 0.2 * rust, 0.07, film);

  o.albedo = vec4f(albedo, 1.0);
  o.roughness = clamp(rough, 0.05, 1.0);
  o.metallic = metal;
  o.normal = detailBump(s.normal, coarse.gradient * 1.7 + fine.gradient * 13.0 * 0.25, 0.05 * (1.0 - 0.7 * film));

  // A lamp plate in the crown at every lamp station; each has its own steadiness.
  let station = floor(along / LAMP);
  let onPlate = (1.0 - smoothstep(0.3, 0.36, abs(along - (station + 0.5) * LAMP))) * (1.0 - smoothstep(0.012, 0.016, abs(around - 0.5)));
  let nerve = fract(sin(station * 12.9898) * 43758.5453);
  let flicker = 1.0 - step(0.82, nerve) * step(0.6, fract(sin(floor(s.absTime * 11.0) * 78.233 + station) * 43758.5453)) * 0.8;
  o.emissive = o.emissive + p.lampColor * p.lamp * onPlate * flicker;
  return o;
}`;

/**
 * Air: the far wall goes into a cold haze. Custom WGSL · Multi over the lit frame and the
 * Render's Depth (view distance ÷ far). Until a stock haze exists (§T1402b) this is the
 * piece's own.
 */
export const HAZE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  density: f32, // @default 0.035  How fast the air closes in, per metre.
  color: vec3f, // @default [0.012, 0.022, 0.034]  What the far end of the tunnel fades to.
  far: f32, // @default 240  The camera's far plane (depth arrives as distance ÷ far).
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let lit = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let size = vec2f(textureDimensions(inputTexture1));
  let depth = textureLoad(inputTexture1, clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1)), 0).r;
  // Nothing drawn here: the tunnel's own dark, all haze.
  let distance = select(depth * params.far, params.far, depth <= 0.0 || depth >= 0.9999);
  let clear = exp(-distance * params.density);
  return vec4f(mix(params.color, lit.rgb, clear), lit.a);
}`;
