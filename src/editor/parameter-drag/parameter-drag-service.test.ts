import { describe, expect, it, vi } from "vitest";
import { createAppRuntime } from "../../app/app-runtime.ts";
import { createParameterDragService } from "./parameter-drag-service.ts";

/**
 * VN63 — a drop on a parameter of ANOTHER node writes `op('<source>').par.<key>` through
 * the existing paste path, one undo step; an unnamed source carries no reference.
 */
async function setup() {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "t", label: "T" } });
  const seeded = await runtime.bus.execute(
    "graph.applyPatch",
    {
      baseRevision: runtime.bus.store.getRevision(),
      label: "seed",
      operations: [
        { op: "addNode", ref: "$a", type: "lfo", position: { x: 0, y: 0 }, label: "lfo_a", parameters: { amplitude: 2 } },
        { op: "addNode", ref: "$b", type: "lfo", position: { x: 200, y: 0 }, label: "lfo_b", parameters: { offset: 0.5 } },
      ],
    },
    runtime.invocation,
  );
  const ids = seeded.output.createdIds as Record<string, string>;
  const refused = vi.fn();
  const service = createParameterDragService({ bus: runtime.bus, invocation: runtime.invocation, onRefused: refused });
  return { runtime, a: ids["$a"]!, b: ids["$b"]!, service, refused };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("VN63 — the parameter drag service", () => {
  it("carries op('<name>').par.<key>, and writes it onto another node's parameter in one undo step", async () => {
    const { runtime, a, b, service, refused } = await setup();
    expect(service.referenceText({ nodeId: a, key: "amplitude" })).toBe("op('lfo_a').par.amplitude");
    service.dropOnParameter({ nodeId: b, key: "offset" }, { nodeId: a, key: "amplitude" });
    await settle();
    expect(runtime.bus.store.getGraph().nodes[b]!.parameters["offset"]).toMatchObject({
      mode: "expression",
      bindings: { expression: { kind: "expression", source: "op('lfo_a').par.amplitude" } },
    });
    expect(refused).not.toHaveBeenCalled();
    await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    expect(runtime.bus.store.getGraph().nodes[b]!.parameters["offset"]).toBe(0.5);
  });
});
