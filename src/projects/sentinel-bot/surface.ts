import { LAMPS_MIRRORED, LAMP_SEEN_WGSL, LAMP_SPACING } from "./tunnel.ts";

/** The lamps the steel can show: the station the robot is under and `LAMPS_MIRRORED` either side. */
const MIRRORED = Array.from({ length: LAMPS_MIRRORED * 2 + 1 }, (_, index) => index);
/** The material parameter that carries where lamp `index` of those hangs (document.ts drives it). */
export const lampParameter = (index: number): string => `lamp${index}`;

/**
 * T1561b — the sentinel's SURFACE: one Material·WGSL that reads which surface a vertex is
 * from the kit's role (`attr.z`, the file's `loom_heat`: 0 shell, 0.2 chrome, 0.4 brass,
 * 0.6 red paint, 0.8 ring core, 1.0 eye lens — tools/blender/sentinel-bot/README.md) and
 * says what that surface is. The look lives here, not in the file.
 */
export const HULL_SURFACE_WGSL = `struct Params {
${MIRRORED.map((index) => `  ${lampParameter(index)}: vec3f, // @default [0, 2.25, ${((index - LAMPS_MIRRORED + 0.5) * LAMP_SPACING).toFixed(1)}]  Where the lamp ${index - LAMPS_MIRRORED} stations on from the robot's own hangs.`).join("\n")}
  station: f32, // @default 37  The station the robot is under: which lamp is which tone.
  lamps: f32, // @default 6  Radiance of a lamp plate, as the steel reflects it.
  pool: f32, // @default 0.05  Radiance of the lit liner round a plate, as a share of the plate's.
  deck: f32, // @default 0.2  How much of all that the wet deck throws back up.
  gloss: f32, // @default 0.2  Roughness of the black shell: lower is wetter.
  steel: f32, // @default 0.3  How much of what it faces the shell throws back: 0.04 is enamel, 0.6 bare steel.
  eyeGlow: f32, // @default 9  Radiance of the eye lenses.
  eyeColor: vec3f, // @default [1, 0.06, 0.03]  Their colour.
  coreGlow: f32, // @default 0.02  Radiance of a red core at rest: an ember, so a tentacle in the dark is still there.
  pulseGlow: f32, // @default 3  Radiance of a core under the crest of a pulse.
};

// What each drawn piece brings of its own: the rig's point attribute of the same name (rig.ts).
struct Instance {
  charge: f32, // @default 0  How much of a pulse is on this piece: 0 at rest, 1 under a fresh crest.
};

${LAMP_SEEN_WGSL}
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let role = s.attr.z;
  if (role > 0.9) {
    // A lens: black glass over a lamp, brightest where it faces the viewer.
    let facing = max(dot(normalize(s.eye - s.world), s.normal), 0.0);
    // Each lens has a nerve of its own: the eyes are a hand's breadth apart in the robot's frame, so a coarse cell of it names one.
    let lens = floor(s.local * 7.0);
    let nerve = fract(sin(dot(lens, vec3f(12.9898, 78.233, 37.719))) * 43758.5453);
    let life = 0.8 + 0.2 * sin(s.absTime * (1.5 + nerve * 4.0) + nerve * 40.0);
    o.albedo = vec4f(0.01, 0.0, 0.0, 1.0);
    o.roughness = 0.08;
    o.metallic = 0.0;
    o.emissive = p.eyeColor * p.eyeGlow * (0.35 + 0.65 * facing * facing) * life;
  } else if (role > 0.7) {
    // The spine between the rings: red mirror, as the reference has it. In the dark it is dark, and red only
    // where a lamp finds it or a pulse is passing.
    o.albedo = vec4f(0.55, 0.012, 0.008, 1.0);
    o.roughness = 0.2;
    o.metallic = 1.0;
    o.emissive = p.eyeColor * (p.coreGlow + p.pulseGlow * s.instance.charge);
  } else if (role > 0.5) {
    o.albedo = vec4f(0.22, 0.012, 0.01, 1.0);
    o.roughness = 0.38;
    o.metallic = 0.6;
  } else if (role > 0.3) {
    o.albedo = vec4f(0.5, 0.36, 0.16, 1.0);
    o.roughness = 0.34;
    o.metallic = 1.0;
  } else if (role > 0.1) {
    o.albedo = vec4f(0.62, 0.64, 0.67, 1.0);
    o.roughness = 0.22;
    o.metallic = 1.0;
  } else {
    // Blackened steel: no diffuse at all, so it is only ever what it reflects — a lamp, the lit liner
    // round one, the wet deck (tunnel.ts, the environment).
    o.albedo = vec4f(p.steel * 0.92, p.steel * 0.96, p.steel * 1.05, 1.0);
    o.roughness = p.gloss;
    o.metallic = 1.0;
  }
  // A mirror shows what is along its mirror direction: the lamps overhead, and their smear in the wet deck
  // below (tunnel.ts). Metal only; a rougher one shows a softer plate.
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
  o.emissive = o.emissive + seen * p.lamps * mix(o.albedo.rgb, vec3f(1.0), graze) * o.metallic * (1.0 - o.roughness);
  return o;
}`;
