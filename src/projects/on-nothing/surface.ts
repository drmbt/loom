/**
 * T1400b — the On Nothing SURFACE: one Material · WGSL for every mesh in the scene.
 *
 * The GLB has no textures and no material id per vertex, so the Blender build writes each
 * material's CLASS CODE into `loom_heat` (class ÷ 64; nothing here is hot), which arrives as
 * `s.attr.z`. The classes get what a texture set would have given them:
 *
 *  - concrete: a damp, patchy warehouse floor — glossy wet patches (so the headlights streak
 *    across it as long vertical reflections), dry rough ground between, tyre scuffs, cracks;
 *  - brick: courses and mortar as bump, near-black;
 *  - clear coat (white, silver, black paint): near-mirror roughness with orange-peel bump;
 *    matte paint stays satin;
 *  - chrome and jewellery: mirror; jewellery breaks into facets so it glints;
 *  - glass: black mirror; tyres: rough rubber with a faint sidewall sheen;
 *  - emissive (headlights, DRLs, LED tubes): the export's emission × a gain per group, the
 *    handle the lanes drive;
 *  - skin, cloth, denim, shoes: rough dielectrics, skin desaturated toward the grade;
 *  - T1418b: the performer's baked skin (36) and eyes (37), drawn by surface-head.ts.
 */
import { HEAD_SURFACE_WGSL } from "./surface-head.ts";

/** The floor contact-shadow footprints: centre (x, z) and half extents, glTF metres. */
export type Footprint = readonly [number, number, number, number];

/** SURFACE_WGSL with the parked cars' footprints baked in (none: no contact shadows). */
export function surfaceWgsl(footprints: readonly Footprint[] = []): string {
  const count = Math.max(1, footprints.length);
  const list = footprints.length === 0 ? "vec4f(0.0, 0.0, -1.0, -1.0)" : footprints.map((f) => `vec4f(${f.map((v) => v.toFixed(4)).join(", ")})`).join(", ");
  return SURFACE_BASE_WGSL.replace("// @contact", `const CONTACT_COUNT: u32 = ${footprints.length}u;\nconst CONTACT = array<vec4f, ${count}>(${list});`);
}

