import { PATH, pathAt, pathWgsl } from "./path.ts";

/**
 * T1561b — THE DOCK: the third place the piece goes.
 *
 * The owner, 2026-10-05, of where the piece should go besides the tunnel: "zion"; and three times since
 * ("temple and zion could be target next"; "temple and zion docks, no?"; "zion and temple still not seen").
 * The films' dock is the largest room in them: a hall of steel a city's ships come home to, ribbed like the
 * inside of a hull, tier on tier of gantries up its walls with a lamp every few metres, a deck far below
 * with its landing lights, bridges across the air, searchlights going about in the haze, all of it lit warm
 * (sodium) against the cold of everything outside. That is what this is, and the machines flying down the
 * middle of it are in the one place they were never meant to reach.
 *
 * How it is made: the tunnel's line goes on (the robots fly the same path) and the tunnel is not there.
 * Round the line stands a HALL, a grid of points the kernel stands on its section: a vault of 40 m struck from
 * a little over the line, cut off below by a flat deck. Out of that shell stand, as real shape and not paint,
 * a RIB every 24 m (an arch, the hall's frame) and three TIERS along each wall (a ledge: a gantry's deck with
 * its lamps along the edge). Across the air go BRIDGES, each a strip a Sweep makes a beam of, high enough that
 * nothing flying meets one. The hall's work lamps are Lights (a pointset's, one node), three to a rib. And
 * SEARCHLIGHTS stand on the deck and go about: each a cone of lit air (a strip a Sweep makes a cone of, drawn
 * as light) and a Spot along it, so what a beam crosses is lit by it.
 *
 * `place` is 1 in the dock and 0 everywhere else. Out of the dock every one of these is drawn in to a point:
 * nothing to draw. The rows of the hall stand at whole multiples of their spacing, so it holds still while
 * the window of it rides along with the robot, as the tunnel's wall does.
 */
export const DOCK = {
  /** The vault's radius, and how far over the line it is struck from, metres. */
  radius: 40,
  lift: 6,
  /** The deck lies this far below the line. */
  deck: 14,
  /** Metres from one rib to the next (divides the path's period), how wide a rib is along the hall, and how far it stands in. */
  rib: 24,
  ribWide: 1.5,
  ribDeep: 2.2,
  /** The tiers: how far above the line each gantry's deck is, how far it stands in from the wall, and how thick its deck is. */
  tiers: [-6, 5, 16],
  tierDeep: 2.8,
  tierThick: 0.9,
  /** The grid the shell is stood on: points round the section and rows along the hall, metres between rows, and the rows behind the robot. */
  cols: 192,
  rows: 288,
  row: 2,
  behind: 72,
  /** Bridges: one at every third rib; points across each; the heights above the line they are drawn between. */
  bridgeEvery: 3,
  bridges: 8,
  bridgePoints: 14,
  bridgeFrom: 11,
  bridgeTo: 24,
  /** Work lamps: three to a rib (DOCK_LAMP_KERNEL). Ribs of the window that carry them, and the ribs behind the robot. */
  lampRibs: 22,
  lampRibsBehind: 5,
  /** Searchlights: how many, points along each cone, and how long a cone is, metres. */
  beams: 4,
  beamPoints: 8,
  beamLength: 70,
} as const;
if (Math.abs(Math.round(PATH.period / DOCK.rib) * DOCK.rib - PATH.period) > 1e-6) throw new Error(`dock.ts: ribs ${DOCK.rib} m apart do not divide the path's ${PATH.period} m period, so the lap's end would move every rib.`);
if (DOCK.rib % DOCK.row !== 0) throw new Error("dock.ts: a rib must stand on a row of the hall's grid.");

export const HALL_CAPACITY = DOCK.cols * DOCK.rows;
export const BRIDGE_CAPACITY = DOCK.bridges * DOCK.bridgePoints;
export const DOCK_LAMPS = DOCK.lampRibs * 3;
export const BEAM_CAPACITY = DOCK.beams * DOCK.beamPoints;

