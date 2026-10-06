// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { NodeId } from "@domain/types/ids.ts";
import type { CommandName } from "@domain/types/commands.ts";
import { inSessionKind, type LoomBus } from "@domain/commands/bus.ts";
import type { ComponentSession } from "@domain/components/session.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T1195 — WHAT ELSE ISN'T SUBGRAPH-AWARE?
 *
 * Owner, after four separate component-boundary defects in one day: *"Shift+F doesn't
 * even work in a subgraph. It doesn't do anything for me — definitely doesn't bring it
 * into the center, while it works perfectly outside. I feel like our UI still has a whole
 * lot of problems actually distinguishing subgraph from not subgraph. Maybe a bunch of
 * our plumbing is not aware of this."*
 *
 * ## The shape, and why the gate is derived rather than a list
 *
 * §B177, §T903, §T969 and §B188 are seven instances of one thing: A SURFACE KEYED ON
 * NODES DOES NOT SEE THROUGH THE INSTANCE BOUNDARY. This file gates the half of that
 * shape that belongs to the COMMAND BUS, and the mechanism has a name:
 *
 *   Inside a component the canvas edits through a SESSION bus (`openComponentSession`
 *   mints a real second `LoomBus`), while every DOOR — the keymap, the palette, the
 *   menubar — keeps dispatching on the ROOT bus. A view-state surface that fills its
 *   holder on the pane's own bus therefore VACATES the root holder on the way down, and
 *   the command answers "no canvas is mounted" while the canvas is right there.
 *
 * T969(b) fixed exactly two commands this way and wrote the rule down in three docblocks.
 * Two more shipped broken anyway — the owner's `Shift+F` and, found by this gate rather
 * than reported, `tab`. So the gate is not a list of commands: it is `bus.listCommands()`
 * — the bus's own registry — asked the same question at both depths. **A new pane-scoped
 * surface registered on one bus fails HERE, on the day it lands, without its author ever
 * having heard of this file.**
 *
 * §V453's shape, and the reason for it: an enumerated list goes stale at the next
 * surface; a derived one fails the moment somebody adds one.
 *
 * ## What this gate can and cannot see, stated rather than implied
 *
 * It sees HOLDERS — a surface whose command refuses when nobody is holding it. It is
 * blind to STORES (`ui.toggleEdgeFlow`, `ui.toggleTimingOverlay`,
 * `ui.toggleReferenceLines`, `preview.setView`): those are per-bus too, so inside a
 * component the root command writes one store while the canvas reads another, and the
 * command still reports `applied`. Measured rather than assumed: after one dive,
 * `ui.toggleEdgeFlow` on the root bus flipped the ROOT store to `true` while the canvas
 * was subscribed to the session bus's own. That family is FILED rather than fixed here —
 * it is a question about which bus OWNS view state, not a missing registration, and
 * answering it by dual-registration would split the state instead of the handler.
 *
 * It is also blind to a command that reads `context.graph` — the ROOT document — while
 * the canvas shows a component's internals. That was T969(b)'s FIRST mechanism, and
 * `ui.beginRename` still has it: measured, `rename.unknownNode` for an interior node id.
 * Both are §T1195's report to the owner.
 */

/*
 * §T1696b: the session the app itself opens on a dive, captured where the editing hook opens
 * it. Its bus is the EDIT bus, which is what a key, the palette and a menu row dispatch on
 * since that row; before it they dispatched on the project's and this gate asked there.
 */
const sessions: ComponentSession[] = [];
vi.mock("@domain/components/session.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("@domain/components/session.ts")>();
  return {
    ...original,
    openComponentSession: (options: Parameters<typeof original.openComponentSession>[0]) => {
      const session = original.openComponentSession(options);
      sessions.push(session);
      return session;
    },
  };
});

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(() => {
  cleanup();
  sessions.length = 0;
});

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester" },
  });
}

/**
 * The whole app, mounted around one instance of the `bloom` starter component.
 *
 * A real instance and a real `<App>` rather than a `GraphPane` in isolation, because the
 * defect is entirely about WHICH BUS the app hands each surface — a pane mounted by a
 * test gets one bus for both roles and is green by construction. `bloom` because it is a
 * shipped starter component with more than one interior node, so "framed the interior"
 * and "framed the instance" cannot both be one.
 */
