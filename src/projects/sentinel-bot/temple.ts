import { PATH, pathWgsl } from "./path.ts";

/**
 * T1561b — THE TEMPLE: the fourth place the piece goes.
 *
 * The owner, 2026-10-05 and three times after: "temple and zion". The films' temple is the other end of the
 * world from the dock: no steel in it. A cavern in the living rock, its roof hung with stalactites and its
 * floor grown with what has dripped from them, lit by nothing but fire, and it is where the drums are. So this
 * is the place of the piece that is WARM and that answers the KICK: every fire in it flares when the kick lands.
 *
 * How it is made: the tunnel's line goes on and the tunnel is not there. Round the line is a CAVE, a grid of
 * points the kernel stands on a section that is no two rows alike: a round of some thirty metres whose radius
 * swells and narrows by a noise of where it is, cut off below by a floor that rises and falls. In it stand
 * FORMATIONS, two to every cell of a ground plan, each a strip of points a Sweep makes rock of: a stalactite
 * hanging from the roof, a stalagmite standing on the floor, or a column where the two have met. None within
 * the AVENUE the robots and the lens use. On the top of two stalagmites in five is a FIRE: a flame (a strip a Sweep
 * makes a tongue of, drawn as light) and a Light, one point of a pointset each.
 *
 * `place` is 1 in the temple and 0 everywhere else, where every one of these is drawn in to a point. What
 * stands where is drawn from where it is along the lap, so it is the same cave every time round and the lap's
 * end is no seam.
 */
export const TEMPLE = {
  /** The cave's radius where the noise is at its middle, how far over the line it is struck from, and how much of the radius the noise moves. */
  radius: 32,
  lift: 7,
  swell: 0.22,
  /** The floor lies about this far below the line, and rises and falls by this much. */
  floor: 11,
  floorRise: 2.5,
  /** The noise's cells: metres along the cave (divides the path's period) and parts of a turn round it. */
  noiseAlong: 12,
  noiseRound: 9,
  /** The grid the shell is stood on. */
  cols: 160,
  rows: 288,
  row: 2,
  behind: 72,
  /** The ground plan of the formations: metres to a cell (divides the period), cells across and along, rows of cells behind, and formations to a cell. */
  cell: 8,
  across: 7,
  along: 54,
  cellsBehind: 12,
  toCell: 1,
  /** Points up a formation's strip. */
  points: 9,
  /** Metres either side of the line no formation stands in. */
  avenue: 9,
  /** A flame: points up it, and how tall, metres. */
  flamePoints: 5,
  flameTall: 2.4,
} as const;
if (Math.abs(Math.round(PATH.period / TEMPLE.cell) * TEMPLE.cell - PATH.period) > 1e-6) throw new Error(`temple.ts: a cell of ${TEMPLE.cell} m does not divide the path's ${PATH.period} m period.`);
if (Math.abs(Math.round(PATH.period / TEMPLE.noiseAlong) * TEMPLE.noiseAlong - PATH.period) > 1e-6) throw new Error(`temple.ts: the noise's ${TEMPLE.noiseAlong} m cell does not divide the path's ${PATH.period} m period.`);

export const CAVE_CAPACITY = TEMPLE.cols * TEMPLE.rows;
export const FORMATIONS = TEMPLE.across * TEMPLE.along * TEMPLE.toCell;
export const FORMATION_CAPACITY = FORMATIONS * TEMPLE.points;
export const FLAME_CAPACITY = FORMATIONS * TEMPLE.flamePoints;

const f = (value: number): string => value.toFixed(5);

/** The cave's shell: where a point is and what it is of. */
export const CAVE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  // r 0 the roof and walls, 0.25 the floor (a formation's is 1 and over); g metres above the line; b how far round the section (0 to 1); a metres along the cave.
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);
/** A formation's strip and a flame's: where, how thick, and four numbers for the material. */
export const TEMPLE_STRIP_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "girth", type: "f32", default: [0] },
  // A formation: r which it is (1 a stalactite, 2 a stalagmite, 3 a column), g its own count, b how far along it (0 to 1), a 1.
  // A flame: r how bright it burns, g its own count, a how far up it (0 to 1).
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);
/**
 * A fire's point, for a Light in Points mode; and for the lit smoke round it, which is the same point drawn as
 * a soft ball of light (`halo`: its colour as it burns now, and in w its radius, metres).
 */
export const FIRE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 1] },
  { name: "power", type: "f32", default: [0] },
  { name: "halo", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);
