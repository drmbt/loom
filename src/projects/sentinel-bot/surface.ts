/**
 * T1561b — the sentinel's SURFACE: one Material·WGSL that reads which surface a vertex is
 * from the kit's role (`attr.z`, the file's `loom_heat`: 0 shell, 0.2 chrome, 0.4 brass,
 * 0.6 red paint, 0.8 ring core, 1.0 eye lens — tools/blender/sentinel-bot/README.md) and
 * says what that surface is. The look lives here, not in the file.
 */
export const HULL_SURFACE_WGSL = `struct Params {
  gloss: f32, // @default 0.2  Roughness of the black shell: lower is wetter.
  eyeGlow: f32, // @default 9  Radiance of the eye lenses.
  eyeColor: vec3f, // @default [1, 0.06, 0.03]  Their colour.
  coreGlow: f32, // @default 1.5  Radiance of the red cores.
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let role = s.attr.z;
  if (role > 0.9) {
    // A lens: black glass over a lamp, brightest where it faces the viewer.
    let facing = max(dot(normalize(s.eye - s.world), s.normal), 0.0);
    o.albedo = vec4f(0.01, 0.0, 0.0, 1.0);
    o.roughness = 0.08;
    o.metallic = 0.0;
    o.emissive = p.eyeColor * p.eyeGlow * (0.35 + 0.65 * facing * facing);
  } else if (role > 0.7) {
    o.albedo = vec4f(0.12, 0.004, 0.003, 1.0);
    o.roughness = 0.45;
    o.metallic = 0.0;
    o.emissive = p.eyeColor * p.coreGlow;
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
    o.albedo = vec4f(0.018, 0.019, 0.022, 1.0);
    o.roughness = p.gloss;
    o.metallic = 0.0;
  }
  return o;
}`;
