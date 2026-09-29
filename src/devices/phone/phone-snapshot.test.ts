import { describe, expect, it } from "vitest";
import type { LoomBus } from "../../domain/commands/bus.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { contextFor, alice } from "../../domain/commands/test-support.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { GraphPatchOperation } from "../../domain/types/patch.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { buildPhoneSnapshot, vetPhoneSet } from "./phone-snapshot.ts";
import type { PhoneSet } from "./phone-protocol.ts";

/**
 * T1396b — WHAT A PHONE SEES, AND WHAT IT MAY WRITE, decided from the document alone.
 *
 * The documents are built through the real bus and the real registry, so every node
 * carries the defaults `addNode` gives it — the vet sees what the product sees. What
 * matters to a phone user: only a Panel with Phone on is visible; its widgets appear under
 * the names the controls pane shows; nothing the phone sends reaches the document unless
 * it names a widget on a CURRENTLY published Panel with a key that widget lets a phone
 * write, in range.
 */

async function documentWith(operations: GraphPatchOperation[]): Promise<{ bus: LoomBus; ids: Record<string, string> }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("p"), now: () => "2026-09-29T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const result = await bus.execute(
    "graph.applyPatch",
    { baseRevision: bus.store.getRevision(), label: "setup", operations },
    contextFor(alice),
  );
  expect(result.output.status).toBe("applied");
  return { bus, ids: result.output.createdIds as Record<string, string> };
}

const add = (ref: string, type: string, label: string, parameters: Record<string, unknown> = {}): GraphPatchOperation =>
  ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;

/** A published Panel naming four widgets, a second Panel NOT published, and an unlisted slider. */
const STAGE: GraphPatchOperation[] = [
  add("fader", "slider", "fader1", { channel: "heat", caption: "Heat", value: 0.25, min: 0, max: 2, step: 0.25 }),
  add("strobe", "toggle", "toggle1", { channel: "strobe" }),
  add("cut", "button", "button1", { channel: "cut", presses: 4 }),
  add("pad", "xyPad", "pad1", { channel: "aim", min: -1, max: 1, x: 0, y: 0.5 }),
  add("hidden", "slider", "secret1", { channel: "secret" }),
  add("stage", "panel", "panel1", { title: "Furnace", remote: true, layout: "# Melt\n> hands off\nfader1 toggle1 ghost\nbutton1, pad1\nnobody" }),
  add("desk", "panel", "panel2", { title: "Desk only", layout: "secret1" }),
];

const set = (handle: string, values: Record<string, number | boolean>, phase: PhoneSet["phase"] = "commit"): PhoneSet => ({
  handle,
  values,
  phase,
});

describe("T1396b — the snapshot a phone sees", () => {
  it("carries only Panels with Phone on, their rows, and the widgets the pane would show", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const snapshot = buildPhoneSnapshot(bus.store.getGraph(), 7);
    expect(snapshot).toEqual({
      seq: 7,
      panels: [
        {
          title: "Furnace",
          rows: [
            { kind: "heading", text: "Melt" },
            { kind: "text", text: "hands off" },
            {
              kind: "widgets",
              widgets: [
                { kind: "slider", handle: ids["$fader"], caption: "Heat", value: 0.25, min: 0, max: 2, step: 0.25 },
                // No caption: the channel name, exactly as the pane captions it.
                { kind: "toggle", handle: ids["$strobe"], caption: "strobe", on: false },
              ],
            },
            {
              kind: "widgets",
              widgets: [
                { kind: "button", handle: ids["$cut"], caption: "cut", held: false },
                { kind: "xyPad", handle: ids["$pad"], caption: "aim", x: 0, y: 0.5, min: -1, max: 1 },
              ],
            },
            // `nobody` names no widget: the row is dropped rather than drawn empty.
          ],
        },
      ],
    });
    // The unpublished Panel's widget appears nowhere in what leaves the page.
    expect(JSON.stringify(snapshot)).not.toContain(ids["$hidden"]!);
  });

  it("leaves out a widget the document drives, and a Panel whose switch is driven", async () => {
    const driven = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.5" } } };
    const { bus, ids } = await documentWith([
      add("fader", "slider", "fader1", { max: driven }),
      add("free", "slider", "fader2"),
      add("stage", "panel", "panel1", { remote: true, layout: "fader1 fader2" }),
      add("other", "panel", "panel2", { remote: driven, layout: "fader2" }),
    ]);
    const snapshot = buildPhoneSnapshot(bus.store.getGraph(), 1);
    expect(snapshot.panels).toHaveLength(1);
    const row = snapshot.panels[0]!.rows[0]!;
    expect(row.kind === "widgets" ? row.widgets.map((widget) => widget.handle) : []).toEqual([ids["$free"]]);
  });
});