/** The lit smoke round a fire: its radius, metres, and how bright it is against the fire's own colour. */
export const HALO = { radius: 3.2, glow: 0.05 } as const;

/** Which a formation is: none, a stalactite, a stalagmite, a column. */
export const FORMATION = { none: 0, stalactite: 1, stalagmite: 2, column: 3 } as const;

const TEMPLE_WGSL = `${pathWgsl()}
const TEMPLE_RADIUS: f32 = ${f(TEMPLE.radius)};
const TEMPLE_LIFT: f32 = ${f(TEMPLE.lift)};
const TEMPLE_LAP_NOISE: i32 = ${Math.round(PATH.period / TEMPLE.noiseAlong)};
const TEMPLE_LAP_CELLS: i32 = ${Math.round(PATH.period / TEMPLE.cell)};
const TEMPLE_CELL: f32 = ${f(TEMPLE.cell)};
const TEMPLE_ACROSS: u32 = ${TEMPLE.across}u;

fn templeLot(a: i32, b: i32, salt: u32) -> f32 {
  let n = (u32(a + 4096) * 73856093u) ^ (u32(b + 4096) * 19349663u) ^ (salt * 83492791u);
  let m = (n ^ (n >> 15u)) * 2246822519u;
  return f32((m ^ (m >> 13u)) >> 8u) / 16777216.0;
}

// A noise of where a thing is round the cave (\`cells\` to the turn, which closes on itself) and along it
// (which closes on itself at the lap's end), 0 to 1, smooth.
fn caveNoise(about: f32, along: f32, cells: i32, salt: u32) -> f32 {
  let r0 = floor(about);
  let a0 = floor(along);
  let u = fract(about);
  let v = fract(along);
  let su = u * u * (3.0 - 2.0 * u);
  let sv = v * v * (3.0 - 2.0 * v);
  let ra = i32(r0) - cells * i32(floor(r0 / f32(cells)));
  let rb = select(ra + 1, 0, ra + 1 >= cells);
  let za = i32(a0) - TEMPLE_LAP_NOISE * i32(floor(a0 / f32(TEMPLE_LAP_NOISE)));
  let zb = select(za + 1, 0, za + 1 >= TEMPLE_LAP_NOISE);
  return mix(mix(templeLot(ra, za, salt), templeLot(rb, za, salt), su), mix(templeLot(ra, zb, salt), templeLot(rb, zb, salt), su), sv);
}

// How far from the cave's middle the rock is in a direction, abreast of z: the round, swelling and narrowing,
// or the floor where that is nearer.
fn caveShell(theta: f32, z: f32) -> f32 {
  let turn = theta / 6.2831853;
  let about = (turn - floor(turn)) * ${f(TEMPLE.noiseRound)};
  let along = z / ${f(TEMPLE.noiseAlong)};
  let large = caveNoise(about, along, ${TEMPLE.noiseRound}, 1u);
  // (Whole multiples of the lattice along, so the lap's end is still no seam.)
  let small = caveNoise(about * 3.0, along * 3.0, ${TEMPLE.noiseRound * 3}, 2u);
  let radius = TEMPLE_RADIUS * (1.0 + ${f(TEMPLE.swell)} * ((large - 0.5) * 2.0 + (small - 0.5) * 0.6));
  let down = -sin(theta);
  if (down > 1e-6) {
    // The floor: where straight under this direction it has risen to, by its own slow noise of where it is.
    let floorAt = ${f(TEMPLE.floor)} + TEMPLE_LIFT + ${f(TEMPLE.floorRise)} * (caveNoise(cos(theta) * 2.0 + 4.0, along * 2.0, 8, 3u) - 0.5) * 2.0;
    return min(radius, floorAt / down);
  }
  return radius;
}

fn caveCentre(z: f32) -> vec3f {
  return pathAt(z) + vec3f(0.0, TEMPLE_LIFT, 0.0);
}

// How high over the line the rock is at x off the line, abreast of z: the roof (above) or the floor (below).
// Found by walking the section's own rule: a few steps of a bisection on the direction whose rock is at that x.
fn caveAt(x: f32, z: f32, above: bool) -> f32 {
  // The direction from the middle: from straight up (or down) toward the side x is on.
  var lo = 0.0;
  var hi = 1.45;
  let side = sign(x + 1e-6);
  let vertical = select(-1.5707963, 1.5707963, above);
  for (var probe = 0; probe < 14; probe += 1) {
    let mid = (lo + hi) * 0.5;
    let theta = vertical - select(-1.0, 1.0, above) * side * mid;
    let reach = caveShell(theta, z) * cos(theta) * side;
    if (reach < abs(x)) { lo = mid; } else { hi = mid; }
  }
  let theta = vertical - select(-1.0, 1.0, above) * side * (lo + hi) * 0.5;
  return caveShell(theta, z) * sin(theta) + TEMPLE_LIFT;
}

struct Formation {
  kind: f32, // 0 none, 1 a stalactite, 2 a stalagmite, 3 a column
  foot: vec3f, // where it grows from: the roof for a stalactite, the floor for the others
  tip: vec3f, // where it ends: its point, or the roof for a column
  girth: f32, // how thick at its foot, metres
  count: f32, // its own count, 0 to 1
};

// The formation in slot \`slot\` of the window, with the robot \`travel\` metres along.
fn formationOf(slot: u32, travel: f32) -> Formation {
  let across = i32(floor(pathAt(travel).x / TEMPLE_CELL)) + i32(slot % TEMPLE_ACROSS) - i32(TEMPLE_ACROSS / 2u);
  let along = i32(floor(travel / TEMPLE_CELL)) + i32(slot / TEMPLE_ACROSS) - ${TEMPLE.cellsBehind};
  let lap = along - TEMPLE_LAP_CELLS * i32(floor(f32(along) / f32(TEMPLE_LAP_CELLS)));
  let z = (f32(along) + 0.5 + (templeLot(across, lap, 11u) - 0.5) * 0.7) * TEMPLE_CELL;
  let x = (f32(across) + 0.5 + (templeLot(across, lap, 12u) - 0.5) * 0.7) * TEMPLE_CELL;
  let line = pathAt(z);
  let off = x - line.x;
  var g: Formation;
  g.count = templeLot(across, lap, 13u);
  g.girth = 0.7 + 1.5 * templeLot(across, lap, 14u);
  g.kind = 0.0;
  g.foot = vec3f(x, -4000.0, z);
  g.tip = g.foot;
  // In the avenue, or out past where the cave's wall can be at its narrowest: nothing.
  if (abs(off) < ${f(TEMPLE.avenue)} + g.girth || abs(off) > ${f(TEMPLE.radius * (1 - TEMPLE.swell * 1.3) - 2)}) { return g; }
  let roof = caveAt(off, z, true);
  let floor_ = caveAt(off, z, false);
  let which = templeLot(across, lap, 15u);
  if (which < 0.42) {
    // A stalactite: from a metre and a half inside the roof, down a third to two thirds of the way to the floor at the most.
    g.kind = 1.0;
    let long = mix(4.0, 13.0, templeLot(across, lap, 16u));
    g.foot = vec3f(x, line.y + roof + 1.5, z);
    g.tip = vec3f(x, line.y + max(roof - long, floor_ + 5.0), z);
  } else if (which < 0.8) {
    // A stalagmite: from inside the floor, up; shorter and stouter than what hangs over it.
    g.kind = 2.0;
    let tall = mix(2.5, 7.5, templeLot(across, lap, 16u));
    g.foot = vec3f(x, line.y + floor_ - 1.0, z);
    g.tip = vec3f(x, line.y + min(floor_ + tall, roof - 5.0), z);
    g.girth = g.girth * 1.25;
  } else {
    // A column: floor to roof, with a waist.
    g.kind = 3.0;
    g.foot = vec3f(x, line.y + floor_ - 1.0, z);
    g.tip = vec3f(x, line.y + roof + 1.5, z);
    g.girth = g.girth * 1.1;
  }
  return g;
}
`;

