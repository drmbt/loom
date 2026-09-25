/**
 * T1354b — the plant's SURFACE: one Material · WGSL (§T1355b) for every mesh in the shop,
 * built on the shared `surface-detail` module (§T1377b).
 *
 * The GLB carries no textures (§T1358b), only per-vertex colour, roughness, metallic and heat,
 * so the surface CLASS is read from those: painted steel (saturated, part-metallic), bare
 * steel (metallic), concrete (grey, dielectric, rough), rubber and cable (dark, rough). Each
 * gets what a texture set would have given it:
 *
 *  - macro variation: every ~1.5 m panel its own slight shade, so no wall is one flat colour;
 *  - micro-normal: dents and cast grain as a world-space bump (the lit normal moves, so the
 *    key and the lamps rake across it), faded out below the pixel footprint;
 *  - roughness breakup, so a highlight is broken instead of a plastic sheen;
 *  - paint worn back to bare steel on convex edges (curvature from the generator);
 *  - soot by height and nearness to the furnace, dust on top faces, streaks down walls;
 *  - oily, damp patches on the floor — glossy, so the furnace and the lamps streak across it.
 *
 * Hot surfaces: liquid steel (heat ≥ 0.9) flows white-hot under rafts of slag; hot linings
 * (refractory, graphite, hot slag) glow in their cracks without flowing. `heatPulse` is the
 * audio's handle on the whole melt.
 */
