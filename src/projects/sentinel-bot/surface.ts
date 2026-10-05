/**
 * T1561b — the sentinel's SURFACE: one Material·WGSL that reads which surface a vertex is
 * from the kit's role (`attr.z`, the file's `loom_heat`: 0 shell, 0.2 chrome, 0.4 brass,
 * 0.6 red paint, 0.8 ring core, 1.0 eye lens — tools/blender/sentinel-bot/README.md) and
 * says what that surface is. The look lives here, not in the file.
 */
export const HULL_SURFACE_WGSL = `struct Params {
  gloss: f32, // @default 0.16  Roughness of the black shell: lower is wetter.
  eyeGlow: f32, // @default 9  Radiance of the eye lenses.
  eyeColor: vec3f, // @default [1, 0.06, 0.03]  Their colour.
  coreGlow: f32, // @default 0.02  Radiance of a red core at rest: an ember, so a tentacle in the dark is still there.
  pulseGlow: f32, // @default 3  Radiance of a core under the crest of a pulse.
};

// What each drawn piece brings of its own: the rig's point attribute of the same name (rig.ts).
struct Instance {
  charge: f32, // @default 0  How much of a pulse is on this piece: 0 at rest, 1 under a fresh crest.
};

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
    // Black enamel: almost no diffuse, so under a lamp it stays black and only its highlights read.
    o.albedo = vec4f(0.006, 0.0065, 0.008, 1.0);
    o.roughness = p.gloss;
    o.metallic = 0.0;
  }
  return o;
}`;
