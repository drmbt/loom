// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { registerComponentCommands } from "@domain/components/commands.ts";
import { createComponentSystem } from "@domain/components/registry.ts";
import { graphOf, instanceNode, node } from "@domain/components/test-support.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createFileReference } from "@domain/media/file-reference.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import { DEFAULT_PROJECT_SETTINGS } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import type { RetainedFileHandle } from "@ui/files/retained-files.ts";
import { retainedFiles } from "@ui/files/retained-files.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { Inspector } from "./inspector.tsx";

/**
 * T1519b (c) — a file inside a component instance relinks from the INSTANCE, without
 * entering the component: the handle is stored under the reference's own identity, so the
 * definition is not rewritten and the document's revision does not move.
 *
 * Through the real Inspector over a real bus and the shipped node set (Movie File In is the
 * subject), with the real retained-file broker; only its storage is in memory.
 */

const storage = vi.hoisted(() => ({ handles: new Map<string, unknown>(), puts: [] as string[] }));
vi.mock("@ui/files/retained-files.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ui/files/retained-files.ts")>();
  const files = actual.createRetainedFiles({
    handlesStore: {
      get: async (id) => storage.handles.get(id) as RetainedFileHandle | undefined,
      put: async (id, handle) => {
        storage.puts.push(id);
        storage.handles.set(id, handle);
      },
    },
    createId: () => "minted-id",
    createObjectURL: () => "blob:test/relinked",
    revokeObjectURL: () => undefined,
  });
  return { ...actual, retainedFiles: () => files };
});

beforeAll(installDomStubs);
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "showOpenFilePicker");
});

const context = contextFor(alice);
const ABSENT = createFileReference("absent-id", "video", "take3.mp4");

/** Reel nests Clip, whose movie reads a file this profile has no handle for. */
const clip: GraphComponentDefinition = {
  componentId: "clip",
  version: 1,
  name: "Clip",
  graph: graphOf([node("movie", "movieFileIn", { file: ABSENT }, { label: "clip1" })]),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "movie", portId: "out" }],
  parameters: [],
};
const reel: GraphComponentDefinition = {
  componentId: "reel",
  version: 1,
  name: "Reel",
  graph: graphOf([instanceNode("take", "clip", 1)]),
  inputs: [],
  outputs: [{ externalId: "out", label: "Out", nodeId: "take", portId: "out" }],
  parameters: [],
};

describe("relink a file inside a component instance from the instance's inspector (T1519b)", () => {
  it("stores the picked file under the SAME id, and edits neither the definition nor the document", async () => {
    const store = createGraphStore({
      ids: createSequentialIdFactory("d"),
      now: () => "2026-10-04T00:00:00.000Z",
      initialGraph: graphOf([instanceNode("show" as NodeId, "reel", 1)]),
    });
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), [clip, reel]);
    const { bus } = createDomainBus({ store, registry: system.nodes });
    registerComponentCommands(bus, { components: system.components });
    const definitionBefore = system.components.get("clip", 1);
    const revisionBefore = bus.store.getRevision();

    // The lease `useFileReferences` holds on the flattened graph, which resolves the file.
    const lease = retainedFiles().acquire(ABSENT);
    await waitFor(() => expect(retainedFiles().snapshot(ABSENT).kind).toBe("missing"));

    // A File System Access host: the moved file is what the person picks.
    const picked: RetainedFileHandle = {
      name: "take3 (moved).mp4",
      getFile: async () => new File(["frames"], "take3 (moved).mp4", { type: "video/mp4" }),
      queryPermission: async () => "granted",
      requestPermission: async () => "granted",
    };
    Object.defineProperty(window, "showOpenFilePicker", { configurable: true, value: async () => [picked] });
    render(
      <Inspector
        bus={bus}
        context={context}
        nodeId={"show" as NodeId}
        settings={DEFAULT_PROJECT_SETTINGS}
        components={system.components.view()}
      />,
    );
    // Named where a person reads it: the file, the node, the component that holds it —
    // two levels down, without entering either.
    const field = screen.getByRole("group", { name: '"take3.mp4" on "clip1" in "Clip"' });

    fireEvent.click(field.querySelector("button") as HTMLButtonElement);

    // The handle went in under the reference's own id — never a newly minted one.
    await waitFor(() => expect(storage.puts).toEqual(["absent-id"]));
    await waitFor(() => expect(retainedFiles().snapshot(ABSENT).kind).toBe("ready"));
    // Nothing was authored: same definition object, same document revision.
    expect(system.components.get("clip", 1)).toBe(definitionBefore);
    expect(bus.store.getRevision()).toBe(revisionBefore);
    // And the row is gone: the file opens now.
    await waitFor(() => expect(screen.queryByRole("group", { name: '"take3.mp4" on "clip1" in "Clip"' })).toBeNull());
    lease.release();
  });
});
