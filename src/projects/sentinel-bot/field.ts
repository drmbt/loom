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
 *
 * THE SECOND LOOK (the owner, 2026-10-06, of the first: "a bit lost on the bottom. maybe needs some haze or
 * fog down there. the scene feels still a bit empty, maybe needs some stuff in the distance … the audio
 * reactivity and lights of the spires themselves are maybe a bit chunky with the whole thing lighting up.
 * look at some matrix movie references"). What the films' fields have that the first look did not (the
 * 1999 film, and the 2021 one's stills): every tower is COVERED in pods, thousands, small against it; the
 * towers go on to the limit of sight; mist lies low between them and is lit cold from behind and within;
 * and there is lightning down in it. ("The future world is cold, dark and riddled with lightning", its
 * cinematographer; "back light mainly the atmos … red glow from the pods shining through", the later
 * film's supervisors.) So:
 *
 *  - trunks stand far further out than hung pods do (two windows of the same ground plan), and every
 *    trunk is covered in a lattice of small pods painted by its material, in tiers with a dark collar
 *    between, each with a lot of its own. The hung pods are the near ones: the same thing, with a shape.
 *  - nothing answers the track all at once (`fieldAnswer`): each pod lights at a level of its own, so
 *    the louder it is the more of them are lit; a kick is a ring going out from the robot through the
 *    field; a hat flares a few, different ones every beat.
 *  - lightning: an arc between two towers low down, now and then, with forks (`BOLT_KERNEL`), a Light
 *    where it is (`STRIKE_KERNEL`), and its glow in the mist (tunnel.ts, the air pass, which also lays
 *    the mist and draws the sky).
 *
 * What it costs (measured 2026-10-06 in the app, headless Chromium on the real GPU, documents alternated in one
 * browser on a loaded machine, the header's GPU reading; a direction, not a number to quote). The first look,
 * on a quieter machine: in the tunnel, with nothing of the fields to draw, its Sweeps still ran over their points,
 * about 1 ms a frame; in the fields with the pack of three out, 11.8 to 12.4 ms against 11.3 ms for three robots
 * in the tunnel. The second look (below), against the first in the same run on a machine several sessions were
 * rendering on: the fields 23 to 28 ms where the first look read 20 to 26, so about a fifth more; the tunnel's
 * readings were too scattered that run to tell the two apart (18 to 49 against 25 to 60). Owed: both again on a
 * quiet machine, against the 30 frames a second the owner has set for this piece.
 *
 * THE SECOND LOOK (the owner, 2026-10-06, of the first: "a bit lost on the bottom. maybe needs some haze or
 * fog down there. the scene feels still a bit empty, maybe needs some stuff in the distance … the audio
 * reactivity and lights of the spires themselves are maybe a bit chunky with the whole thing lighting up.
 * look at some matrix movie references"). What the films' fields have that the first look did not (the
 * 1999 film, and the 2021 one's stills): every tower is COVERED in pods, thousands, small against it; the
 * towers go on to the limit of sight; mist lies low between them and is lit cold from behind and within;
 * and there is lightning down in it. ("The future world is cold, dark and riddled with lightning", its
 * cinematographer; "back light mainly the atmos … red glow from the pods shining through", the later
 * film's supervisors.) So:
 *
 *  - trunks stand far further out than hung pods do (two windows of the same ground plan), and every
 *    trunk is covered in a lattice of small pods painted by its material, in tiers with a dark collar
 *    between, each with a lot of its own. The hung pods are the near ones: the same thing, with a shape.
 *  - nothing answers the track all at once (`fieldAnswer`): each pod lights at a level of its own, so
 *    the louder it is the more of them are lit; a kick is a ring going out from the robot through the
 *    field; a hat flares a few, different ones every beat.
 *  - lightning: an arc between two towers low down, now and then, with forks (`BOLT_KERNEL`), a Light
 *    where it is (`STRIKE_KERNEL`), and its glow in the mist (tunnel.ts, the air pass, which also lays
 *    the mist and draws the sky).
 *
 * What it costs (measured 2026-10-06 in the app, headless Chromium on the real GPU, three documents
 * alternated in one browser on a loaded machine, smallest of five header readings a visit; a direction,
 * not a number to quote). In the tunnel, with nothing of it to draw, the two Sweeps still run over
 * their 37,000 path points: about 1 ms a frame (7.4 to 7.8 ms without these nodes, 8.2 to 8.3 with).
 * In the fields with the pack of three out: 11.8 to 12.4 ms, against 11.3 ms for three robots in the
 * tunnel, so the place costs about what the wall it replaces does.
 */
export const FIELD = {
  /** Metres from one cell of the ground plan to the next. Divides the path's period. */
  cell: 24,
  /**
   * The window of TRUNKS: cells across the line and along it, and the rows of it that lie behind the robot.
   * 430 m ahead and 250 m to either side: past where the air has closed (tunnel.ts, the air pass).
   */
  trunks: { across: 21, along: 22, behind: 4 },
  /** The window of HUNG PODS, which only the near towers carry: further off a pod is a dot of the trunk's own lattice. */
  hung: { across: 11, along: 12, behind: 3 },
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
  /** The lattice a trunk's material paints: metres from one row of pods to the next, and from one tier's collar to the next. */
  row: 1.3,
  tier: 11,
  /** The mist: the height (metres above the line; it is below it) where it has thinned to this much, and how many metres up it thins by e. */
  mistTop: -20,
  mistFade: 9,
  /** Lightning: strips to a strike (the arc and its forks) and points along each. */
  bolts: 3,
  boltPoints: 20,
  /** A strike is placed ahead of a mark the robot passes every this many metres, so it does not travel with the robot. */
  strikeStep: 48,
} as const;
if (Math.abs(Math.round(PATH.period / FIELD.cell) * FIELD.cell - PATH.period) > 1e-6) throw new Error(`field.ts: a cell of ${FIELD.cell} m does not divide the path's ${PATH.period} m period, so the wrap would move every tower.`);

export interface FieldWindow {
  readonly across: number;
  readonly along: number;
  readonly behind: number;
}
export const TRUNK_TOWERS = FIELD.trunks.across * FIELD.trunks.along;
export const POD_TOWERS = FIELD.hung.across * FIELD.hung.along;
export const TOWER_CAPACITY = TRUNK_TOWERS * FIELD.towerPoints;
export const POD_COUNT = POD_TOWERS * FIELD.pods;
export const POD_CAPACITY = POD_COUNT * FIELD.podPoints;
export const BOLT_CAPACITY = FIELD.bolts * FIELD.boltPoints;
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

/** The middle of that tower `h` metres above the line (field.ts, towerAxis: the same rule). */
export function towerAxisAt(across: number, along: number, h: number): [number, number, number] {
  const lap = along - CELLS_A_LAP * Math.floor(along / CELLS_A_LAP);
  const tower = towerAt(across, along);
  const over = (h / 100) * Math.abs(h / 100);
  return [tower.x + (fieldLot(across, lap, 4) - 0.5) * 9 * over, pathAt(tower.z)[1] + h, tower.z + (fieldLot(across, lap, 5) - 0.5) * 9 * over];
}

/** How thick that tower is there (the WGSL's towerGirth: the same rule). */
export function towerGirthAt(across: number, along: number, h: number): number {
  const lap = along - CELLS_A_LAP * Math.floor(along / CELLS_A_LAP);
  const count = fieldLot(across, lap, 6);
  const swell = 1 + 0.24 * Math.sin(h * 0.21 + count * 6.2831853) + 0.13 * Math.sin(h * 0.63 + count * 17);
  const up = Math.min(1, Math.max(0, (h + FIELD.below) / (FIELD.below + FIELD.above)));
  return towerAt(across, along).radius * swell * (1.2 + (0.72 - 1.2) * up);
}

/**
 * A strike's lots: lot `which` of strike number `strike` is the fractional part of the strike's number times an
 * irrational of its own (the fractional parts of square roots of primes, the golden ratio and the plastic number;
 * none small, so no lot creeps from one strike to the next). The same in a float and in a double to a part in
 * ten thousand at the five hundredth strike, where a hash by sine is not.
 */
const STRIKE_TURNS = [0.6180340, 0.7548777, 0.4142136, 0.7320508, 0.2360680, 0.6457513, 0.3166248, 0.6055513, 0.3588989, 0.7958315, 0.3851648, 0.5677644, 0.4031242, 0.5574385, 0.8556546, 0.2801099] as const;
const strikeLot = (strike: number, which: number): number => {
  const turned = strike * (STRIKE_TURNS[which] as number) + which * 0.37;
  return turned - Math.floor(turned);
};
/** Of ten strikes, four go up one tower's flank and four across to the next tower out; the rest go along to the next. */
const STRIKE_KINDS = { flank: 0.4, outward: 0.8 } as const;

/** Where strike number `strike` of the lightning is, with the robot `travel` metres along (the WGSL's strikeOf: the same rule). */
export function strikeAt(strike: number, travel: number): { kind: "flank" | "outward" | "along"; start: [number, number, number]; end: [number, number, number]; live: boolean } {
  const lot = (which: number): number => strikeLot(strike, which);
  const mark = Math.floor(travel / FIELD.strikeStep) * FIELD.strikeStep;
  const z = mark + 18 + 132 * lot(0);
  const side = lot(1) > 0.5 ? 1 : -1;
  const x = pathAt(z)[0] + side * (44 + 56 * lot(2));
  const across = Math.floor(x / FIELD.cell);
  const along = Math.floor(z / FIELD.cell);
  const h = -13 + 17 * lot(4);
  if (lot(3) < STRIKE_KINDS.flank) {
    const top = h + 30 + 25 * lot(5);
    const out = (at: number): [number, number, number] => {
      const axis = towerAxisAt(across, along, at);
      return [axis[0] - side * towerGirthAt(across, along, at) * 1.15, axis[1], axis[2]];
    };
    return { kind: "flank", start: out(h), end: out(top), live: towerAt(across, along).stands };
  }
  const outward = lot(3) < STRIKE_KINDS.outward;
  const next: [number, number] = [across + (outward ? side : 0), along + (outward ? 0 : 1)];
  return { kind: outward ? "outward" : "along", start: towerAxisAt(across, along, h), end: towerAxisAt(next[0], next[1], h - 7 + 14 * lot(5)), live: towerAt(across, along).stands && towerAt(next[0], next[1]).stands };
}

const f = (value: number): string => value.toFixed(5);

/** A cell's lot, alone: what a material needs of the ground plan. */
const LOT_WGSL = `// A cell's lot, 0 to 1 (field.ts, fieldLot: the same line).
fn fieldLot(across: i32, along: i32, salt: u32) -> f32 {
  let n = (u32(across + 4096) * 73856093u) ^ (u32(along + 4096) * 19349663u) ^ (salt * 83492791u);
  let m = (n ^ (n >> 15u)) * 2246822519u;
  return f32((m ^ (m >> 13u)) >> 8u) / 16777216.0;
}
`;

/** The ground plan as WGSL, for a kernel whose slots are `window`'s cells. */
const fieldWgsl = (window: FieldWindow): string => `${pathWgsl()}
const FIELD_CELL: f32 = ${f(FIELD.cell)};
const WINDOW_ACROSS: u32 = ${window.across}u;
const WINDOW_BEHIND: i32 = ${window.behind};
const FIELD_LAP: i32 = ${CELLS_A_LAP};
const FIELD_AVENUE: f32 = ${f(FIELD.avenue)};
const TOWER_SWELL: f32 = ${f(TOWER_SWELL)};

${LOT_WGSL}
struct Tower {
  cell: vec2i, // its cell of the ground plan: across, and along within the lap
  foot: vec3f, // where it crosses the height of the line: x, the line's y abreast of it, z
  radius: f32,
  lean: vec2f, // how far its top has gone over, metres across and along
  count: f32, // its own count, 0 to 1
  stands: f32, // 0 in the avenue: not there
};

// The tower of cell (\`across\`, \`along\`) of the ground plan.
fn towerIn(across: i32, along: i32) -> Tower {
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

// The tower in slot \`slot\` of the window, with the robot \`travel\` metres along.
fn towerOf(slot: u32, travel: f32) -> Tower {
  let across = i32(floor(pathAt(travel).x / FIELD_CELL)) + i32(slot % WINDOW_ACROSS) - i32(WINDOW_ACROSS / 2u);
  let along = i32(floor(travel / FIELD_CELL)) + i32(slot / WINDOW_ACROSS) - WINDOW_BEHIND;
  return towerIn(across, along);
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

/**
 * A STRIKE of lightning, low down, just over the mist: up the flank of one tower on the side that faces the
 * line, or an arc to the tower that stands next to it. `strike` is a whole number that changes with each
 * (the beat's count), and where and which it is is drawn from that number (STRIKE_TURNS). It is placed ahead
 * of a mark and not ahead of the robot, so it does not travel while it is lit. Shared by the kernel that
 * draws it, the one that stands its Light, and the air pass, which lights the mist round it.
 */
export const strikeWgsl = (window: FieldWindow): string => `${fieldWgsl(window)}
const STRIKE_TURNS = array<f32, ${STRIKE_TURNS.length}>(${STRIKE_TURNS.map((turn) => turn.toFixed(7)).join(", ")});
fn strikeLot(strike: f32, which: i32) -> f32 {
  return fract(strike * STRIKE_TURNS[which] + f32(which) * 0.37);
}

struct Strike {
  start: vec3f,
  end: vec3f,
  live: f32, // 0 where a tower of it is not there (the avenue): no strike
};

fn strikeOf(strike: f32, travel: f32) -> Strike {
  let mark = floor(travel / ${f(FIELD.strikeStep)}) * ${f(FIELD.strikeStep)};
  let z = mark + mix(18.0, 150.0, strikeLot(strike, 0));
  let side = select(-1.0, 1.0, strikeLot(strike, 1) > 0.5);
  let x = pathAt(z).x + side * mix(44.0, 100.0, strikeLot(strike, 2));
  let across = i32(floor(x / FIELD_CELL));
  let along = i32(floor(z / FIELD_CELL));
  let kind = strikeLot(strike, 3);
  let a = towerIn(across, along);
  // Above the mist's top, where it can be seen: among the lowest of the hung pods.
  let h = mix(-13.0, 4.0, strikeLot(strike, 4));
  var s: Strike;
  if (kind < ${f(STRIKE_KINDS.flank)}) {
    // Up the flank of one tower, on the side that faces the line.
    let top = h + mix(30.0, 55.0, strikeLot(strike, 5));
    let face = vec3f(-side, 0.0, 0.0);
    s.start = towerAxis(a, h) + face * (towerGirth(a, h) * 1.15);
    s.end = towerAxis(a, top) + face * (towerGirth(a, top) * 1.15);
    s.live = a.stands;
    return s;
  }
  // To the next tower: outward, or along.
  let outward = kind < ${f(STRIKE_KINDS.outward)};
  let b = towerIn(across + select(0, i32(side), outward), along + select(1, 0, outward));
  s.start = towerAxis(a, h);
  s.end = towerAxis(b, h + mix(-7.0, 7.0, strikeLot(strike, 5)));
  s.live = a.stands * b.stands;
  return s;
}
`;

/** The towers' strips: `towerPoints` points up each, slot j × towerPoints + i. */
export const TOWER_KERNEL = `// T1561b — the fields' towers (src/projects/sentinel-bot/field.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  0 the tunnel, 1 the fields.
};
${fieldWgsl(FIELD.trunks)}
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
${fieldWgsl(FIELD.hung)}
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

/** A bolt's strip carries where it is, how thick, and how bright; the strike's Light carries where and how bright. */
export const BOLT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "girth", type: "f32", default: [0] },
  // r how bright it is now (0 to 1), a how far along it (0 to 1).
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);
export const STRIKE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 1] },
  { name: "power", type: "f32", default: [0] },
]);

