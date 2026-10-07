import { describe, expect, it } from "vitest";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { laneDropOperations, laneNameFor, referenceSlot } from "./lane-drop.ts";

const registry = createNodeRegistry(allNodeDefinitions).view();
const node = (id: string, type: string, label: string | undefined, parameters: Record<string, unknown>) =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(label === undefined ? {} : { label }) }) as never;
const graph = (nodes: Record<string, unknown>): GraphDocument => ({ revision: 1, nodes, edges: {}, groups: {} }) as never;

describe("VN63 — a parameter dropped on the lane list", () => {
  it("refuses a compound and a non-number with a notice that says what to do", () => {
    const document = graph({ s: node("s", "solid", "solid_bg", {}), b: node("b", "blur", "blur_x", {}) });
    expect(laneDropOperations(document, registry, { nodeId: "s", key: "color" }, { kind: "new", automationNodeId: null, atTicks: 0 })).toEqual({
      ok: false,
      notice: "Color has several channels; compound parameters can't be automated yet.",
    });
    expect(laneDropOperations(document, registry, { nodeId: "b", key: "filter" }, { kind: "new", automationNodeId: null, atTicks: 0 })).toMatchObject({ ok: false, notice: expect.stringMatching(/not a number/) });
  });

  it("names a new automation node in the same patch and reads it, keeping the static value", () => {
    const document = graph({ l: node("l", "lfo", "lfo_a", { frequency: 25 }), x: node("x", "constant", "automation1", {}) });
    const plan = laneDropOperations(document, registry, { nodeId: "l", key: "frequency" }, { kind: "new", automationNodeId: null, atTicks: 8_000 });
    if (!plan.ok) throw new Error(plan.notice);
    // `automation1` is taken by another node, so the new one is the next free name.
    expect(plan.automationName).toBe("automation2");
    expect(plan.operations.map((operation) => operation.op)).toEqual(["addNode", "setParameters"]);
    expect(plan.operations[1]).toMatchObject({ parameters: { frequency: { mode: "expression", bindings: { static: { value: 25 }, expression: { source: "op('automation2').chan.frequency" } } } } });
  });

  it("an automation node with no name cannot be referenced", () => {
    const document = graph({ l: node("l", "lfo", "lfo_a", {}), a: node("a", "automation", undefined, {}) });
    expect(laneDropOperations(document, registry, { nodeId: "l", key: "frequency" }, { kind: "new", automationNodeId: "a", atTicks: 0 })).toMatchObject({ ok: false });
  });

  it("names lanes after keys and keeps a slot's other bindings", () => {
    expect([laneNameFor("scale.x"), laneNameFor("2d")]).toEqual(["scale_x", "p2d"]);
    const slot = { mode: "bind", bindings: { static: { kind: "static", value: 3 }, bind: { kind: "bind", ref: "amplitude" } } } as never;
    expect(referenceSlot(slot, 0, "op('a').chan.b")).toEqual({
      mode: "expression",
      bindings: { static: { kind: "static", value: 3 }, bind: { kind: "bind", ref: "amplitude" }, expression: { kind: "expression", source: "op('a').chan.b" } },
    });
  });
});
