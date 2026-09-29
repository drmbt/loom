import { describe, expect, it } from "vitest";
import { alice, contextFor } from "../commands/test-support.ts";
import { createDomainBus } from "../commands/index.ts";
import type { LoomBus } from "../commands/bus.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { buildProjectFile, loadProject, type ProjectFile } from "../project/index.ts";
import type { GraphComponentDefinition } from "../types/components.ts";
import type { ProjectDocument } from "../types/graph.ts";
import { SCHEMA_VERSION } from "../types/schemas.ts";
import { DEFAULT_PROJECT_SETTINGS } from "../types/graph.ts";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { registerComponentCommands } from "./commands.ts";
import { componentNodeType } from "./component-type.ts";
import { createComponentSystem, type ComponentRegistry } from "./registry.ts";
import type { ComponentFileWriter } from "./file-commands.ts";
import { bloomComponent, blurKnob, graphOf, instanceNode, node } from "./test-support.ts";

/**
 * T1395b — a component crossing a document boundary as a file, and the §T962 identity
 * rule it arrives by (owner ruling 2026-09-29): same id + version + content is the SAME
 * component and is reused; otherwise the incoming one is imported under a new, unused id,
 * never merged into or over the installed one.
 *
 * Every test reads back what a user would: which definitions the target catalogue holds
 * (and with what content), and which node the document gained. The files are the real
 * bytes `component.export` wrote, not fixtures shaped like them.
 */

const ctx = contextFor(alice);

interface Doc {
  store: GraphStore;
  bus: LoomBus;
  components: ComponentRegistry;
}

function documentWith(definitions: readonly GraphComponentDefinition[], writeFile?: ComponentFileWriter): Doc {
  const store = createGraphStore({
    ids: createSequentialIdFactory("d"),
    now: () => "2026-09-29T00:00:00.000Z",
  });
  const system = createComponentSystem(createTestRegistry().view(), definitions);
  const { bus } = createDomainBus({ store, registry: system.nodes });
  registerComponentCommands(bus, {
    components: system.components,
    ...(writeFile === undefined ? {} : { writeFile }),
  });
  return { store, bus, components: system.components };
}

/** A bloom whose three internal radii read `radius` — the content the rule compares. */
function bloomWith(radius: number, componentId = "bloom"): GraphComponentDefinition {
  const base = bloomComponent(componentId, 1, [blurKnob]);
  const nodes = Object.fromEntries(
    Object.entries(base.graph.nodes).map(([id, each]) => [id, { ...each, parameters: { radius } }]),
  );
  return {
    ...base,
    graph: { ...base.graph, nodes },
    parameters: [{ ...blurKnob, definition: { ...blurKnob.definition, default: radius } as typeof blurKnob.definition }],
  };
}

/** A component that NESTS a bloom: bloom → tail. */
function stackOver(bloomId = "bloom", tailRadius = 2): GraphComponentDefinition {
  return {
    componentId: "stack",
    version: 1,
    name: "Stack",
    graph: graphOf(
      [
        instanceNode("inner", bloomId, 1),
        node("tail", "test.blur", { radius: tailRadius }, { position: { x: 200, y: 0 } }),
      ],
      { e1: { id: "e1", source: { nodeId: "inner", portId: "out" }, target: { nodeId: "tail", portId: "source" } } },
    ),
    inputs: [{ externalId: "source", label: "Source", nodeId: "inner", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "tail", portId: "out" }],
    parameters: [],
  };
}

/** Exports `componentId` from a document holding `definitions`, through the real command. */
async function exported(definitions: readonly GraphComponentDefinition[], componentId: string): Promise<ProjectFile> {
  const written: ProjectFile[] = [];
  const source = documentWith(definitions, async (file) => {
    written.push(file);
    return { kind: "saved", fileName: file.fileName };
  });
  const result = await source.bus.execute("component.export", { componentId }, ctx);
  expect(result.status, result.diagnostics.map((d) => d.message).join("; ")).toBe("applied");
  expect(written).toHaveLength(1);
  return written[0] as ProjectFile;
}

function radiusIn(components: ComponentRegistry, componentId: string): unknown {
  return components.get(componentId, 1)?.graph.nodes.blurA?.parameters.radius;
}

function catalogueOf(components: ComponentRegistry): string[] {
  return components.all().map((each) => `${each.componentId}@${each.version}:${each.name}`);
}

