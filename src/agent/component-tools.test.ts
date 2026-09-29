import { describe, expect, it } from "vitest";

import type { LoomBus } from "@domain/commands/bus.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { registerComponentCommands } from "@domain/components/commands.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import type { ComponentImportOutput } from "@domain/components/file-commands.ts";
import { createComponentSystem, type ComponentRegistry } from "@domain/components/registry.ts";
import { bloomComponent, blurKnob, graphOf, instanceNode, node } from "@domain/components/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore, type GraphStore } from "@domain/graph/store.ts";
import type { Actor } from "@domain/types/commands.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";

import { createAgentToolSurface, type AgentToolSurface } from "./surface.ts";
import type { ExportComponentData } from "./tools/components.ts";

/**
 * T1494b — the agent's door to component files, through the REAL bus on both ends.
 *
 * What an agent needs from this pair is one thing: a component it can see in one document
 * arrives, whole and by the §T962 identity rule, in another. So every test moves real
 * exported text between two separate documents and reads back what the TARGET catalogue
 * and graph hold — not which command was called.
 */

const AGENT: Actor = { kind: "agent", id: "claude", label: "Claude" };

interface Doc {
  store: GraphStore;
  bus: LoomBus;
  components: ComponentRegistry;
  surface: AgentToolSurface;
  writes: number;
}

function documentWith(definitions: readonly GraphComponentDefinition[]): Doc {
  const store = createGraphStore({ ids: createSequentialIdFactory("d"), now: () => "2026-09-29T00:00:00.000Z" });
  const system = createComponentSystem(createTestRegistry().view(), definitions);
  const { bus } = createDomainBus({ store, registry: system.nodes });
  const doc: Doc = {
    store,
    bus,
    components: system.components,
    surface: createAgentToolSurface({ bus, actor: AGENT, projectId: "p" }),
    writes: 0,
  };
  // A writer IS present, as in the app: the export tool must still not use it.
  registerComponentCommands(bus, {
    components: system.components,
    writeFile: async (file) => {
      doc.writes += 1;
      return { kind: "saved", fileName: file.fileName };
    },
  });
  return doc;
}

/** §V38: the grant arrives from whoever owns the store — here the test, as composition root. */
function granted(doc: Doc): Doc {
  doc.bus.grants.grant(AGENT, "componentInstall");
  return doc;
}

function bloomWith(radius: number): GraphComponentDefinition {
  const base = bloomComponent("bloom", 1, [blurKnob]);
  const nodes = Object.fromEntries(
    Object.entries(base.graph.nodes).map(([id, each]) => [id, { ...each, parameters: { radius } }]),
  );
  return { ...base, graph: { ...base.graph, nodes } };
}

/** A component that nests the bloom: the export must carry both. */
const stack: GraphComponentDefinition = {
  componentId: "stack",
  version: 1,
  name: "Stack",
  graph: graphOf(
    [instanceNode("inner", "bloom", 1), node("tail", "test.blur", { radius: 2 }, { position: { x: 200, y: 0 } })],
    { e1: { id: "e1", source: { nodeId: "inner", portId: "out" }, target: { nodeId: "tail", portId: "source" } } },
  ),
  inputs: [{ externalId: "source", label: "Source", nodeId: "inner", portId: "source" }],
  outputs: [{ externalId: "out", label: "Out", nodeId: "tail", portId: "out" }],
  parameters: [],
};

const radiusIn = (components: ComponentRegistry, componentId: string): unknown =>
  components.get(componentId, 1)?.graph.nodes.blurA?.parameters.radius;

const catalogueOf = (components: ComponentRegistry): string[] =>
  components.all().map((each) => `${each.componentId}@${each.version}`);

const nodeTypes = (store: GraphStore): string[] => Object.values(store.view.getGraph().nodes).map((each) => each.type);

