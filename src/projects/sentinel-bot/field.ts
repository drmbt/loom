import { PATH, pathAt, pathWgsl } from "./path.ts";
import { HUE_WGSL } from "./surface.ts";

/**
 * T1561b — THE FIELDS: the second place the piece goes.
 *
 * The owner, 2026-10-05: "that will also be true for the environment … opening up to the spires of
 * matrix pods"; and a day later, of the first whole clip: "not seeing zion or a different environment,
 * the spires or anything visited at all". The reference is the film's own (projects/sentinel-bot/inspo):
 * a dark with no floor and no roof, cold and hazed, towers of machinery going up out of sight and down
 * out of sight, each hung with pods that glow, and the machines flying between them, apart.
 *
 * How it is made: the tunnel's line goes on (the robots fly the same path), and the tunnel is not
 * there. Round the line stand TOWERS, one in every cell of a grid on the ground plan, each a strip of
 * points going up that a Sweep makes a trunk of; and on each tower PODS, each a short strip a Sweep
 * makes a spindle of. A tower keeps away from the line by an AVENUE, so nothing flies through one and
 * the camera has room. What stands in a cell is drawn from the cell's own number, so the same tower is
 * there whichever way the window of them has slid; the window rides with the robot as the tunnel's
 * rows do.
 *
 * `place` is 0 in the tunnel and 1 in the fields. Out of the fields every strip is drawn in to one
 * point with no radius: nothing to draw.
 */
export const FIELD = {
  /** Metres from one cell of the ground plan to the next. Divides the path's period. */
  cell: 24,
  /** Cells in the window: across the line, and along it. */
  across: 11,
  along: 12,
  /** Rows of cells of the window that lie behind the robot. */
  behind: 3,
  /** Metres either side of the line that no tower's trunk reaches into. */
  avenue: 12,
  /** A tower goes this far below the line and this far above it, metres. */
  below: 70,
  above: 100,
  /** Points up a tower's strip. */
  towerPoints: 18,
  /** Pods on a tower, and the band of it they hang in, metres below and above the line. */
  pods: 56,
  podPoints: 5,
  podsFrom: -26,
  podsTo: 34,
} as const;
if (Math.abs(Math.round(PATH.period / FIELD.cell) * FIELD.cell - PATH.period) > 1e-6) throw new Error(`field.ts: a cell of ${FIELD.cell} m does not divide the path's ${PATH.period} m period, so the wrap would move every tower.`);

export const FIELD_TOWERS = FIELD.across * FIELD.along;
export const TOWER_CAPACITY = FIELD_TOWERS * FIELD.towerPoints;
export const POD_COUNT = FIELD_TOWERS * FIELD.pods;
export const POD_CAPACITY = POD_COUNT * FIELD.podPoints;
const CELLS_A_LAP = Math.round(PATH.period / FIELD.cell);

/** Both strips carry the same: where a point is, how wide the sweep is there, and four numbers for the material. */
export const FIELD_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "girth", type: "f32", default: [0] },
  // A tower: r its own count (0 to 1), g metres above the line, b its radius, a whether it stands.
  // A pod: r its place in the colour range, g its height in the band (0 to 1), b how much is alive in it, a how far along it (0 to 1).
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);

/** A cell's lot, 0 to 1: the same line in TypeScript and in WGSL (no integer divide: tunnel.ts, fixtureLot, says why). */
export function fieldLot(across: number, along: number, salt: number): number {
  const n = (Math.imul(across + 4096, 73856093) ^ Math.imul(along + 4096, 19349663) ^ Math.imul(salt, 83492791)) >>> 0;
  const m = Math.imul(n ^ (n >>> 15), 2246822519) >>> 0;
  return ((m ^ (m >>> 13)) >>> 8) / 16777216;
}

/** The most a trunk is thicker than its radius anywhere in the band the robots fly in. */
const TOWER_SWELL = 1.6;

