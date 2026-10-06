import { wgslVec3, wgslVec4, type KitFacts, type Vec3 } from "./kit.ts";
import { PATH, pathWgsl } from "./path.ts";

/**
 * T1561b — THE SENTINEL'S RIG: where the body is, and where every joint of every tentacle is.
 *
 * The robot is PROCEDURAL — it climbs a tunnel that does not exist until run time — and its
 * rig is a POINTSET: one point per joint (54 rings, a claw hub and eight phalanges for each of
 * ten tentacles), carrying a position, an orientation and what kind of joint it is. Whatever
 * draws a joint instances a mesh on its point. That is the TouchDesigner shape (a point
 * operator feeding a Geometry COMP's instancing) and the Notch shape (a cloner under
 * effectors), and it is why the rig costs 631 evaluations a frame however dense the ring
 * mesh is. The 631st is the robot itself: one point where its body is and how it is turned,
 * so the hull is one more instance and a pack of robots is a few more points. Every point is the JOINT itself, in the kit's joint frame (+Z toward the tip, +Y the
 * frame's normal: the curve family's convention, docs/curve-family-design-2026-10-05.md R5), which
 * is where an instanced ring, hub or phalanx has its origin (§T1581b).
 *
 * Every joint is CLOSED FORM: a function of the distance travelled, the clock and a few
 * knobs, with no state carried between frames. So it cannot drift or explode, a frame is
 * reproducible from its number, and — because a point kernel has no substeps (§T1583b) and
 * a neighbour read sees last frame (§T1070), a simulated 54-link chain would settle one link
 * per frame — it is also the only form that holds a chain's length exactly today.
 *
 * ## The gait
 *
 * A tentacle that walks plants its claw on a RUNG of the tunnel wall ahead of the body, holds
 * it while the body passes (stance), then lets go and swings to the next one (swing). Which
 * step it is on is `floor(distance / stride + phase)`, so every plant is a pure function of
 * distance: stop the robot and it holds exactly where it is; back it up and it un-walks.
 *
 * ## The tentacle
 *
 * Arcs of CONSTANT CURVATURE — the standard model of a continuum arm. An arc bends evenly, so
 * its length is exact by construction (slack shows as a rounder bow, never as a stretched or
 * crowded ring), its tightest radius is its length over its turn, and every joint's place and
 * frame are closed form with no twist to accumulate.
 *
 * A tentacle that HOLDS a rung is one arc from socket to claw. For a given length and a given
 * chord there is exactly one such arc up to which way it bows, and it bows the way the socket
 * faces (out and back, off the hull), so the answer is unique and continuous in the claw's
 * place: no branch to jump between, which is what a pop is. The socket swivels to meet it. Past
 * a quarter-circle each side a bow swells beyond its own ends, and through the wall, so slack
 * beyond a little more than that is taken up inside the body: the first rings stay stowed.
 *
 * A tentacle that TRAILS is two arcs, a neck that curls into the wake and an arm that sways.
 * Between the two states the curvatures, the plane and the socket's direction all blend.
 */

/** Points per tentacle: the rings, the hub, then two phalanges per finger. */
export function stationsPerTentacle(facts: KitFacts): number {
  return facts.ringCount + 1 + facts.fingers * 2;
}

/**
 * WHICH of a robot's points a kernel writes. A draw instances its mesh on every point of its
 * pointset, and a point it does not want still costs the whole mesh in the vertex stage
 * (nothing culls an instance yet, §T1592b), so each piece gets a pointset of exactly its own
 * points: a run of `count` stations of every tentacle starting at `first`, or the robot's body.
 * 631 hull instances with 630 turned away measured 400 ms a frame; one, 5.
 */
export type Pick = { readonly first: number; readonly count: number } | "body";

/** The ring joints and the hub of every tentacle: the strip a curve would be (§T1586b). */
export function spinePick(facts: KitFacts): Pick {
  return { first: 0, count: facts.ringCount + 1 };
}

/** Points ONE robot has in a pick; a rig of several holds them robot after robot. */
export function jointCount(facts: KitFacts, pick: Pick): number {
  return pick === "body" ? 1 : facts.sockets.length * pick.count;
}

/**
 * What a point is, as its `kind`: what each draw's Group picks its points by. A phalanx is
 * `phalanx + finger × 2 + link`; a ring still stowed in the body is −1 and nothing draws it.
 */
export const KIND = { ring: 0, hub: 1, phalanx: 2, body: 10 } as const;

/** Metres between the rungs a claw may plant on; divides the path's period, so the wrap lands on one. Every fourth is a rib of the tunnel (tunnel.ts). */
export const RUNG_SPACING = 0.4;
/** How far past its joint the hub's cone reaches: the curve ends at the claw's mouth, not its wrist. */
const CLAW_REACH = 0.19;

export const JOINT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
  // How much of a pulse is on the piece: 0 at rest, 1 under a crest that has just left the body. The material's
  // instance field of the same name reads it and says how bright that is (surface.ts).
  { name: "charge", type: "f32", default: [0] },
  // Which piece it is, 0 to 1: the material ages each piece in its own way (surface.ts).
  { name: "seed", type: "f32", default: [0] },
  // How far along its tentacle a joint is, 0 at the body to 1 at the claw: its place in the lights' colour range (surface.ts).
  { name: "along", type: "f32", default: [0] },
  // 1 on a tentacle's rings: the material keeps them matt and dark between the lit segments (surface.ts).
  { name: "matte", type: "f32", default: [0] },
  // What the point is (KIND): what a draw's Group picks its points by.
  { name: "kind", type: "f32", default: [-1] },
  // Metres between the claw's mouth and where the gait wants it; zero while its rung is in reach.
  { name: "slip", type: "f32", default: [0] },
]);

/** The knobs that say where the robot is. */
const PLACE_PARAMS = `  travel: f32, // @default 0  Distance travelled along the tunnel, metres.
  offset: vec3f, // @default 0  The robot's place off the tunnel's axis: right, up, ahead (metres).
  roll: f32, // @default 0  Roll about its own heading, radians.
  look: vec2f, // @default 0  Where the head turns, radians: x to its right, y up. A perched robot scans with it.
  swim: f32, // @default 0  Let go of the wall and beat the tentacles together like a squid: 0 walking, 1 swimming. A chamber makes it swim whatever this says.
  stroke: f32, // @default 0  Where the beat is, 0 to 1: flung open at 0, snapped shut by a quarter, drifting open again.`;