async function appAroundAnInstance() {
  const runtime = newRuntime();
  const placed = await runtime.bus.execute(
    "component.instantiate",
    { componentId: "bloom", position: { x: 0, y: 0 } },
    runtime.invocation,
  );
  expect(placed.output.ok, placed.diagnostics.map((d) => d.message).join("; ")).toBe(true);
  const instance = placed.output.nodeId as NodeId;
  await act(async () => {
    render(
      <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(NO_WEBGPU)} />,
    );
  });
  const internals = Object.keys(runtime.components.get("bloom" as never, 1)?.graph.nodes ?? {}).sort();
  expect(internals.length).toBeGreaterThan(1);
  return { runtime, instance, internals };
}

describe("T1195 — the reported bug: framing inside a component", () => {
  /**
   * The literal defect, through the real stack and on the bus a keystroke lands on.
   *
   * MEASURED BEFORE THE FIX: `applied {framed: 1}` at the root, then `rejected
   * view.noCanvas` after one `graph.diveIn` — the same two readings T969(b) recorded for
   * `graph.selectAll`, and §V123's silence is what kept them apart.
   *
   * The assertion is on HOW MANY nodes were framed, not just on `applied`: a version that
   * framed the parent's one instance node would be equally green against a status check
   * and equally useless to the person looking at the canvas. `framed` counts what
   * `flow.getNodes()` actually held, which is §V123's rule and the reason a wrong-pane
   * fit could report success at all.
   */
  it("Shift+F frames the component's OWN nodes once the canvas is inside one", async () => {
    const { runtime, instance, internals } = await appAroundAnInstance();

    // At the root the canvas holds exactly the one instance node.
    const atRoot = await act(async () => runtime.bus.execute("view.frameAll", {}, runtime.invocation));
    expect(atRoot.status, atRoot.diagnostics.map((d) => d.code).join(",")).toBe("applied");
    expect(atRoot.output.framed).toBe(1);

    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: instance }, runtime.invocation);
    });

    // Inside: `runtime.bus` is still the ROOT bus — the one `KeymapProvider` dispatches
    // on — and it must now reach the canvas showing bloom's internals.
    const inside = await act(async () => runtime.bus.execute("view.frameAll", {}, runtime.invocation));
    expect(inside.status, inside.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; ")).toBe(
      "applied",
    );
    expect(inside.output.framed).toBe(internals.length);
  });

  /**
   * `f` (frame selected) and `H` (home) ride the same holder, so they broke together and
   * would be fixed together by accident. Asserted separately because "the holder is
   * filled" and "the RIGHT nodes are framed" are different claims: `frameSelected` is the
   * one that can be handed a node the canvas does not hold, and inside a component the
   * ROOT document's own ids are exactly that class of stale name.
   */
  it("frame-selected reaches an interior node and refuses the parent's id honestly", async () => {
    const { runtime, instance, internals } = await appAroundAnInstance();
    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: instance }, runtime.invocation);
    });

    const inner = internals[0] as string;
    const framed = await act(async () =>
      runtime.bus.execute("view.frameSelected", { nodeIds: [inner] }, runtime.invocation),
    );
    expect(framed.status, framed.diagnostics.map((d) => d.code).join(",")).toBe("applied");
    expect(framed.output.framed).toBe(1);

    // The instance node lives in the ROOT document and is NOT on this canvas. Refusing is
    // the honest answer, and it must be a refusal rather than a silent zero — that
    // silence (§V123) is what let a wrong-pane fit look like a working key.
    const stale = await act(async () =>
      runtime.bus.execute("view.frameSelected", { nodeIds: [instance] }, runtime.invocation),
    );
    expect(stale.status).toBe("rejected");
    expect(stale.output.framed).toBe(0);
    expect(stale.diagnostics.map((d) => d.code)).toContain("view.nothingToFrame");

    const home = await act(async () => runtime.bus.execute("view.home", {}, runtime.invocation));
    expect(home.status, home.diagnostics.map((d) => d.code).join(",")).toBe("applied");
    expect(home.output.framed).toBe(internals.length);
  });
});