const STRIKE_PARAMS_WGSL = `  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  0 the tunnel, 1 the fields.
  strike: f32, // @default 0  Which strike: a whole number that changes with each.
  flash: f32, // @default 0  How bright it is now, 0 to 1: 0 is no lightning.`;

/**
 * THE LIGHTNING: `bolts` strips. The first is the arc, from one tower to the next; the others fork off it
 * part of the way along and go down into the mist. Each is redrawn thirty times a second while it is lit
 * (lightning does not hold still), between the same two ends. With no flash every strip is one point with
 * no radius: nothing to draw.
 */
export const BOLT_KERNEL = `// T1561b — the fields' lightning (src/projects/sentinel-bot/field.ts).
struct Params {
${STRIKE_PARAMS_WGSL}
};
${strikeWgsl(FIELD.trunks)}
// A direction and a length of its own for point \`at\` of bolt \`bolt\`, redrawn every \`frame\`.
fn boltLot(at: i32, bolt: u32, frame: i32) -> vec3f {
  return vec3f(fieldLot(at, frame, 31u + bolt * 3u), fieldLot(at, frame, 32u + bolt * 3u), fieldLot(at, frame, 33u + bolt * 3u)) - 0.5;
}

// How far a bolt is off its straight line at \`s\` of the way along: three sizes of kink, the large ones few.
fn boltKink(s: f32, bolt: u32, frame: i32) -> vec3f {
  var off = vec3f(0.0);
  var size = 1.0;
  var cuts = 4.0;
  for (var octave = 0; octave < 3; octave += 1) {
    let at = s * cuts;
    let cell = i32(floor(at));
    off += mix(boltLot(cell + octave * 64, bolt, frame), boltLot(cell + 1 + octave * 64, bolt, frame), fract(at)) * size;
    size *= 0.5;
    cuts *= 2.3;
  }
  return off;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let bolt = ctx.index / ${FIELD.boltPoints}u;
  let s = f32(ctx.index % ${FIELD.boltPoints}u) / ${f(FIELD.boltPoints - 1)};
  let strike = strikeOf(ctx.params.strike, ctx.params.travel);
  if (ctx.params.place < 0.5 || ctx.params.flash < 0.02 || strike.live < 0.5) {
    q.position = vec3f(strike.start.x, -4000.0, strike.start.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  let frame = i32(floor(ctx.absTime * 30.0));
  let span = strike.end - strike.start;
  let reach = length(span);
  // The arc: held at both ends, kinked most in the middle, and sagging a little.
  // How far it kinks: as an arc between two towers does, however long it is. It sags only by how far it goes across.
  let kinks = 0.24 * min(reach, ${f(FIELD.cell)});
  let sag = vec3f(0.0, -0.08 * length(span.xz), 0.0);
  var at = strike.start + span * s + (boltKink(s, 0u, frame) * kinks + sag) * sin(s * 3.14159265);
  var girth = 0.3;
  if (bolt > 0u) {
    // A fork: it leaves the arc somewhere in its middle half and goes down and away, thinning to nothing.
    let leaves = 0.25 + 0.5 * strikeLot(ctx.params.strike, 6 + i32(bolt));
    let root = strike.start + span * leaves + (boltKink(leaves, 0u, frame) * kinks + sag) * sin(leaves * 3.14159265);
    let away = normalize(vec3f(strikeLot(ctx.params.strike, 9 + i32(bolt)) - 0.5, -0.9, strikeLot(ctx.params.strike, 12 + i32(bolt)) - 0.5));
    at = root + away * (0.55 * min(reach, ${f(FIELD.cell)}) * s) + boltKink(s, bolt, frame) * 0.8 * kinks * s;
    girth = 0.17 * (1.0 - s);
  }
  q.position = at;
  q.girth = girth * (0.5 + 0.5 * ctx.params.flash);
  q.tint = vec4f(ctx.params.flash, 0.0, 0.0, s);
  return q;
}`;

