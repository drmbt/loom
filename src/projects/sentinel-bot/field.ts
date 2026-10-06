import { PATH, pathAt, pathWgsl } from "./path.ts";
import { HUE_WGSL } from "./surface.ts";

/**
 * T1561b — THE FIELDS: the second place the piece goes.
 *
 * The owner, 2026-10-05: "that will also be true for the environment … opening up to the spires of
 * matrix pods"; and a day later, of the first whole clip: "not seeing zion or a different environment,
 * the spires or anything visited at all". The reference is the film's own (projects/sentinel-bot/inspo):
 * a dark with no floor and no roof, cold and hazed, towers of machinery going up out of sight and down
 * out of sight, each covered in pods that glow, and the machines flying between them, apart.
 *
 * How it is made: the tunnel's line goes on (the robots fly the same path), and the tunnel is not
 * there. Round the line stand TOWERS, one in every cell of a grid on the ground plan, each a strip of
 * points going up that a Sweep makes a trunk of. A tower keeps away from the line by an AVENUE, so
 * nothing flies through one and the camera has room. What stands in a cell is drawn from the cell's own
 * number, so the same tower is there whichever way the window of them has slid; the window rides with
 * the robot as the tunnel's rows do.
 *
 * `place` is 0 in the tunnel and 1 in the fields. Out of the fields every strip is drawn in to one
 * point with no radius: nothing to draw.
 *
 * WHAT THE LOOK IS, and what was said of the looks before it (the owner, 2026-10-06). Of the first, a few
 * dozen pods hung on each bare trunk in flat navy air: "a bit lost on the bottom. maybe needs some haze or
 * fog down there. the scene feels still a bit empty, maybe needs some stuff in the distance … the audio
 * reactivity and lights of the spires themselves are maybe a bit chunky with the whole thing lighting up.
 * look at some matrix movie references". Of the second, a lattice of lit dots painted on each trunk: "the
 * pods are not really structures … too speckled … not plastic enough". What the films' fields have (the
 * 1999 film, and the 2021 one's stills): every tower is COVERED in pods, thousands, small against it; the
 * towers go on to the limit of sight; mist lies low between them and is lit cold from behind and within;
 * and there is lightning down in it. ("The future world is cold, dark and riddled with lightning", its
 * cinematographer; "back light mainly the atmos … red glow from the pods shining through", the later
 * film's supervisors.) So:
 *
 *  - trunks stand 430 m ahead and 250 m to a side, and every one is covered in pods that its material
 *    draws as shapes standing out of it, each in a steel cradle (TOWER_SURFACE_WGSL), in tiers with a
 *    collar between, each with lots of its own;
 *  - nothing answers the track all at once (`fieldAnswer`): each pod lights at a level of its own, so
 *    the louder it is the more of them are lit; a kick is a ring going out from the robot through the
 *    field; a hat flares a few, different ones every beat;
 *  - lightning: up a tower's flank or across to the next one, low down, now and then, with forks
 *    (`BOLT_KERNEL`), a Light where it is (`STRIKE_KERNEL`), and its glow in the mist (air.ts, which
 *    also lays the mist and draws the sky).
 *
 * What it costs (measured 2026-10-06 in the app, headless Chromium on the real GPU, documents alternated in one
 * browser on a loaded machine, the header's GPU reading; a direction, not a number to quote). The first look,
 * on a quieter machine: in the tunnel, with nothing of the fields to draw, its Sweeps still ran over their points,
 * about 1 ms a frame; in the fields with the pack of three out, 11.8 to 12.4 ms against 11.3 ms for three robots
 * in the tunnel. The second look, against the first in the same run on a machine several sessions were
 * rendering on: the fields 23 to 28 ms where the first look read 20 to 26, so about a fifth more; the tunnel's
 * readings were too scattered that run to tell the two apart (18 to 49 against 25 to 60). The look as it now is
 * (the pods as shapes, the hung pods' two Sweeps gone), with the dock and the temple also in the file, same
 * method, a machine with other work on it but steadier (two visits each): the tunnel 12.0 to 13.2 ms where the
 * file without the dock and the temple read 11.3 to 11.8, so all the other places' kernels standing idle cost
 * about a millisecond; the fields 13.3 to 15.8; the dock 14.4 to 15.8; the temple 13.7 to 15.0. Every place
 * showed 33 to 39 frames a second in the header on that machine, against the 30 the owner has set for this piece.
 * Owed still: the same on a machine doing nothing else.
 */
