/**
 * T1354b — the plant's SURFACE: one Material · WGSL (§T1355b) for every mesh in the shop.
 *
 * Cold steel gets its wear from the world, not from textures (§T1358b): soot that thickens
 * with height and toward the furnace, dust that settles on up-facing surfaces, and rust-dark
 * streaks that run DOWN vertical faces. Hot surfaces (the file's `loom_heat`, attr.z) become
 * molten: a flowing, cracking field whose temperature maps through a blackbody ramp, with a
 * dark crust that forms where the field cools — so a ladle's surface reads as metal with a
 * skin, not as an orange lamp. `heatPulse` is the audio's handle on the whole melt.
 */
export const PLANT_SURFACE_WGSL = `struct Params {
  soot: f32, // @default 0.55  Soot darkening overall (0 clean .. 1 black).
  sootHeight: f32, // @default 18  Height in metres where soot is heaviest.
  furnaceSoot: f32, // @default 0.5  Extra soot near the furnace (within ~25 m).
  dust: f32, // @default 0.35  Pale dust on up-facing surfaces.
  streaks: f32, // @default 0.45  Rust-dark streaks down vertical faces.
  heatGlow: f32, // @default 3.5  Radiance of the hottest molten steel.
  heatFlow: f32, // @default 0.35  How fast the molten surface flows, metres per second.
  heatPulse: f32, // @default 0  Extra heat on the whole melt (the audio's handle).
  crust: f32, // @default 0.8  How much cooling crust (floating slag) forms over the molten surface.
};

fn furnaceHash3(p: vec3f) -> f32 {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + dot(q, q.yxz + 33.33);
  return fract((q.x + q.y) * q.z);
}

fn furnaceNoise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let n000 = furnaceHash3(i);
  let n100 = furnaceHash3(i + vec3f(1.0, 0.0, 0.0));
  let n010 = furnaceHash3(i + vec3f(0.0, 1.0, 0.0));
  let n110 = furnaceHash3(i + vec3f(1.0, 1.0, 0.0));
  let n001 = furnaceHash3(i + vec3f(0.0, 0.0, 1.0));
  let n101 = furnaceHash3(i + vec3f(1.0, 0.0, 1.0));
  let n011 = furnaceHash3(i + vec3f(0.0, 1.0, 1.0));
  let n111 = furnaceHash3(i + vec3f(1.0, 1.0, 1.0));
  return mix(
    mix(mix(n000, n100, u.x), mix(n010, n110, u.x), u.y),
    mix(mix(n001, n101, u.x), mix(n011, n111, u.x), u.y),
    u.z,
  );
}

fn furnaceFbm(p: vec3f) -> f32 {
  var sum = 0.0;
  var amplitude = 0.5;
  var q = p;
  for (var octave = 0; octave < 4; octave = octave + 1) {
    sum = sum + amplitude * furnaceNoise3(q);
    q = q * 2.03 + vec3f(17.1, 3.7, 9.2);
    amplitude = amplitude * 0.5;
  }
  return sum;
}

// Temperature 0..1 to linear radiance colour: dull red, orange, yellow, near-white.
fn blackbody(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  let red = vec3f(0.55, 0.04, 0.005);
  let orange = vec3f(1.0, 0.28, 0.03);
  let yellow = vec3f(1.0, 0.66, 0.2);
  let white = vec3f(1.0, 0.93, 0.78);
  return mix(mix(red, orange, smoothstep(0.0, 0.35, x)), mix(yellow, white, smoothstep(0.75, 1.0, x)), smoothstep(0.35, 0.75, x));
}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let heat = s.attr.z;
  if (heat > 0.01 && heat < 0.9) {
    // HOT SOLID (refractory, graphite, hot slag): glows where it is hottest, cracks glow
    // brighter, and nothing flows — a lining, not a liquid.
    let grain = furnaceFbm(s.world * 2.2);
    let cracks = 1.0 - smoothstep(0.015, 0.06, abs(furnaceFbm(s.world * 0.9) - 0.5));
    let temperature = clamp(heat * (0.7 + 0.5 * grain) + cracks * 0.3 * heat + p.heatPulse * 0.25, 0.0, 1.0);
    o.emissive = blackbody(temperature * 0.85) * p.heatGlow * 0.6 * temperature * temperature * temperature;
    o.albedo = vec4f(s.albedo.rgb * 0.5, s.albedo.a);
    o.roughness = 0.9;
    o.metallic = 0.0;
    return o;
  }
  if (heat >= 0.9) {
    // MOLTEN: a field advected along the surface, domain-warped so it folds and cracks.
    let flow = vec3f(s.absTime * p.heatFlow, 0.0, s.absTime * p.heatFlow * 0.6);
    let warp = furnaceFbm(s.world * 0.6 + flow * 0.5);
    let field = furnaceFbm(s.world * 1.3 + vec3f(warp * 2.0) - flow);
    let cracks = 1.0 - smoothstep(0.02, 0.09, abs(field - 0.5));
    // Liquid steel is near-uniformly white-hot; the field only ripples it.
    let temperature = clamp(heat * (0.85 + 0.2 * field) + cracks * 0.1 + p.heatPulse * 0.3, 0.0, 1.2);
    // Slag floats in rafts: a slower, larger field decides where the skin is thick.
    let rafts = smoothstep(0.42, 0.62, furnaceFbm(s.world * 0.45 - flow * 0.3));
    let skin = clamp(max(smoothstep(0.35, 0.6, field) * 0.6, rafts) * p.crust * (1.0 - p.heatPulse * 0.6) * (1.0 - cracks * 0.8), 0.0, 1.0);
    let glow = blackbody(temperature * (1.0 - skin * 0.45)) * p.heatGlow * temperature * temperature * (1.0 - skin * 0.96);
    o.emissive = glow;
    o.albedo = vec4f(mix(vec3f(0.05, 0.045, 0.04), s.albedo.rgb * 0.3, 0.3) * (0.4 + skin), s.albedo.a);
    o.roughness = mix(0.25, 0.85, skin);
    o.metallic = 0.0;
    return o;
  }
  // COLD STEEL: soot by height and by nearness to the furnace, dust on top faces, streaks down walls.
  let up = clamp(s.normal.y, -1.0, 1.0);
  let heightSoot = smoothstep(2.0, p.sootHeight, s.world.y);
  let nearFurnace = 1.0 - smoothstep(6.0, 26.0, length(s.world.xz));
  let blotch = furnaceFbm(s.world * 0.35);
  let sootAmount = clamp(p.soot * (0.35 + 0.65 * heightSoot) * (0.6 + 0.8 * blotch) + p.furnaceSoot * nearFurnace * blotch, 0.0, 0.95);
  let vertical = 1.0 - abs(up);
  let streak = smoothstep(0.55, 0.8, furnaceFbm(vec3f(s.world.x * 3.1, s.world.y * 0.18, s.world.z * 3.1))) * vertical * p.streaks;
  let dustAmount = smoothstep(0.55, 0.95, up) * p.dust * (0.5 + blotch);
  var albedo = s.albedo.rgb;
  albedo = mix(albedo, albedo * vec3f(0.55, 0.42, 0.32), streak);
  albedo = mix(albedo, vec3f(0.018, 0.016, 0.015), sootAmount);
  albedo = mix(albedo, vec3f(0.34, 0.31, 0.27), dustAmount);
  o.albedo = vec4f(albedo, s.albedo.a);
  o.roughness = clamp(s.roughness + sootAmount * 0.3 + dustAmount * 0.4 - streak * 0.1, 0.05, 1.0);
  o.metallic = s.metallic * (1.0 - dustAmount) * (1.0 - sootAmount * 0.5);
  return o;
}`;
