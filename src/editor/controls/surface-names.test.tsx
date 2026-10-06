// @vitest-environment jsdom
import { useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { serializeCueList, serializePresetBank } from "@domain/presets/index.ts";
import { parsePanelBoard, serializePanelBoard, type StoredBoardItem } from "@nodes/definitions/controls.ts";
import { createAppRuntime, type AppRuntime } from "../../app/app-runtime.ts";
import { ControlsPane } from "./controls-pane.tsx";

/**
 * A BANK, A LAYER, A CUE LIST AND A PANEL ARE CAPTIONED BY THEIR ROLE (T1593b, ruled
 * 2026-10-05).
 *
 * A node's name is `kind_role`: `presets_looks`, `layer_fx`, `cuelist_set`, `panel_desk`.
 * On the canvas the kind is the point. On a performance surface it is the same fact twice,
 * because the board already draws a bank as a strip of presets and a layer as a switch,
 * and every character there is read from across a room. So the surface shows `looks`,
 * `fx`, `set`, `desk`.
 *
 * Every assertion is on the TEXT a performer reads (or a screen reader speaks), on the
 * real Controls pane over the real runtime. And on the other half of the rule: the caption
 * is only a caption. The board still stores its members under the FULL name, and a press
 * still reaches the node.
 */
beforeAll(installDomStubs);
afterEach(cleanup);

const settle = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
const connect = (from: string, to: string, port: string): GraphPatchOperation =>
  ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: `$${to}`, portId: port } }) as GraphPatchOperation;

interface Names {
  readonly bank: string;
  readonly layer: string;
  readonly cues: string;
  readonly panel: string;
}

const CONFORMING: Names = { bank: "presets_looks", layer: "layer_fx", cues: "cuelist_set", panel: "panel_desk" };

/** One Panel with a bank, a layer over a solid into a Window Out, and a cue list, under the given names. */
async function desk(names: Names, panelTitle = ""): Promise<{ runtime: AppRuntime; ids: Record<string, NodeId> }> {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "tester", label: "Tester" } });
  const bank = serializePresetBank({ version: 1, presets: [{ name: "soft", values: { blur1: { size: 4 } } }] });
  const cues = serializeCueList({ version: 1, cues: [{ name: "1", bank: names.bank, preset: "soft" }] });
  const board: StoredBoardItem[] = [
    { member: names.bank, rect: { x: 0, y: 0, w: 4, h: 1 } },
    { member: names.layer, rect: { x: 4, y: 0, w: 4, h: 2 } },
    { member: names.cues, rect: { x: 0, y: 2, w: 4, h: 3 } },
  ];
  const result = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "setup",
      operations: [
        add("blur", "blur", "blur1", { size: 9 }),
        add("bank", "presets", names.bank, { targets: "blur1", presets: bank }),
        add("street", "solid", "solid_street"),
        add("layer", "layer", names.layer),
        add("main", "window", "window_main"),
        connect("street", "layer", "below"),
        connect("layer", "main", "input"),
        add("cues", "cueList", names.cues, { cues }),
        add("panel", "panel", names.panel, { title: panelTitle, board: serializePanelBoard({ columns: 8, items: board }) }),
      ],
    },
    runtime.invocation,
  );
  expect(result.output.status, JSON.stringify(result.output.diagnostics)).toBe("applied");
  return { runtime, ids: result.output.createdIds as Record<string, NodeId> };
}

function Pane({ runtime }: { runtime: AppRuntime }) {
  const graph = useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
  return <ControlsPane graph={graph} registry={runtime.registry} bus={runtime.bus} invocation={runtime.invocation} />;
}

const item = (name: string) => document.querySelector(`[data-controls-pane] [data-board-item="member:${name}"]`) as HTMLElement;