const f = (value: number): string => value.toFixed(5);

/** The hall's shell carries where a point is and what it is of. */
export const HALL_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  // r what it is (0 plate, 1 rib, 2 tier, 3 deck); g metres above the line; b how far round the section (0 to 1); a metres along the hall.
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);
/** A bridge's strip and a searchlight's: where, how thick, and four numbers for the material. */
export const DOCK_STRIP_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "girth", type: "f32", default: [0] },
  // A bridge: r its own count, g how far across (0 to 1), b metres along the hall. A beam: r how bright, a how far along it (0 to 1).
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);
/** A lamp's point, for a Light in Points mode: where, its colour, how strong, and which way it shines. */
export const DOCK_LIGHT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 1] },
  { name: "power", type: "f32", default: [0] },
  { name: "aim", type: "vec3f", default: [0, -1, 0] },
]);

/** How far from the vault's centre the bare shell is in the direction `theta` (radians, 0 to the right, a quarter turn up): the vault, or the deck where that is nearer. */
export function hallShell(theta: number): number {
  const down = -Math.sin(theta);
  return down > 1e-6 ? Math.min(DOCK.radius, (DOCK.deck + DOCK.lift) / down) : DOCK.radius;
}

/** A number 0 to 1 for a thing of the dock numbered (a, b): the same line in WGSL (dockLot). */
export function dockLot(a: number, b: number): number {
  const n = (Math.imul(a + 4096, 73856093) ^ Math.imul(b + 4096, 19349663)) >>> 0;
  const m = Math.imul(n ^ (n >>> 15), 2246822519) >>> 0;
  return ((m ^ (m >>> 13)) >>> 8) / 16777216;
}

/** The bridge at rib `rib` (a whole number; only every `bridgeEvery`-th rib has one): metres above the line, and metres along the hall. */
export function bridgeAt(rib: number): { height: number; z: number; there: boolean } {
  const lap = rib - Math.round(PATH.period / DOCK.rib) * Math.floor(rib / Math.round(PATH.period / DOCK.rib));
  return { height: DOCK.bridgeFrom + (DOCK.bridgeTo - DOCK.bridgeFrom) * dockLot(lap, 3), z: (rib + 0.5) * DOCK.rib, there: ((rib % DOCK.bridgeEvery) + DOCK.bridgeEvery) % DOCK.bridgeEvery === 0 };
}

/** Where the line is at `z`, for a test. */
export const dockLine = (z: number): readonly [number, number, number] => pathAt(z);

const DOCK_WGSL = `${pathWgsl()}
const DOCK_RADIUS: f32 = ${f(DOCK.radius)};
const DOCK_LIFT: f32 = ${f(DOCK.lift)};
const DOCK_DECK: f32 = ${f(DOCK.deck)};
const DOCK_RIB: f32 = ${f(DOCK.rib)};
const DOCK_LAP: i32 = ${Math.round(PATH.period / DOCK.rib)};
const DOCK_TIERS = array<f32, ${DOCK.tiers.length}>(${DOCK.tiers.map(f).join(", ")});

// A number 0 to 1 for a thing of the dock numbered (a, b) (dock.ts, dockLot: the same line).
fn dockLot(a: i32, b: i32) -> f32 {
  let n = (u32(a + 4096) * 73856093u) ^ (u32(b + 4096) * 19349663u);
  let m = (n ^ (n >> 15u)) * 2246822519u;
  return f32((m ^ (m >> 13u)) >> 8u) / 16777216.0;
}

// A rib's number within the lap, so the lap's end changes nothing.
fn dockLap(rib: i32) -> i32 {
  return rib - DOCK_LAP * i32(floor(f32(rib) / f32(DOCK_LAP)));
}

// How far from the vault's centre the bare shell is in a direction: the vault, or the deck where that is nearer.
fn hallShell(theta: f32) -> f32 {
  let down = -sin(theta);
  if (down > 1e-6) { return min(DOCK_RADIUS, (DOCK_DECK + DOCK_LIFT) / down); }
  return DOCK_RADIUS;
}

// The middle of the vault abreast of z: over the line.
fn hallCentre(z: f32) -> vec3f {
  return pathAt(z) + vec3f(0.0, DOCK_LIFT, 0.0);
}
`;

