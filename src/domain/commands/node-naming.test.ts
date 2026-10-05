import { beforeEach, describe, expect, it } from "vitest";

import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import type { ParameterSlot } from "../types/parameters.ts";
import { createDomainBus } from "./index.ts";
import type { LoomBus } from "./bus.ts";
import { alice, contextFor, patch } from "./test-support.ts";

/**
 * NODE NAMES CARRY THEIR KIND, THROUGH THE REAL CATALOGUE AND THE REAL BUS (T1593b).
 *
 * The owner's complaint was that a renamed node stops saying what it is: `dye1`, `lamp`,
 * `pathx1`. The rule that answers it has two halves and both are asserted here as the
 * NAME THE DOCUMENT HOLDS, which is what the canvas draws and what `op('…')` resolves:
 *
 *  - a NEW node is numbered under its kind, so it conforms before anyone touches it;
 *  - a RENAME keeps the kind in front, unless the caller says `exact`.
 *
 * And one thing must not happen: a kind is never applied to a name that is already stored.
 */

const AT = { x: 0, y: 0 };

function expressionSlot(source: string, retained: number): ParameterSlot {
  return {
    mode: "expression",
    bindings: { static: { kind: "static", value: retained }, expression: { kind: "expression", source } },
  };
}

describe("node names carry their kind (T1593b)", () => {
  let bus: LoomBus;
  let store: GraphStore;

  beforeEach(() => {
    store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-05T00:00:00.000Z" });
    bus = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() }).bus;
  });

  const apply = (operations: GraphPatchOperation[]) =>
    bus.execute("graph.applyPatch", patch(store.view.getRevision(), operations), contextFor(alice));

  async function add(type: string, label?: string): Promise<string> {
    const result = await apply([{ op: "addNode", ref: "$n", type, position: AT, ...(label === undefined ? {} : { label }) }]);
    expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
    return result.output.createdIds["$n"] as string;
  }

  const nameOf = (id: string) => store.view.getGraph().nodes[id]?.label;

  describe("a new node is numbered under its kind", () => {
    it("uses the declared short kind for a long type", async () => {
      expect(nameOf(await add("pointKernel"))).toBe("kernel1");
      expect(nameOf(await add("movieFileIn"))).toBe("movie1");
      expect(nameOf(await add("customWgsl"))).toBe("wgsl1");
      expect(nameOf(await add("valueMath"))).toBe("math1");
      expect(nameOf(await add("renderInstances"))).toBe("instances1");
    });

    it("keeps the names that were already short", async () => {
      expect(nameOf(await add("blur"))).toBe("blur1");
      expect(nameOf(await add("slider"))).toBe("slider1");
      expect(nameOf(await add("blur"))).toBe("blur2");
    });

    it("numbers the members of one family in one sequence, so the names stay unique", async () => {
      expect(nameOf(await add("materialPbr"))).toBe("material1");
      expect(nameOf(await add("materialGlass"))).toBe("material2");
      expect(nameOf(await add("limit"))).toBe("limit1");
      expect(nameOf(await add("valueLimit"))).toBe("limit2");
    });

    it("stores an EXPLICIT label exactly, conforming or not (§V324: a patch is replayable)", async () => {
      expect(nameOf(await add("slider", "lamp"))).toBe("lamp");
      expect(nameOf(await add("slider", "slider_lamp"))).toBe("slider_lamp");
    });
  });

  describe("a stored name never moves when a kind changes", () => {
    it("leaves yesterday's auto-name alone and numbers the next node under the kind", async () => {
      // `pointkernel1` is what a Point Kernel was auto-named before T1593b, and what a
      // saved document still holds.
      const old = await add("pointKernel", "pointkernel1");
      const reader = await add("blur");
      await apply([
        { op: "setParameters", nodeId: reader, parameters: { size: expressionSlot("op('pointkernel1').par.count", 2) } },
      ]);

      const fresh = await add("pointKernel");

      expect(nameOf(old)).toBe("pointkernel1");
      expect(nameOf(fresh)).toBe("kernel1");
      const size = store.view.getGraph().nodes[reader]?.parameters["size"] as ParameterSlot;
      expect(size.bindings.expression).toEqual({ kind: "expression", source: "op('pointkernel1').par.count" });
    });
  });

  describe("node.rename keeps the kind in front", () => {
    it("prefixes a bare role and says what the node was actually called", async () => {
      const id = await add("slider");
      const result = await bus.execute("node.rename", { nodeId: id, label: "lamp" }, contextFor(alice));

      expect(result.status).toBe("applied");
      expect(nameOf(id)).toBe("slider_lamp");
      const note = result.diagnostics.find((entry) => entry.code === "node.name.kind");
      expect(note?.severity).toBe("info");
      expect(note?.message).toBe(`Named "slider_lamp", not "lamp": a node's name carries its kind (kind_role).`);
      // The command's own output carries it too: an agent tool reads the output.
      expect(result.output.diagnostics.some((entry) => entry.code === "node.name.kind")).toBe(true);
    });

    it("uses the type's SHORT kind, not its type string", async () => {
      const id = await add("pointKernel");
      await bus.execute("node.rename", { nodeId: id, label: "joints" }, contextFor(alice));
      expect(nameOf(id)).toBe("kernel_joints");
    });

    it("takes a name that already carries the kind as typed, and says nothing", async () => {
      const id = await add("blur");
      const result = await bus.execute("node.rename", { nodeId: id, label: "blur_diffuse" }, contextFor(alice));
      expect(nameOf(id)).toBe("blur_diffuse");
      expect(result.diagnostics.some((entry) => entry.code === "node.name.kind")).toBe(false);
    });

    it("`exact` stores the name as given: removing the prefix is possible, and deliberate", async () => {
      const id = await add("slider");
      const result = await bus.execute("node.rename", { nodeId: id, label: "lamp", exact: true }, contextFor(alice));
      expect(nameOf(id)).toBe("lamp");
      expect(result.diagnostics.some((entry) => entry.code === "node.name.kind")).toBe(false);
    });

    it("rewrites every reference to the PREFIXED name in the same patch (§V128)", async () => {
      const slider = await add("slider");
      const reader = await add("blur");
      await apply([
        { op: "setParameters", nodeId: reader, parameters: { size: expressionSlot("op('slider1').chan.value * 8", 2) } },
      ]);

      const result = await bus.execute("node.rename", { nodeId: slider, label: "lamp" }, contextFor(alice));

      const size = store.view.getGraph().nodes[reader]?.parameters["size"] as ParameterSlot;
      // If the rename had stored one name and rewritten another, this would read
      // `op('lamp')` and resolve to nothing.
      expect(size.bindings.expression).toEqual({ kind: "expression", source: "op('slider_lamp').chan.value * 8" });
      expect(result.diagnostics.some((entry) => entry.code === "node.name.referencesRewritten")).toBe(true);
    });

    it("moves the Channel In that reads a renamed Analyze, and leaves one that reads something else", async () => {
      // The literal bug: an Analyze publishes its measurement under its own NAME, a Channel
      // In reads it by that name, and the rename moved the name out from under the reader.
      // Nothing failed. The controller just read its Fallback from then on.
      const sensor = await add("analyze", "analyze_meter");
      const reader = await add("channelIn");
      const stranger = await add("channelIn");
      await apply([
        { op: "setParameters", nodeId: reader, parameters: { channel: "analyze_meter" } },
        { op: "setParameters", nodeId: stranger, parameters: { channel: "/1/fader1" } },
      ]);

      const result = await bus.execute("node.rename", { nodeId: sensor, label: "glow" }, contextFor(alice));

      expect(nameOf(sensor)).toBe("analyze_glow");
      // What the reader will ask the channel resolver for on the next frame.
      expect(store.view.getGraph().nodes[reader]?.parameters["channel"]).toBe("analyze_glow");
      // A name no node holds is not a reference to one.
      expect(store.view.getGraph().nodes[stranger]?.parameters["channel"]).toBe("/1/fader1");
      expect(result.diagnostics.some((entry) => entry.code === "node.name.referencesRewritten")).toBe(true);
    });

    it("refuses a taken name by the name it would have stored, and offers the free neighbour (§V325)", async () => {
      const first = await add("slider");
      const second = await add("slider");
      await bus.execute("node.rename", { nodeId: first, label: "lamp" }, contextFor(alice));

      const result = await bus.execute("node.rename", { nodeId: second, label: "lamp" }, contextFor(alice));

      expect(result.status).toBe("rejected");
      expect(nameOf(second)).toBe("slider2");
      const refusal = result.diagnostics.find((entry) => entry.code === "node.nameTaken");
      expect(refusal?.message).toBe(`Operation 0 (setNodeLabel): the name "slider_lamp" is already in use.`);
      expect(refusal?.suggestion).toBe(`"slider_lamp2" is free.`);
      // A refusal renamed nothing, so it must not also claim to have named something.
      expect(result.diagnostics.some((entry) => entry.code === "node.name.kind")).toBe(false);
    });

    it("a dry run reports the name it WOULD store and stores nothing", async () => {
      const id = await add("light");
      const before = store.view.getRevision();
      const result = await bus.execute("node.rename", { nodeId: id, label: "key" }, contextFor(alice, { dryRun: true }));

      expect(result.status).toBe("validated");
      expect(nameOf(id)).toBe("light1");
      expect(store.view.getRevision()).toBe(before);
      expect(result.diagnostics.find((entry) => entry.code === "node.name.kind")?.message).toContain(`"light_key"`);
    });

    it("is one undo step back to the name the node had", async () => {
      const id = await add("lfo");
      await bus.execute("node.rename", { nodeId: id, label: "pathx" }, contextFor(alice));
      expect(nameOf(id)).toBe("lfo_pathx");
      await bus.execute("graph.undo", {}, contextFor(alice));
      expect(nameOf(id)).toBe("lfo1");
    });

    it("does not prefix a component's In: its name is the socket's label", async () => {
      const id = await add("componentIn");
      expect(nameOf(id)).toBe("in1");
      const result = await bus.execute("node.rename", { nodeId: id, label: "depth" }, contextFor(alice));
      expect(nameOf(id)).toBe("depth");
      expect(result.diagnostics.some((entry) => entry.code === "node.name.kind")).toBe(false);
    });

    it("still refuses a blank name rather than naming the node its bare kind", async () => {
      const id = await add("blur");
      const result = await bus.execute("node.rename", { nodeId: id, label: "   " }, contextFor(alice));
      expect(result.status).toBe("rejected");
      expect(result.diagnostics.some((entry) => entry.code === "node.label.empty")).toBe(true);
      expect(nameOf(id)).toBe("blur1");
    });
  });
});
