import { describe, expect, it } from "vitest";

import { easeProgress } from "./eases.ts";
import { compileAutomation, evaluateLane, evaluateNormalized, resolveLane, solveBezierU } from "./evaluate.ts";
import { INTERPOLATIONS, newKey, newLane, serializeAutomation, type AutomationKey, type AutomationLane } from "./model.ts";

const S = 240_000;
const at = (lane: AutomationLane, t: number): number => evaluateLane(resolveLane(lane), t);
const normalizedAt = (lane: AutomationLane, t: number): number => evaluateNormalized(resolveLane(lane), t);
const two = (interp: AutomationKey["interp"], extra: Partial<AutomationLane> = {}, a = 0, b = 1): AutomationLane =>
  newLane("l", "x", [newKey("a", 0, a, { interp }), newKey("b", S, b)], extra);

describe("VN61 — evaluating a lane", () => {
  it("passes through every key exactly and maps 0..1 to min..max", () => {
    const lane = newLane("l", "x", [newKey("a", 0, 0.25), newKey("b", S, 1), newKey("c", 3 * S, 0)], { min: -360, max: 360 });
    expect(at(lane, 0)).toBe(-180);
    expect(at(lane, S)).toBe(360);
    expect(at(lane, 3 * S)).toBe(-360);
  });

  it("linear, constant and stepped", () => {
    expect(at(two("linear", { min: 10, max: 20 }), S / 2)).toBe(15);
    expect(at(two("linear"), S / 4)).toBe(0.25);
    expect(at(two("constant"), S - 1)).toBe(0);
    expect(at(two("constant"), S)).toBe(1);
    expect(at(two("linear", { stepped: true }), S - 1)).toBe(0);
  });

  it("every ease starts at 0 and ends at 1", () => {
    for (const interp of INTERPOLATIONS) {
      const progress = easeProgress(interp, 0, 3);
      if (progress === null) continue;
      expect([interp, progress]).toEqual([interp, 0]);
      expect([interp, easeProgress(interp, 1, 3)]).toEqual([interp, 1]);
    }
    expect(easeProgress("ease", 0.5)).toBe(0.5);
    expect(easeProgress("easeinp", 0.5, 3)).toBe(0.125);
    expect(easeProgress("inOutQuad", 0.25)).toBe(0.125);
  });

  it("clamp holds an overshooting ease inside the range; off, it overshoots", () => {
    // outBack overshoots past 1 before settling.
    const peak = Array.from({ length: 99 }, (_, i) => normalizedAt(two("outBack"), ((i + 1) / 100) * S));
    expect(Math.max(...peak)).toBeGreaterThan(1);
    const clamped = Array.from({ length: 99 }, (_, i) => at(two("outBack", { min: 0, max: 10 }), ((i + 1) / 100) * S));
    expect(Math.max(...clamped)).toBe(10);
    const free = Array.from({ length: 99 }, (_, i) => at(two("outBack", { min: 0, max: 10, clamp: false }), ((i + 1) / 100) * S));
    expect(Math.max(...free)).toBeGreaterThan(10);
  });

  it("a bezier with vector handles is the straight line", () => {
    const lane = newLane("l", "x", [newKey("a", 0, 0, { handle: "vector" }), newKey("b", S, 1, { handle: "vector" })]);
    for (const fraction of [0.1, 0.37, 0.5, 0.9]) expect(Math.abs(at(lane, fraction * S) - fraction)).toBeLessThan(1e-12);
  });

  it("Newton agrees with bisection on the bezier solve, monotone handles held in the segment", () => {
    // Free handles far longer than the segment: held in it, so x(u) stays monotone.
    const lane = newLane("l", "x", [
      newKey("a", 0, 0, { handle: "free", out: [10 * S, 0.5] }),
      newKey("b", S, 1, { handle: "free", in: [-10 * S, -0.5] }),
    ]);
    const resolved = resolveLane(lane);
    expect(resolved.keys[0]?.out).toEqual([S, 0.05]);
    expect(resolved.keys[1]?.in).toEqual([-S, -0.05]);
    let previous = -Infinity;
    for (let i = 0; i <= 200; i += 1) {
      const value = evaluateLane(resolved, (i / 200) * S);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(previous - 1e-12);
      previous = value;
    }
    const x: [number, number, number, number] = [0, 0.9, 0.1, 1];
    for (const target of [0.001, 0.25, 0.5, 0.75, 0.999]) {
      const u = solveBezierU(...x, target);
      const mu = 1 - u;
      expect(Math.abs(mu * mu * mu * x[0] + 3 * mu * mu * u * x[1] + 3 * mu * u * u * x[2] + u * u * u * x[3] - target)).toBeLessThan(1e-11);
    }
  });

  it("auto-clamped never overshoots its neighbours; flat at an extreme", () => {
    const keys = [0, 1, 0.9, 1, 0, 0.2, 0.25].map((v, i) => newKey(`k${i}`, i * S + (i % 2) * 37_000, v));
    const lane = newLane("l", "x", keys);
    const resolved = resolveLane(lane);
    for (let i = 0; i + 1 < keys.length; i += 1) {
      const a = keys[i]!;
      const b = keys[i + 1]!;
      const low = Math.min(a.v, b.v);
      const high = Math.max(a.v, b.v);
      for (let step = 0; step <= 50; step += 1) {
        const value = evaluateNormalized(resolved, a.t + ((b.t - a.t) * step) / 50);
        expect(value).toBeGreaterThanOrEqual(low - 1e-12);
        expect(value).toBeLessThanOrEqual(high + 1e-12);
      }
    }
    // Key 1 (value 1) is a local maximum: its handles are flat.
    expect(resolved.keys[1]?.out[1]).toBe(0);
    // Plain auto on the same keys does overshoot: that is the difference the default buys.
    const auto = resolveLane(newLane("l", "x", keys.map((key) => ({ ...key, handle: "auto" as const }))));
    const samples = Array.from({ length: 51 }, (_, step) => evaluateNormalized(auto, keys[1]!.t + ((keys[2]!.t - keys[1]!.t) * step) / 50));
    expect(Math.max(...samples)).toBeGreaterThan(1);
  });

  it("extrapolates constant, linear, cycle, cycle with offset and mirror", () => {
    const base = (pre: AutomationLane["pre"], post: AutomationLane["post"]) =>
      newLane("l", "x", [newKey("a", 0, 0.2, { interp: "linear" }), newKey("b", S, 0.6)], { pre, post, clamp: false });
    expect(normalizedAt(base("constant", "constant"), -S)).toBe(0.2);
    expect(normalizedAt(base("constant", "constant"), 5 * S)).toBe(0.6);
    expect(normalizedAt(base("linear", "linear"), 2 * S)).toBeCloseTo(1.0, 12);
    expect(normalizedAt(base("linear", "linear"), -S / 2)).toBeCloseTo(0.0, 12);
    expect(normalizedAt(base("cycle", "cycle"), S + S / 4)).toBeCloseTo(0.3, 12);
    expect(normalizedAt(base("cycle", "cycle"), -S / 4)).toBeCloseTo(0.5, 12);
    expect(normalizedAt(base("cycleOffset", "cycleOffset"), 2 * S + S / 4)).toBeCloseTo(0.3 + 0.8, 12);
    expect(normalizedAt(base("mirror", "mirror"), S + S / 4)).toBeCloseTo(0.5, 12);
    expect(normalizedAt(base("mirror", "mirror"), -S / 4)).toBeCloseTo(0.3, 12);
  });

  it("a single key is a constant everywhere; a muted lane holds mutedValue, else its first key", () => {
    const one = newLane("l", "x", [newKey("a", S, 0.4)], { pre: "linear", post: "cycle" });
    expect(normalizedAt(one, 0)).toBe(0.4);
    expect(normalizedAt(one, 9 * S)).toBe(0.4);
    expect(normalizedAt(two("linear", { mute: true }, 0.3, 1), S)).toBe(0.3);
    expect(normalizedAt(two("linear", { mute: true, mutedValue: 0.7 }, 0.3, 1), 0)).toBe(0.7);
  });

  it("compiles each distinct text once and refuses a broken one", () => {
    const text = serializeAutomation({ version: 1, lanes: [two("linear")] });
    const first = compileAutomation(text);
    expect(compileAutomation(text)).toBe(first);
    expect(first.ok).toBe(true);
    expect(compileAutomation("{nope")).toEqual({ ok: false, reason: "the lanes field is not valid JSON" });
  });
});
