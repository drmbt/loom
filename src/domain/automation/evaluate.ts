import { easeProgress } from "./eases.ts";
import {
  denormalizeValue,
  parseAutomation,
  type AutomationDocument,
  type AutomationKey,
  type AutomationLane,
  type Extrapolation,
  type Handle,
} from "./model.ts";

/**
 * VN61 — EVALUATING A LANE AT A TIME IN TICKS.
 *
 * Pure: a lane and a tick in, a number out, no clock (§V44). The time arrives from the
 * frame through the node (`automation.ts`), already converted to ticks.
 *
 * HANDLES. Free and Aligned handles are used as stored; Vector, Auto and Auto-Clamped are
 * DERIVED here from the neighbouring keys every time a lane is resolved, so what is
 * stored for them never matters and an edit to a neighbour reshapes them with no second
 * write. Every handle is then held inside its segment (x within [t0, t1]) by scaling it
 * along its own direction, which keeps a cubic's x(u) monotone — the property the bezier
 * solve needs, and Keyframer's `relX ≤ dx` rule.
 *
 * - Auto: the Catmull-Rom tangent (the slope between the two neighbours), a third of
 *   each adjacent segment long — Blender's Auto.
 * - Auto-Clamped (the default): Auto, but flat at a local extreme and at the ends, and
 *   its slope limited to twice the smaller adjacent secant. With both ends of a segment
 *   inside that limit the cubic is monotone (Fritsch–Carlson: α² + β² ≤ 8 < 9), so the
 *   curve never overshoots its neighbours' values and a parameter never leaves its range
 *   between keys.
 * - Vector: points a third of the way to the neighbouring key — a straight-line feel.
 *
 * BEZIER is a weighted cubic in (time, value): x(u) is solved for u by Newton's method
 * from the linear guess, falling back to bisection when a step leaves [0, 1], the slope
 * vanishes, or it has not converged — ltc-lab's `automation.ts` bisects 32 times every
 * call; Newton converges in two or three here and bisection is the guarantee.
 */

export interface ResolvedKey {
  readonly t: number;
  readonly v: number;
  readonly key: AutomationKey;
  /** The effective handles: derived for vector / auto / autoClamped, then held in the segment. */
  readonly in: Handle;
  readonly out: Handle;
}

export interface ResolvedLane {
  readonly lane: AutomationLane;
  readonly keys: readonly ResolvedKey[];
}

const sign = (value: number): number => (value > 0 ? 1 : value < 0 ? -1 : 0);

/** Scale `(dt, dv)` along itself so |dt| ≤ `limit`. */
function holdInSegment(handle: Handle, limit: number): Handle {
  const dt = Math.abs(handle[0]);
  if (dt <= limit || dt === 0) return handle;
  const scale = limit / dt;
  return [handle[0] * scale, handle[1] * scale];
}

function derivedSlope(lane: AutomationLane, index: number): number {
  const keys = lane.keys;
  const key = keys[index] as AutomationKey;
  const previous = keys[index - 1];
  const next = keys[index + 1];
  const left = previous === undefined ? null : (key.v - previous.v) / (key.t - previous.t);
  const right = next === undefined ? null : (next.v - key.v) / (next.t - key.t);
  if (key.handle === "auto") {
    if (previous !== undefined && next !== undefined) return (next.v - previous.v) / (next.t - previous.t);
    return left ?? right ?? 0;
  }
  // autoClamped: flat at the ends and at an extreme (or a plateau), else limited.
  if (left === null || right === null || sign(left) !== sign(right) || left === 0) return 0;
  const catmull = (next!.v - previous!.v) / (next!.t - previous!.t);
  const limit = 2 * Math.min(Math.abs(left), Math.abs(right));
  return sign(catmull) * Math.min(Math.abs(catmull), limit);
}

/** The lane with every key's effective handles. Exported for the editor, which draws them. */
export function resolveLane(lane: AutomationLane): ResolvedLane {
  const keys = lane.keys;
  const resolved: ResolvedKey[] = keys.map((key, index) => {
    const previous = keys[index - 1];
    const next = keys[index + 1];
    const before = previous === undefined ? 0 : key.t - previous.t;
    const after = next === undefined ? 0 : next.t - key.t;
    let inHandle: Handle = key.in;
    let outHandle: Handle = key.out;
    if (key.handle === "vector") {
      inHandle = previous === undefined ? [0, 0] : [-before / 3, (previous.v - key.v) / 3];
      outHandle = next === undefined ? [0, 0] : [after / 3, (next.v - key.v) / 3];
    } else if (key.handle === "auto" || key.handle === "autoClamped") {
      const slope = derivedSlope(lane, index);
      inHandle = [-before / 3, (-before / 3) * slope];
      outHandle = [after / 3, (after / 3) * slope];
    }
    return { t: key.t, v: key.v, key, in: holdInSegment(inHandle, before), out: holdInSegment(outHandle, after) };
  });
  return { lane, keys: resolved };
}

