import { describe, expect, it } from "vitest";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { FrameScheduler } from "@ui/controls/coalesce.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createPhoneWrites, phoneActor } from "./phone-writes.ts";

/**
 * T1396b — A PHONE'S WRITE LANDS IN THE DOCUMENT AS THAT PHONE, AND ONLY WHEN IT MAY.
 *
 * Through the real bus and the real registry: what a phone sends becomes a stored value
 * the desk reads back, the audit entry names the phone, a whole phone gesture (live
 * frames then a lift) undoes in ONE step from the phone's own stack while the desk's
 * stack is untouched, and a refused write changes nothing and is SAID.
 */

const desk = contextFor(alice);

async function stage(): Promise<{ bus: LoomBus; id: (ref: string) => NodeId }> {
  const store = createGraphStore({ ids: createSequentialIdFactory("w"), now: () => "2026-09-29T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const add = (ref: string, type: string, label: string, parameters: Record<string, unknown>): GraphPatchOperation =>
    ({ op: "addNode", ref: `$${ref}`, type, position: { x: 0, y: 0 }, label, parameters }) as GraphPatchOperation;
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getRevision(),
      operations: [
        add("fader", "slider", "fader1", { channel: "heat", value: 0.25, min: 0, max: 1, step: 0.125 }),
        add("cut", "button", "button1", { channel: "cut", presses: 2 }),
        add("stage", "panel", "panel1", { remote: true, layout: "fader1 button1" }),
      ],
    },
    desk,
  );
  const created = result.output.createdIds as Record<string, NodeId>;
  return { bus, id: (ref) => created[`$${ref}`]! };
}

/** Frames run only when the test says so — the parameter editor's coalescing, made visible. */
function manualFrames(): { schedule: FrameScheduler; frame: () => void } {
  let queued: Array<() => void> = [];
  return {
    schedule: (callback) => {
      queued.push(callback);
      return () => {
        queued = queued.filter((entry) => entry !== callback);
      };
    },
    frame: () => {
      const run = queued;
      queued = [];
      for (const callback of run) callback();
    },
  };
}

const value = (bus: LoomBus, node: NodeId, key: string): unknown => bus.store.getGraph().nodes[node]!.parameters[key];

describe("T1396b — phone writes through the bus", () => {
  it("a phone drag is live frames plus a lift: one undo group on the PHONE's stack, audited as the phone", async () => {
    const { bus, id } = await stage();
    const frames = manualFrames();
    const refusals: string[] = [];
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: frames.schedule, onRefused: (_p, reason) => refusals.push(reason) });
    const fader = id("fader");
    const auditBefore = bus.store.getAudit().length;

    void writes.write("p1", { handle: fader, values: { value: 0.4 }, phase: "live" });
    await writes.settled();
    expect(value(bus, fader, "value")).toBe(0.375); // snapped to the 0.125 step
    void writes.write("p1", { handle: fader, values: { value: 0.61 }, phase: "live" });
    frames.frame();
    await writes.settled();
    expect(value(bus, fader, "value")).toBe(0.625);
    void writes.write("p1", { handle: fader, values: { value: 4 }, phase: "commit" });
    await writes.settled();
    expect(value(bus, fader, "value")).toBe(1); // clamped to Max

    const entries = bus.store.getAudit().slice(auditBefore);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((entry) => entry.actor.id === "remote-p1" && entry.actor.kind === "human" && entry.status === "applied")).toBe(true);
    const groups = new Set(entries.map((entry) => entry.undoGroupId));
    expect(groups.size).toBe(1);

    // The phone's stack holds ONE group; the desk's holds only its own setup.
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
    expect(bus.store.getHistory(alice).undo).toHaveLength(1);
    // Undo at the desk undoes the DESK's latest edit and does not reach the phone's gesture…
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: id("cut"), parameters: { presses: 10 } }] },
      desk,
    );
    await bus.execute("graph.undo", {}, desk);
    expect(value(bus, id("cut"), "presses")).toBe(2);
    expect(value(bus, fader, "value")).toBe(1);
    // …and ONE undo as the phone lands on the value before the drag started.
    await bus.execute("graph.undo", {}, contextFor(phoneActor("p1")));
    expect(value(bus, fader, "value")).toBe(0.25);
    expect(refusals).toEqual([]);
  });

  it("two phones keep two undo stacks", async () => {
    const { bus, id } = await stage();
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: () => undefined });
    await writes.write("p1", { handle: id("fader"), values: { value: 0.5 }, phase: "commit" });
    await writes.write("p2", { handle: id("fader"), values: { value: 0.75 }, phase: "commit" });
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
    expect(bus.store.getHistory(phoneActor("p2")).undo).toHaveLength(1);
  });

  it("a button press and release, sent back to back, counts ONE press in ONE undo group", async () => {
    const { bus, id } = await stage();
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: () => undefined });
    const cut = id("cut");
    // Not awaited between: the release must be vetted against a document that has the press.
    void writes.write("p1", { handle: cut, values: { held: true }, phase: "live" });
    void writes.write("p1", { handle: cut, values: { held: true }, phase: "live" });
    const released = writes.write("p1", { handle: cut, values: { held: false }, phase: "commit" });
    await released;
    await writes.settled();
    expect(value(bus, cut, "presses")).toBe(3);
    expect(value(bus, cut, "held")).toBe(false);
    expect(bus.store.getHistory(phoneActor("p1")).undo).toHaveLength(1);
  });

  it("a phone that drops mid-press lets go of the button", async () => {
    const { bus, id } = await stage();
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: () => undefined });
    await writes.write("p1", { handle: id("cut"), values: { held: true }, phase: "live" });
    expect(value(bus, id("cut"), "held")).toBe(true);
    await writes.release("p1");
    expect(value(bus, id("cut"), "held")).toBe(false);
    expect(value(bus, id("cut"), "presses")).toBe(3);
  });

  it("a Panel switched off mid-session refuses its widgets: nothing written, the refusal said", async () => {
    const { bus, id } = await stage();
    const refusals: Array<[string, string]> = [];
    const writes = createPhoneWrites({ bus, invocation: desk, schedule: manualFrames().schedule, onRefused: (phone, reason) => refusals.push([phone, reason]) });
    await writes.write("p1", { handle: id("fader"), values: { value: 0.5 }, phase: "commit" });
    expect(value(bus, id("fader"), "value")).toBe(0.5);
    await bus.execute(
      "graph.applyPatch",
      { baseRevision: bus.store.getRevision(), operations: [{ op: "setParameters", nodeId: id("stage"), parameters: { remote: false } }] },
      desk,
    );
    const revision = bus.store.getRevision();
    await writes.write("p1", { handle: id("fader"), values: { value: 1 }, phase: "commit" });
    expect(value(bus, id("fader"), "value")).toBe(0.5);
    expect(bus.store.getRevision()).toBe(revision);
    expect(refusals).toEqual([["p1", "A phone tried to move a control that is not published to the phone door."]]);
  });
});
