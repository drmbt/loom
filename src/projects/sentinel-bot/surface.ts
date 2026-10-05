import { LAMPS_MIRRORED, LAMP_SEEN_WGSL, LAMP_SPACING } from "./tunnel.ts";

/** The lamps the steel can show: the station the robot is under and `LAMPS_MIRRORED` either side. */
const MIRRORED = Array.from({ length: LAMPS_MIRRORED * 2 + 1 }, (_, index) => index);
/** The material parameter that carries where lamp `index` of those hangs (document.ts drives it). */
export const lampParameter = (index: number): string => `lamp${index}`;

/**
 * THE ROBOT'S LIGHTS ARE ONE INSTRUMENT (the owner, 2026-10-05: "they'll be our main instrument to
 * drive audio reactivity"): the lenses of its face and the lines along its tentacles take their
 * colour from one RANGE, two hues the panel names, and each light has a place in it. A hue is
 * 0 to 1 round the wheel (0 red, 1/3 green, 2/3 blue); the range runs the way it is written,
 * so From 0.95 To 1.05 crosses red.
 */
// Thirds of the wheel, as the six decimals all three forms below are written with.
const HUE_OFFSETS = [0, 0.666667, 0.333333] as const;
/** The colour of a hue, as WGSL: full saturation, with a breath of white so a red is the film's and not a laser's. */
export const HUE_WGSL = `fn hueColour(hue: f32) -> vec3f {
  let wheel = clamp(abs(fract(vec3f(hue) + vec3f(${HUE_OFFSETS.map((offset) => offset.toFixed(6)).join(", ")})) * 6.0 - 3.0) - 1.0, vec3f(0.0), vec3f(1.0));
  return wheel * 0.96 + 0.04;
}
`;
/** The same colour as three expressions of a hue (itself an expression), for a light. */
export function hueExpression(hue: string): readonly [string, string, string] {
  const channel = (offset: number): string => `(clamp(abs(fract(${hue} + ${offset.toFixed(6)}) * 6 - 3) - 1, 0, 1) * 0.96 + 0.04)`;
  return [channel(HUE_OFFSETS[0]), channel(HUE_OFFSETS[1]), channel(HUE_OFFSETS[2])];
}
/** The same in plain arithmetic, for a test. */
export function hueColour(hue: number): [number, number, number] {
  const channel = (offset: number): number => Math.min(1, Math.max(0, Math.abs(((((hue + offset) % 1) + 1) % 1) * 6 - 3) - 1)) * 0.96 + 0.04;
  return [channel(HUE_OFFSETS[0]), channel(HUE_OFFSETS[1]), channel(HUE_OFFSETS[2])];
}

/**
 * T1561b — the sentinel's SURFACE: one Material·WGSL that reads which surface a vertex is
 * from the kit's role (`attr.z`, the file's `loom_heat`: 0 shell, 0.2 chrome, 0.4 brass,
 * 0.6 red paint, 0.8 ring core, 1.0 eye lens — tools/blender/sentinel-bot/README.md) and
 * says what that surface is. The look lives here, not in the file.
 *
 * It is an OLD machine (the owner, 2026-10-05: "not so much chrome … gritty", "it doesn't look
 * aged"). Wear is the piece's own, fixed to it and different on every piece (the instance's
 * `seed`): edges rubbed to bare metal, rust where it has stood wet, dust and soot lying on
 * what faces up. With Wear at 0 every surface is the clean one the kit names.
 */