/** One point: where the strike's Light stands (the middle of the arc) and how bright. A Light in Points mode reads it. */
export const STRIKE_KERNEL = `// T1561b — the lightning's light (src/projects/sentinel-bot/field.ts).
struct Params {
${STRIKE_PARAMS_WGSL}
  power: f32, // @default 120  The Light's intensity at full flash.
};
${strikeWgsl(FIELD.trunks)}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let strike = strikeOf(ctx.params.strike, ctx.params.travel);
  q.position = mix(strike.start, strike.end, 0.5);
  q.tint = vec4f(0.56, 0.74, 1.0, 1.0);
  q.power = ctx.params.power * ctx.params.flash * strike.live * step(0.5, ctx.params.place);
  return q;
}`;

/** A bolt is light and nothing else. */
export const BOLT_SURFACE_WGSL = `struct Params {
  glow: f32, // @default 90  Radiance of a bolt at full flash.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.roughness = 1.0;
  o.metallic = 0.0;
  o.emissive = vec3f(0.62, 0.8, 1.0) * (p.glow * s.tint.r);
  return o;
}`;

/** What both field materials read of the piece's lights and of the track. */
const FIELD_PARAMS_WGSL = `  glow: f32, // @default 2.4  Radiance of a pod.
  hueFrom: f32, // @default 0  The lights' colour range starts at this hue, 0 to 1 round the wheel (0 red).
  hueTo: f32, // @default 0.03  …and ends at this one.
  low: f32, // @default 0  The low end of the track, 0 to 1.
  kick: f32, // @default 0  The kick, 0 to 1 as it decays.
  hat: f32, // @default 0  The hats, 0 to 1 as they decay.
  beat: f32, // @default 0  The beat's count: a whole number.
  react: f32, // @default 1  How much the pods answer the track.
  robotAt: vec3f, // @default [0, 0, 0]  Where the robot is: a kick goes out through the field from there.`;