describe("T1396b — the vet: a phone writes a published widget's own keys, in range, or nothing", () => {
  it("clamps a slider to its range and snaps it to its step", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const graph = bus.store.getGraph();
    const fader = ids["$fader"]!;
    expect(vetPhoneSet(graph, set(fader, { value: 0.9 }))).toMatchObject({ ok: true, entries: { value: 1 } });
    expect(vetPhoneSet(graph, set(fader, { value: 0.6 }))).toMatchObject({ ok: true, entries: { value: 0.5 } });
    expect(vetPhoneSet(graph, set(fader, { value: 9 }))).toMatchObject({ ok: true, entries: { value: 2 } });
    expect(vetPhoneSet(graph, set(fader, { value: -3 }))).toMatchObject({ ok: true, entries: { value: 0 } });
    expect(vetPhoneSet(graph, set(ids["$pad"]!, { x: 5, y: -5 }))).toMatchObject({ ok: true, entries: { x: 1, y: -1 } });
  });

  it("counts a button press on the false→true edge only, and writes both keys every time", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const cut = ids["$cut"]!;
    expect(vetPhoneSet(bus.store.getGraph(), set(cut, { held: true }, "live"))).toMatchObject({ ok: true, entries: { held: true, presses: 5 } });
    expect(vetPhoneSet(bus.store.getGraph(), set(cut, { held: false }))).toMatchObject({ ok: true, entries: { held: false, presses: 4 } });
    // Already held (by the desk, or a repeated message): not a second press.
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: cut as never, parameters: { held: true } }] },
      contextFor(alice),
    );
    expect(vetPhoneSet(bus.store.getGraph(), set(cut, { held: true }, "live"))).toMatchObject({ ok: true, entries: { held: true, presses: 4 } });
  });

  it("refuses every write that is not a published widget's own key and value", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const graph: GraphDocument = bus.store.getGraph();
    const refused = (write: PhoneSet): string => {
      const vet = vetPhoneSet(graph, write);
      expect(vet.ok).toBe(false);
      return vet.ok ? "" : vet.reason;
    };
    const unpublished = "A phone tried to move a control that is not published to the phone door.";
    // A handle that names nothing, a node that is no widget, a widget on no remote Panel.
    expect(refused(set("node-does-not-exist", { value: 1 }))).toBe(unpublished);
    expect(refused(set(ids["$stage"]!, { remote: false }))).toBe(unpublished);
    expect(refused(set(ids["$hidden"]!, { value: 1 }))).toBe(unpublished);
    // Keys the widget does not let a phone write — including one it HAS (a slider's max).
    expect(refused(set(ids["$fader"]!, { max: 100 }))).toMatch(/does not let a phone write/);
    expect(refused(set(ids["$cut"]!, { presses: 99 }))).toMatch(/does not let a phone write/);
    expect(refused(set(ids["$fader"]!, {}))).toMatch(/carried no values/);
    // Wrong value types, and numbers that are not finite.
    expect(refused(set(ids["$fader"]!, { value: true }))).toMatch(/not a finite number/);
    expect(refused(set(ids["$fader"]!, { value: Number.NaN }))).toMatch(/not a finite number/);
    expect(refused(set(ids["$pad"]!, { x: Number.POSITIVE_INFINITY }))).toMatch(/not a finite number/);
    expect(refused(set(ids["$strobe"]!, { on: 1 }))).toMatch(/not true or false/);
    expect(refused(set(ids["$cut"]!, { held: 0 }))).toMatch(/not true or false/);
    expect(refused({ handle: ids["$fader"]!, values: { value: 1 }, phase: "later" as never })).toMatch(/no gesture phase/);
  });

  it("refuses a driven widget on a published Panel, by name", async () => {
    const driven = { mode: "expression", bindings: { expression: { kind: "expression", source: "0.5" } } };
    const { bus, ids } = await documentWith([
      add("fader", "slider", "fader1", { caption: "Heat", value: driven }),
      add("stage", "panel", "panel1", { remote: true, layout: "fader1" }),
    ]);
    const vet = vetPhoneSet(bus.store.getGraph(), set(ids["$fader"]!, { value: 0.5 }));
    expect(vet).toEqual({ ok: false, reason: "“Heat” is driven by the document, so a phone cannot move it." });
  });

  it("stops accepting a Panel's widgets the moment its Phone switch goes off", async () => {
    const { bus, ids } = await documentWith(STAGE);
    const fader = ids["$fader"]!;
    expect(vetPhoneSet(bus.store.getGraph(), set(fader, { value: 1 })).ok).toBe(true);
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [{ op: "setParameters", nodeId: ids["$stage"] as never, parameters: { remote: false } }],
      },
      contextFor(alice),
    );
    expect(vetPhoneSet(bus.store.getGraph(), set(fader, { value: 1 }))).toEqual({
      ok: false,
      reason: "A phone tried to move a control that is not published to the phone door.",
    });
    expect(buildPhoneSnapshot(bus.store.getGraph(), 2).panels).toEqual([]);
  });
});