/** THE CAVE'S SHELL: a grid, `cols` round the section and `rows` along. */
export const CAVE_KERNEL = `// T1561b — the temple's cave (src/projects/sentinel-bot/temple.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  1 in the temple; 0 anywhere else, where every point of it is drawn in to one.
};
${TEMPLE_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.params.place < 0.5) {
    q.position = vec3f(0.0, -4000.0, 0.0);
    q.tint = vec4f(0.0);
    return q;
  }
  let z = (floor(ctx.params.travel / ${f(TEMPLE.row)}) + f32(ctx.dim.j) - ${f(TEMPLE.behind)}) * ${f(TEMPLE.row)};
  let around = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  let theta = (around - 0.25) * 6.2831853;
  let radius = caveShell(theta, z);
  let high = radius * sin(theta) + TEMPLE_LIFT;
  // The floor is whatever of it faces up from below the line's own height.
  let floored = step(sin(theta), -0.35) * step(high, -4.0);
  q.position = caveCentre(z) + vec3f(cos(theta), sin(theta), 0.0) * radius;
  q.tint = vec4f(floored * 0.25, high, around, z);
  return q;
}`;

/** THE FORMATIONS' strips: `points` points along each, from its foot to its tip. */
export const FORMATION_KERNEL = `// T1561b — the temple's stalactites, stalagmites and columns (src/projects/sentinel-bot/temple.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  1 in the temple.
};
${TEMPLE_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let g = formationOf(ctx.index / ${TEMPLE.points}u, ctx.params.travel);
  let along = f32(ctx.index % ${TEMPLE.points}u) / ${f(TEMPLE.points - 1)};
  if (g.kind < 0.5 || ctx.params.place < 0.5) {
    q.position = vec3f(g.foot.x, -4000.0, g.foot.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  // It does not grow dead straight: it wanders a little off its line, most in its middle.
  let wander = vec3f(sin(along * 5.0 + g.count * 40.0), 0.0, cos(along * 4.0 + g.count * 23.0)) * (0.35 * g.girth * sin(along * 3.14159265));
  q.position = mix(g.foot, g.tip, along) + wander;
  // A spike thins to its point, with a knuckle or two on the way; a column has a waist.
  let knuckle = 1.0 + 0.16 * sin(along * 17.0 + g.count * 31.0);
  var girth = g.girth * pow(1.0 - along, 0.75) * knuckle;
  if (g.kind > 2.5) { girth = g.girth * (0.45 + 0.75 * pow(abs(along - 0.5) * 2.0, 1.6)) * knuckle; }
  q.girth = girth;
  q.tint = vec4f(g.kind, g.count, along, 1.0);
  return q;
}`;