const SURFACE_BASE_WGSL = `// @use surface-detail
// @contact
struct Params {
  headGain: f32, // @default 1  Headlight and DRL radiance multiplier.
  tubeGain: f32, // @default 1  LED tube radiance multiplier.
  tailGain: f32, // @default 1  Tail light radiance multiplier.
  wet: f32, // @default 0.4  Share of the floor that is damp and glossy.
  wetGloss: f32, // @default 0.22  Roughness of the damp patches.
  contactDepth: f32, // @default 0.93  How dark the floor gets under a parked car (0 off).
  contactReach: f32, // @default 1.1  How far the contact shadow reaches beyond the footprint, metres.
  dryGloss: f32, // @default 0.62  Roughness of the dry floor (worn concrete: past the reflections' cutoff).
  peel: f32, // @default 0.25  Orange-peel strength on the clear coat.
  silverAlbedo: f32, // @default 0.45  The hero's satin silver: its albedo (linear).
  silverRoughness: f32, // @default 0.3  The hero's satin silver: its roughness.
  silverMetallic: f32, // @default 0.2  The hero's satin silver: how metallic (a flake coat, mostly dielectric).
  cycAlbedo: f32, // @default 0.9  Albedo of the white cyc.
  ice: f32, // @default 0.075  The ice's own mirrored studio (jewel class only; T1407b closeups2).
};

fn classOf(s: SurfaceIn) -> u32 {
  return u32(s.attr.z * 64.0 + 0.5);
}

// Scratch lines: per 0.6 m cell, a random direction and offset; thin, broken, short.
fn scratchAt(w: vec2f, scale: f32, seed: u32) -> f32 {
  let q = w / scale;
  let cell = floor(q);
  let h = vec3f(unitFloat(hash3i(vec3i(vec3f(cell, 1.0)), seed)), unitFloat(hash3i(vec3i(vec3f(cell, 2.0)), seed + 7u)), unitFloat(hash3i(vec3i(vec3f(cell, 3.0)), seed + 13u)));
  let a = h.x * 3.14159;
  let local = q - cell - vec2f(0.5);
  let across = dot(local, vec2f(-sin(a), cos(a))) - (h.y - 0.5) * 0.6;
  let along = dot(local, vec2f(cos(a), sin(a)));
  let seg = smoothstep(0.45, 0.2, abs(along)) * step(0.35, h.z);
  return smoothstep(0.012, 0.0, abs(across)) * seg;
}

// CONTACT SHADOWS under the parked cars: each footprint (generated from the GLB, see
// contactFootprints) darkens the floor with a soft falloff — near black under the body, a
// short penumbra beyond it — the sky/room occlusion a screen-space pass cannot reach at 15 m.
fn contactShadow(q: vec2f, p: Params) -> f32 {
  var k = 1.0;
  for (var i = 0u; i < CONTACT_COUNT; i = i + 1u) {
    let f = CONTACT[i];
    let d = abs(q - f.xy) - f.zw;
    let outside = length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
    let shadow = pow(1.0 - smoothstep(-0.6, p.contactReach, outside), 1.6);
    k = k * (1.0 - shadow * p.contactDepth);
  }
  return k;
}

fn floorSurface(s: SurfaceIn, p: Params, o: SurfaceOut) -> SurfaceOut {
  // DRY, WORN warehouse concrete: satin, never glossy. A traffic-polished lane catches the
  // lamps as a soft sheen; scuffs, stains, aggregate and scratches break it everywhere.
  var r = o;
  let w = s.world;
  let large = detailFbm(vec3f(w.x * 0.18, 0.0, w.z * 0.18), 4, s.footprint);
  let mid = detailFbm(vec3f(w.x * 0.9, 5.0, w.z * 0.9), 4, s.footprint);
  let fine = detailFbm(w * 3.1, 5, s.footprint);
  let grit = detailFbm(w * 21.0, 3, s.footprint);
  let damp = smoothstep(1.0 - p.wet - 0.15, 1.0 - p.wet + 0.15, large.value + (fine.value - 0.5) * 0.25);
  // tyre scuffs and oil stains
  let scuff = smoothstep(0.6, 0.8, detailNoise(vec3f(w.x * 1.7, 0.0, w.z * 0.12)).value) * 0.45;
  let stain = smoothstep(0.62, 0.78, mid.value) * 0.35;
  // aggregate: a speckle of lighter and darker stones in the cement
  let stone = smoothstep(0.7, 0.85, grit.value) * 0.18 - smoothstep(0.3, 0.15, grit.value) * 0.12;
  let crack = smoothstep(0.006, 0.0, abs(detailNoise(vec3f(w.x * 0.9, 3.0, w.z * 0.9)).value - 0.5)) * 0.5;
  let scratches = max(scratchAt(w.xz, 0.6, 3u), scratchAt(w.xz + vec2f(0.21, 0.37), 0.35, 11u) * 0.6) * (1.0 - smoothstep(0.004, 0.02, s.footprint));
  let shade = (0.88 + 0.24 * fine.value + stone) * (0.85 + 0.3 * large.value);
  r.albedo = vec4f(o.albedo.rgb * shade * mix(1.0, 0.6, damp) * (1.0 - scuff * 0.5) * (1.0 - stain) * (1.0 - crack * 0.6) * (1.0 + scratches * 0.5) * contactShadow(w.xz, p), 1.0);
  // satin, never a mirror: polished where traffic ran, rough where it did not
  let polish = smoothstep(0.35, 0.75, large.value);
  r.roughness = clamp(mix(p.dryGloss + 0.12, p.dryGloss - 0.08, polish) + (grit.value - 0.5) * 0.1 + stain * 0.1 - scratches * 0.15, 0.3, 0.95);
  r.roughness = mix(r.roughness, p.wetGloss, damp);
  r.metallic = 0.0;
  r.normal = detailBump(s.normal, grit.gradient * 0.006 + fine.gradient * 0.015 + mid.gradient * 0.02, 1.0);
  return r;
}

fn brickSurface(s: SurfaceIn, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let w = s.world;
  let course = w.y / 0.075;
  let row = floor(course);
  let along = (w.x + w.z) / 0.23 + row * 0.5;
  let mortar = max(smoothstep(0.1, 0.0, fract(course)), smoothstep(0.06, 0.0, fract(along)));
  let n = detailFbm(w * 6.0, 4, s.footprint);
  r.albedo = vec4f(o.albedo.rgb * (0.7 + 0.6 * n.value) * mix(1.0, 1.6, mortar), 1.0);
  r.roughness = 0.9;
  r.normal = detailBump(s.normal, n.gradient * 0.01, 1.0);
  return r;
}

fn clearCoat(s: SurfaceIn, p: Params, o: SurfaceOut, roughness: f32) -> SurfaceOut {
  var r = o;
  let peel = detailFbm(s.world * 90.0, 2, s.footprint);
  r.roughness = roughness;
  r.normal = detailBump(s.normal, peel.gradient * 0.00045 * p.peel, 1.0);
  return r;
}

// ICE (T1407b closeups2): the chain, the bracelet, the pendant slab. As a pure mirror the ice
// showed only the dark room and read black in every shot; the reference's reads WHITE. A pavé
// is not a mirror: every stone returns light from inside, so it is (1) a bright white body the
// scene's lights light like a diffuse surface, and (2) a scatter of facets, each mirroring the
// set's lights as a glint. The room gives the facets nothing to mirror, so the ice carries its
// OWN reflected studio — a soft overhead box and a horizon band, seen through each stone's
// facet normal — as emission scaled by params.ice. It is the jewel-only environment gain: the
// Render's IBL (and so the skin) stays as low as each shot sets it.
fn jewel(s: SurfaceIn, p: Params, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  // stones ~3 mm apart; each a facet tilted its own way
  let q = s.world * 330.0;
  let cell = floor(q);
  let h = vec3f(unitFloat(hash3i(vec3i(cell), 11u)), unitFloat(hash3i(vec3i(cell), 23u)), unitFloat(hash3i(vec3i(cell), 37u)));
  // facets finer than a pixel sparkle and crawl frame to frame: fade them to the smooth normal
  let resolved = 1.0 - smoothstep(0.0015, 0.005, s.footprint);
  // each stone ROUND in its cell (a cell's sphere cut by the surface), the metal of the setting
  // showing darker between them, so close up it reads as pavé rather than a mosaic of squares
  let seat = length(q - cell - vec3f(0.5) - (h - vec3f(0.5)) * 0.25);
  let stone = mix(1.0, 1.0 - smoothstep(0.36, 0.48, seat), resolved);
  let n = normalize(s.normal);
  let facet = normalize(n + (h - vec3f(0.5)) * 1.1 * resolved * stone);
  r.normal = facet;
  r.roughness = mix(0.25, 0.12, stone);
  r.metallic = mix(0.9, 0.45, stone);
  r.albedo = vec4f(vec3f(0.92, 0.94, 0.97) * mix(0.55, 1.0, stone), 1.0);
  // the ice's own studio, mirrored by the facet: a broad soft box overhead and toward the lens,
  // a dimmer horizon band, a few stones catching it hard (a sparkle, per stone)
  let v = normalize(s.eye - s.world);
  let refl = reflect(-v, facet);
  let box = smoothstep(0.1, 0.7, refl.y) * 0.8 + smoothstep(0.35, 0.95, dot(refl, v)) * 0.6;
  let band = smoothstep(0.25, 0.0, abs(refl.y - 0.05)) * 0.35;
  let sparkle = select(0.0, 3.0, h.x > 0.93) * resolved;
  // an unresolved pavé averages its stones: a steady satin white
  let studio = mix(0.55, box + band + sparkle, resolved);
  r.emissive = vec3f(0.93, 0.97, 1.0) * p.ice * studio * mix(0.3, 1.0, stone);
  return r;
}
${HEAD_SURFACE_WGSL}
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let c = classOf(s);
  switch c {
    case 1u: { return floorSurface(s, p, o); }
    case 2u: { return brickSurface(s, o); }
    case 4u: { o.emissive = s.emissive * p.tubeGain; }
    case 10u, 13u: { return clearCoat(s, p, o, 0.035); }
    case 11u: {
      // The hero's SATIN SILVER (T1407b wide, round 4). As a 0.85-metallic mirror it showed only
      // the black room and read near-black in every wide; the reference hero is a light satin
      // grey that takes the set's low keys on its bumper and bonnet. A light, mostly dielectric
      // albedo with a broad sheen does that. (The title keeps its own matte grey, title.ts.)
      o.albedo = vec4f(vec3f(p.silverAlbedo) * vec3f(0.98, 1.0, 1.02), 1.0);
      o.metallic = p.silverMetallic;
      return clearCoat(s, p, o, p.silverRoughness);
    }
    case 12u: { return clearCoat(s, p, o, 0.42); }
    case 14u, 19u: { o.roughness = 0.035; o.metallic = 1.0; }
    case 15u: { o.roughness = 0.015; o.metallic = 0.0; }
    case 17u: {
      let n = detailFbm(s.world * 40.0, 3, s.footprint);
      o.roughness = 0.65 + 0.2 * n.value;
      o.normal = detailBump(s.normal, n.gradient * 0.002, 1.0);
    }
    case 18u: { o.emissive = s.emissive * p.headGain; }
    case 20u: { o.emissive = s.emissive * p.tailGain; }
    case 30u: {
      let luma = dot(o.albedo.rgb, vec3f(0.2126, 0.7152, 0.0722));
      o.albedo = vec4f(mix(vec3f(luma), o.albedo.rgb, 0.6), 1.0);
      o.roughness = 0.45;
    }
    case 31u, 32u: {
      let n = detailFbm(s.world * 55.0, 3, s.footprint);
      o.roughness = 0.9;
      o.normal = detailBump(s.normal, n.gradient * 0.0012, 1.0);
    }
    case 35u: { return jewel(s, p, o); }
    case 36u: { return headSkin(s, o); }
    case 37u: { return headEye(s, o); }
    case 40u: { o.albedo = vec4f(vec3f(p.cycAlbedo), 1.0); o.roughness = 0.95; o.metallic = 0.0; }
    default: {}
  }
  return o;
}`;

