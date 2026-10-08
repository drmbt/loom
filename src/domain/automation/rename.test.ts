import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createDomainBus } from "../commands/index.ts";
import { alice, contextFor, patch } from "../commands/test-support.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createGraphStore } from "../graph/store.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { newKey, newLane, parseAutomation, serializeAutomation } from "./model.ts";
import { laneRenameOperations, rewriteChannelReads } from "./rename.ts";

const LANES = serializeAutomation({
  version: 1,
  lanes: [
    newLane("lane1", "opacity", [newKey("key1", 0, 0)]),
    newLane("lane2", "spin", [newKey("key1", 0, 1)]),
  ],
});

const expression = (source: string) => ({ mode: "expression", bindings: { expression: { kind: "expression", source } } });

async function documentWithReaders() {
  const store = createGraphStore({ ids: createSequentialIdFactory("t"), now: () => "2026-10-07T00:00:00.000Z" });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry(allNodeDefinitions).view() });
  const ctx = contextFor(alice);
  const add = (ref: string, type: string, label: string, parameters: Record<string, unknown>): GraphPatchOperation =>
    ({ op: "addNode", ref, type, label, position: { x: 0, y: 0 }, parameters } as never);
  const created = await bus.execute(
    "graph.applyPatch",
    patch(store.view.getRevision(), [
      add("$auto", "automation", "automation_score", { lanes: LANES }),
      add("$a", "constant", "constant_a", { value: expression("op('automation_score').chan.opacity * 2 + op(\"automation_score\").chan.opacity") }),
      // Another node's channel of the same name, and another lane of this node: untouched.
      add("$b", "constant", "constant_b", { value: expression("op('lfo_other').chan.opacity + op('automation_score').chan.spin") }),
      // A RETAINED expression (static is active) is still the author's text, and follows.
      add("$c", "constant", "constant_c", { value: { mode: "static", bindings: { static: { kind: "static", value: 3 }, expression: { kind: "expression", source: "op('automation_score').chan.opacity" } } } }),
    ]),
    ctx,
  );
  if (created.status !== "applied") throw new Error(JSON.stringify(created));
  const ids = created.output.createdIds as Record<string, string>;
  return { store, bus, ctx, ids };
}

const sourceOf = (stored: unknown): string => (stored as { bindings: { expression: { source: string } } }).bindings.expression.source;

describe("VN61 — renaming a lane rewrites every reference, in one undo step", () => {
  it("rewrites the lane and every op('<node>').chan.<old> read, and one undo restores both", async () => {
    const { store, bus, ctx, ids } = await documentWithReaders();
    const before = store.view.getGraph();
    const plan = laneRenameOperations(before, ids["$auto"]!, "lane1", "alpha");
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.rewritten).toBe(2);

    const applied = await bus.execute("graph.applyPatch", patch(store.view.getRevision(), plan.operations), ctx);
    expect(applied.status).toBe("applied");
    const after = store.view.getGraph();
    const lanes = parseAutomation(after.nodes[ids["$auto"]!]?.parameters["lanes"]);
    expect(lanes.ok && lanes.document.lanes.map((lane) => lane.name)).toEqual(["alpha", "spin"]);
    expect(sourceOf(after.nodes[ids["$a"]!]?.parameters["value"])).toBe("op('automation_score').chan.alpha * 2 + op(\"automation_score\").chan.alpha");
    expect(sourceOf(after.nodes[ids["$b"]!]?.parameters["value"])).toBe("op('lfo_other').chan.opacity + op('automation_score').chan.spin");
    expect(sourceOf(after.nodes[ids["$c"]!]?.parameters["value"])).toBe("op('automation_score').chan.alpha");

    // ONE undo puts the name and every reference back.
    await bus.execute("graph.undo", {}, ctx);
    const undone = store.view.getGraph();
    for (const key of ["$auto", "$a", "$b", "$c"]) expect(undone.nodes[ids[key]!]?.parameters).toEqual(before.nodes[ids[key]!]?.parameters);
  });

  it("refuses a taken name, a non-identifier and an unknown lane; same name is an empty plan", async () => {
    const { store, ids } = await documentWithReaders();
    const graph = store.view.getGraph();
    expect(laneRenameOperations(graph, ids["$auto"]!, "lane1", "spin")).toEqual({ ok: false, reason: 'Another lane is already named "spin".' });
    expect(laneRenameOperations(graph, ids["$auto"]!, "lane1", "9lives")).toMatchObject({ ok: false });
    expect(laneRenameOperations(graph, ids["$auto"]!, "nope", "x")).toMatchObject({ ok: false });
    expect(laneRenameOperations(graph, ids["$auto"]!, "lane1", "opacity")).toEqual({ ok: true, operations: [], rewritten: 0 });
  });

  it("refuses the whole rename when the parser and the text rewrite disagree", async () => {
    const { store, ids } = await documentWithReaders();
    // A scan that renames only the first read of two: the parser still sees the old one.
    const firstOnly: typeof rewriteChannelReads = (source, node, from, to) => {
      const whole = rewriteChannelReads(source, node, from, to);
      const at = source.indexOf(`.chan.${from}`);
      return { source: `${source.slice(0, at)}.chan.${to}${source.slice(at + `.chan.${from}`.length)}`, count: whole.count };
    };
    expect(laneRenameOperations(store.view.getGraph(), ids["$auto"]!, "lane1", "alpha", firstOnly)).toEqual({
      ok: false,
      reason: 'Could not rewrite the reference in "constant_a".value; nothing was renamed.',
    });
  });

  it("the text rewrite honours quotes and whole tokens", () => {
    const rewrite = (source: string) => rewriteChannelReads(source, "auto", "op", "go").source;
    expect(rewrite("op('auto').chan.op")).toBe("op('auto').chan.go");
    expect(rewrite("op( 'auto' ) . chan . op+1")).toBe("op( 'auto' ) . chan . go+1");
    // A longer member is a different channel.
    expect(rewrite("op('auto').chan.opacity")).toBe("op('auto').chan.opacity");
    // Another node, and a node whose NAME merely contains the text.
    expect(rewrite("op('autox').chan.op + op('x').chan.op")).toBe("op('autox').chan.op + op('x').chan.op");
  });
});
