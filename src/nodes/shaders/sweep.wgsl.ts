import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import type { SweepProfile, SweepUvAlong } from "../../points/sweep.ts";

/**
 * T1587b — Sweep: ONE THREAD PER VERTEX of the swept grid.
 *
 * A vertex works out its row and column from its slot, reads its path point (position,
 * frame, and whatever is mapped or carried) and its profile point, turns the profile point
 * by the frame's quaternion and writes itself. Nothing about a vertex depends on another,
 * so there is no walk and no scan here: one dispatch, whatever the path's length. The frame
 * and the distances were measured before this node, by Curve Frames.
 *
 * This file is `src/points/sweep.ts`'s `sweepStrip` in WGSL, rule for rule, and the Dawn
 * tests hold the two together. Three things it keeps exact, because the tests assert
 * equality on them (§V147):
 *
 *  - under the identity frame a vertex is `path point + profile point × radius`, with
 *    nothing added by the rotation (`qrot` adds a cross product of zero), so a Ring along
 *    +Z is the Tube generator's points to the bit;
 *  - a Square's corners are ±1 and its sides' normals come out as exact axes;
 *  - a cap's centre IS the path point: it is copied, never computed as a radius of zero.
 *
 * The path's attributes are read out of their producers' packed buffers by offset (T1076),
 * one binding per producer. A path that has been through a Resample, a kernel and a Curve
 * Frames is three producers; a custom profile is one more.
 *
 * ⚑ SEVERAL STRIPS ARE SEVERAL SHEETS (slice 2). Each strip of the path is swept into a
 * sheet of its own, one after another in the buffer: slot `(strip × rows + row) × cols +
 * column`, which is the grid claim's own order. It is a BRANCH in this one emitter, taken
 * only for a path of more than one strip: with one, the text is the one that shipped, to the
 * byte, because two programs can round one expression differently and a Ring along a
 * straight path is the Tube generator's points to the bit (`point-sweep.test.ts` pins it).
 *
 * ## What it costs, measured
 *
 * Dawn/Metal, best of 9 runs of 200 frames, over the same graph without the node, a Ring,
 * ms a frame. What a vertex is written from decides it: its own position, normal and uv are
 * 40 bytes, and every attribute the path carries is copied to it on top.
 *
 *   vertices     sides × rings     path with a frame     with Curve Frames'     and a colour and a
 *                                  only (40 bytes)       metrics (56 bytes)     width (76 bytes)
 *   199,936      64 × 3,124        0.02                  0.04                   0.06
 *   999,936      256 × 3,906       0.22                  0.36                   0.46
 *
 * Flat sides, a mapped radius and the coordinate along make no difference the measurement
 * resolves: runs of one graph differ by 0.05 ms. So a sweep is a plain kernel pass over as
 * many points, and the way to make a long tube cheaper is to carry less along it.
 */

/** Where an attribute the sweep reads lives: a bound buffer and a word offset in it. */
export interface SweepRegion {
  readonly group: number;
  readonly word: number;
}

/** One attribute copied from a path point to every vertex of its ring. */
export interface SweepCarriedAttribute {
  readonly group: number;
  readonly inWord: number;
  readonly outWord: number;
  /** Words between consecutive points (a vec3f strides four). */
  readonly strideWords: number;
  /** Components actually stored. */
  readonly components: number;
}

export interface SweepShaderOptions {
  readonly profile: SweepProfile;
  /** Every side flat: two columns a side. */
  readonly flat: boolean;
  readonly profileClosed: boolean;
  readonly inward: boolean;
  readonly pathClosed: boolean;
  /** Whether either end has a cap: only then does a row's centre need its radius for `uv`. */
  readonly capped: boolean;
  /** The path is several strips: each is a sheet of its own, and the uniform block has `sheets`. */
  readonly sheets: boolean;
  readonly uvAlong: SweepUvAlong;
  /** The uniform block's members, in order: the node builds its uniform record from the same list. */
  readonly members: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  /** How many upstream buffers are bound (`pk_0` …). */
  readonly groups: number;
  readonly position: SweepRegion;
  readonly orient: SweepRegion;
  /** The attribute that multiplies the radius, and which component of it. */
  readonly radius?: SweepRegion & { readonly strideWords: number; readonly component: number };
  /** Curve Frames' metrics, each present only where the coordinate along reads it. */
  readonly distance?: SweepRegion;
  readonly curveU?: SweepRegion;
  readonly curveLength?: SweepRegion;
  /** Custom: the profile strip's position region. */
  readonly outline?: SweepRegion;
  readonly carried: ReadonlyArray<SweepCarriedAttribute>;
  /** Word offsets of the three attributes the sweep makes, in its own buffer. */
  readonly out: { readonly position: number; readonly normal: number; readonly uv: number };
}

