import { beforeAll, describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { codeParametersOf } from "../../domain/parameters/code.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { BackendDiagnosticCode } from "../../runtime/backend/diagnostics.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { diagnosticsForCodeParameter, diagnosticsToMarkers } from "./shader-diagnostics.ts";

/**
 * T1523b — THE CODE PANE MARKS THE LINE THE DEVICE OBJECTED TO, IN THE TEXT IT IS IN.
 *
 * A point kernel's device error used to mark nothing: the pane drew markers for the `source`
 * parameter only, and the position was a line of a generated module the author never saw.
 * Here the literal error goes through compiler + backend + Dawn, and the diagnostic the
 * backend reports goes through the SAME two functions `ShaderPane` (app/dock-panes.tsx)
 * calls, against the node's own code parameters: the kernel's editor gets one marker, on
 * `notAFunction` exactly; the group predicate's and the attribute schema's get none.
 */

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = notAFunction(p.position);
  return q;
}`;

function graph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      sim: {
        id: "sim",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { capacity: 8, seed: 7, kernel: KERNEL },
      },
      draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8, sizePixels: 6 } },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

describe("a device error marks the author's line in the right code editor (T1523b(a), §V27)", () => {
  it("the kernel's editor marks `notAFunction`; the node's other code editors mark nothing", async () => {
    if (dawnError !== undefined) throw new Error(`Dawn did not start: ${dawnError}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: RuntimeDiagnostic[] = [];
    backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const document = graph();
      const plan = compileGraph({
        graph: document,
        settings: {
          outputResolution: { width: 64, height: 64 },
          workingFormat: "rgba8unorm",
          randomSeed: 7,
          previewLongEdge: 64,
          previewFps: 20,
          limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
        },
        registry,
        capabilities,
      });
      await expect(backend.compile(plan)).rejects.toBeDefined();
      const node = diagnostics.filter((d) => d.nodeId === "sim");
      expect(node.map((d) => d.code)).toEqual([BackendDiagnosticCode.compileFailed]);

      // The pane's subjects, derived the way the pane derives them.
      const sim = document.nodes["sim"]!;
      const definition = registry.get(sim.type)!;
      const keys = codeParametersOf(effectiveParameterSchema(definition, sim.parameters)).map((entry) => entry.key);
      expect(keys).toContain("kernel");
      expect(keys.length).toBeGreaterThan(1);

      const marked = Object.fromEntries(
        keys.map((key) => [key, diagnosticsToMarkers(KERNEL, diagnosticsForCodeParameter(node, key, keys, "source"))]),
      );
      const at = KERNEL.indexOf("notAFunction");
      expect(marked["kernel"]!.map((marker) => [marker.severity, marker.from])).toEqual([["error", at]]);
      for (const key of keys.filter((entry) => entry !== "kernel")) expect(marked[key]).toEqual([]);
    } finally {
      backend.dispose();
    }
  }, 60_000);
});
