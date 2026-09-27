/**
 * T1407b (closeups) — the CLOSE-UP SURFACE: the Material · WGSL for the props the close-ups hold
 * in frame at a few centimetres (tools/blender/on-nothing/closeups.py). Its classes start at 50
 * so they never collide with the scene's (surface.ts); each face's class arrives as
 * `s.attr.z × 64`, as there.
 *
 *  - 50 PAVÉ: the iced faces. The stones sit in hexagonal rows (a little jittered, as set by
 *    hand) in whichever of the x, y, z planes the surface faces most, so they need no UVs. Inside a stone
 *    the normal snaps to a brilliant's facets — a table, eight star facets, eight main crown
 *    facets, each stone turned at random — so every stone throws several glints and the whole
 *    face sparkles as the lens moves. Between the stones: white-gold metal and the prong beads
 *    at the stones' meeting points.
 *  - 51 polished white gold (the sides and back of the letters, the bail, the links' insides).
 *  - 52 white leather, 53 the white rubber cupsole, 54 the flat laces, 57 the insole: drawn in
 *    the SHOE'S OWN FRAME (the document passes its origin and axes, read from the GLB's
 *    `prop.shoe` marker), so the panels, the stitching, the perforated toe and the creases sit
 *    on the shoe wherever it stands.
 *  - 55 the pendant set's painted grey-teal wall, 56 the black knit of the tee behind it.
 */
