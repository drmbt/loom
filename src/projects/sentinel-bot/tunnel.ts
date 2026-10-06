import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { CAMERA_PARAMS, VIEW } from "../furnace/screen-space.ts";
import { CHAMBERS, PATH, chamberAt, chamberExpression, chamberWgsl, pathExpression, pathWgsl } from "./path.ts";

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
 * to stand on, and every 96 m a chamber where the bore opens out into a hall. Until a swept surface and instanced modules exist (§T1587b, §T1581b) this grid
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

/**
 * WHAT COLOUR A LAMP IS, by its station along the tunnel. Cold in the bore, sodium in the
 * halls, and every fifteenth an emergency red. One rule with two readers that must agree,
 * because a lamp is drawn twice: its plate glows in the wall's material (WGSL) and the nearest
 * three are real lights whose colour is an expression. So the rule is whole numbers and the
 * chamber function, exact in both, and never a float hash that 32 and 64 bits would round apart.
 */
export const LAMP_TONES = {
  bore: [0.62, 0.84, 1],
  hall: [1, 0.62, 0.28],
  alarm: [1, 0.1, 0.06],
  /** Every this-many stations one is an alarm; it divides the stations in a period, so the wrap does not recolour a lamp. */
  alarmEvery: 15,
  alarmAt: 7,
} as const;

/**
 * How much of its light each lamp of a run of fifteen still gives: a third of them give a
 * fifth of it or less (two of those no more than a filament's glow) and a fifth are failing, so the tunnel is dark for stretches and the robot crosses them by
 * its own eyes. (The owner, 2026-10-05: "it shouldn't look like a hospital".) The alarm is lit.
 * A tone below is this times the lamp's colour, so the plate, its light, the dust and the
 * steel's reflection of it all go dark together.
 */
// Turns 3 and 11 stay lit: with a hall every seven and a half stations, those are the lamps in the halls.
export const LAMP_GAINS: readonly number[] = [1, 0.2, 1, 1, 0.06, 0.4, 1, 1, 0.2, 0.06, 0.4, 1, 1, 0.2, 0.4];
if (LAMP_GAINS.length !== LAMP_TONES.alarmEvery || LAMP_GAINS[LAMP_TONES.alarmAt] !== 1) throw new Error("tunnel.ts: LAMP_GAINS is one gain per station of a run, and the alarm is lit.");

const STATIONS = Math.round(PATH.period / LAMP_SPACING);
if (STATIONS % LAMP_TONES.alarmEvery !== 0) throw new Error(`tunnel.ts: ${LAMP_TONES.alarmEvery} does not divide the ${STATIONS} lamp stations of a period.`);

/** The rule itself: the tone of the lamp at a whole station number. */
export function lampTone(station: number): readonly [number, number, number] {
  const turn = station - LAMP_TONES.alarmEvery * Math.floor(station / LAMP_TONES.alarmEvery);
  if (turn === LAMP_TONES.alarmAt) return LAMP_TONES.alarm;
  const gain = LAMP_GAINS[turn] as number;
  const tone = chamberAt((station + 0.5) * LAMP_SPACING) > 0.5 ? LAMP_TONES.hall : LAMP_TONES.bore;
  return [tone[0] * gain, tone[1] * gain, tone[2] * gain];
}

/** The same rule as three expressions of a station number (itself an expression). */
export function lampToneExpression(station: string): readonly [string, string, string] {
  const alarm = `(mod(${station}, ${LAMP_TONES.alarmEvery}) == ${LAMP_TONES.alarmAt})`;
  const hall = `(${chamberExpression(`((${station}) + 0.5) * ${LAMP_SPACING}`)} > 0.5)`;
  // The gain of its place in the run: the sum of the gains whose turn this is (a dead lamp adds nothing).
  const turn = `mod(${station}, ${LAMP_TONES.alarmEvery})`;
  const gain = `(${LAMP_GAINS.map((value, index) => (value === 0 ? "" : `(${turn} == ${index}) * ${value}`)).filter((term) => term !== "").join(" + ")})`;
  const channel = (index: 0 | 1 | 2): string => `(${alarm} * ${LAMP_TONES.alarm[index]} + (1 - ${alarm}) * ${gain} * (${hall} * ${LAMP_TONES.hall[index]} + (1 - ${hall}) * ${LAMP_TONES.bore[index]}))`;
  return [channel(0), channel(1), channel(2)];
}