/** The tower of cell (`across`, `along`) of the ground plan: where it stands, how thick, and whether it stands at all. */
export function towerAt(across: number, along: number): { x: number; z: number; radius: number; stands: boolean } {
  const lap = along - CELLS_A_LAP * Math.floor(along / CELLS_A_LAP);
  const z = (along + 0.5 + (fieldLot(across, lap, 1) - 0.5) * 0.6) * FIELD.cell;
  const x = (across + 0.5 + (fieldLot(across, lap, 2) - 0.5) * 0.6) * FIELD.cell;
  const radius = 2.4 + 2.6 * fieldLot(across, lap, 3);
  return { x, z, radius, stands: Math.abs(x - pathAt(z)[0]) >= FIELD.avenue + radius * TOWER_SWELL };
}

const f = (value: number): string => value.toFixed(5);

const FIELD_WGSL = `${pathWgsl()}
const FIELD_CELL: f32 = ${f(FIELD.cell)};
const FIELD_ACROSS: u32 = ${FIELD.across}u;
const FIELD_BEHIND: i32 = ${FIELD.behind};
const FIELD_LAP: i32 = ${CELLS_A_LAP};
const FIELD_AVENUE: f32 = ${f(FIELD.avenue)};
const TOWER_SWELL: f32 = ${f(TOWER_SWELL)};

// A cell's lot, 0 to 1 (field.ts, fieldLot: the same line).
fn fieldLot(across: i32, along: i32, salt: u32) -> f32 {
  let n = (u32(across + 4096) * 73856093u) ^ (u32(along + 4096) * 19349663u) ^ (salt * 83492791u);
  let m = (n ^ (n >> 15u)) * 2246822519u;
  return f32((m ^ (m >> 13u)) >> 8u) / 16777216.0;
}

struct Tower {
  cell: vec2i, // its cell of the ground plan: across, and along within the lap
  foot: vec3f, // where it crosses the height of the line: x, the line's y abreast of it, z
  radius: f32,
  lean: vec2f, // how far its top has gone over, metres across and along
  count: f32, // its own count, 0 to 1
  stands: f32, // 0 in the avenue: not there
};

// The tower in slot \`slot\` of the window, with the robot \`travel\` metres along.
fn towerOf(slot: u32, travel: f32) -> Tower {
  let across = i32(floor(pathAt(travel).x / FIELD_CELL)) + i32(slot % FIELD_ACROSS) - i32(FIELD_ACROSS / 2u);
  let along = i32(floor(travel / FIELD_CELL)) + i32(slot / FIELD_ACROSS) - FIELD_BEHIND;
  // Its lots are drawn from its place in the lap, so the lap's end does not change the field.
  let lap = along - FIELD_LAP * i32(floor(f32(along) / f32(FIELD_LAP)));
  var t: Tower;
  t.cell = vec2i(across, lap);
  let z = (f32(along) + 0.5 + (fieldLot(across, lap, 1u) - 0.5) * 0.6) * FIELD_CELL;
  let x = (f32(across) + 0.5 + (fieldLot(across, lap, 2u) - 0.5) * 0.6) * FIELD_CELL;
  let line = pathAt(z);
  t.foot = vec3f(x, line.y, z);
  t.radius = 2.4 + 2.6 * fieldLot(across, lap, 3u);
  t.lean = (vec2f(fieldLot(across, lap, 4u), fieldLot(across, lap, 5u)) - 0.5) * 9.0;
  t.count = fieldLot(across, lap, 6u);
  t.stands = step(FIELD_AVENUE + t.radius * TOWER_SWELL, abs(x - line.x));
  return t;
}

// Its middle, \`h\` metres above the line: it goes over a little, more the higher.
fn towerAxis(t: Tower, h: f32) -> vec3f {
  let over = (h / 100.0) * abs(h / 100.0);
  return t.foot + vec3f(t.lean.x * over, h, t.lean.y * over);
}

// How thick it is there: swellings a few tens of metres apart, and thinner toward the top.
fn towerGirth(t: Tower, h: f32) -> f32 {
  let swell = 1.0 + 0.24 * sin(h * 0.21 + t.count * 6.2831853) + 0.13 * sin(h * 0.63 + t.count * 17.0);
  return t.radius * swell * mix(1.2, 0.72, clamp((h + ${f(FIELD.below)}) / ${f(FIELD.below + FIELD.above)}, 0.0, 1.0));
}
`;

