import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { pointStorageId } from "../../../nodes/definitions/point-storage.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * §T1707b (§V168, §V47): A KERNEL READS THE TEXTURE ITS OWN FRAME RENDERED, ON BOTH PATHS.
 *
 * Through vgpu 0.5.0 a kernel submitted its own command buffer the moment it was encoded,
 * while the frame's render passes went out when the frame closed. The direct path split the
 * frame around every kernel to keep plan order; the live loop could not, so there a kernel
 * that sampled a texture rendered earlier in the plan read the PREVIOUS frame's (B19's
 * remaining caveat). The same project then rendered one picture live and another on export.
 *
 * The literal case is the TOP→POP bridge on the FIRST frame: the solid has rendered nothing
 * before it, so a kernel that runs ahead of it samples a zero-initialised texture. Run in
 * plan order it samples the solid's colour, exactly.
 */

const SIZE = 64;
const POINTS = 8;

function plan() {
  return compileGraph({
    graph: {
      revision: 1,
      nodes: {
        sim: { id: "sim", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: POINTS, seed: 7 } },
        tex: { id: "tex", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [0, 1, 0, 1] } },
        bridge: { id: "bridge", type: "textureToAttribute", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: POINTS } },
        draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: POINTS, sizePixels: 6 } },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "bridge", portId: "points" } },
        e2: { id: "e2", source: { nodeId: "tex", portId: "out" }, target: { nodeId: "bridge", portId: "texture" } },
        e3: { id: "e3", source: { nodeId: "bridge", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
        e4: { id: "e4", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    },
    settings: {
      outputResolution: { width: SIZE, height: SIZE },
      workingFormat: "rgba8unorm",
      randomSeed: 7,
      previewLongEdge: 192,
      previewFps: 20,
      limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    },
    registry: createNodeRegistry(allNodeDefinitions).view(),
    capabilities: {
      tier: "B",
      features: [],
      formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
      timestampQuery: false,
      limits: { maxTextureDimension2D: 8192 },
    },
  });
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** What the bridge sampled into each point after ONE frame on the given path. */
async function firstFrameSamples(path: "direct" | "loop"): Promise<number[][]> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const compiled = plan();
  expect(compiled.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  // The claim needs the solid's pass BEFORE the bridge's kernel in the plan.
  const order = compiled.passes.map((pass) => ("nodeId" in pass ? pass.nodeId : undefined));
  expect(order.indexOf("tex")).toBeLessThan(order.indexOf("bridge"));

  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((d) => {
    if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
  });
  try {
    await backend.initialize({});
    const program = await backend.compile(compiled);
    const render = (): void =>
      backend.render(program, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SIZE, SIZE],
      });
    if (path === "direct") {
      render();
    } else {
      // One tick of the backend's own loop: the app's path, ONE frame open around the render.
      let rendered = false;
      const control = backend.loop(() => {
        if (rendered) return;
        rendered = true;
        render();
      });
      await until(() => rendered, "loop tick");
      control.stop();
    }
    const samples = new Float32Array(await backend.readBuffer(pointStorageId("bridge")));
    expect(errors).toEqual([]);
    return Array.from({ length: POINTS }, (_, point) => Array.from(samples.subarray(point * 4, point * 4 + 4)));
  } finally {
    backend.dispose();
  }
}

describe("a kernel reads the texture its own frame rendered (§T1707b, §V168)", () => {
  for (const path of ["direct", "loop"] as const) {
    it(`${path} path: the bridge samples the solid on the first frame, not an unrendered texture`, async () => {
      expect(await firstFrameSamples(path)).toEqual(Array.from({ length: POINTS }, () => [0, 1, 0, 1]));
    }, 120_000);
  }
});
