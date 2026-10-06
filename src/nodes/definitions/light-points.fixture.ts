import type { GraphDocument } from "../../domain/types/graph.ts";

/**
 * T1589b — the scenes the pointset-light tests share (no GPU here; `light-points.test.ts`
 * reads their plans and `light-points.gpu.test.ts` their pictures, so the two cannot be
 * talking about different scenes).
 *
 * A floor on y = 0, sixteen units square, in the default material (lambert, albedo 0.8),
 * seen by a camera straight above it; and LAMPS, a Light in Points mode over a small Point
 * Kernel that says where each stands and what it carries. The Render has no ambient, so a
 * pixel no lamp reaches is exactly black and a pixel one lamp reaches is that lamp alone.
 */

type Parameters = Record<string, unknown>;

/** A parameter in Map mode: the attribute, and the static value it retains. */
export const mapped = (attribute: string, retained: unknown, channel?: string): unknown => ({
  mode: "map",
  bindings: { static: { kind: "static", value: retained }, map: { kind: "map", attribute, ...(channel === undefined ? {} : { channel }) } },
});

/** The lamps' height over the floor, their range, and the Light's own intensity. */
export const LAMP_HEIGHT = 2;
export const LAMP_RANGE = 3;
export const LAMP_INTENSITY = 2;
/** The floor's albedo: the default material's. */
export const FLOOR_ALBEDO = 0.8;

/** The camera straight above the floor: sixteen units of it in the frame's height. */
export const TOP_CAMERA: Parameters = { eye: [0, 10, 0], lookAt: [0, 0, 0], ortho: true, orthoHeight: 16, near: 0.1, far: 40 };

/** What a lamps kernel may write besides `position`. */
export const LAMP_ATTRIBUTES = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "color", type: "vec4f", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "gain", type: "f32", default: [1] },
  { name: "reach", type: "f32", default: [1] },
  { name: "place", type: "vec3f", default: [0, 0, 0] },
  { name: "pair", type: "vec2f", default: [0, 0] },
];

/**
 * Three lamps in a row along x, four units apart: red, green, blue. Each stands over the
 * CENTRE of a pixel of a 128-pixel frame under `TOP_CAMERA` (eight pixels a unit), so the
 * pixel under it is lit from straight above. `gain` is a half, `reach` one and a half and
 * `place` the same row turned to run along z: what the map tests read.
 */
