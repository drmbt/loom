import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { CompilerDiagnosticCode } from "../../compiler/diagnostics.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { decodeHalf } from "../../tests/headless/pixel-compare.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { hashLotReference } from "../shaders/shared-modules.ts";
import { allNodeDefinitions } from "./index.ts";
import { readKernelAttribute } from "./test-support.ts";

/**
 * B263 — `hashLot(h, n)` IS THE SAME LOT ON THE GPU AS ON THE CPU.
 *
 * The helper exists because the obvious line is wrong on Apple GPUs: `(h >> 16u) % 97u`
 * returned 63993 where the CPU says 9 (`docs/apple-gpu-divide-high-half-2026-10-06.md`).
 * A helper that replaces it is worth exactly as much as its agreement with the CPU, on the
 * device and in both stages, since the wrong line was wrong in both.
 *
 * 512 hashes, through the real compiler and backend:
 *
 *  - COMPUTE: a Point Kernel of 512 points draws six lots a point;
 *  - FRAGMENT: a Custom WGSL of 32 × 16 pixels draws three lots a pixel.
 *
 * The hashes are (i + 1) × 2654435761, which fills the high half, and for the first four
 * i × 0x55555555, which is 0, a third, two thirds and the whole of the range. n is a
 * literal (97, 100, 1024), the largest the helper takes (65536), the smallest (1), and a
 * value the shader cannot know (a parameter, and one that differs per pixel). Every lot is a
 * whole number that an f32 or a half float holds exactly, so the claims are equalities.
 */

const POINTS = 512;
const WIDTH = 32;
const HEIGHT = 16;

/** Hash i of the 512, on the CPU: the two lines the shaders run. */
const hashOf = (index: number): number => (index < 4 ? Math.imul(index, 0x55555555) : Math.imul(index + 1, 2654435761)) >>> 0;

const HASHES = `var h = (i + 1u) * 2654435761u;
  if (i < 4u) {
    h = i * 0x55555555u;
  }`;

const KERNEL = `// @use lot
struct Params {
  lots: f32, // @default 97
};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = ctx.index;
  ${HASHES}
  q.position = vec3f(f32(hashLot(h, 97u)), f32(hashLot(h, 100u)), f32(hashLot(h, 65536u)));
  q.velocity = vec3f(f32(hashLot(h, u32(ctx.params.lots))), f32(hashLot(h, 1u)), f32(hashLot(h, 1024u)));
  return q;
}`;

const FRAGMENT = `// @use lot
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let keep = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).r * 0.0;
  let pixel = vec2u(uv * vec2f(${WIDTH}.0, ${HEIGHT}.0));
  let i = pixel.x + pixel.y * ${WIDTH}u;
  ${HASHES}
  let n = 2u + (i % 61u);
  return vec4f(f32(hashLot(h, 97u)) / 128.0 + keep, f32(hashLot(h, n)) / 64.0, f32(hashLot(h, 1024u)) / 1024.0, 1.0);
}`;

const settings: ProjectSettings = {
  outputResolution: { width: WIDTH, height: HEIGHT },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: registry.get(type)?.version ?? 1, position: { x: 0, y: 0 }, parameters, label: id };
}

const kernelGraph: GraphDocument = {
  revision: 1,
  nodes: {
    kernel_lots: node("kernel_lots", "pointKernel", { capacity: POINTS, seed: 7, kernel: KERNEL, lots: 97 }),
    points_draw: node("points_draw", "renderPoints", { count: POINTS, sizePixels: 1 }),
    output_frame: node("output_frame", "output", {}),
  },
  edges: {
    e1: { id: "e1", source: { nodeId: "kernel_lots", portId: "out" }, target: { nodeId: "points_draw", portId: "points" } },
    e2: { id: "e2", source: { nodeId: "points_draw", portId: "out" }, target: { nodeId: "output_frame", portId: "input" } },
  },
  groups: {},
};

const fragmentGraph: GraphDocument = {
  revision: 1,
  nodes: {
    solid_in: node("solid_in", "solid", {}),
    wgsl_lots: node("wgsl_lots", "customWgsl", { source: FRAGMENT }),
    output_frame: node("output_frame", "output", {}),
  },
  edges: {
    e1: { id: "e1", source: { nodeId: "solid_in", portId: "out" }, target: { nodeId: "wgsl_lots", portId: "input" } },
    e2: { id: "e2", source: { nodeId: "wgsl_lots", portId: "out" }, target: { nodeId: "output_frame", portId: "input" } },
  },
  groups: {},
};