/**
 * T1512b — a Panel that follows its WIRING publishes its widgets in wiring order, and moves
 * when the order does: the phone reads the same `panelLayout` the desk draws from.
 */
describe("T1512b — the phone follows a Panel's wiring order", () => {
  const wire = (from: string, to: string): GraphPatchOperation =>
    ({ op: "connect", source: { nodeId: `$${from}`, portId: "out" }, target: { nodeId: `$${to}`, portId: "controls" } }) as GraphPatchOperation;
  const handles = (bus: LoomBus): string[] =>
    buildPhoneSnapshot(bus.store.getGraph(), 1).panels.flatMap((panel) =>
      panel.rows.flatMap((row) => (row.kind === "widgets" ? row.widgets.map((widget) => widget.handle) : [])),
    );

  it("publishes wired widgets in edge order, and a reorder reorders the phone", async () => {
    const { bus, ids } = await documentWith([
      add("fader", "slider", "fader1"),
      add("strobe", "toggle", "toggle1"),
      add("stage", "panel", "panel1", { title: "Wired", remote: true }),
      wire("strobe", "stage"),
      wire("fader", "stage"),
    ]);
    expect(handles(bus)).toEqual([ids["$strobe"], ids["$fader"]]);
    // A wired widget is published, so the vet lets the phone move it.
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$fader"]!, { value: 0.5 })).ok).toBe(true);

    const edges = Object.values(bus.store.getGraph().edges).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    await bus.execute(
      "graph.applyPatch",
      {
        baseRevision: bus.store.getRevision(),
        operations: [{ op: "reorderEdges", nodeId: ids["$stage"] as never, portId: "controls", edgeIds: [edges[1]!.id, edges[0]!.id] }],
      },
      contextFor(alice),
    );
    expect(handles(bus)).toEqual([ids["$fader"], ids["$strobe"]]);

    // Unwired, it is gone from the phone and the vet refuses it.
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "disconnect", edgeIds: [edges[1]!.id] }] },
      contextFor(alice),
    );
    expect(handles(bus)).toEqual([ids["$strobe"]]);
    expect(vetPhoneSet(bus.store.getGraph(), set(ids["$fader"]!, { value: 0.5 })).ok).toBe(false);
  });
});
