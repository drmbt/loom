/**
 * T1561b — THE ROBOTS' SEARCHLIGHTS: a white beam from the front of each, now and then.
 *
 * The owner, 2026-10-06, of the robots out in the fields: "Maybe we need to have white lights on the front, like
 * searchlights every once in a while". Out of the tunnel a robot is black steel in a great dark, seen by its own
 * small lights; a beam says where it is, which way it is looking, and how far off the next thing is.
 *
 * Each beam is a cone of lit air (a strip a Sweep makes a cone of, drawn as light: the dock's own material for
 * its searchlights) and a Spot along it. Where a robot's face is and what it looks toward are the document's
 * (the same expressions its other lights ride), handed in as two points a robot; `level` is how bright each is,
 * 0 for one that is not out or not searching.
 */
export const SEARCH = {
  /** Robots that can carry one: the pack. */
  robots: 3,
  /** Points along a cone, and how long it is, metres. */
  points: 8,
  length: 34,
} as const;

export const SEARCH_CAPACITY = SEARCH.robots * SEARCH.points;

const f = (value: number): string => value.toFixed(5);
const each = (line: (robot: number) => string): string => Array.from({ length: SEARCH.robots }, (_, robot) => line(robot)).join("\n");

/** The parameters that say where robot `robot`'s face is, what it looks toward, and how bright its beam is. */
export const searchParameters = (robot: number): { face: string; toward: string; level: string } => ({ face: `face${robot}`, toward: `toward${robot}`, level: `level${robot}` });

const SEARCH_PARAMS_WGSL = each((robot) => `  ${searchParameters(robot).face}: vec3f, // @default [0, 0, ${robot * -5.5}]  Where robot ${robot}'s face is.
  ${searchParameters(robot).toward}: vec3f, // @default [0, 0, ${robot * -5.5 + 30}]  A point it looks toward.
  ${searchParameters(robot).level}: f32, // @default 0  How bright its beam is, 0 to 1.`);

const SEARCH_WGSL = `struct Search {
  foot: vec3f,
  along: vec3f,
  level: f32,
};
fn searchOf(robot: u32, p: Params) -> Search {
  var s: Search;
${each((robot) => `  if (robot == ${robot}u) { s.foot = p.${searchParameters(robot).face}; s.along = p.${searchParameters(robot).toward} - p.${searchParameters(robot).face}; s.level = p.${searchParameters(robot).level}; }`)}
  s.along = normalize(s.along + vec3f(0.0, 0.0, 1e-5));
  return s;
}
`;

/** The cones: `points` points along each robot's. A robot that is not searching has one point of no radius. */
export const SEARCH_KERNEL = `// T1561b — the robots' searchlights, as cones of lit air (src/projects/sentinel-bot/searchlight.ts).
struct Params {
${SEARCH_PARAMS_WGSL}
};
${SEARCH_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let beam = searchOf(ctx.index / ${SEARCH.points}u, ctx.params);
  let along = f32(ctx.index % ${SEARCH.points}u) / ${f(SEARCH.points - 1)};
  if (beam.level < 0.01) {
    q.position = vec3f(beam.foot.x, -4000.0, beam.foot.z);
    q.girth = 0.0;
    q.tint = vec4f(0.0);
    return q;
  }
  q.position = beam.foot + beam.along * (along * ${f(SEARCH.length)});
  // A lens at the face, opening to two and a half metres across at the far end.
  q.girth = 0.1 + 1.15 * along;
  q.tint = vec4f(beam.level, 0.0, 0.0, along);
  return q;
}`;

/** One point a robot: where its Spot stands (at its face), which way it shines, how strong. */
export const SEARCH_LIGHT_KERNEL = `// T1561b — the robots' searchlights, as lights (src/projects/sentinel-bot/searchlight.ts).
struct Params {
${SEARCH_PARAMS_WGSL}
  power: f32, // @default 110  A searchlight's intensity at full.
};
${SEARCH_WGSL}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let beam = searchOf(ctx.index, ctx.params);
  q.position = beam.foot;
  q.tint = vec4f(0.82, 0.9, 1.0, 1.0);
  q.power = ctx.params.power * beam.level;
  q.aim = beam.along;
  return q;
}`;
