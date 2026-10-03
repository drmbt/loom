import { describe, expect, it } from "vitest";
import { createDomainBus } from "@domain/commands/index.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { GEOMETRY_PRESERVING, fitPlaced, fitShown, mappingTargetsOf } from "./perform-mapping.ts";
import type { WindowFit } from "./perform-mapping.ts";

/**
 * §T1536b — the two pure halves of the perform window's edit-mapping mode: which mapping
 * node's handles can be placed exactly on a Window Out, and Fit's map between its input and
 * its target. The integration (`perform-mapping.test.tsx`) proves the common chain end to
 * end; this pins the branches it does not stage.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const context = contextFor(alice);

/** `checker → …chain → window`; returns the ids in that order and the labels. */
async function chainOf(chain: readonly string[], extra: (ids: Record<string, string>) => GraphPatchOperation[] = () => []) {
  const store = createGraphStore({ ids: createSequentialIdFactory("n") });
  const { bus } = createDomainBus({ store, registry });
  const types = ["checker", ...chain, "window"];
  const port = (type: string) => (type === "lookup" ? "source" : type === "null" ? "in" : "input");
  const result = await bus.execute(
    "graph.applyPatch",
    {
      baseRevision: 0,
      operations: [
        ...types.map((type, index) => ({ op: "addNode" as const, ref: `$${String(index)}` as const, type, position: { x: index * 300, y: 0 } })),
        ...types.slice(1).map((type, index) => ({
          op: "connect" as const,
          source: { nodeId: `$${String(index)}` as const, portId: "out" },
          target: { nodeId: `$${String(index + 1)}` as const, portId: port(type) },
        })),
      ],
    },
    context,
  );
  expect(result.status, JSON.stringify(result.diagnostics)).toBe("applied");
  const ids = types.map((_, index) => result.output.createdIds[`$${String(index)}`] ?? "");
  const more = extra(Object.fromEntries(ids.map((id, index) => [`$${String(index)}`, id])));
  if (more.length > 0) {
    const patched = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: more }, context);
    expect(patched.status, JSON.stringify(patched.diagnostics)).toBe("applied");
  }
  const graph = bus.store.getGraph();
  const label = (index: number) => graph.nodes[ids[index] ?? ""]?.label ?? "";
  return { graph, ids, label, windowId: ids[ids.length - 1] ?? "" };
}