/**
 * THE HALL'S SHELL: a grid, `cols` round the section and `rows` along. The first and last column are the same
 * line, down the middle of the deck.
 */
export const HALL_KERNEL = `// T1561b — the dock's hall (src/projects/sentinel-bot/dock.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  1 in the dock; 0 anywhere else, where every point of it is drawn in to one.
};
${DOCK_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.params.place < 0.5) {
    q.position = vec3f(0.0, -4000.0, 0.0);
    q.tint = vec4f(0.0);
    return q;
  }
  // Rows stand at whole multiples of the row spacing, so the hall holds still while the window slides along it.
  let z = (floor(ctx.params.travel / ${f(DOCK.row)}) + f32(ctx.dim.j) - ${f(DOCK.behind)}) * ${f(DOCK.row)};
  let around = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  // From straight down, round by the right wall, over the vault, and down the left.
  let theta = (around - 0.25) * 6.2831853;
  var radius = hallShell(theta);
  var what = 0.0;
  let onDeck = step(radius, DOCK_RADIUS - 0.01);
  let high = radius * sin(theta) + DOCK_LIFT;
  if (onDeck > 0.5) {
    what = 3.0;
  } else {
    // Tiers: a ledge along each wall, the gantry's deck. Not over the crown, where there is no wall to hang one on.
    for (var tier = 0; tier < ${DOCK.tiers.length}; tier += 1) {
      let off = abs(high - DOCK_TIERS[tier]);
      if (off < ${f(DOCK.tierThick)} && abs(cos(theta)) > 0.45) {
        radius = radius - ${f(DOCK.tierDeep)};
        what = 2.0;
      }
    }
    // Ribs: an arch that stands in from the shell, wall and vault, at every bay.
    let bay = floor(z / DOCK_RIB);
    let alongBay = abs(z - (bay + 0.5) * DOCK_RIB);
    if (alongBay < ${f(DOCK.ribWide / 2)} && what < 1.5) {
      radius = radius - ${f(DOCK.ribDeep)};
      what = 1.0;
    }
  }
  q.position = hallCentre(z) + vec3f(cos(theta), sin(theta), 0.0) * radius;
  q.tint = vec4f(what, radius * sin(theta) + DOCK_LIFT, around, z);
  return q;
}`;

/** THE BRIDGES: a strip across the hall at every third rib, at a height of its own, wall to wall. */
export const BRIDGE_KERNEL = `// T1561b — the dock's bridges (src/projects/sentinel-bot/dock.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  1 in the dock.
};
${DOCK_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let bridge = i32(ctx.index / ${DOCK.bridgePoints}u);
  let across = f32(ctx.index % ${DOCK.bridgePoints}u) / ${f(DOCK.bridgePoints - 1)};
  // The ribs that have one, from two behind the robot on.
  let first = i32(floor(ctx.params.travel / (DOCK_RIB * ${f(DOCK.bridgeEvery)}))) - 2;
  let rib = (first + bridge) * ${DOCK.bridgeEvery};
  let z = (f32(rib) + 0.5) * DOCK_RIB;
  let high = mix(${f(DOCK.bridgeFrom)}, ${f(DOCK.bridgeTo)}, dockLot(dockLap(rib), 3));
  if (ctx.params.place < 0.5) {
    q.position = vec3f(0.0, -4000.0, z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  // Wall to wall at that height: the vault is narrower the higher.
  let up = high - DOCK_LIFT;
  let half = sqrt(max(DOCK_RADIUS * DOCK_RADIUS - up * up, 1.0)) - 0.5;
  q.position = pathAt(z) + vec3f(mix(-half, half, across), high, 0.0);
  q.girth = 0.75;
  q.tint = vec4f(dockLot(dockLap(rib), 4), across, z, 1.0);
  return q;
}`;

