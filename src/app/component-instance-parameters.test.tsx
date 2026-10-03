// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { graphOf, instanceNode, node } from "@domain/components/test-support.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { parseProjectDocument, serializeProjectDocument } from "@domain/project/index.ts";
import { Inspector } from "@editor/inspector/inspector.tsx";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createAppRuntime, type AppRuntime } from "./app-runtime.ts";
import { useComponentEditing, type ComponentEditing } from "./use-component-editing.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

function maskComponent(runtime: AppRuntime): GraphComponentDefinition {
  const channel = effectiveParameterSchema(runtime.registry.get("mask"), {}).channel;
  if (channel?.type !== "enum") throw new Error("Mask channel must be an enum");
  return {
    componentId: "syncMask", version: 1, name: "Sync Mask",
    graph: graphOf([node("first", "mask", { channel: "red" }), node("second", "mask", { channel: "red" })]),
    inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "first", portId: "out" }],
    parameters: [{ key: "maskSource", definition: { ...channel, label: "Published source", default: "green" },
      targets: [{ nodeId: "first", key: "channel" }, { nodeId: "second", key: "channel" }] }],
  };
}

function Harness({ runtime, handle, nodeId = "first" }: { runtime: AppRuntime; handle: { editing: ComponentEditing | null }; nodeId?: NodeId }) {
  const editing = useComponentEditing(runtime);
  handle.editing = editing;
  return editing.insideComponent ? <Inspector
    bus={editing.bus} context={runtime.invocation} nodeId={nodeId} settings={runtime.settings}
    {...(editing.instanceParameters === undefined ? {} : { instanceParameters: editing.instanceParameters })}
  /> : null;
}

async function setup(nested = false, intermediate = false, privatePage = false) {
  const runtime = createAppRuntime({ identityStorage: null });
  const definition = maskComponent(runtime);
  runtime.components.register(definition);
  if (nested) runtime.components.register({
    componentId: "syncOuter", version: 1, name: "Sync Outer",
    graph: graphOf([instanceNode("inner", "syncMask", 1, { maskSource: "red" })]), inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
    parameters: privatePage ? [] : [{ key: "outerSource", definition: definition.parameters[0]!.definition,
      targets: [{ nodeId: "inner", key: "maskSource" }] }],
  });
  const ids: NodeId[] = [];
  for (const x of [0, 400]) {
    const placed = await runtime.bus.execute("component.instantiate", {
      componentId: nested ? "syncOuter" : "syncMask", position: { x, y: 0 },
    }, runtime.invocation);
    expect(placed.output.ok).toBe(true);
    ids.push(placed.output.nodeId!);
  }
  const first = ids[0]!;
  const second = ids[1]!;
  const handle: { editing: ComponentEditing | null } = { editing: null };
  render(<Harness runtime={runtime} handle={handle} nodeId={intermediate ? "inner" : "first"} />);
  await act(async () => {
    await runtime.bus.execute("graph.diveIn", { nodeId: first }, runtime.invocation);
    if (nested && !intermediate) await runtime.bus.execute("graph.diveIn", { nodeId: "inner" }, runtime.invocation);
  });
  const sourceKey = nested ? "outerSource" : "maskSource";
  const prefix = nested ? `${first}/inner` : first;
  const source = () => screen.getByLabelText(intermediate ? "Published source" : "Mask Source") as HTMLSelectElement;
  const setParent = async (value: string) => act(async () => {
    const result = await runtime.bus.execute("graph.applyPatch", {
      baseRevision: runtime.bus.store.getRevision(),
      operations: [{ op: "setParameters", nodeId: first, parameters: { [sourceKey]: value } }],
    }, runtime.invocation);
    expect(result.status).toBe("applied");
  });
  return { runtime, definition, first, second, handle, source, sourceKey, prefix, setParent };
}