describe("mappingTargetsOf — exact or refused, never guessed", () => {
  it("a bypassed Transform is a wire: the Corner Pin behind it is placed exactly", async () => {
    const { graph, ids, windowId } = await chainOf(["cornerPin", "transform"], (ref) => [
      { op: "setNodeUi", nodeId: ref["$2"] as string, ui: { bypassed: true } },
    ]);
    expect(mappingTargetsOf(graph, registry, windowId)).toEqual([
      expect.objectContaining({ nodeId: ids[1], kind: "cornerPin", refusal: null }),
    ]);
  });

  it("§T1538b: Corner Pins are crossed — each target behind them carries them, in picture order", async () => {
    const { graph, ids, windowId, label } = await chainOf(["gridWarp", "cornerPin", "level", "cornerPin"]);
    expect(mappingTargetsOf(graph, registry, windowId)).toEqual([
      expect.objectContaining({ nodeId: ids[4], kind: "cornerPin", refusal: null, through: [] }),
      expect.objectContaining({ nodeId: ids[2], kind: "cornerPin", refusal: null, through: [{ nodeId: ids[4], name: label(4) }] }),
      expect.objectContaining({
        nodeId: ids[1],
        kind: "gridWarp",
        refusal: null,
        through: [
          { nodeId: ids[2], name: label(2) },
          { nodeId: ids[4], name: label(4) },
        ],
      }),
    ]);
  });

  it("§T1538b: a Transform in front of a Corner Pin still refuses what lies behind both", async () => {
    const { graph, windowId, label } = await chainOf(["gridWarp", "cornerPin", "transform"]);
    expect(mappingTargetsOf(graph, registry, windowId).map((target) => target.refusal)).toEqual([
      `Transform "${label(3)}" moves the picture between Corner Pin "${label(2)}" and this window, so its handles cannot be placed exactly here.`,
      `Transform "${label(3)}" moves the picture between Grid Warp "${label(1)}" and this window, so its handles cannot be placed exactly here.`,
    ]);
  });

  it("the same Transform, live, refuses it by name", async () => {
    const { graph, windowId, label } = await chainOf(["cornerPin", "transform"]);
    expect(mappingTargetsOf(graph, registry, windowId)[0]?.refusal).toBe(
      `Transform "${label(2)}" moves the picture between Corner Pin "${label(1)}" and this window, so its handles cannot be placed exactly here.`,
    );
  });

  it("a muted colour node between them refuses, and says it is muted", async () => {
    const { graph, windowId, label } = await chainOf(["cornerPin", "level"], (ref) => [
      { op: "setNodeUi", nodeId: ref["$2"] as string, ui: { muted: true } },
    ]);
    expect(mappingTargetsOf(graph, registry, windowId)[0]?.refusal).toBe(
      `Level "${label(2)}" is muted between Corner Pin "${label(1)}" and this window, so its handles cannot be placed exactly here.`,
    );
  });

  it("follows the Window Out's Source NAME when nothing is wired (B233)", async () => {
    const { graph, ids, windowId, label } = await chainOf(["gridWarp"]);
    // The wire into the window taken away: nothing feeds it, then its Source names the warp.
    const unwired = {
      ...graph,
      edges: Object.fromEntries(Object.entries(graph.edges).filter(([, edge]) => edge.target.nodeId !== windowId)),
    };
    expect(mappingTargetsOf(unwired, registry, windowId)).toEqual([]);
    const named = {
      ...unwired,
      nodes: { ...unwired.nodes, [windowId]: { ...unwired.nodes[windowId]!, parameters: { ...unwired.nodes[windowId]!.parameters, source: label(1) } } },
    };
    expect(mappingTargetsOf(named, registry, windowId)).toEqual([expect.objectContaining({ nodeId: ids[1], kind: "gridWarp", refusal: null })]);
  });

  it("every geometry-preserving entry names a real node type and its real picture input", () => {
    for (const [type, input] of Object.entries(GEOMETRY_PRESERVING)) {
      const definition = registry.get(type);
      expect(definition, type).toBeDefined();
      expect(definition?.inputs.some((port) => port.id === input), `${type}.${input}`).toBe(true);
    }
  });
});

describe("Fit, restated from the Window Out shader", () => {
  const cases: ReadonlyArray<[WindowFit, readonly [number, number]]> = [
    ["fit", [1280, 720]],
    ["fit", [720, 1280]],
    ["fill", [1280, 720]],
    ["fill", [720, 1280]],
    ["stretch", [1280, 720]],
  ];
  it.each(cases)("%s with a %j input in a square target: shown ∘ placed is the identity", (fit, inputSize) => {
    const facts = { fit, inputSize, targetSize: [1000, 1000] as const };
    for (const point of [[0, 0], [0.25, 0.8], [1, 1], [0.5, 0.5]] as const) {
      const [x, y] = fitShown(facts, fitPlaced(facts, point));
      expect(x).toBeCloseTo(point[0], 12);
      expect(y).toBeCloseTo(point[1], 12);
    }
  });

  it("fill crops a 16:9 input into a square: the input's x 0.21875..0.78125 spans the target", () => {
    // ratio = 1 / (16/9) = 0.5625; fill on a narrower target scales x: x_in = (x − 0.5)·0.5625 + 0.5.
    const facts = { fit: "fill" as const, inputSize: [1280, 720] as const, targetSize: [1000, 1000] as const };
    expect(fitPlaced(facts, [0, 0.3])).toEqual([0.21875, 0.3]);
    expect(fitPlaced(facts, [1, 0.3])).toEqual([0.78125, 0.3]);
    expect(fitShown({ ...facts, fit: "stretch" }, [0.3, 0.7])).toEqual([0.3, 0.7]);
  });
});