/**
 * How a robot that nothing holds wanders off the tunnel's axis: two slow sines each way,
 * `[metres, radians a second, how much of the robot's own count, phase]`. One table, read by the
 * rig on the GPU and, for the robot the camera follows, by the camera (document.ts): a close
 * shot rides with it.
 */
const ADRIFT: Readonly<Record<"x" | "y", ReadonlyArray<readonly [number, number, number, number]>>> = {
  x: [[0.5, 0.31, 1, 0], [0.22, 0.73, 1.7, 1.3]],
  y: [[0.38, 0.23, 0.6, 2.0], [0.18, 0.57, 1, 0]],
};
/** …and along the tunnel: it gains and loses this many metres on this slow a count (radians a second). */
const ADRIFT_AHEAD = [0.7, 0.21] as const;
/** How far ahead of its place the leader has drifted, fully adrift: metres, as an expression. */
export const adriftAheadExpression = `(${ADRIFT_AHEAD[0]} * sin(abstime * ${ADRIFT_AHEAD[1]}))`;
const adriftWgsl = (axis: "x" | "y"): string => ADRIFT[axis].map(([metres, rate, own, phase]) => `${metres} * sin(time * ${rate} + own * ${own} + ${phase})`).join(" + ");
/** A robot's own count from its place off the pack's (right, up, ahead): what the rig's `ownCount` computes. */
export const ownCountOf = (offset: readonly [number, number, number]): number => offset[2] * 1.3 + offset[0] * 2.1;
/** Where a robot has wandered to, fully adrift: metres right or up, as an expression. The leader's by default (no place of its own off the pack's). */
export const adriftExpression = (axis: "x" | "y", own = 0): string => `(${ADRIFT[axis].map(([metres, rate, scale, phase]) => `${metres} * sin(abstime * ${rate} + ${(own * scale + phase).toFixed(4)})`).join(" + ")})`;
/** With company a robot wanders a fifth as far, and holds the ends of its tentacles in: three in a bore have no room for more. */
export const PACK_WANDER = 0.2;
/**
 * How much further apart the pack flies out in the fields, as a hall's swell is reckoned: a hall is 1, and
 * this many halls' worth puts the three 3.7 m either side of the leader and 2.2 m over and under it.
 */
export const FIELD_BERTH = 1.6;

const ROBOT_FRAME = `${pathWgsl()}
// How much it swims at z: what it is told, or a chamber's say-so, read a little way ahead so
// it has let go before the wall is out of reach.
fn swimAt(swim: f32, z: f32) -> f32 {
  return max(clamp(swim, 0.0, 1.0), chamberAt(z + 2.5));
}

// Where along the tunnel the robot is. Swimming, it lunges on the snap of each stroke and
// drifts back between: half a metre either side of where it would glide.
fn robotZ(travel: f32, offset: vec3f, swim: f32, stroke: f32) -> f32 {
  let z = travel + offset.z;
  return z + swimAt(swim, z) * 0.5 * sin(6.2831853 * (stroke - 0.125));
}

// Adrift it does not keep its distance either: it gains and loses most of a metre on a slow count.
fn adriftZ(time: f32, offset: vec3f) -> f32 {
  return ${ADRIFT_AHEAD[0]} * sin(time * ${ADRIFT_AHEAD[1]} + offset.z * 0.9 + offset.x * 1.7);
}

// The robot's own frame: on the tunnel's frame at its distance, facing a little way ahead so it
// turns into a bend before it reaches it, banking into the bend, and never hanging dead still.
// \`adrift\` (0 to 1) is how much it is in the water and not on the wall: it wanders half a
// metre off the axis on slow counts of its own, noses about and rolls, as a thing does that
// nothing holds.
fn adriftAcross(time: f32, own: f32) -> vec2f {
  return vec2f(${adriftWgsl("x")}, ${adriftWgsl("y")});
}

// A robot's own count: what makes each of a pack wander differently.
fn ownCount(offset: vec3f) -> f32 {
  return offset.z * 1.3 + offset.x * 2.1;
}

fn robotFrame(z: f32, offset: vec3f, roll: f32, look: vec2f, time: f32, adrift: f32) -> Frame {
  let tunnel = pathFrame(z);
  var frame: Frame;
  let own = ownCount(offset);
  let drift = vec2f(sin(time * 0.9 + offset.z), sin(time * 1.3 + offset.z * 1.7)) * 0.05 + adrift * adriftAcross(time, own);
  frame.origin = tunnel.origin + tunnel.right * (offset.x + drift.x) + tunnel.up * (offset.y + drift.y);
  frame.forward = pathTangent(z + 1.2);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), frame.forward));
  let up = cross(frame.forward, right);
  // How fast the heading swings, measured a couple of metres either side: the inside of the turn drops.
  let bank = roll + adrift * 0.28 * sin(time * 0.19 + own * 0.8) - 1.5 * (pathTangent(z + 2.0).x - pathTangent(z - 2.0).x);
  // Adrift it noses off the tunnel's heading: it points where it is wandering to.
  let nose = look + adrift * vec2f(0.16 * cos(time * 0.31 + own) + 0.1 * cos(time * 0.73 + own * 1.7 + 1.3), 0.12 * cos(time * 0.23 + own * 0.6 + 2.0));
  let banked = right * cos(bank) + up * sin(bank);
  let crown = up * cos(bank) - right * sin(bank);
  // The head turns: about its own up, then about its own right.
  let ahead = frame.forward * cos(nose.x) + banked * sin(nose.x);
  frame.right = banked * cos(nose.x) - frame.forward * sin(nose.x);
  frame.forward = ahead * cos(nose.y) + crown * sin(nose.y);
  frame.up = crown * cos(nose.y) - ahead * sin(nose.y);
  return frame;
}
`;

/**
 * Where on the bore each tentacle plants: the sockets' own order around the body, spread
 * evenly, so neighbours on the body are neighbours on the wall and no two tentacles cross to
 * reach their ribs.
 */