const cubic = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
  const mu = 1 - u;
  return mu * mu * mu * p0 + 3 * mu * mu * u * p1 + 3 * mu * u * u * p2 + u * u * u * p3;
};

const cubicSlope = (p0: number, p1: number, p2: number, p3: number, u: number): number => {
  const mu = 1 - u;
  return 3 * (mu * mu * (p1 - p0) + 2 * mu * u * (p2 - p1) + u * u * (p3 - p2));
};

/** Solve x(u) = x for u in [0, 1]; x(u) is monotone because the handles are held in the segment. */
export function solveBezierU(x0: number, x1: number, x2: number, x3: number, x: number): number {
  if (x <= x0) return 0;
  if (x >= x3) return 1;
  const tolerance = (x3 - x0) * 1e-12;
  let u = (x - x0) / (x3 - x0);
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const error = cubic(x0, x1, x2, x3, u) - x;
    if (Math.abs(error) <= tolerance) return u;
    const slope = cubicSlope(x0, x1, x2, x3, u);
    if (slope <= 0) break;
    const next = u - error / slope;
    if (!(next > 0 && next < 1)) break;
    u = next;
  }
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 64; iteration += 1) {
    u = (low + high) / 2;
    const value = cubic(x0, x1, x2, x3, u);
    if (Math.abs(value - x) <= tolerance) return u;
    if (value < x) low = u;
    else high = u;
  }
  return (low + high) / 2;
}

/** The normalized value inside one segment, a ≤ t ≤ b. */
function segmentValue(a: ResolvedKey, b: ResolvedKey, t: number, stepped: boolean): number {
  if (t <= a.t) return a.v;
  if (t >= b.t) return b.v;
  const interp = stepped ? "constant" : a.key.interp;
  const span = b.t - a.t;
  const u = (t - a.t) / span;
  switch (interp) {
    case "constant":
      return a.v;
    case "linear":
      return a.v + (b.v - a.v) * u;
    case "cubic": {
      // Hermite through the two keys with the handles' slopes, the handles' lengths ignored.
      const m0 = a.out[0] > 0 ? a.out[1] / a.out[0] : 0;
      const m1 = b.in[0] < 0 ? b.in[1] / b.in[0] : 0;
      const u2 = u * u;
      const u3 = u2 * u;
      return (2 * u3 - 3 * u2 + 1) * a.v + (u3 - 2 * u2 + u) * span * m0 + (-2 * u3 + 3 * u2) * b.v + (u3 - u2) * span * m1;
    }
    case "bezier": {
      const solved = solveBezierU(a.t, a.t + a.out[0], b.t + b.in[0], b.t, t);
      return cubic(a.v, a.v + a.out[1], b.v + b.in[1], b.v, solved);
    }
    default: {
      const progress = easeProgress(interp, u, a.key.power) ?? u;
      return a.v + (b.v - a.v) * progress;
    }
  }
}

/** The curve's slope (normalized value per tick) leaving the first key / arriving at the last. */
function endSlope(resolved: ResolvedLane, end: "start" | "end"): number {
  const keys = resolved.keys;
  if (keys.length < 2) return 0;
  const a = (end === "start" ? keys[0] : keys[keys.length - 2]) as ResolvedKey;
  const b = (end === "start" ? keys[1] : keys[keys.length - 1]) as ResolvedKey;
  const interp = resolved.lane.stepped ? "constant" : a.key.interp;
  if (interp === "constant") return 0;
  if (interp === "linear") return (b.v - a.v) / (b.t - a.t);
  if (interp === "bezier" || interp === "cubic") {
    const handle = end === "start" ? a.out : b.in;
    if (handle[0] !== 0) return handle[1] / handle[0];
    return (b.v - a.v) / (b.t - a.t);
  }
  // An ease: the derivative of its progress at the end, taken numerically (eases are smooth there).
  const h = 1e-6;
  const at = end === "start" ? 0 : 1 - h;
  const progress = (u: number): number => easeProgress(interp, u, a.key.power) ?? u;
  return ((progress(at + h) - progress(at)) / h) * ((b.v - a.v) / (b.t - a.t));
}

