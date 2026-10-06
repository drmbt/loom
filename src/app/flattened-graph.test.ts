import { describe, expect, it } from "vitest";

import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { ZERO_FRAME } from "@domain/types/frame.ts";
import { createComponentSystem } from "@domain/components/index.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import {
  animatedComponentDefinition,
  twoInstanceDocument,
} from "../tests/fixtures/animated-component.ts";
import { createFlattenedGraphSource } from "./flattened-graph.ts";

/**
 * THE MEMO — the half of T615 that is not optional (§V529).
 *
 * `flattenComponents` is a pure function of `(document, catalogue)` and costs several
 * times the value graph it feeds. Measured on ten instances of the animated fixture:
 * flattening alone is 9× the per-frame value graph, and running the correct code WITHOUT
 * this memo is 1.45× SLOWER per frame than the broken version it replaces. With it, the
 * same document costs 1.77× LESS than the broken version did.
 *
 * So this file gates the memo the way the behaviour gate gates the flattening: not "is it
 * fast" — a timing assertion is a flake — but the two properties speed is made of.
 *
 *   1. an unchanged document and catalogue return the SAME OBJECT. That is what makes the
 *      per-frame call a map lookup instead of a walk.
 *   2. a document edit, and a CATALOGUE edit with no document edit at all (§V210(c)),
 *      each produce a new one. A memo that never invalidates is a correctness bug wearing
 *      a performance fix's clothes — the host graph does not move when a component's
 *      internals are re-authored, so a document-only key would serve the old internals for
 *      ever.
 */

function harness() {
  const nodeRegistry = createNodeRegistry(allNodeDefinitions).view();
  const system = createComponentSystem(nodeRegistry);
  system.components.register(animatedComponentDefinition());
  const { bus } = createDomainBus({
    registry: system.nodes,
    initialGraph: twoInstanceDocument(),
  });
  const flattened = createFlattenedGraphSource({
    store: bus.store,
    registry: system.nodes,
    components: system.components,
  });
  return { bus, components: system.components, flattened };
}

describe("the flattened document is memoized per (document revision, catalogue revision)", () => {
  it("returns the SAME object while nothing has changed", () => {
    const { flattened } = harness();
    const first = flattened.current();
    expect(flattened.current()).toBe(first);
    expect(flattened.current()).toBe(first);
    // Non-vacuity: it is a real flattening and not an empty stub (§V461).
    expect(Object.keys(first.graph.nodes)).toContain("c1/wob");
    expect(Object.keys(first.graph.nodes)).toContain("c2/wob");
    flattened.dispose();
  });

  it("re-flattens after a DOCUMENT edit", async () => {
    const { bus, flattened } = harness();
    const before = flattened.current();
    const result = await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getGraph().revision,
        operations: [{ op: "setParameters", nodeId: "c1", parameters: { rate: 3 } }],
      },
      { actor: { kind: "human", id: "test", label: "Test" }, projectId: "p", capabilities: [] },
    );
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("applied");

    const after = flattened.current();
    expect(after).not.toBe(before);
    // And the new value actually reached the internals, which is what the memo must not
    // be allowed to hide.
    expect(after.graph.nodes["c1/wob"]?.parameters["frequency"]).toBe(3);
    flattened.dispose();
  });

  it("re-flattens after a CATALOGUE edit with NO document edit (§V210(c))", () => {
    const { bus, components, flattened } = harness();
    const before = flattened.current();
    const revision = bus.store.getGraph().revision;

    // Re-author the component AT THE SAME VERSION: every linked instance changes and the
    // host document does not move at all (§V79).
    const definition = animatedComponentDefinition();
    const wob = definition.graph.nodes["wob"];
    if (wob === undefined) throw new Error("fixture lost its LFO");
    definition.graph.nodes["wob"] = { ...wob, parameters: { ...wob.parameters, amplitude: 7 } };
    components.register(definition);

    const after = flattened.current();
    expect(bus.store.getGraph().revision).toBe(revision);
    expect(after).not.toBe(before);
    expect(after.graph.nodes["c1/wob"]?.parameters["amplitude"]).toBe(7);
    flattened.dispose();
  });

  it("stops listening once disposed, so a stale source cannot hold the catalogue open", () => {
    const { components, flattened } = harness();
    const first = flattened.current();
    flattened.dispose();
    // After dispose the subscription is gone; the object is inert rather than wrong —
    // nothing in the app calls it after `runtime.dispose()`.
    components.register(animatedComponentDefinition());
    expect(first.graph.nodes["c1/wob"]).toBeDefined();
  });
});

