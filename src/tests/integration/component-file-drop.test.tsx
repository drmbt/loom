// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createRef } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { KeymapProvider } from "@editor/keymap/index.ts";
import { buildProjectFile } from "@domain/project/index.ts";
import { componentNodeType } from "@domain/components/index.ts";
import type { CommandStatus } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { AppRuntimeContext } from "../../app/app-context.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { GraphPane } from "../../app/graph-pane.tsx";
import type { GraphActions } from "../../app/graph-pane.tsx";

/**
 * T1395b — a `.loom.json` component file dropped on the canvas, through the real pane,
 * the real app runtime (starter set installed at boot) and the real bytes.
 *
 * What the user sees is what is asserted: which node the canvas's document gained, what
 * the catalogue holds afterwards, and — for a refused file — that nothing moved and the
 * reason reached the app's refusal path.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

type Refusal = { status: CommandStatus; diagnostics: RuntimeDiagnostic[] };

function newRuntime(): AppRuntime {
  return createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester" } });
}

async function mountCanvas(runtime: AppRuntime) {
  const refusals: Refusal[] = [];
  const view = await act(async () =>
    render(
      <AppRuntimeContext.Provider value={runtime}>
        <KeymapProvider bus={runtime.bus} invocationContext={runtime.invocation}>
          <GraphPane
            selection={[]}
            onSelectionChange={() => {}}
            onHoveredNodeChange={() => {}}
            portDrag={null}
            onPortDragChange={() => {}}
            onPatchResult={() => {}}
            onCommandRefused={(result) => refusals.push(result)}
            actionsRef={createRef<GraphActions | null>()}
          />
        </KeymapProvider>
      </AppRuntimeContext.Provider>,
    ),
  );
  const surface = view.container.querySelector('[data-keymap-context="graph"]');
  if (surface === null) throw new Error("expected the graph surface");
  return { surface, refusals };
}

/** A real OS file drag: files, and no node payload. */
function fileDrag(...files: File[]) {
  return { dropEffect: "none", effectAllowed: "all", files, types: ["Files"], getData: () => "", setData: () => {} };
}

async function drop(surface: Element, ...files: File[]): Promise<boolean> {
  let notPrevented = true;
  await act(async () => {
    notPrevented = fireEvent.drop(surface, { dataTransfer: fileDrag(...files), clientX: 40, clientY: 30 });
    // The file is read and the command awaited off the event; let both settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return notPrevented;
}

const nodesOf = (runtime: AppRuntime) => Object.values(runtime.bus.store.getGraph().nodes);
const catalogue = (runtime: AppRuntime) =>
  runtime.components.all().map((each) => `${each.componentId}@${each.version}:${each.name}`);

describe("dropping a component file on the canvas (T1395b)", () => {
  it("the SHIPPED Bloom file is the starter this document already has: reused, one instance placed", async () => {
    const runtime = newRuntime();
    const before = catalogue(runtime);
    expect(before).toContain("bloom@1:Bloom");
    const { surface, refusals } = await mountCanvas(runtime);

    const bytes = readFileSync(join(process.cwd(), "examples/components/Bloom.loom.json"), "utf8");
    const prevented = !(await drop(surface, new File([bytes], "Bloom.loom.json")));

    expect(prevented).toBe(true);
    expect(refusals).toEqual([]);
    expect(nodesOf(runtime).map((node) => node.type)).toEqual([componentNodeType("bloom", 1)]);
    const position = nodesOf(runtime)[0]?.position;
    expect(Number.isFinite(position?.x) && Number.isFinite(position?.y)).toBe(true);
    // Same id, version and content: no bloom-2, nothing new in the library.
    expect(catalogue(runtime)).toEqual(before);
  });

  it("an EXPORTED, edited Bloom arrives beside the starter as bloom-2 — the export writes through writeTextFile", async () => {
    // Document A edits its Bloom and exports it through the app's real writer (the picker
    // path of `writeTextFile`), which is what the library row's `export` runs.
    const source = newRuntime();
    const starter = source.components.get("bloom", 1);
    if (starter === undefined) throw new Error("expected the starter bloom");
    const [firstId, first] = Object.entries(starter.graph.nodes)[0] ?? [];
    if (firstId === undefined || first === undefined) throw new Error("expected bloom internals");
    source.components.register({
      ...starter,
      graph: { ...starter.graph, nodes: { ...starter.graph.nodes, [firstId]: { ...first, label: "edited" } } },
    });
    let written = "";
    const globals = globalThis as { showSaveFilePicker?: unknown };
    globals.showSaveFilePicker = async () => ({
      name: "Bloom.loom.json",
      createWritable: async () => ({
        write: async (data: string) => {
          written = data;
        },
        close: async () => {},
        abort: async () => {},
      }),
    });
    try {
      const exported = await source.bus.execute("component.export", { componentId: "bloom" }, source.invocation);
      expect(exported.output).toMatchObject({ saved: true, fileName: "Bloom.loom.json" });
    } finally {
      delete globals.showSaveFilePicker;
    }
    expect(written).not.toBe("");

    // Document B still has the shipped Bloom.
    const target = newRuntime();
    const { surface, refusals } = await mountCanvas(target);
    await drop(surface, new File([written], "Bloom.loom.json"));

    expect(refusals).toEqual([]);
    expect(nodesOf(target).map((node) => node.type)).toEqual([componentNodeType("bloom-2", 1)]);
    expect(target.components.get("bloom-2", 1)?.name).toBe("Bloom-2");
    expect(target.components.get("bloom-2", 1)?.graph.nodes[firstId]?.label).toBe("edited");
    // B's own Bloom is exactly the shipped one still.
    expect(target.components.get("bloom", 1)?.graph.nodes[firstId]?.label).toBe(first.label);
  });

  it("refuses a whole PROJECT file by name and leaves the document alone", async () => {
    // What File → Save writes: the document plus the whole catalogue.
    const saved = newRuntime();
    const projectText = buildProjectFile({
      document: saved.projectDocument(),
      components: saved.components.all(),
    }).text;

    const runtime = newRuntime();
    const graphBefore = runtime.bus.store.getGraph();
    const catalogueBefore = catalogue(runtime);
    const { surface, refusals } = await mountCanvas(runtime);
    await drop(surface, new File([projectText], "My Show.loom.json"));

    expect(runtime.bus.store.getGraph()).toBe(graphBefore);
    expect(catalogue(runtime)).toEqual(catalogueBefore);
    expect(refusals.flatMap((each) => each.diagnostics.map((d) => d.code))).toEqual(["component.import.notAComponent"]);
    expect(refusals[0]?.diagnostics[0]?.message).toContain('"My Show.loom.json" is a whole project');
  });

  it("refuses a malformed file and a file that is not JSON at all, and keeps the tab on the project", async () => {
    const runtime = newRuntime();
    const graphBefore = runtime.bus.store.getGraph();
    const { surface, refusals } = await mountCanvas(runtime);

    const prevented = !(await drop(
      surface,
      new File(['{"componentLibrary": '], "broken.loom.json"),
      new File(["\u0089PNG"], "picture.png"),
    ));

    // The browser's default for a dropped file is to navigate to it — which closes the project.
    expect(prevented).toBe(true);
    expect(runtime.bus.store.getGraph()).toBe(graphBefore);
    expect(refusals.flatMap((each) => each.diagnostics.map((d) => d.code))).toEqual([
      "component.import.malformed",
      "component.import.notAComponent",
    ]);
  });
});
