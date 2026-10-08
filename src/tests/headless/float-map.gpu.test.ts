import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { DEFAULT_PROJECT_SETTINGS, type GraphDocument } from "../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { floatMapSourceIdFor } from "../../nodes/definitions/float-map-in.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { PHOTO_MAPPING_SHADER } from "../../app/photo-mapping-effects.ts";
import { readChannels, srgbToLinear } from "../../runtime/export/pixel-format.ts";
import { createDomainBus } from "../../domain/commands/index.ts";
import { registerPhotoMappingCommands } from "../../domain/commands/photo-mapping-commands.ts";
import { alice, contextFor } from "../../domain/commands/test-support.ts";
import { createFileReference } from "../../domain/media/file-reference.ts";
import { SINK_TARGET_PORT } from "../../compiler/resources.ts";

const SIZE = 8;
const SOURCE = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var inputTexture1: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let pixel = vec2i(uv * vec2f(textureDimensions(inputTexture1)));
  let depth = textureLoad(inputTexture1, pixel, 0).r;
  return vec4f(depth * color.r, 0.0, 0.0, 1.0);
}`;

function document(): GraphDocument {
  return {
    revision: 1, groups: {},
    nodes: {
      map: { id: "map", type: "floatMapIn", definitionVersion: 1, label: "floatmap_depth", position: { x: 0, y: 0 }, parameters: { interpretation: "raw" } },
      white: { id: "white", type: "solid", definitionVersion: 1, label: "solid_white", position: { x: 250, y: 0 }, parameters: { color: [1, 1, 1, 1] } },
      mask: { id: "mask", type: "mask", definitionVersion: 1, label: "mask_surface", position: { x: 500, y: 0 }, parameters: { channel: "red", apply: "colour" }, format: { mode: "fixed", format: "r32float" } },
      multi: { id: "multi", type: "customWgslMulti", definitionVersion: 1, label: "wgsl_relief", position: { x: 500, y: 250 }, parameters: { source: SOURCE }, format: { mode: "fixed", format: "r32float" } },
    },
    edges: {
      picture: { id: "picture", source: { nodeId: "white", portId: "out" }, target: { nodeId: "mask", portId: "input" } },
      coverage: { id: "coverage", source: { nodeId: "map", portId: "out" }, target: { nodeId: "mask", portId: "mask" } },
      effectPicture: { id: "effectPicture", source: { nodeId: "white", portId: "out" }, target: { nodeId: "multi", portId: "input" } },
      effectDepth: { id: "effectDepth", source: { nodeId: "map", portId: "out" }, target: { nodeId: "multi", portId: "more" } },
    },
  };
}

describe("float32 prepared maps on the real backend", () => {
  it("retains sub-half-float differences through upload, blit, Mask and Custom WGSL Multi", async () => {
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: unknown[] = [];
    backend.onDiagnostic(diagnostic => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const plan = compileGraph({ graph: document(), registry: createNodeRegistry(allNodeDefinitions).view(), capabilities,
        settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: SIZE, height: SIZE }, workingFormat: "rgba16float" },
        sinks: ["map", "mask", "multi"].map(nodeId => ({ nodeId, portId: "out", kind: "readback" })),
      });
      expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
      const values = new Float32Array(SIZE * SIZE);
      for (let index = 0; index < values.length; index++) values[index] = 0.5001 + (index % SIZE) * 2 ** -23 + Math.floor(index / SIZE) * 0.01;
      expect(values[0]).not.toBe(values[1]);
      const compiled = await backend.compile(plan);
      backend.registerMediaSource(floatMapSourceIdFor("map"), { currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true });
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 30, frameIndex: 0, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [SIZE, SIZE],
      });
      for (const nodeId of ["map", "mask", "multi"]) {
        const output = plan.outputs.find(entry => entry.nodeId === nodeId && entry.portId === "out");
        if (output === undefined) throw new Error(`Missing ${nodeId} output`);
        expect(output.format).toBe("r32float");
        const image = await backend.readOutput(output.resourceId);
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        const actual = new Float32Array(SIZE * SIZE);
        for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) actual[y * SIZE + x] = view.getFloat32(y * image.rowStride + x * 4, true);
        expect(actual, nodeId).toEqual(values);
      }
      expect(diagnostics).toEqual([]);
    } finally { backend.dispose(); }
  }, 60_000);

  it.each([{ name: "dark", colour: [0.08, 0.12, 0.18, 1], masked: true, effect: 1 },
    { name: "white", colour: [1, 1, 1, 1], masked: true, effect: 1 },
    ...[0, 1, 2, 3, 4].map(effect => ({ name: `full frame effect ${effect}`, colour: [0.08, 0.12, 0.18, 1], masked: false, effect }))])(
    "renders the generated $name photo previz into the main Output without opening a projector or requesting a display sink", async ({ colour, masked, effect }) => {
    const width = 32;
    const height = 24;
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: unknown[] = [];
    backend.onDiagnostic(diagnostic => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const registry = createNodeRegistry(allNodeDefinitions).view();
      const { bus, store } = createDomainBus({ registry, initialSettings: {
        ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width, height }, workingFormat: "rgba16float",
        colorPolicy: { workingSpace: "linear", displayTransform: "none" },
      } });
      registerPhotoMappingCommands(bus);
      const result = await bus.execute("photoMapping.create", {
        photo: createFileReference("photo", "image", "surface.png"),
        depth: createFileReference("depth", "binary", "depth.loomf32"),
        ...(masked ? { mask: createFileReference("mask", "binary", "mask.loomf32") } : {}),
        width, height, shader: PHOTO_MAPPING_SHADER, effect,
      }, contextFor(alice));
      expect(result.status).toBe("applied");
      expect(result.diagnostics).toEqual([]);
      const ids = result.output.createdIds;
      const graph = structuredClone(store.view.getGraph());
      // Isolate media decoding: keep the factory's graph and supply a known photograph.
      const photo = graph.nodes[ids.$photo!]!;
      photo.type = "solid";
      photo.parameters = { color: colour };
      const plan = compileGraph({ graph, registry, capabilities, settings: store.view.getSettings() });
      expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
      expect(plan.outputs.some(output => output.nodeId === ids.$window)).toBe(false);
      const output = plan.outputs.find(entry => entry.nodeId === ids.$output && entry.portId === SINK_TARGET_PORT);
      if (output === undefined) throw new Error("Missing generated main Output target");
      const compiled = await backend.compile(plan);
      const depth = new Float32Array(width * height);
      const mask = new Float32Array(width * height);
      for (let index = 0; index < depth.length; index++) {
        depth[index] = 0.1 + (index % width) / width * 0.8;
        mask[index] = index % width < width / 2 ? 0 : 1;
      }
      for (const [ref, values] of [["$depth", depth], ["$mask", mask]] as const) {
        if (ref === "$mask" && !masked) continue;
        backend.registerMediaSource(floatMapSourceIdFor(ids[ref]!), {
          currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true,
        });
      }
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 30, frameIndex: 0, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height],
      });
      const photoOutput = plan.outputs.find(entry => entry.nodeId === ids.$reference && entry.portId === "out");
      const coverageOutput = plan.outputs.find(entry => entry.nodeId === ids.$coverage && entry.portId === "out");
      if (photoOutput === undefined || coverageOutput === undefined) throw new Error("Missing generated previz inputs");
      const reference = await backend.readOutput(photoOutput.resourceId);
      const projection = await backend.readOutput(coverageOutput.resourceId);
      const preview = await backend.readOutput(output.resourceId);
      const views = [reference, projection, preview].map(image => new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength));
      const channels = [new Float32Array(4), new Float32Array(4), new Float32Array(4)];
      let strongestEffect = 0;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        for (const [index, image] of [reference, projection, preview].entries()) {
          expect(image.format).toBe("rgba16float");
          readChannels(image.bytes, views[index]!, y * image.rowStride + x * 8, image.format, channels[index]!);
        }
        for (let channel = 0; channel < 3; channel++) {
          if (masked && x < width / 2) {
            expect(channels[1]![channel]).toBeCloseTo(0, 5);
            expect(channels[2]![channel]).toBeCloseTo(channels[0]![channel]!, 3);
          } else {
            strongestEffect = Math.max(strongestEffect, channels[2]![channel]! - channels[0]![channel]!);
          }
          expect(Number.isFinite(channels[2]![channel])).toBe(true);
          expect(channels[0]![channel]).toBeCloseTo(srgbToLinear(colour[channel]!) * 0.65, 3);
          // Screen's light opacity scales the effect; the photograph remains its backdrop.
          expect(channels[2]![channel]).toBeCloseTo(1 - (1 - channels[1]![channel]! * 0.35) * (1 - channels[0]![channel]!), 3);
        }
        expect(channels[0]![3]).toBeCloseTo(1, 3);
        expect(channels[2]![3]).toBeCloseTo(1, 3);
      }
      expect(strongestEffect).toBeGreaterThan(0.02);
      expect(diagnostics).toEqual([]);
    } finally { backend.dispose(); }
  }, 60_000);

  it("traces the real concave surface and its hole instead of drawing a frame around the image", async () => {
    const size = 64;
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      const capabilities = await backend.initialize({});
      const graph = document();
      graph.nodes["multi"]!.parameters = { source: PHOTO_MAPPING_SHADER, mode: 3, bands: 1, edgeWidth: 3 / size, edgeGlow: 1.2 };
      delete graph.nodes["multi"]!.format;
      delete graph.nodes["mask"]!.format;
      graph.nodes["coverage"] = { id: "coverage", type: "floatMapIn", definitionVersion: 1, label: "floatmap_surface", position: { x: 0, y: 250 }, parameters: { interpretation: "raw" } };
      graph.edges["effectDepth"]!.order = 0;
      graph.edges["effectMask"] = { id: "effectMask", source: { nodeId: "coverage", portId: "out" }, target: { nodeId: "multi", portId: "more" }, order: 1 };
      graph.edges["coverage"]!.source = { nodeId: "coverage", portId: "out" };
      graph.edges["picture"]!.source = { nodeId: "multi", portId: "out" };
      const plan = compileGraph({ graph, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities,
        settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width: size, height: size }, workingFormat: "rgba16float" },
        sinks: [{ nodeId: "mask", portId: "out", kind: "readback" }],
      });
      expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
      const depth = new Float32Array(size * size).fill(0.4);
      const coverage = new Float32Array(size * size);
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        coverage[y * size + x] = (x - 32) ** 2 + (y - 32) ** 2 < 26 ** 2
          && (x - 37) ** 2 + (y - 28) ** 2 >= 10 ** 2 && !(x > 42 && y < 18) ? 1 : 0;
      }
      const compiled = await backend.compile(plan);
      for (const [nodeId, values] of [["map", depth], ["coverage", coverage]] as const) {
        backend.registerMediaSource(floatMapSourceIdFor(nodeId), { currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true });
      }
      const output = plan.outputs.find(entry => entry.nodeId === "mask" && entry.portId === "out");
      const effectPass = plan.passes.find(pass => pass.kind === "effect" && pass.nodeId === "multi");
      if (output === undefined || effectPass === undefined) throw new Error("Missing traced surface output");
      async function render() {
        backend.render(compiled, { frame: { timeSeconds: 0, deltaSeconds: 1 / 30, frameIndex: 0, mode: "offline", randomSeed: 1 },
          pointer: { x: 0, y: 0, buttons: 0 }, resolution: [size, size] });
        const image = await backend.readOutput(output!.resourceId);
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        return (x: number, y: number) => {
          const pixel = new Float32Array(4);
          readChannels(image.bytes, view, y * image.rowStride + x * 8, image.format, pixel);
          return pixel;
        };
      }
      const traced = await render();
      backend.updateUniforms({ passId: effectPass.id, values: { edgeGlow: 0 } });
      const plain = await render();
      for (const [x, y] of [[32, 7], [27, 28], [42, 17]]) {
        expect(coverage[y! * size + x!]).toBe(1);
        const boost = traced(x!, y!).slice(0, 3).map((value, channel) => value - plain(x!, y!)[channel]!);
        expect(Math.max(...boost), `Surface boundary at ${x},${y}`).toBeGreaterThan(0.2);
      }
      expect(traced(16, 32)).toEqual(plain(16, 32));
      for (const [x, y] of [[0, 0], [1, 32], [37, 28], [46, 16]]) {
        expect(coverage[y! * size + x!]).toBe(0);
        expect(traced(x!, y!).every(value => value < 0.00001)).toBe(true);
      }
      // A mask covering the complete photograph still ends at the image boundary.
      coverage.fill(1);
      backend.registerMediaSource(floatMapSourceIdFor("coverage"), {
        currentFrame: () => ({ frameId: 2, bytes: new Uint8Array(coverage.buffer) }), ended: true,
      });
      const fullPlain = await render();
      backend.updateUniforms({ passId: effectPass.id, values: { edgeGlow: 1.2 } });
      const fullTraced = await render();
      for (const [x, y] of [[0, 32], [32, 0]]) {
        const boost = fullTraced(x!, y!).slice(0, 3).map((value, channel) => value - fullPlain(x!, y!)[channel]!);
        expect(Math.max(...boost), "Full-image mask ends at the photograph boundary").toBeGreaterThan(0.2);
      }
      expect(fullTraced(16, 32)).toEqual(fullPlain(16, 32));
    } finally { backend.dispose(); }
  }, 60_000);

  it("uses reference architecture independently of photo mixing in five distinct effects without changing depth or coverage", async () => {
    const width = 320;
    const height = 200;
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: unknown[] = [];
    backend.onDiagnostic(diagnostic => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const graph = document();
      graph.nodes["white"]!.parameters = { color: [0.6, 0.5, 0.4, 1] };
      graph.nodes["facade"] = { id: "facade", type: "customWgsl", definitionVersion: 1, label: "wgsl_facade",
        position: { x: 250, y: 250 }, parameters: { source: `
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let p = uv * vec2f(320.0, 200.0);
  let pilaster = (p.x >= 40.0 && p.x < 52.0) || (p.x >= 260.0 && p.x < 272.0);
  let cornice = (p.y >= 30.0 && p.y < 38.0) || (p.y >= 162.0 && p.y < 170.0);
  let windowCell = p - vec2f(70.0, 52.0);
  let local = windowCell % vec2f(46.0, 34.0);
  let window = all(windowCell >= vec2f(0.0)) && all(windowCell < vec2f(184.0, 102.0))
    && all(local < vec2f(30.0, 22.0));
  let mullion = window && (abs(local.x - 15.0) < 1.0 || abs(local.y - 11.0) < 1.0);
  var colour = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  if (window) { colour = vec3f(0.025, 0.055, 0.09); }
  if (pilaster || cornice || mullion) { colour = vec3f(0.9, 0.85, 0.7); }
  return vec4f(colour, 1.0);
}` } };
      graph.nodes["multi"]!.parameters = { source: PHOTO_MAPPING_SHADER, photoAmount: 0 };
      delete graph.nodes["multi"]!.format;
      delete graph.nodes["mask"]!.format;
      graph.nodes["flatEffect"] = { ...structuredClone(graph.nodes["multi"]!), id: "flatEffect", label: "wgsl_flat",
        position: { x: 750, y: 250 } };
      graph.nodes["coverage"] = { id: "coverage", type: "floatMapIn", definitionVersion: 1, label: "floatmap_surface",
        position: { x: 0, y: 250 }, parameters: { interpretation: "raw" } };
      graph.edges["effectPicture"]!.source = { nodeId: "facade", portId: "out" };
      graph.edges["facadeInput"] = { id: "facadeInput", source: { nodeId: "white", portId: "out" }, target: { nodeId: "facade", portId: "input" } };
      graph.edges["effectDepth"]!.order = 0;
      graph.edges["effectMask"] = { id: "effectMask", source: { nodeId: "coverage", portId: "out" },
        target: { nodeId: "multi", portId: "more" }, order: 1 };
      graph.edges["flatPicture"] = { id: "flatPicture", source: { nodeId: "white", portId: "out" }, target: { nodeId: "flatEffect", portId: "input" } };
      graph.edges["flatDepth"] = { id: "flatDepth", source: { nodeId: "map", portId: "out" }, target: { nodeId: "flatEffect", portId: "more" }, order: 0 };
      graph.edges["flatMask"] = { id: "flatMask", source: { nodeId: "coverage", portId: "out" }, target: { nodeId: "flatEffect", portId: "more" }, order: 1 };
      graph.edges["coverage"]!.source = { nodeId: "coverage", portId: "out" };
      graph.edges["picture"]!.source = { nodeId: "multi", portId: "out" };
      const plan = compileGraph({ graph, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities,
        settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width, height }, workingFormat: "rgba16float" },
        sinks: ["facade", "multi", "flatEffect", "mask", "map", "coverage"].map(nodeId => ({ nodeId, portId: "out", kind: "readback" })),
      });
      expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
      const depth = new Float32Array(width * height).fill(0.4);
      const coverage = new Float32Array(width * height).fill(1);
      const compiled = await backend.compile(plan);
      for (const [nodeId, values] of [["map", depth], ["coverage", coverage]] as const) {
        backend.registerMediaSource(floatMapSourceIdFor(nodeId), { currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true });
      }
      async function pixels(nodeId: string): Promise<Float32Array> {
        const output = plan.outputs.find(entry => entry.nodeId === nodeId && entry.portId === "out");
        if (output === undefined) throw new Error(`Missing ${nodeId} architecture output`);
        const image = await backend.readOutput(output.resourceId);
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        const pixel = new Float32Array(4);
        const result = new Float32Array(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          readChannels(image.bytes, view, y * image.rowStride + x * (image.format === "r32float" ? 4 : 8), image.format, pixel);
          result.set(pixel, (y * width + x) * 4);
        }
        return result;
      }
      function render() {
        backend.render(compiled, { frame: { timeSeconds: 6, deltaSeconds: 1 / 30, frameIndex: 180, mode: "offline", randomSeed: 1 },
          pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height] });
      }
      const passes = ["multi", "flatEffect"].map(nodeId => {
        const pass = plan.passes.find(entry => entry.kind === "effect" && entry.nodeId === nodeId);
        if (pass === undefined) throw new Error(`Missing ${nodeId} architecture pass`);
        return pass;
      });
      const effects: Float32Array[] = [];
      const colourfulPixels: number[] = [];
      for (const mode of [0, 1, 2, 3, 4]) {
        // First render uses the shipped Architecture Detail default, with photo mixing disabled.
        for (const pass of passes) backend.updateUniforms({ passId: pass.id, values: { mode, ...(mode > 0 ? { architectureDetail: 0.85 } : {}) } });
        render();
        const detailed = await pixels("multi");
        const flatDetailed = await pixels("flatEffect");
        expect(await pixels("mask"), `Full coverage preserves effect ${mode}`).toEqual(detailed);
        expect(detailed.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
        effects.push(detailed);
        for (const pass of passes) backend.updateUniforms({ passId: pass.id, values: { architectureDetail: 0 } });
        render();
        const plain = await pixels("multi");
        expect(await pixels("flatEffect"), `Photo content cannot leak through Photo Amount 0 when detail is disabled, mode ${mode}`).toEqual(plain);
        expect(flatDetailed, `A flat reference has no architectural edges, mode ${mode}`).toEqual(plain);
        const facade = await pixels("facade");
        let accented = 0;
        let colourVariation = 0;
        let maximumAccent = 0;
        let strongestInteriorChange = 0;
        for (let y = 8; y < height - 8; y++) for (let x = 8; x < width - 8; x++) {
          const offset = (y * width + x) * 4;
          let difference = 0;
          for (let channel = 0; channel < 3; channel++) difference = Math.max(difference, Math.abs(detailed[offset + channel]! - plain[offset + channel]!));
          maximumAccent = Math.max(maximumAccent, difference);
          if (difference > 0.05) accented++;
          if (Math.max(...detailed.subarray(offset, offset + 3)) - Math.min(...detailed.subarray(offset, offset + 3)) > 0.1) colourVariation++;
          // A broad neighbourhood of the actual rendered reference identifies uniform wall/window
          // interiors without repeating the production derivative or pattern calculations.
          let referenceContrast = 0;
          for (let distance = 1; distance <= 5; distance++) {
            for (const [dx, dy] of [[-distance, 0], [distance, 0], [0, -distance], [0, distance]]) {
              const nearby = ((y + dy!) * width + x + dx!) * 4;
              for (let channel = 0; channel < 3; channel++) referenceContrast = Math.max(referenceContrast, Math.abs(facade[offset + channel]! - facade[nearby + channel]!));
            }
          }
          if (referenceContrast < 0.001) strongestInteriorChange = Math.max(strongestInteriorChange, difference);
        }
        expect(maximumAccent, `Architecture is visibly projected with constant depth, mode ${mode}`).toBeGreaterThan(0.15);
        expect(accented, `Architectural accents occupy visible pixels, mode ${mode}`).toBeGreaterThan(width * height * 0.02);
        expect(strongestInteriorChange, `Architectural accents stay near reference features, mode ${mode}`).toBeLessThan(0.002);
        colourfulPixels.push(colourVariation);
      }
      for (let a = 0; a < effects.length; a++) for (let b = a + 1; b < effects.length; b++) {
        let difference = 0;
        for (let offset = 0; offset < effects[a]!.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
          difference += Math.abs(effects[a]![offset + channel]! - effects[b]![offset + channel]!);
        }
        expect(difference / (width * height * 3), `Architecture modes ${a} and ${b} remain distinct`).toBeGreaterThan(0.04);
      }
      for (const [nodeId, values] of [["map", depth], ["coverage", coverage]] as const) {
        const actual = await pixels(nodeId);
        expect(values.every((value, index) => actual[index * 4] === value), `${nodeId} remains an unchanged scalar map`).toBe(true);
      }
      expect(Math.min(...colourfulPixels), `Colourful pixels per architecture mode: ${colourfulPixels.join(", ")}`).toBeGreaterThan(width * height * 0.1);
      expect(diagnostics).toEqual([]);
    } finally { backend.dispose(); }
  }, 60_000);

  it.each([0, 1, 2, 3, 4])("renders colourful, evolving photo-mapping effect %s through an unchanged scalar surface mask", async mode => {
    const width = 100;
    const height = 60;
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    const diagnostics: unknown[] = [];
    backend.onDiagnostic(diagnostic => diagnostics.push(diagnostic));
    try {
      const capabilities = await backend.initialize({});
      const graph = document();
      graph.nodes["multi"]!.parameters = { source: PHOTO_MAPPING_SHADER, mode };
      delete graph.nodes["multi"]!.format;
      delete graph.nodes["mask"]!.format;
      graph.nodes["coverage"] = { id: "coverage", type: "floatMapIn", definitionVersion: 1, label: "floatmap_surface", position: { x: 0, y: 250 }, parameters: { interpretation: "raw" } };
      graph.edges["effectDepth"]!.order = 0;
      graph.edges["effectMask"] = { id: "effectMask", source: { nodeId: "coverage", portId: "out" },
        target: { nodeId: "multi", portId: "more" }, order: 1 };
      graph.edges["coverage"]!.source = { nodeId: "coverage", portId: "out" };
      graph.edges["picture"]!.source = { nodeId: "multi", portId: "out" };
      const plan = compileGraph({ graph, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities,
        settings: { ...DEFAULT_PROJECT_SETTINGS, outputResolution: { width, height }, workingFormat: "rgba16float" },
        sinks: ["multi", "mask"].map(nodeId => ({ nodeId, portId: "out", kind: "readback" })),
      });
      expect(plan.ok, JSON.stringify(plan.diagnostics)).toBe(true);
      const values = new Float32Array(width * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        values[y * width + x] = 0.5 + 0.28 * Math.sin(x / width * Math.PI * 3)
          + 0.18 * Math.cos(y / height * Math.PI * 4);
      }
      const coverage = new Float32Array(width * height);
      for (let index = 0; index < coverage.length; index++) coverage[index] = index % width < width / 2 ? 0 : 1;
      const compiled = await backend.compile(plan);
      backend.registerMediaSource(floatMapSourceIdFor("map"), { currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true });
      backend.registerMediaSource(floatMapSourceIdFor("coverage"), { currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(coverage.buffer) }), ended: true });
      async function pixels(nodeId: string): Promise<Float32Array> {
        const output = plan.outputs.find(entry => entry.nodeId === nodeId && entry.portId === "out");
        if (output === undefined) throw new Error(`Missing ${nodeId} photo effect output`);
        const image = await backend.readOutput(output.resourceId);
        expect(image.format).toBe("rgba16float");
        const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
        const pixel = new Float32Array(4);
        const result = new Float32Array(width * height * 4);
        for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
          readChannels(image.bytes, view, y * image.rowStride + x * 8, image.format, pixel);
          result.set(pixel, (y * width + x) * 4);
        }
        return result;
      }
      async function render(time: number): Promise<Float32Array> {
        backend.render(compiled, {
          frame: { timeSeconds: time, deltaSeconds: 1 / 30, frameIndex: Math.round(time * 30), mode: "offline", randomSeed: 1 },
          pointer: { x: 0, y: 0, buttons: 0 }, resolution: [width, height],
        });
        const effect = await pixels("multi");
        const masked = await pixels("mask");
        expect(effect.every(value => Number.isFinite(value) && value >= 0 && value <= 1)).toBe(true);
        let colourful = 0;
        let bright = 0;
        for (let index = 0; index < width * height; index++) {
          const offset = index * 4;
          const rgb = effect.subarray(offset, offset + 3);
          if (Math.max(...rgb) - Math.min(...rgb) > 0.1) colourful++;
          if (Math.max(...rgb) > 0.25) bright++;
          // Coverage survives within half-float filtering precision, including alpha.
          for (let channel = 0; channel < 4; channel++) {
            if (index % width < width / 2) {
              expect(masked[offset + channel]).toBeCloseTo(0, 5);
            } else {
              expect(masked[offset + channel]).toBeCloseTo(effect[offset + channel]!, 3);
            }
          }
        }
        expect(colourful).toBeGreaterThan(width * height * 0.1);
        expect(bright).toBeGreaterThan(width * height * 0.05);
        return effect;
      }
      const first = await render(0);
      let evolved = first;
      for (const time of [3, 33, 90]) {
        const later = await render(time);
        let difference = 0;
        for (let index = 0; index < later.length; index++) difference += Math.abs(later[index]! - first[index]!);
        expect(difference / later.length, `Motion/evolution at ${time}s`).toBeGreaterThan(0.02);
        evolved = later;
      }
      expect(await render(0)).toEqual(first);
      const effectPass = plan.passes.find(pass => pass.kind === "effect" && pass.nodeId === "multi");
      if (effectPass === undefined) throw new Error("Missing photo effect uniform pass");
      backend.updateUniforms({ passId: effectPass.id, values: { evolution: 0 } });
      const unevolved = await render(90);
      let evolutionDifference = 0;
      for (let index = 0; index < evolved.length; index++) evolutionDifference += Math.abs(evolved[index]! - unevolved[index]!);
      expect(evolutionDifference / evolved.length, "Slow evolution changes the effect independently of motion").toBeGreaterThan(0.01);
      backend.updateUniforms({ passId: effectPass.id, values: { speed: 0 } });
      expect(await render(90)).toEqual(await render(3));
      expect(diagnostics).toEqual([]);
    } finally { backend.dispose(); }
  }, 60_000);
});
