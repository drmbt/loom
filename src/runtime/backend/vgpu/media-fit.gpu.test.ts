import { describe, expect, it } from "vitest";
import { compileGraph } from "../../../compiler/compile.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument } from "../../../domain/types/graph.ts";
import { allNodeDefinitions, mediaSourceIdFor } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

// Three tiny rendered frames. Exercise actual WGSL without a running browser/animation loop.
describe("media fit keeps the full source independently of output resolution", () => {
  it.each(["fit", "fill", "stretch"])("renders %s as actual pixels", async imageFit => {
    const graph: GraphDocument = {
      revision: 1, groups: {}, edges: {},
      nodes: {
        movie: {
          id: "movie", type: "movieFileIn", definitionVersion: 1,
          position: { x: 0, y: 0 }, parameters: { imageFit },
          resolution: { mode: "fixed", width: 16, height: 16 },
          format: { mode: "fixed", format: "rgba8unorm" },
        },
      },
    };
    const capabilities: BackendCapabilities = {
      tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float"],
      timestampQuery: false, limits: { maxTextureDimension2D: 8192 },
    };
    const plan = compileGraph({
      graph, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities,
      settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: 16, height: 16 } },
      sinks: [{ nodeId: "movie", kind: "readback" }],
    });
    // Byte producers declare their extent in the plan. Browser image producers provide
    // intrinsic dimensions; external-image-size.test.ts proves that allocation seam.
    const resources = plan.resources.map(resource => resource["kind"] === "externalTexture"
      ? { ...resource, size: [32, 16] } : resource);
    const pixels = new Uint8Array(32 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 32; x++) {
        const color = x < 4 ? [255, 0, 0, 255] : x >= 28 ? [0, 255, 0, 255] : [0, 0, 255, 255];
        pixels.set(color, (y * 32 + x) * 4);
      }
    }
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile({ ...plan, resources });
      backend.registerMediaSource(mediaSourceIdFor("movie"), { currentFrame: () => ({ frameId: 1, bytes: pixels }) });
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 30, frameIndex: 0, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [16, 16],
      });
      const output = await backend.readOutput("target:movie:out");
      const at = (x: number, y: number) => [...output.bytes.slice((y * 16 + x) * 4, (y * 16 + x + 1) * 4)];
      if (imageFit === "fill") {
        expect(at(0, 8)).toEqual([0, 0, 255, 255]);
        expect(at(15, 8)).toEqual([0, 0, 255, 255]);
      } else {
        // Both outer source edges survive: an upper-left upload crop fails the right edge.
        expect(at(0, 8)).toEqual([255, 0, 0, 255]);
        expect(at(15, 8)).toEqual([0, 255, 0, 255]);
      }
      expect(at(0, 0)[3]).toBe(imageFit === "fit" ? 0 : 255);
    } finally {
      backend.dispose();
    }
  });
});