/** The towers' strips: `towerPoints` points up each, slot j × towerPoints + i. */
export const TOWER_KERNEL = `// T1561b — the fields' towers (src/projects/sentinel-bot/field.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  0 the tunnel, 1 the fields.
};
${FIELD_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let t = towerOf(ctx.index / ${FIELD.towerPoints}u, ctx.params.travel);
  let h = mix(${f(-FIELD.below)}, ${f(FIELD.above)}, f32(ctx.index % ${FIELD.towerPoints}u) / ${f(FIELD.towerPoints - 1)});
  if (t.stands < 0.5 || ctx.params.place < 0.5) {
    // Not there: the whole strip is one point with no radius, well under everything.
    q.position = vec3f(t.foot.x, -4000.0, t.foot.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  q.position = towerAxis(t, h);
  q.girth = towerGirth(t, h);
  q.tint = vec4f(t.count, h, t.radius, 1.0);
  return q;
}`;

/** The pods' strips: `podPoints` points along each, `pods` to a tower. */
export const POD_KERNEL = `// T1561b — the pods on the fields' towers (src/projects/sentinel-bot/field.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  0 the tunnel, 1 the fields.
};
${FIELD_WGSL}
const POD_SHAPE = array<f32, ${FIELD.podPoints}>(0.05, 0.8, 1.0, 0.72, 0.05);

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let pod = ctx.index / ${FIELD.podPoints}u;
  let along = f32(ctx.index % ${FIELD.podPoints}u) / ${f(FIELD.podPoints - 1)};
  let t = towerOf(pod / ${FIELD.pods}u, ctx.params.travel);
  if (t.stands < 0.5 || ctx.params.place < 0.5) {
    q.position = vec3f(t.foot.x, -4000.0, t.foot.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  let which = i32(pod % ${FIELD.pods}u);
  // Its own lots, drawn from its tower's cell and its number on the tower.
  let own = t.cell.x * 64 + which;
  let rung = (f32(which) + fieldLot(own, t.cell.y, 11u)) / ${f(FIELD.pods)};
  let h = mix(${f(FIELD.podsFrom)}, ${f(FIELD.podsTo)}, rung);
  // Round the tower by the golden angle, so no two rows line up.
  let turn = f32(which) * 2.3999632 + t.count * 6.2831853;
  let radial = vec3f(cos(turn), 0.0, sin(turn));
  let size = 0.75 + 0.6 * fieldLot(own, t.cell.y, 12u);
  // It hangs out from the trunk and a little up, its foot just inside the skin.
  let hang = normalize(radial + vec3f(0.0, 0.42, 0.0));
  let foot = towerAxis(t, h) + radial * (towerGirth(t, h) * 0.9);
  q.position = foot + hang * (1.5 * size * along);
  q.girth = POD_SHAPE[ctx.index % ${FIELD.podPoints}u] * 0.5 * size;
  // One in four is empty: a husk, all but dark.
  let alive = mix(0.06, 1.0, step(0.25, fieldLot(own, t.cell.y, 13u)));
  q.tint = vec4f(fieldLot(own, t.cell.y, 14u), rung, alive, along);
  return q;
}`;

/** What both field materials read of the piece's lights and of the track. */
const FIELD_PARAMS_WGSL = `  glow: f32, // @default 2.4  Radiance of a pod.
  hueFrom: f32, // @default 0  The lights' colour range starts at this hue, 0 to 1 round the wheel (0 red).
  hueTo: f32, // @default 0.03  …and ends at this one.
  low: f32, // @default 0  The low end of the track, 0 to 1.
  kick: f32, // @default 0  The kick, 0 to 1 as it decays.
  react: f32, // @default 1  How much the pods answer the track.`;