export const CLOSEUP_SURFACE_WGSL = `// @use surface-detail
struct Params {
  pitch: f32, // @default 0.0015  Pavé stone pitch, metres.
  fire: f32, // @default 0.3  Colour of the stones' fire (0 = colourless glints).
  crown: f32, // @default 0.62  Tilt of the main crown facets, radians.
  shoeOrigin: vec3f, // @default 0  The shoe's own origin (heel, on the ground), world metres.
  shoeX: vec3f, // @default 0  World direction of the shoe's +x (across, lateral).
  shoeY: vec3f, // @default 0  World direction of the shoe's +y (heel to toe).
  shoeZ: vec3f, // @default 0  World direction of the shoe's +z (up).
  grime: f32, // @default 0.3  How worn the white shoe is (creases, scuffs, a yellowed sole edge).
  wallGlow: f32, // @default 0.12  The pendant set's far wall: its own soft grey-teal glow.
  wallCentre: vec3f, // @default 0  Where the wall's glow is brightest (world).
  windowGlow: f32, // @default 0.06  Radiance of the warehouse's far windows (the sneaker shot's background).
  debugView: f32, // @default 0  1 shows the pave: red = distance from the stone centre, green = resolved, blue = the facet.
};

fn classOf(s: SurfaceIn) -> u32 {
  return u32(s.attr.z * 64.0 + 0.5);
}

fn hash3(c: vec3f, seed: u32) -> vec3f {
  let i = vec3i(c);
  return vec3f(unitFloat(hash3i(i, seed)), unitFloat(hash3i(i, seed + 101u)), unitFloat(hash3i(i, seed + 211u)));
}

struct Stone {
  f1: f32, // distance from this point to its stone's centre, in pitches
  offset: vec3f, // from the stone's centre to this point, world metres (in the setting's plane)
  id: vec3f,
};

// Stones are SET in rows: a hexagonal lattice (each stone jittered a little, as a setter's hand
// does) in the plane the surface faces most — x, y or z, a triplanar choice — so a face of the
// letter carries even rows and a curved link switches plane where its normal turns.
fn stoneAt(w: vec3f, n: vec3f, pitch: f32) -> Stone {
  let a = abs(n);
  var u = vec3f(1.0, 0.0, 0.0);
  var v = vec3f(0.0, 1.0, 0.0);
  var face = 2.0;
  if (a.x >= a.y && a.x >= a.z) { u = vec3f(0.0, 0.0, 1.0); v = vec3f(0.0, 1.0, 0.0); face = 0.0; }
  else if (a.y >= a.z) { u = vec3f(1.0, 0.0, 0.0); v = vec3f(0.0, 0.0, 1.0); face = 1.0; }
  let q = vec2f(dot(w, u), dot(w, v)) / pitch;
  // hex lattice: rows 0.866 apart, every other row shifted half a pitch
  let rowH = 0.8660254;
  let row0 = floor(q.y / rowH);
  var st: Stone;
  st.f1 = 1e9;
  for (var dr = -1; dr <= 2; dr = dr + 1) {
    let row = row0 + f32(dr);
    let shift = select(0.0, 0.5, (i32(row) & 1) == 1);
    let col0 = floor(q.x - shift);
    for (var dc = -1; dc <= 2; dc = dc + 1) {
      let col = col0 + f32(dc);
      let id = vec3f(col, row, face);
      let jitter = (hash3(id, 17u).xy - vec2f(0.5)) * 0.12;
      let centre = vec2f(col + shift + 0.5, (row + 0.5) * rowH) + jitter;
      let d = q - centre;
      let dist = length(d);
      if (dist < st.f1) {
        st.f1 = dist;
        st.offset = (u * d.x + v * d.y) * pitch;
        st.id = id;
      }
    }
  }
  return st;
}

fn pave(s: SurfaceIn, p: Params, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let n = normalize(s.normal);
  // Stones smaller than about three pixels cannot be drawn: they fade to a bright satin sheen.
  let resolved = 1.0 - smoothstep(p.pitch * 0.25, p.pitch * 0.6, s.footprint);
  let st = stoneAt(s.world, n, p.pitch);
  // 0 at a stone's centre, 1 at its girdle (stones of 0.92 of a pitch, varying a little)
  let h = hash3(st.id, 53u);
  let t = st.f1 / (0.46 * (0.94 + 0.06 * h.z));
  // the radial direction, laid into the surface's own tangent plane
  let flat = st.offset - n * dot(st.offset, n);
  let radial = flat / max(length(flat), 1e-9);
  let b1 = normalize(cross(n, normalize(vec3f(0.37, 0.81, 0.46))));
  let b2 = cross(n, b1);
  let turn = h.x * 6.2831853;
  let angle = atan2(dot(radial, b2), dot(radial, b1)) - turn;
  let sectors = 8.0;
  let k = floor(angle / (6.2831853 / sectors));
  // star facets sit between the main facets: half a sector round
  let star = t < 0.55;
  let centreAngle = (k + select(0.5, 0.0, star)) * (6.2831853 / sectors) + turn;
  let facetDir = b1 * cos(centreAngle) + b2 * sin(centreAngle);
  var tilt = select(p.crown, 0.36, star);
  if (t < 0.2) { tilt = 0.0; }
  // each stone sits a little crooked in its seat
  let seat = normalize(n + (h - vec3f(0.5)) * 0.6);
  var facet = normalize(seat * cos(tilt) + facetDir * sin(tilt));
  let metal = smoothstep(0.96, 1.02, t);
  // prongs: the metal between stones, domed into beads where three stones meet
  let bead = smoothstep(1.02, 1.18, t) * metal;
  facet = normalize(mix(facet, n, metal));
  r.normal = normalize(mix(n, facet, resolved));
  if (p.debugView > 0.5) { r.emissive = vec3f(t, resolved, fract(k / 8.0)) * 2.0; r.albedo = vec4f(0.0, 0.0, 0.0, 1.0); r.metallic = 0.0; r.roughness = 1.0; return r; }
  // Fire: a brilliant splits white light, so each facet leans a little toward a hue.
  let hue = unitFloat(hash3i(vec3i(st.id * 7.0 + vec3f(k)), 71u));
  let fireTint = vec3f(0.5) + 0.5 * cos(6.2831853 * (hue + vec3f(0.0, 0.33, 0.67)));
  let stoneColor = mix(vec3f(1.0), fireTint, p.fire * (1.0 - metal));
  r.albedo = vec4f(mix(stoneColor, vec3f(0.95, 0.95, 0.97), metal) * mix(0.92, 1.0, resolved), 1.0);
  // A diamond returns light from inside as well as off its facets: part mirror, part a bright
  // white body the key lights, so the pave reads silver-white, not black glass.
  r.metallic = mix(0.93, 1.0, metal);
  r.roughness = mix(mix(0.012, 0.18, metal), 0.1, 1.0 - resolved) + bead * 0.05;
  return r;
}

fn shoeLocal(s: SurfaceIn, p: Params) -> vec3f {
  let d = s.world - p.shoeOrigin;
  return vec3f(dot(d, p.shoeX), dot(d, p.shoeY), dot(d, p.shoeZ));
}

// A stitched seam: a row of short raised thread dashes along the line where f = 0, running
// along the parameter u (metres). Returns the thread coverage.
fn stitch(f: f32, u: f32, footprint: f32) -> f32 {
  let across = smoothstep(0.00045 + footprint, 0.00015, abs(f));
  let along = smoothstep(0.35, 0.3, abs(fract(u / 0.0036) - 0.5));
  return across * along;
}

fn leather(s: SurfaceIn, p: Params, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let q = shoeLocal(s, p);
  let lx = q.x - 0.005 * sin(3.14159 * q.y / 0.29);
  let n = normalize(s.normal);
  // tumbled leather: a fine pebble grain, glossier on the crowns of the pebbles
  let grain = detailFbm(s.world * 900.0, 3, s.footprint);
  let broad = detailFbm(s.world * 60.0, 3, s.footprint);
  var bumpGrad = grain.gradient * 0.00028 + broad.gradient * 0.0006;
  var albedo = vec3f(0.84, 0.84, 0.82) * (0.96 + 0.06 * broad.value);
  var rough = 0.62 + 0.1 * grain.value;
  // panel seams and their double stitching
  let toeSeam = q.y - (0.212 + 18.0 * lx * lx);
  let mudguard = q.z - (0.041 + 0.02 * smoothstep(0.2, 0.29, q.y));
  let heelSeam = q.y - (0.082 - 0.35 * max(q.z - 0.03, 0.0));
  let eyestay = abs(lx) - (0.034 - 0.02 * smoothstep(0.17, 0.205, q.y));
  var thread = 0.0;
  thread = max(thread, stitch(toeSeam - 0.0025, lx, s.footprint));
  thread = max(thread, stitch(toeSeam - 0.0045, lx, s.footprint) * step(0.04, q.z));
  thread = max(thread, stitch(mudguard - 0.0025, q.y, s.footprint) * step(0.07, q.y));
  thread = max(thread, stitch(heelSeam + 0.0025, q.z, s.footprint) * step(0.03, q.z));
  thread = max(thread, stitch(eyestay + 0.0025, q.y, s.footprint) * step(0.105, q.y) * step(q.y, 0.205) * step(0.06, q.z));
  // the panel edges themselves: an overlay's edge is a small step with a dark crease under it
  let edges = min(min(abs(toeSeam), abs(mudguard)), min(abs(heelSeam), select(1.0, abs(eyestay), q.y > 0.1 && q.y < 0.205 && q.z > 0.06)));
  let edge = smoothstep(0.0009 + s.footprint, 0.0, edges);
  albedo = albedo * (1.0 - 0.35 * edge);
  // the perforated toe box: rows of punched holes on the vamp, ahead of the toe seam
  let perfZone = step(0.004, toeSeam) * step(0.047, q.z) * step(abs(lx), 0.034);
  let cellA = vec2f(lx, q.y) / 0.0048;
  let row = floor(cellA.y);
  let hole = length(fract(cellA + vec2f(0.5 * (row % 2.0), 0.0)) - vec2f(0.5)) * 0.0048;
  let holeMask = smoothstep(0.00085 + s.footprint, 0.00055, hole) * perfZone;
  albedo = mix(albedo, vec3f(0.05), holeMask);
  rough = mix(rough, 0.95, holeMask);
  // creases across the toe box, where the foot bends: wavy ridges, deeper in the middle
  let flex = smoothstep(0.17, 0.2, q.y) * smoothstep(0.245, 0.215, q.y) * smoothstep(0.04, 0.06, q.z) * p.grime;
  let wave = sin(q.y / 0.0055 * 6.2831853 + detailNoise(s.world * 80.0).value * 5.0);
  let creaseGrad = p.shoeY * cos(q.y / 0.0055 * 6.2831853) * (6.2831853 / 0.0055) * 0.00022 * flex;
  bumpGrad = bumpGrad + creaseGrad;
  albedo = albedo * (1.0 - 0.07 * flex * max(-wave, 0.0));
  // thread: off-white, raised, matte
  albedo = mix(albedo, vec3f(0.78, 0.78, 0.75), thread);
  rough = mix(rough, 0.7, thread);
  r.normal = detailBump(n, bumpGrad, 1.0);
  r.albedo = vec4f(albedo, 1.0);
  r.roughness = rough;
  r.metallic = 0.0;
  return r;
}

fn sole(s: SurfaceIn, p: Params, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let q = shoeLocal(s, p);
  let n = normalize(s.normal);
  let grain = detailFbm(s.world * 500.0, 3, s.footprint);
  var albedo = vec3f(0.82, 0.8, 0.76);
  // the cupsole's stitch row round the upper band, and a scuffed, faintly yellowed lower edge
  let around = atan2(q.y - 0.145, q.x * 2.4) * 0.13;
  let thread = stitch(q.z - 0.0245, around, s.footprint);
  albedo = mix(albedo, vec3f(0.74, 0.73, 0.7), thread);
  let low = smoothstep(0.012, 0.0, q.z);
  let scuff = smoothstep(0.55, 0.8, detailFbm(s.world * 140.0, 3, s.footprint).value) * low;
  albedo = mix(albedo, vec3f(0.78, 0.72, 0.62), low * 0.5 * p.grime);
  albedo = albedo * (1.0 - scuff * 0.35 * p.grime);
  r.albedo = vec4f(albedo * (0.97 + 0.05 * grain.value), 1.0);
  r.roughness = 0.72 + 0.12 * grain.value;
  r.metallic = 0.0;
  r.normal = detailBump(n, grain.gradient * 0.0003, 1.0);
  return r;
}

fn lace(s: SurfaceIn, o: SurfaceOut) -> SurfaceOut {
  var r = o;
  let n = normalize(s.normal);
  // a woven flat lace: a fine herringbone of fibres
  let weave = detailFbm(vec3f(s.world.x * 2600.0, s.world.y * 2600.0, s.world.z * 600.0), 2, s.footprint);
  r.albedo = vec4f(vec3f(0.86, 0.86, 0.84) * (0.9 + 0.12 * weave.value), 1.0);
  r.roughness = 0.85;
  r.metallic = 0.0;
  r.normal = detailBump(n, weave.gradient * 0.00008, 1.0);
  return r;
}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  switch classOf(s) {
    case 50u: { return pave(s, p, o); }
    case 51u: {
      let brush = detailFbm(s.world * vec3f(4000.0, 300.0, 4000.0), 2, s.footprint);
      o.albedo = vec4f(0.93, 0.93, 0.95, 1.0);
      o.metallic = 1.0;
      o.roughness = 0.05 + 0.04 * brush.value;
      o.normal = detailBump(normalize(s.normal), brush.gradient * 0.00002, 1.0);
    }
    case 52u: { return leather(s, p, o); }
    case 53u: { return sole(s, p, o); }
    case 54u: { return lace(s, o); }
    case 55u: {
      // a painted wall, mottled: out of focus it is only a soft grey-teal field
      let m = detailFbm(s.world * 3.0, 4, s.footprint);
      o.albedo = vec4f(vec3f(0.2, 0.25, 0.25) * (0.85 + 0.3 * m.value), 1.0);
      o.roughness = 0.9;
      o.metallic = 0.0;
      // lit from off frame: a broad soft pool, falling away from its centre
      let away = length(s.world - p.wallCentre);
      o.emissive = vec3f(0.5, 0.74, 0.74) * p.wallGlow * (0.85 + 0.3 * m.value) * exp(-away * away / 0.8);
    }
    case 56u: {
      // black cotton knit: fine vertical ribs and a dull sheen
      let rib = detailFbm(vec3f(s.world.x * 1400.0, s.world.y * 250.0, s.world.z * 1400.0), 2, s.footprint);
      o.albedo = vec4f(vec3f(0.022, 0.022, 0.024) * (0.8 + 0.4 * rib.value), 1.0);
      o.roughness = 0.78;
      o.metallic = 0.0;
      o.normal = detailBump(normalize(s.normal), rib.gradient * 0.0002, 1.0);
    }
    case 57u: { o.albedo = vec4f(0.05, 0.05, 0.052, 1.0); o.roughness = 0.9; o.metallic = 0.0; }
    case 58u: {
      // the warehouse's far windows: grimy wired glass lit from outside, a dim cold glow,
      // uneven pane to pane, the wire mesh and the grime darker
      let pane = floor(s.world * 1.4);
      let h = unitFloat(hash3i(vec3i(pane), 5u));
      let grime = detailFbm(s.world * 2.0, 4, s.footprint).value;
      let mesh = max(smoothstep(0.93, 0.98, fract(s.world.x * 1.4 + s.world.z * 1.4)), smoothstep(0.93, 0.98, fract(s.world.y * 1.4)));
      o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
      o.emissive = vec3f(0.62, 0.74, 0.8) * p.windowGlow * (0.35 + 0.65 * h) * (0.6 + 0.6 * grime) * (1.0 - 0.8 * mesh);
      o.roughness = 1.0;
      o.metallic = 0.0;
    }
    default: {}
  }
  return o;
}`;
