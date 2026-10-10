import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";
import { arePortsCompatible } from "../../../domain/graph/port-compat.ts";
import { floatMapInNode, floatMapSourceIdFor } from "../../../nodes/definitions/float-map-in.ts";
import { pointKernelNode } from "../../../nodes/definitions/points.ts";
import { DATA_TEXTURE, RGBA_TEXTURE } from "../../../nodes/definitions/common-ports.ts";
import { readKernelAttribute } from "../../../nodes/definitions/test-support.ts";
import { frameFromClock } from "../../../domain/types/frame.ts";

/**
 * T477 on a REAL device, answered as §V361 demands — what differs if the edge is cut?
 * A kernel advects its points by `fieldAt(...)`; the same graph with a zero field must
 * move nothing. Rendered twice and compared as BYTES, because "the pass compiled" says
 * nothing about whether the texture read reaches the position write.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

function advectionGraph(fieldColor: readonly number[]): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("flow", "solid", { color: fieldColor }),
        node("sim", "pointKernel", {
          capacity: 16,
          seed: 7,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          ]),
          kernel:
            "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  /* The field IS the velocity: red drives +x. */\n  q.position += vec3f(fieldAt(p.position).r, 0.0, 0.0) * 0.1;\n  return q;\n}",
        }),
        node("draw", "renderPoints", { count: 16, sizePixels: 12 }),
        node("out", "output", {}),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "flow", portId: "out" }, target: { nodeId: "sim", portId: "field" } },
      e2: { id: "e2", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

describe("fieldAt advects points on Dawn (T477, §V361)", () => {
  it("accepts numerical depth and existing colour sources through one data field contract", () => {
    const field = pointKernelNode.inputs.find(input => input.id === "field");
    if (field === undefined) throw new Error("Point Kernel must expose its field input");
    expect(field.type).toEqual(DATA_TEXTURE);
    expect(arePortsCompatible(floatMapInNode.outputs[0]!.type, field.type)).toBe(true);
    expect(arePortsCompatible(RGBA_TEXTURE, field.type)).toBe(true);
  });

  it("reads r32float depth directly into exact point positions without colour transfer", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const base = advectionGraph([0, 0, 0, 1]);
    const graph: GraphDocument = { ...base, nodes: { ...base.nodes,
      flow: { id: "flow", label: "float_depth", type: "floatMapIn", definitionVersion: 1,
        position: { x: 0, y: 0 }, parameters: { file: "registered-depth.loomf32", interpretation: "raw" },
        resolution: { mode: "fixed", width: 4, height: 4 } },
      sim: { ...base.nodes["sim"]!, label: "kernel_measurement", parameters: { ...base.nodes["sim"]!.parameters,
        kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let u = f32(ctx.index % 4u) / 3.0;
  let v = f32(ctx.index / 4u) / 3.0;
  let sample = fieldAt(vec3f(u * 2.0 - 1.0, 1.0 - v * 2.0, 0.0));
  q.position = sample.rgb;
  return q;
}` } },
    } };
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: {
      tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
      timestampQuery: false, limits: { maxTextureDimension2D: 8192 },
    } });
    expect(plan.diagnostics.filter(diagnostic => diagnostic.severity !== "info")).toEqual([]);
    const values = new Float32Array([0.123456791, 0.5000000596, 0.9999998808, -0.0312500037,
      0.234567896, 0.6000000238, 0.3000000119, 1.0000001192,
      0.345678925, 0.7000000477, 0.4000000059, -0.1000000089,
      0.456789106, 0.8000000119, 0.2000000179, 0.9000000357]);
    const before = new Uint32Array(values.buffer).slice();
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    let release: (() => void) | undefined;
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      release = backend.registerMediaSource(floatMapSourceIdFor("flow"), {
        currentFrame: () => ({ frameId: 1, bytes: new Uint8Array(values.buffer) }), ended: true,
      });
      backend.render(compiled, { frame: frameFromClock({ timeSeconds: 0, deltaSeconds: 1 / 60,
        frameIndex: 0, mode: "offline", randomSeed: 7, fps: 60 }),
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64] });
      const positions = (await readKernelAttribute(backend.readBuffer, graph.nodes["sim"]!, "sim", "position")).floats;
      for (let index = 0; index < values.length; index++) {
        expect(positions[index * 4], `raw red sample ${index}`).toBe(values[index]);
        expect(positions[index * 4 + 1]).toBe(0);
        expect(positions[index * 4 + 2]).toBe(0);
      }
      expect(new Uint32Array(values.buffer)).toEqual(before);
    } finally { release?.(); backend.dispose(); }
  }, 120_000);

  it("a red field moves the sprites; a black field is the cut — bytes differ", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();

    const render = async (fieldColor: readonly number[]): Promise<Uint8Array> => {
      const plan = compileGraph({
        graph: advectionGraph(fieldColor),
        settings: SETTINGS,
        registry,
        capabilities: {
          tier: "B",
          features: [],
          formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
          timestampQuery: false,
          limits: { maxTextureDimension2D: 8192 },
        } as never,
      });
      expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
      const backend = createVgpuBackend({ host: nodeGpuHost() });
      try {
        await backend.initialize({});
        const compiled = await backend.compile(plan);
        for (let frame = 0; frame < 4; frame += 1) {
          backend.render(compiled, {
            frame: { timeSeconds: frame / 60, deltaSeconds: 1 / 60, frameIndex: frame, mode: "offline", randomSeed: 7 },
            pointer: { x: 0, y: 0, buttons: 0 },
            resolution: [64, 64],
          });
        }
        const image = await backend.readOutput("target:draw:out");
        return image.bytes;
      } finally {
        backend.dispose();
      }
    };

    const driven = await render([1, 0, 0, 1]);
    const cut = await render([0, 0, 0, 1]);
    // Both drew SOMETHING — a pair of blank frames trivially agrees.
    expect(driven.some((byte) => byte !== 0)).toBe(true);
    expect(cut.some((byte) => byte !== 0)).toBe(true);
    // §V361: the field is load-bearing — cut it and the picture changes.
    expect(Buffer.compare(Buffer.from(driven), Buffer.from(cut))).not.toBe(0);
  }, 120_000);
});