function wallAngles(facts: KitFacts): { angle: number[]; rank: number[] } {
  const count = facts.sockets.length;
  const own = facts.sockets.map((socket) => Math.atan2(socket[1], socket[0]));
  const order = own.map((_, index) => index).sort((a, b) => (own[a] as number) - (own[b] as number));
  const rank = new Array<number>(count).fill(0);
  order.forEach((tentacle, place) => (rank[tentacle] = place));
  const even = (place: number): number => -Math.PI + ((place + 0.5) * 2 * Math.PI) / count;
  // Turn the even set by the mean difference, so each tentacle plants as near its own side as an even spread allows.
  const turn = order.reduce((total, tentacle, place) => total + ((own[tentacle] as number) - even(place)), 0) / count;
  return { angle: rank.map((place) => even(place) + turn), rank };
}

/**
 * `robots` places each robot of the pack off the pack's own place: right, up, ahead (metres).
 * A table baked into the kernel, because a kernel reads one pointset and its knobs are scalars:
 * when it can read a second pointset (§T1582b) the robots become points and this a lookup,
 * and the kernels of the several picks one kernel whose points the others read.
 */
export function jointKernel(facts: KitFacts, robots: readonly Vec3[], pick: Pick): string {
  if (robots.length === 0) throw new Error("jointKernel: a rig needs at least one robot.");
  const tentacles = facts.sockets.length;
  const stations = stationsPerTentacle(facts);
  const { angle, rank } = wallAngles(facts);
  // A WAVE of steps round the body, not two gangs. Each tentacle steps a tenth of a cycle after another, and
  // the next to step is three places round from the last (three and ten share no factor, so every tentacle
  // has its own tenth): at any moment the ones in the air are spread round the body and the same number are
  // planted. (Until 2026-10-06 alternate neighbours stepped half a cycle apart: five let go together, then
  // the other five, which an animator read as janky, and it was.)
  const phase = rank.map((place) => ((place * 3) % tentacles) / tentacles);
  // As Crawl rises the tentacles take to the wall opposite pairs first, so the body is always held from two sides.
  const engage = rank.map((place) => ((place * (tentacles / 2 + 1)) % tentacles + tentacles) % tentacles);
  const length = facts.hubDistance + CLAW_REACH;
  const rungs = Math.round(PATH.period / RUNG_SPACING);
  if (Math.abs(rungs * RUNG_SPACING - PATH.period) > 1e-6) throw new Error(`jointKernel: the rung spacing ${RUNG_SPACING} m does not divide the path's ${PATH.period} m period.`);
  const list = (values: readonly number[]): string => values.map((value) => value.toFixed(5)).join(", ");
  const phalanges = facts.phalanges.length;
  return `// @use quat
// T1561b — the sentinel's joints (generated by src/projects/sentinel-bot/rig.ts from the kit).
struct Params {
${PLACE_PARAMS}
  crawl: f32, // @default 1  How many of the tentacles walk the wall: 0 none (all trail behind), 1 every one.
  stride: f32, // @default 3.2  Metres the body travels per step of a tentacle.
  duty: f32, // @default 0.62  Share of a step the claw stays planted. The rest it is in the air, reaching for the next rung.
  lead: f32, // @default 0.75  Metres ahead of the body a claw plants.
  lift: f32, // @default 0.35  How far a swinging claw pulls in off the wall, as a share of the way to the axis.
  bore: f32, // @default 2.6  Radius of the wall the claws plant on, metres.
  flare: f32, // @default 0.25  How far the trailing tentacles splay outward.
  wave: f32, // @default 0.05  Amplitude of the wave travelling down a tentacle, metres.
  waveRate: f32, // @default 1.2  Its speed, radians per second.
  grip: f32, // @default 1  How far a planted claw closes: 0 open, 1 shut.
  variety: f32, // @default 1  How differently the robots of a pack step: 0 in unison, 1 each on its own count.
  gesture: f32, // @default 0  What a tentacle with no rung to hold does: 0 trails behind, 1 reaches out and feels about.
  snap: f32, // @default 0  Shuts the claws of the tentacles that hold nothing: 0 open, 1 shut. A hat on it and they clack.
  pulse: f32, // @default 100  Seconds since the last pulse left the body: it runs down every tentacle's core and fades. Drive it from a kick.
  carry: f32, // @default 1  How far off rails the body is: walking it weaves slowly across the tunnel's axis, swimming it is adrift. 0 is on rails.
  meter: f32, // @default 0  The cores as a level meter: lit from the body out to this share of each tentacle, 0 to 1. Drive it from a level.
  chase: f32, // @default 0  Brightness of the bands that run out along the cores.
  chasePhase: f32, // @default 0  Where those bands are: they move one band's spacing out for each whole number. Drive it from the beat.
  bands: f32, // @default 3  How many bands a tentacle carries at once.
  spark: f32, // @default 0  Brightness of single cores flashing at random. Drive it from a hat.
  spiral: f32, // @default 0  It walks a corkscrew round the bore: turns per 16 m of tunnel. 0 walks straight.
  spiralTurn: f32, // @default 0  How far round it has got, in turns. Drive it from an integrator of Spiral x speed, so the rungs it holds stay put.
  attack: f32, // @default 0  The attack: every other tentacle lets go of the wall, coils by the face and strikes forward, again and again; the rest hold. 0 to 1.
  company: f32, // @default 0  Whether it has company, 0 to 1: with others beside it, it wanders a fifth as far and holds its tentacles' ends in.
  afield: f32, // @default 0  1 out in the fields (field.ts), where the pack has all the room there is; 0 in the tunnel.
  pack: f32, // @default 1000  How many robots of the pack are out: 1 is the leader alone, 2 brings the second up from behind, and a part of one is one on its way. The default is all of them.
};
${ROBOT_FRAME}
const ROBOTS: u32 = ${robots.length}u;
// Which of a robot's points this kernel writes (rig.ts, Pick).
const PICK_BODY: bool = ${pick === "body"};
const PICK_FIRST: u32 = ${pick === "body" ? 0 : pick.first}u;
const PICK_COUNT: u32 = ${pick === "body" ? 1 : pick.count}u;
const ROBOT_POINTS: u32 = ${jointCount(facts, pick)}u;
const ROBOT_OFFSET = array<vec3f, ${robots.length}>(${robots.map(wgslVec3).join(", ")});
const TENTACLES: u32 = ${tentacles}u;
const RINGS: u32 = ${facts.ringCount}u;
const STATIONS: u32 = ${stations}u;
const RING_START: f32 = ${facts.ringStart.toFixed(5)};
const RING_PITCH: f32 = ${facts.ringPitch.toFixed(5)};
const HUB_DISTANCE: f32 = ${facts.hubDistance.toFixed(5)};
const LENGTH: f32 = ${length.toFixed(5)};
const RUNG: f32 = ${RUNG_SPACING.toFixed(5)};
const SOCKET = array<vec3f, ${tentacles}>(${facts.sockets.map(wgslVec3).join(", ")});
const WALL_ANGLE = array<f32, ${tentacles}>(${list(angle)});
const STEP_PHASE = array<f32, ${tentacles}>(${list(phase)});
const ENGAGE = array<f32, ${tentacles}>(${list(engage)});
// Which tentacles strike in an attack (1) and which hold the wall for it (0): every other one round the body.
const STRIKER = array<f32, ${tentacles}>(${list(rank.map((place) => place % 2))});
const SPIRAL_PITCH: f32 = 16.0;
// The claw, from the kit: each phalanx's joint on its carrier, its rest orientation there, its hinge and the range the reference performance turns it through.
const PHALANX_JOINT = array<vec3f, ${phalanges}>(${facts.phalanges.map((phalanx) => wgslVec3(phalanx.joint)).join(", ")});
const PHALANX_REST = array<vec4f, ${phalanges}>(${facts.phalanges.map((phalanx) => wgslVec4(phalanx.rest)).join(", ")});
const PHALANX_AXIS = array<vec3f, ${phalanges}>(${facts.phalanges.map((phalanx) => wgslVec3(phalanx.axis)).join(", ")});
const PHALANX_RANGE = array<vec2f, ${phalanges}>(${facts.phalanges.map((phalanx) => `vec2f(${phalanx.range[0].toFixed(5)}, ${phalanx.range[1].toFixed(5)})`).join(", ")});

// Integer hashes: a plant must be the same rung on every driver, which fract(sin(x)) does not promise.
fn mix32(v: u32) -> u32 {
  let x = v * 747796405u + 2891336453u;
  let w = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return (w >> 22u) ^ w;
}

fn chance(a: u32, b: u32, c: u32) -> f32 {
  return f32(mix32(a ^ mix32(b ^ mix32(c)))) / 4294967295.0;
}

// ── The tentacle: arcs of constant curvature ──
const NECK: f32 = LENGTH * 0.4;
const ARM: f32 = LENGTH - NECK;
// The half-turn at which slack starts to stow: past a quarter circle each side a bow swells beyond its own ends, by 5 cm here.
const BOW_LIMIT: f32 = 1.9;

fn sinc(x: f32) -> f32 {
  if (abs(x) < 1e-3) { return 1.0 - x * x / 6.0; }
  return sin(x) / x;
}

// The half-turn of an arc whose chord is that share of its length: sinc inverted on [0, π], where it only falls.
fn halfTurn(share: f32) -> f32 {
  var low = 0.0;
  var high = 3.14159265;
  for (var i = 0u; i < 20u; i = i + 1u) {
    let mid = (low + high) * 0.5;
    if (sinc(mid) > share) { low = mid; } else { high = mid; }
  }
  return (low + high) * 0.5;
}

// Where an arc of curvature k has got to after s metres, in its own plane: x along its start, y the way it bends.
fn arcAt(k: f32, s: f32) -> vec2f {
  let a = k * s;
  if (abs(a) < 1e-3) { return vec2f(s * (1.0 - a * a / 6.0), s * a * 0.5); }
  return vec2f(sin(a) / k, (1.0 - cos(a)) / k);
}

fn turned(v: vec2f, angle: f32) -> vec2f {
  return vec2f(v.x * cos(angle) - v.y * sin(angle), v.x * sin(angle) + v.y * cos(angle));
}

// A neck's and an arm's curvature.
struct Bend {
  neck: f32,
  arm: f32,
};

// A point d metres along a tentacle bent so, and its heading there, in the tentacle's plane.
fn along(bend: Bend, d: f32) -> vec3f {
  if (d <= NECK) { return vec3f(arcAt(bend.neck, d), bend.neck * d); }
  let turn = bend.neck * NECK;
  return vec3f(arcAt(bend.neck, NECK) + turned(arcAt(bend.arm, d - NECK), turn), turn + bend.arm * (d - NECK));
}

// How far round the bore the corkscrew has everything at z, radians. A function of the place along the
// tunnel, so a rung that is held does not move: the turn the robot has reached (an integrator's) and how
// much further round the walk goes for each metre beyond the leader's place.
fn spiralAt(z: f32, params: Params) -> f32 {
  return 6.2831853 * (params.spiralTurn + params.spiral * (z - params.travel) / SPIRAL_PITCH);
}

// Where tentacle t plants on step number step: a rung ahead of where the body was when it let go.
fn plant(tentacle: u32, step: f32, stride: f32, bodyZ: f32, own: f32, seed: u32, params: Params) -> vec3f {
  let steps = round(PATH_PERIOD / stride);
  let wrapped = u32(step - floor(step / steps) * steps + 0.5);
  var z = (step - STEP_PHASE[tentacle] - own) * stride + params.lead + (chance(tentacle, wrapped, seed) - 0.5) * 0.4;
  z = round(z / RUNG) * RUNG;
  // The same rung from whichever side of the path's wrap the body is on.
  z = z - round((z - bodyZ) / PATH_PERIOD) * PATH_PERIOD;
  let theta = WALL_ANGLE[tentacle] + (chance(tentacle, wrapped, seed + 1u) - 0.5) * 0.45 + spiralAt(z, params);
  let wall = pathFrame(z);
  // A hall's wall stands further off; the rung is on it all the same (whether the claw can reach it is the gait's business).
  return wall.origin + (wall.right * cos(theta) + wall.up * sin(theta)) * (params.bore * (1.0 + CHAMBER_SWELL * chamberAt(z)));
}

// ── The trail: what a tentacle does that holds nothing ──
// It streams back along the way the robot has come, as a squid's do: the bundle leaves the body
// in the arrangement the sockets have, draws in a little, lies along the tunnel behind (so it
// bends where the tunnel bent), squiggles more the further out, and only its ends stand apart.
// (The owner, 2026-10-05: "legs point straight away from it instead of going a bit to the back
// and then apart like a squid would … just the ends a bit spread out, the rest slightly
// squiggled but oriented backwards for the most part or rather along the velocity vector".)
// A shape, not a simulation: the kernel cannot read a neighbour, so there is no rope to solve (§T1585b).
struct Trail {
  z0: f32, // where along the tunnel its socket is
  across: vec2f, // the socket's direction off the body's axis, on the body's own right and up
  radius: f32, // how far off that axis the socket is, metres
  right: vec3f, // the body's right and up: the bundle starts on these and settles onto the tunnel's
  up: vec3f,
  offset: vec2f, // the body's place off the tunnel's axis now
  berth: vec2f, // …and the part of it that is its standing place there (a pack's station): the tail keeps to that line
  flare: f32, // how far the ends stand apart at rest, metres
  swim: f32, // how much it is swimming, 0 to 1
  stroke: f32, // where the swimming beat is, 0 to 1
  adrift: f32, // how much the body is adrift, 0 to 1, and its own count
  own: f32,
  wave: f32, // the squiggle's size, metres
  phase: f32, // this tentacle's own count
  time: f32,
};

// How open the swimming beat has the tentacles, 0 to 1: flung open at the top of the beat, drawn
// in over the next third of it, drifting open again.
fn strokeOpen(stroke: f32) -> f32 {
  let at = stroke - floor(stroke);
  return select(smoothstep(0.34, 1.0, at), 1.0 - smoothstep(0.0, 0.34, at), at < 0.34);
}

// How far off the axis the trail runs s metres along, and how fast that changes.
fn trailRadius(t: Trail, s: f32) -> vec2f {
  // The beat reaches the ends late: what the body did a fifth of a bar ago, the tips do now. That lag is the drag.
  let open = t.swim * strokeOpen(t.stroke - 0.2 * s / LENGTH);
  let tip = t.flare + open * 0.85;
  let begins = LENGTH * mix(0.6, 0.3, open);
  let inward = clamp(s / 1.2, 0.0, 1.0);
  let apart = clamp((s - begins) / max(LENGTH - begins, 1e-3), 0.0, 1.0);
  let drawn = inward * inward * (3.0 - 2.0 * inward);
  let spread = apart * apart * (3.0 - 2.0 * apart);
  let radius = t.radius * (1.0 - 0.4 * drawn) + tip * spread * spread;
  let slope = -0.4 * t.radius * 6.0 * inward * (1.0 - inward) / 1.2 + tip * 2.0 * spread * 6.0 * apart * (1.0 - apart) / max(LENGTH - begins, 1e-3);
  return vec2f(radius, slope);
}

// A tentacle does not stretch: what it spends going outward it does not go back. The distance
// back along the axis after s metres of tentacle (a six-step sum; the squiggle takes a little more).
fn trailBack(t: Trail, s: f32) -> f32 {
  var back = 0.0;
  for (var i = 0u; i < 6u; i = i + 1u) {
    let slope = trailRadius(t, s * (f32(i) + 0.5) / 6.0).y;
    back = back + sqrt(max(1.0 - slope * slope, 0.04));
  }
  return back * s / 6.0 * 0.97;
}

fn trailShape(t: Trail, s: f32) -> vec3f {
  let tunnel = pathFrame(t.z0 - trailBack(t, s));
  let settle = 1.0 - exp(-s / 0.8);
  let right = normalize(mix(t.right, tunnel.right, settle));
  let up = normalize(mix(t.up, tunnel.up, settle));
  let around = right * t.across.x + up * t.across.y;
  let sideways = normalize(cross(around, tunnel.forward));
  let reach = s / LENGTH;
  // A long slow wave running out to the tip, growing as it goes: water, not a spring.
  let size = t.wave * (0.15 + 3.0 * reach * reach);
  let count = s * 1.7 - t.time * 1.25 + t.phase;
  let squiggle = (sideways * sin(count) + around * 0.6 * cos(count * 0.7 + 1.0)) * size;
  // A slow sway of the whole tail, a pendulum's: nothing at the body, most at the tip.
  let sway = sideways * sin(t.time * 0.45 + t.phase * 1.3) * 0.26 * reach * reach;
  // The tail goes where the body WENT: s metres back it is where the body had wandered to half a second
  // a metre ago, about the line the body itself keeps (its berth: a pack's robots fly beside the axis, and
  // drawn back onto the axis every tail of a pack pointed at the middle of the tunnel; the owner,
  // 2026-10-06: "a weird pull towards center instead of their own reference"). What else has the body off
  // that line (the tentacles that carry it) dies away behind it.
  let wandered = t.adrift * adriftAcross(t.time, t.own);
  let followed = t.berth + t.adrift * adriftAcross(t.time - s * 0.5, t.own) + (t.offset - t.berth - wandered) * exp(-s / 1.5);
  return tunnel.origin + tunnel.right * followed.x + tunnel.up * followed.y + around * trailRadius(t, s).x + squiggle + sway;
}

// How firmly tentacle t is told to take the wall. Crawl says how many do; WHICH ones moves
// round the body as it goes (one tentacle's turn every 9.6 m, which divides the path's length,
// so the set is the same either side of its wrap), so no tentacle holds for ever and none
// trails for ever. The hand-over is slow, most of a turn: a tentacle lets go and drifts back,
// or reaches forward and takes hold, over some three seconds. At Crawl 1 every one holds.
fn grabbing(tentacle: u32, crawl: f32, bodyZ: f32) -> f32 {
  let all = f32(TENTACLES);
  let centre = bodyZ / 9.6;
  let off = ENGAGE[tentacle] - centre;
  let apart = abs(off - all * round(off / all));
  let reach = clamp(crawl, 0.0, 1.0) * (all * 0.5 + 0.9);
  let held = clamp((reach - apart) / 0.9, 0.0, 1.0);
  // Quintic: it neither starts nor lands with a jolt.
  return held * held * held * (held * (held * 6.0 - 15.0) + 10.0);
}

// Whether tentacle t holds the wall: its turn round the body says, unless it is attacking, when every other
// tentacle holds and the ones between strike.
fn takesHold(tentacle: u32, bodyZ: f32, params: Params) -> f32 {
  return mix(grabbing(tentacle, params.crawl, bodyZ), 1.0 - STRIKER[tentacle], clamp(params.attack, 0.0, 1.0));
}

// One tentacle's gait: how far through its step it is.
fn swingOf(tentacle: u32, bodyZ: f32, stride: f32, count: f32, duty: f32) -> f32 {
  let cycle = bodyZ / stride + STEP_PHASE[tentacle] + count;
  return smoothstep(0.0, 1.0, clamp((cycle - floor(cycle) - duty) / max(1.0 - duty, 1e-3), 0.0, 1.0));
}

// Walking, the body is not on the tunnel's axis: it weaves across it, slowly, as a thing does that is
// handed along from hold to hold. A function of the distance it has come and of nothing else, with
// wavelengths of 13 and 21 metres (each divides the path's length, so the weave closes on itself): four
// and six seconds at a walk, and still when it stands. x right, y up, metres.
//
// The owner, three times (2026-10-05/06): "too bobby", "these things move smooth not jerk", "the bob
// and sway while walking looks super jank … very nervous movement back and forth". Two earlier versions
// read the gait (which tentacles hold, where) and each moved with every change of it, however much it
// was averaged. This one cannot: nothing about the legs or the track is in it.
fn weave(z: f32) -> vec2f {
  return vec2f(0.13 * sin(6.2831853 * z / (PATH_PERIOD / 72.0) + 1.1), 0.08 * sin(6.2831853 * z / (PATH_PERIOD / 45.0)));
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.slip = 0.0;
  q.charge = 0.0;
  q.seed = chance(ctx.index, PICK_FIRST, 7u);
  let robot = ctx.index / ROBOT_POINTS;
  if (robot >= ROBOTS) {
    q.kind = -1.0;
    return q;
  }
  let place = ctx.index % ROBOT_POINTS;
  let tentacle = place / PICK_COUNT;
  let station = PICK_FIRST + place % PICK_COUNT;
  let params = ctx.params;
  // How far out of the pack's back this robot is: 0 not there (nothing of it is drawn), 1 in its place. On its
  // way it comes up the tunnel from 45 m behind, out of the haze, and goes back the same way: it never pops.
  let present = clamp(params.pack - f32(robot), 0.0, 1.0);
  if (present <= 0.0) {
    q.position = vec3f(0.0);
    q.kind = -1.0;
    return q;
  }
  let arriving = 1.0 - present * present * (3.0 - 2.0 * present);
  // A robot's place off the leader's is given for the plain bore. Where the tunnel is wider (a hall, or the
  // panel's Tunnel turned up) the pack takes the room: its places across the tunnel grow with the radius there.
  // Not downward in a hall: a hall's walls and crown stand further off but its deck does not sink, and a
  // robot sent 1.9 times as far under the axis flew through the floor.
  // Out in the fields (field.ts) there is neither wall nor deck: more room than any hall, below as well as above.
  let berth = ROBOT_OFFSET[robot];
  let wide = params.bore / 2.6;
  let afield = step(0.5, params.afield);
  let roomy = wide * (1.0 + CHAMBER_SWELL * max(chamberAt(params.travel + berth.z), ${FIELD_BERTH.toFixed(2)} * afield));
  let offset = params.offset + vec3f(berth.x * roomy, berth.y * select(wide, roomy, berth.y > 0.0 || afield > 0.5), berth.z - 45.0 * arriving);
  let swimming = swimAt(params.swim, params.travel + offset.z);
  // Where the gait counts from: the rungs it plants on are a matter of how far it has come.
  let bodyZ = robotZ(params.travel, offset, params.swim, params.stroke);
  let stride = PATH_PERIOD / round(PATH_PERIOD / max(params.stride, 0.5));
  let count = f32(robot) * 0.37 * params.variety;
  // A pack in unison plants on the same ribs; with variety each robot draws its own.
  let seed = 1u + u32(f32(robot) * params.variety + 0.5) * 16u;
  // The body is not on rails. Walking, it weaves slowly across the axis (weave, above) and leans a
  // little into it. Swimming, nothing holds it and it is adrift.
  let afoot = (1.0 - swimming) * params.carry;
  let woven = weave(bodyZ);
  let sway = vec3f(woven, 0.0) * afoot;
  // …and less far in company (PACK_WANDER): there is no room to wander three abreast.
  let adrift = swimming * params.carry * mix(1.0, ${PACK_WANDER}, clamp(params.company, 0.0, 1.0));
  let frameZ = bodyZ + adrift * adriftZ(ctx.absTime, offset);
  // Walking a corkscrew, the body turns with the rungs it holds and rides a little toward the wall its back is to.
  let winding = spiralAt(bodyZ, params);
  let wound = clamp(params.spiral * 3.0, 0.0, 1.0) * (1.0 - swimming);
  let riding = vec3f(-sin(winding), cos(winding), 0.0) * 0.32 * wound;
  // Attacking it rears: nose up a little, to strike over what it holds.
  let rearing = clamp(params.attack, 0.0, 1.0) * (1.0 - swimming);
  let body = robotFrame(frameZ, offset + sway + riding, params.roll + winding - woven.x * 0.3 * afoot, params.look + vec2f(0.0, 0.14 * rearing), ctx.absTime, adrift);
  if (PICK_BODY) {
    // The robot's own point: where its body is and how it is turned (the kit's robot frame: +Z forward, +Y up).
    q.position = body.origin;
    q.orient = quatFromFrame(body.right, body.up, body.forward);
    q.kind = ${KIND.body}.0;
    return q;
  }
  let socket = SOCKET[tentacle];
  let root = body.origin + body.right * socket.x + body.up * socket.y + body.forward * socket.z;
  let radial = normalize(body.right * socket.x + body.up * socket.y);

  // ── Walking: stance on one rib, then a swing to the next ──
  let step = floor(bodyZ / stride + STEP_PHASE[tentacle] + count);
  let swing = swingOf(tentacle, bodyZ, stride, count, params.duty);
  let rib = plant(tentacle, step, stride, bodyZ, count, seed, params);
  let next = plant(tentacle, step + 1.0, stride, bodyZ, count, seed, params);
  var walking = mix(rib, next, swing);
  let aloft = sin(swing * 3.14159265);
  walking = mix(walking, pathAt(walking.z), params.lift * aloft);

  let grab = takesHold(tentacle, bodyZ, params) * (1.0 - swimming);
  let leave = normalize(body.forward * -0.6 + radial * 0.8);

  // ── Trailing: the neck curls back into the wake (less with Flare), the arm sways, the plane rocks ──
  let wake = -body.forward;
  let toWake = normalize(wake - leave * dot(wake, leave));
  let side = cross(leave, toWake);
  let rock = sin(ctx.absTime * 0.6 + f32(tentacle) * 1.3) * 0.5;
  let loosePlane = toWake * cos(rock) + side * sin(rock);
  // Swimming opens and shuts them together: splayed wide at the top of the beat, streamlined after the snap.
  let open = select(smoothstep(0.25, 1.0, params.stroke), 1.0 - smoothstep(0.0, 0.25, params.stroke), params.stroke < 0.25);
  let splay = clamp(params.flare + swimming * (open * 1.1 - 0.15), -0.2, 1.2);
  let trailing = Bend(
    acos(clamp(dot(leave, wake), -1.0, 1.0)) * (1.0 - splay) / NECK,
    (sin(ctx.absTime * 0.9 + f32(tentacle) * 2.1) * 0.35 - swimming * open * 0.6) / ARM,
  );
  // Gesturing: the neck turns the other way, out and forward, and the arm curls and uncurls
  // on two slow counts of its own, so no two tentacles feel about in step. Swimming overrides it.
  let own = f32(tentacle) * 1.9 + f32(robot) * 0.7;
  let feeling = Bend(
    -(1.0 + 0.35 * sin(ctx.absTime * 0.7 + own)) / NECK,
    (0.9 * sin(ctx.absTime * 1.1 + own * 1.3) + 0.7 * sin(ctx.absTime * 0.43 + own * 0.6)) / ARM,
  );
  let reaching = clamp(params.gesture, 0.0, 1.0) * (1.0 - swimming);
  let loose = Bend(mix(trailing.neck, feeling.neck, reaching), mix(trailing.arm, feeling.arm, reaching));

  // ── Holding: the one arc from socket to claw, bowing the way the socket faces ──
  let span = walking - root;
  let far = max(length(span), 1e-4);
  let chord = span / far;
  let deployed = min(LENGTH, far / sinc(BOW_LIMIT));
  let half = halfTurn(min(far / deployed, 1.0));
  // Which way the slack bows: ROUND THE BODY, each tentacle to the same hand, like the arms of a pinwheel.
  // A tentacle runs from its socket out to the wall and a little ahead or behind, so its chord lies in the
  // plane of "out" and "ahead"; "round" is at right angles to both, so the chord is never along it and the
  // bow turns only as slowly as the rung's place round the wall does. Two rules before this one flipped:
  // "the way the socket faces" snapped to the other side whenever the chord swung through that direction (a
  // metre of tentacle in one frame; the no-pop test caught it walking a corkscrew, 1.29 m however fine the
  // step), and "down, as slack hangs" whipped round for every tentacle reaching straight up.
  let hangs = cross(body.forward, radial);
  let lean = hangs - chord * dot(hangs, chord);
  let bow = select(toWake, normalize(lean), length(lean) > 1e-4);
  let holdLeave = chord * cos(half) + bow * sin(half);
  let holdPlane = chord * sin(half) - bow * cos(half);
  let holdBend = 2.0 * half / deployed;

  // Between the two the socket's direction, the plane and the curvatures all blend.
  let out = normalize(mix(leave, holdLeave, grab));
  let blended = mix(loosePlane, holdPlane, grab);
  let plane = normalize(blended - out * dot(blended, out));
  let bend = Bend(mix(loose.neck, holdBend, grab), mix(loose.arm, holdBend, grab));
  let run = mix(LENGTH, deployed, grab);

  // ── This joint's place along it ──
  let ring = station < RINGS;
  // Metres from the socket along what is deployed; under zero the joint is still stowed in the body.
  let d = select(HUB_DISTANCE, RING_START + f32(station) * RING_PITCH, ring) - (LENGTH - run);
  if (d < 0.0) {
    q.position = root;
    q.kind = -1.0;
    q.slip = 0.0;
    return q;
  }
  let here = along(bend, d);
  var at = root + out * here.x + plane * here.y;
  var tangent = out * cos(here.z) + plane * sin(here.z);
  var normal = plane * cos(here.z) - out * sin(here.z);
  // A tentacle that neither holds nor reaches trails: its place is the trail's, not an arc's.
  let loosely = (1.0 - grab) * (1.0 - reaching);
  if (loosely > 0.0) {
    let axis = pathFrame(frameZ);
    let off = body.origin - axis.origin;
    var trail: Trail;
    trail.z0 = frameZ + socket.z;
    trail.radius = max(length(socket.xy), 1e-3);
    trail.across = socket.xy / trail.radius;
    trail.right = body.right;
    trail.up = body.up;
    trail.offset = vec2f(dot(off, axis.right), dot(off, axis.up));
    trail.berth = offset.xy;
    // Swimming flings the ends wide at the top of the beat and draws them in after it (trailRadius).
    // In company the ends are held in and the stroke flings them less wide: they would lie across the next robot.
    trail.flare = (0.18 + 0.7 * params.flare) * mix(1.0, 0.3, clamp(params.company, 0.0, 1.0));
    trail.swim = swimming * mix(1.0, 0.25, clamp(params.company, 0.0, 1.0));
    trail.stroke = params.stroke;
    trail.adrift = adrift;
    trail.own = ownCount(offset);
    trail.wave = params.wave * 1.6 + 0.03;
    // Each robot of a pack squiggles on its own count, as far as Variety says (in unison they are one robot).
    trail.phase = f32(tentacle) * 1.7 + f32(robot) * 0.9 * params.variety;
    trail.time = ctx.absTime;
    let trailAt = root + trailShape(trail, d) - trailShape(trail, 0.0);
    let trailTangent = normalize(trailShape(trail, d + 0.04) - trailShape(trail, max(d - 0.04, 0.0)));
    let outward = body.right * trail.across.x + body.up * trail.across.y;
    at = mix(at, trailAt, loosely);
    tangent = normalize(mix(tangent, trailTangent, loosely));
    normal = mix(normal, outward, loosely);
    normal = normalize(normal - tangent * dot(normal, tangent));
  }
  // ── The strike: coiled by the face, thrown straight ahead, drawn back, each striker on its own count ──
  let striking = rearing * STRIKER[tentacle];
  var struck = 0.0;
  if (striking > 0.0) {
    let beat = ctx.absTime * 2.1 + f32(tentacle) * 1.9 + f32(robot) * 0.7 * params.variety;
    // Out fast, back slower: most of the count it is coiled.
    let thrust = pow(0.5 + 0.5 * sin(beat), 3.0);
    struck = thrust;
    let strikeOut = normalize(body.forward * 0.8 + radial * 0.6);
    let inward = normalize(-radial - strikeOut * dot(-radial, strikeOut));
    let coil = Bend(0.5 / NECK, mix(2.4, 0.2, thrust) / ARM);
    let there = along(coil, d);
    let strikeTangent = strikeOut * cos(there.z) + inward * sin(there.z);
    let strikeNormal = inward * cos(there.z) - strikeOut * sin(there.z);
    at = mix(at, root + strikeOut * there.x + inward * there.y, striking);
    tangent = normalize(mix(tangent, strikeTangent, striking));
    normal = mix(normal, strikeNormal, striking);
    normal = normalize(normal - tangent * dot(normal, tangent));
  }
  let binormal = cross(tangent, normal);
  // A wave runs root to tip; it dies at both ends, and a planted tentacle carries less of it.
  let planted = grab * (1.0 - aloft);
  let ripple = d * 3.0 - ctx.absTime * params.waveRate + f32(tentacle) * 1.7;
  at = at + (normal * cos(ripple) + binormal * sin(ripple)) * (params.wave * sin(3.14159265 * d / run) * (1.0 - 0.6 * planted));
  // The kit's joint frame and the curve family's: +Z the tangent, +Y the normal, +X = normal × tangent.
  let frame = quatFromFrame(-binormal, normal, tangent);
  // ── What runs along the cores ──
  // A pulse leaves the body and runs to the claw at 9 metres a second, a hand's width long, fading as it goes.
  let crest = d - 9.0 * params.pulse;
  var charge = exp(-crest * crest / 0.12) * exp(-params.pulse * 1.2);
  // A level meter: a bright head as far out as the level says, each tentacle reading a little differently, and a
  // faint trail back to the body. (Lit all the way it was the row of red dashes again.)
  let reading = clamp(params.meter, 0.0, 1.0) * (0.75 + 0.5 * chance(tentacle, 3u, seed)) * LENGTH;
  charge = charge + (1.0 - smoothstep(reading - 0.15, reading, d)) * (0.05 + 0.75 * smoothstep(reading - 0.45, reading, d)) * select(0.0, 1.0, params.meter > 0.001);
  // Bands running out, one band's spacing a beat.
  let band = 0.5 + 0.5 * cos(6.2831853 * (d / LENGTH * params.bands - params.chasePhase + f32(tentacle) * 0.1));
  charge = charge + params.chase * pow(band, 8.0);
  // Single cores flashing, a new draw fourteen times a second.
  charge = charge + params.spark * select(0.0, 1.0, chance(ctx.index, u32(ctx.absTime * 14.0), seed + 5u) > 0.93);
  q.charge = charge;
  q.along = clamp(d / LENGTH, 0.0, 1.0);
  // How far the claw's mouth is from where the gait wants it: zero while its rung is in reach.
  let mouth = along(bend, run);
  q.slip = grab * distance(root + out * mouth.x + plane * mouth.y, walking);

  if (ring) {
    q.position = at;
    q.orient = frame;
    q.kind = ${KIND.ring}.0;
    q.matte = 1.0;
    return q;
  }
  if (station == RINGS) {
    q.position = at;
    q.orient = frame;
    q.kind = ${KIND.hub}.0;
    return q;
  }
  // ── The claw: each phalanx on its carrier, turned about its hinge ──
  let which = station - RINGS - 1u;
  let knuckle = which - which % 2u;
  // A planted claw grips; one that holds nothing hangs open, shuts on Snap, and works idly while it feels about.
  let idle = clamp(params.snap + reaching * (0.5 + 0.5 * sin(ctx.absTime * 2.6 + own)) * 0.6, 0.0, 1.0);
  // A striking claw is open as it goes out and shuts at the end of the throw.
  let closed = max(mix(idle * (1.0 - grab), params.grip, planted), striking * smoothstep(0.7, 0.95, struck));
  let knuckleFrame = quatMul(quatMul(frame, quatAxisAngle(PHALANX_AXIS[knuckle], mix(PHALANX_RANGE[knuckle].x, PHALANX_RANGE[knuckle].y, closed))), PHALANX_REST[knuckle]);
  let knuckleAt = at + quatRotate(frame, PHALANX_JOINT[knuckle]);
  var jointFrame = knuckleFrame;
  var jointAt = knuckleAt;
  if (which % 2u == 1u) {
    jointFrame = quatMul(quatMul(knuckleFrame, quatAxisAngle(PHALANX_AXIS[which], mix(PHALANX_RANGE[which].x, PHALANX_RANGE[which].y, closed))), PHALANX_REST[which]);
    jointAt = knuckleAt + quatRotate(knuckleFrame, PHALANX_JOINT[which]);
  }
  q.position = jointAt;
  q.orient = jointFrame;
  q.kind = ${KIND.phalanx}.0 + f32(which);
  return q;
}`;
}
