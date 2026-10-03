import { describe, expect, it } from "vitest";
import { createDisplaySinkStore, mergeSinkStores } from "./display-sinks.ts";
import { createPreviewSinkStore } from "./preview-sinks.ts";

/**
 * §T1391b — the compile's sink list is the preview sinks plus the shown Window Outs. The
 * compile memo keys on the list's IDENTITY, so an unchanged set must hand back the same
 * array (no recompile), and an open or close must hand back a new one (a recompile).
 */
describe("display sinks", () => {
  it("forwards independent preview owners through the merged store", () => {
    let clock = 0;
    const merged = mergeSinkStores(createPreviewSinkStore(() => clock, 0), createDisplaySinkStore());
    const tiles = {}, background = {};
    merged.set([{ nodeId: "tile", portId: "out" }], tiles);
    merged.set([{ nodeId: "background", portId: "out" }], background);
    merged.set([], background);
    clock = 1500;
    merged.set([], background);
    expect(merged.get().map(sink => sink.nodeId)).toEqual(["tile"]);
  });
  it("names each shown Window Out as an output sink, sorted and de-duplicated", () => {
    const store = createDisplaySinkStore();
    store.set(["win2", "win1", "win2"]);
    expect(store.get()).toEqual([
      { nodeId: "win1", kind: "output" },
      { nodeId: "win2", kind: "output" },
    ]);
  });

  it("notifies only when the set really changes", () => {
    const store = createDisplaySinkStore();
    let heard = 0;
    store.subscribe(() => {
      heard += 1;
    });
    store.set(["a"]);
    const first = store.get();
    store.set(["a"]);
    expect(heard).toBe(1);
    expect(store.get()).toBe(first);
    store.set([]);
    expect(heard).toBe(2);
    expect(store.get()).toEqual([]);
  });

  it("merges after the previews, keeping identity until either half changes", () => {
    const previews = createPreviewSinkStore();
    const display = createDisplaySinkStore();
    const merged = mergeSinkStores(previews, display);
    const empty = merged.get();
    expect(merged.get()).toBe(empty);
    let heard = 0;
    merged.subscribe(() => {
      heard += 1;
    });
    display.set(["win"]);
    expect(heard).toBe(1);
    const shown = merged.get();
    expect(shown).toContainEqual({ nodeId: "win", kind: "output" });
    expect(merged.get()).toBe(shown);
    display.set([]);
    expect(merged.get()).not.toContainEqual({ nodeId: "win", kind: "output" });
  });
});
