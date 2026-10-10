import { describe, expect, it } from "vitest";
import { compileGraph } from "../../../compiler/compile.ts";
import type { BackendCapabilities } from "../../../domain/types/backend.ts";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument } from "../../../domain/types/graph.ts";
import type { ParameterValue } from "../../../domain/types/parameters.ts";
import { allNodeDefinitions, mediaSourceIdFor } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { nodeGpuHost } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

async function framingFixture(sourceWidth: number, sourceHeight: number, pixels: Uint8Array) {
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  await backend.initialize({});
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const capabilities: BackendCapabilities = {
    tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float"],
    timestampQuery: false, limits: { maxTextureDimension2D: 8192 },
  };
  let frameIndex = 0;
  return {
    dispose: () => backend.dispose(),
    async render(parameters: Record<string, ParameterValue>) {
      const graph: GraphDocument = {
        revision: 1, groups: {}, edges: {}, nodes: Object.fromEntries(["reference", "untouched"].map(id => [id, {
          id, label: `movie_${id}`, type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 },
          parameters: { imageFit: "fill", ...(id === "reference" ? parameters : {}) },
          resolution: { mode: "fixed", width: 16, height: 16 }, format: { mode: "fixed", format: "rgba8unorm" },
        }])),
      };
      const plan = compileGraph({ graph, registry, capabilities,
        settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: 16, height: 16 } },
        sinks: [{ nodeId: "reference", kind: "readback" }, { nodeId: "untouched", kind: "readback" }],
      });
      expect(plan.diagnostics.filter(diagnostic => diagnostic.severity === "error")).toEqual([]);
      const resources = plan.resources.map(resource => resource.kind === "externalTexture"
        ? { ...resource, size: [sourceWidth, sourceHeight] } : resource);
      const compiled = await backend.compile({ ...plan, resources });
      for (const id of ["reference", "untouched"]) {
        backend.registerMediaSource(mediaSourceIdFor(id), { currentFrame: () => ({ frameId: frameIndex + 1, bytes: pixels }) });
      }
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 30, frameIndex: frameIndex++, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [16, 16],
      });
      const reference = await backend.readOutput("target:reference:out");
      const untouched = await backend.readOutput("target:untouched:out");
      return { reference: reference.bytes, untouched: untouched.bytes };
    },
  };
}

const pixelAt = (bytes: Uint8Array, x: number, y: number) => [...bytes.slice((y * 16 + x) * 4, (y * 16 + x + 1) * 4)];

// Tiny rendered frames exercise actual WGSL without a browser or animation loop.
describe("media fit keeps the full source independently of output resolution", () => {
  it("moves a portrait fill crop to the top or bottom of the selected reference only", async () => {
    const pixels = new Uint8Array(16 * 32 * 4);
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 16; x++) {
        pixels.set(y < 4 ? [255, 0, 0, 255] : y >= 28 ? [0, 255, 0, 255] : [0, 0, 255, 255], (y * 16 + x) * 4);
      }
    }
    const fixture = await framingFixture(16, 32, pixels);
    try {
      const centered = await fixture.render({});
      expect(pixelAt(centered.reference, 8, 0)).toEqual([0, 0, 255, 255]);
      expect(pixelAt(centered.reference, 8, 15)).toEqual([0, 0, 255, 255]);
      const top = await fixture.render({ imageAnchorY: 0 });
      expect(pixelAt(top.reference, 8, 0)).toEqual([255, 0, 0, 255]);
      expect(pixelAt(top.reference, 8, 15)).toEqual([0, 0, 255, 255]);
      const bottom = await fixture.render({ imageAnchorY: 1 });
      expect(pixelAt(bottom.reference, 8, 0)).toEqual([0, 0, 255, 255]);
      expect(pixelAt(bottom.reference, 8, 15)).toEqual([0, 255, 0, 255]);
      expect(top.untouched).toEqual(centered.untouched);
      expect(bottom.untouched).toEqual(centered.untouched);
      expect(top.reference).not.toEqual(bottom.reference);
    } finally { fixture.dispose(); }
  });

  it("zooms and pans a landscape reference while preserving other images and default framing bytes", async () => {
    const pixels = new Uint8Array(32 * 16 * 4);
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 32; x++) {
        pixels.set(x < 4 ? [255, 0, 0, 255] : x >= 28 ? [0, 255, 0, 255] : [0, 0, 255, 255], (y * 32 + x) * 4);
      }
    }
    const fixture = await framingFixture(32, 16, pixels);
    try {
      const defaults = await fixture.render({});
      const explicitDefaults = await fixture.render({ imageAnchorX: 0.5, imageAnchorY: 0.5, imageZoom: 1 });
      expect(explicitDefaults.reference).toEqual(defaults.reference);
      const left = await fixture.render({ imageAnchorX: 0, imageZoom: 2 });
      expect(pixelAt(left.reference, 3, 8)).toEqual([255, 0, 0, 255]);
      expect(pixelAt(left.reference, 12, 8)).toEqual([0, 0, 255, 255]);
      const right = await fixture.render({ imageAnchorX: 1, imageZoom: 2 });
      expect(pixelAt(right.reference, 3, 8)).toEqual([0, 0, 255, 255]);
      expect(pixelAt(right.reference, 12, 8)).toEqual([0, 255, 0, 255]);
      expect(left.reference).not.toEqual(defaults.reference);
      expect(right.reference).not.toEqual(defaults.reference);
      expect(left.untouched).toEqual(defaults.untouched);
      expect(right.untouched).toEqual(defaults.untouched);
      for (let pixel = 0; pixel < 16 * 16; pixel++) {
        expect(left.reference[pixel * 4 + 3]).toBe(255);
        expect(right.reference[pixel * 4 + 3]).toBe(255);
      }
    } finally { fixture.dispose(); }
  });

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