export const FIELD = {
  /** Metres from one cell of the ground plan to the next. Divides the path's period. */
  cell: 24,
  /**
   * The window of TRUNKS: cells across the line and along it, and the rows of it that lie behind the robot.
   * 430 m ahead and 250 m to either side: past where the air has closed (tunnel.ts, the air pass).
   */
  trunks: { across: 21, along: 22, behind: 4 },
  /** Metres either side of the line that no tower's trunk reaches into. */
  avenue: 12,
  /** A tower goes this far below the line and this far above it, metres. */
  below: 70,
  above: 100,
  /** Points up a tower's strip. */
  towerPoints: 18,
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
export const TOWER_CAPACITY = TRUNK_TOWERS * FIELD.towerPoints;
export const BOLT_CAPACITY = FIELD.bolts * FIELD.boltPoints;
const CELLS_A_LAP = Math.round(PATH.period / FIELD.cell);

/** Both strips carry the same: where a point is, how wide the sweep is there, and four numbers for the material. */
export const FIELD_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "girth", type: "f32", default: [0] },
  // A tower: r its own count (0 to 1), g metres above the line, b its radius, a how thick it is here (metres).
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
  // Above the mist's top, where it can be seen.
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
  q.tint = vec4f(t.count, h, t.radius, towerGirth(t, h));
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

/**
 * A pod of the lattice (TOWER_SURFACE_WGSL): how many stand round a trunk for each metre of its radius; its
 * half-widths across and up as shares of its cell, and how far it stands out, metres; how much of that is sunk
 * into the trunk; which way round the columns count (the Sweep's winding); and how bright a pod is against
 * the panel's glow.
 */