const FIRE_PARAMS_WGSL = `  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  1 in the temple.
  kick: f32, // @default 0  The kick, 0 to 1 as it decays: every fire flares on it.
  low: f32, // @default 0  The low end of the track, 0 to 1: the fires burn higher with it.
  react: f32, // @default 1  How much the fires answer the track.`;

/**
 * How a fire burns now, 0 and up, 1 at rest: its own flicker (two counts of its own, never still), higher with
 * the low end, and a flare on the kick. This is the place of the drums.
 */
const FIRE_WGSL = `${TEMPLE_WGSL}
fn fireBurns(count: f32, time: f32, kick: f32, low: f32, react: f32) -> f32 {
  let flicker = 0.82 + 0.12 * sin(time * (7.0 + count * 5.0) + count * 50.0) + 0.06 * sin(time * (17.0 + count * 9.0) + count * 20.0);
  return flicker * (1.0 + react * (0.5 * low + 1.6 * kick));
}

// Where a formation's fire sits: on a stalagmite's tip, for two stalagmites in five. \`lit\` is 0 for anything else.
struct Fire {
  seat: vec3f,
  lit: f32,
  count: f32,
};
fn fireOf(slot: u32, travel: f32) -> Fire {
  let g = formationOf(slot, travel);
  var fire: Fire;
  fire.seat = g.tip;
  // Two stalagmites in five carry one: a cave lit by pools of firelight with dark between, not a lit room.
  fire.lit = step(1.5, g.kind) * step(g.kind, 2.5) * step(fract(g.count * 7.0), 0.4);
  fire.count = g.count;
  return fire;
}
`;

/** THE FLAMES: a tongue on every stalagmite, `flamePoints` points up it. It leans and licks on its own count. */
export const FLAME_KERNEL = `// T1561b — the temple's fires, as flames (src/projects/sentinel-bot/temple.ts).
struct Params {
${FIRE_PARAMS_WGSL}
};
${FIRE_WGSL}
const FLAME_SHAPE = array<f32, ${TEMPLE.flamePoints}>(0.36, 0.62, 0.44, 0.2, 0.0);

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let fire = fireOf(ctx.index / ${TEMPLE.flamePoints}u, ctx.params.travel);
  let up = f32(ctx.index % ${TEMPLE.flamePoints}u) / ${f(TEMPLE.flamePoints - 1)};
  if (fire.lit < 0.5 || ctx.params.place < 0.5) {
    q.position = vec3f(fire.seat.x, -4000.0, fire.seat.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  let burns = fireBurns(fire.count, ctx.absTime, ctx.params.kick, ctx.params.low, ctx.params.react);
  // It licks: its upper half leans about, more the higher.
  let lick = vec3f(sin(ctx.absTime * (5.0 + fire.count * 4.0) + fire.count * 30.0 + up * 2.0), 0.0, cos(ctx.absTime * (4.0 + fire.count * 3.0) + fire.count * 17.0 + up * 2.5)) * (0.3 * up * up);
  q.position = fire.seat + vec3f(0.0, up * ${f(TEMPLE.flameTall)} * (0.7 + 0.5 * burns), 0.0) + lick;
  q.girth = FLAME_SHAPE[ctx.index % ${TEMPLE.flamePoints}u] * (0.8 + 0.3 * burns);
  q.tint = vec4f(burns, fire.count, 0.0, up);
  return q;
}`;

