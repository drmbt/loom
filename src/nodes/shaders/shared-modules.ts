import { remember } from "../definitions/params-reflection.ts";
import { WGSL_HASH } from "./common.wgsl.ts";

/**
 * T1286 — THE WGSL A `customWgsl` SOURCE MAY PULL IN, BY NAME.
 *
 * Until now a source reached exactly one thing: `SHARED_UNIFORMS_WGSL`. Everything else in
 * the repo's WGSL was private to the file it was typed into — §T1283's survey found
 * `time-grid.wgsl.ts`'s `cellAt()` was the ONLY function shared across more than one
 * shader, while `common.wgsl.ts` already held the integer lattice hashes that every new
 * shader re-writes by hand.
 *
 * ## Why a registry rather than a blanket prelude
 *
 * A prepend that hands every source everything is cheap to write and wrong twice over: it
 * puts code a shader never asked for into its compile (and into any error message it
 * produces), and it makes every future addition a global change to every shader in the
 * catalogue. The row's constraint is EXPLICIT PER SOURCE, and this is that: a source names
 * what it wants and gets nothing else.
 *
 * ## What may live here, and what may not
 *
 * ⚑ A MODULE MUST BE PARAMETER-FREE. Everything it needs arrives as a function argument;
 * it may not read `params` (the host's own reflected struct) and it may not read `frameU`
 * (the shared frame block). That rule is not tidiness — it is what makes a module MEAN the
 * same thing in the shader that imports it as in the one it came from. §T1286 found the
 * two blocks the row most wanted are not parameter-free today: `reactor.wgsl.ts`'s Worley
 * (`cellEdge`) reads `params.morph` and `frameU.absTime`, and `alembic.wgsl.ts`'s `fold()`
 * reads four `params` fields and a local `spin()`. Sharing either means re-cutting it so
 * its knobs are arguments, with byte-identity proved on the file it came from — a refactor
 * per block, not an entry in this table.
 *
 * ## Names are global to a source's compile, so they are chosen once and here
 *
 * A module's declarations land in the same namespace as the importing source's own, and a
 * collision is refused BY NAME at compile rather than shadowed (`custom-wgsl.ts`). That is
 * also why `cellAt`'s struct is `GridCell` here and not `Cell`: two shipped shaders declare
 * a `Cell` with different fields, and a shared module that claimed the bare name would make
 * the two un-importable together for no reason anybody could see from the call site.
 */
export interface SharedWgslModule {
  /** The WGSL this module contributes, verbatim. */
  readonly source: string;
  /** Modules this one calls into. Pulled in automatically, once, before it. */
  readonly requires?: readonly string[];
  /** What it is for, in one line — read by the editor's completion and by error text. */
  readonly summary: string;
}

/**
 * The integer avalanche family (`hashU32`, `hash2`, `hash3`, …) already in `common.wgsl.ts`.
 *
 * INTEGER on purpose, and the reason is §V44's sibling promise: a float hash built on
 * `fract(sin(x))` is a different number on every driver, so a seeded look would replay
 * differently per machine. `u32` shifts and multiplies are exact everywhere WGSL runs.
 */
const HASH_MODULE: SharedWgslModule = {
  summary: "integer lattice hashes — exact on every driver, unlike fract(sin(x))",
  source: WGSL_HASH,
};

/**
 * The uniform grid partition, lifted from `time-grid.wgsl.ts` (§T1283 named it the only
 * WGSL already shared across shaders, which is what makes it the safe first entry here).
 *
 * It is the SAME partition the Tile node uses — `floor(uv * repeat)`, offset zero, both
 * rounding the count the same way — so a cell here is exactly a cell there and no effect
 * built on it can straddle a seam.
 */