/**
 * THE WORK LAMPS, three to a rib. Two are sodium, one under the edge of each wall's second gantry, turned to the
 * wall: a pool of warm light down the plates under every one. The third is a flood in the crown, cold white,
 * shining straight down the fifty metres to the deck: it is what lights the deck and whatever flies over it,
 * from above. Points for a Light in Points mode. One in five is dead, and the rest breathe with the low end as
 * the tunnel's lamps do.
 */
export const DOCK_LAMP_KERNEL = `// T1561b — the dock's work lamps (src/projects/sentinel-bot/dock.ts).
struct Params {
  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  1 in the dock.
  power: f32, // @default 70  A gantry lamp's intensity.
  flood: f32, // @default 2500  A crown flood's intensity.
};
${DOCK_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let which = ctx.index % 3u;
  let rib = i32(floor(ctx.params.travel / DOCK_RIB)) + i32(ctx.index / 3u) - ${DOCK.lampRibsBehind};
  let z = (f32(rib) + 0.5) * DOCK_RIB;
  let alive = step(0.2, dockLot(dockLap(rib), 9 + i32(which))) * step(0.5, ctx.params.place);
  let own = dockLot(dockLap(rib), 7 + i32(which));
  if (which == 2u) {
    // The crown's flood: just under the rib, on the middle line.
    q.position = hallCentre(z) + vec3f(0.0, DOCK_RADIUS - ${f(DOCK.ribDeep + 1.0)}, 0.0);
    q.tint = vec4f(0.82, 0.9, 1.0, 1.0);
    q.power = ctx.params.flood * alive;
    q.aim = vec3f(0.0, -1.0, 0.0);
    return q;
  }
  let side = select(-1.0, 1.0, which == 1u);
  let high = DOCK_TIERS[1] - 1.2;
  let up = high - DOCK_LIFT;
  let half = sqrt(max(DOCK_RADIUS * DOCK_RADIUS - up * up, 1.0)) - ${f(DOCK.tierDeep + 0.6)};
  q.position = pathAt(z) + vec3f(side * half, high, 0.0);
  // Sodium, each a little its own.
  q.tint = vec4f(1.0, 0.58 + 0.1 * own, 0.24 + 0.08 * own, 1.0);
  q.power = ctx.params.power * alive;
  // Down the wall under it.
  q.aim = normalize(vec3f(side * 0.5, -1.0, 0.0));
  return q;
}`;

const BEAM_PARAMS_WGSL = `  travel: f32, // @default 0  Distance travelled along the line, metres.
  place: f32, // @default 0  1 in the dock.
  sweep: f32, // @default 0  How far through their sweeps the searchlights are: across the hall and back once for every two. Drive it from a clock.
  level: f32, // @default 1  How bright they are, 0 to 1.`;

/**
 * A SEARCHLIGHT: it stands on the deck by a wall, a little ahead of the robot, and goes about: across the hall and
 * back, and up and down the length of it, each on its own count. The same rule for the cone that is drawn and for
 * the Spot that lights what the cone crosses.
 */
const BEAM_WGSL = `${DOCK_WGSL}
struct Beam {
  foot: vec3f,
  toward: vec3f,
};

fn beamOf(beam: u32, travel: f32, sweep: f32) -> Beam {
  // They stand at marks 96 m apart along the hall, two to a mark, one by each wall.
  let mark = floor(travel / 96.0) + f32(beam / 2u);
  let side = select(-1.0, 1.0, beam % 2u == 1u);
  let z = (mark + 0.35) * 96.0;
  var b: Beam;
  b.foot = pathAt(z) + vec3f(side * 30.0, -DOCK_DECK + 0.6, 0.0);
  let own = f32(beam) * 1.7;
  // Across the hall toward the far wall and back; along it; and never down.
  let across = -side * (0.15 + 0.55 * (0.5 + 0.5 * sin(sweep * 6.2831853 * 0.5 + own)));
  let along = 0.7 * sin(sweep * 6.2831853 * 0.25 + own * 2.3);
  b.toward = normalize(vec3f(across, 0.75, along));
  return b;
}
`;