async function rendered<T>(graph: GraphDocument, read: (backend: ReturnType<typeof createVgpuBackend>, plan: ReturnType<typeof compileGraph>) => Promise<T>): Promise<T> {
  const plan = compileGraph({ graph, settings, registry, capabilities });
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
  /* The helper is not the shape it replaces: the compiler has nothing to say about it. */
  expect(plan.diagnostics.filter((diagnostic) => diagnostic.code === CompilerDiagnosticCode.wgslHighHalfDivide)).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    for (const frameIndex of [0, 1]) {
      backend.render(compiled, { frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 }, pointer: { x: 0, y: 0, buttons: 0 }, resolution: [WIDTH, HEIGHT] });
    }
    return await read(backend, plan);
  } finally {
    backend.dispose();
  }
}

describe("B263: hashLot on the device is hashLotReference on the CPU", () => {
  it("in a compute kernel, for 512 hashes and six n", async () => {
    // Required, never skipped: without a GPU this would be a green tick about nothing.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const lots = await rendered(kernelGraph, async (backend) => {
      const attribute = async (name: string): Promise<Float32Array> =>
        (await readKernelAttribute(backend.readBuffer, { type: "pointKernel", parameters: { capacity: POINTS } }, "kernel_lots", name)).floats;
      return { position: await attribute("position"), velocity: await attribute("velocity") };
    });
    const got: number[][] = [];
    const want: number[][] = [];
    for (let index = 0; index < POINTS; index += 1) {
      const h = hashOf(index);
      got.push([...lots.position.slice(index * 4, index * 4 + 3), ...lots.velocity.slice(index * 4, index * 4 + 3)]);
      want.push([97, 100, 65536, 97, 1, 1024].map((n) => hashLotReference(h, n)));
    }
    expect(got).toEqual(want);
    /* The table is not a column of zeros: every n but 1 draws many different lots, and the largest reaches its ends. */
    const column = (at: number): Set<number> => new Set(want.map((row) => row[at] as number));
    expect([column(0).size, column(1).size, column(4).size]).toEqual([97, 100, 1]);
    expect(column(2).size).toBeGreaterThan(500);
    expect([want[0]?.[2], want[3]?.[2]]).toEqual([0, 65535]);
  }, 120_000);

  it("in a fragment shader, for 512 hashes, two literal n and one that differs per pixel", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const picture = await rendered(fragmentGraph, async (backend, plan) => {
      const target = plan.outputs.find((output) => output.nodeId === "wgsl_lots")?.resourceId ?? "";
      const image = await backend.readOutput(target);
      expect([image.width, image.height, image.format]).toEqual([WIDTH, HEIGHT, "rgba16float"]);
      const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
      return Array.from({ length: HEIGHT }, (_, y) =>
        Array.from({ length: WIDTH }, (_, x) => {
          const at = y * image.rowStride + x * 8;
          return [decodeHalf(view.getUint16(at, true)) * 128, decodeHalf(view.getUint16(at + 2, true)) * 64, decodeHalf(view.getUint16(at + 4, true)) * 1024];
        }),
      );
    });
    /** What the CPU says the picture is, when the shader's row 0 is the picture's row `first`. */
    const expected = (flipped: boolean): number[][][] =>
      Array.from({ length: HEIGHT }, (_, y) =>
        Array.from({ length: WIDTH }, (_, x) => {
          const index = x + (flipped ? HEIGHT - 1 - y : y) * WIDTH;
          const h = hashOf(index);
          return [hashLotReference(h, 97), hashLotReference(h, 2 + (index % 61)), hashLotReference(h, 1024)];
        }),
      );
    /* Which way up uv runs is not this test's claim; that every pixel is its own lot is. */
    const upright = JSON.stringify(picture) === JSON.stringify(expected(false));
    expect(picture).toEqual(expected(upright ? false : true));
    expect(new Set(picture.flat().map((lots) => lots[0])).size).toBe(97);
  }, 120_000);
});
