import { describe, expect, it } from "vitest";
import { agent, alice, contextFor } from "../commands/test-support.ts";
import type { GraphComponentDefinition, PublishedParameter } from "../types/components.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { openComponentSession } from "./session.ts";
import { bloomComponent, blurKnob, createComponentHarness, graphOf, instanceNode } from "./test-support.ts";

/**
 * §T1546b — PUBLISH, UNPUBLISH, EXPOSE, UNEXPOSE AND REORDER INSIDE A COMPONENT ARE UNDO
 * STEPS. They change the definition and not the graph, so the session's store made no step
 * for them and Undo walked straight past: an author who published the wrong knob had to
 * unpublish it by hand, and Undo instead reverted the graph edit made BEFORE the publish.
 *
 * Each case asserts what the author reads back — the catalogue's page and boundary, i.e.
 * what every linked instance shows — after undo and after redo, and that the step sits in
 * the actor's history in the order it was made, between graph steps.
 */

const ctx = contextFor(alice);

const gain: PublishedParameter = {
  key: "gain",
  definition: { type: "number", label: "Gain", default: 1, min: 0, max: 4 },
  targets: [{ nodeId: "blurA", key: "radius" }],
};

const mix: PublishedParameter = {
  key: "mix",
  definition: { type: "number", label: "Mix", default: 0.5, min: 0, max: 1 },
  targets: [{ nodeId: "blurB", key: "radius" }],
};

function opened(definition: GraphComponentDefinition = bloomComponent("bloom", 1, [blurKnob, gain])) {
  const harness = createComponentHarness("t", graphOf([instanceNode("inst", "bloom", 1)]));
  harness.components.register(definition);
  const session = openComponentSession({ components: harness.components, nodes: harness.nodes, componentId: "bloom", version: 1 });
  const current = (): GraphComponentDefinition => harness.components.get("bloom", 1)!;
  const keys = (): string[] => current().parameters.map((each) => each.key);
  const outputs = (): string[] => current().outputs.map((each) => each.externalId);
  const undo = async (): Promise<string> => (await session.bus.execute("graph.undo", {}, ctx)).status;
  const redo = async (): Promise<string> => (await session.bus.execute("graph.redo", {}, ctx)).status;
  const edit = async (label: string, operations: GraphPatchOperation[]): Promise<void> => {
    const result = await session.bus.execute("graph.applyPatch", { baseRevision: session.store.view.getRevision(), label, operations }, ctx);
    expect(result.status).toBe("applied");
  };
  const radius = (nodeId: string): unknown => current().graph.nodes[nodeId]?.parameters["radius"];
  return { harness, session, current, keys, outputs, undo, redo, edit, radius };
}