/** The searchlights' cones: `beamPoints` points along each. With nothing to show, every strip is one point of no radius. */
export const BEAM_KERNEL = `// T1561b — the dock's searchlights, as cones of lit air (src/projects/sentinel-bot/dock.ts).
struct Params {
${BEAM_PARAMS_WGSL}
};
${BEAM_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let beam = beamOf(ctx.index / ${DOCK.beamPoints}u, ctx.params.travel, ctx.params.sweep);
  let along = f32(ctx.index % ${DOCK.beamPoints}u) / ${f(DOCK.beamPoints - 1)};
  if (ctx.params.place < 0.5 || ctx.params.level < 0.01) {
    q.position = vec3f(beam.foot.x, -4000.0, beam.foot.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  q.position = beam.foot + beam.toward * (along * ${f(DOCK.beamLength)});
  // A lamp's glass at the foot, and a cone that opens as it goes.
  q.girth = 0.35 + 4.2 * along;
  q.tint = vec4f(ctx.params.level, 0.0, 0.0, along);
  return q;
}`;

/** One point a searchlight: where its Spot stands, which way it shines, how strong. */
export const BEAM_LIGHT_KERNEL = `// T1561b — the dock's searchlights, as lights (src/projects/sentinel-bot/dock.ts).
struct Params {
${BEAM_PARAMS_WGSL}
  power: f32, // @default 900  A searchlight's intensity.
};
${BEAM_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let beam = beamOf(ctx.index, ctx.params.travel, ctx.params.sweep);
  q.position = beam.foot;
  q.tint = vec4f(0.78, 0.88, 1.0, 1.0);
  q.power = ctx.params.power * ctx.params.level * step(0.5, ctx.params.place);
  q.aim = beam.toward;
  return q;
}`;

/**
 * A cone of lit air: all light, drawn over what is there. Brightest seen along its length and through its
 * middle, nothing at its edge (the facing of a cone's skin to the lens is how much air the eye looks through),
 * and thinning as it opens.
 */
export const BEAM_SURFACE_WGSL = `struct Params {
  glow: f32, // @default 0.5  Radiance of the lit air at the lamp.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let through = abs(dot(normalize(s.eye - s.world), s.normal));
  let along = s.tint.a;
  o.albedo = vec4f(0.0, 0.0, 0.0, 1.0);
  o.roughness = 1.0;
  o.metallic = 0.0;
  o.emissive = vec3f(0.78, 0.88, 1.0) * (p.glow * s.tint.r * through * through * (1.0 - along) * (1.0 - along) / (0.35 + 6.0 * along));
  return o;
}`;

/**
 * THE HALL'S STEEL. Plates with seams, each a little its own, grimed and streaked below every ledge; the ribs
 * heavy and dark; a gantry's edge with its row of lamps (sodium, a lamp every three metres, and they answer a
 * kick as the fields' pods do: a ring going out from the robot) and its underside lit by them; here and there a
 * lit window; and the deck far below, wet, with lanes painted down it and the cold lights of the landing pads.
 */