const GRID_MODULE: SharedWgslModule = {
  summary: "uniform grid partition: index, count, origin, size and local uv of a cell",
  source: `struct GridCell {
  index: f32,
  count: f32,
  last: f32,
  local: vec2f,
  origin: vec2f,
  size: vec2f,
};

fn gridCellAt(uv: vec2f, grid: vec2f) -> GridCell {
  let cols = max(1.0, floor(grid.x + 0.5));
  let rows = max(1.0, floor(grid.y + 0.5));
  let ij = clamp(floor(uv * vec2f(cols, rows)), vec2f(0.0), vec2f(cols - 1.0, rows - 1.0));
  var cell: GridCell;
  cell.index = (ij.y * cols) + ij.x;
  cell.count = cols * rows;
  cell.last = max(1.0, cell.count - 1.0);
  cell.size = vec2f(1.0 / cols, 1.0 / rows);
  cell.origin = ij * cell.size;
  cell.local = clamp((uv - cell.origin) / cell.size, vec2f(0.0), vec2f(1.0));
  return cell;
}`,
};

/**
 * T1377b — SURFACE DETAIL for Material · WGSL: the micro-structure textures would carry,
 * built procedurally in world space so an untextured mesh still has dents, grain, seams and
 * wear. Integer-hashed value noise with an ANALYTIC gradient (so a bump costs no extra
 * taps), an fbm that drops octaves finer than the pixel footprint (so detail fades instead
 * of aliasing as the camera pulls back), a bump that tilts a normal by a height field's
 * gradient projected onto the surface, and wear masks keyed to curvature.
 *
 * Parameter-free per this file's rule: scale, strength, footprint and curvature arrive as
 * arguments (a Material · WGSL passes `s.footprint` and `s.curvature`).
 */
const SURFACE_DETAIL_MODULE: SharedWgslModule = {
  summary: "world-space surface detail: noise with gradient, footprint-filtered fbm, bump, wear masks",
  requires: ["hash"],
  source: `struct DetailSample {
  value: f32,
  gradient: vec3f,
};

fn detailLattice(cell: vec3f) -> f32 {
  return unitFloat(hash3i(vec3i(cell), 0x9e37u));
}

// Value noise in [0, 1] with its analytic gradient (quintic fade).
fn detailNoise(p: vec3f) -> DetailSample {
  let i = floor(p);
  let f = p - i;
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  let a = detailLattice(i);
  let b = detailLattice(i + vec3f(1.0, 0.0, 0.0));
  let c = detailLattice(i + vec3f(0.0, 1.0, 0.0));
  let d = detailLattice(i + vec3f(1.0, 1.0, 0.0));
  let e = detailLattice(i + vec3f(0.0, 0.0, 1.0));
  let g = detailLattice(i + vec3f(1.0, 0.0, 1.0));
  let h = detailLattice(i + vec3f(0.0, 1.0, 1.0));
  let k = detailLattice(i + vec3f(1.0, 1.0, 1.0));
  let k0 = a;
  let k1 = b - a;
  let k2 = c - a;
  let k3 = e - a;
  let k4 = a - b - c + d;
  let k5 = a - c - e + h;
  let k6 = a - b - e + g;
  let k7 = -a + b + c - d + e - g - h + k;
  var sample: DetailSample;
  sample.value = k0 + k1 * u.x + k2 * u.y + k3 * u.z + k4 * u.x * u.y + k5 * u.y * u.z + k6 * u.z * u.x + k7 * u.x * u.y * u.z;
  sample.gradient = du * vec3f(
    k1 + k4 * u.y + k6 * u.z + k7 * u.y * u.z,
    k2 + k5 * u.z + k4 * u.x + k7 * u.z * u.x,
    k3 + k6 * u.x + k5 * u.y + k7 * u.x * u.y,
  );
  return sample;
}

// fbm with gradient; an octave whose wavelength is under ~2 pixels (footprint = world metres
// per pixel) is faded out rather than sampled, so distant detail averages instead of sparkling.
fn detailFbm(p: vec3f, octaves: i32, footprint: f32) -> DetailSample {
  var total: DetailSample;
  total.value = 0.0;
  total.gradient = vec3f(0.0);
  var amplitude = 0.5;
  var frequency = 1.0;
  var weight = 0.0;
  for (var octave = 0; octave < octaves; octave = octave + 1) {
    let fade = 1.0 - smoothstep(0.25, 0.5, footprint * frequency);
    let n = detailNoise(p * frequency + vec3f(f32(octave) * 17.13));
    total.value = total.value + (n.value - 0.5) * amplitude * fade;
    total.gradient = total.gradient + n.gradient * amplitude * frequency * fade;
    weight = weight + amplitude;
    amplitude = amplitude * 0.5;
    frequency = frequency * 2.07;
  }
  total.value = total.value / max(weight, 1e-4) + 0.5;
  return total;
}

// Tilt a unit normal by a height field's world gradient, projected onto the surface.
fn detailBump(normal: vec3f, gradient: vec3f, strength: f32) -> vec3f {
  let tangential = gradient - normal * dot(gradient, normal);
  return normalize(normal - tangential * strength);
}

// 0..1 wear on convex edges: curvature is |d normal| / |d position| (1/metres).
fn detailEdgeWear(curvature: f32, threshold: f32, noise: f32) -> f32 {
  return smoothstep(threshold * 0.6, threshold * 1.6, curvature * (0.6 + 0.8 * noise));
}`,
};

