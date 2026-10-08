import { describe, expect, it } from "vitest";

import { resolveLane } from "@domain/automation/evaluate.ts";
import { newKey, newLane, type AutomationDocument } from "@domain/automation/model.ts";
import { dopeHit, dopeRows, refsAtTicks, retimeColumns, DOPE_ROW_HEIGHT } from "./dope-sheet.ts";
import { setKey } from "./timeline-edits.ts";
import { hitBox, selectionBox } from "./timeline-hit.ts";
import type { AutomationNodeView } from "./timeline-model.ts";

const S = 240_000;
const view = { startTicks: 0, ticksPerPixel: S / 100, valueLow: 0, valueHigh: 1 };
const one: AutomationDocument = { version: 1, lanes: [newLane("a", "a", [newKey("k1", 0, 0), newKey("k2", S, 1)]), newLane("b", "b", [newKey("k1", S, 0), newKey("k2", 3 * S, 1)])] };
const two: AutomationDocument = { version: 1, lanes: [newLane("c", "c", [newKey("k1", S, 0.2), newKey("k2", S + 10_000, 0.4)])] };
const nodeView = (id: string, document: AutomationDocument): AutomationNodeView => ({ id, name: `automation_${id}`, document, error: null, editable: true });

describe("VN62 — the dope sheet", () => {
  it("rows: a summary of every node's ticks, then one per node", () => {
    const rows = dopeRows([nodeView("x", one), nodeView("y", two)]);
    expect(rows.map((row) => [row.id, row.columns])).toEqual([
      ["summary", [0, S, S + 10_000, 3 * S]],
      ["x", [0, S, 3 * S]],
      ["y", [S, S + 10_000]],
    ]);
    expect(dopeHit(view, rows, 101, DOPE_ROW_HEIGHT * 2 + 3)).toEqual({ row: rows[2], tick: S });
    expect(dopeHit(view, rows, 50, 3)).toBeNull();
    expect(refsAtTicks(one, new Set([S]))).toEqual([{ lane: "a", key: "k2" }, { lane: "b", key: "k1" }]);
  });

  it("retimes a column across nodes by ONE distance: the tightest clamp wins", () => {
    const documents = new Map([["x", one], ["y", two]]);
    // Moving tick S forward: in y, k1 at S stops one tick before k2 at S + 10 000.
    const retimed = retimeColumns(documents, new Set([S]), 50_000);
    expect(retimed.dt).toBe(9_999);
    expect(retimed.documents.get("x")!.lanes.map((lane) => lane.keys.map((key) => key.t))).toEqual([[0, S + 9_999], [S + 9_999, 3 * S]]);
    expect(retimed.documents.get("y")!.lanes[0]!.keys.map((key) => key.t)).toEqual([S + 9_999, S + 10_000]);
    expect(retimeColumns(documents, new Set([12345]), 1000).documents.size).toBe(0);
  });
});

describe("VN62 — the box transform and the table's exact edit", () => {
  const geometry = { view, height: 100, mode: "normalized" as const };
  it("boxes two or more selected keys and finds its edges", () => {
    const lanes = one.lanes.map(resolveLane);
    const box = selectionBox(geometry, lanes, [{ lane: "a", key: "k1" }, { lane: "b", key: "k2" }]);
    expect(box).toEqual({ x0: 0, y0: 0, x1: 300, y1: 100 });
    expect(selectionBox(geometry, lanes, [{ lane: "a", key: "k1" }])).toBeNull();
    expect([hitBox(box!, 301, 50), hitBox(box!, -2, 50), hitBox(box!, 150, 2), hitBox(box!, 150, 99), hitBox(box!, 150, 50)]).toEqual(["right", "left", "top", "bottom", null]);
  });

  it("setKey moves a key exactly, and never past a neighbour", () => {
    expect(setKey(one, { lane: "b", key: "k1" }, { t: 2 * S, v: 0.25 }).lanes[1]!.keys[0]).toMatchObject({ t: 2 * S, v: 0.25 });
    expect(setKey(one, { lane: "b", key: "k1" }, { t: 9 * S }).lanes[1]!.keys[0]!.t).toBe(3 * S - 1);
  });
});