export const HALL_SURFACE_WGSL = `// @use surface-detail
struct Params {
  lamps: f32, // @default 3  Radiance of a gantry's lamps.
  pads: f32, // @default 2  Radiance of the deck's landing lights.
  kick: f32, // @default 0  The kick, 0 to 1 as it decays.
  beat: f32, // @default 0  The beat's count: a whole number.
  react: f32, // @default 1  How much the hall's lights answer the track.
  robotAt: vec3f, // @default [0, 0, 0]  Where the robot is: a kick goes out along the hall from there.
};

fn hallLot(a: f32, b: f32) -> f32 {
  let n = (u32(i32(a) + 4096) * 73856093u) ^ (u32(i32(b) + 4096) * 19349663u);
  let m = (n ^ (n >> 15u)) * 2246822519u;
  return f32((m ^ (m >> 13u)) >> 8u) / 16777216.0;
}

fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let what = s.tint.r;
  let high = s.tint.g;
  let around = s.tint.b;
  let z = s.tint.a;
  let grime = detailFbm(s.world * vec3f(0.35, 0.5, 0.35), 4, s.footprint);
  let fine = detailFbm(s.world * 2.4, 3, s.footprint);
  // A kick is a ring going out along the hall from the robot.
  let gone = length(s.world - p.robotAt);
  let ring = exp(-pow((gone - (1.0 - p.kick) * 180.0) / 12.0, 2.0)) * smoothstep(0.03, 0.2, p.kick) * p.react;
  // Painted steel, worn: it must take a lamp's light as paint does. (As bare dark metal the whole hall was a
  // black room with rows of lamps in it: a metal shows a light only where it mirrors it.)
  var albedo = vec3f(0.12, 0.125, 0.12);
  var rough = 0.7;
  var metal = 0.25;
  var glow = vec3f(0.0);
  let sodium = vec3f(1.0, 0.6, 0.26);
  if (what > 2.5) {
    // The deck: dark, wet in pools, lanes painted down it, and the pads' lights.
    let across = s.world.x;
    // (Pools: a few, with soft edges. At half the deck they read as a pattern painted on it.)
    let wet = smoothstep(0.6, 0.72, grime.value);
    albedo = vec3f(0.07, 0.072, 0.075) * (0.7 + 0.6 * fine.value);
    rough = mix(0.75, 0.1, wet);
    metal = 0.1;
    albedo = albedo * mix(1.0, 0.45, wet);
    let lane = (1.0 - smoothstep(0.1, 0.16, abs(across - floor(across / 14.0 + 0.5) * 14.0))) * step(0.35, fine.value);
    albedo = mix(albedo, vec3f(0.5, 0.4, 0.06), lane * 0.85);
    // A pad every 96 m: a ring of cold lights, and they step round on the beat.
    let padZ = (floor(z / 96.0) + 0.5) * 96.0;
    let off = vec2f(across - floor(across / 28.0 + 0.5) * 28.0, z - padZ);
    let rim = abs(length(off) - 7.0);
    let turn = atan2(off.y, off.x) / 6.2831853 * 16.0;
    let lamp = (1.0 - smoothstep(0.12, 0.3, rim)) * (1.0 - smoothstep(0.18, 0.3, abs(fract(turn) - 0.5)));
    let stepping = 0.35 + 0.65 * step(0.75, fract((floor(turn) + p.beat) / 4.0) + 0.01);
    glow = vec3f(0.5, 0.8, 1.0) * (p.pads * lamp * stepping);
  } else if (what > 1.5) {
    // A gantry: its deck is grating, its edge carries the lamps, its underside is lit by them.
    let facing = s.normal.y;
    albedo = vec3f(0.09, 0.09, 0.085) * (0.6 + 0.8 * fine.value);
    rough = 0.7;
    metal = 0.4;
    let edge = 1.0 - smoothstep(0.25, 0.6, abs(facing));
    let every = fract(z / 3.0) - 0.5;
    let lamp = edge * (1.0 - smoothstep(0.05, 0.11, abs(every)));
    let alive = step(0.12, hallLot(floor(z / 3.0), floor(high)));
    glow = sodium * (p.lamps * lamp * alive * (1.0 + 2.5 * ring));
    // Under it: the lamps' light on the steel.
    glow = glow + sodium * (p.lamps * 0.05 * smoothstep(0.3, 0.9, -facing) * (1.0 + 2.5 * ring));
  } else if (what > 0.5) {
    // A rib: heavy, dark, a little polished where things have passed. In the crown it carries the flood: a lit
    // glass a few metres across the middle line.
    albedo = vec3f(0.07, 0.072, 0.078) * (0.7 + 0.6 * fine.value);
    rough = mix(0.5, 0.8, grime.value);
    metal = 0.5;
    let crown = 1.0 - smoothstep(0.012, 0.02, abs(around - 0.5));
    glow = vec3f(0.82, 0.9, 1.0) * (p.lamps * 2.0 * crown);
  } else {
    // Plates: 4 m by 3 m, each a little its own, a seam round each.
    let panel = vec2f(floor(z / 4.0), floor(around * 80.0));
    let own = hallLot(panel.x, panel.y);
    let seam = max(1.0 - smoothstep(0.0, 0.07, abs(fract(z / 4.0) - 0.5) * 2.0 - 0.9), 1.0 - smoothstep(0.0, 0.06, abs(fract(around * 80.0) - 0.5) * 2.0 - 0.9));
    // Grey-green paint, some plates ochre primer.
    albedo = mix(vec3f(0.1, 0.115, 0.11), mix(vec3f(0.17, 0.18, 0.17), vec3f(0.22, 0.17, 0.09), step(0.8, own)), own) * (0.55 + 0.7 * grime.value);
    rough = mix(0.5, 0.85, grime.value) + (own - 0.5) * 0.2;
    albedo = albedo * (1.0 - 0.6 * seam);
    // Rust runs down from the seams.
    let run = detailFbm(vec3f(s.world.x * 3.0, s.world.y * 0.25, s.world.z * 3.0), 3, s.footprint).value;
    let rust = smoothstep(0.55, 0.75, run) * smoothstep(0.4, 0.7, grime.value);
    albedo = mix(albedo, vec3f(0.11, 0.04, 0.015), rust * 0.7);
    rough = mix(rough, 0.92, rust);
    metal = mix(metal, 0.05, rust);
    // Here and there a lit window: a room behind the wall.
    let pane = abs(vec2f(fract(z / 4.0), fract(around * 80.0)) - 0.5);
    // (On the walls: not in the vault overhead.)
    let window = step(0.93, own) * (1.0 - smoothstep(0.2, 0.24, pane.x)) * (1.0 - smoothstep(0.12, 0.16, pane.y)) * (1.0 - smoothstep(18.0, 24.0, high));
    glow = sodium * (p.lamps * 0.12 * window);
    albedo = mix(albedo, vec3f(0.0), window);
  }
  o.albedo = vec4f(albedo, 1.0);
  o.roughness = clamp(rough, 0.06, 1.0);
  o.metallic = metal;
  o.normal = detailBump(s.normal, fine.gradient * 2.4, 0.02);
  o.emissive = glow;
  return o;
}`;

/** A bridge: a box of dark steel with a row of lamps under it. */
export const BRIDGE_SURFACE_WGSL = `// @use surface-detail
struct Params {
  lamps: f32, // @default 3  Radiance of its lamps.
};
fn surface(s: SurfaceIn, p: Params) -> SurfaceOut {
  var o = surfaceDefaults(s);
  let across = s.tint.g;
  let fine = detailFbm(s.world * 2.0, 3, s.footprint);
  o.albedo = vec4f(vec3f(0.024, 0.025, 0.028) * (0.6 + 0.8 * fine.value), 1.0);
  o.roughness = 0.6;
  o.metallic = 0.85;
  // Lamps under it, one every twelfth of the way across.
  let lamp = smoothstep(0.5, 0.9, -s.normal.y) * (1.0 - smoothstep(0.08, 0.16, abs(fract(across * 12.0) - 0.5)));
  o.emissive = vec3f(1.0, 0.6, 0.26) * (p.lamps * lamp);
  return o;
}`;
