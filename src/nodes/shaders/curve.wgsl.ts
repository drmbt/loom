import { wgsl } from "../../runtime/backend/wgsl.ts";
import type { EmittedWgsl } from "../../runtime/backend/wgsl.ts";
import { ARC_SOLVE_STEPS, ZERO_SEGMENT_SQUARED, type CurveBasis } from "../../points/curve.ts";
import { CURVE_SEED_WGSL } from "./curve-common.wgsl.ts";

/**
 * T1586b — Curve: ONE THREAD PER OUTPUT POINT, each from at most four control points.
 *
 * A control strip becomes `segments` points per span, and a span runs from one control
 * point to the next. Nothing about point k depends on point k − 1, so there is no walk and
 * no scan here: every slot works out which span it is on and how far along, reads the
 * control points around that span, and writes itself. One dispatch, whatever the basis.
 *
 * This file is `src/points/curve.ts`'s `evaluateCurve` in WGSL, basis for basis, and the
 * Dawn tests hold the two together. Three things it keeps exact, because the tests assert
 * equality on them (§V147):
 *
 *  - an interpolating basis returns a control point TO THE BIT where a span starts or ends
 *    on one (the words are returned unblended);
 *  - every blend is written "point + share × difference", so a repeated control point
 *    cancels nothing, and a straight, evenly spaced control strip gives exactly the line;
 *  - a taut Arc (its length equal to its chord) has a half turn of exactly zero, so its
 *    stations are exactly `k × chord ÷ segments` along the chord.
 *
 * The control points come from ONE of two places, behind the same three functions
 * (`controlPosition`, and for the table `tableRow` / `tableRoll`): the regions of a wired
 * pointset, read by offset out of its packed buffers (T1076), or the node's own authored
 * table, which arrives as uniform members — one vec4 a point, the way Ramp's stops do,
 * because a plan carries uniform values as flat lists and has no array of them.
 *
 * ## What it costs, measured
 *
 * Dawn/Metal, best of 9 runs of 200 frames, over the same graph without the node; strips
 * of 16 control points at 16 segments (241 points a strip), position only, ms per frame:
 *
 *   points      strips     Linear    Catmull-Rom    Cardinal    B-Spline    Arc
 *   100,015     415        under 0.05 for every basis (the submission floor)
 *   987,136     4,096      0.13      0.07           0.09        0.07        0.17
 *
 * The Arc solves its span again for every point of it (24 bisection steps) and is still
 * the price of a plain kernel pass: the solve reads two control points and nothing else.
 */

/** One attribute carried from a wired control set to the output, as the pass addresses it. */
export interface CurveCarriedAttribute {
  /** Which bound upstream buffer (`pk_<group>`) holds it. */
  readonly group: number;
  /** Word offset of its region in that buffer, and in this node's own. */
  readonly inWord: number;
  readonly outWord: number;
  /** Words between consecutive points (a vec3f strides four). */
  readonly strideWords: number;
  /** Components actually stored. */
  readonly components: number;
  /** Float attributes blend along the span; integer attributes hold the control point at its start. */
  readonly blend: boolean;
}

/** Where a wired attribute the basis itself reads lives: a buffer and a word offset. */
export interface CurveControlRegion {
  readonly group: number;
  readonly word: number;
}

export interface CurveShaderOptions {
  readonly basis: CurveBasis;
  /** An open, unclamped B-Spline: span s reads control points s … s + 3, and reaches neither end. */
  readonly unclamped: boolean;
  /** The uniform block's members, in order: the node builds its uniform record from the same list. */
  readonly members: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  /** Word offset of `position` in this node's own buffer. */
  readonly positionOutWord: number;
  readonly source:
    | {
        readonly kind: "wired";
        /** How many upstream buffers are bound (`pk_0` …). */
        readonly groups: number;
        readonly position: CurveControlRegion;
        readonly attributes: ReadonlyArray<CurveCarriedAttribute>;
        /** Bezier: the two handle attributes (vec3f, relative to their point). */
        readonly handleIn?: CurveControlRegion;
        readonly handleOut?: CurveControlRegion;
        /** Arc: a per-control-point length (the component of its attribute to read) and bow. */
        readonly arcLength?: CurveControlRegion & { readonly strideWords: number; readonly component: number };
        readonly bow?: CurveControlRegion;
      }
    | {
        readonly kind: "table";
        /** Control points in the table; the uniform block carries `c0` … and `r0` … for them. */
        readonly count: number;
        /** Word offsets of the two attributes a table publishes beside position. */
        readonly scaleOutWord: number;
        readonly rollOutWord: number;
      };
}

const PI = "3.14159265358979";

