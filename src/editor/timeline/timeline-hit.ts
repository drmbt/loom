import type { ResolvedLane } from "@domain/automation/evaluate.ts";
import type { KeyRef } from "./timeline-edits.ts";
import { displayValue, tickToX, valueToY, xToTick, type TimelineView, type ValueMode } from "./timeline-view.ts";

/**
 * VN62 — WHAT IS UNDER THE POINTER, in the curve area's CSS pixels. Pure.
 *
 * Handles are tested before keys (a handle sits on top of its key when short), and only
 * for keys whose handles are drawn (selected keys), so an unselected key's invisible
 * handle never steals a click.
 */

export type Hit =
  | { readonly kind: "key"; readonly ref: KeyRef }
  | { readonly kind: "handle"; readonly ref: KeyRef; readonly side: "in" | "out" }
  | { readonly kind: "none" };

export const HIT_RADIUS = 6;

export interface Geometry {
  readonly view: TimelineView;
  readonly height: number;
  readonly mode: ValueMode;
}

export const keyPoint = (geometry: Geometry, lane: ResolvedLane, t: number, v: number): { x: number; y: number } => ({
  x: tickToX(geometry.view, t),
  y: valueToY(geometry.view, geometry.height, displayValue(lane.lane, v, geometry.mode)),
});

export function hitTest(
  geometry: Geometry,
  lanes: readonly ResolvedLane[],
  x: number,
  y: number,
  handlesOf: (ref: KeyRef) => boolean,
  radius = HIT_RADIUS,
): Hit {
  const near = (point: { x: number; y: number }): number => Math.hypot(point.x - x, point.y - y);
  let best: Hit = { kind: "none" };
  let bestDistance = radius;
  // Later lanes draw on top, so they win a tie: walk in reverse and only replace on "closer".
  for (const lane of [...lanes].reverse()) {
    for (const key of lane.keys) {
      const ref = { lane: lane.lane.id, key: key.key.id };
      if (handlesOf(ref)) {
        for (const side of ["in", "out"] as const) {
          const handle = key[side];
          if (handle[0] === 0 && handle[1] === 0) continue;
          const distance = near(keyPoint(geometry, lane, key.t + handle[0], key.v + handle[1]));
          if (distance < bestDistance) {
            best = { kind: "handle", ref, side };
            bestDistance = distance;
          }
        }
      }
      const distance = near(keyPoint(geometry, lane, key.t, key.v));
      // A key beats a handle at the same distance: the key is what the user sees first.
      if (distance < bestDistance || (distance === bestDistance && best.kind === "handle")) {
        best = { kind: "key", ref };
        bestDistance = distance;
      }
    }
  }
  return best;
}

export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

const normalize = (rect: Rect): Rect => ({
  x0: Math.min(rect.x0, rect.x1),
  x1: Math.max(rect.x0, rect.x1),
  y0: Math.min(rect.y0, rect.y1),
  y1: Math.max(rect.y0, rect.y1),
});

/**
 * A marquee's catch. Keys inside it; and when it catches NO key, the SEGMENTS whose curve
 * it crosses select both their keys (Keyframer's rule: a box drawn over a flat stretch
 * means that stretch). Segment crossing is tested at the marquee's pixel columns.
 */
export function marquee(
  geometry: Geometry,
  lanes: readonly ResolvedLane[],
  rect: Rect,
  curveAt: (lane: ResolvedLane, ticks: number) => number,
): KeyRef[] {
  const box = normalize(rect);
  const inside = (point: { x: number; y: number }): boolean => point.x >= box.x0 && point.x <= box.x1 && point.y >= box.y0 && point.y <= box.y1;
  const caught: KeyRef[] = [];
  for (const lane of lanes) {
    for (const key of lane.keys) if (inside(keyPoint(geometry, lane, key.t, key.v))) caught.push({ lane: lane.lane.id, key: key.key.id });
  }
  if (caught.length > 0) return caught;
  for (const lane of lanes) {
    for (let index = 0; index + 1 < lane.keys.length; index += 1) {
      const a = lane.keys[index]!;
      const b = lane.keys[index + 1]!;
      const from = Math.max(box.x0, tickToX(geometry.view, a.t));
      const to = Math.min(box.x1, tickToX(geometry.view, b.t));
      for (let x = from; x <= to; x += 1) {
        const y = valueToY(geometry.view, geometry.height, displayValue(lane.lane, curveAt(lane, xToTick(geometry.view, x)), geometry.mode));
        if (y >= box.y0 && y <= box.y1) {
          caught.push({ lane: lane.lane.id, key: a.key.id }, { lane: lane.lane.id, key: b.key.id });
          break;
        }
      }
    }
  }
  return caught;
}