/** The surface without contact shadows (every shot but the parked-car sets). */
export const SURFACE_WGSL = surfaceWgsl([]);

/**
 * T1407b — LAMP GLASS, drawn ADDITIVELY over the lamp (loom has no transmissive mesh glass,
 * T1357b): what a clear polycarbonate cover adds to a lit lamp is its reflection — a fresnel
 * sheen that grows at grazing angles, and sharp glints where the cover's curvature catches the
 * room's bright shapes (a horizon band and a couple of overhead sources). Adds, never occludes,
 * so the lamp and its streak stay whole.
 */
export const LAMP_GLASS_WGSL = `struct Params {
  sheen: f32, // @default 0.06  Fresnel sheen radiance.
  glint: f32, // @default 3  Radiance of the glints (the room's bright shapes in the glass).
  tint: vec3f, // @default 1  Colour of the reflection.
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let v = normalize(s.eye - s.world);
  let n = normalize(s.normal);
  let nv = clamp(abs(dot(n, v)), 0.0, 1.0);
  let fresnel = 0.04 + 0.96 * pow(1.0 - nv, 5.0);
  let r = reflect(-v, n);
  // the room: a bright horizon band (the other cars' lamps, the doors) and two overhead fittings
  let band = smoothstep(0.12, 0.02, abs(r.y - 0.05)) * (0.6 + 0.4 * sin(atan2(r.x, r.z) * 7.0));
  let top = pow(max(dot(r, normalize(vec3f(0.3, 1.0, 0.2))), 0.0), 400.0) + pow(max(dot(r, normalize(vec3f(-0.4, 0.9, -0.3))), 0.0), 300.0);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.emissive = p.tint * (fresnel * p.sheen * 10.0 + (band + top) * p.glint * (0.25 + fresnel));
  return o;
}`;