describe("§T1546b — definition-only edits in a component session are undo steps", () => {
  it("publish: undo takes the knob off the page, redo puts it back exactly; the step is audited with its actor", async () => {
    const { session, current, keys, undo, redo } = opened();
    const graph = current().graph;
    const published = await session.bus.execute("component.publishParameter", { ...mix, targets: [...mix.targets] }, ctx);
    expect(published.status).toBe("applied");
    expect(keys()).toEqual(["blur", "gain", "mix"]);
    const withMix = JSON.stringify(current().parameters);

    // One step in alice's history, labelled for the history UI, and the audit entry says who.
    const history = session.store.view.getHistory(alice);
    expect(history.undo.map((group) => group.label)).toEqual(["Publish Mix"]);
    expect(published.undoGroupId).toBe(history.undo[0]?.id);
    const entry = session.store.view.getAudit().at(-1);
    expect(entry).toMatchObject({ actor: alice, command: "component.publishParameter", status: "applied", undoGroupId: published.undoGroupId });

    expect(await undo()).toBe("applied");
    expect(keys()).toEqual(["blur", "gain"]);
    expect(await redo()).toBe("applied");
    expect(JSON.stringify(current().parameters)).toBe(withMix);
    // None of the three touched the graph, so the definition still holds the same graph
    // object: nothing keyed on it recompiles, and a saved component keeps its revision.
    expect(current().graph).toBe(graph);
    session.dispose();
  });

  it("unpublish: undo brings the knob back in its own place, targets and all", async () => {
    const { session, current, keys, undo, redo } = opened();
    const before = JSON.stringify(current().parameters);
    expect((await session.bus.execute("component.unpublishParameter", { key: "blur" }, ctx)).status).toBe("applied");
    expect(keys()).toEqual(["gain"]);
    expect(await undo()).toBe("applied");
    expect(JSON.stringify(current().parameters)).toBe(before);
    expect(await redo()).toBe("applied");
    expect(keys()).toEqual(["gain"]);
    session.dispose();
  });

  it("expose and unexpose: each undoes and redoes as one step", async () => {
    const { session, current, outputs, undo, redo } = opened();
    expect((await session.bus.execute("component.exposePort", { direction: "output", nodeId: "blurA", portId: "out", externalId: "early" }, ctx)).status).toBe("applied");
    expect(outputs()).toEqual(["out", "early"]);
    expect(await undo()).toBe("applied");
    expect(outputs()).toEqual(["out"]);
    expect(await redo()).toBe("applied");
    expect(outputs()).toEqual(["out", "early"]);

    const exposed = JSON.stringify(current().outputs);
    expect((await session.bus.execute("component.unexposePort", { direction: "output", externalId: "out" }, ctx)).status).toBe("applied");
    expect(outputs()).toEqual(["early"]);
    expect(await undo()).toBe("applied");
    expect(JSON.stringify(current().outputs)).toBe(exposed);
    expect(await redo()).toBe("applied");
    expect(outputs()).toEqual(["early"]);
    session.dispose();
  });

  it("reorder: undo puts the page back in the order it had, redo moves it again", async () => {
    const { session, keys, undo, redo } = opened(bloomComponent("bloom", 1, [blurKnob, gain, mix]));
    expect((await session.bus.execute("component.reorderParameter", { key: "mix", toIndex: 0 }, ctx)).status).toBe("applied");
    expect(keys()).toEqual(["mix", "blur", "gain"]);
    expect(await undo()).toBe("applied");
    expect(keys()).toEqual(["blur", "gain", "mix"]);
    expect(await redo()).toBe("applied");
    expect(keys()).toEqual(["mix", "blur", "gain"]);
    session.dispose();
  });

  it("an edit that changes nothing makes no step: Undo would otherwise do nothing visible", async () => {
    const { session } = opened();
    const depth = session.store.view.getHistory(alice).undo.length;
    const revision = session.store.view.getRevision();
    expect((await session.bus.execute("component.reorderParameter", { key: "blur", toIndex: 0 }, ctx)).status).toBe("applied");
    expect(session.store.view.getHistory(alice).undo.length).toBe(depth);
    expect(session.store.view.getRevision()).toBe(revision);
    session.dispose();
  });

  it("interleaved with graph edits: graph edit, publish, graph edit — three undos reverse each in turn, three redos replay them", async () => {
    const { session, keys, undo, redo, edit, radius } = opened();
    const radiusA = radius("blurA");
    const radiusB = radius("blurB");
    await edit("A to 9", [{ op: "setParameters", nodeId: "blurA", parameters: { radius: 9 } }]);
    expect((await session.bus.execute("component.publishParameter", { ...mix, targets: [...mix.targets] }, ctx)).status).toBe("applied");
    await edit("B to 7", [{ op: "setParameters", nodeId: "blurB", parameters: { radius: 7 } }]);
    const radiusA9 = radius("blurA");
    const radiusB7 = radius("blurB");
    expect(radiusA9).not.toEqual(radiusA);
    expect(radiusB7).not.toEqual(radiusB);
    expect(session.store.view.getHistory(alice).undo.map((group) => group.label)).toEqual(["A to 9", "Publish Mix", "B to 7"]);

    // Undo 1: only the last graph edit.
    expect(await undo()).toBe("applied");
    expect([radius("blurA"), radius("blurB"), keys()]).toEqual([radiusA9, radiusB, ["blur", "gain", "mix"]]);
    // Undo 2: only the publish.
    expect(await undo()).toBe("applied");
    expect([radius("blurA"), radius("blurB"), keys()]).toEqual([radiusA9, radiusB, ["blur", "gain"]]);
    // Undo 3: only the first graph edit.
    expect(await undo()).toBe("applied");
    expect([radius("blurA"), radius("blurB"), keys()]).toEqual([radiusA, radiusB, ["blur", "gain"]]);

    expect(await redo()).toBe("applied");
    expect([radius("blurA"), radius("blurB"), keys()]).toEqual([radiusA9, radiusB, ["blur", "gain"]]);
    expect(await redo()).toBe("applied");
    expect([radius("blurA"), radius("blurB"), keys()]).toEqual([radiusA9, radiusB, ["blur", "gain", "mix"]]);
    expect(await redo()).toBe("applied");
    expect([radius("blurA"), radius("blurB"), keys()]).toEqual([radiusA9, radiusB7, ["blur", "gain", "mix"]]);
    session.dispose();
  });

  it("undo is per actor (§V41): alice's Undo does not take back the agent's publish", async () => {
    const { session, keys, undo, edit } = opened();
    await edit("A to 9", [{ op: "setParameters", nodeId: "blurA", parameters: { radius: 9 } }]);
    expect((await session.bus.execute("component.publishParameter", { ...mix, targets: [...mix.targets] }, contextFor(agent))).status).toBe("applied");
    expect(await undo()).toBe("applied");
    expect(keys()).toEqual(["blur", "gain", "mix"]);
    expect((await session.bus.execute("graph.undo", {}, contextFor(agent))).status).toBe("applied");
    expect(keys()).toEqual(["blur", "gain"]);
    session.dispose();
  });

  it("leaving the session: the publish stays committed and its step goes with the session, exactly like a graph step; the root's undo never sees either", async () => {
    const { harness, session, keys, edit, radius } = opened();
    // A root edit first, so the root has a step of its own to undo.
    const rootEdit = await harness.bus.execute(
      "graph.applyPatch",
      { baseRevision: harness.store.view.getRevision(), label: "move inst", operations: [{ op: "moveNodes", positions: { inst: { x: 300, y: 300 } } }] },
      ctx,
    );
    expect(rootEdit.status).toBe("applied");
    const rootDepth = harness.store.view.getHistory(alice).undo.length;

    await edit("A to 9", [{ op: "setParameters", nodeId: "blurA", parameters: { radius: 9 } }]);
    const radiusA9 = radius("blurA");
    expect((await session.bus.execute("component.publishParameter", { ...mix, targets: [...mix.targets] }, ctx)).status).toBe("applied");
    // Neither session step reached the root's history.
    expect(harness.store.view.getHistory(alice).undo.length).toBe(rootDepth);
    session.dispose();

    // The root's undo takes back the root edit only; the definition keeps both session edits.
    expect((await harness.bus.execute("graph.undo", {}, ctx)).status).toBe("applied");
    expect(harness.store.view.getGraph().nodes["inst"]?.position).toEqual({ x: 0, y: 0 });
    expect(keys()).toEqual(["blur", "gain", "mix"]);
    expect(radius("blurA")).toEqual(radiusA9);

    // A reopened session starts with an empty history: nothing to undo, graph step or publish.
    const reopened = openComponentSession({ components: harness.components, nodes: harness.nodes, componentId: "bloom", version: 1 });
    const again = await reopened.bus.execute("graph.undo", {}, ctx);
    expect(again.status).toBe("rejected");
    expect(again.diagnostics.map((each) => each.code)).toEqual(["history.empty"]);
    expect(keys()).toEqual(["blur", "gain", "mix"]);
    reopened.dispose();
  });

  it("the root bus refuses a definition edit by name and records no step for it", async () => {
    const { harness } = opened();
    const depth = harness.store.view.getHistory(alice).undo.length;
    const revision = harness.store.view.getRevision();
    const refused = await harness.bus.execute("component.publishParameter", { ...mix, targets: [...mix.targets] }, ctx);
    expect(refused.status).toBe("rejected");
    expect(refused.diagnostics.map((each) => each.code)).toEqual(["component.notInsideComponent"]);
    expect(harness.store.view.getHistory(alice).undo.length).toBe(depth);
    expect(harness.store.view.getRevision()).toBe(revision);
  });
});