async function exportedText(source: Doc, componentId: string): Promise<string> {
  const exported = await source.surface.callTool("export_component", { componentId });
  expect(exported.status, exported.diagnostics.map((d) => d.message).join("; ")).toBe("ok");
  const data = exported.data as ExportComponentData;
  expect(typeof data.text).toBe("string");
  return data.text as string;
}

describe("export_component → import_component (T1494b)", () => {
  it("carries a component and what it nests into another document, and writes no file", async () => {
    const source = documentWith([bloomWith(9), stack]);
    const text = await exportedText(source, "stack");
    // The agent's export is the bytes, not a save: the page's writer is never touched.
    expect(source.writes).toBe(0);

    const target = granted(documentWith([]));
    const imported = await target.surface.callTool("import_component", { text, position: { x: 40, y: 60 } });

    expect(imported.status, imported.diagnostics.map((d) => d.message).join("; ")).toBe("ok");
    expect(catalogueOf(target.components)).toEqual(["bloom@1", "stack@1"]);
    // The CONTENT arrived, not just the names: the nested bloom holds the source's radius.
    expect(radiusIn(target.components, "bloom")).toBe(9);
    const placed = (imported.data as ComponentImportOutput).nodeId;
    expect(placed).not.toBeNull();
    expect(target.store.view.getGraph().nodes[placed as string]).toMatchObject({
      type: componentNodeType("stack", 1),
      position: { x: 40, y: 60 },
    });
    // One edit, one undo step the presence panel can revert.
    expect(imported.undoGroupId).toBeDefined();
  });

  it("reuses what the target already has, and renames a different component under a taken id", async () => {
    const text = await exportedText(documentWith([bloomWith(9)]), "bloom");

    // Same id, version and content: reused, nothing new installed.
    const same = granted(documentWith([bloomWith(9)]));
    const reused = (await same.surface.callTool("import_component", { text })).data as ComponentImportOutput;
    expect(reused.installed).toEqual([]);
    expect(reused.reused).toEqual([{ componentId: "bloom", version: 1 }]);
    expect(catalogueOf(same.components)).toEqual(["bloom@1"]);
    expect(nodeTypes(same.store)).toEqual([componentNodeType("bloom", 1)]);

    // Same id, different content: imported as bloom1, the installed bloom left alone.
    const other = granted(documentWith([bloomWith(4)]));
    const renamed = (await other.surface.callTool("import_component", { text })).data as ComponentImportOutput;
    expect(renamed.componentId).toBe("bloom1");
    expect(catalogueOf(other.components)).toEqual(["bloom@1", "bloom1@1"]);
    expect(radiusIn(other.components, "bloom")).toBe(4);
    expect(radiusIn(other.components, "bloom1")).toBe(9);
    expect(nodeTypes(other.store)).toEqual([componentNodeType("bloom1", 1)]);
  });

  it("installs nothing without the componentInstall grant (§V38), and a dry run installs nothing", async () => {
    const text = await exportedText(documentWith([bloomWith(9)]), "bloom");

    const cold = documentWith([]);
    const denied = await cold.surface.callTool("import_component", { text });
    expect(denied.status).toBe("denied");
    expect(catalogueOf(cold.components)).toEqual([]);
    expect(nodeTypes(cold.store)).toEqual([]);

    const warm = granted(documentWith([]));
    const dry = await warm.surface.callTool("import_component", { text, dryRun: true });
    expect(dry.status).toBe("validated");
    expect((dry.data as ComponentImportOutput).installed).toEqual([{ componentId: "bloom", version: 1 }]);
    expect(catalogueOf(warm.components)).toEqual([]);
    expect(nodeTypes(warm.store)).toEqual([]);
  });

  it("refuses an unknown component by name rather than returning an empty file", async () => {
    const exported = await documentWith([bloomWith(9)]).surface.callTool("export_component", { componentId: "nope" });
    expect(exported.status).toBe("rejected");
    expect(exported.diagnostics.map((d) => d.code)).toEqual(["component.notInstalled"]);
    expect((exported.data as ExportComponentData).text).toBeNull();
  });
});