describe("component.export — one component and what it nests, as a save", () => {
  it("writes the component with every component it nests, and the file opens as a project", async () => {
    const file = await exported([bloomWith(4), stackOver()], "stack");
    expect(file.fileName).toBe("Stack.loom.json");

    // Opened as a PROJECT, through the real loader, into a catalogue that has neither.
    const target = createComponentSystem(createTestRegistry().view());
    const loaded = loadProject(file.text, { nodes: target.nodes, components: target.components });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(catalogueOf(target.components)).toEqual(["bloom@1:Bloom", "stack@1:Stack"]);
    // The host graph shows the exported component, not nothing.
    expect(Object.values(loaded.document.graph.nodes).map((each) => each.type)).toEqual([
      componentNodeType("stack", 1),
    ]);
  });

  it("refuses to pretend where nothing can write, and a dry run writes nothing", async () => {
    const headless = documentWith([bloomWith(4)]);
    const refused = await headless.bus.execute("component.export", { componentId: "bloom" }, ctx);
    expect(refused.status).toBe("rejected");
    expect(refused.diagnostics.map((d) => d.code)).toEqual(["component.export.noWriter"]);

    let writes = 0;
    const armed = documentWith([bloomWith(4)], async (file) => {
      writes += 1;
      return { kind: "saved", fileName: file.fileName };
    });
    const dry = await armed.bus.execute("component.export", { componentId: "bloom" }, { ...ctx, dryRun: true });
    expect(dry.status).toBe("validated");
    expect(writes).toBe(0);

    const missing = await armed.bus.execute("component.export", { componentId: "nope" }, ctx);
    expect(missing.diagnostics.map((d) => d.code)).toEqual(["component.notInstalled"]);
  });
});

describe("component.import — the identity rule (§T962, owner ruling 2026-09-29)", () => {
  it("installs a component nobody has under its own id and places it at the drop point", async () => {
    const file = await exported([bloomWith(4), stackOver()], "stack");
    const target = documentWith([]);

    const result = await target.bus.execute(
      "component.import",
      { text: file.text, fileName: file.fileName, position: { x: 320, y: -40 } },
      ctx,
    );

    expect(result.status, result.diagnostics.map((d) => d.message).join("; ")).toBe("applied");
    expect(catalogueOf(target.components)).toEqual(["bloom@1:Bloom", "stack@1:Stack"]);
    const placed = target.store.view.getGraph().nodes[result.output.nodeId as string];
    expect(placed?.type).toBe(componentNodeType("stack", 1));
    expect(placed?.position).toEqual({ x: 320, y: -40 });
    // The published defaults, as a library placement would set them.
    expect(result.output.renamed).toEqual([]);
  });

  it("REUSES an installed component with the same id, version and content — no duplicate", async () => {
    const file = await exported([bloomWith(4)], "bloom");
    const target = documentWith([bloomWith(4)]);
    const before = target.components.get("bloom", 1);

    const result = await target.bus.execute("component.import", { text: file.text }, ctx);

    expect(result.status).toBe("applied");
    expect(catalogueOf(target.components)).toEqual(["bloom@1:Bloom"]);
    // Not re-registered: the very definition object the document already had.
    expect(target.components.get("bloom", 1)).toBe(before);
    expect(target.store.view.getGraph().nodes[result.output.nodeId as string]?.type).toBe(
      componentNodeType("bloom", 1),
    );
    expect(result.output.reused).toEqual([{ componentId: "bloom", version: 1 }]);
  });

  it("imports a same-id, same-version, DIFFERENT component as bloom1 and leaves the installed one alone", async () => {
    const file = await exported([bloomWith(9)], "bloom");
    const target = documentWith([bloomWith(4)]);

    const result = await target.bus.execute("component.import", { text: file.text }, ctx);

    expect(result.status).toBe("applied");
    expect(catalogueOf(target.components)).toEqual(["bloom@1:Bloom", "bloom1@1:Bloom1"]);
    // Neither merged nor overwritten: the document's own bloom still reads 4…
    expect(radiusIn(target.components, "bloom")).toBe(4);
    // …and the file's content arrived intact under the new name.
    expect(radiusIn(target.components, "bloom1")).toBe(9);
    expect(target.store.view.getGraph().nodes[result.output.nodeId as string]?.type).toBe(
      componentNodeType("bloom1", 1),
    );
    expect(result.diagnostics.map((d) => d.code)).toEqual(["component.import.renamed"]);
  });

  it("dropping the same file twice reuses the first import instead of minting bloom2", async () => {
    const file = await exported([bloomWith(9)], "bloom");
    const target = documentWith([bloomWith(4)]);

    await target.bus.execute("component.import", { text: file.text }, ctx);
    const again = await target.bus.execute("component.import", { text: file.text }, ctx);

    expect(again.status).toBe("applied");
    expect(catalogueOf(target.components)).toEqual(["bloom@1:Bloom", "bloom1@1:Bloom1"]);
    expect(target.store.view.getGraph().nodes[again.output.nodeId as string]?.type).toBe(
      componentNodeType("bloom1", 1),
    );
  });

  it("renames a colliding NESTED component and rewrites the reference that pointed at it", async () => {
    const file = await exported([bloomWith(9), stackOver()], "stack");
    const target = documentWith([bloomWith(4)]);

    const result = await target.bus.execute("component.import", { text: file.text }, ctx);

    expect(result.status, result.diagnostics.map((d) => d.message).join("; ")).toBe("applied");
    expect(catalogueOf(target.components)).toEqual(["bloom@1:Bloom", "bloom1@1:Bloom1", "stack@1:Stack"]);
    // The stack's inner instance follows the rename — it holds the FILE's bloom, not ours.
    expect(target.components.get("stack", 1)?.graph.nodes.inner?.type).toBe(componentNodeType("bloom1", 1));
    expect(radiusIn(target.components, "bloom1")).toBe(9);
    expect(radiusIn(target.components, "bloom")).toBe(4);
  });

  it("renames the parent too when only its dependency collided — the reference IS content", async () => {
    // The target already holds the identical stack, but over a DIFFERENT bloom.
    const file = await exported([bloomWith(9), stackOver()], "stack");
    const target = documentWith([bloomWith(4), stackOver()]);

    const result = await target.bus.execute("component.import", { text: file.text }, ctx);

    expect(result.status).toBe("applied");
    expect(catalogueOf(target.components)).toEqual([
      "bloom@1:Bloom",
      "bloom1@1:Bloom1",
      "stack@1:Stack",
      "stack1@1:Stack1",
    ]);
    expect(target.components.get("stack", 1)?.graph.nodes.inner?.type).toBe(componentNodeType("bloom", 1));
    expect(target.components.get("stack1", 1)?.graph.nodes.inner?.type).toBe(componentNodeType("bloom1", 1));
    expect(target.store.view.getGraph().nodes[result.output.nodeId as string]?.type).toBe(
      componentNodeType("stack1", 1),
    );
  });

  it("is one undo step, and undo removes the instance", async () => {
    const file = await exported([bloomWith(4)], "bloom");
    const target = documentWith([]);
    await target.bus.execute("component.import", { text: file.text }, ctx);
    expect(Object.keys(target.store.view.getGraph().nodes)).toHaveLength(1);
    await target.bus.execute("graph.undo", {}, ctx);
    expect(Object.keys(target.store.view.getGraph().nodes)).toHaveLength(0);
  });
});

