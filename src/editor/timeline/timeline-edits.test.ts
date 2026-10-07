import { describe, expect, it } from "vitest";

import { newKey, newLane, type AutomationDocument } from "@domain/automation/model.ts";
import { resolveLane } from "@domain/automation/evaluate.ts";
import { rateOf } from "@domain/time/ticks.ts";
import {
  addLane,
  copyKeys,
  deleteKeys,
  freshLaneName,
  insertKey,
  insertKeyOnAllLanes,
  isValidDocument,
  moveKeys,
  moveLane,
  nudgeMultiplier,
  pasteKeys,
  scaleKeys,
  setHandle,
  setHandlesLinked,
  snapTicks,
  stepKey,
} from "./timeline-edits.ts";

const S = 240_000;
const doc = (): AutomationDocument => ({
  version: 1,
  lanes: [
    newLane("a", "alpha", [newKey("k1", 0, 0, { interp: "linear" }), newKey("k2", S, 0.5, { interp: "linear" }), newKey("k3", 2 * S, 1)]),
    newLane("b", "beta", [newKey("k1", 0, 1), newKey("k2", 3 * S, 0)]),
  ],
});
const times = (document: AutomationDocument, lane: string): number[] => document.lanes.find((each) => each.id === lane)!.keys.map((key) => key.t);