/**
 * T1417b — reading a Render's LIGHT DEPTH output: whether a world point is lit by that
 * Render's first casting light. The layouts are the Render's own (`scene.ts`'s shadow sweeps,
 * `domain/geometry/camera.ts`'s matrices), rebuilt from the light's placement rather than
 * passed as matrices: a POINT light's map is the 3×2 cube atlas (+X, −X, +Y, −Y, +Z, −Z), each
 * face a 90° frustum storing radial distance ÷ range; a DIRECTIONAL light's is the ortho
 * volume round the origin (half-extent `extent`, 3 × extent deep, the map's own aspect)
 * storing its z. One nearest texel, no PCF: a march samples many points and averages anyway.
 * `bias` is in metres along the light. What a haze or a shaft needs — the light's own view of
 * its occluders, where a march through the CAMERA's depth sees only what the camera sees.
 */
const LIGHT_DEPTH_MODULE: SharedWgslModule = {
  summary: "light visibility from a Render's Light Depth output (point cube atlas or directional ortho map)",
  source: `fn lightDepthPointVisible(map: texture_2d<f32>, light: vec3f, range: f32, p: vec3f, bias: f32) -> f32 {
  let toP = p - light;
  let distance = length(toP);
  if (distance >= range) { return 1.0; }
  let axes = abs(toP);
  var face = 0u;
  var axis = vec3f(1.0, 0.0, 0.0);
  var up = vec3f(0.0, 1.0, 0.0);
  if (axes.x >= axes.y && axes.x >= axes.z) {
    face = select(1u, 0u, toP.x > 0.0);
    axis = vec3f(sign(toP.x), 0.0, 0.0);
  } else if (axes.y >= axes.z) {
    face = select(3u, 2u, toP.y > 0.0);
    axis = vec3f(0.0, sign(toP.y), 0.0);
    up = vec3f(0.0, 0.0, -sign(toP.y));
  } else {
    face = select(5u, 4u, toP.z > 0.0);
    axis = vec3f(0.0, 0.0, sign(toP.z));
  }
  let right = normalize(cross(axis, up));
  let trueUp = cross(right, axis);
  let w = max(dot(toP, axis), 1e-6);
  let ndc = vec2f(dot(toP, right), dot(toP, trueUp)) / w;
  let suv = clamp(vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5), vec2f(0.0), vec2f(1.0));
  let atlas = vec2f(textureDimensions(map, 0));
  let tile = floor(atlas / vec2f(3.0, 2.0));
  let origin = vec2i(vec2f(f32(face % 3u), f32(face / 3u)) * tile);
  let stored = textureLoad(map, origin + vec2i(suv * (tile - vec2f(1.0))), 0).r;
  return select(1.0, 0.0, (distance - bias) / range > stored);
}

fn lightDepthDirectionalVisible(map: texture_2d<f32>, direction: vec3f, extent: f32, p: vec3f, bias: f32) -> f32 {
  let d = normalize(direction);
  let eye = -d * extent;
  let up = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(d.y) > 0.999);
  let right = normalize(cross(up, -d));
  let trueUp = cross(-d, right);
  let dims = vec2f(textureDimensions(map, 0));
  let aspect = max(dims.x / max(dims.y, 1.0), 1e-6);
  let halfH = extent * max(1.0, 1.0 / aspect);
  let rel = p - eye;
  let clip = vec2f(dot(rel, right) / (halfH * aspect), dot(rel, trueUp) / halfH);
  let depth = (dot(rel, d) - 0.01) / (3.0 * extent - 0.01);
  let suv = vec2f(clip.x * 0.5 + 0.5, 0.5 - clip.y * 0.5);
  if (any(suv < vec2f(0.0)) || any(suv > vec2f(1.0)) || depth > 1.0) { return 1.0; }
  let stored = textureLoad(map, vec2i(suv * (dims - vec2f(1.0))), 0).r;
  return select(1.0, 0.0, depth - bias / (3.0 * extent - 0.01) > stored);
}`,
};