const scalar = (name: string, region: SweepRegion, strideWords = 1, component = 0): string =>
  `fn ${name}(point: u32) -> f32 {
  return bitcast<f32>(pk_${region.group}[${region.word}u + point * ${strideWords}u + ${component}u]);
}`;

/** Point `k` of the outline, in the profile's plane, before the radius. */
function outlineWgsl(options: SweepShaderOptions): string {
  switch (options.profile) {
    case "ring":
      return `fn outlinePoint(k: u32) -> vec2f {
  let angle = f32(k) / f32(params.profilePoints) * TAU;
  return vec2f(cos(angle), sin(angle));
}`;
    case "square":
      return `fn outlinePoint(k: u32) -> vec2f {
  switch (k) {
    case 0u: { return vec2f(1.0, -1.0); }
    case 1u: { return vec2f(1.0, 1.0); }
    case 2u: { return vec2f(-1.0, 1.0); }
    default: { return vec2f(-1.0, -1.0); }
  }
}`;
    case "strip":
      return `fn outlinePoint(k: u32) -> vec2f {
  return vec2f(1.0 - 2.0 * f32(k) / f32(params.profilePoints - 1u), 0.0);
}`;
    case "custom": {
      const region = options.outline as SweepRegion;
      return `/* The first strip of the Profile input: each point's x and y. */
fn outlinePoint(k: u32) -> vec2f {
  let o = ${region.word}u + k * 4u;
  return bitcast<vec2f>(vec2u(pk_${region.group}[o], pk_${region.group}[o + 1u]));
}`;
    }
  }
}

/** One column of the ring: where it stands and the outline's outward normal there. */
function columnWgsl(options: SweepShaderOptions): string {
  const ring = options.profile === "ring";
  if (options.flat) {
    /* Two columns a side: the side's first point, then its second, both with the side's normal. */
    const normal = ring
      ? `  let angle = (f32(side) + 0.5) / f32(count) * TAU;
  sample.normal = vec2f(cos(angle), sin(angle));`
      : `  sample.normal = outward(outlinePoint(side), outlinePoint((side + 1u) % count));`;
    return `fn outlineColumn(column: u32) -> OutlineSample {
  let count = params.profilePoints;
  let side = column / 2u;
  var sample: OutlineSample;
  sample.at = outlinePoint((side + column % 2u) % count);
${normal}
  return sample;
}`;
  }
  const neighbours = options.profileClosed
    ? "outlinePoint((column + count - 1u) % count), outlinePoint((column + 1u) % count)"
    : "outlinePoint(max(column, 1u) - 1u), outlinePoint(min(column + 1u, count - 1u))";
  const normal = ring
    ? "  sample.normal = sample.at;"
    : options.profile === "strip"
      ? "  sample.normal = vec2f(0.0, 1.0);"
      : `  let count = params.profilePoints;
  sample.normal = outward(${neighbours});`;
  return `fn outlineColumn(column: u32) -> OutlineSample {
  var sample: OutlineSample;
  sample.at = outlinePoint(column);
${normal}
  return sample;
}`;
}

