import { describe, expect, it } from "vitest";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { graphOf, node } from "../../domain/components/test-support.ts";
import { openComponentSession } from "../../domain/components/session.ts";
import { SCHEMA_VERSION } from "../../domain/types/schemas.ts";
import { DEFAULT_PROJECT_SETTINGS } from "../../domain/types/graph.ts";
import { componentNodeType } from "../../domain/components/component-type.ts";
import { compileGraphRetaining } from "../../compiler/index.ts";
import { testCapabilities } from "../../compiler/test-support.ts";

describe("parent() cycle validation", () => {
  it("rejects a published page expression that cycles through parent()", async () => {
    const definition: GraphComponentDefinition = {
      componentId: "rig", version: 1, name: "Rig",
      graph: graphOf([{ ...node("inner", "constant", {}, { label: "constant_inner" }), parameters: { value: expressionSlot("parent().par.gain", 0) } }]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [{ key: "gain", definition: { type: "number", label: "Gain", default: 1 }, targets: [] }],
    };
    const runtime = createAppRuntime({ identityStorage: null, components: [definition] });
    try {
      const placed = await runtime.bus.execute("component.instantiate", { componentId: "rig" }, runtime.invocation);
      expect(placed.status).toBe("applied");
      const id = placed.output.nodeId!;
      const before = JSON.stringify(runtime.bus.store.getGraph());
      const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: id, parameters: { gain: expressionSlot("op('constant_inner').par.value", 1) } },
      ] }, runtime.invocation);
      expect(result.status).toBe("rejected");
      expect(result.diagnostics.some(d => d.code === "parameter.referenceCycle")).toBe(true);
      expect(JSON.stringify(runtime.bus.store.getGraph())).toBe(before);
    } finally { runtime.dispose(); }
  });

  it("reports cycles through pages in a project loaded from a file", async () => {
    const definition: GraphComponentDefinition = {
      componentId: "rig", version: 1, name: "Rig",
      graph: graphOf([{ ...node("inner", "constant", {}, { label: "constant_inner" }), parameters: { value: expressionSlot("parent().par.gain", 0) } }]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [{ key: "gain", definition: { type: "number", label: "Gain", default: 1 }, targets: [] }],
    };
    const runtime = createAppRuntime({ identityStorage: null, components: [definition], document: {
      schemaVersion: SCHEMA_VERSION, projectId: "loaded", name: "loaded", createdAt: "2026-10-08", updatedAt: "2026-10-08", assets: [], settings: DEFAULT_PROJECT_SETTINGS,
      graph: graphOf([{ ...node("inst", componentNodeType("rig", 1), {}, { label: "rig_a" }), parameters: { gain: expressionSlot("op('constant_inner').par.value", 1) } }]),
    } });
    try {
      const result = compileGraphRetaining({ graph: runtime.bus.store.getGraph(), settings: runtime.settings, registry: runtime.registry,
        capabilities: testCapabilities(), components: runtime.components.view(), flattened: runtime.flattened.current() });
      expect(result.compiled.diagnostics.some(d => d.code === "parameter.referenceCycle")).toBe(true);
    } finally { runtime.dispose(); }
  });

  it.each([false, true])("refuses publication that makes a latent page cycle executable (dryRun=%s)", async dryRun => {
    const definition: GraphComponentDefinition = {
      componentId: "rig", version: 1, name: "Rig",
      graph: graphOf([{ ...node("inner", "constant", {}, { label: "constant_inner" }), parameters: { value: expressionSlot("parent().par.gain", 0) } }]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }], parameters: [],
    };
    const runtime = createAppRuntime({ identityStorage: null, components: [definition], document: {
      schemaVersion: SCHEMA_VERSION, projectId: "loaded", name: "loaded", createdAt: "2026-10-08", updatedAt: "2026-10-08", assets: [], settings: DEFAULT_PROJECT_SETTINGS,
      graph: graphOf([{ ...node("inst", componentNodeType("rig", 1), {}, { label: "rig_a" }), parameters: { gain: expressionSlot("op('constant_inner').par.value", 1) } }]),
    } });
    const session = openComponentSession({ componentId: "rig", version: 1, components: runtime.components, nodes: runtime.registry,
      parent: runtime.bus, root: runtime.bus.store.getGraph, instancePath: () => ["inst"] });
    try {
      const before = JSON.stringify(runtime.components.all());
      const result = await session.bus.execute("component.publishParameter", { key: "gain",
        definition: { type: "number", label: "Gain", default: 1 }, targets: [] }, { ...runtime.invocation, dryRun });
      expect(result.status).toBe("rejected");
      expect(result.diagnostics.some(d => d.code === "parameter.referenceCycle")).toBe(true);
      expect(JSON.stringify(runtime.components.all())).toBe(before);
    } finally { session.dispose(); runtime.dispose(); }
  });

  it("allows an unrelated published control in a file that already carries a cycle", async () => {
    const definition: GraphComponentDefinition = {
      componentId: "rig", version: 1, name: "Rig",
      graph: graphOf([{ ...node("inner", "constant", {}, { label: "constant_inner" }), parameters: { value: expressionSlot("parent().par.gain", 0) } }]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [{ key: "gain", definition: { type: "number", label: "Gain", default: 1 }, targets: [] }],
    };
    const runtime = createAppRuntime({ identityStorage: null, components: [definition], document: {
      schemaVersion: SCHEMA_VERSION, projectId: "loaded", name: "loaded", createdAt: "2026-10-08", updatedAt: "2026-10-08", assets: [], settings: DEFAULT_PROJECT_SETTINGS,
      graph: graphOf([{ ...node("inst", componentNodeType("rig", 1), {}, { label: "rig_a" }), parameters: { gain: expressionSlot("op('constant_inner').par.value", 1) } }]),
    } });
    const session = openComponentSession({ componentId: "rig", version: 1, components: runtime.components, nodes: runtime.registry,
      parent: runtime.bus, root: runtime.bus.store.getGraph, instancePath: () => ["inst"] });
    try {
      const result = await session.bus.execute("component.publishParameter", { key: "offset",
        definition: { type: "number", label: "Offset", default: 0 }, targets: [] }, runtime.invocation);
      expect(result.status).toBe("applied");
      expect(runtime.components.get("rig", 1)!.parameters.map(p => p.key)).toEqual(["gain", "offset"]);
    } finally { session.dispose(); runtime.dispose(); }
  });
});