const wgslTone = (tone: readonly number[]): string => `vec3f(${tone.map((component) => component.toFixed(4)).join(", ")})`;

/** The rule as WGSL, for the wall's material and the motes. Needs `chamberAt` beside it. */
const LAMP_TONE_WGSL = `const LAMP: f32 = ${LAMP_SPACING.toFixed(5)};
const LAMP_GAIN = array<f32, ${LAMP_GAINS.length}>(${LAMP_GAINS.map((gain) => gain.toFixed(2)).join(", ")});
// The light of the lamp at a station (tunnel.ts, LAMP_TONES and LAMP_GAINS): cold in the bore, sodium in a hall,
// every fifteenth an alarm; and of every run of fifteen, some are dead and some failing.
fn lampTone(station: f32) -> vec3f {
  let turn = station - ${LAMP_TONES.alarmEvery}.0 * floor(station / ${LAMP_TONES.alarmEvery}.0);
  if (abs(turn - ${LAMP_TONES.alarmAt}.0) < 0.5) { return ${wgslTone(LAMP_TONES.alarm)}; }
  let gain = LAMP_GAIN[u32(clamp(turn + 0.5, 0.0, ${LAMP_GAINS.length - 1}.5))];
  return mix(${wgslTone(LAMP_TONES.bore)}, ${wgslTone(LAMP_TONES.hall)}, step(0.5, chamberAt((station + 0.5) * LAMP))) * gain;
}
`;

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

  // In a chamber the bore opens out into a hall (path.ts, CHAMBERS).
  let bore = ctx.params.bore * (1.0 + CHAMBER_SWELL * chamberAt(z));
  let liner = bore + 0.05;
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
    radius = min(radius, mix(radius, bore - 0.12, rib * ctx.params.relief));
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
 * The wall's surface: OLD, and mostly DRY. Soot-black concrete segments stained with rust
 * where water has run down from the ribs, a tide of silt toward the deck, iron ribs gone to
 * rust, pipes whose paint is coming off. It is matt nearly everywhere; water shines only in
 * the narrow tracks it still runs in and where it stands on the deck, so a highlight is an
 * event. (The owner, 2026-10-05: "too shiny all around, not dark and gritty and grimy
 * enough … the tunnel is very grey".) The lamps are plates in the crown that glow.
 */
export const BORE_SURFACE_WGSL = `// @use surface-detail
struct Params {
  wet: f32, // @default 0.4  How much water still runs: the tracks down the wall and the pools on the deck.
  grime: f32, // @default 0.85  Rust, soot and silt.
  lamp: f32, // @default 14  Radiance of the lamp plates in the crown.
};

${chamberWgsl()}${LAMP_TONE_WGSL}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let what = s.tint.r;
  let own = s.tint.g;
  let around = s.tint.b;
  let along = s.tint.a;
  // 0 at the crown, 1 at the bottom of the bore.
  let low = abs(around - 0.5) * 2.0;
  let stain = detailFbm(s.world * 0.55, 4, s.footprint);
  let spall = detailFbm(s.world * 4.3, 4, s.footprint);
  let grit = detailFbm(s.world * 31.0, 3, s.footprint);
  // Water comes down the wall: tracks a hand wide that run the long way round it.
  let track = detailFbm(vec3f(along * 7.0, around * 2.2, 3.0), 3, s.footprint).value;
  let run = smoothstep(0.6, 0.72, track) * (0.35 + 0.65 * low);
  let dirt = p.grime * smoothstep(0.3, 0.72, stain.value);
  let pit = smoothstep(0.52, 0.8, spall.value);

  // The liner: concrete segments, each cast on its own day.
  var albedo = mix(vec3f(0.03, 0.03, 0.032), vec3f(0.16, 0.135, 0.105), 0.25 + 0.75 * own) * (0.55 + 0.6 * stain.value);
  var rough = 0.9;
  var metal = 0.0;
  var relief = 0.14;
  if (what > 2.5) {
    // The deck: plate steel under silt.
    albedo = mix(vec3f(0.04, 0.038, 0.036), vec3f(0.09, 0.066, 0.04), dirt);
    rough = 0.78;
    metal = 0.5 * (1.0 - dirt);
    relief = 0.09;
  } else if (what > 1.5) {
    // Pipes and cable runs: ochre, oxide green or red lead, flaking to the iron.
    let paint = mix(mix(vec3f(0.13, 0.105, 0.03), vec3f(0.03, 0.07, 0.052), step(0.34, own)), vec3f(0.12, 0.03, 0.02), step(0.67, own));
    albedo = mix(paint, vec3f(0.06, 0.05, 0.046), pit);
    rough = 0.66;
    metal = 0.55 * pit;
    relief = 0.06;
  } else if (what > 0.5) {
    // Ribs: iron, mostly rust.
    albedo = mix(vec3f(0.05, 0.048, 0.05), vec3f(0.16, 0.066, 0.026), 0.35 + 0.65 * smoothstep(0.25, 0.7, spall.value) * p.grime);
    rough = 0.74;
    metal = 0.6 * (1.0 - pit);
    relief = 0.08;
  }
  // Rust and soot: brown where water has carried it, black where nothing has washed it.
  albedo = mix(albedo, vec3f(0.15, 0.062, 0.024), run * p.grime * 0.75);
  albedo = mix(albedo, vec3f(0.014, 0.014, 0.015), dirt * 0.55);
  // Silt at the foot of the wall.
  let silt = p.grime * smoothstep(0.62, 0.86, low + (stain.value - 0.5) * 0.25) * step(what, 2.5);
  albedo = mix(albedo, vec3f(0.07, 0.052, 0.034), silt * 0.8);
  // What still shines: the running tracks, and pools where the deck dips.
  let pool = step(2.5, what) * smoothstep(0.5, 0.62, stain.value);
  let film = clamp(p.wet * max(run * 0.9, pool), 0.0, 1.0);
  rough = mix(rough + 0.08 * (grit.value - 0.5), 0.12, film);
  albedo = albedo * (1.0 - 0.35 * film);

  o.albedo = vec4f(albedo, 1.0);
  o.roughness = clamp(rough, 0.06, 1.0);
  o.metallic = metal * (1.0 - film);
  // Pitted and spalled where dry; water lies flat.
  // (Fine grit in the normal made every lit metre of wall sparkle: it roughens, it does not glint.)
  o.normal = detailBump(s.normal, stain.gradient * 0.55 * 0.4 + spall.gradient * 4.3 * 0.42 + grit.gradient * 31.0 * 0.025, relief * (1.0 - 0.85 * film));

  // A lamp plate in the crown at every lamp station; each has its own steadiness.
  let station = floor(along / LAMP);
  let onPlate = (1.0 - smoothstep(0.3, 0.36, abs(along - (station + 0.5) * LAMP))) * (1.0 - smoothstep(0.012, 0.016, abs(around - 0.5)));
  let nerve = fract(sin(station * 12.9898) * 43758.5453);
  let flicker = 1.0 - step(0.82, nerve) * step(0.6, fract(sin(floor(s.absTime * 11.0) * 78.233 + station) * 43758.5453)) * 0.8;
  o.emissive = o.emissive + lampTone(station) * p.lamp * onPlate * flicker;
  return o;
}`;

/** How many lamp stations either side of the robot's own a mirror on it can show, and the air can glow round: five lamps, 64 m of tunnel. */
/**
 * How bright a lamp's beam of lit air is against the same lamp as a bare point. Set by eye in a hall, where
 * the lens is often inside a beam: at 2.5 the whole frame went to milk, at 1 the cone shows and the walls
 * keep their dark.
 */
export const BEAM_GAIN = 1;
/** A lamp's light hangs this far under its plate, metres: a point light in the wall's own surface lights nothing. */
export const LAMP_HANGS = 0.35;
/**
 * How high the lamp at `z` along the tunnel hangs, as an expression: under its plate, wherever the wall there
 * holds it. A hall's crown is higher (path.ts, CHAMBERS); left at the plain bore's height the light, its lit air
 * and its picture in the steel all hung metres under the plate in a hall (the owner, 2026-10-06: "this random
 * sphere that is visible with like a gap").
 */
export function lampHeightExpression(z: string, bore: string): string {
  return `${pathExpression(z).y} + ${bore} * (1 + ${CHAMBERS.swell} * ${chamberExpression(z)}) - ${LAMP_HANGS}`;
}
export const LAMPS_MIRRORED = 2;
/** The lamps a pass is handed: the station the robot is under and `LAMPS_MIRRORED` either side. */
const NEAR_LAMPS = Array.from({ length: LAMPS_MIRRORED * 2 + 1 }, (_, index) => index);
/** The parameter that carries where lamp `index` of those hangs (document.ts drives it from the lights' own expression). */
export const lampParameter = (index: number): string => `lamp${index}`;
/** Those parameters, as lines of a WGSL Params struct. */
export const LAMP_PARAMS_WGSL = `${NEAR_LAMPS.map((index) => `  ${lampParameter(index)}: vec3f, // @default [0, 2.25, ${((index - LAMPS_MIRRORED + 0.5) * LAMP_SPACING).toFixed(1)}]  Where the lamp ${index - LAMPS_MIRRORED} stations on from the robot's own hangs.`).join("\n")}
  station: f32, // @default 37  The station the robot is under: which lamp is which tone.`;

/**
 * THE TUNNEL AS A GLOSSY THING IN IT SEES IT. Blackened steel has no diffuse, so between two
 * lamps the robot is a hole in the picture unless something is reflected in it. This is what
 * is there to reflect: a lamp plate at the crown, in its own tone, and the pool of lit liner
 * round it, as a ray from a place sees them. The hull's material looks the nearest lamps up
 * along its mirror direction (surface.ts), so as the robot travels the plates pass overhead
 * and their highlights run along the hull.
 *
 * A picture of the lamps, not a second set of them: the plate's size is the wall's own
 * (BORE_SURFACE_WGSL), and where each hangs is handed in, from the same expression that
 * places the lights (document.ts), so the shader does no path arithmetic per pixel.
 *
 * Why not the Render's Environment input, which is the stock way to give a mirror something to
 * show: tried first (an equirect of this same picture, 512×256). In the app the header's GPU
 * time went from about 4.5 ms to about 5.6 ms a frame, the same with 8 taps, 2 taps or
 * prefiltered, because every lit pixel of the tunnel pays for it and only the robot wanted
 * it. (Smallest of five readings per document, four documents back to back, twice, on a
 * machine other sessions were loading: a direction, not a number to quote.) Here only the
 * robot's pixels pay, and each reads the lamps from where it is, not from the robot's middle.
 */
export const LAMP_SEEN_WGSL = `${chamberWgsl()}${LAMP_TONE_WGSL}
// What a ray going up (d.y > 0) from \`here\` sees of the lamp of \`station\` hanging at \`lampAt\`, in the level
// plane it hangs in. \`pool\` is the lit liner round the plate as a share of the plate's radiance; \`soft\`
// widens the plate's edge, metres (a rough mirror).
fn lampSeen(d: vec3f, here: vec3f, lampAt: vec3f, station: f32, pool: f32, soft: f32) -> vec3f {
  let lamp = lampAt - here;
  // The tunnel climbs and falls: a lamp below this height is round a bend of it.
  if (lamp.y < 0.3) { return vec3f(0.0); }
  let hit = d * (lamp.y / d.y);
  let across = hit.x - lamp.x;
  let along = hit.z - lamp.z;
  let plate = (1.0 - smoothstep(0.2, 0.26 + soft, abs(across))) * (1.0 - smoothstep(0.3, 0.36 + soft, abs(along)));
  let lit = exp(-(across * across + along * along) / 3.0) * pool;
  // Air between: a far lamp is a dim one.
  return lampTone(station) * (plate + lit) * exp(-length(hit) * 0.035);
}
`;

/**
 * AIR. Two things, in one pass over the lit frame and the Render's Depth:
 *
 *   haze   the far wall goes into a cold murk that is never quite black, so what stands in
 *          front of it has an outline;
 *   glow   the air itself is lit under every lamp and round the robot's face: what each pixel's
 *          ray picks up on its way to the wall, in even air. Both have a closed form, so there
 *          is no marching. The face is a point (the integral of 1/d² along a line is an
 *          arctangent): a halo. A lamp is a plate that shines down (the cube of the cosine off
 *          straight down, which integrates without an arctangent): a cone hanging from the
 *          plate, and nothing above it. No shadows in either: not shafts between the ribs.
 *
 * (The owner, 2026-10-05: "volumetric light or an approximation could be neat"; "we still
 * missing some haze or something. it looks too clean".) Until a stock haze exists (§T1402b)
 * this is the piece's own; the view helpers are the furnace's.
 */
export const HAZE_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
${CAMERA_PARAMS}
  density: f32, // @default 0.04  How fast the air closes in, per metre.
  color: vec3f, // @default [0.016, 0.04, 0.044]  What the far end of the tunnel fades to: never black.
  glow: f32, // @default 0.002  How much of a light the air between throws at the lens.
${LAMP_PARAMS_WGSL}
  lamp: f32, // @default 26  The lamps' intensity, as their lights have it.
  eyesAt: vec3f, // @default [0, 0, 0.9]  Where the robot's face is.
  eyeColor: vec3f, // @default [1, 0.04, 0.04]  Its light's colour.
  eyes: f32, // @default 1.6  …and intensity, as its light has it.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
${VIEW}
${chamberWgsl()}${LAMP_TONE_WGSL}
// A lamp's light hangs this far under its plate (document.ts, lampAt); its lit air starts at the plate.
const LAMP_HANGS: f32 = ${LAMP_HANGS.toFixed(2)};
const BEAM_GAIN: f32 = ${BEAM_GAIN.toFixed(2)};
// How much of a point light at \`light\` the air along a ray throws back, per unit of the light and of the air's
// own share: the integral of 1/d² from the lens out to \`reach\` metres, dimmed by the air it then crosses.
fn airlight(origin: vec3f, ray: vec3f, reach: f32, light: vec3f) -> f32 {
  let q = origin - light;
  let b = dot(ray, q);
  // No nearer than a lamp is wide: a ray through the lamp itself is a bright core, not infinity.
  let c = sqrt(max(dot(q, q) - b * b, 0.03));
  let nearest = clamp(-b, 0.0, reach);
  return (atan((reach + b) / c) - atan(b / c)) / c * exp(-nearest * params.density);
}

// The same for a LAMP, which is not a point: it is a plate in the crown that shines down, most straight down
// and nothing above its own height (the cube of the cosine off straight down). So its lit air is a cone
// hanging from the plate, not a ball round a point under it. That integral is closed too, and has no
// arctangent in it: with s the distance along the ray from its nearest point to the plate, c that nearest
// distance, and the depth under the plate there under + sink * s, it is the integral of
// (under + sink * s)³ / (s² + c²)^(5/2), taken over the part of the ray that is below the plate.
// A hall's lamp is the bigger lamp, by the square of how much higher it hangs (document.ts, lampAt).
fn hallLamp(z: f32) -> f32 {
  let high = 1.0 + CHAMBER_SWELL * chamberAt(z);
  return high * high;
}

fn beamUpTo(s: f32, c2: f32, under: f32, sink: f32) -> f32 {
  let r2 = s * s + c2;
  let r3 = r2 * sqrt(r2);
  let j0 = s / (3.0 * c2 * r3) + 2.0 * s / (3.0 * c2 * c2 * sqrt(r2));
  let j1 = -1.0 / (3.0 * r3);
  let j2 = s * s * s / (3.0 * c2 * r3);
  let j3 = -(3.0 * s * s + 2.0 * c2) / (3.0 * r3);
  return under * under * under * j0 + 3.0 * under * under * sink * j1 + 3.0 * under * sink * sink * j2 + sink * sink * sink * j3;
}

fn beamlight(origin: vec3f, ray: vec3f, reach: f32, plate: vec3f) -> f32 {
  let q = origin - plate;
  let b = dot(ray, q);
  let c2 = max(dot(q, q) - b * b, 0.03);
  let sink = -ray.y;
  let under = b * ray.y - q.y;
  var s0 = b;
  var s1 = reach + b;
  if (sink > 1e-4) {
    s0 = max(s0, -under / sink);
  } else if (sink < -1e-4) {
    s1 = min(s1, -under / sink);
  } else if (under <= 0.0) {
    return 0.0;
  }
  if (s1 <= s0) { return 0.0; }
  let nearest = clamp(-b, s0 - b, s1 - b);
  return max(beamUpTo(s1, c2, under, sink) - beamUpTo(s0, c2, under, sink), 0.0) * BEAM_GAIN * exp(-nearest * params.density);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let lit = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let view = makeView();
  let ray = rayAt(view, uv);
  let z = viewDepth(uv);
  // Nothing drawn here: the tunnel's own dark, all haze.
  let reach = select(z / max(dot(ray, view.forward), 1e-4), params.far, z < 0.0);
  let clear = exp(-reach * params.density);
  var air = params.eyeColor * params.eyes * airlight(params.eye, ray, reach, params.eyesAt);
${NEAR_LAMPS.map((index) => `  air = air + lampTone(params.station + ${(index - LAMPS_MIRRORED).toFixed(1)}) * params.lamp * hallLamp(params.${lampParameter(index)}.z) * beamlight(params.eye, ray, reach, params.${lampParameter(index)} + vec3f(0.0, LAMP_HANGS, 0.0));`).join("\n")}
  return vec4f(mix(params.color, lit.rgb, clear) + air * params.glow, lit.a);
}`;

/** Dust in the air: how many motes, and how long a stretch of tunnel they fill round the robot. */
export const MOTE_COUNT = 6000;
const MOTE_SPAN = 60;
const MOTES_BEHIND = 14;

export const MOTE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  // The light a mote throws back, already multiplied out (additive, unlit); alpha is its size as a multiple of the draw's.
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 1] },
]);

/**
 * AIR: motes hanging in the tunnel, each lit by the lamp it is nearest and by the robot's
 * eyes, so the light has something to be seen in before it reaches a wall. A mote keeps its
 * place in the tunnel while the window of them rides with the robot; it is the same wrapping
 * the wall's rows do. Billboards, additive, unlit: the kernel does their lighting.
 */
export const MOTE_KERNEL = `// T1561b — dust in the tunnel's air (src/projects/sentinel-bot/tunnel.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the tunnel, metres.
  bore: f32, // @default 2.6  The tunnel's radius, metres.
  lamp: f32, // @default 26  The lamps' intensity, as their lights have it.
  eyes: f32, // @default 8  The eyes' light, as its light has it.
  eyeColor: vec3f, // @default [1, 0.04, 0.04]  Its colour.
  amount: f32, // @default 1  How much of the dust shows: 0 none.
};
${pathWgsl()}${LAMP_TONE_WGSL}
fn moteHash(a: u32, b: u32) -> f32 {
  let x = (a * 747796405u) ^ (b * 2891336453u + 12345u);
  let w = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return f32((w >> 22u) ^ w) / 4294967295.0;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let start = ctx.params.travel - ${MOTES_BEHIND}.0;
  // Its own place along the tunnel, in whichever span of it the window is over now.
  let home = moteHash(ctx.index, 1u) * ${MOTE_SPAN}.0;
  let z = start + (home - start) - ${MOTE_SPAN}.0 * floor((home - start) / ${MOTE_SPAN}.0);
  let wall = pathFrame(z);
  let reach = ctx.params.bore * (1.0 + CHAMBER_SWELL * chamberAt(z)) * 0.9;
  let angle = moteHash(ctx.index, 2u) * 6.2831853;
  let radius = sqrt(moteHash(ctx.index, 3u)) * reach;
  let nerve = moteHash(ctx.index, 4u);
  // It hangs, and drifts a hand's width on a slow count of its own.
  let drift = vec2f(sin(ctx.absTime * (0.11 + nerve * 0.2) + nerve * 40.0), cos(ctx.absTime * (0.09 + nerve * 0.17) + nerve * 23.0)) * 0.12;
  var across = vec2f(cos(angle), sin(angle)) * radius + drift;
  // Nothing hangs under the deck.
  across.y = max(across.y, -ctx.params.bore * 0.7);
  q.position = wall.origin + wall.right * across.x + wall.up * across.y;

  // The lamp it is nearest, and the robot's eyes: inverse square, as the lights themselves fall off.
  let station = floor(z / LAMP);
  let lampAt = pathFrame((station + 0.5) * LAMP);
  // Under the plate, wherever the wall there holds it: a hall's crown is higher (CHAMBERS).
  let toLamp = lampAt.origin + lampAt.up * (ctx.params.bore * (1.0 + CHAMBER_SWELL * chamberAt((station + 0.5) * LAMP)) - ${LAMP_HANGS.toFixed(2)}) - q.position;
  let eyesAt = pathAt(ctx.params.travel + 0.9);
  let toEyes = eyesAt - q.position;
  let lit = lampTone(station) * ctx.params.lamp / (1.0 + dot(toLamp, toLamp)) + ctx.params.eyeColor * ctx.params.eyes / (0.3 + dot(toEyes, toEyes));
  let twinkle = 0.55 + 0.45 * sin(ctx.absTime * (0.8 + nerve * 2.5) + nerve * 60.0);
  q.tint = vec4f(lit * (0.006 * ctx.params.amount * twinkle), 0.5 + nerve);
  return q;
}`;
