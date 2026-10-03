import { describe, expect, it } from "vitest";
import type { NodeId } from "@domain/types/ids.ts";
import { orderSelection, primaryOf, promoteInSelection } from "./selection-order.ts";

/**
 * T1531b — the rule the inspector's subject comes from. React Flow reports a selection in
 * its own node order (here: a, b, c, d); every case below would answer differently if that
 * order leaked through.
 */
const ids = (...names: string[]) => names as NodeId[];

describe("T1531b — the selection keeps the order it was made in, primary last", () => {
  it("a node joining alone becomes the primary, whatever its canvas position", () => {
    const one = orderSelection([], ids("c"));
    const two = orderSelection(one, ids("a", "c"));
    expect(two).toEqual(ids("c", "a"));
    expect(primaryOf(two)).toBe("a");
  });

  it("when the primary leaves, the most recently added node still selected takes over", () => {
    const made = orderSelection(orderSelection(orderSelection([], ids("b")), ids("a", "b")), ids("a", "b", "d"));
    expect(primaryOf(made)).toBe("d");
    expect(primaryOf(orderSelection(made, ids("a", "b")))).toBe("a");
  });

  it("several joining at once (select all) leave a still-selected primary in place", () => {
    const made = orderSelection([], ids("b"));
    expect(orderSelection(made, ids("a", "b", "c", "d"))).toEqual(ids("a", "c", "d", "b"));
  });

  it("several joining with no primary left (a paste, a marquee) end on the last in canvas order", () => {
    expect(primaryOf(orderSelection(ids("b"), ids("c", "d")))).toBe("d");
  });

  it("the same set reported again — React Flow re-firing in its own order — changes nothing", () => {
    const made = ids("d", "a");
    expect(orderSelection(made, ids("a", "d"))).toBe(made);
  });

  it("a click on a selected node promotes it; on an unselected or already-primary node it does nothing", () => {
    const made = ids("a", "b", "c");
    expect(promoteInSelection(made, "a")).toEqual(ids("b", "c", "a"));
    expect(promoteInSelection(made, "c")).toBe(made);
    expect(promoteInSelection(made, "d")).toBe(made);
  });
});
