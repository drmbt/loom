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
 *  - skin, cloth, denim, shoes: rough dielectrics, skin desaturated toward the grade.
 */
export const SURFACE_WGSL = `// @use surface-detail
struct Params {
  headGain: f32, // @default 1  Headlight and DRL radiance multiplier.
  tubeGain: f32, // @default 1  LED tube radiance multiplier.
  tailGain: f32, // @default 1  Tail light radiance multiplier.
  wet: f32, // @default 0.4  Share of the floor that is damp and glossy.
  wetGloss: f32, // @default 0.22  Roughness of the damp patches.
  peel: f32, // @default 0.25  Orange-peel strength on the clear coat.
  cycAlbedo: f32, // @default 0.9  Albedo of the white cyc.
};

fn classOf(s: SurfaceIn) -> u32 {
  return u32(s.attr.z * 64.0 + 0.5);
}

fn floorSurface(s: SurfaceIn, p: Params, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let w = s.world;
  let large = detailFbm(vec3f(w.x * 0.18, 0.0, w.z * 0.18), 4, s.footprint);
  let fine = detailFbm(w * 3.1, 5, s.footprint);
  let grit = detailFbm(w * 21.0, 3, s.footprint);
  // Damp patches: large, soft-edged pools with fine ragged borders.
  let damp = smoothstep(1.0 - p.wet - 0.15, 1.0 - p.wet + 0.15, large.value + (fine.value - 0.5) * 0.25);
  // Tyre scuffs: long dark arcs along the depth axis.
  let scuff = smoothstep(0.62, 0.8, detailNoise(vec3f(w.x * 1.7, 0.0, w.z * 0.12)).value) * 0.5;
  // Hairline cracks.
  let crack = smoothstep(0.006, 0.0, abs(detailNoise(vec3f(w.x * 0.9, 3.0, w.z * 0.9)).value - 0.5)) * 0.5;
  let shade = 0.85 + 0.3 * fine.value + (grit.value - 0.5) * 0.2;
  r.albedo = vec4f(o.albedo.rgb * shade * mix(1.0, 0.55, damp) * (1.0 - scuff * 0.6) * (1.0 - crack * 0.6), 1.0);
  r.roughness = mix(0.72 + (grit.value - 0.5) * 0.2, p.wetGloss + (fine.value - 0.5) * 0.04, damp);
  r.metallic = 0.0;
  r.normal = detailBump(s.normal, grit.gradient * 0.004 + fine.gradient * 0.012 * (1.0 - damp), 1.0);
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

fn jewel(s: SurfaceIn, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  // Facets: the normal snaps to a coarse lattice of directions, cell by cell, so each stone
  // throws its own glint instead of one smooth sheen.
  let cell = floor(s.world * 180.0);
  let h = vec3f(unitFloat(hash3i(vec3i(cell), 11u)), unitFloat(hash3i(vec3i(cell), 23u)), unitFloat(hash3i(vec3i(cell), 37u)));
  r.normal = normalize(s.normal + (h - vec3f(0.5)) * 0.9);
  r.roughness = 0.03;
  r.metallic = 1.0;
  r.albedo = vec4f(0.98, 0.98, 1.0, 1.0);
  return r;
}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let c = classOf(s);
  switch c {
    case 1u: { return floorSurface(s, p, o); }
    case 2u: { return brickSurface(s, o); }
    case 4u: { o.emissive = s.emissive * p.tubeGain; }
    case 10u, 13u: { return clearCoat(s, p, o, 0.035); }
    case 11u: { return clearCoat(s, p, o, 0.16); }
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
    case 35u: { return jewel(s, o); }
    case 40u: { o.albedo = vec4f(vec3f(p.cycAlbedo), 1.0); o.roughness = 0.95; o.metallic = 0.0; }
    default: {}
  }
  return o;
}`;