const modulo = (value: number, period: number): number => ((value % period) + period) % period;

/** Map a time outside [first, last] by the extrapolation mode; returns the value directly. */
function extrapolate(resolved: ResolvedLane, t: number, mode: Extrapolation, side: "pre" | "post"): number {
  const keys = resolved.keys;
  const first = keys[0] as ResolvedKey;
  const last = keys[keys.length - 1] as ResolvedKey;
  const span = last.t - first.t;
  if (mode === "constant" || span === 0) return side === "pre" ? first.v : last.v;
  if (mode === "linear") {
    return side === "pre" ? first.v + endSlope(resolved, "start") * (t - first.t) : last.v + endSlope(resolved, "end") * (t - last.t);
  }
  const offset = t - first.t;
  if (mode === "mirror") {
    const phase = modulo(offset, 2 * span);
    return inside(resolved, phase <= span ? first.t + phase : last.t - (phase - span));
  }
  const cycles = Math.floor(offset / span);
  const value = inside(resolved, first.t + modulo(offset, span));
  return mode === "cycleOffset" ? value + cycles * (last.v - first.v) : value;
}

/** The value at a time inside [first, last]. Binary search for the segment. */
function inside(resolved: ResolvedLane, t: number): number {
  const keys = resolved.keys;
  let low = 0;
  let high = keys.length - 1;
  while (high - low > 1) {
    const middle = (low + high) >> 1;
    if ((keys[middle] as ResolvedKey).t <= t) low = middle;
    else high = middle;
  }
  const a = keys[low] as ResolvedKey;
  const b = keys[high] as ResolvedKey;
  return low === high ? a.v : segmentValue(a, b, t, resolved.lane.stepped);
}

/** The NORMALIZED value at `t` ticks, before clamp and range. A muted lane holds `mutedValue` (else its first key). */
export function evaluateNormalized(resolved: ResolvedLane, t: number): number {
  const keys = resolved.keys;
  const first = keys[0];
  const last = keys[keys.length - 1];
  if (first === undefined || last === undefined) return 0;
  if (resolved.lane.mute) return resolved.lane.mutedValue ?? first.v;
  if (t < first.t) return extrapolate(resolved, t, resolved.lane.pre, "pre");
  if (t > last.t) return extrapolate(resolved, t, resolved.lane.post, "post");
  return inside(resolved, t);
}

/** What the lane's channel publishes at `t`: clamped (when the lane says so) in 0..1, then mapped to min..max. */
export function evaluateLane(resolved: ResolvedLane, t: number): number {
  const normalized = evaluateNormalized(resolved, t);
  const held = resolved.lane.clamp ? Math.min(1, Math.max(0, normalized)) : normalized;
  return denormalizeValue(resolved.lane, held);
}

export interface CompiledAutomation {
  readonly document: AutomationDocument;
  readonly lanes: readonly ResolvedLane[];
}

export type CompiledAutomationResult = { readonly ok: true; readonly compiled: CompiledAutomation } | { readonly ok: false; readonly reason: string };

/*
 * Parse-and-resolve once per distinct text, not once per frame. Keyed by the text alone,
 * so an edit is a new key and a hit can only be the text asked about (the expression
 * parse memo's argument, T1172); FIFO past a small cap, since the working set is the
 * automation nodes in one document.
 */
const COMPILE_CACHE_LIMIT = 64;
const compiledByText = new Map<string, CompiledAutomationResult>();

export function compileAutomation(text: unknown): CompiledAutomationResult {
  const key = typeof text === "string" ? text : "";
  const hit = compiledByText.get(key);
  if (hit !== undefined) return hit;
  const parsed = parseAutomation(key);
  const result: CompiledAutomationResult = parsed.ok
    ? { ok: true, compiled: { document: parsed.document, lanes: parsed.document.lanes.map(resolveLane) } }
    : parsed;
  compiledByText.set(key, result);
  if (compiledByText.size > COMPILE_CACHE_LIMIT) {
    const oldest = compiledByText.keys().next();
    if (oldest.done !== true) compiledByText.delete(oldest.value);
  }
  return result;
}