/**
 * T1668b — `structure`: THE SAME OBJECT FOR TWO FLATTENINGS THAT DIFFER IN VALUES ONLY.
 *
 * The value graph memoises who reads whom on it (0.6 ms of parsing a write on a 200-node
 * project, twice). A token kept across a revision that changed a reference would order the
 * value graph by yesterday's references, so both halves are held: a value keeps it, and
 * everything else — a new reference above all — does not. And the consequence is asserted
 * where it is read back: a Constant that begins to read another through a NEW expression
 * publishes that other's value in the very next evaluation.
 */
describe("T1668b: a flattening's `structure` is kept across values and across nothing else", () => {
  const actor = { actor: { kind: "human" as const, id: "test", label: "Test" }, projectId: "p", capabilities: [] };

  async function valueDocument() {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const system = createComponentSystem(registry);
    const { bus } = createDomainBus({ registry: system.nodes });
    const apply = async (operations: unknown[]) => {
      const result = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: operations as never, label: "edit" }, actor);
      expect(result.status, JSON.stringify(result.diagnostics).slice(0, 300)).toBe("applied");
      return result.output.createdIds as Record<string, string>;
    };
    // The READER is made first, so its id sorts first: nothing but the reference puts it after what it reads.
    const ids = await apply([
      { op: "addNode", ref: "$a", type: "constant", position: { x: 0, y: 0 }, label: "constant_a", parameters: { value: 1 } },
      { op: "addNode", ref: "$z", type: "constant", position: { x: 300, y: 0 }, label: "constant_z", parameters: { value: 3 } },
    ]);
    expect([ids["$a"], ids["$z"]].sort()[0], "the fixture's reader does not sort first").toBe(ids["$a"]);
    const flattened = createFlattenedGraphSource({ store: bus.store, registry: system.nodes, components: system.components });
    return { bus, apply, ids, flattened, components: system.components, registry: system.nodes };
  }

  it("a value written keeps it; a mode change, another expression, a node and a name do not", async () => {
    const { apply, ids, flattened } = await valueDocument();
    const first = flattened.current().structure;
    expect(first).toBeDefined();
    await apply([{ op: "setParameters", nodeId: ids["$z"], parameters: { value: 4 } }]);
    await apply([{ op: "setParameters", nodeId: ids["$a"], parameters: { value: 2 } }]);
    expect(flattened.current().structure, "a value written changed the structure").toBe(first);

    const structural: ReadonlyArray<readonly [string, unknown[]]> = [
      ["a mode change with a new expression", [{ op: "setParameters", nodeId: ids["$a"], parameters: { value: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('constant_z').chan.value + 1" }, static: { kind: "static", value: 2 } } } } }]],
      ["another expression in the same mode", [{ op: "setParameters", nodeId: ids["$a"], parameters: { value: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('constant_z').chan.value + 2" }, static: { kind: "static", value: 2 } } } } }]],
      ["a node", [{ op: "addNode", ref: "$n", type: "constant", position: { x: 600, y: 0 }, label: "constant_n" }]],
      ["a name", [{ op: "setNodeLabel", nodeId: ids["$a"], label: "constant_alpha" }]],
    ];
    let before = flattened.current().structure;
    for (const [what, operations] of structural) {
      await apply(operations);
      const now = flattened.current().structure;
      expect(now, `${what} kept the structure`).not.toBe(before);
      before = now;
    }
    flattened.dispose();
  });

  it("a catalogue edit with no document edit is another structure", () => {
    const { components, flattened } = harness();
    const before = flattened.current().structure;
    components.register(animatedComponentDefinition());
    expect(flattened.current().structure).not.toBe(before);
    flattened.dispose();
  });

  it("the value graph, keyed on it, follows a NEW reference at once, and a value after that", async () => {
    const { apply, ids, flattened, registry } = await valueDocument();
    const session = createValueGraphSession(registry);
    const valueOfA = (): number | undefined => {
      const now = flattened.current();
      return session.evaluate(now.graph, ZERO_FRAME, { flattening: now }).byName.get("constant_a")?.["value"];
    };
    expect(valueOfA()).toBe(1);
    // `constant_a` begins to read `constant_z`: it must be evaluated AFTER it from now on.
    await apply([{ op: "setParameters", nodeId: ids["$a"], parameters: { value: { mode: "expression", bindings: { expression: { kind: "expression", source: "op('constant_z').chan.value + 1" }, static: { kind: "static", value: 1 } } } } }]);
    expect(valueOfA(), "the value graph did not order by the new reference").toBe(4);
    // And a value written to what it reads arrives, with the same structure.
    await apply([{ op: "setParameters", nodeId: ids["$z"], parameters: { value: 10 } }]);
    expect(valueOfA()).toBe(11);
    flattened.dispose();
  });
});
