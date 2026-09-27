/**
 * T1418b — the performer's HEAD in the On Nothing surface (surface.ts calls these by class).
 *
 * loom samples no image textures on a mesh, so tools/blender/on-nothing/head.py bakes what a
 * texture set would have carried into the two channels a mesh vertex has:
 *
 *  - COLOR_0 rgb: MakeHuman's CC0 skin (and, on the eyes, its CC0 brown iris) sampled at each
 *    corner's UV — the albedo, arriving as `s.albedo` (the material's base colour is white);
 *  - COLOR_0 alpha: 1 − the facial-hair density (a goatee joined to a moustache, jaw stubble,
 *    the brows), smooth between vertices;
 *  - TEXCOORD_0: MakeHuman's UV, carried through the skin kernel, so the detail drawn here
 *    SITS ON THE SKIN as the figure moves (a world-space noise would swim across the face).
 *
 * Class 36, SKIN: round PORES keyed to the UV (darker, duller pits whose slope bumps the normal
 * in a frame aligned with the head's UV layout: the mesh carries no tangents); an oilier sheen
 * where the vertex albedo is lighter (the nose and forehead catch it); and short dark HAIRS
 * grown from the density, one per UV cell at most: down the face in the beard, outwards in
 * the brows. Anything finer than a
 * pixel is replaced by its average (the footprint fade), so the head neither sparkles at a
 * distance nor loses its beard: the beard becomes its mean darkness.
 *
 * Class 37, EYE: the baked sclera, a crisp procedural iris and pupil at the two iris centres
 * of MakeHuman's eye texture (the bake alone is ~2 mm between vertices: too coarse for a
 * pupil), a dark limbal ring, and a wet, near-mirror cornea.
 *
 * Both return albedo alpha 1: the alpha channel was data, not coverage.
 */

/** MakeHuman's UV: about 0.9 UV units a metre across the face (measured on the MPFB head). */
const UV_PER_METRE = 0.9;

