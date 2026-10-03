// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildComponentFile } from "@domain/components/component-file.ts";
import { graphOf, node } from "@domain/components/test-support.ts";
import { createFileReference } from "@domain/media/file-reference.ts";
import { loadProject } from "@domain/project/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import { createAppRuntime, createRuntimeCatalogue, type AppRuntime } from "./app-runtime.ts";
import { useArrivingFiles, type ArrivingFilesOptions } from "./use-arriving-files.ts";

/**
 * T1519b — a file that arrives and does not open in this browser is said at that moment,
 * naming the component, the node and the file (owner ruling 2026-10-04).
 *
 * Every arrival goes through the real door: `component.import` on the runtime's bus, the
 * real load path for an open (`loadProject` → `createAppRuntime`, what `adoptDocument`
 * does), and `graph.copySelection` / `graph.paste` across two runtimes. What is read
 * back is the notice the strip shows. The one thing faked is this browser's storage: which
 * handle ids it holds, and which object URLs still open.
 */

const LINKED = createFileReference("linked-id", "video", "here.mp4");
const ABSENT = createFileReference("absent-id", "video", "take3.mp4");
/** What the picker wrote before retained references, in a file exported before `9999ae85`. */
const STALE_BLOB = "blob:http://localhost:5173/3f2a9c1e#old take.mp4";

/** This profile holds `linked-id` and nothing else; no object URL from another session opens. */
const browser: ArrivingFilesOptions = {
  hasHandle: async (id) => id === "linked-id",
  objectUrlOpens: async () => false,
};

function clipReading(file: string, componentId = "clip", name = "Clip"): GraphComponentDefinition {
  return {
    componentId,
    version: 1,
    name,
    graph: graphOf([node("movie", "movieFileIn", { file }, { label: "clip1" })]),
    inputs: [],
    outputs: [{ externalId: "out", label: "Out", nodeId: "movie", portId: "out" }],
    parameters: [],
  };
}

function componentFileText(definition: GraphComponentDefinition): string {
  return buildComponentFile({ root: definition, definitions: [definition], settings: createAppRuntime({ identityStorage: null }).settings }).text;
}

const runtimes: AppRuntime[] = [];
function runtimeOf(options: Parameters<typeof createAppRuntime>[0] = {}): AppRuntime {
  const runtime = createAppRuntime({ identityStorage: null, ...options });
  runtimes.push(runtime);
  return runtime;
}

afterEach(() => {
  cleanup();
  for (const runtime of runtimes.splice(0)) runtime.dispose();
});

const NOT_LINKED = "is not linked in this browser — select the node, or its component instance, and choose relink in the Inspector";

describe("a retained file that arrives without its handle warns, naming component, node and file (T1519b)", () => {
  it("IMPORT: a component file whose movie has no handle here", async () => {
    const runtime = runtimeOf();
    const view = renderHook(() => useArrivingFiles(runtime, browser));
    expect(view.result.current).toBeNull();

    // The legitimate case first: a reference this profile CAN open arrives and says nothing.
    const linked = await runtime.bus.execute("component.import", { text: componentFileText(clipReading(LINKED, "here", "Here")) }, runtime.invocation);
    expect(linked.status).toBe("applied");

    const imported = await runtime.bus.execute("component.import", { text: componentFileText(clipReading(ABSENT)) }, runtime.invocation);
    expect(imported.status).toBe("applied");
    await waitFor(() => expect(view.result.current).not.toBeNull());
    expect(view.result.current?.tone).toBe("warn");
    expect(view.result.current?.message).toBe("A file this document reads cannot be opened in this browser.");
    // Named once, the linked "here.mp4" not at all.
    expect(view.result.current?.detail).toBe(`"take3.mp4" on "clip1" in component "Clip" ${NOT_LINKED}.`);

    // Dismissed, and the same file arriving again (a second import reuses the component,
    // a second instance) is not news: it was said once for this document.
    act(() => view.result.current?.actions?.[0]?.onSelect());
    expect(view.result.current).toBeNull();
    const again = await runtime.bus.execute("component.import", { text: componentFileText(clipReading(ABSENT)) }, runtime.invocation);
    expect(again.status).toBe("applied");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(view.result.current).toBeNull();
  });

  it("IMPORT (d): a blob: URL in a component file written before export refused them", async () => {
    const runtime = runtimeOf();
    const view = renderHook(() => useArrivingFiles(runtime, browser));
    const imported = await runtime.bus.execute("component.import", { text: componentFileText(clipReading(STALE_BLOB)) }, runtime.invocation);
    expect(imported.status).toBe("applied");
    await waitFor(() => expect(view.result.current).not.toBeNull());
    expect(view.result.current?.detail).toBe(
      '"old take.mp4" on "clip1" in component "Clip" was picked for a browser session that has ended — choose the file again.',
    );
  });

  it("OPEN: a project whose graph and component library hold references with no handle here", async () => {
    // The project a component file opens as: its library carries Clip, its graph instances it.
    // Beside it, a root movie node reading a file this profile DOES hold.
    const text = componentFileText(clipReading(ABSENT));
    const loaded = loadProject(text, { nodes: createRuntimeCatalogue().registry });
    if (!loaded.ok) throw new Error(loaded.reason);
    const graph = {
      ...loaded.document.graph,
      nodes: { ...loaded.document.graph.nodes, own: node("own", "movieFileIn", { file: LINKED }, { label: "own1", position: { x: 0, y: 300 } }) },
    };
    const runtime = runtimeOf({ document: { ...loaded.document, graph }, components: loaded.components });

    const view = renderHook(() => useArrivingFiles(runtime, browser));
    await waitFor(() => expect(view.result.current).not.toBeNull());
    expect(view.result.current?.detail).toBe(`"take3.mp4" on "clip1" in component "Clip" ${NOT_LINKED}.`);
  });

  it("PASTE: an instance copied in another document carries its component, and the missing file is named", async () => {
    // One clipboard both documents share, text-only like a browser without ClipboardItem.
    let held = "";
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { held = text; }, readText: async () => held },
    });
    try {
      const source = runtimeOf({ components: [clipReading(ABSENT)] });
      const placed = await source.bus.execute("component.instantiate", { componentId: "clip", version: 1, mode: "linked" }, source.invocation);
      expect(placed.status).toBe("applied");
      const copied = await source.bus.execute("graph.copySelection", { nodeIds: [...placed.output.nodeIds] }, source.invocation);
      expect(copied.status).toBe("applied");
      await waitFor(() => expect(held).not.toBe(""));

      const target = runtimeOf();
      const view = renderHook(() => useArrivingFiles(target, browser));
      expect(target.components.has("clip")).toBe(false);
      const pasted = await target.bus.execute("graph.paste", {}, target.invocation);
      expect(pasted.status).toBe("applied");
      expect(target.components.has("clip")).toBe(true);
      await waitFor(() => expect(view.result.current).not.toBeNull());
      expect(view.result.current?.detail).toBe(`"take3.mp4" on "clip1" in component "Clip" ${NOT_LINKED}.`);
    } finally {
      Reflect.deleteProperty(navigator, "clipboard");
    }
  });
});
