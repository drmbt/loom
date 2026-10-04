import { describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { resolveParameters } from "@domain/parameters/resolve.ts";
import { NO_FLATTENING, parameterReadOptions } from "@domain/parameters/node-references.ts";
import { boxesOverlap, nodeBox } from "@domain/graph/node-box.ts";
import { authoredGraph, type GraphNode } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { panelMembers, panelTitle } from "@nodes/definitions/controls.ts";

/**
 * T1514b — MAPPING STARTS FROM THE PARAMETER, through the real app bus.
 *
 * What the owner asked for, asserted as what a person reads back: the control that appears
 * is the one the parameter needs (its own range, its current value), the parameter READS it
 * (moving the control moves the resolved value — the render effect, evaluated through the
 * real value session), it sits on a Panel, and the whole gesture is ONE undo. Letting go
 * lands on the number the parameter held before, never on something else.
 */

async function runtimeWith(operations: GraphPatchOperation[]): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "setup", operations }, runtime.invocation);
  expect(result.output.status).toBe("applied");
  return runtime;
}

const graph = (runtime: AppRuntime) => runtime.bus.store.getGraph();
const named = (runtime: AppRuntime, label: string): GraphNode => {
  const found = Object.values(graph(runtime).nodes).find((node) => node.label === label);
  if (found === undefined) throw new Error(`no node "${label}"`);
  return found;
};
const ofType = (runtime: AppRuntime, type: string) => Object.values(graph(runtime).nodes).filter((node) => node.type === type);

const frame = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 } as const;

/** What the parameter resolves to this frame, channels from the real value session. */
function resolved(runtime: AppRuntime, label: string, key: string): ParameterValue | undefined {
  const document = graph(runtime);
  const channels = createValueGraphSession(runtime.registry).evaluate(document, frame).resolver;
  const node = named(runtime, label);
  const options = parameterReadOptions({ graph: authoredGraph(document), registry: runtime.registry, channels, frame, flattening: NO_FLATTENING });
  return resolveParameters(node, runtime.registry.get(node.type), options).values[key];
}

async function set(runtime: AppRuntime, label: string, parameters: Record<string, ParameterValue>): Promise<void> {
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), label: "move", operations: [{ op: "setParameters", nodeId: named(runtime, label).id, parameters }] },
    runtime.invocation,
  );
  expect(result.output.status).toBe("applied");
}

const level = (parameters: Record<string, ParameterValue> = {}): GraphPatchOperation => ({
  op: "addNode",
  ref: "$level",
  type: "level",
  position: { x: 400, y: 0 },
  label: "level1",
  parameters,
});