/** How far a kick's ring has gone when the kick has died away, metres, and how thick the ring is. */
const RING = { reach: 150, width: 9 } as const;

/**
 * HOW A POD ANSWERS THE TRACK. Never all of them at once (the owner, 2026-10-06: "a bit chunky with the whole
 * thing lighting up"): each has a number of its own, `lot`, and
 *  - the LOW END lights the ones whose number is under it, so the louder it is the more are lit, and which
 *    ones never changes (a quiet passage has a few lit, the same few);
 *  - a KICK is a ring going out from the robot through the whole field while the kick dies away: fast at
 *    first and slowing, as the envelope does. A pod flares as the ring crosses it;
 *  - a HAT flares one in sixteen, different ones every beat.
 * With Listen at 0 every pod is at 1.
 */
const FIELD_LIGHT_WGSL = `${HUE_WGSL}
fn fieldAnswer(p: Params, lot: f32, world: vec3f) -> f32 {
  let meter = smoothstep(lot - 0.1, lot + 0.1, (p.low - 0.3) * 1.3);
  let gone = length(world - p.robotAt);
  let ring = exp(-pow((gone - (1.0 - p.kick) * ${f(RING.reach)}) / ${f(RING.width)}, 2.0)) * smoothstep(0.03, 0.2, p.kick);
  let spark = step(0.9375, fract(lot * 61.0 + p.beat * 0.6180340)) * p.hat * p.hat * p.hat;
  return 1.0 - 0.4 * min(p.react, 1.0) + p.react * (1.0 * meter + 2.2 * ring + 3.2 * spark);
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
  o.emissive = hueColour(mix(p.hueFrom, p.hueTo, place)) * (p.glow * alive * (0.06 + core) * breath * fieldAnswer(p, place, s.world));
  return o;
}`;