const FIELD_LIGHT_WGSL = `${HUE_WGSL}
// A pod's light now, at \`rung\` of the band it hangs in (0 the bottom, 1 the top): it swells with the low end,
// and a kick runs up the tower as it dies away.
fn podPulse(p: Params, rung: f32) -> f32 {
  let wave = exp(-pow((rung - (1.0 - p.kick)) * 4.0, 2.0)) * p.kick;
  return 1.0 + p.react * (0.9 * p.low + 2.6 * wave);
}
`;

/**
 * A POD: a wet membrane with something lit inside. All of its light is its own: brightest where the
 * lens looks straight in at the middle of it, falling to a dark skin at the edge, which is what makes
 * it read as a lit volume and not a painted bulb.
 */
export const POD_SURFACE_WGSL = `struct Params {
${FIELD_PARAMS_WGSL}
};
${FIELD_LIGHT_WGSL}
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let place = s.tint.r;
  let rung = s.tint.g;
  let alive = s.tint.b;
  let along = s.tint.a;
  let facing = max(dot(normalize(s.eye - s.world), s.normal), 0.0);
  // What is inside lies toward the foot: the far end is membrane.
  let core = facing * facing * (0.25 + 0.75 * (1.0 - smoothstep(0.35, 0.95, along)));
  // Each breathes on a slow count of its own.
  let breath = 0.78 + 0.22 * sin(s.absTime * (0.5 + place * 0.9) + place * 40.0);
  o.albedo = vec4f(0.02, 0.012, 0.012, 1.0);
  o.roughness = 0.22;
  o.metallic = 0.0;
  o.emissive = hueColour(mix(p.hueFrom, p.hueTo, place)) * (p.glow * alive * (0.06 + core) * breath * podPulse(p, rung));
  return o;
}`;

/**
 * A TOWER: black machinery, ribbed the long way with cable. It is lit by what flies past it and by its
 * own pods, and the pods' light on the trunk is painted here (a Light for every pod is several
 * thousand lights; §T1589b is where they could become real ones).
 */
export const TOWER_SURFACE_WGSL = `// @use surface-detail
struct Params {
${FIELD_PARAMS_WGSL}
};
${FIELD_LIGHT_WGSL}
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let count = s.tint.r;
  let h = s.tint.g;
  // Cable and ducting run up it: detail stretched tall.
  let run = detailFbm(s.world * vec3f(1.7, 0.09, 1.7) + count * 31.0, 4, s.footprint);
  let knot = detailFbm(s.world * vec3f(0.5, 0.42, 0.5) + count * 17.0, 3, s.footprint);
  o.albedo = vec4f(mix(vec3f(0.012, 0.013, 0.016), vec3f(0.055, 0.058, 0.066), smoothstep(0.35, 0.75, run.value)), 1.0);
  o.roughness = mix(0.38, 0.8, knot.value);
  o.metallic = 0.75;
  o.normal = detailBump(s.normal, run.gradient * vec3f(1.7, 0.09, 1.7) * 0.5 + knot.gradient * 0.2, 0.22);
  // Where the pods hang, their light is on the trunk: more in the hollows between the cables.
  let rung = (h - ${f(FIELD.podsFrom)}) / ${f(FIELD.podsTo - FIELD.podsFrom)};
  let band = smoothstep(-0.12, 0.05, rung) * (1.0 - smoothstep(0.95, 1.12, rung));
  let lit = band * (0.25 + 0.75 * knot.value) * (1.0 - 0.6 * smoothstep(0.35, 0.75, run.value));
  o.emissive = hueColour(mix(p.hueFrom, p.hueTo, 0.5)) * (p.glow * 0.05 * lit * podPulse(p, clamp(rung, 0.0, 1.0)));
  return o;
}`;