export const PLANT_SURFACE_WGSL = `// @use surface-detail
struct Params {
  soot: f32, // @default 0.5  Soot darkening overall (0 clean .. 1 black).
  sootHeight: f32, // @default 18  Height in metres where soot is heaviest.
  furnaceSoot: f32, // @default 0.45  Extra soot near the furnace (within ~25 m).
  dust: f32, // @default 0.3  Pale dust on up-facing surfaces.
  streaks: f32, // @default 0.4  Rust-dark streaks down vertical faces.
  dents: f32, // @default 0.35  Strength of the dented, cast surface relief.
  wear: f32, // @default 0.7  Paint worn back to bare steel on edges.
  puddles: f32, // @default 0.8  Oily, glossy patches on the floor.
  floorGrime: f32, // @default 0.85  Scale, soot and slag ground into the floor.
  chalk: f32, // @default 0.45  How much chroma weathered paint has lost.
  paintPop: f32, // @default 0.35  Extra chroma on painted steel (fresh safety paint).
  fx: f32, // @default 0  Master level of the surface effects below (the director's intensity).
  kickSince: f32, // @default 100  Seconds since the kick: a shockwave runs out from the furnace along the panel seams.
  snareSince: f32, // @default 100  Seconds since the snare: a hot scanline sweeps up every wall.
  flicker: f32, // @default 0  Hats: panels light up as corrupt blocks, hash-picked per 1.5 m panel.
  heatGlow: f32, // @default 14  Radiance of the hottest molten steel.
  heatFlow: f32, // @default 0.3  How fast the molten surface flows, metres per second.
  heatPulse: f32, // @default 0  Extra heat on the whole melt (the audio's handle).
  crust: f32, // @default 0.8  How much slag floats on the molten surface.
};

// Temperature 0..1 to linear radiance colour: dull red, orange, yellow, near-white.
fn blackbody(t: f32) -> vec3f {
  let x = clamp(t, 0.0, 1.0);
  // Saturated through the orange: a camera sees molten steel as orange-yellow with a white
  // core only at the very top — and the grade's curve whitens whatever is left past it.
  let red = vec3f(0.6, 0.03, 0.0);
  let orange = vec3f(1.0, 0.22, 0.01);
  let yellow = vec3f(1.0, 0.5, 0.06);
  let white = vec3f(1.0, 0.82, 0.5);
  return mix(mix(red, orange, smoothstep(0.0, 0.35, x)), mix(yellow, white, smoothstep(0.9, 1.1, x)), smoothstep(0.35, 0.8, x));
}

// The audio's marks ON the steel — light running through the structure, not over the picture.
fn surfaceFx(s: SurfaceIn, p: Params) -> vec3f {
  if (p.fx <= 0.0) { return vec3f(0.0); }
  // Panel seams: distance to the nearest edge of the 1.5 m panel grid, on the face's plane.
  let cell = fract(s.world / 1.5);
  let edge = min(cell, vec3f(1.0) - cell);
  let across = abs(s.normal);
  let seamDistance = min(min(select(edge.x, 1.0, across.x > 0.7), select(edge.y, 1.0, across.y > 0.7)), select(edge.z, 1.0, across.z > 0.7));
  let seam = 1.0 - smoothstep(0.0, 0.04, seamDistance);
  // KICK: a ring leaving the furnace at 60 m/s, fading within a second; it lights the seams
  // hard and the panels faintly, so the structure itself carries the beat.
  let radius = p.kickSince * 60.0;
  let ring = exp(-pow((length(s.world.xz) - radius) / 0.8, 2.0)) * exp(-p.kickSince * 3.0);
  var fx = vec3f(1.0, 0.42, 0.12) * ring * (seam * 2.5 + 0.1);
  // SNARE: a thin scanline climbing the walls at 30 m/s, cold.
  let line = exp(-pow((s.world.y - p.snareSince * 30.0) / 0.25, 2.0)) * exp(-p.snareSince * 3.0) * (1.0 - across.y);
  fx = fx + vec3f(0.35, 0.8, 1.0) * line * 3.0;
  // HATS: a few 3 m panels switching on as flat blocks, a new pick twelve times a second —
  // sparse, or it reads as confetti rather than a fault in the structure.
  let panel = floor(s.world / 3.0);
  let pick = fract(sin(dot(panel, vec3f(12.9898, 78.233, 37.719)) + floor(s.absTime * 12.0) * 7.13) * 43758.5453);
  fx = fx + vec3f(0.3, 0.75, 1.0) * step(1.0 - p.flicker * 0.012, pick) * 0.9;
  return fx * p.fx;
}

fn panelShade(world: vec3f) -> f32 {
  return detailNoise(floor(world / 1.5) + vec3f(0.5)).value;
}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let heat = s.attr.z;

  if (heat >= 0.9) {
    // LIQUID STEEL: near-uniformly white-hot, rippling, carrying rafts of dark slag.
    let flow = vec3f(s.absTime * p.heatFlow, 0.0, s.absTime * p.heatFlow * 0.6);
    let field = detailFbm(s.world * 1.4 - flow, 4, s.footprint);
    let rafts = smoothstep(0.5, 0.66, detailFbm(s.world * 0.5 - flow * 0.35, 3, s.footprint).value);
    let skin = clamp(rafts * p.crust * (1.0 - p.heatPulse * 0.6), 0.0, 1.0);
    let temperature = clamp(heat * (0.86 + 0.18 * field.value) + p.heatPulse * 0.3, 0.0, 1.2);
    o.emissive = blackbody(temperature * (1.0 - skin * 0.5)) * p.heatGlow * temperature * temperature * (1.0 - skin * 0.97);
    o.albedo = vec4f(vec3f(0.035, 0.03, 0.028) * (0.5 + skin), s.albedo.a);
    o.roughness = mix(0.15, 0.8, skin);
    o.metallic = 0.0;
    o.normal = detailBump(s.normal, field.gradient, 0.06 + skin * 0.1);
    return o;
  }

  if (heat > 0.01) {
    // HOT LINING (refractory, graphite, hot slag): glows hottest in its cracks, never flows.
    let grain = detailFbm(s.world * 2.4, 4, s.footprint);
    let crackField = detailFbm(s.world * 0.9, 3, s.footprint).value;
    let cracks = 1.0 - smoothstep(0.012, 0.05, abs(crackField - 0.5));
    let temperature = clamp(heat * (0.6 + 0.5 * grain.value) + cracks * 0.35 * heat + p.heatPulse * 0.25, 0.0, 1.0);
    o.emissive = blackbody(temperature * 0.85) * p.heatGlow * 0.35 * temperature * temperature * temperature;
    o.albedo = vec4f(s.albedo.rgb * 0.45, s.albedo.a);
    o.roughness = 0.92;
    o.metallic = 0.0;
    o.normal = detailBump(s.normal, grain.gradient, 0.25);
    return o;
  }

  // ── COLD SURFACES ──
  let base = s.albedo.rgb;
  let brightest = max(base.r, max(base.g, base.b));
  let saturation = (brightest - min(base.r, min(base.g, base.b))) / max(brightest, 1e-3);
  let painted = smoothstep(0.25, 0.45, saturation);
  let concrete = (1.0 - smoothstep(0.02, 0.1, s.metallic)) * smoothstep(0.7, 0.85, s.roughness) * (1.0 - painted);
  let up = clamp(s.normal.y, -1.0, 1.0);
  let vertical = 1.0 - abs(up);
  let isFloor = smoothstep(0.9, 0.97, up) * (1.0 - smoothstep(0.25, 0.6, s.world.y));

  // Relief: broad dents plus fine cast grain; concrete gets pitting instead of dents.
  let dents = detailFbm(s.world * 0.7, 3, s.footprint);
  let grain = detailFbm(s.world * 9.0, 3, s.footprint);
  let reliefGradient = dents.gradient * mix(0.5, 0.15, concrete) + grain.gradient * mix(0.04, 0.09, concrete);
  var normal = detailBump(s.normal, reliefGradient, p.dents * 0.12);

  // Macro variation per panel, and a slow blotch for grime to key off.
  let panel = panelShade(s.world);
  let blotch = detailFbm(s.world * 0.3, 3, s.footprint).value;
  var albedo = base * (0.82 + 0.36 * panel);
  // Paint in a melt shop is chalked and filmed with dust: it keeps its hue but loses its
  // chroma, which is also what stops blue paint under orange light going violet.
  albedo = mix(vec3f(dot(albedo, vec3f(0.2126, 0.7152, 0.0722))), albedo, 1.0 - painted * p.chalk);
  // …and where it is fresh it is the loudest colour in the shop: safety yellow, primer red.
  albedo = mix(albedo, albedo * albedo / max(dot(albedo, vec3f(0.2126, 0.7152, 0.0722)), 1e-3) * 0.9, painted * p.paintPop);

  // Paint worn back to bare steel on edges, and a little everywhere it gets knocked.
  let chips = detailFbm(s.world * 3.2, 3, s.footprint).value;
  let wear = painted * p.wear * max(detailEdgeWear(s.curvature, 6.0, chips), smoothstep(0.72, 0.85, chips) * 0.5);
  albedo = mix(albedo, vec3f(0.42, 0.41, 0.4), wear);
  var metallic = mix(s.metallic, 0.95, wear);
  var roughness = mix(s.roughness, 0.32, wear);

  // Soot by height and by the furnace; dust on top faces; streaks down walls.
  let heightSoot = smoothstep(2.0, p.sootHeight, s.world.y);
  let nearFurnace = 1.0 - smoothstep(6.0, 26.0, length(s.world.xz));
  let sootAmount = clamp(p.soot * (0.3 + 0.7 * heightSoot) * (0.55 + 0.9 * blotch) + p.furnaceSoot * nearFurnace * blotch, 0.0, 0.92);
  let streak = smoothstep(0.58, 0.8, detailFbm(vec3f(s.world.x * 3.1, s.world.y * 0.16, s.world.z * 3.1), 3, s.footprint).value) * vertical * p.streaks;
  let dustAmount = smoothstep(0.6, 0.95, up) * p.dust * (0.4 + blotch) * (1.0 - isFloor * 0.6);
  albedo = mix(albedo, albedo * vec3f(0.5, 0.36, 0.26), streak);
  albedo = mix(albedo, vec3f(0.016, 0.014, 0.013), sootAmount * (1.0 - wear * 0.5));
  albedo = mix(albedo, vec3f(0.3, 0.28, 0.25), dustAmount);
  albedo = mix(albedo, albedo * vec3f(0.78, 0.74, 0.7), concrete * smoothstep(0.45, 0.75, blotch));
  // A melt-shop floor is never clean concrete: ground-in scale and soot take it dark, with
  // paler tracks where the traffic scuffs it and black slag spatter near the furnace.
  let tracks = smoothstep(0.55, 0.75, detailFbm(vec3f(s.world.x * 0.12, 0.0, s.world.z * 0.9), 3, s.footprint).value);
  let spatter = smoothstep(0.7, 0.78, detailFbm(s.world * 1.7, 3, s.footprint).value) * (1.0 - smoothstep(8.0, 22.0, length(s.world.xz)));
  let grime = isFloor * p.floorGrime;
  albedo = mix(albedo, albedo * vec3f(0.34, 0.32, 0.3) * (0.7 + 0.8 * tracks), grime);
  albedo = mix(albedo, vec3f(0.02, 0.018, 0.017), spatter * grime);

  // Roughness breakup: nothing in a steel shop is evenly glossy.
  roughness = clamp(roughness * (0.72 + 0.56 * grain.value) + sootAmount * 0.25 + dustAmount * 0.35 - streak * 0.08, 0.06, 1.0);
  metallic = metallic * (1.0 - dustAmount) * (1.0 - sootAmount * 0.6);

  // The floor: oily, damp patches go dark and glossy and flatten the relief.
  let wet = isFloor * p.puddles * smoothstep(0.52, 0.64, detailFbm(s.world * 0.22 + vec3f(3.1), 4, s.footprint).value);
  albedo = mix(albedo, albedo * 0.35, wet);
  roughness = mix(roughness, 0.05, wet);
  normal = normalize(mix(normal, s.normal, wet));

  o.albedo = vec4f(albedo, s.albedo.a);
  o.roughness = roughness;
  o.metallic = metallic;
  o.normal = normal;
  o.emissive = o.emissive + surfaceFx(s, p);
  return o;
}`;


/** T1354b — the sky seen through the openings: the file's emissive, scaled by the light programme. */
export const SKY_SURFACE_WGSL = `struct Params {
  sky: f32, // @default 1  Brightness of the sky in the openings (the director drives it).
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.emissive = s.emissive * p.sky;
  return o;
}`;
