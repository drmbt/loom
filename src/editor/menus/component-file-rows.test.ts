import { describe, expect, it } from "vitest";

import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { registerComponentCommands } from "@domain/components/commands.ts";
import { readComponentFile } from "@domain/components/component-file.ts";
import { componentNodeType } from "@domain/components/component-type.ts";
import type { ComponentFileReadOutcome } from "@domain/components/file-commands.ts";
import { createComponentSystem, type ComponentRegistry } from "@domain/components/registry.ts";
import { bloomComponent, graphOf, instanceNode, node } from "@domain/components/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore, type GraphStore } from "@domain/graph/store.ts";
import type { ProjectFile } from "@domain/project/project-file.ts";
import type { CommandName, CommandInput } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { isMenuSeparator, type MenuEntry, type MenuItem, type MenuTarget } from "@domain/types/menus.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";

import { DEFAULT_BINDINGS } from "../keymap/defaults.ts";
import { resolveKeymap } from "../keymap/resolve.ts";
import { buildPaletteEntries } from "../palette/entries.ts";
import type { MenuContext } from "./guards.ts";
import { resolveMenuInput } from "./input.ts";
import { menuSchemaFor } from "./schemas.ts";

/**
 * T1494b — the component file commands' menu and palette doors.
 *
 * Before this, the only door to `component.export` was the library row's button and the
 * only door to `component.import` a file drag. Each test takes the REAL row out of the
 * real schema, resolves its input the way the menu host does on open, and runs it on a
 * bus the component commands are registered on — then reads back what the user would:
 * the file that was written, the node that landed and where.
 */

const ctx = contextFor(alice);

interface Doc {
  store: GraphStore;
  bus: LoomBus;
  components: ComponentRegistry;
  written: ProjectFile[];
  /** What the next open picker answers. */
  pick: ComponentFileReadOutcome;
}

function documentWith(installed: boolean, initialGraph?: GraphDocument): Doc {
  const store = createGraphStore({
    ids: createSequentialIdFactory("m"),
    now: () => "2026-09-29T00:00:00.000Z",
    ...(initialGraph === undefined ? {} : { initialGraph }),
  });
  const system = createComponentSystem(createTestRegistry().view(), installed ? [bloomComponent()] : []);
  const { bus } = createDomainBus({ store, registry: system.nodes });
  const doc: Doc = { store, bus, components: system.components, written: [], pick: { kind: "cancelled" } };
  registerComponentCommands(bus, {
    components: system.components,
    writeFile: async (file) => {
      doc.written.push(file);
      return { kind: "saved", fileName: file.fileName };
    },
    readFile: async () => doc.pick,
  });
  return doc;
}

const menuContext = (doc: Doc): MenuContext => ({
  graph: doc.store.view.getGraph(),
  revision: doc.store.view.getRevision(),
  selection: [],
  registry: doc.bus.registry,
});

function rowFor(surface: MenuTarget["surface"], command: string, doc: Doc): MenuItem {
  const walk = (entries: readonly MenuEntry[]): MenuItem[] =>
    entries.flatMap((entry) => (isMenuSeparator(entry) ? [] : [entry, ...walk(entry.submenu ?? [])]));
  const row = walk(menuSchemaFor(surface, doc.bus.registry).entries).find((item) => item.command === command);
  if (row === undefined) throw new Error(`no ${command} row on the ${surface} menu`);
  return row;
}

/** What the menu host does when the row is chosen: resolve on open, then execute. */
async function choose(doc: Doc, row: MenuItem, target: MenuTarget) {
  const resolved = resolveMenuInput(row, target, menuContext(doc));
  if (!resolved.ok) throw new Error(resolved.reason);
  return doc.bus.execute(
    row.command as CommandName,
    resolved.input as CommandInput<CommandName>,
    ctx,
  );
}

async function bloomFileText(): Promise<string> {
  const source = documentWith(true);
  await source.bus.execute("component.export", { componentId: "bloom" }, ctx);
  return (source.written[0] as ProjectFile).text;
}

const typesIn = (doc: Doc): string[] => Object.values(doc.store.view.getGraph().nodes).map((each) => each.type);

describe("Component ▸ Export component… on a node", () => {
  it("writes the file of the component the clicked instance runs", async () => {
    const doc = documentWith(true, graphOf([instanceNode("i1", "bloom", 1), node("plain", "test.blur")]));
    const row = rowFor("node", "component.export", doc);

    const result = await choose(doc, row, { surface: "node", nodeId: "i1" });

    expect(result.status).toBe("applied");
    expect(doc.written.map((file) => file.fileName)).toEqual(["Bloom.loom.json"]);
    const read = readComponentFile((doc.written[0] as ProjectFile).text);
    expect(read.ok && read.definitions.map((each) => `${each.componentId}@${each.version}`)).toEqual(["bloom@1"]);
  });

  it("greys out on a node that is not a component instance, saying why", () => {
    const doc = documentWith(true, graphOf([instanceNode("i1", "bloom", 1), node("plain", "test.blur")]));
    const row = rowFor("node", "component.export", doc);
    const resolved = resolveMenuInput(row, { surface: "node", nodeId: "plain" }, menuContext(doc));
    expect(resolved).toEqual({ ok: false, reason: "Only a component instance can be exported." });
  });
});

describe("Import component… on the canvas, and from the palette", () => {
  it("places the picked file's component at the point that was right-clicked", async () => {
    const doc = documentWith(false);
    doc.pick = { kind: "opened", fileName: "Bloom.loom.json", text: await bloomFileText() };
    const row = rowFor("canvas", "component.import", doc);

    const result = await choose(doc, row, { surface: "canvas", position: { x: 120, y: -40 } });

    expect(result.status, result.diagnostics.map((d) => d.message).join("; ")).toBe("applied");
    expect(doc.components.all().map((each) => each.componentId)).toEqual(["bloom"]);
    const placed = Object.values(doc.store.view.getGraph().nodes);
    expect(placed.map((each) => [each.type, each.position])).toEqual([
      [componentNodeType("bloom", 1), { x: 120, y: -40 }],
    ]);
  });

  it("is on the palette, and running it there (no input) asks for the file", async () => {
    const doc = documentWith(false);
    const resolved = resolveKeymap({ defaults: DEFAULT_BINDINGS, overrides: {} }, "mac");
    const entry = buildPaletteEntries({ bus: doc.bus, resolved }).find((each) => each.command === "component.import");
    expect(entry?.available).toBe(true);

    // The palette runs `bus.execute(command, {})` — exactly this.
    doc.pick = { kind: "opened", fileName: "Bloom.loom.json", text: await bloomFileText() };
    const result = await doc.bus.execute("component.import", {}, ctx);
    expect(result.status).toBe("applied");
    expect(typesIn(doc)).toEqual([componentNodeType("bloom", 1)]);
  });

  it("changes nothing and reports nothing when the picker is cancelled", async () => {
    const doc = documentWith(false);
    const before = doc.store.view.getRevision();
    const result = await doc.bus.execute("component.import", {}, ctx);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics).toEqual([]);
    expect(doc.store.view.getRevision()).toBe(before);
    expect(doc.components.all()).toEqual([]);
  });
});
