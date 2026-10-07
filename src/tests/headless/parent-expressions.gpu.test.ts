import { describe, expect, it } from "vitest";

import { createAppRuntime } from "../../app/app-runtime.ts";
import { openComponentSession } from "../../domain/components/session.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * VN36 — `parent().par.gain` INSIDE A COMPONENT, PLACED TWICE, on Dawn.
 *
 * Proposal 01 §2.3: an expression could not read its component's published parameter, so the
 * previz put a Constant "knob holder" in every component for a formula to read. Now the
 * component's Solid reads its page directly: red = `parent().par.gain`, green =
 * `1 - parent().par.gain`. Two instances, gain 1 and gain 0, must render pure red and pure
 * green: each from ITS OWN page (§V321), through the flattener's rewrite to
 * `op('<instance>').par.gain` and the reader of a dissolved instance's page.
 *
 * Built through the app's commands: the Solid saved as "Lamp", placed twice and renamed, its
 * output exposed and `gain` published from a component session, the Solid's two channels set there. 0 and 1 are
 * fixed points of the display decode (§V56), so every assertion is an exact byte (§V147).
 */

const SIZE = 16;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 64,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

interface Staged {
  readonly graph: GraphDocument;
  readonly instances: { readonly a: string; readonly b: string };
  /** The Solid's id inside the component: the instance's flat child is `<instance>/<inner>`. */
  readonly inner: string;
  readonly components: ReturnType<ReturnType<typeof createAppRuntime>["components"]["view"]>;
}

/** `pages`: each instance's `gain`. `publish`: false cuts the publish. */
async function stage(pages: { a: StoredParameter; b: StoredParameter }, publish = true): Promise<Staged> {
  const runtime = createAppRuntime({ identityStorage: null });
  const { bus, invocation } = runtime;
  const added = await bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 }, label: "solid_lamp", parameters: { color: [0, 0, 0, 1] } },
  ] }, invocation);
  expect(added.status).toBe("applied");
  const solid = added.output.createdIds["$solid"]!;
  const saved = await bus.execute("component.saveSelection", { nodeIds: [solid], name: "Lamp" }, invocation);
  expect(saved.status).toBe("applied");
  const componentId = saved.output.componentId!;
  const placed = await bus.execute("component.instantiate", { componentId }, invocation);
  expect(placed.status).toBe("applied");
  const instances = { a: saved.output.instanceNodeId!, b: placed.output.nodeId! };
  for (const [nodeId, label] of [[instances.a, "lamp_a"], [instances.b, "lamp_b"]] as const) {
    expect((await bus.execute("node.rename", { nodeId, label }, invocation)).status).toBe("applied");
  }

  // Inside the component: publish `gain`, and aim the Solid's red and green at it.
  const session = openComponentSession({ components: runtime.components, nodes: runtime.registry, componentId, version: 1 });
  const inner = Object.keys(session.bus.store.getGraph().nodes)[0]!;
  const exposed = await session.bus.execute("component.exposePort", { direction: "output", nodeId: inner, portId: "out", externalId: "out", label: "Out" }, invocation);
  expect(exposed.status, exposed.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  if (publish) {
    const published = await session.bus.execute("component.publishParameter", {
      key: "gain", definition: { type: "number", label: "Gain", default: 0.5, min: 0, max: 1 }, targets: [],
    }, invocation);
    expect(published.status, published.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  }
  const aimed = await session.bus.execute("graph.applyPatch", { baseRevision: session.bus.store.getRevision(), operations: [
    { op: "setParameters", nodeId: inner, parameters: {
      "color.r": expressionSlot("parent().par.gain", 0),
      "color.g": expressionSlot("1 - parent().par.gain", 0),
    } },
  ] }, invocation);
  expect(aimed.status, aimed.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  session.dispose();

  const definition = runtime.components.get(componentId, 1)!;
  // A page key the component does not publish is refused at the door, so the cut leaves the
  // pages at nothing: what the reads then see is exactly "no such key".
  if (publish) {
    const paged = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [
      { op: "setParameters", nodeId: instances.a, parameters: { gain: pages.a } },
      { op: "setParameters", nodeId: instances.b, parameters: { gain: pages.b } },
    ] }, invocation);
    expect(paged.status, paged.diagnostics.map((each) => each.message).join("; ")).toBe("applied");
  }
  const shown = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [
    { op: "addNode", ref: "$out", type: "output", position: { x: 400, y: 0 }, label: "output_main" },
    { op: "connect", source: { nodeId: instances.a, portId: "out" }, target: { nodeId: "$out", portId: "input" } },
  ] }, invocation);
  expect(shown.status).toBe("applied");
  expect(definition.outputs.map((each) => each.externalId)).toEqual(["out"]);
  return { graph: bus.store.getGraph(), instances, inner, components: runtime.components.view() };
}