/**
 * Commands whose answer LEGITIMATELY differs at depth, each with its reason.
 *
 * Read in two directions, so a STALE entry fails too: an excuse whose command has stopped
 * differing is a fix nobody deleted the excuse for, and it is as much a lie about the app
 * as a missing entry.
 */
const DEPTH_DEPENDENT: ReadonlyMap<string, string> = new Map([
  [
    "graph.jumpUp",
    "Leaving a component is the one command whose whole meaning IS the depth: at the root there is nowhere to go up to, and it says so by name.",
  ],
]);

describe("T1195 — no command loses its canvas at depth (derived from the bus registry)", () => {
  /**
   * The gate. Nothing here is enumerated by hand except the excuses.
   *
   * Every registered command is dry-run on the ROOT bus at the root and again after one
   * `graph.diveIn`, and the two answers — status plus diagnostic codes — must match.
   *
   * Dry run because every surface-backed command in this app refuses a null holder BEFORE
   * it honours `dryRun` (`view-commands.ts:83`, `selection-commands.ts:75`,
   * `node-search-command.ts:99` and their siblings all check the holder first), so an
   * empty holder is visible without eighty commands actually mutating a document.
   *
   * The input is `{}` for every command, so most answer with the same input complaint at
   * both depths — and that is the point. The property is that the answer does not CHANGE,
   * not that it is good; a missing-canvas rejection is reached first either way.
   */
  /*
   * §T1696b — TURNED TO THE EDIT BUS, AND TO THE COMMANDS THE PROPERTY IS ABOUT.
   *
   * The doors dispatch on the edit bus now: the project's at the root, the component
   * session's inside. So that is where each answer is asked. And the property "the answer
   * does not change with depth" is about the APP's commands, the ones a session inherits
   * (`"app"` and `"instance"`): a canvas, a panel, the transport are the same thing wherever
   * the editor stands. A `"definition"` command answers about the graph in hand, which IS
   * another graph inside a component (its undo history is empty, its layout is its own), so
   * it differs by design; what it must never do is reach the project, and
   * `session-commands.test.tsx` holds that for every one of them.
   */
  it("every command the app owns answers the same at the root and inside a component, on the bus a key dispatches on", async () => {
    const { runtime, instance } = await appAroundAnInstance();
    const names = runtime.bus.listCommands().filter((name) => inSessionKind(runtime.bus.inSessionOf(name)!) !== "definition");
    // The registry IS the derivation, so an empty one would pass this gate vacuously.
    // Asserted rather than trusted (§V707).
    expect(names.length).toBeGreaterThan(40);

    const dry = { ...runtime.invocation, dryRun: true };
    const census = async (bus: LoomBus) => {
      const rows = new Map<string, string>();
      for (const name of names) {
        const result = await act(async () => bus.execute(name as CommandName, {} as never, dry));
        rows.set(name, `${result.status} [${result.diagnostics.map((d) => d.code).sort().join(", ")}]`);
      }
      return rows;
    };

    const atRoot = await census(runtime.bus);
    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: instance }, runtime.invocation);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    const session = sessions.at(-1);
    if (session === undefined) throw new Error("the dive opened no session");
    expect(session.bus.parent).toBe(runtime.bus);
    const inside = await census(session.bus);

    // A NAMED difference, not a count: a failure says which command lost its surface and
    // what it answers instead, which is the whole of the diagnosis.
    const drifted = names
      .filter((name) => !DEPTH_DEPENDENT.has(name))
      .filter((name) => atRoot.get(name) !== inside.get(name))
      .map((name) => `${name}: root ${atRoot.get(name)} -> inside ${inside.get(name)}`);
    expect(drifted).toEqual([]);

    const settled = [...DEPTH_DEPENDENT.keys()].filter(
      (name) => names.includes(name) && atRoot.get(name) === inside.get(name),
    );
    expect(settled).toEqual([]);
  });
});