/**
 * T1581b (F9) — QUATERNIONS, for a kernel that writes a per-instance `orient`.
 *
 * A Geometry in Instances mode turns each instance by a unit quaternion, and until now a
 * kernel had to write the four numbers by hand. These are the handful of operations that
 * builds them: from an axis and an angle, from a frame, toward a direction, between two
 * directions, composed, interpolated.
 *
 * ONE CONVENTION, the engine's (docs/mesh-instancing-design-2026-10-05.md, D5): a unit
 * quaternion is a vec4f (x, y, z, w), a turn is RIGHT-HANDED about its axis and ACTIVE —
 * `quatAxisAngle(vec3f(0, 0, 1), 1.5707963)` carries +X to +Y — and `quatMul(a, b)` turns
 * by `b` FIRST, then by `a`, as a matrix product does. `quatRotate` is the arithmetic the
 * renderer itself turns an instance by, so what a kernel computes with it is what is drawn.
 */
const QUAT_MODULE: SharedWgslModule = {
  summary: "unit quaternions (x, y, z, w) for per-instance orient: axis-angle, multiply, rotate, from a frame, look-at, from-to, slerp",
  source: `fn quatAxisAngle(axis: vec3f, angle: f32) -> vec4f {
  let halfAngle = angle * 0.5;
  return vec4f(normalize(axis) * sin(halfAngle), cos(halfAngle));
}

fn quatMul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

fn quatRotate(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn quatFromFrame(x: vec3f, y: vec3f, z: vec3f) -> vec4f {
  let trace = x.x + y.y + z.z;
  if (trace > 0.0) {
    let s = sqrt(trace + 1.0) * 2.0;
    return vec4f((y.z - z.y) / s, (z.x - x.z) / s, (x.y - y.x) / s, 0.25 * s);
  }
  if (x.x > y.y && x.x > z.z) {
    let s = sqrt(1.0 + x.x - y.y - z.z) * 2.0;
    return vec4f(0.25 * s, (y.x + x.y) / s, (z.x + x.z) / s, (y.z - z.y) / s);
  }
  if (y.y > z.z) {
    let s = sqrt(1.0 + y.y - x.x - z.z) * 2.0;
    return vec4f((y.x + x.y) / s, 0.25 * s, (z.y + y.z) / s, (z.x - x.z) / s);
  }
  let s = sqrt(1.0 + z.z - x.x - y.y) * 2.0;
  return vec4f((z.x + x.z) / s, (z.y + y.z) / s, 0.25 * s, (x.y - y.x) / s);
}

fn quatLookAt(forward: vec3f, up: vec3f) -> vec4f {
  let z = normalize(forward);
  let side = cross(up, z);
  let sideLength = length(side);
  let spare = cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(z.x) > 0.9), z);
  let x = select(side / max(sideLength, 1e-12), normalize(spare), sideLength < 1e-6);
  return quatFromFrame(x, cross(z, x), z);
}

fn quatFromTo(a: vec3f, b: vec3f) -> vec4f {
  let u = normalize(a);
  let v = normalize(b);
  let cosine = dot(u, v);
  if (cosine < -0.999999) {
    let axis = normalize(cross(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(u.x) > 0.9), u));
    return vec4f(axis, 0.0);
  }
  return normalize(vec4f(cross(u, v), 1.0 + cosine));
}

fn quatSlerp(a: vec4f, b: vec4f, t: f32) -> vec4f {
  var end = b;
  var cosine = dot(a, b);
  if (cosine < 0.0) {
    end = -b;
    cosine = -cosine;
  }
  if (cosine > 0.9995) {
    return normalize(mix(a, end, t));
  }
  let angle = acos(cosine);
  return (a * sin((1.0 - t) * angle) + end * sin(t * angle)) / sin(angle);
}`,
};