describe("published child controls edit and read their owning instance", () => {
  it("edits Common channels on only the drilled instance and keeps controls in sync", async () => {
    const { runtime, first, second, handle, prefix } = await setup(true);
    const tab = screen.getByRole("tab", { name: "Common" });
    fireEvent.mouseDown(tab, { button: 0 });
    fireEvent.click(tab);
    const alpha = screen.getByRole("button", { name: "Process A" });
    fireEvent.click(alpha);
    await waitFor(() => expect(runtime.flattened.current().graph.nodes[`${prefix}/first`]?.channelMask)
      .toEqual({ r: true, g: true, b: true, a: false }));
    expect(runtime.flattened.current().graph.nodes[`${second}/inner/first`]?.channelMask).toBeUndefined();
    expect(handle.editing?.graph.nodes.first?.channelMask).toBeUndefined();
    expect(alpha.getAttribute("aria-pressed")).toBe("false");
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    expect(alpha.getAttribute("aria-pressed")).toBe("true");
    expect(runtime.bus.store.getGraph().nodes[first]?.state?.componentChannelMaskOverrides).toBeUndefined();
  });


  it("edits a private nested published page on its nearest parent authoring bus", async () => {
    const { runtime, source, first, definition, handle } = await setup(true, false, true);
    const rootBefore = runtime.bus.store.getGraph();
    expect(source().value).toBe("red");
    await act(async () => { fireEvent.change(source(), { target: { value: "blue" } }); });
    await waitFor(() => expect(runtime.components.get("syncOuter", 1)?.graph.nodes.inner?.parameters.maskSource).toBe("blue"));
    expect(source().value).toBe("blue");
    expect(runtime.bus.store.getGraph()).toBe(rootBefore);
    expect(runtime.components.get("syncMask", 1)).toBe(definition);
    const target = handle.editing!.instanceParameters!.target("first", "channel")!;
    expect(target.nodeId).toBe("inner");
    expect(target.key).toBe("maskSource");
    expect(target.bus).not.toBe(handle.editing!.bus);
    await act(async () => { await target.bus.execute("graph.undo", {}, runtime.invocation); });
    expect(source().value).toBe("red");
    expect(runtime.flattened.current().graph.nodes[`${first}/inner/first`]?.parameters.channel).toBe("red");
  });

  it("keeps the intermediate nested component's own published control synchronized too", async () => {
    const { runtime, source, first, sourceKey, setParent, handle } = await setup(true, true);
    expect(handle.editing?.graph.nodes.inner?.parameters.maskSource).toBe("red");
    expect(source().value).toBe("green");
    await setParent("blue");
    expect(source().value).toBe("blue");
    await act(async () => { fireEvent.change(source(), { target: { value: "alpha" } }); });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[first]?.parameters[sourceKey]).toBe("alpha"));
    expect(handle.editing?.graph.nodes.inner?.parameters.maskSource).toBe("red");
  });

  it("reads a published default omitted by a loaded instance", async () => {
    const seed = createAppRuntime({ identityStorage: null });
    const definition = maskComponent(seed);
    const runtime = createAppRuntime({ identityStorage: null, components: [definition], document: {
      ...seed.project, settings: seed.settings,
      graph: graphOf([instanceNode("unseeded", "syncMask", 1)]),
    } });
    const handle: { editing: ComponentEditing | null } = { editing: null };
    render(<Harness runtime={runtime} handle={handle} />);
    await act(async () => { await runtime.bus.execute("graph.diveIn", { nodeId: "unseeded" }, runtime.invocation); });
    expect(runtime.bus.store.getGraph().nodes.unseeded?.parameters).toEqual({});
    expect((screen.getByLabelText("Mask Source") as HTMLSelectElement).value).toBe("green");
  });

  it.each([false, true])("shows defaults and follows parent changes while drilled (nested=%s)", async nested => {
    const { source, setParent, handle } = await setup(nested);
    expect(handle.editing?.graph.nodes.first?.parameters.channel).toBe("red");
    expect(source().value).toBe("green");
    await setParent("blue");
    expect(source().value).toBe("blue");
    expect(handle.editing?.graph.nodes.first?.parameters.channel).toBe("red");
  });

  it.each([false, true])("child edits fan out, persist, and undo on the parent without changing its peer (nested=%s)", async nested => {
    const { runtime, definition, source, first, second, sourceKey, prefix, handle } = await setup(nested);
    await act(async () => { fireEvent.change(source(), { target: { value: "alpha" } }); });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[first]?.parameters[sourceKey]).toBe("alpha"));
    expect(source().value).toBe("alpha");
    expect(runtime.bus.store.getGraph().nodes[second]?.parameters[sourceKey]).toBe("green");
    for (const id of ["first", "second"]) expect(runtime.flattened.current().graph.nodes[`${prefix}/${id}`]?.parameters.channel).toBe("alpha");
    expect(runtime.components.get("syncMask", 1)).toBe(definition);
    expect(handle.editing?.graph.nodes.first?.parameters.channel).toBe("red");
    const parsed = parseProjectDocument(serializeProjectDocument({ ...runtime.project, settings: runtime.settings,
      graph: runtime.bus.store.getGraph() }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.document.graph.nodes[first]?.parameters[sourceKey]).toBe("alpha");
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    expect(source().value).toBe("green");
  });

  it("keeps a parent's inactive expression when a child writes its constant", async () => {
    const { runtime, source, first, sourceKey } = await setup();
    await act(async () => {
      const seeded = await runtime.bus.execute("graph.applyPatch", {
        baseRevision: runtime.bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: first,
          parameters: { [sourceKey]: { mode: "static", bindings: {
            static: { kind: "static", value: "green" }, expression: { kind: "expression", source: "1" },
          } } } }],
      }, runtime.invocation);
      expect(seeded.status, seeded.diagnostics.map(entry => entry.message).join("; ")).toBe("applied");
      fireEvent.change(source(), { target: { value: "alpha" } });
    });
    await waitFor(() => expect(runtime.bus.store.getGraph().nodes[first]?.parameters[sourceKey]).toMatchObject({
      mode: "static", bindings: { static: { value: "alpha" }, expression: { source: "1" } },
    }));
  });

  it("routes per-channel colour edits to the corresponding published component key", async () => {
    const runtime = createAppRuntime({ identityStorage: null });
    const color = effectiveParameterSchema(runtime.registry.get("circle"), {}).fillcolor;
    if (color?.type !== "color") throw new Error("Circle fill must be a colour");
    runtime.components.register({ componentId: "syncColor", version: 1, name: "Sync Color",
      graph: graphOf([node("first", "circle", { fillcolor: [1, 1, 1, 1] })]), inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "first", portId: "out" }],
      parameters: [{ key: "tint", definition: color, targets: [{ nodeId: "first", key: "fillcolor" }] }],
    });
    const placed = await runtime.bus.execute("component.instantiate", { componentId: "syncColor", position: { x: 0, y: 0 } }, runtime.invocation);
    const first = placed.output.nodeId!;
    const handle: { editing: ComponentEditing | null } = { editing: null };
    render(<Harness runtime={runtime} handle={handle} />);
    await act(async () => { await runtime.bus.execute("graph.diveIn", { nodeId: first }, runtime.invocation); });
    const editing = handle.editing!;
    const editor = createParameterEditor({ bus: editing.bus, context: runtime.invocation,
      parameterTarget: editing.instanceParameters!.target });
    await act(async () => {
      editor.setParameter("first", "fillcolor.r", 0.25, "commit");
      await editor.settled();
    });
    expect(runtime.bus.store.getGraph().nodes[first]?.parameters["tint.r"]).toBe(0.25);
    expect(editing.bus.store.getGraph().nodes.first?.parameters.fillcolor).toEqual([1, 1, 1, 1]);
    editor.dispose();
  });
});