/** Every frame of `instance`'s output, as the first pixel's RGB. The Solid fills the frame. */
async function render(staged: Staged, instance: string, frames = 1): Promise<{ rgb: number[][]; diagnostics: readonly RuntimeDiagnostic[] }> {
  // The one Output shows the instance under test: its wire is re-aimed, nothing else moves.
  const edges = Object.fromEntries(Object.entries(staged.graph.edges).map(([id, each]) =>
    [id, staged.graph.nodes[each.target.nodeId]?.type === "output" ? { ...each, source: { ...each.source, nodeId: instance } } : each]));
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: { ...staged.graph, edges },
    components: staged.components,
    settings: SETTINGS,
    frames,
    capture: Array.from({ length: frames }, (_, index) => index),
    animate: frames > 1,
    // The instance is flattened away; its Solid, by flat id, is what the plan materialises.
    outputNodeId: `${instance}/${staged.inner}`,
    outputPortId: "out",
  });
  return { rgb: result.frames.map((frame) => [frame.bytes[0]!, frame.bytes[1]!, frame.bytes[2]!]), diagnostics: result.diagnostics };
}

const parentCodes = (diagnostics: readonly RuntimeDiagnostic[]) =>
  diagnostics.filter((each) => each.code.startsWith("compiler/parent-reference")).map((each) => each.code);

async function dawn(): Promise<void> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
}

describe("VN36: parent().par.gain, one component placed twice (Dawn)", () => {
  it("each instance renders from ITS OWN page: gain 1 is red, gain 0 is green", async () => {
    await dawn();
    const staged = await stage({ a: 1, b: 0 });
    const a = await render(staged, staged.instances.a);
    const b = await render(staged, staged.instances.b);
    expect(a.diagnostics.filter((each) => each.severity === "error")).toEqual([]);
    expect(parentCodes(a.diagnostics)).toEqual([]);
    expect(a.rgb).toEqual([[255, 0, 0]]);
    expect(b.rgb).toEqual([[0, 255, 0]]);
  }, 120_000);

  it("CUT THE PUBLISH: no page key, so the reads are refused by name and both hold their static black", async () => {
    await dawn();
    const staged = await stage({ a: 1, b: 0 }, false);
    const a = await render(staged, staged.instances.a);
    const b = await render(staged, staged.instances.b);
    expect(a.rgb).toEqual([[0, 0, 0]]);
    expect(b.rgb).toEqual([[0, 0, 0]]);
    // Red and green, in each of the two instances.
    expect(parentCodes(a.diagnostics)).toEqual(Array(4).fill("compiler/parent-reference-unknown-key"));
  }, 120_000);

  it("an ANIMATED page knob animates through parent(): two frames, two colours", async () => {
    await dawn();
    const staged = await stage({ a: expressionSlot("frame % 2", 0), b: 0 });
    const { rgb } = await render(staged, staged.instances.a, 2);
    expect(rgb).toHaveLength(2);
    expect(new Set(rgb.map((each) => each.join(",")))).toEqual(new Set(["255,0,0", "0,255,0"]));
  }, 120_000);
});
