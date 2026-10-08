import {
  freshId,
  isLaneName,
  newKey,
  newLane,
  parseAutomation,
  serializeAutomation,
  type AutomationDocument,
  type AutomationKey,
  type AutomationLane,
  type Handle,
  type HandleType,
  type Interpolation,
} from "@domain/automation/model.ts";
import { evaluateNormalized, resolveLane } from "@domain/automation/evaluate.ts";
import { snapTicksToFrame, TICKS_PER_SECOND, type FrameRate } from "@domain/time/ticks.ts";

/**
 * VN62 — EDITS TO AN AUTOMATION DOCUMENT, PURE.
 *
 * Every gesture in the timeline is one of these, applied to the document the gesture
 * STARTED from (never to the previous frame's result, so a drag back to where it began
 * writes the original bytes and the editor skips the write). The pane serializes the
 * result and sends ONE `setParameters` on the node's `lanes` per gesture.
 *
 * Selection is by stable id (`KeyRef`), never by index, so it survives undo and every
 * other edit (Keyframer's indices went stale).
 *
 * Keyframer's rules kept: keys never cross and never share a tick (a move CLAMPS against
 * the unselected neighbours, so a group moves as one unit and keeps its spacing, where
 * Keyframer compressed it); a lane never drops below one key; a locked lane refuses edits.
 * Anything that would break VN61's invariants is refused by validating the result, so no
 * edit can write a document the node would refuse to read.
 */

export interface KeyRef {
  readonly lane: string;
  readonly key: string;
}

export type Selection = readonly KeyRef[];

export const sameRef = (a: KeyRef, b: KeyRef): boolean => a.lane === b.lane && a.key === b.key;