/** `switch` over the table's uniform members: WGSL cannot index a struct's fields. */
function tableWgsl(count: number): string {
  const rows = Array.from({ length: count }, (_, index) =>
    index === count - 1 ? `    default: { return params.c${index}; }` : `    case ${index}u: { return params.c${index}; }`,
  ).join("\n");
  const groups = Math.ceil(count / 4);
  const rolls = Array.from({ length: groups }, (_, group) =>
    group === groups - 1 ? `    default: { return params.r${group}[i % 4u]; }` : `    case ${group}u: { return params.r${group}[i % 4u]; }`,
  ).join("\n");
  return `/* The authored table: one control point a uniform member, x y z and its scale in w. */
fn tableRow(i: u32) -> vec4f {
  switch (i) {
${rows}
  }
}

/* A control point's roll, in degrees: four to a member. */
fn tableRoll(i: u32) -> f32 {
  switch (i / 4u) {
${rolls}
  }
}

fn controlPosition(strip: u32, i: u32) -> vec3f {
  return tableRow(i).xyz;
}`;
}

function wiredVec3(name: string, region: CurveControlRegion): string {
  return `fn ${name}(strip: u32, i: u32) -> vec3f {
  let o = ${region.word}u + (strip * params.colsIn + i) * 4u;
  return bitcast<vec3f>(vec3u(pk_${region.group}[o], pk_${region.group}[o + 1u], pk_${region.group}[o + 2u]));
}`;
}

const BASIS_WGSL: Readonly<Record<Exclude<CurveBasis, "arc" | "bezier">, string>> = {
  linear: `fn curvePoint(strip: u32, index: u32, next: u32, u: f32) -> vec3f {
  let p1 = controlPosition(strip, index);
  if (u == 0.0) { return p1; }
  let p2 = controlPosition(strip, next);
  if (u == 1.0) { return p2; }
  return p1 + (p2 - p1) * u;
}`,
  /* Catmull-Rom with centripetal knots (Barry and Goldman's pyramid): a knot gap is the
     square root of the distance it spans, so unevenly spaced control points do not loop. */
  catmullRom: `fn knotGap(a: vec3f, b: vec3f) -> f32 {
  let d = b - a;
  return max(sqrt(sqrt(dot(d, d))), 1.0e-12);
}

fn curvePoint(strip: u32, index: u32, next: u32, u: f32) -> vec3f {
  let p1 = controlPosition(strip, index);
  if (u == 0.0) { return p1; }
  let p2 = controlPosition(strip, next);
  if (u == 1.0) { return p2; }
  let p0 = controlAt(strip, i32(index) - 1);
  let p3 = controlAt(strip, i32(index) + 2);
  let g01 = knotGap(p0, p1);
  let g12 = knotGap(p1, p2);
  let g23 = knotGap(p2, p3);
  let t = u * g12;
  let a1 = p1 + (p1 - p0) * (t / g01);
  let a2 = p1 + (p2 - p1) * (t / g12);
  let a3 = p2 + (p3 - p2) * ((t - g12) / g23);
  let b1 = a1 + (a2 - a1) * ((t + g01) / (g01 + g12));
  let b2 = a2 + (a3 - a2) * (t / (g12 + g23));
  return b1 + (b2 - b1) * (t / g12);
}`,
  cardinal: `fn curvePoint(strip: u32, index: u32, next: u32, u: f32) -> vec3f {
  let p1 = controlPosition(strip, index);
  if (u == 0.0) { return p1; }
  let p2 = controlPosition(strip, next);
  if (u == 1.0) { return p2; }
  let p0 = controlAt(strip, i32(index) - 1);
  let p3 = controlAt(strip, i32(index) + 2);
  let m1 = (p2 - p0) * ((1.0 - params.tension) * 0.5);
  let m2 = (p3 - p1) * ((1.0 - params.tension) * 0.5);
  let h10 = u * u * u - 2.0 * u * u + u;
  let h01 = 3.0 * u * u - 2.0 * u * u * u;
  let h11 = u * u * u - u * u;
  return (p1 + m1 * h10) + ((p2 - p1) * h01 + m2 * h11);
}`,
  /* Uniform cubic, approximating: it passes near its control points, not through them. */
  bspline: `fn curvePoint(strip: u32, index: u32, next: u32, u: f32) -> vec3f {
  let p0 = controlAt(strip, i32(index) - 1);
  let p1 = controlAt(strip, i32(index));
  let p2 = controlAt(strip, i32(index) + 1);
  let p3 = controlAt(strip, i32(index) + 2);
  let v = 1.0 - u;
  let w0 = v * v * v;
  let w1 = 3.0 * u * u * u - 6.0 * u * u + 4.0;
  let w2 = -3.0 * u * u * u + 3.0 * u * u + 3.0 * u + 1.0;
  let w3 = u * u * u;
  return ((p0 * w0 + p1 * w1) + (p2 * w2 + p3 * w3)) / 6.0;
}`,
};

