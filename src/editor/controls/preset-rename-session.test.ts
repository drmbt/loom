import { describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { presetBankNode } from "@domain/presets/test-support.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { presetsNode } from "@nodes/definitions/presets.ts";
import { BEGIN_PRESET_RENAME_COMMAND, registerPresetRenameSessionCommand } from "./preset-rename-session.ts";

/**
 * VN152 — `ui.beginPresetRename` opens the name field on ONE preset button and edits nothing:
 * no revision, no undo. A preset the bank does not hold is refused by name; a dry run opens nothing.
 */
function bank() {
  const nodeId = "looks";
  const initialGraph: GraphDocument = {
    revision: 0,
    nodes: { [nodeId]: presetBankNode(nodeId, "looks", "", [{ name: "hard", values: {} }]) },
    edges: {},
    groups: {},
  };
  const graphStore = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-11-21T00:00:00.000Z", initialGraph });
  const { bus } = createDomainBus({ store: graphStore, registry: createNodeRegistry([presetsNode]).view() });
  return { bus, nodeId, store: registerPresetRenameSessionCommand(bus) };
}

describe("ui.beginPresetRename (VN152)", () => {
  it("opens the session on the named preset and writes nothing to the document", async () => {
    const { bus, nodeId, store } = bank();
    const revision = bus.store.getRevision();
    const opened = await bus.execute(BEGIN_PRESET_RENAME_COMMAND, { nodeId, name: "hard" }, contextFor(alice));
    expect(opened.status).toBe("applied");
    expect(store.get()).toEqual({ nodeId, name: "hard" });
    expect(bus.store.getRevision()).toBe(revision);
    // A stale close for another preset closes nothing; its own does.
    store.end({ nodeId, name: "soft" });
    expect(store.get()).toEqual({ nodeId, name: "hard" });
    store.end({ nodeId, name: "hard" });
    expect(store.get()).toBeNull();
  });

  it("refuses a preset the bank does not hold, and a dry run opens nothing", async () => {
    const { bus, nodeId, store } = bank();
    const refused = await bus.execute(BEGIN_PRESET_RENAME_COMMAND, { nodeId, name: "zz" }, contextFor(alice));
    expect([refused.status, refused.diagnostics[0]?.code]).toEqual(["rejected", "presetRename.unknown"]);
    const dry = await bus.execute(BEGIN_PRESET_RENAME_COMMAND, { nodeId, name: "hard" }, { ...contextFor(alice), dryRun: true });
    expect(dry.status).toBe("validated");
    expect(store.get()).toBeNull();
  });
});
