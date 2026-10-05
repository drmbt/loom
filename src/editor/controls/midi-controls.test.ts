import { afterEach, describe, expect, it } from "vitest";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { createValueGraphSession } from "@domain/channels/value-graph.ts";
import { buildProjectFile, loadProject } from "@domain/project/index.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import { decodeMidiMessage, midiChannelName, parseMidiMapping, serialiseMidiMapping, type MidiSource } from "@domain/midi/midi-mapping.ts";
import { boxesOverlap, nodeBox } from "@domain/graph/node-box.ts";
import { resolveParameters } from "@domain/parameters/resolve.ts";
import { NO_FLATTENING, parameterReadOptions } from "@domain/parameters/node-references.ts";
import { authoredGraph, type GraphNode } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { StoredParameter } from "@domain/types/parameters.ts";
import { controlMidiBinding, learnControlMidiPlan, unlearnControlMidiPlan } from "./midi-controls.ts";
import type { ControlPlan } from "./parameter-controls.ts";

const CC: MidiSource = { kind: "cc", channel: 1, number: 74 };
const PORT = "controller-a";
const runtimes: AppRuntime[] = [];
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); });
const graph = (runtime: AppRuntime) => runtime.bus.store.getGraph();
const named = (runtime: AppRuntime, label: string): GraphNode => {
  const node = Object.values(graph(runtime).nodes).find((each) => each.label === label);
  if (node === undefined) throw new Error(`Missing node "${label}".`);
  return node;
};
const nodes = (runtime: AppRuntime, type: string) => Object.values(graph(runtime).nodes).filter((node) => node.type === type);
const add = (type: string, label: string, parameters: Record<string, StoredParameter> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${label}`, type, label, position: { x: 0, y: 0 }, parameters });

async function patch(runtime: AppRuntime, operations: GraphPatchOperation[]): Promise<void> {
  const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "test patch", operations }, runtime.invocation);
  expect(result.output.status, JSON.stringify(result.output.diagnostics)).toBe("applied");
}
async function setup(operations: GraphPatchOperation[]): Promise<AppRuntime> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "midi-test" } });
  runtimes.push(runtime);
  await patch(runtime, operations);
  return runtime;
}
async function apply(runtime: AppRuntime, plan: ControlPlan): Promise<void> {
  if (!plan.ok) throw new Error(plan.reason);
  await patch(runtime, plan.operations);
}
async function learn(runtime: AppRuntime, label: string, key: string, source = CC, port = PORT): Promise<void> {
  await apply(runtime, learnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, label).id, key, source, port));
}
function readings(runtime: AppRuntime, label: string) {
  const session = createValueGraphSession(runtime.registry);
  let index = 0;
  return (data?: readonly number[], port = PORT) => {
    const message = data === undefined ? null : decodeMidiMessage(Uint8Array.from(data));
    const frame = { timeSeconds: index / 60, deltaSeconds: 1 / 60, frameIndex: index++, mode: "realtime", randomSeed: 1 } as const;
    const values = session.evaluate(graph(runtime), frame, { channels: (name) => message !== null && name === midiChannelName(port, message.source) ? message.raw : undefined });
    expect(values.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
    return values.byId.get(named(runtime, label).id);
  };
}
const cc = (raw: number, number = 74) => [0xb0, number, raw];

describe("MIDI learning uses one document patch and the existing value graph", () => {
  it("maps slider endpoints and midpoint to retained Min/Max, with current value at rest", async () => {
    const runtime = await setup([add("slider", "heat", { value: 3, min: -2, max: 8 })]);
    const before = graph(runtime);
    await learn(runtime, "heat", "value");
    expect(runtime.bus.store.getRevision()).toBe(before.revision + 1);
    expect(controlMidiBinding(graph(runtime), named(runtime, "heat").id, "value")).toMatchObject({ channel: "heatValue", binding: { source: CC, range: [-2, 8], mode: "absolute", rest: 3 } });
    const read = readings(runtime, "heat");
    expect(read()).toEqual({ value: 3 });
    expect(read(cc(0))).toEqual({ value: -2 });
    expect(read(cc(64))?.["value"]).toBeCloseTo(-2 + 10 * 64 / 127);
    expect(read(cc(127))).toEqual({ value: 8 });
    const boxes = Object.values(graph(runtime).nodes).map((node) => nodeBox(node, runtime.registry.get(node.type), undefined, graph(runtime)));
    expect(boxesOverlap(boxes[0]!, boxes[1]!)).toBe(false);
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    expect(graph(runtime).nodes).toEqual(before.nodes);
    expect(graph(runtime).edges).toEqual(before.edges);
    await runtime.bus.execute("graph.redo", {}, runtime.invocation);
    expect(readings(runtime, "heat")(cc(127))).toEqual({ value: 8 });
  });

  it("learned widget channels drive an existing downstream parameter in the same frame", async () => {
    const runtime = await setup([add("slider", "heat", { value: 0.3 }), add("level", "picture", {
      opacity: { mode: "expression", bindings: { static: { kind: "static", value: 0.3 }, expression: { kind: "expression", source: "op('heat').chan.value" } } },
    })]);
    await learn(runtime, "heat", "value");
    const session = createValueGraphSession(runtime.registry);
    const frame = { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 1 } as const;
    const values = session.evaluate(graph(runtime), frame, { channels: (name) => name === midiChannelName(PORT, CC) ? 127 : undefined });
    const target = named(runtime, "picture");
    const options = parameterReadOptions({ graph: authoredGraph(graph(runtime)), registry: runtime.registry, channels: values.resolver, frame, flattening: NO_FLATTENING });
    expect(resolveParameters(target, runtime.registry.get(target.type), options).values["opacity"]).toBe(1);
  });

  it.each([false, true])("first toggle press flips retained state %s, high repeats and release do not toggle", async (on) => {
    const runtime = await setup([add("toggle", "enabled", { on })]);
    await learn(runtime, "enabled", "on");
    const read = readings(runtime, "enabled");
    expect(read()).toEqual({ value: on ? 1 : 0 });
    expect(read(cc(0))).toEqual({ value: on ? 1 : 0 });
    expect(read(cc(127))).toEqual({ value: on ? 0 : 1 });
    expect(read(cc(127))).toEqual({ value: on ? 0 : 1 });
    expect(read(cc(0))).toEqual({ value: on ? 0 : 1 });
    expect(read(cc(127))).toEqual({ value: on ? 1 : 0 });
  });

  it("binds button held and retained press count with no hold-off or synthetic initial press", async () => {
    const runtime = await setup([add("button", "fire", { held: true, presses: 5 })]);
    await learn(runtime, "fire", "held");
    expect(nodes(runtime, "valueCount")).toHaveLength(1);
    expect(nodes(runtime, "valueCount")[0]?.parameters).toMatchObject({ holdoff: 0, threshold: 0.5 });
    expect(Object.keys(graph(runtime).edges)).toHaveLength(1);
    const read = readings(runtime, "fire");
    expect(read()).toEqual({ value: 0, valueCount: 5 });
    expect(read(cc(63))).toEqual({ value: 0, valueCount: 5 });
    expect(read(cc(64))).toEqual({ value: 1, valueCount: 6 });
    expect(read(cc(127))).toEqual({ value: 1, valueCount: 6 });
    expect(read(cc(0))).toEqual({ value: 0, valueCount: 6 });
    expect(read(cc(127))).toEqual({ value: 1, valueCount: 7 });
    const learned = graph(runtime);
    await learn(runtime, "fire", "held", { kind: "cc", channel: 1, number: 75 });
    expect(nodes(runtime, "midiIn")).toHaveLength(1);
    expect(nodes(runtime, "valueCount")).toHaveLength(1);
    expect(graph(runtime).edges).toEqual(learned.edges);
    expect(parseMidiMapping(nodes(runtime, "midiIn")[0]?.parameters["mapping"]).bindings).toHaveLength(1);
    expect(readings(runtime, "fire")(cc(127, 75))).toEqual({ value: 1, valueCount: 6 });
    await apply(runtime, unlearnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "fire").id, "held"));
    expect(readings(runtime, "fire")(cc(127, 75))).toEqual({ value: 1, valueCount: 5 });
    expect(controlMidiBinding(graph(runtime), named(runtime, "fire").id, "held")).toBeNull();
    expect(nodes(runtime, "valueCount")).toHaveLength(1);
    expect(graph(runtime).edges).toEqual(learned.edges);
  });

  it("button count wiring and retained base survive project reopening", async () => {
    const runtime = await setup([add("button", "fire", { presses: 5 })]);
    await learn(runtime, "fire", "held");
    const loaded = loadProject(buildProjectFile({ document: runtime.projectDocument() }).text, { nodes: runtime.registry });
    if (!loaded.ok) throw new Error(loaded.reason);
    const reopened = createAppRuntime({ document: loaded.document, identityStorage: null });
    runtimes.push(reopened);
    expect(graph(reopened).edges).toEqual(graph(runtime).edges);
    expect(named(reopened, "fire").parameters).toEqual(named(runtime, "fire").parameters);
    const read = readings(reopened, "fire");
    expect(read(cc(0))).toEqual({ value: 0, valueCount: 5 });
    expect(read(cc(127))).toEqual({ value: 1, valueCount: 6 });
  });

  it("learns each XY axis independently and supports full 14-bit pitch bend", async () => {
    const runtime = await setup([add("xyPad", "position", { x: -0.25, y: 0.75, min: -1, max: 1 })]);
    await learn(runtime, "position", "x", { kind: "pitchBend", channel: 2 });
    const read = readings(runtime, "position");
    expect(read()).toEqual({ valueX: -0.25, valueY: 0.75 });
    expect(read([0xe1, 0, 0])).toEqual({ valueX: -1, valueY: 0.75 });
    expect(read([0xe1, 127, 127])).toEqual({ valueX: 1, valueY: 0.75 });
    expect(read([0xe1, 0, 64])?.["valueX"]).toBeCloseTo(-1 + 2 * 8192 / 16383);
    await learn(runtime, "position", "y");
    expect(nodes(runtime, "midiIn")).toHaveLength(1);
    const both = readings(runtime, "position");
    expect(both(cc(0))).toEqual({ valueX: -0.25, valueY: -1 });
    await apply(runtime, unlearnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "position").id, "y"));
    expect(controlMidiBinding(graph(runtime), named(runtime, "position").id, "x")).not.toBeNull();
    expect(controlMidiBinding(graph(runtime), named(runtime, "position").id, "y")).toBeNull();
    expect(readings(runtime, "position")([0xe1, 0, 0])).toEqual({ valueX: -1, valueY: 0.75 });
  });

  it("reuses the captured port, preserves unrelated mapping rows, avoids channel collisions and repeated learns", async () => {
    const unrelated = { channel: "heatValue", source: { kind: "cc" as const, channel: 1, number: 12 }, range: [5, 9] as const, mode: "absolute" as const, rest: 6 };
    const runtime = await setup([add("slider", "heat", { value: 0.4 }), add("midiIn", "sharedMidi", { device: PORT, mapping: serialiseMidiMapping([unrelated]) })]);
    await learn(runtime, "heat", "value");
    const binding = controlMidiBinding(graph(runtime), named(runtime, "heat").id, "value");
    expect(binding?.channel).not.toBe("heatValue");
    expect(binding?.midiId).toBe(named(runtime, "sharedMidi").id);
    await learn(runtime, "heat", "value", { kind: "cc", channel: 3, number: 7 });
    expect(nodes(runtime, "midiIn")).toHaveLength(1);
    const rows = parseMidiMapping(named(runtime, "sharedMidi").parameters["mapping"]).bindings;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(unrelated);
    expect(rows[1]?.source).toEqual({ kind: "cc", channel: 3, number: 7 });
    expect(controlMidiBinding(graph(runtime), named(runtime, "heat").id, "value")?.channel).toBe(binding?.channel);
    await apply(runtime, unlearnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "heat").id, "value"));
    expect(readings(runtime, "heat")([0xb2, 7, 127])).toEqual({ value: 0.4 });
    expect(parseMidiMapping(named(runtime, "sharedMidi").parameters["mapping"]).bindings).toEqual(rows);
    await learn(runtime, "heat", "value");
    expect(parseMidiMapping(named(runtime, "sharedMidi").parameters["mapping"]).bindings).toHaveLength(2);
  });

  it("does not reuse wildcard or different-port sources", async () => {
    const runtime = await setup([add("slider", "heat"), add("midiIn", "anyMidi"), add("midiIn", "otherMidi", { device: "different" })]);
    await learn(runtime, "heat", "value");
    expect(nodes(runtime, "midiIn")).toHaveLength(3);
    const binding = controlMidiBinding(graph(runtime), named(runtime, "heat").id, "value");
    expect(graph(runtime).nodes[binding!.midiId]?.parameters["device"]).toBe(PORT);
    expect(readings(runtime, "heat")(cc(127), "different")).toEqual({ value: 0.5 });
  });

  it("keeps retained slot bindings, range envelopes and learned wiring through save/load", async () => {
    const runtime = await setup([add("slider", "heat", {
      value: { mode: "static", bindings: { static: { kind: "static", value: 0.3 }, expression: { kind: "expression", source: "0.8" } } },
      min: { mode: "static", bindings: { static: { kind: "static", value: -2 } } }, max: 4,
    })]);
    await learn(runtime, "heat", "value");
    const file = buildProjectFile({ document: runtime.projectDocument() });
    const loaded = loadProject(file.text, { nodes: runtime.registry });
    if (!loaded.ok) throw new Error(loaded.reason);
    const reopened = createAppRuntime({ document: loaded.document, identityStorage: null });
    runtimes.push(reopened);
    expect(named(reopened, "heat").parameters).toEqual(named(runtime, "heat").parameters);
    expect(readings(reopened, "heat")(cc(127))).toEqual({ value: 4 });
    await apply(reopened, unlearnControlMidiPlan(graph(reopened), reopened.registry, named(reopened, "heat").id, "value"));
    const restored = named(reopened, "heat").parameters["value"];
    expect(isParameterSlot(restored) && restored.mode).toBe("static");
    expect(readings(reopened, "heat")(cc(127))).toEqual({ value: 0.3 });
  });

  it("refuses malformed existing mappings without dropping valid preceding rows", async () => {
    const runtime = await setup([add("slider", "heat"), add("midiIn", "broken", { device: PORT, mapping: '[{"channel":"keep"},{}]' })]);
    const before = graph(runtime);
    expect(learnControlMidiPlan(before, runtime.registry, named(runtime, "heat").id, "value", CC, PORT)).toMatchObject({ ok: false, code: "control.midi.mapping" });
    expect(graph(runtime)).toBe(before);
    expect(learnControlMidiPlan(before, runtime.registry, named(runtime, "heat").id, "value", CC, PORT)).not.toHaveProperty("operations");
  });

  it("refuses unsupported keys, deleted controls and invalid hardware addresses", async () => {
    const runtime = await setup([add("slider", "heat"), add("solid", "picture")]);
    const heat = named(runtime, "heat");
    for (const key of ["min", "max", "caption", "unknown"]) {
      expect(learnControlMidiPlan(graph(runtime), runtime.registry, heat.id, key, CC, PORT)).toMatchObject({ ok: false, code: "control.midi.target" });
      expect(unlearnControlMidiPlan(graph(runtime), runtime.registry, heat.id, key)).toMatchObject({ ok: false });
    }
    expect(learnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "picture").id, "color", CC, PORT)).toMatchObject({ ok: false });
    for (const source of [{ kind: "cc", channel: 0, number: 1 }, { kind: "cc", channel: 1, number: 128 }, { kind: "cc", channel: 1 }, { kind: "pitchBend", channel: 1.5 }] as MidiSource[]) {
      expect(learnControlMidiPlan(graph(runtime), runtime.registry, heat.id, "value", source, PORT)).toMatchObject({ ok: false, code: "control.midi.source" });
    }
    expect(learnControlMidiPlan(graph(runtime), runtime.registry, heat.id, "value", CC, "")).toMatchObject({ ok: false });
    await patch(runtime, [{ op: "removeNodes", nodeIds: [heat.id] }]);
    expect(learnControlMidiPlan(graph(runtime), runtime.registry, heat.id, "value", CC, PORT)).toMatchObject({ ok: false, code: "control.node" });
    expect(unlearnControlMidiPlan(graph(runtime), runtime.registry, heat.id, "value")).toMatchObject({ ok: false, code: "control.node" });
    expect(controlMidiBinding(graph(runtime), heat.id, "value")).toBeNull();
  });

  it("Unlearn refuses unrelated expressions and does not clear a button's separately authored press expression", async () => {
    const arbitrary = { mode: "expression" as const, bindings: { static: { kind: "static" as const, value: 2 }, expression: { kind: "expression" as const, source: "time * 2" } } };
    const runtime = await setup([add("slider", "heat", { value: arbitrary }), add("button", "fire")]);
    expect(unlearnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "heat").id, "value")).toMatchObject({ ok: false, code: "control.midi.unbound" });
    await learn(runtime, "fire", "held");
    await patch(runtime, [{ op: "setParameters", nodeId: named(runtime, "fire").id, parameters: { presses: arbitrary } }]);
    await apply(runtime, unlearnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "fire").id, "held"));
    expect(named(runtime, "fire").parameters["presses"]).toEqual(arbitrary);
    expect(controlMidiBinding(graph(runtime), named(runtime, "fire").id, "held")).toBeNull();
  });

  it("keeps captured port IDs opaque and unchanged", async () => {
    const runtime = await setup([add("slider", "heat")]);
    const plan = learnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "heat").id, "value", CC, " port with spaces ");
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.operations[0]).toMatchObject({ op: "addNode", parameters: { device: " port with spaces " } });
    await apply(runtime, plan);
    const read = readings(runtime, "heat");
    expect(read(cc(127), " port with spaces ")).toEqual({ value: 1 });
    expect(read(cc(127), "port with spaces")).toEqual({ value: 0.5 });
  });

  it.each(["bind", "map"] as const)("Unlearn preserves an active %s slot with a retained generated counter expression", async (mode) => {
    const runtime = await setup([add("button", "fire", { presses: 5 })]);
    await learn(runtime, "fire", "held");
    const original = named(runtime, "fire").parameters["presses"];
    if (!isParameterSlot(original)) throw new Error("Expected learned press slot.");
    const active: StoredParameter = {
      mode,
      bindings: {
        ...original.bindings,
        ...(mode === "bind" ? { bind: { kind: "bind" as const, ref: "parent.presses" } } : { map: { kind: "map" as const, attribute: "age" } }),
      },
    };
    await patch(runtime, [{ op: "setParameters", nodeId: named(runtime, "fire").id, parameters: { presses: active } }]);
    await apply(runtime, unlearnControlMidiPlan(graph(runtime), runtime.registry, named(runtime, "fire").id, "held"));
    expect(named(runtime, "fire").parameters["presses"]).toEqual(active);
    expect(controlMidiBinding(graph(runtime), named(runtime, "fire").id, "held")).toBeNull();
  });

  it("preserves an unnamed legacy MIDI source and creates an addressable source for learning", async () => {
    const runtime = await setup([add("slider", "heat"), add("midiIn", "legacy", { device: PORT })]);
    const legacyId = named(runtime, "legacy").id;
    await patch(runtime, [{ op: "setNodeLabel", nodeId: legacyId, label: null }]);
    const legacy = graph(runtime).nodes[legacyId];
    await learn(runtime, "heat", "value");
    const binding = controlMidiBinding(graph(runtime), named(runtime, "heat").id, "value");
    expect(binding?.midiId).not.toBe(legacyId);
    expect(graph(runtime).nodes[legacyId]).toEqual(legacy);
    expect(nodes(runtime, "midiIn")).toHaveLength(2);
    expect(readings(runtime, "heat")(cc(127))).toEqual({ value: 1 });
    await learn(runtime, "heat", "value");
    expect(nodes(runtime, "midiIn")).toHaveLength(2);
  });

  it("preserves an unnamed counter candidate and creates an addressable button counter", async () => {
    const runtime = await setup([add("button", "fire", { presses: 5 })]);
    await learn(runtime, "fire", "held");
    const oldCount = nodes(runtime, "valueCount")[0]!;
    const binding = controlMidiBinding(graph(runtime), named(runtime, "fire").id, "held")!;
    const pressSlot = named(runtime, "fire").parameters["presses"];
    if (!isParameterSlot(pressSlot)) throw new Error("Expected learned press slot.");
    await patch(runtime, [
      { op: "setNodeLabel", nodeId: oldCount.id, label: null },
      { op: "setParameters", nodeId: named(runtime, "fire").id, parameters: { presses: {
        ...pressSlot, bindings: { ...pressSlot.bindings, expression: { kind: "expression", source: `5 + op('${oldCount.id}').chan.${binding.channel}` } },
      } } },
    ]);
    const unnamed = graph(runtime).nodes[oldCount.id];
    const oldEdges = Object.values(graph(runtime).edges);
    await learn(runtime, "fire", "held");
    expect(nodes(runtime, "valueCount")).toHaveLength(2);
    expect(graph(runtime).nodes[oldCount.id]).toEqual(unnamed);
    for (const edge of oldEdges) expect(graph(runtime).edges[edge.id]).toEqual(edge);
    const read = readings(runtime, "fire");
    expect(read(cc(0))).toEqual({ value: 0, valueCount: 5 });
    expect(read(cc(127))).toEqual({ value: 1, valueCount: 6 });
    await learn(runtime, "fire", "held");
    expect(nodes(runtime, "valueCount")).toHaveLength(2);
  });

  it("reports missing required node definitions before emitting a patch", async () => {
    const runtime = await setup([add("slider", "heat"), add("button", "fire")]);
    const missingMidi = { ...runtime.registry, get: (type: string) => type === "midiIn" ? undefined : runtime.registry.get(type) };
    expect(learnControlMidiPlan(graph(runtime), missingMidi, named(runtime, "heat").id, "value", CC, PORT)).toMatchObject({ ok: false, code: "control.midi.unavailable" });
    const missingCount = { ...runtime.registry, get: (type: string) => type === "valueCount" ? undefined : runtime.registry.get(type) };
    expect(learnControlMidiPlan(graph(runtime), missingCount, named(runtime, "fire").id, "held", CC, PORT)).toMatchObject({ ok: false, code: "control.midi.unavailable" });
  });
});
