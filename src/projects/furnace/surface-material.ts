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
import type { FurnaceSceneFacts, MaterialFacts } from "./scene-facts.ts";

/** Surface classes the plant material draws differently; 0 falls through to the generic surface. */
const CLASS_OF: ReadonlyArray<readonly [RegExp, number, string]> = [
  [/paint|pipe_green|primer/, 1, "painted steel"],
  [/steel_dark|steel_worn|steel_heat|panel_cooled|graphite/, 2, "bare steel"],
  [/galvani|roof/, 3, "galvanized sheet"],
  [/chequer|grating/, 4, "chequer plate and grating"],
  [/rust|scrap/, 5, "rust"],
  [/concrete/, 6, "concrete"],
  [/refractory/, 7, "refractory brick"],
  [/rubber|cable|hose/, 8, "rubber"],
  [/copper/, 9, "copper"],
  [/slag_cold/, 10, "cold slag"],
];

function classOf(material: MaterialFacts): number {
  return CLASS_OF.find(([pattern]) => pattern.test(material.name))?.[1] ?? 0;
}

/**
 * The CLASSIFIER, generated from the GLB's own material table: a vertex carries its
 * material's exact metallic and roughness factors (the decoder flattens them), which are
 * near-unique per material — the nearest pair names the class, heat breaking the ties.
 */
function classifierWgsl(materials: readonly MaterialFacts[]): string {
  const known = materials.filter((material) => classOf(material) !== 0);
  const rows = known.map((material) => `  if (abs(metal - ${material.metallic.toFixed(4)}) < 0.004 && abs(rough - ${material.roughness.toFixed(4)}) < 0.004 && abs(heat - ${material.heat.toFixed(4)}) < 0.02) { return ${classOf(material)}u; } // ${material.name}`);
  return `fn materialClass(metal: f32, rough: f32, heat: f32) -> u32 {
${rows.join("\n")}
  return 0u;
}`;
}

export function plantSurfaceWgsl(facts: FurnaceSceneFacts): string {
  return PLANT_SURFACE_WGSL.replace("// @classifier", classifierWgsl(facts.materials));
}

