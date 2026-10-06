/**
 * T1561b — THE ROBOTS' SEARCHLIGHTS: a white beam from the front of each, now and then.
 *
 * The owner, 2026-10-06, of the robots out in the fields: "Maybe we need to have white lights on the front, like
 * searchlights every once in a while". Out of the tunnel a robot is black steel in a great dark, seen by its own
 * small lights; a beam says where it is, which way it is looking, and how far off the next thing is.
 *
 * Each beam is a cone of lit air (a strip a Sweep makes a cone of, drawn as light: the dock's own material for
 * its searchlights) and a Spot along it.
 *
 * ONE SOURCE (the owner, 2026-10-06: "the front spot light … is detached from the body … the body sway and what
 * not is not translated to the spot light and thus it suddenly floats", and "it should look around with the face
 * of the robot rather than look around detached"). A beam was handed its two ends by the document, as expressions
 * that said again where a robot is, and swung on a sine of its own: whatever the rig did to the body that the
 * expressions did not repeat (its weave, its bank, the head's turn, its rearing) stood the beam off the face.
 * Now both kernels are PROCESSORS over the rig's own points (rig.ts): the Spot over the hull's point, which is
 * where the body is drawn and how it is turned, and the cone over the rig's points along the body's nose (rig.ts,
 * AxisPick). The beam is at the face because it is the face's frame, and looking about is the head's turn.
 * What is handed in is only how bright each robot's is: 0 for one that is not searching.
 */
export const SEARCH = {
  /** Robots that can carry one: the pack. */
  robots: 3,
  /** Points along a cone, and how long it is, metres. */
  points: 8,
  length: 34,
} as const;

const each = (line: (robot: number) => string): string => Array.from({ length: SEARCH.robots }, (_, robot) => line(robot)).join("\n");

/** The parameter that says how bright robot `robot`'s beam is. */
export const searchLevel = (robot: number): string => `level${robot}`;

const SEARCH_PARAMS_WGSL = each((robot) => `  ${searchLevel(robot)}: f32, // @default 0  How bright robot ${robot}'s beam is, 0 to 1.`);

const SEARCH_WGSL = `// How bright a robot's beam is: what it is told, and nothing for a robot that is not out (the rig's kind).
fn searchLevelOf(robot: u32, kind: f32, p: Params) -> f32 {
  var level = 0.0;
${each((robot) => `  if (robot == ${robot}u) { level = p.${searchLevel(robot)}; }`)}
  return level * step(-0.5, kind);
}
`;

const RIG_POINT = [
  // What the rig says of the point (rig.ts, JOINT_ATTRIBUTES): what it is (-1 for a robot that is not out)…
  { name: "kind", type: "f32", default: [-1] },
];
/** The cone's points: a strip's, and of the rig's what a beam reads (how far along the nose a point is). */
export const SEARCH_STRIP_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "girth", type: "f32", default: [0] },
  // r how bright, a how far along the beam (0 to 1): what the dock's beam material reads.
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
  ...RIG_POINT,
  { name: "along", type: "f32", default: [0] },
]);
/** The Spots' points, for a Light in Points mode, and of the rig's what a Spot reads (how the body is turned). */
export const SEARCH_LIGHT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 1] },
  { name: "power", type: "f32", default: [0] },
  { name: "aim", type: "vec3f", default: [0, 0, 1] },
  ...RIG_POINT,
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
]);

/**
 * The cones. POINTS IN: the rig's points along each robot's nose (an AxisPick of SEARCH.points, from the face to
 * SEARCH.length beyond it). A robot that is not searching has its points parked, of no radius.
 */
export const SEARCH_KERNEL = `// T1561b — the robots' searchlights, as cones of lit air (src/projects/sentinel-bot/searchlight.ts).
// Points In: the rig's points along each robot's nose. Where a beam is and which way it goes is theirs.
struct Params {
${SEARCH_PARAMS_WGSL}
};
${SEARCH_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let level = searchLevelOf(ctx.index / ${SEARCH.points}u, p.kind, ctx.params);
  if (level < 0.01) {
    q.position = vec3f(p.position.x, -4000.0, p.position.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  // A lens at the face, opening to two and a half metres across at the far end.
  q.girth = 0.1 + 1.15 * p.along;
  q.tint = vec4f(level, 0.0, 0.0, p.along);
  return q;
}`;

/**
 * One point a robot: where its Spot stands (at its face), which way it shines, how strong. POINTS IN: the hull's
 * points, one a robot (the rig's body pick): where the body is drawn and how it is turned.
 */
export const SEARCH_LIGHT_KERNEL = `// T1561b — the robots' searchlights, as lights (src/projects/sentinel-bot/searchlight.ts).
// Points In: the hull's points, one a robot. A Spot stands at that body's face and shines the way it faces.
struct Params {
${SEARCH_PARAMS_WGSL}
  face: f32, // @default 0.65  How far ahead of its body's middle a robot's face is, metres.
  power: f32, // @default 110  A searchlight's intensity at full.
};
${SEARCH_WGSL}
// A vector of the body's own frame (+Z forward, +Y up), in the world: turned by the body's quaternion (x y z w).
fn turned(by: vec4f, v: vec3f) -> vec3f {
  return v + 2.0 * cross(by.xyz, cross(by.xyz, v) + by.w * v);
}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let forward = turned(p.orient, vec3f(0.0, 0.0, 1.0));
  q.position = p.position + forward * ctx.params.face;
  q.tint = vec4f(0.82, 0.9, 1.0, 1.0);
  q.power = ctx.params.power * searchLevelOf(ctx.index, p.kind, ctx.params);
  q.aim = forward;
  return q;
}`;