/**
 * B263 — A LOT IN 0 .. n − 1 FROM A HASH, without a divide.
 *
 * The line everyone writes is `hash % n`. On Apple GPUs the remainder (and the quotient) of
 * the HIGH HALF of a 32-bit value by a constant is wrong: `(h >> 16u) % 97u` returned 63993
 * where the CPU says 9, in a kernel and in a fragment shader alike, with every shift and
 * mask around it correct (`docs/apple-gpu-divide-high-half-2026-10-06.md`). The high half is
 * exactly what a careful author takes from a multiplicative hash, because its low bits are
 * its worst.
 *
 * So the lot is a scale, not a remainder: the high half is a number in 0 .. 65535, times n,
 * shifted down by 16. One multiply, exact, the same on every device and equal to
 * `hashLotReference` below to the bit. n may be anything up to 65536; above that the
 * product leaves 32 bits.
 *
 * A module of its own and not three more lines of `hash`: that text is in every shipped
 * shader that includes the hashes, and adding to it would move every one of them (§V309).
 * It calls nothing, so it is used after any u32 hash, the author's own included.
 */
const LOT_MODULE: SharedWgslModule = {
  summary: "hashLot(h, n): a lot in 0..n-1 from a u32 hash, exact on every GPU (never hash % n)",
  source: `fn hashLot(h: u32, n: u32) -> u32 {
  return ((h >> 16u) * n) >> 16u;
}`,
};

/**
 * The CPU's `hashLot`, bit for bit: what a test, an oracle or a document source computes to
 * know which lot a shader will draw. `nodes/definitions/hash-lot.gpu.test.ts` holds the two
 * together on Dawn, in a kernel and in a fragment shader.
 */
export function hashLotReference(hash: number, n: number): number {
  return (Math.imul(hash >>> 16, n) >>> 16) >>> 0;
}

export const SHARED_WGSL_MODULES: Readonly<Record<string, SharedWgslModule>> = {
  hash: HASH_MODULE,
  lot: LOT_MODULE,
  grid: GRID_MODULE,
  "surface-detail": SURFACE_DETAIL_MODULE,
  "light-depth": LIGHT_DEPTH_MODULE,
  quat: QUAT_MODULE,
};

/** The directive a source writes, in the file's own `// @` comment idiom. */
const USE_DIRECTIVE = /^[ \t]*\/\/[ \t]*@use[ \t]+([^\n]*)$/gm;

export interface SharedModuleResolution {
  /** The modules named, in the order they must be emitted (dependencies first). */
  readonly names: readonly string[];
  /** Names the source asked for that do not exist. */
  readonly missing: readonly string[];
  /** The WGSL to place before the source, or "" when nothing was asked for. */
  readonly prelude: string;
}