describe("a Panel board captions a bank, a layer and a cue list by the role of their name", () => {
  it("shows `fx` on the layer's switch, not `layer_fx`", async () => {
    const { runtime } = await desk(CONFORMING);
    render(<Pane runtime={runtime} />);

    const toggle = within(item("layer_fx")).getByRole("switch");
    expect(toggle.getAttribute("aria-label") ?? toggle.textContent).toMatch(/^fx/);
    expect(item("layer_fx").textContent).toContain("fx");
    expect(item("layer_fx").textContent).not.toContain("layer_fx");
  });

  it("names the bank's strip and the cue list by their roles to a screen reader", async () => {
    const { runtime } = await desk(CONFORMING);
    render(<Pane runtime={runtime} />);

    expect(within(item("presets_looks")).getByRole("group").getAttribute("aria-label")).toBe("Presets of looks");
    expect(within(item("cuelist_set")).getByRole("group", { name: "Cues of set" })).toBeDefined();
  });

  it("titles an untitled Panel by the role of its name", async () => {
    const { runtime } = await desk(CONFORMING);
    render(<Pane runtime={runtime} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("desk");
  });

  it("still shows a Panel's own Title when it has one", async () => {
    const { runtime } = await desk(CONFORMING, "Front of house");
    render(<Pane runtime={runtime} />);
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("Front of house");
  });

  /*
   * The caption is not the address. The board item is still keyed by the node's whole
   * name, the stored board still names it whole, and the press reaches the node: a caption
   * that leaked into the membership would silently drop the item from the board.
   */
  it("keeps the whole name as the member's identity, and a press still reaches the node", async () => {
    const { runtime, ids } = await desk(CONFORMING);
    render(<Pane runtime={runtime} />);

    const stored = parsePanelBoard(runtime.bus.store.getGraph().nodes[ids["$panel"]!]!.parameters["board"]);
    expect(stored.items.map((each) => ("member" in each ? each.member : null))).toEqual(["presets_looks", "layer_fx", "cuelist_set"]);

    await act(async () => {
      fireEvent.click(within(item("presets_looks")).getByRole("button", { name: "soft" }));
      await settle();
    });
    expect(runtime.bus.store.getGraph().nodes[ids["$blur"]!]!.parameters["size"]).toBe(4);
  });
});

describe("a name the rule did not make is shown as it is", () => {
  it("shows a name without its kind whole: every document saved before the rule", async () => {
    const { runtime } = await desk({ bank: "looks", layer: "fx", cues: "set", panel: "desk" });
    render(<Pane runtime={runtime} />);

    expect(item("fx").textContent).toContain("fx");
    expect(within(item("looks")).getByRole("group").getAttribute("aria-label")).toBe("Presets of looks");
    expect(within(item("set")).getByRole("group", { name: "Cues of set" })).toBeDefined();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("desk");
  });

  it("shows an auto-name whole: `layer1` has no role to show instead", async () => {
    const { runtime } = await desk({ bank: "presets1", layer: "layer1", cues: "cuelist1", panel: "panel1" });
    render(<Pane runtime={runtime} />);

    expect(item("layer1").textContent).toContain("layer1");
    expect(within(item("presets1")).getByRole("group").getAttribute("aria-label")).toBe("Presets of presets1");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("panel1");
  });

  it("does not cut a name that only begins with the letters of its kind", async () => {
    const { runtime } = await desk({ bank: "presetsA", layer: "layers_main", cues: "cuelistB", panel: "panels" });
    render(<Pane runtime={runtime} />);

    expect(item("layers_main").textContent).toContain("layers_main");
    expect(within(item("presetsA")).getByRole("group").getAttribute("aria-label")).toBe("Presets of presetsA");
  });
});

describe("the Layers list calls a layer by its role too", () => {
  it("shows `fx` on the row, and selecting it still selects the node", async () => {
    const { runtime, ids } = await desk(CONFORMING);
    render(<Pane runtime={runtime} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Layers" }));
      await settle();
    });

    const row = document.querySelector(`[data-layer-row="${ids["$layer"]!}"]`) as HTMLElement;
    expect(within(row).getByRole("button", { name: "fx" }).getAttribute("title")).toBe("Select fx");
    expect(row.textContent).not.toContain("layer_fx");
  });
});