describe("VN62 — timeline edits", () => {
  it("inserts on the curve without changing its shape, and onto an existing tick by value", () => {
    const inserted = insertKey(doc(), "a", S / 2);
    expect(inserted.ref).toEqual({ lane: "a", key: "key1" });
    const lane = inserted.document.lanes[0]!;
    expect(lane.keys.map((key) => [key.t, key.v])).toEqual([[0, 0], [S / 2, 0.25], [S, 0.5], [2 * S, 1]]);
    expect(lane.keys[1]!.interp).toBe("linear");
    const onto = insertKey(doc(), "a", S, 0.9);
    expect(onto.ref).toEqual({ lane: "a", key: "k2" });
    expect(times(onto.document, "a")).toEqual([0, S, 2 * S]);
    expect(onto.document.lanes[0]!.keys[1]!.v).toBe(0.9);
    expect(insertKeyOnAllLanes(doc(), S / 2).refs).toHaveLength(2);
  });

  it("moves a group as ONE unit: clamped at the unselected neighbour, spacing kept, never crossing", () => {
    const selection = [{ lane: "a", key: "k1" }, { lane: "a", key: "k2" }];
    const moved = moveKeys(doc(), selection, 5 * S, 0);
    // k2 stops one tick before k3; k1 moves the same distance, so the pair keeps its spacing.
    expect(moved.dt).toBe(S - 1);
    expect(times(moved.document, "a")).toEqual([S - 1, 2 * S - 1, 2 * S]);
    expect(isValidDocument(moved.document)).toBe(true);
    // Value: the group stops when its highest key reaches 1.
    expect(moveKeys(doc(), selection, 0, 0.9).dv).toBe(0.5);
    // A move that clamps to nothing writes nothing.
    expect(moveKeys(doc(), [{ lane: "a", key: "k3" }], 0, 0.3).document).toEqual(doc());
  });

  it("a locked lane refuses edits", () => {
    const locked: AutomationDocument = { ...doc(), lanes: doc().lanes.map((lane) => (lane.id === "a" ? { ...lane, lock: true } : lane)) };
    expect(moveKeys(locked, [{ lane: "a", key: "k2" }], 100, 0).document).toBe(locked);
    expect(insertKey(locked, "a", 5).ref).toBeNull();
  });

  it("scales about a pivot, and refuses a scale that would cross keys", () => {
    const all = [{ lane: "a", key: "k1" }, { lane: "a", key: "k2" }, { lane: "a", key: "k3" }];
    expect(times(scaleKeys(doc(), all, 0, 0, 2, 1), "a")).toEqual([0, 2 * S, 4 * S]);
    expect(scaleKeys(doc(), all, 0, 0.5, 1, 0).lanes[0]!.keys.map((key) => key.v)).toEqual([0.5, 0.5, 0.5]);
    // Squeezing k2 alone past k3 is refused.
    expect(scaleKeys(doc(), [{ lane: "a", key: "k2" }], 0, 0, 3, 1)).toEqual(doc());
  });

  it("dragging an auto handle makes the key aligned and turns the other handle with it", () => {
    const dragged = setHandle(doc(), { lane: "a", key: "k2" }, "out", [S / 4, 0.1]);
    const key = dragged.lanes[0]!.keys[1]!;
    expect(key.handle).toBe("aligned");
    expect(key.out).toEqual([S / 4, 0.1]);
    // Collinear: the in handle points exactly the other way.
    expect(key.in[1] / key.in[0]).toBeCloseTo(0.1 / (S / 4), 15);
    // An out handle cannot point back.
    expect(setHandle(doc(), { lane: "a", key: "k2" }, "out", [-50, 0]).lanes[0]!.keys[1]!.out[0]).toBe(0);
    // T: break, then unify.
    const broken = setHandlesLinked(dragged, [{ lane: "a", key: "k2" }], false);
    expect(broken.lanes[0]!.keys[1]!.handle).toBe("free");
    expect(setHandlesLinked(broken, [{ lane: "a", key: "k2" }], true).lanes[0]!.keys[1]!.handle).toBe("aligned");
  });

  it("delete never leaves a lane without a key", () => {
    const all = doc().lanes[1]!.keys.map((key) => ({ lane: "b", key: key.id }));
    const deleted = deleteKeys(doc(), all);
    expect(times(deleted.document, "b")).toEqual([0]);
    expect(deleted.kept).toEqual([{ lane: "b", key: "k1" }]);
    expect(times(deleteKeys(doc(), [{ lane: "a", key: "k2" }]).document, "a")).toEqual([0, 2 * S]);
  });

  it("pastes at the cursor relative to the earliest copied key, with new ids", () => {
    const clipboard = copyKeys(doc(), [{ lane: "a", key: "k2" }, { lane: "a", key: "k3" }])!;
    const pasted = pasteKeys(doc(), clipboard, 5 * S, null);
    expect(times(pasted.document, "a")).toEqual([0, S, 2 * S, 5 * S, 6 * S]);
    expect(pasted.refs).toEqual([{ lane: "a", key: "key1" }, { lane: "a", key: "key2" }]);
    // Pasting onto ticks that hold keys replaces them.
    expect(times(pasteKeys(doc(), clipboard, S, null).document, "a")).toEqual([0, S, 2 * S]);
  });

  it("Tab steps through keys in time across lanes, wrapping", () => {
    expect(stepKey(doc(), null, 1)).toEqual({ lane: "a", key: "k1" });
    expect(stepKey(doc(), { lane: "a", key: "k1" }, 1)).toEqual({ lane: "b", key: "k1" });
    expect(stepKey(doc(), { lane: "b", key: "k2" }, 1)).toEqual({ lane: "a", key: "k1" });
    expect(stepKey(doc(), { lane: "a", key: "k1" }, -1)).toEqual({ lane: "b", key: "k2" });
  });

  it("snaps to frames and seconds; nudges multiply by modifier", () => {
    expect(snapTicks(12_345, "frames", rateOf(30))).toBe(16_000);
    expect(snapTicks(12_345, "frames", rateOf(29.97))).toBe(16_016);
    expect(snapTicks(130_000, "seconds", rateOf(30))).toBe(240_000);
    expect(snapTicks(12_345.4, "off", rateOf(30))).toBe(12_345);
    expect([nudgeMultiplier({ shiftKey: false, altKey: false }), nudgeMultiplier({ shiftKey: true, altKey: false }), nudgeMultiplier({ shiftKey: false, altKey: true }), nudgeMultiplier({ shiftKey: true, altKey: true })]).toEqual([1, 2, 4, 8]);
  });

  it("adds, names and reorders lanes", () => {
    const added = addLane(doc(), 1234.4, { name: "alpha" });
    const lane = added.document.lanes[2]!;
    expect([added.laneId, lane.name, lane.keys[0]!.t, lane.color]).toEqual(["lane1", "alpha1", 1234, "axis-y"]);
    expect(freshLaneName({ version: 1, lanes: [] })).toBe("lane");
    expect(moveLane(doc(), "b", 0).lanes.map((each) => each.id)).toEqual(["b", "a"]);
    expect(isValidDocument(added.document)).toBe(true);
    expect(resolveLane(lane).keys).toHaveLength(1);
  });
});
