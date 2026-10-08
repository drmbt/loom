import { describe, expect, it } from "vitest";
import { createAppRuntime } from "../app/app-runtime.ts";
import { graphOf, node } from "../domain/components/test-support.ts";
import type { GraphComponentDefinition } from "../domain/types/components.ts";
import type { ParameterSlot } from "../domain/types/parameters.ts";
import { referenceCycleDiagnostics } from "../domain/graph/reference-cycles.ts";
import { openComponentSession } from "../domain/components/session.ts";

const expression = (source: string): ParameterSlot => ({ mode: "expression", bindings: { static: { kind: "static", value: 0 }, expression: { kind: "expression", source } } });

async function fixture(backReference = true, label = "rig_a") {
  const definition: GraphComponentDefinition = {
    componentId: "rig", version: 1, name: "Rig",
    graph: graphOf([{ ...node("inner", "constant", {}, { label: "constant_inner" }), parameters: {
      value: backReference ? expression("op('../constant_root').par.value") : 7,
    } }]),
    inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }], parameters: [],
  };
  const runtime = createAppRuntime({ identityStorage: null, components: [definition] });
  const added = await runtime.bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
    { op: "addNode", ref: "$root", type: "constant", position: { x: 0, y: 0 }, label: "constant_root" },
  ] }, runtime.invocation);
  expect(added.status).toBe("applied");
  const placed = await runtime.bus.execute("component.instantiate", { componentId: definition.componentId }, runtime.invocation);
  expect(placed.status).toBe("applied");
  expect((await runtime.bus.execute("node.rename", { nodeId: placed.output.nodeId!, label }, runtime.invocation)).status).toBe("applied");
  return { runtime, rootId: added.output.createdIds["$root"]!, instanceId: placed.output.nodeId! };
}

describe("path reference cycle validation", () => {
  it.each([false, true])("rejects cyclic writes atomically, including dry runs (dryRun=%s)", async dryRun => {
    const { runtime, rootId } = await fixture();
    try {
      const before = JSON.stringify(runtime.bus.store.getGraph());
      const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: rootId, parameters: { value: expression("op('rig_a/constant_inner').par.value") } },
      ] }, { ...runtime.invocation, dryRun });
      expect(result.status).toBe("rejected");
      expect(result.diagnostics.some(d => d.code === "parameter.referenceCycle")).toBe(true);
      expect(JSON.stringify(runtime.bus.store.getGraph())).toBe(before);
      expect(referenceCycleDiagnostics(runtime.flattened.current().graph)).toEqual([]);
    } finally { runtime.dispose(); }
  });

  it("also rejects activating a retained path expression through the parameter command", async () => {
    const { runtime, rootId } = await fixture();
    try {
      const inactive = { ...expression("op('rig_a/constant_inner').par.value"), mode: "static" as const };
      const stored = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: rootId, parameters: { value: inactive } },
      ] }, runtime.invocation);
      expect(stored.status).toBe("applied");
      const before = JSON.stringify(runtime.bus.store.getGraph());
      const result = await runtime.bus.execute("parameter.setMode", { nodeId: rootId, parameterKey: "value", mode: "expression" }, runtime.invocation);
      expect(result.status).toBe("rejected");
      expect(result.diagnostics.some(d => d.code === "parameter.referenceCycle")).toBe(true);
      expect(JSON.stringify(runtime.bus.store.getGraph())).toBe(before);
    } finally { runtime.dispose(); }
  });

  it("refuses a rename that makes a dangling path close a cycle", async () => {
    const { runtime, rootId, instanceId } = await fixture(true, "rig_b");
    try {
      const written = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: rootId, parameters: { value: expression("op('rig_a/constant_inner').par.value") } },
      ] }, runtime.invocation);
      expect(written.status).toBe("applied");
      const before = JSON.stringify(runtime.bus.store.getGraph());
      const renamed = await runtime.bus.execute("node.rename", { nodeId: instanceId, label: "rig_a" }, runtime.invocation);
      expect(renamed.status).toBe("rejected");
      expect(renamed.diagnostics.some(d => d.code === "parameter.referenceCycle")).toBe(true);
      expect(JSON.stringify(runtime.bus.store.getGraph())).toBe(before);
    } finally { runtime.dispose(); }
  });

  it("rejects a definition edit that closes a cycle through its owning project", async () => {
    const { runtime, rootId, instanceId } = await fixture(false);
    let session: ReturnType<typeof openComponentSession> | undefined;
    try {
      const written = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: rootId, parameters: { value: expression("op('rig_a/constant_inner').par.value") } },
      ] }, runtime.invocation);
      expect(written.status).toBe("applied");
      session = openComponentSession({ componentId: "rig", version: 1, components: runtime.components, nodes: runtime.registry,
        parent: runtime.bus, root: runtime.bus.store.getGraph, instancePath: () => [instanceId] });
      const before = JSON.stringify(runtime.components.all());
      const graphBefore = JSON.stringify(session.bus.store.getGraph());
      const result = await session.bus.execute("graph.applyPatch", { baseRevision: session.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: "inner", parameters: { value: expression("op('../constant_root').par.value") } },
      ] }, runtime.invocation);
      expect(result.status).toBe("rejected");
      expect(result.diagnostics.some(d => d.code === "parameter.referenceCycle")).toBe(true);
      expect(JSON.stringify(session.bus.store.getGraph())).toBe(graphBefore);
      expect(JSON.stringify(runtime.components.all())).toBe(before);
    } finally { session?.dispose(); runtime.dispose(); }
  });

  it("allows acyclic paths and unrelated edits in a document with an existing cycle", async () => {
    const { runtime, rootId } = await fixture(false);
    try {
      const valid = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: rootId, parameters: { value: expression("op('rig_a/constant_inner').par.value") } },
      ] }, runtime.invocation);
      expect(valid.status).toBe("applied");
      expect(referenceCycleDiagnostics(runtime.flattened.current().graph)).toEqual([]);
      const document = runtime.projectDocument();
      const cyclic = { ...document, graph: { ...document.graph, nodes: { ...document.graph.nodes,
        [rootId]: { ...document.graph.nodes[rootId]!, parameters: { value: expression("op('constant_root').par.value") } },
      } } };
      const reopened = createAppRuntime({ identityStorage: null, document: cyclic, components: runtime.components.all() });
      try {
        const unrelated = await reopened.bus.execute("graph.applyPatch", { baseRevision: reopened.bus.store.getRevision(), operations: [
          { op: "addNode", ref: "$other", type: "constant", position: { x: 300, y: 0 }, label: "constant_other" },
        ] }, reopened.invocation);
        expect(unrelated.status).toBe("applied");
      } finally { reopened.dispose(); }
    } finally { runtime.dispose(); }
  });
});
