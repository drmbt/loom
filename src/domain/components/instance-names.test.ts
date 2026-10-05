import { describe, expect, it } from "vitest";

import { alice, contextFor } from "../commands/test-support.ts";
import type { ParameterSlot } from "../types/parameters.ts";
import { componentNodeType } from "./component-type.ts";
import { blurKnob, bloomComponent, createComponentHarness, graphOf, node } from "./test-support.ts";

/**
 * A COMPONENT INSTANCE IS NAMED FOR ITS COMPONENT (T1593b, ruled 2026-10-05).
 *
 * An instance of Bloom is `bloom1` when it is made and `bloom_glow` when it is renamed. Two
 * things changed, and each is asserted as the name THE DOCUMENT holds:
 *
 *  - the kind is the component's own NAME, not `comp` and not the id in its type. A saved
 *    component's id is minted (`cmp_7`), so the id says nothing a reader can use;
 *  - a new instance is NAMED. It used to be left unnamed, which made it the one new node an
 *    `op('…')` could not address until someone renamed it.
 *
 * Through the real component commands and the real bus.
 */

const ctx = contextFor(alice);

function expressionSlot(source: string, retained: number): ParameterSlot {
  return {
    mode: "expression",
    bindings: { static: { kind: "static", value: retained }, expression: { kind: "expression", source } },
  };
}

describe("a new component instance is named for its component", () => {
  it("names the first `bloom1` and the next `bloom2`", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const nameOf = (id: string | null) => harness.store.view.getGraph().nodes[id as string]?.label;

    const first = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    const second = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);

    expect(nameOf(first.output.nodeId)).toBe("bloom1");
    expect(nameOf(second.output.nodeId)).toBe("bloom2");
  });

  it("reads the kind from the component's NAME, not from the id its type carries", async () => {
    const harness = createComponentHarness();
    // The id a saved component really gets is minted, and says nothing.
    harness.components.register({ ...bloomComponent("cmp_7", 1, [blurKnob]), name: "Depth Points" });

    const placed = await harness.bus.execute("component.instantiate", { componentId: "cmp_7" }, ctx);

    expect(harness.store.view.getGraph().nodes[placed.output.nodeId as string]?.label).toBe("depthpoints1");
  });

  /*
   * The point of naming it at all: the name is the reference currency (§V129), so the new
   * instance can be read by `op('…')` at once, and a rename carries that reference with it.
   * An unnamed instance could not be the target of either.
   */
  it("is addressable by op('…') from the moment it exists, and a rename keeps the kind and the reference", async () => {
    const harness = createComponentHarness("t", graphOf([node("reader", "test.blur", { radius: 2 })]));
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const placed = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    const instanceId = placed.output.nodeId as string;
    await harness.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: harness.store.view.getRevision(),
        operations: [
          { op: "setParameters", nodeId: "reader", parameters: { radius: expressionSlot("op('bloom1').par.blur", 2) } },
        ],
      },
      ctx,
    );

    const renamed = await harness.bus.execute("node.rename", { nodeId: instanceId, label: "glow" }, ctx);

    expect(renamed.status).toBe("applied");
    expect(harness.store.view.getGraph().nodes[instanceId]?.label).toBe("bloom_glow");
    const radius = harness.store.view.getGraph().nodes["reader"]?.parameters["radius"] as ParameterSlot;
    expect(radius.bindings.expression).toEqual({ kind: "expression", source: "op('bloom_glow').par.blur" });
  });

  it("names an instance added by a patch operation the same way", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));

    const added = await harness.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: harness.store.view.getRevision(),
        operations: [{ op: "addNode", ref: "$i", type: componentNodeType("bloom", 1), position: { x: 0, y: 0 } }],
      },
      ctx,
    );

    expect(harness.store.view.getGraph().nodes[added.output.createdIds["$i"] as string]?.label).toBe("bloom1");
  });

  /*
   * THE ONE DOOR NOT YET NAMED, pinned so that it is a known gap and not a forgotten one
   * (T1593b phase 2). The instance a saved selection becomes should be `doubleblur1`.
   *
   * It is not, because every shipped starter component is authored through this command
   * and ships the host document it leaves behind: naming the instance here adds a line to
   * each of the 12 files under `examples/components/` (`component-sync.test.ts` holds their
   * bytes), and phase 1b may not change a shipped byte. The sweep regenerates those files;
   * the line in `commands.ts` and this expectation change with them, to "doubleblur1".
   */
  it("does not yet name the instance a saved selection becomes: that waits for the sweep", async () => {
    const harness = createComponentHarness(
      "t",
      graphOf([
        node("b1", "test.blur", { radius: 2 }, { position: { x: 100, y: 0 } }),
        node("b2", "test.blur", { radius: 8 }, { position: { x: 200, y: 0 } }),
      ]),
    );

    const saved = await harness.bus.execute(
      "component.saveSelection",
      { nodeIds: ["b1", "b2"], name: "Double Blur" },
      ctx,
    );

    expect(saved.status).toBe("applied");
    const nodes = Object.values(harness.store.view.getGraph().nodes);
    // The selection is gone and one instance stands where it was.
    expect(nodes.map((each) => each.type.startsWith("component:"))).toEqual([true]);
    expect(nodes[0]?.label).toBeUndefined();
  });

  /*
   * A component may share a word with a built-in kind: one called "Blur" makes instances
   * of kind `blur`, and to the reader it is that kind of thing. What must still hold is
   * that two nodes never get one name, so they are numbered in ONE sequence.
   */
  it("numbers an instance in the same sequence as a built-in node of the same kind", async () => {
    const harness = createComponentHarness();
    harness.components.register({ ...bloomComponent("soft", 1, [blurKnob]), name: "Blur" });
    const builtIn = await harness.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: harness.store.view.getRevision(),
        operations: [{ op: "addNode", ref: "$b", type: "test.blur", position: { x: 0, y: 0 } }],
      },
      ctx,
    );
    const placed = await harness.bus.execute("component.instantiate", { componentId: "soft" }, ctx);

    const graph = harness.store.view.getGraph();
    expect(graph.nodes[builtIn.output.createdIds["$b"] as string]?.label).toBe("blur1");
    expect(graph.nodes[placed.output.nodeId as string]?.label).toBe("blur2");
  });

  /*
   * STORED NAMES NEVER MOVE. A component that comes back under another name (a new
   * version here) names its NEXT instance for the new name. The instance made under the
   * old one keeps its name, and the reference to it still resolves.
   */
  it("when the component is renamed, the old instance keeps its name and the next one takes the new", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    const old = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);

    harness.components.register({ ...bloomComponent("bloom", 2, [blurKnob]), name: "Glow Stack" });
    const fresh = await harness.bus.execute("component.instantiate", { componentId: "bloom", version: 2 }, ctx);

    const graph = harness.store.view.getGraph();
    expect(graph.nodes[old.output.nodeId as string]?.label).toBe("bloom1");
    expect(graph.nodes[fresh.output.nodeId as string]?.label).toBe("glowstack1");
  });

  it("is one undo step: the instance and its name go together", async () => {
    const harness = createComponentHarness();
    harness.components.register(bloomComponent("bloom", 1, [blurKnob]));
    await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    await harness.bus.execute("graph.undo", {}, ctx);
    expect(Object.keys(harness.store.view.getGraph().nodes)).toEqual([]);

    // And the number it held is free again for the next one.
    const again = await harness.bus.execute("component.instantiate", { componentId: "bloom" }, ctx);
    expect(harness.store.view.getGraph().nodes[again.output.nodeId as string]?.label).toBe("bloom1");
  });
});