/**
 * A TOWER: black machinery, ribbed the long way with cable, and COVERED IN PODS. The pods are painted: a
 * lattice round the trunk and up it, every other row set half a pod over, in tiers with a dark collar
 * between. Each cell of the lattice has lots of its own (whether there is anything alive in it, its place in
 * the colour range, its own slow breath, the number it answers the track by), so a tower is thousands of
 * lights and no two towers the same. Far off, where a pod is smaller than a pixel, the lattice is drawn as
 * its own average: a tower two hundred metres away is a dim red shape, not a shimmer.
 *
 * (A Light for every pod is hundreds of thousands of lights. What the pods throw on the trunk between them
 * is painted here too.)
 */
export const TOWER_SURFACE_WGSL = `// @use surface-detail
struct Params {
${FIELD_PARAMS_WGSL}
};
${LOT_WGSL}${FIELD_LIGHT_WGSL}
// The share of a cell of the lattice that a pod's light fills, and of the cells that have anything alive in them.
const POD_FILLS: f32 = 0.2;
const POD_ALIVE: f32 = 0.72;

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let count = s.tint.r;
  let h = s.tint.g;
  let radius = s.tint.b;
  // Cable and ducting run up it: detail stretched tall.
  let run = detailFbm(s.world * vec3f(1.7, 0.09, 1.7) + count * 31.0, 4, s.footprint);
  let knot = detailFbm(s.world * vec3f(0.5, 0.42, 0.5) + count * 17.0, 3, s.footprint);
  o.albedo = vec4f(mix(vec3f(0.012, 0.013, 0.016), vec3f(0.055, 0.058, 0.066), smoothstep(0.35, 0.75, run.value)), 1.0);
  o.roughness = mix(0.38, 0.8, knot.value);
  o.metallic = 0.75;
  o.normal = detailBump(s.normal, run.gradient * vec3f(1.7, 0.09, 1.7) * 0.5 + knot.gradient * 0.2, 0.22);

  // The lattice. Rows up it, a whole number of pods round it (so the seam is no seam), every other row half a pod over.
  let rows = (h + ${f(FIELD.below)}) / ${f(FIELD.row)};
  let row = floor(rows);
  let around = max(floor(radius * 4.6 + 0.5), 6.0);
  let turns = s.uv.x * around + 0.5 * (row - 2.0 * floor(row * 0.5));
  let column = floor(turns) - around * floor(floor(turns) / around);
  let within = vec2f(fract(turns), fract(rows)) - 0.5;
  // A tier, with a collar of bare machinery at its foot.
  let tier = fract((h + count * ${f(FIELD.tier)}) / ${f(FIELD.tier)});
  let collar = smoothstep(0.0, 0.07, tier) * (1.0 - smoothstep(0.88, 0.95, tier));
  // The cell's own lots.
  let cell = i32(column) + i32(count * 4096.0);
  let alive = step(1.0 - POD_ALIVE, fieldLot(cell, i32(row), 21u));
  let place = fieldLot(cell, i32(row), 22u);
  let nerve = fieldLot(cell, i32(row), 23u);
  let size = 0.3 + 0.12 * fieldLot(cell, i32(row), 24u);
  // The pod: a bright core and a dimmer membrane round it.
  let off = length(within);
  let membrane = 1.0 - smoothstep(size * 0.55, size, off);
  let pod = membrane * (0.3 + 0.7 * (1.0 - smoothstep(0.0, size * 0.6, off)));
  let breath = 0.78 + 0.22 * sin(s.absTime * (0.5 + nerve * 0.9) + nerve * 40.0);
  // How many pixels a cell is: under two, the lattice is drawn as its average.
  let seen = smoothstep(1.5, 4.0, ${f(FIELD.row)} / max(s.footprint, 1e-4));
  let one = alive * pod * breath * fieldAnswer(p, nerve, s.world);
  let many = POD_ALIVE * POD_FILLS * fieldAnswer(p, 0.5, s.world);
  let lit = collar * mix(many, one, seen);
  // Where a pod is, the skin is membrane, not cable.
  o.albedo = vec4f(mix(o.albedo.rgb, vec3f(0.02, 0.012, 0.012), collar * membrane * alive * seen), 1.0);
  o.roughness = mix(o.roughness, 0.24, collar * membrane * alive * seen);
  // …and round the pods, their light is on the machinery: more in the hollows between the cables.
  let wash = collar * (0.25 + 0.75 * knot.value) * (1.0 - 0.6 * smoothstep(0.35, 0.75, run.value)) * fieldAnswer(p, 0.5, s.world);
  o.emissive = hueColour(mix(p.hueFrom, p.hueTo, mix(0.5, place, seen))) * (p.glow * (0.55 * lit + 0.022 * wash));
  return o;
}`;
