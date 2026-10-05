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
 * effectors), and it is why the rig costs 630 evaluations a frame however dense the ring
 * mesh is. Every point is the JOINT itself, in the kit's joint frame (+Z toward the tip, +Y the
 * frame's normal: the curve family's convention, docs/curve-family-design-2026-10-05.md R5), which
 * is where an instanced ring, hub or phalanx has its origin. Until a mesh can be instanced
 * (§T1581b) the joints are drawn as boxes centred on them.
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

/** Joints of ONE robot; a rig of several holds them robot after robot. */
export function jointCount(facts: KitFacts): number {
  return facts.sockets.length * stationsPerTentacle(facts);
}

/** Metres between the rungs a claw may plant on; divides the path's period, so the wrap lands on one. Every fourth is a rib of the tunnel (tunnel.ts). */
export const RUNG_SPACING = 0.4;
/** How far past its joint the hub's cone reaches: the curve ends at the claw's mouth, not its wrist. */
const CLAW_REACH = 0.19;

export const JOINT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
  // rgb, and the joint's size in w (the box stand-in's edge, as a multiple of the draw's Scale).
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  // 0 ring, 1 hub, 2 phalanx: what a draw's Group picks its joints by.
  { name: "kind", type: "f32", default: [0] },
  // Metres between the claw's mouth and where the gait wants it; zero while its rung is in reach.
  { name: "slip", type: "f32", default: [0] },
]);

/** Every mesh attribute, so the body's material data rides through the kernel that places it. */
export const BODY_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
  { name: "uv", type: "vec2f", default: [0, 0] },
  { name: "color", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "surface", type: "vec4f", default: [1, 0, 0, 0] },
  { name: "emissive", type: "vec3f", qualifier: "color", default: [0, 0, 0] },
]);

/** The knobs that say where the robot is. Both kernels declare them first, under these names. */
const PLACE_PARAMS = `  travel: f32, // @default 0  Distance travelled along the tunnel, metres.
  offset: vec3f, // @default 0  The robot's place off the tunnel's axis: right, up, ahead (metres).
  roll: f32, // @default 0  Roll about its own heading, radians.
  look: vec2f, // @default 0  Where the head turns, radians: x to its right, y up. A perched robot scans with it.
  swim: f32, // @default 0  Let go of the wall and beat the tentacles together like a squid: 0 walking, 1 swimming. A chamber makes it swim whatever this says.
  stroke: f32, // @default 0  Where the beat is, 0 to 1: flung open at 0, snapped shut by a quarter, drifting open again.`;

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