export const THREE_LAMPS = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let along = (f32(ctx.index) - 1.0) * 4.0 + 0.0625;
  q.position = vec3f(along, ${LAMP_HEIGHT}.0, 0.0625);
  q.color = vec4f(f32(ctx.index == 0u), f32(ctx.index == 1u), f32(ctx.index == 2u), 1.0);
  q.gain = 0.5;
  q.reach = 1.5;
  q.place = vec3f(0.0625, ${LAMP_HEIGHT}.0, along);
  q.pair = vec2f(0.25, 0.5);
  return q;
}`;
/** Where the three stand along their row. */
export const THREE_LAMPS_AT = [-3.9375, 0.0625, 4.0625] as const;

/**
 * Many lamps scattered over and above the floor, in every colour, with ranges that differ:
 * `count` of them from one kernel. Some hang below the floor and some far outside the frame,
 * so a grid has lights to leave out of every kind.
 */
export const SCATTERED_LAMPS = `fn hash(n: f32) -> f32 {
  return fract(sin(n * 12.9898 + 4.1414) * 43758.5453);
}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = f32(ctx.index);
  q.position = vec3f((hash(i) - 0.5) * 22.0, hash(i + 0.37) * 5.0 - 0.5, (hash(i + 0.71) - 0.5) * 22.0);
  q.color = vec4f(0.3 + 0.7 * hash(i + 1.3), 0.3 + 0.7 * hash(i + 2.9), 0.3 + 0.7 * hash(i + 4.1), 1.0);
  q.gain = 0.4 + hash(i + 5.7);
  q.reach = 0.4 + 1.6 * hash(i + 8.3);
  q.place = q.position;
  q.pair = vec2f(0.0);
  return q;
}`;

const FLAT = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x, 0.0, p.position.y);
  return q;
}`;
/** A wall standing across the back of the floor, so a perspective view has depth to cut into slices. */
const UPRIGHT = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x, p.position.y + 4.0, -6.0);
  return q;
}`;
const POSITION_ONLY = JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]);

export interface LampsScene {
  /** How many lamps the kernel holds (its capacity). */
  readonly count?: number;
  /** The lamps' kernel. */
  readonly kernel?: string;
  /** A Point Kernel · Advanced (a COUNTED pointset) instead of a Point Kernel. */
  readonly counted?: boolean;
  /** Parameters over the kernel's own (reflected `Params`, a driven value). */
  readonly kernelParameters?: Parameters;
  /** Parameters over the Light's. */
  readonly light?: Parameters;
  /** Leave Points unwired. */
  readonly unwired?: boolean;
  /** The Render's Lights. Default: the lamps alone. */
  readonly lights?: string;
  /** More nodes (other Lights, other geometry) and the wires they need. */
  readonly nodes?: ReadonlyArray<{ readonly id: string; readonly type: string; readonly parameters: Parameters }>;
  readonly edges?: ReadonlyArray<readonly [from: string, to: string, port: string]>;
  /** The Render's Scenes. Default: the floor alone (`geometry_wall` exists and may be named). */
  readonly scenes?: string;
  readonly camera?: Parameters;
  readonly render?: Parameters;
  /** The floor's own parameters (a material, a blend). */
  readonly floor?: Parameters;
}

const node = (id: string, type: string, parameters: Parameters) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id });
const edge = (from: string, to: string, port: string) => ({ id: `e_${from}_${to}_${port}`, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });

export function lampsScene(options: LampsScene = {}): GraphDocument {
  const count = options.count ?? 3;
  const nodes = [
    node("grid_floor", "pointGrid", { cols: 33, rows: 33, count: 33 * 33, sizeX: 16, sizeY: 16 }),
    node("kernel_floor", "pointKernel", { capacity: 33 * 33, attributes: POSITION_ONLY, kernel: FLAT }),
    node("geometry_floor", "geometry", { mode: "surface", ...options.floor }),
    node("grid_wall", "pointGrid", { cols: 17, rows: 9, count: 17 * 9, sizeX: 16, sizeY: 8 }),
    node("kernel_wall", "pointKernel", { capacity: 17 * 9, attributes: POSITION_ONLY, kernel: UPRIGHT }),
    node("geometry_wall", "geometry", { mode: "surface" }),
    options.counted === true
      ? node("kernel_lamps", "pointKernelAdvanced", { capacity: count, seed: 1, kernel: options.kernel ?? THREE_LAMPS, ...options.kernelParameters })
      : node("kernel_lamps", "pointKernel", { capacity: count, attributes: JSON.stringify(LAMP_ATTRIBUTES), kernel: options.kernel ?? THREE_LAMPS, ...options.kernelParameters }),
    node("light_lamps", "light", { mode: "points", kind: "point", falloff: "inverseSquare", intensity: LAMP_INTENSITY, range: LAMP_RANGE, ...options.light }),
    node("camera_shot", "camera", { ...TOP_CAMERA, ...options.camera }),
    node("render_shot", "render", {
      scenes: options.scenes ?? "geometry_floor",
      camera: "camera_shot",
      lights: options.lights ?? "light_lamps",
      ambientColor: [1, 1, 1, 1],
      ambientIntensity: 0,
      background: [0, 0, 0, 1],
      ...options.render,
    }),
    node("output_frame", "output", {}),
    ...(options.nodes ?? []).map((entry) => node(entry.id, entry.type, entry.parameters)),
  ];
  const edges = [
    edge("grid_floor", "kernel_floor", "in"),
    edge("kernel_floor", "geometry_floor", "points"),
    edge("grid_wall", "kernel_wall", "in"),
    edge("kernel_wall", "geometry_wall", "points"),
    ...(options.unwired === true ? [] : [edge("kernel_lamps", "light_lamps", "points")]),
    edge("render_shot", "output_frame", "input"),
    ...(options.edges ?? []).map(([from, to, port]) => edge(from, to, port)),
  ];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

/**
 * What one lamp of the Light gives the floor, by the Render's own arithmetic: albedo × colour
 * × intensity × the inverse-square falloff at its distance × the range window
 * `(1 − (d/range)⁴)²` × the lambert of a floor facing up. Straight under the lamp unless
 * `aside` says how far along the floor.
 */
export function lampOnFloor(intensity: number = LAMP_INTENSITY, range: number = LAMP_RANGE, height: number = LAMP_HEIGHT, aside: number = 0): number {
  const distance = Math.hypot(height, aside);
  const window = range > 0 ? Math.max(0, 1 - (distance / range) ** 4) ** 2 : 1;
  return (FLOOR_ALBEDO * intensity * window * (height / distance)) / (distance * distance);
}