export const HULL_SURFACE_WGSL = `// @use surface-detail
struct Params {
${MIRRORED.map((index) => `  ${lampParameter(index)}: vec3f, // @default [0, 2.25, ${((index - LAMPS_MIRRORED + 0.5) * LAMP_SPACING).toFixed(1)}]  Where the lamp ${index - LAMPS_MIRRORED} stations on from the robot's own hangs.`).join("\n")}
  station: f32, // @default 37  The station the robot is under: which lamp is which tone.
  lamps: f32, // @default 6  Radiance of a lamp plate, as the steel reflects it.
  pool: f32, // @default 0.05  Radiance of the lit liner round a plate, as a share of the plate's.
  deck: f32, // @default 0.2  How much of all that the wet deck throws back up.
  gloss: f32, // @default 0.42  Roughness of the shell where nothing has worn or soiled it.
  steel: f32, // @default 0.3  How much of what it faces the shell throws back: 0.04 is enamel, 0.6 bare steel.
  wear: f32, // @default 0.8  How old it is: rubbed edges, rust, dust. 0 is as the kit left the works.
  hueFrom: f32, // @default 0  The lights' colour range starts at this hue, 0 to 1 round the wheel (0 red).
  hueTo: f32, // @default 0.03  …and ends at this one.
  spread: f32, // @default 0.6  How much of the range the lights are spread over: 0 all one colour, 1 the lenses (and the length of a tentacle) cover it all.
  shift: f32, // @default 0  Moves every light along the range, 0 to 1. Drive it from a level.
  eyeGlow: f32, // @default 9  Radiance of the eye lenses.
  eyeHits: f32, // @default 0  How much the lenses answer the drums instead of burning steadily: a third of them each to kick, snare and hat.
  kick: f32, // @default 0  The kick, 0 to 1 as it decays.
  snare: f32, // @default 0  The snare.
  hat: f32, // @default 0  The hat.
  eyeSweep: f32, // @default 0  How much a band of light crossing the face takes over from the steady glow.
  sweepPhase: f32, // @default 0  Where that band is: it crosses once for each whole number. Drive it from the beat.
  coreGlow: f32, // @default 0.01  Radiance of a tentacle's light lines at rest: barely an ember.
  pulseGlow: f32, // @default 2  Radiance of a line fully charged.
};

// What each drawn piece brings of its own: the rig's point attributes of the same names (rig.ts).
struct Instance {
  charge: f32, // @default 0  How lit this piece's lines are by what runs along the tentacle: 0 at rest, 1 fully.
  seed: f32, // @default 0  Which piece it is, 0 to 1: its wear is its own.
  along: f32, // @default 0  How far along its tentacle it is, 0 at the body to 1 at the claw: its place in the colour range.
};

${HUE_WGSL}
// The colour of the light at a place (0 to 1) in the range.
fn lightColour(place: f32, p: Params) -> vec3f {
  return hueColour(mix(p.hueFrom, p.hueTo, clamp(place * p.spread + p.shift, 0.0, 1.0)));
}