// The robot's own frame: on the tunnel's frame at its distance, facing a little way ahead so it
// turns into a bend before it reaches it, banking into the bend, and never hanging dead still.
fn robotFrame(z: f32, offset: vec3f, roll: f32, look: vec2f, time: f32) -> Frame {
  let tunnel = pathFrame(z);
  var frame: Frame;
  let drift = vec2f(sin(time * 0.9 + offset.z), sin(time * 1.3 + offset.z * 1.7)) * 0.05;
  frame.origin = tunnel.origin + tunnel.right * (offset.x + drift.x) + tunnel.up * (offset.y + drift.y);
  frame.forward = pathTangent(z + 1.2);
  let right = normalize(cross(vec3f(0.0, 1.0, 0.0), frame.forward));
  let up = cross(frame.forward, right);
  // How fast the heading swings, measured a couple of metres either side: the inside of the turn drops.
  let bank = roll - 1.5 * (pathTangent(z + 2.0).x - pathTangent(z - 2.0).x);
  let banked = right * cos(bank) + up * sin(bank);
  let crown = up * cos(bank) - right * sin(bank);
  // The head turns: about its own up, then about its own right.
  let ahead = frame.forward * cos(look.x) + banked * sin(look.x);
  frame.right = banked * cos(look.x) - frame.forward * sin(look.x);
  frame.forward = ahead * cos(look.y) + crown * sin(look.y);
  frame.up = crown * cos(look.y) - ahead * sin(look.y);
  return frame;
}
`;

/** The body, eyes and front arms ride the robot frame rigidly. */
export const BODY_KERNEL = `// T1561b — the sentinel's body: the kit's robot frame, set down in the tunnel.
struct Params {
${PLACE_PARAMS}
};
${ROBOT_FRAME}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let frame = robotFrame(robotZ(ctx.params.travel, ctx.params.offset, ctx.params.swim, ctx.params.stroke), ctx.params.offset, ctx.params.roll, ctx.params.look, ctx.absTime);
  q.position = frame.origin + frame.right * p.position.x + frame.up * p.position.y + frame.forward * p.position.z;
  q.normal = normalize(frame.right * p.normal.x + frame.up * p.normal.y + frame.forward * p.normal.z);
  return q;
}`;

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
 * when it can read a second pointset (§T1582b) the robots become points and this a lookup.
 */
export function jointKernel(facts: KitFacts, robots: readonly Vec3[] = [[0, 0, 0]]): string {
  if (robots.length === 0) throw new Error("jointKernel: a rig needs at least one robot.");
  const tentacles = facts.sockets.length;
  const stations = stationsPerTentacle(facts);
  const { angle, rank } = wallAngles(facts);
  // Alternate neighbours step half a cycle apart; a little extra per tentacle keeps any two from landing together.
  const phase = rank.map((place) => (place % 2) * 0.5 + ((place * 0.37) % 1) * 0.16);
  // As Crawl rises the tentacles take to the wall opposite pairs first, so the body is always held from two sides.
  const engage = rank.map((place) => ((place * (tentacles / 2 + 1)) % tentacles + tentacles) % tentacles);
  const length = facts.hubDistance + CLAW_REACH;
  const rungs = Math.round(PATH.period / RUNG_SPACING);
  if (Math.abs(rungs * RUNG_SPACING - PATH.period) > 1e-6) throw new Error(`jointKernel: the rung spacing ${RUNG_SPACING} m does not divide the path's ${PATH.period} m period.`);
  const list = (values: readonly number[]): string => values.map((value) => value.toFixed(5)).join(", ");
  const phalanges = facts.phalanges.length;
  return `// T1561b — the sentinel's joints (generated by src/projects/sentinel-bot/rig.ts from the kit).
struct Params {
${PLACE_PARAMS}
  crawl: f32, // @default 1  How many of the tentacles walk the wall: 0 none (all trail behind), 1 every one.
  stride: f32, // @default 3.2  Metres the body travels per step of a tentacle.
  duty: f32, // @default 0.7  Share of a step the claw stays planted.
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
};
${ROBOT_FRAME}
const ROBOTS: u32 = ${robots.length}u;
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
// The claw, from the kit: each phalanx's joint on its carrier, its rest orientation there, its hinge and the range the reference performance turns it through.
const PHALANX_JOINT = array<vec3f, ${phalanges}>(${facts.phalanges.map((phalanx) => wgslVec3(phalanx.joint)).join(", ")});
const PHALANX_REST = array<vec4f, ${phalanges}>(${facts.phalanges.map((phalanx) => wgslVec4(phalanx.rest)).join(", ")});
const PHALANX_AXIS = array<vec3f, ${phalanges}>(${facts.phalanges.map((phalanx) => wgslVec3(phalanx.axis)).join(", ")});
const PHALANX_RANGE = array<vec2f, ${phalanges}>(${facts.phalanges.map((phalanx) => `vec2f(${phalanx.range[0].toFixed(5)}, ${phalanx.range[1].toFixed(5)})`).join(", ")});

fn axisAngle(axis: vec3f, angle: f32) -> vec4f {
  return vec4f(normalize(axis) * sin(angle * 0.5), cos(angle * 0.5));
}

// Hamilton product (a ⊗ b): b first, then a — the draw's active, right-handed convention.
fn qmul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

// The rotation whose columns are x, y, z (an orthonormal, right-handed frame).
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

// Where tentacle t plants on step number step: a rung ahead of where the body was when it let go.
fn plant(tentacle: u32, step: f32, stride: f32, bodyZ: f32, own: f32, seed: u32, params: Params) -> vec3f {
  let steps = round(PATH_PERIOD / stride);
  let wrapped = u32(step - floor(step / steps) * steps + 0.5);
  var z = (step - STEP_PHASE[tentacle] - own) * stride + params.lead + (chance(tentacle, wrapped, seed) - 0.5) * 0.4;
  z = round(z / RUNG) * RUNG;
  // The same rung from whichever side of the path's wrap the body is on.
  z = z - round((z - bodyZ) / PATH_PERIOD) * PATH_PERIOD;
  let theta = WALL_ANGLE[tentacle] + (chance(tentacle, wrapped, seed + 1u) - 0.5) * 0.45;
  let wall = pathFrame(z);
  // A hall's wall stands further off; the rung is on it all the same (whether the claw can reach it is the gait's business).
  return wall.origin + (wall.right * cos(theta) + wall.up * sin(theta)) * (params.bore * (1.0 + CHAMBER_SWELL * chamberAt(z)));
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let robot = ctx.index / (TENTACLES * STATIONS);
  if (robot >= ROBOTS) {
    q.kind = -1.0;
    return q;
  }
  let tentacle = (ctx.index / STATIONS) % TENTACLES;
  let station = ctx.index % STATIONS;
  let params = ctx.params;
  let offset = params.offset + ROBOT_OFFSET[robot];
  let swimming = swimAt(params.swim, params.travel + offset.z);
  let bodyZ = robotZ(params.travel, offset, params.swim, params.stroke);
  let body = robotFrame(bodyZ, offset, params.roll, params.look, ctx.absTime);
  let socket = SOCKET[tentacle];
  let root = body.origin + body.right * socket.x + body.up * socket.y + body.forward * socket.z;
  let radial = normalize(body.right * socket.x + body.up * socket.y);

  // ── Walking: stance on one rib, then a swing to the next ──
  let stride = PATH_PERIOD / round(PATH_PERIOD / max(params.stride, 0.5));
  let count = f32(robot) * 0.37 * params.variety;
  let cycle = bodyZ / stride + STEP_PHASE[tentacle] + count;
  let step = floor(cycle);
  let swing = smoothstep(0.0, 1.0, clamp((cycle - step - params.duty) / max(1.0 - params.duty, 1e-3), 0.0, 1.0));
  // A pack in unison plants on the same ribs; with variety each robot draws its own.
  let seed = 1u + u32(f32(robot) * params.variety + 0.5) * 16u;
  let rib = plant(tentacle, step, stride, bodyZ, count, seed, params);
  let next = plant(tentacle, step + 1.0, stride, bodyZ, count, seed, params);
  var walking = mix(rib, next, swing);
  let aloft = sin(swing * 3.14159265);
  walking = mix(walking, pathAt(walking.z), params.lift * aloft);

  let grab = smoothstep(0.0, 1.0, clamp(params.crawl * f32(TENTACLES) - ENGAGE[tentacle], 0.0, 1.0)) * (1.0 - swimming);
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
  let lean = leave - chord * dot(leave, chord);
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
  let tangent = out * cos(here.z) + plane * sin(here.z);
  let normal = plane * cos(here.z) - out * sin(here.z);
  let binormal = cross(tangent, normal);
  // A wave runs root to tip; it dies at both ends, and a planted tentacle carries less of it.
  let planted = grab * (1.0 - aloft);
  let ripple = d * 3.0 - ctx.absTime * params.waveRate + f32(tentacle) * 1.7;
  at = at + (normal * cos(ripple) + binormal * sin(ripple)) * (params.wave * sin(3.14159265 * d / run) * (1.0 - 0.6 * planted));
  // The kit's joint frame and the curve family's: +Z the tangent, +Y the normal, +X = normal × tangent.
  let frame = quatFromFrame(-binormal, normal, tangent);
  // How far the claw's mouth is from where the gait wants it: zero while its rung is in reach.
  let mouth = along(bend, run);
  q.slip = grab * distance(root + out * mouth.x + plane * mouth.y, walking);

  let shade = 0.5 + 0.5 * chance(tentacle, 7u, 3u);
  if (ring) {
    q.position = at;
    q.orient = frame;
    q.tint = vec4f(vec3f(0.5, 0.52, 0.56) * shade, 1.0);
    q.kind = 0.0;
    return q;
  }
  if (station == RINGS) {
    q.position = at;
    q.orient = frame;
    q.tint = vec4f(0.6, 0.62, 0.66, 2.0);
    q.kind = 1.0;
    return q;
  }
  // ── The claw: each phalanx on its carrier, turned about its hinge ──
  let which = station - RINGS - 1u;
  let knuckle = which - which % 2u;
  // A planted claw grips; one that holds nothing hangs open, shuts on Snap, and works idly while it feels about.
  let idle = clamp(params.snap + reaching * (0.5 + 0.5 * sin(ctx.absTime * 2.6 + own)) * 0.6, 0.0, 1.0);
  let closed = mix(idle * (1.0 - grab), params.grip, planted);
  let knuckleFrame = qmul(qmul(frame, axisAngle(PHALANX_AXIS[knuckle], mix(PHALANX_RANGE[knuckle].x, PHALANX_RANGE[knuckle].y, closed))), PHALANX_REST[knuckle]);
  let knuckleAt = at + qrot(frame, PHALANX_JOINT[knuckle]);
  var jointFrame = knuckleFrame;
  var jointAt = knuckleAt;
  if (which % 2u == 1u) {
    jointFrame = qmul(qmul(knuckleFrame, axisAngle(PHALANX_AXIS[which], mix(PHALANX_RANGE[which].x, PHALANX_RANGE[which].y, closed))), PHALANX_REST[which]);
    jointAt = knuckleAt + qrot(knuckleFrame, PHALANX_JOINT[which]);
  }
  q.position = jointAt;
  q.orient = jointFrame;
  q.tint = vec4f(0.8, 0.82, 0.86, 0.7);
  q.kind = 2.0;
  return q;
}`;
}