/** A black, unlit stand-in: the cars as depth occluders in the glass Render. Roughness 1 marks it (the glass is 0.02). */
export const OCCLUDER_WGSL = `struct Params {
  unused: f32, // @default 0  (none)
};

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.emissive = vec3f(0.0);
  o.roughness = 1.0;
  return o;
}`;

/**
 * Lays the glass Render over the frame: where the glass is (its normal output, low roughness),
 * the frame behind is REFRACTED — sampled through a UV offset from the glass normal, with a
 * slight dispersion — and the glass's own reflections are added on top.
 * Input = the frame, More = [glass colour, glass normal].
 */
export const GLASS_COMPOSITE_WGSL = `struct Params {
  refract: f32, // @default 0.012  Refraction offset, fraction of the frame, at full normal tilt.
  dispersion: f32, // @default 0.25  Extra offset for red over blue (a hint of rainbow at the edges).
  reflect: f32, // @default 1  Reflection gain.
  tint: f32, // @default 0.92  Transmission (the cover absorbs a little).
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var<uniform> params: Params;
@group(0) @binding(4) var inputTexture1: texture_2d<f32>;
@group(0) @binding(5) var inputTexture2: texture_2d<f32>;

fn texel(t: texture_2d<f32>, uv: vec2f) -> vec2i {
  let size = vec2f(textureDimensions(t));
  return clamp(vec2i(uv * size), vec2i(0), vec2i(size) - vec2i(1));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let base = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let g = textureLoad(inputTexture2, texel(inputTexture2, uv), 0);
  // glass: a surface (a > 0) that is glossy (the occluders carry roughness 1)
  let isGlass = step(0.001, g.a) * step(g.a, 0.2);
  if (isGlass <= 0.0) { return base; }
  let n = normalize(g.rgb * 2.0 - 1.0);
  let o = n.xy * vec2f(1.0, -1.0) * params.refract;
  let r = textureSampleLevel(inputTexture, inputSampler, uv + o * (1.0 + params.dispersion), 0.0).r;
  let gg = textureSampleLevel(inputTexture, inputSampler, uv + o, 0.0).g;
  let b = textureSampleLevel(inputTexture, inputSampler, uv + o * (1.0 - params.dispersion), 0.0).b;
  let refl = textureSampleLevel(inputTexture1, inputSampler, uv, 0.0).rgb;
  return vec4f(vec3f(r, gg, b) * params.tint + refl * params.reflect, base.a);
}`;
