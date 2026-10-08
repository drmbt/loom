import { retimeTicks, type FpsChangeMode, type FrameRate } from "../time/ticks.ts";
import type { AutomationDocument, AutomationKey } from "./model.ts";

/**
 * VN61 — CHANGING FPS, FOR A WHOLE AUTOMATION DOCUMENT.
 *
 * `keepTime` (the default, Vincent 2026-10-06) changes nothing: ticks are time, so every
 * key stays at its second and lands on a different frame number. `keepFrames` keeps each
 * key on its frame number: times, handle lengths and the explicit `range` all scale by
 * old/new rate, rounded to whole ticks. Rounding could in principle land two keys on one
 * tick at an extreme ratio; a key that would is pushed one tick past its predecessor, so
 * the result still satisfies the parse invariants (strictly increasing). The UI that asks
 * the question is VN62's.
 */
export function retimeAutomation(document: AutomationDocument, mode: FpsChangeMode, from: FrameRate, to: FrameRate): AutomationDocument {
  if (mode === "keepTime") return document;
  const scale = (ticks: number): number => retimeTicks(ticks, mode, from, to);
  // Handle lengths are durations: scaled unrounded, product first so 8 000 → 8 008 is exact.
  const stretch = (dt: number): number => (dt * from.num * to.den) / (from.den * to.num);
  return {
    ...document,
    ...(document.range === undefined ? {} : { range: [scale(document.range[0]), Math.max(scale(document.range[0]) + 1, scale(document.range[1]))] as const }),
    lanes: document.lanes.map((lane) => {
      const keys: AutomationKey[] = [];
      for (const key of lane.keys) {
        const previous = keys[keys.length - 1];
        const t = previous === undefined ? scale(key.t) : Math.max(previous.t + 1, scale(key.t));
        keys.push({ ...key, t, in: [stretch(key.in[0]), key.in[1]], out: [stretch(key.out[0]), key.out[1]] });
      }
      return { ...lane, keys };
    }),
  };
}