export function sweepWgsl(options: SweepShaderOptions): EmittedWgsl {
  const buffers = Array.from({ length: options.groups }, (_, group) => `@group(0) @binding(${group + 1}) var<storage, read> pk_${group}: array<u32>;`);
  const vector = (name: string, region: SweepRegion, size: 3 | 4): string => {
    const words = Array.from({ length: size }, (_, component) => `pk_${region.group}[o${component === 0 ? "" : ` + ${component}u`}]`).join(", ");
    return `fn ${name}(point: u32) -> vec${size}f {
  let o = ${region.word}u + point * 4u;
  return bitcast<vec${size}f>(vec${size}u(${words}));
}`;
  };
  const accessors = [
    vector("pathPosition", options.position, 3),
    vector("pathOrient", options.orient, 4),
    ...(options.radius === undefined ? [] : [scalar("pathScale", options.radius, options.radius.strideWords, options.radius.component)]),
    ...(options.distance === undefined ? [] : [scalar("pathDistance", options.distance)]),
    ...(options.curveU === undefined ? [] : [scalar("pathCurveU", options.curveU)]),
    ...(options.curveLength === undefined ? [] : [scalar("pathCurveLength", options.curveLength)]),
  ];

  /* Inward: the same outline, walked the other way from its first point. */
  const walked = !options.inward
    ? "column"
    : options.profileClosed && !options.flat
      ? "(params.cols - column) % params.cols"
      : "params.cols - 1u - column";
  /* The share of the way round, by sides: it rises with the column whichever way the sweep faces. */
  const sides = options.flat ? "params.cols / 2u" : options.profileClosed ? "params.cols" : "params.cols - 1u";
  const around = options.flat ? `f32((column + 1u) / 2u) / f32(${sides})` : `f32(column) / f32(${sides})`;

  /* The coordinate along. A cap's centre is one radius further than its rim. */
  const beyond = options.capped ? "  var beyond = 0.0;\n  if (centre) { beyond = cap * radius; }\n" : "";
  const offset = options.capped ? " + beyond" : "";
  const along =
    options.uvAlong === "points"
      ? `  let along = f32(row) / f32(${options.pathClosed ? "params.rows" : "max(params.rows - 1u, 1u)"});`
      : options.uvAlong === "stretch"
        ? options.capped
          ? `${beyond}  let total = pathCurveLength(point);
  var along = pathCurveU(point);
  if (total > 0.0) { along = along + beyond / total; }`
          : "  let along = pathCurveU(point);"
        : options.pathClosed
          ? `  /* A loop holds a whole number of tiles, so the pattern meets itself at the seam. */
  let total = pathCurveLength(point);
  var along = 0.0;
  if (total > 0.0) { along = pathDistance(point) * max(round(total / params.uvLength), 1.0) / total; }`
          : `${beyond}  let along = (pathDistance(point)${offset}) / params.uvLength;`;

  const carried = options.carried
    .flatMap((attribute) =>
      Array.from({ length: attribute.components }, (_, component) => {
        const tail = component === 0 ? "" : ` + ${component}u`;
        return `  out_points[${attribute.outWord}u + slot * ${attribute.strideWords}u${tail}] = pk_${attribute.group}[${attribute.inWord}u + point * ${attribute.strideWords}u${tail}];`;
      }),
    )
    .join("\n");

  return wgsl`struct SweepParams {
${options.members.map((member) => `  ${member.name}: ${member.type},`).join("\n")}
};

@group(0) @binding(0) var<uniform> params: SweepParams;
${buffers.join("\n")}
@group(0) @binding(${options.groups + 1}) var<storage, read_write> out_points: array<u32>;

const TAU: f32 = 6.28318530717958647692;

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
}

${accessors.join("\n\n")}

${outlineWgsl(options)}

struct OutlineSample {
  at: vec2f,
  normal: vec2f,
};

/* The outward normal of a direction along the outline: it turned a quarter turn clockwise. */
fn outward(a: vec2f, b: vec2f) -> vec2f {
  let v = vec2f(b.y - a.y, a.x - b.x);
  let size = sqrt(dot(v, v));
  if (size > 0.0) { return v / size; }
  return vec2f(0.0);
}

${columnWgsl(options)}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.cols * params.rows${options.sheets ? " * params.sheets" : ""}) {
    return;
  }
  let column = slot % params.cols;
  let row = ${options.sheets ? "(slot / params.cols) % params.rows" : "slot / params.cols"};

  /* Which point of the path this row stands on, and whether it is a cap's: the start's two
     rows come first (its centre, then its rim), the end's two last (its rim, then its centre). */
  var point = 0u;
  var cap = 0.0;
  var centre = false;
  if (row < params.startRows) {
    cap = -1.0;
    centre = row == 0u;
  } else if (row >= params.startRows + params.pathPoints) {
    point = params.pathPoints - 1u;
    cap = 1.0;
    centre = row > params.startRows + params.pathPoints;
  } else {
    point = row - params.startRows;
  }
${
  options.sheets
    ? `  /* Several strips: this sheet's own, whose points follow the strips before it. */
  point = point + (slot / (params.cols * params.rows)) * params.pathPoints;
`
    : ""
}
  let origin = pathPosition(point);
  let frame = pathOrient(point);
  let radius = params.radius${options.radius === undefined ? "" : " * pathScale(point)"};
  let sample = outlineColumn(${walked});

  /* A cap's centre IS the path point. */
  var position = origin;
  if (!centre) { position = origin + qrot(frame, vec3f(sample.at * radius, 0.0)); }
  /* The outline's own normal on the tube, the end's on a cap, on the side the sweep faces. */
  var local = vec3f(sample.normal, 0.0);
  if (cap != 0.0) { local = vec3f(0.0, 0.0, cap); }
  let normal = ${options.inward ? "-" : ""}qrot(frame, local);
${along}

  let positionAt = ${options.out.position}u + slot * 4u;
  out_points[positionAt] = bitcast<u32>(position.x);
  out_points[positionAt + 1u] = bitcast<u32>(position.y);
  out_points[positionAt + 2u] = bitcast<u32>(position.z);
  let normalAt = ${options.out.normal}u + slot * 4u;
  out_points[normalAt] = bitcast<u32>(normal.x);
  out_points[normalAt + 1u] = bitcast<u32>(normal.y);
  out_points[normalAt + 2u] = bitcast<u32>(normal.z);
  let uvAt = ${options.out.uv}u + slot * 2u;
  out_points[uvAt] = bitcast<u32>(${around});
  out_points[uvAt + 1u] = bitcast<u32>(along);
${carried}
}`;
}