${LAMP_SEEN_WGSL}
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let role = s.attr.z;
  var albedo = vec3f(p.steel * 0.92, p.steel * 0.96, p.steel * 1.05);
  var rough = p.gloss;
  var metal = 1.0;
  // Whether it ages, and whether it is a mirror to the lamps.
  var ages = 1.0;
  var mirrors = 1.0;
  if (role > 0.9) {
    // A lens: black glass over a lamp, brightest where it faces the viewer.
    let facing = max(dot(normalize(s.eye - s.world), s.normal), 0.0);
    // Each lens has a nerve of its own: the eyes are a hand's breadth apart in the robot's frame, so a coarse cell of it names one.
    let lens = floor(s.local * 7.0);
    let nerve = fract(sin(dot(lens, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
    let life = 0.8 + 0.2 * sin(s.absTime * (1.5 + nerve * 4.0) + nerve * 40.0);
    albedo = vec3f(0.006, 0.006, 0.006);
    rough = 0.08;
    metal = 0.0;
    // The drums: a third of the lenses each to kick, snare and hat. With Eye Hits up a lens sits low and flashes on its own drum.
    let drum = select(select(p.hat, p.snare, nerve < 0.667), p.kick, nerve < 0.333);
    let struck = mix(1.0, 0.25 + 2.6 * drum, clamp(p.eyeHits, 0.0, 1.0));
    // A band of light crossing the face from one side to the other, once for each whole number of the phase.
    let band = pow(0.5 + 0.5 * cos(6.2831853 * (s.local.x * 0.9 - p.sweepPhase)), 3.0);
    let swept = mix(1.0, 0.2 + 2.4 * band, clamp(p.eyeSweep, 0.0, 1.0));
    o.emissive = lightColour(nerve, p) * p.eyeGlow * (0.35 + 0.65 * facing * facing) * life * struck * swept;
    ages = 0.0;
    mirrors = 0.0;
  } else if (role > 0.7) {
    // The spine between the rings: dull dark rubber with five thin light lines let into it, lit by
    // whatever runs along the tentacle. Lines, not the whole spine: the spine is half of a tentacle's
    // length, and lit whole it was a row of fat red dashes (twice). Not a mirror, for the same reason.
    albedo = vec3f(0.022, 0.02, 0.02);
    rough = 0.72;
    metal = 0.2;
    let line = smoothstep(0.84, 0.95, cos(atan2(s.local.y, s.local.x) * 5.0));
    o.emissive = lightColour(s.instance.along, p) * (p.coreGlow + p.pulseGlow * s.instance.charge) * line;
    ages = 0.5;
    mirrors = 0.0;
  } else if (role > 0.5) {
    // Red lead paint.
    albedo = vec3f(0.11, 0.012, 0.009);
    rough = 0.5;
    metal = 0.25;
  } else if (role > 0.3) {
    // Brass, long tarnished.
    albedo = vec3f(0.3, 0.2, 0.08);
    rough = 0.45;
  } else if (role > 0.1) {
    // Bright steel that has not been bright for years.
    albedo = vec3f(0.34, 0.345, 0.36);
    rough = 0.36;
  }

  // ── Age ──
  let wear = p.wear * ages;
  var pitted = s.normal;
  if (wear > 0.0) {
    let skin = s.local + vec3f(17.0, 31.0, 7.0) * s.instance.seed;
    let blotch = detailFbm(skin * 2.6, 4, s.footprint).value;
    let wet = detailFbm(skin * 1.4 + vec3f(41.0, 13.0, 29.0), 3, s.footprint).value;
    let grain = detailFbm(skin * 48.0, 3, s.footprint);
    // Scores and scratches: long thin marks the way things have dragged along it, each a hair wide.
    let score = detailFbm(vec3f(skin.x * 55.0, skin.y * 55.0, skin.z * 2.5) + vec3f(9.0), 3, s.footprint).value;
    let scratched = wear * smoothstep(0.7, 0.76, score);
    // Edges and raised detail, rubbed through to the metal.
    let rubbed = clamp(wear * detailEdgeWear(s.curvature, 18.0, grain.value) + scratched * 0.85, 0.0, 1.0);
    albedo = mix(albedo, vec3f(0.55, 0.53, 0.5), rubbed * 0.8);
    rough = mix(rough, 0.3, rubbed * 0.7);
    metal = mix(metal, 1.0, rubbed);
    // Rust where it has stood wet, pitted.
    let rust = wear * smoothstep(0.46, 0.7, wet) * (0.4 + 0.6 * grain.value) * (1.0 - rubbed);
    albedo = mix(albedo, vec3f(0.17, 0.062, 0.022), rust);
    rough = mix(rough, 0.9, rust);
    metal = mix(metal, 0.0, rust);
    // Soot and oil baked on, in patches: darker and duller, still metal underneath.
    let soot = wear * smoothstep(0.38, 0.62, blotch) * (1.0 - rubbed);
    albedo = albedo * (1.0 - 0.6 * soot);
    rough = mix(rough, 0.78, soot * 0.7);
    // Dust lying on what faces up.
    let dust = wear * smoothstep(0.5, 0.75, 1.0 - blotch) * max(s.normal.y, 0.0) * (1.0 - rubbed);
    albedo = mix(albedo, vec3f(0.05, 0.045, 0.038), dust * 0.8);
    rough = mix(rough, 0.96, dust * 0.8);
    metal = mix(metal, 0.0, dust * 0.8);
    // And no patch of it quite as smooth as the next; pitted all over.
    rough = rough + wear * (grain.value - 0.5) * 0.3;
    pitted = detailBump(s.normal, grain.gradient * 48.0, 0.0035 * wear);
  }
  o.normal = pitted;
  o.albedo = vec4f(albedo, 1.0);
  o.roughness = clamp(rough, 0.05, 1.0);
  o.metallic = metal;

  // A mirror shows what is along its mirror direction: the lamps overhead, and their smear in the wet deck
  // below (tunnel.ts). Metal only, and hardly at all once it is rough.
  let view = normalize(s.world - s.eye);
  let mirror = reflect(view, s.normal);
  let soft = o.roughness * 0.6;
  // Looking down, it is the deck's own mirror image of the same lamps, dimmer.
  let up = vec3f(mirror.x, max(abs(mirror.y), 0.02), mirror.z);
  var seen = vec3f(0.0);
${MIRRORED.map((index) => `  seen = seen + lampSeen(up, s.world, p.${lampParameter(index)}, p.station + ${(index - LAMPS_MIRRORED).toFixed(1)}, p.pool, soft);`).join("\n")}
  seen = seen * select(p.deck, 1.0, mirror.y > 0.0);
  // Schlick: at a grazing angle any metal is a full mirror.
  let graze = pow(1.0 - max(dot(-view, s.normal), 0.0), 5.0);
  let polish = (1.0 - o.roughness) * (1.0 - o.roughness);
  o.emissive = o.emissive + seen * p.lamps * mix(o.albedo.rgb, vec3f(1.0), graze) * o.metallic * polish * mirrors;
  return o;
}`;