/* Cubic Bezier, each control point carrying its two handles relative to itself. */
const BEZIER_WGSL = `fn curvePoint(strip: u32, index: u32, next: u32, u: f32) -> vec3f {
  let p1 = controlPosition(strip, index);
  if (u == 0.0) { return p1; }
  let p2 = controlPosition(strip, next);
  if (u == 1.0) { return p2; }
  let b1 = p1 + controlHandleOut(strip, index);
  let b2 = p2 + controlHandleIn(strip, next);
  let v = 1.0 - u;
  return (p1 * (v * v * v) + b1 * (3.0 * v * v * u)) + (b2 * (3.0 * v * u * u) + p2 * (u * u * u));
}`;

/**
 * The Arc: the one arc of constant curvature and a given length from a span's first control
 * point to its second (`solveArc` and `arcPoint` in the reference). Its half turn φ solves
 * sinc(φ) = chord ÷ length, and sinc only falls on [0, π], so a fixed number of bisection
 * steps finds the one answer — the loop's length depends on nothing it reads.
 */
function arcWgsl(lengthAt: string, bowAt: string): string {
  return `const PI: f32 = ${PI};

fn sinc(x: f32) -> f32 {
  if (abs(x) < 1.0e-3) { return 1.0 - x * x / 6.0; }
  return sin(x) / x;
}

${CURVE_SEED_WGSL}

fn curvePoint(strip: u32, index: u32, next: u32, u: f32) -> vec3f {
  let a = controlPosition(strip, index);
  let chordVector = controlPosition(strip, next) - a;
  let chordSquared = dot(chordVector, chordVector);
  let bow = ${bowAt};
  var chord = 0.0;
  var along = vec3f(0.0);
  var side = vec3f(0.0, -1.0, 0.0);
  if (chordSquared > ZERO_SEGMENT_SQUARED) {
    chord = sqrt(chordSquared);
    along = chordVector / chord;
    side = seedNormal(along, bow);
  } else {
    /* No chord: a circle through the point, leaving square to the bow. */
    if (dot(bow, bow) > 1.0e-12) { side = bow / sqrt(dot(bow, bow)); }
    along = seedNormal(side, leastAligned(side));
  }
  var wanted = ${lengthAt};
  if (params.arcChords == 1u) { wanted = wanted * chord; }
  var laid = max(wanted, 0.0);
  /* A full turn is no cap at all: sinc(π) is zero, and a chord over it is not a length. */
  if (params.maxHalfTurn < PI - 1.0e-6) { laid = min(laid, chord / sinc(params.maxHalfTurn)); }
  var halfTurn = 0.0;
  if (laid > 0.0 && chord < laid) {
    let share = chord / laid;
    var low = 0.0;
    var high = PI;
    for (var iteration = 0u; iteration < ${ARC_SOLVE_STEPS}u; iteration = iteration + 1u) {
      let mid = (low + high) * 0.5;
      if (sinc(mid) > share) { low = mid; } else { high = mid; }
    }
    halfTurn = (low + high) * 0.5;
  }
  var curvature = 0.0;
  if (laid > 0.0) { curvature = 2.0 * halfTurn / laid; }
  let tangent = along * cos(halfTurn) + side * sin(halfTurn);
  let inward = along * sin(halfTurn) - side * cos(halfTurn);
  let s = u * laid;
  let angle = curvature * s;
  /* sin(κs)/κ and (1 − cos(κs))/κ, written so a straight arc (κ = 0) is exact. */
  return a + (tangent * (s * sinc(angle)) + inward * (s * sin(angle * 0.5) * sinc(angle * 0.5)));
}`;
}