describe("T1514b — Control from Panel", () => {
  it("a number gets a slider over its own range at its value, the parameter reads it, and one undo takes it all back", async () => {
    const runtime = await runtimeWith([level({ brightness: 3 })]);
    const before = graph(runtime);
    const target = named(runtime, "level1");

    const result = await runtime.bus.execute("control.fromParameter", { nodeId: target.id, parameterKey: "brightness" }, runtime.invocation);
    expect(result.output.status).toBe("applied");

    // The slider carries Level's Brightness declaration (0..8, continuous) and the 3 it held.
    const slider = named(runtime, "brightness");
    expect(slider.type).toBe("slider");
    expect(slider.parameters).toMatchObject({ channel: "brightness", caption: "Brightness", value: 3, min: 0, max: 8, step: 0 });
    // Bound the way the controls always bind: the channel read, the 3 retained beside it.
    expect(named(runtime, "level1").parameters["brightness"]).toEqual({
      mode: "expression",
      bindings: { static: { kind: "static", value: 3 }, expression: { kind: "expression", source: "op('brightness').chan.brightness" } },
    });
    // No Panel existed, so one was made — titled "Controls" — and the slider is on it.
    const [panel] = ofType(runtime, "panel");
    expect(panel).toBeDefined();
    expect(panelTitle(panel as GraphNode)).toBe("Controls");
    expect(panelMembers(graph(runtime), panel as GraphNode).map((node) => node.label)).toEqual(["brightness"]);
    // Placed beside what it drives, on top of nothing.
    const boxes = Object.values(graph(runtime).nodes).map((node) => nodeBox(node, runtime.registry.get(node.type), undefined, graph(runtime)));
    boxes.forEach((box, index) => boxes.slice(index + 1).forEach((other) => expect(boxesOverlap(box, other)).toBe(false)));

    // THE RENDER EFFECT: the parameter follows the slider, through the real value session.
    expect(resolved(runtime, "level1", "brightness")).toBe(3);
    await set(runtime, "brightness", { value: 6.5 });
    expect(resolved(runtime, "level1", "brightness")).toBe(6.5);

    // ONE undo: slider, Panel, wire and binding go together; Brightness is 3 again. (The
    // slider move above is its own step, undone first.)
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    expect(Object.keys(graph(runtime).nodes).sort()).toEqual(Object.keys(before.nodes).sort());
    expect(Object.keys(graph(runtime).edges)).toEqual([]);
    expect(named(runtime, "level1").parameters["brightness"]).toBe(3);
  });

  it("a number with no range declared gets 0..1, widened to reach the value it holds", async () => {
    // Constant's Value and LFO's Offset declare no min/max. A slider that could not reach
    // the value would MOVE it the moment it was bound; 0..1 is the travel otherwise.
    const runtime = await runtimeWith([
      { op: "addNode", ref: "$k", type: "constant", position: { x: 400, y: 0 }, label: "constant1", parameters: { value: 5 } },
      { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 400, y: 600 }, label: "lfo1" },
    ]);
    await runtime.bus.execute("control.fromParameter", { nodeId: named(runtime, "constant1").id, parameterKey: "value" }, runtime.invocation);
    await runtime.bus.execute("control.fromParameter", { nodeId: named(runtime, "lfo1").id, parameterKey: "offset" }, runtime.invocation);
    expect(named(runtime, "value").parameters).toMatchObject({ value: 5, min: 0, max: 5 });
    expect(named(runtime, "offset").parameters).toMatchObject({ value: 0, min: 0, max: 1 });
    expect(resolved(runtime, "constant1", "value")).toBe(5);
  });

  it("a boolean gets a toggle in its current state", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$remap", type: "remap", position: { x: 400, y: 0 }, label: "remap1", parameters: { flipu: true } }]);
    await runtime.bus.execute("control.fromParameter", { nodeId: named(runtime, "remap1").id, parameterKey: "flipu" }, runtime.invocation);
    const toggle = named(runtime, "flipU");
    expect(toggle.type).toBe("toggle");
    expect(toggle.parameters).toMatchObject({ channel: "flipU", caption: "Flip U", on: true });
    expect(resolved(runtime, "remap1", "flipu")).toBe(true);
    await set(runtime, "flipU", { on: false });
    expect(resolved(runtime, "remap1", "flipu")).toBe(false);
  });

  it("a 2-vector gets an XY pad and BOTH components read it", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$pin", type: "cornerPin", position: { x: 400, y: 0 }, label: "pin1" }]);
    await runtime.bus.execute("control.fromParameter", { nodeId: named(runtime, "pin1").id, parameterKey: "pintr" }, runtime.invocation);
    const pin = named(runtime, "pin1");
    expect(pin.parameters["pintr.x"]).toMatchObject({ mode: "expression", bindings: { static: { value: 1 }, expression: { source: "op('pinTopRight').chan.pinTopRightX" } } });
    expect(pin.parameters["pintr.y"]).toMatchObject({ mode: "expression", bindings: { static: { value: 1 }, expression: { source: "op('pinTopRight').chan.pinTopRightY" } } });
    await set(runtime, "pinTopRight", { x: 0.25, y: 0.75 });
    expect(resolved(runtime, "pin1", "pintr")).toEqual([0.25, 0.75]);
  });

  it("joins the only Panel; with several it joins the one named, and refuses to guess", async () => {
    const panel = (ref: `$${string}`, label: string, title: string): GraphPatchOperation => ({ op: "addNode", ref, type: "panel", position: { x: -800, y: label === "deskA" ? 0 : 600 }, label, parameters: { title } });
    const one = await runtimeWith([level(), panel("$a", "deskA", "Desk A")]);
    await one.bus.execute("control.fromParameter", { nodeId: named(one, "level1").id, parameterKey: "contrast" }, one.invocation);
    expect(ofType(one, "panel")).toHaveLength(1);
    expect(panelMembers(graph(one), named(one, "deskA")).map((node) => node.label)).toEqual(["contrast"]);

    const two = await runtimeWith([level(), panel("$a", "deskA", "Desk A"), panel("$b", "deskB", "Desk B")]);
    const guess = await two.bus.execute("control.fromParameter", { nodeId: named(two, "level1").id, parameterKey: "contrast" }, two.invocation);
    expect(guess.output.status).toBe("rejected");
    expect(ofType(two, "slider")).toHaveLength(0);
    await two.bus.execute("control.fromParameter", { nodeId: named(two, "level1").id, parameterKey: "contrast", panelId: named(two, "deskB").id }, two.invocation);
    expect(panelMembers(graph(two), named(two, "deskB")).map((node) => node.label)).toEqual(["contrast"]);
    expect(panelMembers(graph(two), named(two, "deskA"))).toEqual([]);
  });

  it("refuses by name where no control fits, and writes nothing", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$remap", type: "remap", position: { x: 400, y: 0 }, label: "remap1" }]);
    const revision = runtime.bus.store.getRevision();
    const result = await runtime.bus.execute("control.fromParameter", { nodeId: named(runtime, "remap1").id, parameterKey: "sourcex" }, runtime.invocation);
    expect(result.output.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.message).toContain("enum parameter");
    expect(runtime.bus.store.getRevision()).toBe(revision);
  });

  it("names a second control for the same word with the next free number", async () => {
    const runtime = await runtimeWith([level(), { ...level(), ref: "$level2", label: "level2", position: { x: 400, y: 600 } } as GraphPatchOperation]);
    await runtime.bus.execute("control.fromParameter", { nodeId: named(runtime, "level1").id, parameterKey: "brightness" }, runtime.invocation);
    await runtime.bus.execute("control.fromParameter", { nodeId: named(runtime, "level2").id, parameterKey: "brightness" }, runtime.invocation);
    expect(named(runtime, "level2").parameters["brightness"]).toMatchObject({ bindings: { expression: { source: "op('brightness1').chan.brightness" } } });
  });
});