const PLANT_SURFACE_WGSL = `// @use surface-detail
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
  kickCount: f32, // @default 0  Running kick count: each kick re-picks WHICH parts of the plant the wave lights.
  flicker: f32, // @default 0  Hats: panels light up as corrupt blocks, hash-picked per 1.5 m panel.
  heatGlow: f32, // @default 14  (Legacy; the liquid and solid glows below replace it.)
  liquidGlow: f32, // @default 2  Radiance of liquid steel at its hottest.
  fire: f32, // @default 18  Radiance of the flames inside the furnace (the audio's handle).
  liningGlow: f32, // @default 12  Radiance of hot SOLIDS — the strand, hot slag, graphite, linings.
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
  // The ring is hot at its leading edge and cools behind it — white, orange, deep red —
  // with a second, cold echo ring running a beat behind.
  let lead = exp(-pow((length(s.world.xz) - radius) / 0.5, 2.0));
  let wake = exp(-pow((length(s.world.xz) - radius + 3.0) / 2.5, 2.0));
  let echo = exp(-pow((length(s.world.xz) - radius * 0.6) / 0.6, 2.0)) * exp(-p.kickSince * 3.5);
  let fade = exp(-p.kickSince * 3.0);
  // SELECTIVE: each kick picks what answers, rotating through three ways of choosing —
  // scattered 6 m blocks, one horizontal band of the building, or only the machines — so the
  // whole plant never lights the same way twice in a row.
  let mode = u32(p.kickCount) % 3u;
  let block = floor(s.world / 6.0);
  let pickBlock = step(0.62, fract(sin(dot(block, vec3f(12.9898, 78.233, 37.719)) + p.kickCount * 3.17) * 43758.5453));
  let bandCentre = 2.0 + fract(p.kickCount * 0.618) * 24.0;
  let pickBand = 1.0 - smoothstep(1.5, 3.5, abs(s.world.y - bandCentre));
  let pickMachine = step(0.5, s.attr.w);
  let chosen = select(select(pickMachine, pickBand, mode == 1u), pickBlock, mode == 0u);
  var fx = ((vec3f(1.0, 0.9, 0.7) * lead * 6.0 + vec3f(1.0, 0.35, 0.05) * wake * 2.5) * fade * (seam * 1.5 + 0.08)
    + vec3f(0.2, 0.7, 1.0) * echo * seam * 2.5) * chosen;
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

// @classifier

struct Skin {
  albedo: vec3f,
  roughness: f32,
  metallic: f32,
  normal: vec3f,
  // 1 where paint has flaked to the metal beneath (the generic wear then leaves it alone).
  exposed: f32,
};

// Two coordinates ON the face: the world projected along the face's dominant axis.
fn faceUv(world: vec3f, normal: vec3f) -> vec2f {
  let a = abs(normal);
  if (a.x > a.y && a.x > a.z) { return world.zy; }
  if (a.z > a.y) { return world.xy; }
  return world.xz;
}

fn cellHash(c: vec2f) -> f32 {
  return fract(sin(dot(c, vec2f(127.1, 311.7))) * 43758.5453);
}

// Rust, in three layers: dark iron oxide, orange bloom, ochre dust.
fn rustColour(n: f32) -> vec3f {
  return mix(mix(vec3f(0.09, 0.035, 0.015), vec3f(0.34, 0.11, 0.03), smoothstep(0.3, 0.6, n)), vec3f(0.42, 0.24, 0.08), smoothstep(0.7, 0.9, n));
}

fn classSkin(kind: u32, s: SurfaceIn, base: vec3f, normal: vec3f, p: Params) -> Skin {
  var k: Skin;
  k.albedo = base;
  k.roughness = s.roughness;
  k.metallic = s.metallic;
  k.normal = normal;
  k.exposed = 0.0;
  let w = s.world;
  let fp = s.footprint;
  switch kind {
    case 1u: {
      // PAINT: chips flake down to RUST (not bright metal), rust bleeds in streaks below them,
      // and runs of thicker paint catch the light.
      let chip = detailFbm(w * 2.6, 4, fp).value;
      let edge = detailEdgeWear(s.curvature, 5.0, chip);
      let flake = clamp(max(edge, smoothstep(0.66, 0.74, chip)) * p.wear, 0.0, 1.0);
      let bleed = smoothstep(0.62, 0.8, detailFbm(vec3f(w.x * 5.0, w.y * 0.35, w.z * 5.0), 3, fp).value) * (1.0 - abs(normal.y));
      let rust = rustColour(detailFbm(w * 7.0, 3, fp).value);
      k.albedo = mix(mix(base, base * vec3f(0.62, 0.42, 0.3), bleed * 0.7), rust, flake);
      k.roughness = mix(0.42 + 0.2 * chip, 0.85, flake);
      k.metallic = mix(0.05, 0.3, flake);
      k.normal = detailBump(normal, detailFbm(w * 2.6, 3, fp).gradient, 0.05 + flake * 0.12);
      k.exposed = flake;
    }
    case 2u: {
      // BARE STEEL: brushed along the part, blue-black mill scale in islands, and TEMPER
      // colours near the furnace — straw, bronze, purple, blue with rising heat.
      let brush = detailFbm(vec3f(w.x * 40.0, w.y * 1.5, w.z * 40.0), 2, fp).value;
      let scale = smoothstep(0.45, 0.62, detailFbm(w * 1.1, 4, fp).value);
      let near = 1.0 - smoothstep(4.0, 16.0, length(w.xz));
      let temper = clamp(near * (0.55 + 0.6 * detailFbm(w * 0.6, 3, fp).value) + p.heatPulse * near * 0.3, 0.0, 1.0);
      let tint = mix(mix(vec3f(0.62, 0.5, 0.26), vec3f(0.5, 0.26, 0.12), smoothstep(0.2, 0.45, temper)), mix(vec3f(0.3, 0.12, 0.32), vec3f(0.12, 0.2, 0.42), smoothstep(0.7, 0.9, temper)), smoothstep(0.45, 0.7, temper));
      var steel = base * (0.75 + 0.5 * brush);
      steel = mix(steel, vec3f(0.035, 0.04, 0.05), scale * 0.8);
      k.albedo = mix(steel, tint * (0.6 + 0.4 * brush), smoothstep(0.12, 0.3, temper) * 0.85);
      k.roughness = clamp(mix(0.28 + 0.25 * brush, 0.7, scale), 0.08, 1.0);
      k.metallic = mix(0.95, 0.55, scale);
      k.normal = detailBump(normal, detailFbm(w * 3.0, 3, fp).gradient, 0.04);
    }
    case 3u: {
      // GALVANIZED: spangle — crystal cells of slightly different sheen — and white rust.
      let uv = faceUv(w, normal) * 9.0;
      let spangle = cellHash(floor(uv + detailNoise(vec3f(uv, 0.0) * 0.5).value));
      let whiteRust = smoothstep(0.6, 0.78, detailFbm(w * 1.4, 4, fp).value);
      k.albedo = mix(base * (0.8 + 0.45 * spangle), vec3f(0.55, 0.56, 0.55), whiteRust * 0.7);
      k.roughness = mix(0.22 + 0.3 * spangle, 0.9, whiteRust);
      k.metallic = mix(0.9, 0.2, whiteRust);
    }
    case 4u: {
      // CHEQUER PLATE: raised lozenges in alternating directions, polished bright by boots on
      // top, grime packed between them.
      let uv = faceUv(w, normal) * 3.2;
      let cell = floor(uv);
      let f = fract(uv) - 0.5;
      let turn = select(vec2f(f.x + f.y, f.x - f.y), vec2f(f.x - f.y, f.x + f.y), (i32(cell.x + cell.y) & 1) == 1) * 0.7071;
      let lozenge = 1.0 - smoothstep(0.06, 0.1, length(vec2f(turn.x * 0.28, turn.y)));
      let grad = vec3f(-turn.x, 0.0, -turn.y) * lozenge * 3.0;
      let worn = lozenge * abs(normal.y);
      k.albedo = mix(base * 0.7, vec3f(0.5, 0.5, 0.5), worn * 0.8);
      k.roughness = mix(0.62, 0.22, worn);
      k.metallic = 0.9;
      k.normal = detailBump(normal, grad, 0.18);
    }
    case 5u: {
      // RUST: flaky, layered, pitted.
      let n = detailFbm(w * 4.0, 4, fp);
      k.albedo = rustColour(n.value) * (0.7 + 0.6 * detailFbm(w * 0.8, 2, fp).value);
      k.roughness = 0.9;
      k.metallic = 0.15;
      k.normal = detailBump(normal, n.gradient, 0.3);
    }
    case 6u: {
      // CONCRETE: aggregate, cracks, oil stains, and painted walkway lines on the floor.
      let aggregate = detailFbm(w * 14.0, 2, fp).value;
      let crackField = detailFbm(vec3f(w.x, 0.0, w.z) * 0.35, 4, fp).value;
      let crack = 1.0 - smoothstep(0.004, 0.018, abs(crackField - 0.5));
      let oil = smoothstep(0.55, 0.7, detailFbm(w * 0.25 + vec3f(7.0), 4, fp).value);
      let floorFace = smoothstep(0.9, 0.97, normal.y);
      let lane = floorFace * (1.0 - smoothstep(0.07, 0.1, abs(fract(w.z / 9.0 + 0.5) - 0.5) * 9.0 - 3.6)) * step(0.25, fract(w.x / 3.0));
      var c = base * (0.8 + 0.4 * aggregate);
      c = mix(c, vec3f(0.02, 0.018, 0.016), crack * 0.85);
      c = mix(c, c * 0.3, oil * floorFace);
      // Walkway lines: worn, dirty — a trace of paint, not a fresh yellow stripe.
      c = mix(c, vec3f(0.42, 0.3, 0.06) * (0.5 + 0.5 * aggregate), lane * 0.45 * smoothstep(0.35, 0.6, aggregate));
      k.albedo = c;
      k.roughness = mix(mix(0.9, 0.12, oil * floorFace), 0.5, lane);
      k.metallic = 0.0;
      k.normal = detailBump(normal, detailFbm(w * 6.0, 3, fp).gradient, 0.08);
    }
    case 7u: {
      // REFRACTORY: brick courses in running bond, each brick its own shade, dark mortar.
      let uv = faceUv(w, normal) / vec2f(0.46, 0.14);
      let row = floor(uv.y);
      let brickUv = vec2f(uv.x + 0.5 * (row % 2.0), uv.y);
      let brick = floor(brickUv);
      let f = fract(brickUv);
      let mortar = 1.0 - smoothstep(0.03, 0.07, min(min(f.x, 1.0 - f.x) * 0.46 / 0.14, min(f.y, 1.0 - f.y)));
      let shade = cellHash(brick);
      k.albedo = mix(base * (0.65 + 0.6 * shade) * vec3f(1.0, 0.92, 0.85), vec3f(0.05, 0.045, 0.04), mortar);
      k.roughness = 0.92;
      k.metallic = 0.0;
      k.normal = detailBump(normal, vec3f(f.x - 0.5, f.y - 0.5, 0.0) * mortar * 2.0, 0.2);
    }
    case 8u: {
      // RUBBER: dark satin, dust in the grain.
      let grainy = detailFbm(w * 20.0, 2, fp).value;
      k.albedo = base * (0.8 + 0.4 * grainy);
      k.roughness = 0.55 + 0.2 * grainy;
      k.metallic = 0.0;
    }
    case 9u: {
      // COPPER: bright on the edges, verdigris and dark tarnish in the flats.
      let tarnish = detailFbm(w * 2.0, 3, fp).value;
      let edge = detailEdgeWear(s.curvature, 4.0, tarnish);
      let verdigris = smoothstep(0.62, 0.75, tarnish) * (1.0 - edge);
      k.albedo = mix(mix(base * 0.45, base * 1.25, edge), vec3f(0.12, 0.3, 0.24), verdigris);
      k.roughness = mix(mix(0.45, 0.2, edge), 0.8, verdigris);
      k.metallic = mix(1.0, 0.1, verdigris);
    }
    case 10u: {
      // COLD SLAG: glassy black, bubbled, an oil-slick sheen where it is smooth.
      let bubbles = detailFbm(w * 9.0, 3, fp);
      let sheen = 0.5 + 0.5 * sin(bubbles.value * 18.0 + vec3f(0.0, 2.1, 4.2));
      k.albedo = mix(vec3f(0.02), sheen * 0.08, smoothstep(0.5, 0.7, bubbles.value));
      k.roughness = mix(0.25, 0.9, bubbles.value);
      k.metallic = 0.3;
      k.normal = detailBump(normal, bubbles.gradient, 0.35);
    }
    default: {}
  }
  return k;
}

// Inside the furnace shell (radius ~4.2 m about the vertical axis, between the hearth and the
// roof): flames licking up the walls and a foaming, boiling slag line — what the slag door
// and the roof gaps show. Advected upward, broken by noise, flickering with the music.
fn furnaceInterior(s: SurfaceIn, p: Params) -> vec3f {
  let r = length(s.world.xz);
  // Only the LINING: a surface inside the radius whose normal faces the axis (the shell's
  // outer skin faces away, and must stay steel).
  let inward = smoothstep(0.2, 0.6, dot(s.normal.xz, -s.world.xz / max(r, 1e-3)));
  let floorOfBath = smoothstep(0.7, 0.95, s.normal.y) * (1.0 - smoothstep(2.5, 3.8, r));
  let inside = (1.0 - smoothstep(3.6, 4.2, r)) * max(inward, floorOfBath) * smoothstep(6.0, 7.0, s.world.y) * (1.0 - smoothstep(12.0, 13.0, s.world.y));
  if (inside <= 0.0 || p.fire <= 0.0) { return vec3f(0.0); }
  let t = s.absTime;
  let rise = vec3f(s.world.x * 1.3, s.world.y * 0.9 - t * 2.6, s.world.z * 1.3);
  let tongues = detailFbm(rise, 4, s.footprint).value;
  let flicker = detailFbm(vec3f(s.world.xz * 0.7, t * 3.0), 2, s.footprint).value;
  let height = 1.0 - smoothstep(8.0, 12.5, s.world.y);
  let flame = smoothstep(0.42, 0.75, tongues * (0.6 + 0.6 * flicker) + height * 0.3);
  // The slag line: a boiling band around the bath level.
  let foam = smoothstep(0.45, 0.7, detailFbm(vec3f(s.world.xz * 2.2, t * 1.8), 3, s.footprint).value) * (1.0 - smoothstep(0.0, 0.9, abs(s.world.y - 8.9)));
  let temperature = clamp(0.55 + 0.45 * flame + 0.3 * foam, 0.0, 1.0);
  return blackbody(temperature) * p.fire * inside * (flame * flame + foam * 0.8);
}

// The slag door's back plate is a PORTAL (interior mapping): the view ray continues through
// it into a virtual furnace, and what it meets there is shaded — the churning bath at the
// slag line, flames boiling up off it, the far wall glowing. A flat hot plate in the model
// becomes a hole into a furnace.
fn doorPortal(s: SurfaceIn, p: Params) -> vec4f {
  let w = s.world;
  let onPlate = step(-3.62, w.x) * step(w.x, -3.2) * step(abs(w.z), 0.78) * step(8.8, w.y) * step(w.y, 10.55) * step(0.6, -s.normal.x);
  if (onPlate <= 0.0) { return vec4f(0.0); }
  let ray = normalize(w - s.eye);
  // The bath, 0.25 m below the sill, reaching deep into the shell.
  let bathY = 8.6;
  var colour = vec3f(0.0);
  if (ray.y < -0.02) {
    let t = (bathY - w.y) / ray.y;
    let hit = w + ray * t;
    let flow = vec3f(s.absTime * 0.35, 0.0, s.absTime * 0.2);
    let cells = detailFbm(hit * 1.1 - flow, 3, s.footprint).value;
    let churn = detailFbm(hit * 3.5 - flow * 1.8, 3, s.footprint).value;
    let temperature = clamp(0.45 + 0.4 * cells + 0.25 * churn, 0.0, 1.1);
    colour = blackbody(temperature) * p.liquidGlow * 6.0 * temperature * temperature * exp(-t * 0.08);
  }
  // Flames: a slab of turbulent fire filling the space, sampled along the ray.
  var flames = 0.0;
  for (var k = 1; k <= 6; k = k + 1) {
    let x = w + ray * f32(k) * 0.55;
    let rise = vec3f(x.x * 1.4, x.y * 1.1 - s.absTime * 3.2, x.z * 1.4);
    let tongue = smoothstep(0.5, 0.8, detailFbm(rise, 3, s.footprint).value) * (1.0 - smoothstep(9.0, 11.5, x.y));
    flames = flames + tongue * 0.3;
  }
  colour = colour + blackbody(0.8) * p.fire * 0.35 * flames;
  return vec4f(colour, 1.0);
}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceBody(s, p);
  let portal = doorPortal(s, p);
  if (portal.w > 0.0) {
    o.albedo = vec4f(vec3f(0.0), s.albedo.a);
    o.emissive = portal.rgb;
    o.roughness = 1.0;
    o.metallic = 0.0;
    return o;
  }
  o.emissive = o.emissive + furnaceInterior(s, p);
  return o;
}

fn surfaceBody(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let heat = s.attr.z;

  if (heat >= 0.9) {
    // LIQUID STEEL, read at a camera's distance: a surface of CELLS — bright upwellings
    // bounded by darker, cooling seams (Voronoi-like, from the distance to the nearest of a
    // jittered grid), crossed by black slag rafts that drift and tear, fume lifting off.
    let flow = vec3f(s.absTime * p.heatFlow, 0.0, s.absTime * p.heatFlow * 0.6);
    let q = s.world.xz * 1.3 + vec2f(detailNoise(vec3f(s.world.xz * 0.8, s.absTime * 0.3)).value) * 0.9;
    let cell = floor(q);
    var nearest = 9.0;
    var second = 9.0;
    for (var j = -1; j <= 1; j = j + 1) {
      for (var i = -1; i <= 1; i = i + 1) {
        let c = cell + vec2f(f32(i), f32(j));
        let h = fract(sin(vec2f(dot(c, vec2f(127.1, 311.7)), dot(c, vec2f(269.5, 183.3)))) * 43758.5453);
        let site = c + 0.5 + 0.4 * sin(h * 6.2831 + s.absTime * (0.6 + h));
        let d = length(q - site);
        if (d < nearest) { second = nearest; nearest = d; } else if (d < second) { second = d; }
      }
    }
    let seam = 1.0 - smoothstep(0.02, 0.22, second - nearest);
    let churn = detailFbm(s.world * 3.2 - flow * 1.7 + vec3f(0.0, s.absTime * 0.4, 0.0), 3, s.footprint);
    let rafts = smoothstep(0.5, 0.6, detailFbm(s.world * 0.7 - flow * 0.4, 3, s.footprint).value);
    let skin = clamp(rafts * p.crust * (1.0 - p.heatPulse * 0.6), 0.0, 1.0);
    let raftCracks = (1.0 - smoothstep(0.02, 0.06, abs(churn.value - 0.5))) * skin;
    let core = 1.0 - smoothstep(0.0, 0.55, nearest);
    let temperature = clamp(heat * (0.45 + 0.35 * core + 0.3 * churn.value - 0.18 * seam) + p.heatPulse * 0.25, 0.0, 1.1);
    let glow = blackbody(temperature) * p.liquidGlow * temperature * temperature * (1.0 - 0.3 * seam);
    o.emissive = glow * (1.0 - skin * 0.985) + blackbody(0.6) * p.liquidGlow * 0.6 * raftCracks;
    o.albedo = vec4f(vec3f(0.03, 0.026, 0.024) * (0.5 + skin), s.albedo.a);
    o.roughness = mix(0.1, 0.85, skin);
    o.metallic = 0.0;
    o.normal = detailBump(s.normal, churn.gradient * (1.0 - skin) * 0.5 + vec3f(q.x - cell.x - 0.5, 0.0, q.y - cell.y - 0.5) * seam, 0.15 + skin * 0.2);
    return o;
  }

  if (heat > 0.01) {
    // HOT SOLIDS (the strand, hot slag, graphite, refractory): BLAZING — a solid at 1200 °C is
    // a light source. Orange-yellow body, brighter cracks, a darker oxide scale that breaks.
    let grain = detailFbm(s.world * 2.4, 4, s.footprint);
    let crackField = detailFbm(s.world * 0.9, 3, s.footprint).value;
    let cracks = 1.0 - smoothstep(0.012, 0.05, abs(crackField - 0.5));
    // Hot SLAG (dielectric, rough) is a black crust that glows only in its fissures; hot steel
    // (the strand, graphite) glows through a thin, breaking oxide.
    let slag = step(s.metallic, 0.05) * step(0.65, s.roughness) * step(heat, 0.8);
    let oxide = mix(smoothstep(0.55, 0.75, detailFbm(s.world * 1.6, 3, s.footprint).value) * (1.0 - heat * 0.6), 1.0 - cracks, slag);
    let temperature = clamp(heat * (0.75 + 0.35 * grain.value) + cracks * 0.3 * heat + p.heatPulse * 0.25, 0.0, 1.0);
    o.emissive = blackbody(temperature) * p.liningGlow * temperature * temperature * (1.0 - oxide * 0.8);
    o.albedo = vec4f(s.albedo.rgb * 0.4, s.albedo.a);
    o.roughness = mix(0.6, 0.95, oxide);
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

  // The surface CLASS (from the file's own material table) draws its own texture.
  let kind = materialClass(s.metallic, s.roughness, s.attr.z);
  var metallic = s.metallic;
  var roughness = s.roughness;
  var wear = 0.0;
  if (kind != 0u) {
    let skin = classSkin(kind, s, albedo, normal, p);
    albedo = skin.albedo;
    roughness = skin.roughness;
    metallic = skin.metallic;
    normal = skin.normal;
    wear = skin.exposed;
  } else {
    // Unclassified: paint worn back to bare steel on edges, and a little where it is knocked.
    let chips = detailFbm(s.world * 3.2, 3, s.footprint).value;
    wear = painted * p.wear * max(detailEdgeWear(s.curvature, 6.0, chips), smoothstep(0.72, 0.85, chips) * 0.5);
    albedo = mix(albedo, vec3f(0.42, 0.41, 0.4), wear);
    metallic = mix(s.metallic, 0.95, wear);
    roughness = mix(s.roughness, 0.32, wear);
  }

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
  // Openings near the floor (the hall's doors to the yard) stay dim: at full sky brightness
  // they leaked white light under the machinery.
  o.emissive = s.emissive * p.sky * mix(0.12, 1.0, smoothstep(6.0, 14.0, s.world.y));
  return o;
}`;