/** Does this document still satisfy every invariant the node reads by? */
export function isValidDocument(document: AutomationDocument): boolean {
  return parseAutomation(serializeAutomation(document)).ok;
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

function selectedIn(lane: AutomationLane, selection: Selection): Set<string> {
  const keys = new Set<string>();
  if (lane.lock) return keys;
  for (const ref of selection) if (ref.lane === lane.id) keys.add(ref.key);
  return keys;
}

const mapLanes = (document: AutomationDocument, map: (lane: AutomationLane) => AutomationLane): AutomationDocument => ({
  ...document,
  lanes: document.lanes.map(map),
});

/** Snapping while editing (storage stays ticks; VN61). Markers join in VN67, beats in VN68. */
export type SnapMode = "off" | "frames" | "seconds";

export function snapTicks(ticks: number, mode: SnapMode, rate: FrameRate): number {
  if (mode === "frames") return snapTicksToFrame(ticks, rate);
  if (mode === "seconds") return Math.round(ticks / TICKS_PER_SECOND) * TICKS_PER_SECOND;
  return Math.round(ticks);
}

/**
 * Insert a key at `t` (whole ticks) on one lane. `v` absent = the curve's value there, so
 * inserting does not change the shape (Alt-Ctrl-click on all lanes). A key already on that
 * tick takes the value instead of a second key landing beside it.
 */
export function insertKey(document: AutomationDocument, laneId: string, t: number, v?: number): { document: AutomationDocument; ref: KeyRef | null } {
  const lane = document.lanes.find((each) => each.id === laneId);
  if (lane === undefined || lane.lock) return { document, ref: null };
  const tick = Math.round(t);
  const value = clamp01(v ?? evaluateNormalized(resolveLane({ ...lane, mute: false }), tick));
  const existing = lane.keys.find((key) => key.t === tick);
  if (existing !== undefined) {
    return {
      document: mapLanes(document, (each) => (each.id === laneId ? { ...each, keys: each.keys.map((key) => (key.id === existing.id ? { ...key, v: value } : key)) } : each)),
      ref: { lane: laneId, key: existing.id },
    };
  }
  const id = freshId("key", lane.keys.map((key) => key.id));
  // The new key takes its neighbour's interpolation, so inserting into a linear run stays linear.
  const before = [...lane.keys].reverse().find((key) => key.t < tick);
  const key = newKey(id, tick, value, before === undefined ? {} : { interp: before.interp, power: before.power });
  const keys = [...lane.keys, key].sort((a, b) => a.t - b.t);
  return { document: mapLanes(document, (each) => (each.id === laneId ? { ...each, keys } : each)), ref: { lane: laneId, key: id } };
}

/** Alt-Ctrl-click: a key at `t` on EVERY unlocked lane, each on its own curve. */
export function insertKeyOnAllLanes(document: AutomationDocument, t: number): { document: AutomationDocument; refs: KeyRef[] } {
  let current = document;
  const refs: KeyRef[] = [];
  for (const lane of document.lanes) {
    const inserted = insertKey(current, lane.id, t);
    current = inserted.document;
    if (inserted.ref !== null) refs.push(inserted.ref);
  }
  return { document: current, refs };
}

/**
 * Move the selected keys by (dt ticks, dv normalized) as ONE unit. `dt` is clamped so no
 * selected key reaches an unselected neighbour (the whole group stops together, so its
 * spacing is kept), and `dv` so every selected value stays in 0..1. Returns the clamped
 * deltas actually applied, for the readout.
 */
export function moveKeys(document: AutomationDocument, selection: Selection, dt: number, dv: number): { document: AutomationDocument; dt: number; dv: number } {
  let low = -Infinity;
  let high = Infinity;
  let vLow = -Infinity;
  let vHigh = Infinity;
  let any = false;
  for (const lane of document.lanes) {
    const chosen = selectedIn(lane, selection);
    lane.keys.forEach((key, index) => {
      if (!chosen.has(key.id)) return;
      any = true;
      const previous = lane.keys[index - 1];
      const next = lane.keys[index + 1];
      if (previous !== undefined && !chosen.has(previous.id)) low = Math.max(low, previous.t + 1 - key.t);
      if (next !== undefined && !chosen.has(next.id)) high = Math.min(high, next.t - 1 - key.t);
      vLow = Math.max(vLow, -key.v);
      vHigh = Math.min(vHigh, 1 - key.v);
    });
  }
  if (!any) return { document, dt: 0, dv: 0 };
  const appliedT = Math.round(Math.min(high, Math.max(low, dt)));
  const appliedV = Math.min(vHigh, Math.max(vLow, dv));
  if (appliedT === 0 && appliedV === 0) return { document, dt: 0, dv: 0 };
  const moved = mapLanes(document, (lane) => {
    const chosen = selectedIn(lane, selection);
    if (chosen.size === 0) return lane;
    return { ...lane, keys: lane.keys.map((key) => (chosen.has(key.id) ? { ...key, t: key.t + appliedT, v: clamp01(key.v + appliedV) } : key)) };
  });
  return { document: moved, dt: appliedT, dv: appliedV };
}

/**
 * Scale the selection about a pivot: time by `sx` (D), value by `sy` (F), both together.
 * Handles scale with their keys. Refused (the document comes back unchanged) when the
 * result would cross keys or collapse two onto one tick; values are held in 0..1.
 */
export function scaleKeys(document: AutomationDocument, selection: Selection, pivotT: number, pivotV: number, sx: number, sy: number): AutomationDocument {
  if (!(sx > 0) || !Number.isFinite(sy)) return document;
  const scaled = mapLanes(document, (lane) => {
    const chosen = selectedIn(lane, selection);
    if (chosen.size === 0) return lane;
    const keys = lane.keys.map((key) => {
      if (!chosen.has(key.id)) return key;
      const scaleHandle = (handle: Handle): Handle => [handle[0] * sx, handle[1] * sy];
      return { ...key, t: Math.round(pivotT + (key.t - pivotT) * sx), v: clamp01(pivotV + (key.v - pivotV) * sy), in: scaleHandle(key.in), out: scaleHandle(key.out) };
    });
    return { ...lane, keys };
  });
  return isValidDocument(scaled) ? scaled : document;
}

/**
 * Drag one handle to (dt, dv). Dragging a DERIVED handle (auto, auto-clamped, vector)
 * makes it `aligned`, Blender's rule, so the drag means what it shows. An aligned key's
 * other handle turns to stay collinear, keeping its own length. The dragged handle's Δt is
 * held on its own side of the key (an out handle cannot point back).
 */
export function setHandle(document: AutomationDocument, ref: KeyRef, side: "in" | "out", handle: Handle): AutomationDocument {
  return mapLanes(document, (lane) => {
    if (lane.id !== ref.lane || lane.lock) return lane;
    const resolved = resolveLane(lane);
    return {
      ...lane,
      keys: lane.keys.map((key, index) => {
        if (key.id !== ref.key) return key;
        const effective = resolved.keys[index]!;
        const dt = side === "out" ? Math.max(0, handle[0]) : Math.min(0, handle[0]);
        const dragged: Handle = [dt, handle[1]];
        const type: HandleType = key.handle === "free" ? "free" : "aligned";
        const other = side === "out" ? effective.in : effective.out;
        let opposite: Handle = other;
        if (type === "aligned") {
          const length = Math.hypot(other[0], other[1]);
          const own = Math.hypot(dragged[0], dragged[1]);
          opposite = own === 0 ? other : [(-dragged[0] / own) * length, (-dragged[1] / own) * length];
        }
        const effectiveIn = side === "in" ? dragged : opposite;
        const effectiveOut = side === "out" ? dragged : opposite;
        return { ...key, handle: type, in: effectiveIn, out: effectiveOut };
      }),
    };
  });
}

/** T: unify (aligned, the in handle turned to match the out) or break (free) the selected keys' handles. */
export function setHandlesLinked(document: AutomationDocument, selection: Selection, linked: boolean): AutomationDocument {
  return mapLanes(document, (lane) => {
    const chosen = selectedIn(lane, selection);
    if (chosen.size === 0) return lane;
    const resolved = resolveLane(lane);
    return {
      ...lane,
      keys: lane.keys.map((key, index) => {
        if (!chosen.has(key.id)) return key;
        const effective = resolved.keys[index]!;
        if (!linked) return { ...key, handle: "free" as const, in: effective.in, out: effective.out };
        const out = effective.out;
        const inLength = Math.hypot(effective.in[0], effective.in[1]);
        const outLength = Math.hypot(out[0], out[1]);
        const inHandle: Handle = outLength === 0 ? effective.in : [(-out[0] / outLength) * inLength, (-out[1] / outLength) * inLength];
        return { ...key, handle: "aligned" as const, in: inHandle, out };
      }),
    };
  });
}

export function setInterpolation(document: AutomationDocument, selection: Selection, interp: Interpolation): AutomationDocument {
  return mapLanes(document, (lane) => {
    const chosen = selectedIn(lane, selection);
    return chosen.size === 0 ? lane : { ...lane, keys: lane.keys.map((key) => (chosen.has(key.id) ? { ...key, interp } : key)) };
  });
}

export function setHandleType(document: AutomationDocument, selection: Selection, handle: HandleType): AutomationDocument {
  return mapLanes(document, (lane) => {
    const chosen = selectedIn(lane, selection);
    if (chosen.size === 0) return lane;
    const resolved = resolveLane(lane);
    // Switching to free/aligned starts from what was DRAWN, so the curve does not jump.
    return { ...lane, keys: lane.keys.map((key, index) => (chosen.has(key.id) ? { ...key, handle, in: resolved.keys[index]!.in, out: resolved.keys[index]!.out } : key)) };
  });
}

/**
 * Delete the selected keys. A lane never drops below one key: when every key of a lane is
 * selected, its earliest stays, and `kept` names it so the pane can say so (Keyframer
 * dropped lanes below two keys and broke them).
 */
export function deleteKeys(document: AutomationDocument, selection: Selection): { document: AutomationDocument; kept: KeyRef[] } {
  const kept: KeyRef[] = [];
  const next = mapLanes(document, (lane) => {
    const chosen = selectedIn(lane, selection);
    if (chosen.size === 0) return lane;
    let keys = lane.keys.filter((key) => !chosen.has(key.id));
    if (keys.length === 0) {
      keys = [lane.keys[0]!];
      kept.push({ lane: lane.id, key: lane.keys[0]!.id });
    }
    return { ...lane, keys };
  });
  return { document: next, kept };
}

/** Copied keys: per source lane, times relative to the EARLIEST copied key. */
export interface KeyClipboard {
  readonly lanes: readonly { readonly lane: string; readonly keys: readonly AutomationKey[] }[];
}

export function copyKeys(document: AutomationDocument, selection: Selection): KeyClipboard | null {
  let earliest = Infinity;
  const lanes: { lane: string; keys: AutomationKey[] }[] = [];
  for (const lane of document.lanes) {
    const chosen = new Set(selection.filter((ref) => ref.lane === lane.id).map((ref) => ref.key));
    const keys = lane.keys.filter((key) => chosen.has(key.id));
    if (keys.length === 0) continue;
    earliest = Math.min(earliest, keys[0]!.t);
    lanes.push({ lane: lane.id, keys });
  }
  if (lanes.length === 0) return null;
  return { lanes: lanes.map((entry) => ({ lane: entry.lane, keys: entry.keys.map((key) => ({ ...key, t: key.t - earliest })) })) };
}

/**
 * Paste at the cursor (`atTicks`), relative to the earliest copied key. Each lane's keys
 * go back to the lane they came from when it still exists, else to `fallbackLane`; a pasted
 * key replaces a key on the same tick. New ids, so a paste never aliases its source.
 */
export function pasteKeys(document: AutomationDocument, clipboard: KeyClipboard, atTicks: number, fallbackLane: string | null): { document: AutomationDocument; refs: KeyRef[] } {
  const refs: KeyRef[] = [];
  let current = document;
  for (const entry of clipboard.lanes) {
    const target = current.lanes.find((lane) => lane.id === entry.lane) ?? current.lanes.find((lane) => lane.id === fallbackLane);
    if (target === undefined || target.lock) continue;
    const offset = Math.round(atTicks);
    const incoming = entry.keys.map((key) => key.t + offset);
    const keep = target.keys.filter((key) => !incoming.includes(key.t));
    const taken = keep.map((key) => key.id);
    const pasted = entry.keys.map((key) => {
      const id = freshId("key", taken);
      taken.push(id);
      refs.push({ lane: target.id, key: id });
      return { ...key, id, t: key.t + offset };
    });
    const keys = [...keep, ...pasted].sort((a, b) => a.t - b.t);
    current = mapLanes(current, (lane) => (lane.id === target.id ? { ...lane, keys } : lane));
  }
  return isValidDocument(current) ? { document: current, refs } : { document, refs: [] };
}

/** Tab stepping: the next (or previous) key in time across the given lanes, wrapping. */
export function stepKey(document: AutomationDocument, from: KeyRef | null, direction: 1 | -1, lanes?: ReadonlySet<string>): KeyRef | null {
  const all: (KeyRef & { t: number })[] = [];
  document.lanes.forEach((lane, laneIndex) => {
    if (lanes !== undefined && !lanes.has(lane.id)) return;
    for (const key of lane.keys) all.push({ lane: lane.id, key: key.id, t: key.t * 1024 + laneIndex });
  });
  if (all.length === 0) return null;
  all.sort((a, b) => a.t - b.t);
  const index = from === null ? -1 : all.findIndex((entry) => sameRef(entry, from));
  const next = index < 0 ? (direction > 0 ? 0 : all.length - 1) : (index + direction + all.length) % all.length;
  const entry = all[next]!;
  return { lane: entry.lane, key: entry.key };
}

/** Nudge multipliers by modifier: none ×1, Shift ×2, Alt ×4, Shift+Alt ×8 (Keyframer's). */
export function nudgeMultiplier(modifiers: { shiftKey: boolean; altKey: boolean }): number {
  return (modifiers.shiftKey ? 2 : 1) * (modifiers.altKey ? 4 : 1);
}

// ── Lanes ─────────────────────────────────────────────────────────────────────────────

/** The palette new lanes cycle through: token names, read as `--<name>` (§V17). */
export const LANE_PALETTE = ["signal", "axis-z", "axis-y", "axis-x", "port-buffer", "port-vector", "port-pointset", "port-camera", "component", "port-material"] as const;

/** A free lane name: `base` when free, else `base2`, `base3` … */
export function freshLaneName(document: AutomationDocument, base = "lane"): string {
  const taken = new Set(document.lanes.map((lane) => lane.name));
  if (!taken.has(base) && isLaneName(base)) return base;
  for (let ordinal = 1; ; ordinal += 1) if (!taken.has(`${base}${ordinal}`)) return `${base}${ordinal}`;
}

/** A new lane with one key at `atTicks` holding `v` (0.5 by default). */
export function addLane(document: AutomationDocument, atTicks: number, options: { name?: string; v?: number; min?: number; max?: number } = {}): { document: AutomationDocument; laneId: string } {
  const laneId = freshId("lane", document.lanes.map((lane) => lane.id));
  const color = LANE_PALETTE[document.lanes.length % LANE_PALETTE.length]!;
  const lane = newLane(laneId, freshLaneName(document, options.name ?? "lane"), [newKey("key1", Math.max(0, Math.round(atTicks)), clamp01(options.v ?? 0.5))], {
    color,
    ...(options.min === undefined ? {} : { min: options.min }),
    ...(options.max === undefined ? {} : { max: options.max }),
  });
  return { document: { ...document, lanes: [...document.lanes, lane] }, laneId };
}

export function deleteLane(document: AutomationDocument, laneId: string): AutomationDocument {
  return { ...document, lanes: document.lanes.filter((lane) => lane.id !== laneId) };
}

/** Move a lane to `index` in the list (the channel order a reader enumerates). */
export function moveLane(document: AutomationDocument, laneId: string, index: number): AutomationDocument {
  const from = document.lanes.findIndex((lane) => lane.id === laneId);
  if (from < 0) return document;
  const lanes = [...document.lanes];
  const [lane] = lanes.splice(from, 1);
  lanes.splice(Math.max(0, Math.min(lanes.length, index)), 0, lane!);
  return { ...document, lanes };
}

/** Lane properties the list edits directly. Name has its own path (references follow it). */
export type LaneProps = Partial<Pick<AutomationLane, "color" | "lock" | "min" | "max" | "clamp" | "pre" | "post" | "stepped">>;

export function setLaneProps(document: AutomationDocument, laneId: string, props: LaneProps): AutomationDocument {
  const next = mapLanes(document, (lane) => (lane.id === laneId ? { ...lane, ...props } : lane));
  return isValidDocument(next) ? next : document;
}

/**
 * Set one key's time and/or normalized value exactly (the table view). Goes through
 * `moveKeys`, so a time typed past a neighbour stops one tick short of it rather than
 * crossing, and a value is held in 0..1.
 */
export function setKey(document: AutomationDocument, ref: KeyRef, change: { t?: number; v?: number }): AutomationDocument {
  const key = document.lanes.find((lane) => lane.id === ref.lane)?.keys.find((each) => each.id === ref.key);
  if (key === undefined) return document;
  const dt = change.t === undefined ? 0 : Math.round(change.t) - key.t;
  const dv = change.v === undefined ? 0 : change.v - key.v;
  return moveKeys(document, [ref], dt, dv).document;
}