const POD = { round: 4.6, across: 0.4, up: 0.43, out: 0.5, sunk: 0.3, winds: 1, glows: 0.5 } as const;

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
 * A TOWER: black machinery COVERED IN PODS, and the pods are SHAPES.
 *
 * (The owner, 2026-10-06, of the pods as a lattice of lit dots painted on a trunk of stretched noise: "the pods
 * are not really structures, visible structures at all … too speckled and too weird and not plastic enough, and
 * the texture of the black of the spire is not convincing"; "strangely shiny"; "maybe we can come up with a
 * clever way of having them be geometry or fake this".)
 *
 * The lattice is the same: rows up the trunk, a whole number of pods round it, every other row half a pod over,
 * in tiers with a collar of bare machinery between. But each cell of it now holds an ELLIPSOID standing out of
 * the trunk, and the material finds it with the ray from the lens: from the point of the trunk's skin the pixel
 * is of, back toward the eye, against the ellipsoids of the cells that ray passes over (a closed form each, no
 * marching). Where it meets one, the pixel is of the pod: its normal is the ellipsoid's, so the storm's light and
 * the lightning make a highlight that goes round it as a wet thing's does; and its own light is by how much of
 * the pod the ray goes through, most through the middle where what is inside lies, none at the edge. A lit
 * volume, not a lit disc. Where the ray meets none, the pixel is of the machinery: a steel cradle round each pod,
 * conduits up between the columns and clamps across between the rows, matte, darkest close under a pod, and red
 * where a pod's light falls on it.
 *
 * What this cannot do is change a tower's outline: at the very edge of a trunk the pods do not stand out past
 * it. And far off, where a pod is smaller than two pixels, the lattice is drawn as its own average.
 */
export const TOWER_SURFACE_WGSL = `// @use surface-detail
struct Params {
${FIELD_PARAMS_WGSL}
};
${LOT_WGSL}${FIELD_LIGHT_WGSL}
// The share of a cell of the lattice that a pod's light fills, and of the cells that have anything alive in them.
const POD_FILLS: f32 = 0.34;
const POD_ALIVE: f32 = 0.72;
const ROW: f32 = ${f(FIELD.row)};
// Which way round the trunk the lattice's columns count, against the frame the material builds (the Sweep's own
// winding: field.gpu.test.ts holds it, by which side of a pod a light from one side falls on).
const ROUND_TURNS: f32 = ${f(POD.winds)};

struct Pod {
  hit: f32, // 1 where the ray meets it
  along: f32, // how far along the ray, toward the eye: the visible skin of it
  through: f32, // how much of it the ray goes through, 0 to 1 of its depth
  normal: vec3f, // its skin's normal there, in the lattice's frame: across, up, out
  cell: vec2i,
  off: vec2f, // where the trunk's own point lies from its middle, in radii: 1 is its rim
};

// The cell of the lattice that holds the point (turns, rows), and that point from the cell's middle, in metres.
fn podCell(at: vec2f, around: f32) -> vec3f {
  let row = floor(at.y);
  let shifted = at.x + 0.5 * (row - 2.0 * floor(row * 0.5));
  return vec3f(floor(shifted), row, shifted - floor(shifted) - 0.5);
}

// The ray from a point of the trunk's skin toward the eye (both in the lattice's frame, metres) against the pod
// of the cell that holds \`probe\` (turns, rows).
fn podMet(skin: vec2f, toEye: vec3f, probe: vec2f, around: f32, wide: f32, count: f32) -> Pod {
  var pod: Pod;
  let cell = podCell(probe, around);
  let column = cell.x - around * floor(cell.x / around);
  pod.cell = vec2i(i32(column) + i32(count * 4096.0), i32(cell.y));
  // Its own size: no two quite alike.
  let size = 0.86 + 0.2 * fieldLot(pod.cell.x, pod.cell.y, 24u);
  let radii = vec3f(${f(POD.across)} * wide, ${f(POD.up)} * ROW, ${f(POD.out)}) * size;
  // Where the skin's point is from this pod's middle: the cell's middle, sunk a little into the trunk.
  let row = cell.y;
  let middle = vec2f(cell.x + 0.5 - 0.5 * (row - 2.0 * floor(row * 0.5)), row + 0.5);
  let apart = vec3f((skin.x - middle.x) * wide, (skin.y - middle.y) * ROW, ${f(-(1 - 2 * POD.sunk))} * radii.z);
  pod.off = apart.xy / radii.xy;
  let o = apart / radii;
  let d = toEye / radii;
  let a = dot(d, d);
  let b = dot(o, d);
  let c = dot(o, o) - 1.0;
  let disc = b * b - a * c;
  pod.hit = 0.0;
  if (disc > 0.0) {
    let root = sqrt(disc);
    let far = (-b + root) / a;
    if (far > 0.0) {
      pod.hit = 1.0;
      pod.along = far;
      let near = max((-b - root) / a, 0.0);
      pod.through = clamp((far - near) * sqrt(a) * 0.5, 0.0, 1.0);
      pod.normal = normalize((o + d * far) / radii);
    }
  }
  return pod;
}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let count = s.tint.r;
  let h = s.tint.g;
  let radius = s.tint.b;
  let girth = max(s.tint.a, 0.5);
  // The lattice. Rows up it, a whole number of pods round it (so the seam is no seam).
  let around = max(floor(radius * ${f(POD.round)} + 0.5), 6.0);
  let wide = 6.2831853 * girth / around;
  let skin = vec2f(s.uv.x * around, (h + ${f(FIELD.below)}) / ROW);
  // A tier, with a collar of bare machinery at its foot.
  let tier = fract((h + count * ${f(FIELD.tier)}) / ${f(FIELD.tier)});
  let collar = smoothstep(0.0, 0.06, tier) * (1.0 - smoothstep(0.9, 0.96, tier));
  // The lattice's frame at this point: across (the way the columns count), up, and out.
  let outward = normalize(s.normal);
  let upward = normalize(vec3f(0.0, 1.0, 0.0) - outward * outward.y);
  let across = cross(upward, outward) * ROUND_TURNS;
  let eyeward = normalize(s.eye - s.world);
  let toEye = vec3f(dot(eyeward, across), dot(eyeward, upward), max(dot(eyeward, outward), 0.04));
  // How many pixels a cell is: under two, the lattice is drawn as its average. And toward the trunk's own edge,
  // where the ray lies along the skin and passes over more pods than are looked for (they smeared into pears).
  let seen = smoothstep(1.5, 4.0, min(ROW, wide) / max(s.footprint, 1e-4)) * smoothstep(0.16, 0.4, dot(eyeward, outward));

  // ── The machinery, which is what this point is unless a pod is in front of it ──
  let own = podCell(skin, around);
  let grime = detailFbm(s.world * vec3f(1.9, 0.7, 1.9) + count * 31.0, 3, s.footprint);
  // Conduits up between the columns and clamps across between the rows: round in section, so they take a light.
  let pipe = abs(own.z) * 2.0;
  let conduit = smoothstep(0.72, 0.84, pipe);
  let rung = abs(fract(skin.y) - 0.5) * 2.0;
  let strap = smoothstep(0.82, 0.92, rung) * (1.0 - conduit);
  var albedo = mix(vec3f(0.011, 0.012, 0.014), vec3f(0.03, 0.032, 0.036), max(conduit, strap * 0.6)) * (0.7 + 0.6 * grime.value);
  var rough = mix(0.86, 0.6, max(conduit, strap)) + (grime.value - 0.5) * 0.2;
  var metal = 0.35;
  // Their roundness, as a turn of the normal: a conduit's across the trunk, a clamp's up it.
  let sideways = sign(own.z) * (1.0 - smoothstep(0.84, 1.0, pipe)) * conduit;
  var normal = normalize(outward + across * (ROUND_TURNS * sideways * 0.7) + upward * (sign(fract(skin.y) - 0.5) * strap * 0.5) + grime.gradient * 0.05);
  var glow = vec3f(0.0);
  var podded = 0.0;

  if (collar > 0.0 && seen > 0.0) {
    // The pods the ray toward the eye passes over: this point's own cell's, and the cells' it is over half way up
    // a pod's height and at the top of it. The one it meets nearest the eye is the one that is seen.
    let reach = ${f(POD.out * (2 - 2 * POD.sunk) * 1.1)} / toEye.z;
    let slide = toEye.xy / vec2f(wide, ROW);
    var met = podMet(skin, toEye, skin, around, wide, count);
    for (var probe = 1; probe <= 2; probe += 1) {
      let other = podMet(skin, toEye, skin + slide * (reach * f32(probe) * 0.5), around, wide, count);
      if (other.hit > met.hit || (other.hit == met.hit && other.along > met.along)) { met = other; }
    }
    // The cell's own lots.
    let alive = step(1.0 - POD_ALIVE, fieldLot(met.cell.x, met.cell.y, 21u));
    let place = fieldLot(met.cell.x, met.cell.y, 22u);
    let nerve = fieldLot(met.cell.x, met.cell.y, 23u);
    let breath = 0.8 + 0.2 * sin(s.absTime * (0.5 + nerve * 0.9) + nerve * 40.0);
    let lit = p.glow * alive * breath * fieldAnswer(p, nerve, s.world);
    let tone = hueColour(mix(p.hueFrom, p.hueTo, place));
    if (met.hit > 0.5) {
      // A pod: a wet membrane, and a light inside it that shows by how much of the pod the ray goes through.
      podded = collar * seen;
      let inside = met.through * met.through * met.through;
      let skinNormal = normalize(across * (met.normal.x * ROUND_TURNS) + upward * met.normal.y + outward * met.normal.z);
      normal = normalize(mix(normal, skinNormal, podded));
      albedo = mix(albedo, mix(vec3f(0.035, 0.03, 0.03), vec3f(0.06, 0.012, 0.014), alive), podded);
      rough = mix(rough, 0.17, podded);
      metal = mix(metal, 0.0, podded);
      glow = tone * (lit * (0.07 + 0.93 * inside)) * podded;
    } else {
      // The machinery by a pod: a steel cradle round its foot, dark close under it, and its light on what is near.
      let rim = length(met.off);
      let cradle = (1.0 - smoothstep(1.16, 1.3, rim)) * collar * seen;
      albedo = mix(albedo, vec3f(0.05, 0.052, 0.058), cradle * 0.8);
      rough = mix(rough, 0.42, cradle);
      metal = mix(metal, 0.9, cradle);
      albedo = albedo * mix(1.0, smoothstep(0.95, 1.7, rim), 0.75 * collar * seen);
      glow = tone * (lit * 0.07 * exp(-max(rim - 1.0, 0.0) * 2.2)) * collar * seen;
    }
  }
  // Far off: the lattice's own average, with what it answers the track by.
  let many = hueColour(mix(p.hueFrom, p.hueTo, 0.5)) * (p.glow * POD_ALIVE * POD_FILLS * 0.42 * fieldAnswer(p, 0.5, s.world)) * collar;
  o.albedo = vec4f(albedo, 1.0);
  o.roughness = clamp(rough, 0.08, 1.0);
  o.metallic = metal;
  o.normal = normal;
  o.emissive = mix(many, glow, seen) * ${f(POD.glows)};
  return o;
}`;