describe("component.import — refused files change nothing", () => {
  const project = (definitions: readonly GraphComponentDefinition[]): string => {
    const document: ProjectDocument = {
      schemaVersion: SCHEMA_VERSION,
      projectId: "p",
      name: "A project",
      settings: DEFAULT_PROJECT_SETTINGS,
      assets: [],
      createdAt: "2026-09-29T00:00:00.000Z",
      updatedAt: "2026-09-29T00:00:00.000Z",
      graph: graphOf([node("solid", "test.solid")]),
    };
    return buildProjectFile({ document, components: definitions, now: () => document.updatedAt }).text;
  };

  const cases: ReadonlyArray<{ name: string; text: () => Promise<string> | string; code: string }> = [
    {
      name: "a whole project (the app saves its whole catalogue: many top-level components)",
      text: () => project([bloomWith(9, "glow"), bloomWith(9, "haze")]),
      code: "component.import.notAComponent",
    },
    { name: "a project with no component in it", text: () => project([]), code: "component.import.noComponent" },
    { name: "text that is not JSON", text: () => '{"componentLibrary": ', code: "component.import.malformed" },
    {
      name: "a library that does not read",
      text: () => project([bloomWith(9, "glow")]).replace('"version": 1', '"version": "one"'),
      code: "component.import.malformed",
    },
    {
      name: "a file that needs a component it neither carries nor finds",
      text: () => project([stackOver("elsewhere")]),
      code: "component.import.missingDependency",
    },
    {
      name: "components that contain each other (§V83)",
      text: () => {
        const a = { ...stackOver("b"), componentId: "a", name: "A" };
        const b = { ...stackOver("a"), componentId: "b", name: "B" };
        const top = { ...stackOver("a"), componentId: "top", name: "Top" };
        return project([a, b, top]);
      },
      code: "component.recursion",
    },
  ];

  it.each(cases)("refuses $name, and leaves the document and catalogue as they were", async ({ text, code }) => {
    const target = documentWith([bloomWith(4)]);
    await target.bus.execute(
      "graph.applyPatch",
      { baseRevision: target.store.view.getRevision(), operations: [{ op: "addNode", ref: "$s", type: "test.solid", position: { x: 0, y: 0 } }], label: "seed" },
      ctx,
    );
    const graphBefore = target.store.view.getGraph();
    const catalogueBefore = catalogueOf(target.components);

    const result = await target.bus.execute("component.import", { text: await text(), fileName: "x.loom.json" }, ctx);

    expect(result.status).toBe("rejected");
    expect(result.output.ok).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(code);
    expect(target.store.view.getGraph()).toBe(graphBefore);
    expect(catalogueOf(target.components)).toEqual(catalogueBefore);
  });

  it("refuses the palette's empty call by name instead of throwing", async () => {
    const target = documentWith([]);
    const result = await target.bus.execute("component.import", {} as never, ctx);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((d) => d.code)).toEqual(["component.import.input"]);
  });
});