/** THE FIRES' LIGHTS: one point for every formation, in the middle of its flame; no power where there is no fire. */
export const FIRE_KERNEL = `// T1561b — the temple's fires, as lights (src/projects/sentinel-bot/temple.ts).
struct Params {
${FIRE_PARAMS_WGSL}
  power: f32, // @default 240  A fire's intensity at rest.
};
${FIRE_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let fire = fireOf(ctx.index, ctx.params.travel);
  q.position = fire.seat + vec3f(0.0, ${f(TEMPLE.flameTall * 0.4)}, 0.0);
  q.tint = vec4f(1.0, 0.5 + 0.1 * fire.count, 0.14 + 0.06 * fire.count, 1.0);
  let burns = fire.lit * step(0.5, ctx.params.place) * fireBurns(fire.count, ctx.absTime, ctx.params.kick, ctx.params.low, ctx.params.react);
  q.power = ctx.params.power * burns;
  // The smoke round it, lit by it: a ball of its own light, brighter and a little larger as it flares.
  q.halo = vec4f(q.tint.rgb * (${f(HALO.glow)} * burns), ${f(HALO.radius)} * (0.8 + 0.2 * burns) * step(0.001, burns));
  return q;
}`;

/** A flame is light and nothing else: white-yellow at its root and through its middle, orange to red toward its tip and its edge. */
export const FLAME_SURFACE_WGSL = `struct Params {
  glow: f32, // @default 6  Radiance of a flame's root.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let through = abs(dot(normalize(s.eye - s.world), s.normal));
  let up = s.tint.a;
  let heat = through * through * (1.0 - up * 0.8);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.roughness = 1.0;
  o.metallic = 0.0;
  o.emissive = mix(vec3f(1.0, 0.16, 0.02), vec3f(1.0, 0.72, 0.3), heat) * (p.glow * s.tint.r * heat);
  return o;
}`;

/**
 * THE ROCK: the cave and everything that has grown in it, one material. Limestone: pale where it is dry, banded
 * the way it was laid down (and the bands lie level, whatever stands on them), darker and with a sheen where
 * water still runs, which is down every stalactite and in the low of the floor. Not a metal: it takes a fire's
 * light as stone does.
 */
export const ROCK_SURFACE_WGSL = `// @use surface-detail
struct Params {
  wet: f32, // @default 0.5  How much of it water still runs on.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let large = detailFbm(s.world * 0.22, 4, s.footprint);
  let fine = detailFbm(s.world * 2.6, 4, s.footprint);
  // Beds: level bands a hand to a metre thick, their edges moved about by the large noise.
  let bed = fract(s.world.y * 0.55 + large.value * 1.7);
  let band = smoothstep(0.0, 0.12, bed) * (1.0 - smoothstep(0.8, 1.0, bed));
  // (Dark: at twice this the cave under its fires was a room of cream.)
  var albedo = mix(vec3f(0.085, 0.066, 0.05), vec3f(0.17, 0.135, 0.1), band) * (0.6 + 0.6 * fine.value);
  var rough = 0.92;
  // Water: down what hangs, and where the floor is low.
  let hangs = step(0.75, s.tint.r) * step(s.tint.r, 1.5);
  let runs = p.wet * max(hangs * smoothstep(0.3, 1.0, s.tint.b), smoothstep(0.55, 0.7, large.value) * max(s.normal.y, 0.0));
  albedo = albedo * mix(1.0, 0.5, runs);
  rough = mix(rough, 0.18, runs);
  o.albedo = vec4f(albedo, 1.0);
  o.roughness = rough;
  o.metallic = 0.0;
  o.normal = detailBump(s.normal, large.gradient * 0.22 * 1.2 + fine.gradient * 2.6 * 0.12, 0.5);
  return o;
}`;