export function curveWgsl(options: CurveShaderOptions): EmittedWgsl {
  const { source, basis } = options;
  const wired = source.kind === "wired";
  const buffers = wired
    ? Array.from({ length: source.groups }, (_, group) => `@group(0) @binding(${group + 1}) var<storage, read> pk_${group}: array<u32>;`)
    : [];
  const outBinding = (wired ? source.groups : 0) + 1;

  const accessors: string[] = [];
  if (wired) {
    accessors.push(wiredVec3("controlPosition", source.position));
    if (source.handleIn !== undefined) accessors.push(wiredVec3("controlHandleIn", source.handleIn));
    if (source.handleOut !== undefined) accessors.push(wiredVec3("controlHandleOut", source.handleOut));
    if (source.bow !== undefined) accessors.push(wiredVec3("controlBow", source.bow));
    if (source.arcLength !== undefined) {
      const region = source.arcLength;
      accessors.push(`fn controlArcLength(strip: u32, i: u32) -> f32 {
  return bitcast<f32>(pk_${region.group}[${region.word}u + (strip * params.colsIn + i) * ${region.strideWords}u + ${region.component}u]);
}`);
    }
  } else {
    accessors.push(tableWgsl(source.count));
  }

  const basisText =
    basis === "arc"
      ? arcWgsl(
          wired && source.arcLength !== undefined ? "controlArcLength(strip, index)" : "params.arcLength",
          wired && source.bow !== undefined ? "controlBow(strip, index)" : "params.bow",
        )
      : basis === "bezier"
        ? BEZIER_WGSL
        : BASIS_WGSL[basis];

  const carried = wired
    ? source.attributes
        .flatMap((attribute) =>
          Array.from({ length: attribute.components }, (_, component) => {
            const tail = component === 0 ? "" : ` + ${component}u`;
            const read = (point: string): string =>
              `pk_${attribute.group}[${attribute.inWord}u + (baseIn + ${point}) * ${attribute.strideWords}u${tail}]`;
            const target = `out_points[${attribute.outWord}u + slot * ${attribute.strideWords}u${tail}]`;
            return attribute.blend ? `  ${target} = blend(${read("index")}, ${read("next")}, u);` : `  ${target} = ${read("held")};`;
          }),
        )
        .join("\n")
    : `  out_points[${source.scaleOutWord}u + slot] = blend(bitcast<u32>(tableRow(index).w), bitcast<u32>(tableRow(next).w), u);
  out_points[${source.rollOutWord}u + slot] = blend(bitcast<u32>(tableRoll(index)), bitcast<u32>(tableRoll(next)), u);`;

  return wgsl`struct CurveParams {
${options.members.map((member) => `  ${member.name}: ${member.type},`).join("\n")}
};

@group(0) @binding(0) var<uniform> params: CurveParams;
${buffers.join("\n")}
@group(0) @binding(${outBinding}) var<storage, read_write> out_points: array<u32>;

/* A span at or below this squared length has no chord (the Arc's degenerate case). */
const ZERO_SEGMENT_SQUARED: f32 = ${ZERO_SEGMENT_SQUARED};

${accessors.join("\n\n")}

/* A control point by signed index: wrapped on a closed strip; past an open end, the
   neighbour mirrored through the end point, so an end is entered and left straight. */
fn controlAt(strip: u32, i: i32) -> vec3f {
  let n = i32(params.colsIn);
  if (params.closed == 1u) { return controlPosition(strip, u32(((i % n) + n) % n)); }
  if (i < 0) {
    if (n < 2) { return controlPosition(strip, 0u); }
    return 2.0 * controlPosition(strip, 0u) - controlPosition(strip, 1u);
  }
  if (i >= n) {
    if (n < 2) { return controlPosition(strip, u32(n - 1)); }
    return 2.0 * controlPosition(strip, u32(n - 1)) - controlPosition(strip, u32(n - 2));
  }
  return controlPosition(strip, u32(i));
}

${basisText}

/* One float component between a span's two control points. ON a control point the word is
   returned untouched, so an attribute at a control point is kept to the bit. */
fn blend(a: u32, b: u32, t: f32) -> u32 {
  if (t == 0.0) { return a; }
  if (t == 1.0) { return b; }
  let x = bitcast<f32>(a);
  let y = bitcast<f32>(b);
  return bitcast<u32>(x + (y - x) * t);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let slot = gid.x;
  if (slot >= params.colsOut * params.rows) {
    return;
  }
  let strip = slot / params.colsOut;
  let k = slot % params.colsOut;
  let baseIn = strip * params.colsIn;
  var span = 0u;
  var u = 0.0;
  if (params.spans > 0u) {
    span = k / params.segments;
    u = f32(k % params.segments) / f32(params.segments);
    /* The last point of an open strip is the END of the last span, not the start of one
       that does not exist. */
    if (span >= params.spans) {
      span = params.spans - 1u;
      u = 1.0;
    }
  }
  let index = span + ${options.unclamped ? 1 : 0}u;
  var next = index;
  if (params.spans > 0u) {
    next = index + 1u;
    if (params.closed == 1u) { next = next % params.colsIn; }
  }
  /* An integer attribute cannot blend: a point holds its span's first control point's, and
     the far one's only where the strip ENDS on it — so a point on a control point always
     carries that control point's own. */
  var held = index;
  if (u == 1.0) { held = next; }
  let position = bitcast<vec3u>(curvePoint(strip, index, next, u));
  let at = ${options.positionOutWord}u + slot * 4u;
  out_points[at] = position.x;
  out_points[at + 1u] = position.y;
  out_points[at + 2u] = position.z;
${carried}
}`;
}