describe("T1514b — Drive from, and letting go", () => {
  const controls: GraphPatchOperation[] = [
    { op: "addNode", ref: "$heat", type: "slider", position: { x: -400, y: 0 }, label: "heat", parameters: { channel: "heat", caption: "Heat", value: 1.5, min: 0, max: 2 } },
    { op: "addNode", ref: "$flash", type: "button", position: { x: -400, y: 300 }, label: "flash", parameters: { channel: "flash", presses: 4 } },
    { op: "addNode", ref: "$warp", type: "xyPad", position: { x: -400, y: 600 }, label: "warp", parameters: { channel: "warp", x: 0.2, y: 0.9 } },
  ];

  it("binds an existing control's channel, keeping the value the parameter held", async () => {
    const runtime = await runtimeWith([level({ brightness: 2 }), ...controls]);
    const nodeId = named(runtime, "level1").id;
    await runtime.bus.execute("control.bindParameter", { nodeId, parameterKey: "brightness", controlId: named(runtime, "heat").id, channel: "heat" }, runtime.invocation);
    expect(named(runtime, "level1").parameters["brightness"]).toEqual({
      mode: "expression",
      bindings: { static: { kind: "static", value: 2 }, expression: { kind: "expression", source: "op('heat').chan.heat" } },
    });
    expect(resolved(runtime, "level1", "brightness")).toBe(1.5);
    // A Button's count is a channel of its own.
    await runtime.bus.execute("control.bindParameter", { nodeId, parameterKey: "contrast", controlId: named(runtime, "flash").id, channel: "flashCount" }, runtime.invocation);
    expect(resolved(runtime, "level1", "contrast")).toBe(4);
  });

  it("an XY pad drives a 2-vector whole", async () => {
    const runtime = await runtimeWith([{ op: "addNode", ref: "$pin", type: "cornerPin", position: { x: 400, y: 0 }, label: "pin1" }, ...controls]);
    await runtime.bus.execute("control.bindParameter", { nodeId: named(runtime, "pin1").id, parameterKey: "pinbl", controlId: named(runtime, "warp").id }, runtime.invocation);
    expect(resolved(runtime, "pin1", "pinbl")).toEqual([0.2, 0.9]);
  });

  it("Unlink control puts the retained value back, and refuses where nothing is bound", async () => {
    const runtime = await runtimeWith([level({ brightness: 2 }), ...controls]);
    const nodeId = named(runtime, "level1").id;
    const idle = await runtime.bus.execute("control.unbindParameter", { nodeId, parameterKey: "brightness" }, runtime.invocation);
    expect(idle.output.status).toBe("rejected");
    await runtime.bus.execute("control.bindParameter", { nodeId, parameterKey: "brightness", controlId: named(runtime, "heat").id, channel: "heat" }, runtime.invocation);
    expect(resolved(runtime, "level1", "brightness")).toBe(1.5);
    const result = await runtime.bus.execute("control.unbindParameter", { nodeId, parameterKey: "brightness" }, runtime.invocation);
    expect(result.output.status).toBe("applied");
    expect(named(runtime, "level1").parameters["brightness"]).toMatchObject({ mode: "static", bindings: { static: { value: 2 } } });
    expect(resolved(runtime, "level1", "brightness")).toBe(2);
  });
});