export const HEAD_SURFACE_WGSL = `
const HEAD_UV_PER_M: f32 = ${UV_PER_METRE};
// pores ~0.7 mm apart; hair follicles ~0.8 mm apart (in UV cells)
const PORE_FREQ: f32 = ${(1 / (0.0007 * UV_PER_METRE)).toFixed(1)};
const HAIR_FREQ: f32 = ${(1 / (0.0008 * UV_PER_METRE)).toFixed(1)};
const HAIR_COLOUR: vec3f = vec3f(0.012, 0.009, 0.008);
// the face's centre line in v, and the eyes' line in u (brows above it), measured on the MPFB head's UV
const FACE_V: f32 = 0.5168;
const BROW_U: f32 = 0.83;

fn headHash4(c: vec2f, seed: u32) -> vec4f {
  let i = vec3i(vec3f(c, f32(seed)));
  return vec4f(unitFloat(hash3i(i, seed)), unitFloat(hash3i(i, seed + 101u)), unitFloat(hash3i(i, seed + 211u)), unitFloat(hash3i(i, seed + 307u)));
}

fn headSegment(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  return length(p - (a + ab * t));
}

// Hair coverage at uv (0..1): at most one hair per cell (a follicle ~0.8 mm from the next),
// present where the density allows, a stroke 2-3.5 cells long, thick at the root and thin at the
// tip. The beard grows down the face (+u in MakeHuman's layout); above the eyes (u < BROW_U) the
// brows grow out from the nose, along v, rising a little. HAIR_MEAN is the coverage these strokes
// average to, so the footprint fade does not change the beard's darkness.
fn hairCoverage(uv: vec2f, density: f32) -> f32 {
  let q = uv * HAIR_FREQ;
  let base = floor(q);
  let brow = uv.x < BROW_U;
  let out = select(-1.0, 1.0, uv.y > FACE_V);
  var cover = 0.0;
  for (var a = -4; a <= 1; a = a + 1) {
    for (var b = -1; b <= 1; b = b + 1) {
      // a hair reaches up to 3.5 cells from its root: the beard searches up the face (-u), a brow inwards along v
      let cell = base + select(vec2f(f32(a), f32(b)), vec2f(f32(b), f32(a) * out), brow);
      let h = headHash4(cell, 17u);
      if (h.x < density) {
        let root = cell + h.yz;
        let dir = select(normalize(vec2f(1.0, (h.w - 0.5) * 0.9)), normalize(vec2f(-0.35 + (h.w - 0.5) * 0.5, out)), brow);
        let length = 2.0 + 1.5 * h.y;
        let d = headSegment(q, root, root + dir * length);
        let along = clamp(dot(q - root, dir) / length, 0.0, 1.0);
        let width = mix(0.2, 0.07, along);
        cover = max(cover, 1.0 - smoothstep(width * 0.5, width, d));
      }
    }
  }
  return cover;
}

// Pores: one per cell at most, a round pit (Worley: the nearest pore of the 3x3 cells). Returns the
// pit depth (0..1) and its gradient in cell units (for the bump).
fn poreAt(uv: vec2f) -> vec3f {
  let q = uv * PORE_FREQ;
  let base = floor(q);
  var best = vec3f(0.0);
  for (var dy = -1; dy <= 1; dy = dy + 1) {
    for (var dx = -1; dx <= 1; dx = dx + 1) {
      let cell = base + vec2f(f32(dx), f32(dy));
      let h = headHash4(cell, 29u);
      if (h.x < 0.75) {
        let centre = cell + vec2f(0.15) + h.yz * 0.7;
        let radius = 0.18 + 0.14 * h.w;
        let v = q - centre;
        let d = length(v);
        let t = clamp(1.0 - d / radius, 0.0, 1.0);
        let depth = t * t * (3.0 - 2.0 * t);
        if (depth > best.x) {
          // d(depth)/dq = s'(t) * dt/dq, with dt/dq = -v / (d * radius)
          let slope = 6.0 * t * (1.0 - t) / max(d * radius, 1e-4);
          best = vec3f(depth, -v * slope);
        }
      }
    }
  }
  return best;
}

fn hairMean(density: f32) -> f32 {
  return 1.0 - exp(-density * 0.55);
}

fn headSkin(s: SurfaceIn, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let density = clamp(1.0 - s.tint.a, 0.0, 1.0);
  let base = s.albedo.rgb;
  // UV units per pixel, and how resolved the pores and the hairs are at this distance
  let uvPx = s.footprint * HEAD_UV_PER_M;
  let poreSeen = 1.0 - smoothstep(0.35, 0.9, uvPx * PORE_FREQ);
  let hairSeen = 1.0 - smoothstep(0.3, 0.8, uvPx * HAIR_FREQ);
  let n = normalize(s.normal);
  // A frame for the bump: MakeHuman's head UV runs u DOWN the face and v across it (towards the
  // subject's right), so with the head upright, -u is world up and +v is the figure's right.
  // There is no tangent attribute; this frame turns with the normal, so a pore stays a pit as the head turns.
  let side = normalize(select(cross(vec3f(0.0, 1.0, 0.0), n), vec3f(1.0, 0.0, 0.0), abs(n.y) > 0.98));
  let up = cross(n, side);
  let pore = poreAt(s.uv);
  let pit = pore.x * poreSeen;
  // the pit's slope in world terms (per cell -> a tilt); a pit tilts the normal towards its centre
  // and a finer-than-the-bake unevenness (2-5 mm): a height field's gradient in the same frame
  let fineScale = PORE_FREQ * 0.3;
  let fine = detailFbm(vec3f(s.uv * fineScale, 5.0), 3, uvPx * fineScale);
  let slope = (-up * pore.y - side * pore.z) * 0.035 * poreSeen + (-up * fine.gradient.x - side * fine.gradient.y) * 0.012;
  let blotch = detailFbm(vec3f(s.uv * PORE_FREQ * 0.08, 2.0), 3, uvPx * PORE_FREQ * 0.08);
  var albedo = base * (1.0 - 0.22 * pit) * (0.94 + 0.12 * blotch.value);
  // oil: the lighter, raised planes (nose, forehead, cheekbones) are glossier; pores are dull
  let luma = dot(base, vec3f(0.2126, 0.7152, 0.0722));
  var rough = clamp(0.5 - 0.9 * (luma - 0.1) + 0.15 * pit + 0.08 * (blotch.value - 0.5) + 0.1 * (fine.value - 0.5), 0.3, 0.62);
  var normal = normalize(n + slope - n * dot(slope, n));
  // the hairs, or their average darkness where they are finer than a pixel
  let cover = select(0.0, hairCoverage(s.uv, density), hairSeen > 0.0 && density > 0.02);
  let mean = hairMean(density);
  let hair = mix(mean, cover, hairSeen);
  albedo = mix(albedo, HAIR_COLOUR, hair * 0.92);
  rough = mix(rough, 0.55, hair);
  r.albedo = vec4f(albedo, 1.0);
  r.roughness = rough;
  r.metallic = 0.0;
  r.normal = normal;
  return r;
}

// MakeHuman's eye texture holds two eyes; their iris centres and radii, measured on the PNG. glTF UVs run v DOWN
// (the exporter flips Blender's v), which is the PNG's own row order.
const IRIS_A: vec2f = vec2f(0.703, 0.298);
const IRIS_B: vec2f = vec2f(0.288, 0.708);
const IRIS_R: f32 = 0.113;
const PUPIL_R: f32 = 0.036;

fn headEye(s: SurfaceIn, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let da = s.uv - IRIS_A;
  let db = s.uv - IRIS_B;
  let d2 = select(db, da, dot(da, da) < dot(db, db));
  let d = length(d2);
  let angle = atan2(d2.y, d2.x);
  let aa = max(s.footprint * 4.0, 0.004);
  // the iris: dark brown, radial fibres, a darker collarette and a dark limbal ring
  let fibres = 0.75 + 0.5 * detailNoise(vec3f(angle * 18.0, d * 40.0, 0.0)).value;
  var iris = vec3f(0.1, 0.05, 0.024) * fibres;
  iris = iris * mix(0.6, 1.0, smoothstep(PUPIL_R, PUPIL_R * 1.8, d));
  iris = iris * mix(1.0, 0.35, smoothstep(IRIS_R * 0.8, IRIS_R, d));
  let inIris = 1.0 - smoothstep(IRIS_R - aa, IRIS_R + aa, d);
  let inPupil = 1.0 - smoothstep(PUPIL_R - aa, PUPIL_R + aa, d);
  // the sclera from the bake, a little shadowed and warm, never paper white
  let sclera = s.albedo.rgb * vec3f(0.62, 0.58, 0.55);
  var albedo = mix(sclera, iris, inIris);
  albedo = mix(albedo, vec3f(0.004), inPupil);
  r.albedo = vec4f(albedo, 1.0);
  r.roughness = 0.03;
  r.metallic = 0.0;
  return r;
}
`;