/**
 * Read a source's `// @use` lines and resolve them.
 *
 * A COMMENT rather than a `#include`: WGSL has no preprocessor, so a directive that is not
 * a comment would make the source invalid WGSL on its own — and this file's sources are
 * edited in a pane that highlights and validates them, pasted into shader playgrounds, and
 * read by `reflectParamsStruct`. `// @use` is the same idiom the reflected controls already
 * use for `// @default`, so a reader who has seen one has seen the other.
 *
 * Pure and total: it never throws. A name that does not resolve comes back in `missing` for
 * the caller to turn into a diagnostic naming it, because a shader that silently compiles
 * without the code it asked for is §V288's bug wearing a new hat.
 */
export function resolveSharedModules(source: string): SharedModuleResolution {
  const hit = resolutionsBySource.get(source);
  if (hit !== undefined) return hit;
  return remember(resolutionsBySource, source, resolveModules(source));
}

/**
 * ⚑ MEMOISED FOR THE SAME REASON AS THE POINT KERNEL'S SCANS (§T1333b), and found the same
 * way: 3.37% of all script time on E55 Reactor, in the production build, mapped back through
 * the bundle's sourcemap. §T259 compiles every frame, `customWgsl`'s compile calls this, and
 * the answer is a pure function of bytes that do not change between frames.
 *
 * It is a SMALLER number than the kernel's 39.4%, and the gap is the argument rather than a
 * reason to skip it: which emitter is hot is a property of the DOCUMENT, not of the emitter.
 * E32 Pasture made the point kernel a third of the main thread and never touched this; E55
 * does the reverse; E24 makes neither measurable. Nobody can know at authoring time which
 * document will make their emitter the expensive one, which is what §T1335b's seam is for.
 *
 * ⚠ The value is SHARED, like every `remember`ed value: `names`, `missing` and `prelude` are
 * `readonly` on the interface and no caller may mutate what comes back.
 */
const resolutionsBySource = new Map<string, SharedModuleResolution>();

function resolveModules(source: string): SharedModuleResolution {
  const asked: string[] = [];
  for (const match of source.matchAll(USE_DIRECTIVE)) {
    for (const raw of (match[1] ?? "").split(",")) {
      const name = raw.trim();
      if (name.length > 0) asked.push(name);
    }
  }

  const missing: string[] = [];
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (name: string): void => {
    if (seen.has(name)) return;
    const module = SHARED_WGSL_MODULES[name];
    if (module === undefined) {
      // Recorded once, in the order it was asked for, so the message can name every one.
      if (!missing.includes(name)) missing.push(name);
      return;
    }
    // Marked BEFORE the recursion: a cycle in the table would otherwise hang the compile,
    // and a table this small is exactly where nobody would look for a hang.
    seen.add(name);
    for (const dependency of module.requires ?? []) visit(dependency);
    ordered.push(name);
  };
  for (const name of asked) visit(name);

  const prelude = ordered.map((name) => SHARED_WGSL_MODULES[name]!.source).join("\n\n");
  return { names: ordered, missing, prelude: prelude.length > 0 ? `${prelude}\n\n` : "" };
}

/**
 * Every top-level `fn` and `struct` a chunk of WGSL declares.
 *
 * Deliberately crude — it reads declarations at the start of a line, which is what both the
 * modules above and every shipped source do — because the alternative is a WGSL parser, and
 * the cost of being crude here is bounded: a missed declaration means a collision this gate
 * does not catch, and the compile fails at Dawn instead with the driver's own message. What
 * it must never do is report a collision that is not one, which is why it anchors.
 */
export function declaredNames(wgsl: string): readonly string[] {
  const names: string[] = [];
  for (const match of wgsl.matchAll(/^[ \t]*(?:fn|struct)[ \t]+([A-Za-z_][A-Za-z0-9_]*)/gm)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}
