import { compileGraph } from "../../compiler/index.ts";
import { frameFromClock } from "../../domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "../../domain/types/graph.ts";
import type { StoredParameter } from "../../domain/types/parameters.ts";
import type { PointAttributeSchema, PointAttributeType } from "../../points/attributes.ts";
import { COMPONENT_COUNTS } from "../../points/attributes.ts";
import { createNodeRegistry } from "../registry/registry.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { allNodeDefinitions } from "./index.ts";
import { pointStorageId } from "./point-storage.ts";
import { pointRegionSlice } from "./test-support.ts";

/**
 * T1586b — what the curve family's tests share: graphs whose points are AUTHORED EXACTLY,
 * run through the real compiler and a real device, and read back attribute by attribute.
 *
 * A fixture is an assumption written twice, so the three test files of the family (strips,
 * Curve Frames, Resample) write this one once. Nothing here knows a curve node: it builds
 * graphs, renders them on Dawn, and slices a node's packed buffer with the layout the node
 * itself declares.
 *
 * Node names are `kind_role` (§T1593b), and an id is its name.
 */

export const CURVE_TEST_REGISTRY = createNodeRegistry(allNodeDefinitions).view();

const SIZE = 16;

const settingsAt = (size: number) =>
  ({
    outputResolution: { width: size, height: size },
    workingFormat: "rgba8unorm",
    randomSeed: 7,
    previewLongEdge: 192,
    previewFps: 20,
    limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
  }) as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
} as never;

export const curveNode = (id: string, type: string, parameters: Record<string, unknown> = {}): GraphNode =>
  ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label: id }) as never;

export const curveEdge = (source: [string, string], target: [string, string]) => ({
  id: `${source[0]}.${source[1]}-${target[0]}.${target[1]}`,
  source: { nodeId: source[0], portId: source[1] },
  target: { nodeId: target[0], portId: target[1] },
});

/** A parameter in Map mode: a per-point attribute drives it (T286). */
export const mappedTo = (attribute: string, retained: number | readonly number[], channel?: string): StoredParameter =>
  ({
    mode: "map",
    bindings: { static: { kind: "static", value: retained }, map: { kind: "map", attribute, ...(channel === undefined ? {} : { channel }) } },
  }) as StoredParameter;

export function curveGraph(nodes: ReadonlyArray<GraphNode>, edges: ReadonlyArray<ReturnType<typeof curveEdge>>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
    groups: {},
  } as never;
}

/** The sink every graph needs so the compiler keeps the chain alive: points drawn to an output. */
export function drawnTo(source: string, count: number): { nodes: GraphNode[]; edges: Array<ReturnType<typeof curveEdge>> } {
  return {
    nodes: [curveNode("renderpoints_probe", "renderPoints", { count, sizePixels: 1 }), curveNode("output_probe", "output")],
    edges: [curveEdge([source, "out"], ["renderpoints_probe", "points"]), curveEdge(["renderpoints_probe", "out"], ["output_probe", "input"])],
  };
}

export const compileCurveGraph = (graph: GraphDocument, size = SIZE) =>
  compileGraph({ graph, settings: settingsAt(size), registry: CURVE_TEST_REGISTRY, capabilities: CAPABILITIES });

const literal = (value: number): string => (Number.isInteger(value) ? `${value}.0` : String(value));
const vec = (values: readonly number[]): string => `vec${values.length}f(${values.map(literal).join(", ")})`;

/** A point, as a test writes it. */
type Vec3 = readonly [number, number, number];

export interface AuthoredAttribute {
  readonly name: string;
  readonly type: Exclude<PointAttributeType, "vec4u">;
  /** One value per point: numbers for f32 and u32, component lists for vectors. */
  readonly values: ReadonlyArray<number | readonly number[]>;
}

/**
 * A Point Kernel node that AUTHORS a pointset: slot i gets `positions[i]` and each extra
 * attribute's i-th value, from constant tables in its WGSL. The numbers are the test's
 * own, to the bit, so a readback has nothing to compare against but the arithmetic under
 * test (§V147).
 */
export function authoredPoints(
  id: string,
  positions: ReadonlyArray<Vec3>,
  extras: ReadonlyArray<AuthoredAttribute> = [],
): { readonly node: GraphNode; readonly schema: ReadonlyArray<PointAttributeSchema> } {
  const count = positions.length;
  const schema: PointAttributeSchema[] = [
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    ...extras.map((extra) => ({ name: extra.name, type: extra.type, default: Array<number>(COMPONENT_COUNTS[extra.type]).fill(0) })),
  ];
  const table = (name: string, type: string, values: ReadonlyArray<string>): string =>
    `const ${name} = array<${type}, ${count}>(${values.join(", ")});`;
  const tables = [
    table("AUTHORED_position", "vec3f", positions.map(vec)),
    ...extras.map((extra) =>
      table(
        `AUTHORED_${extra.name}`,
        extra.type,
        extra.values.map((value) =>
          typeof value === "number" ? (extra.type === "u32" ? `${value}u` : literal(value)) : vec(value),
        ),
      ),
    ),
  ];
  const kernel = `${tables.join("\n")}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = AUTHORED_position[ctx.index];
${extras.map((extra) => `  q.${extra.name} = AUTHORED_${extra.name}[ctx.index];`).join("\n")}
  return q;
}`;
  return {
    node: curveNode(id, "pointKernel", { capacity: count, seed: 7, attributes: JSON.stringify(schema), kernel }),
    schema,
  };
}

export interface CurveSession {
  readonly plan: ReturnType<typeof compileCurveGraph>;
  /** Render one more frame; the first call is frame 0. */
  renderFrame(frameIndex?: number): void;
  /** One attribute of a node's packed point buffer, sliced with the schema the node declares. */
  read(
    nodeId: string,
    schema: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }>,
    capacity: number,
    attribute: string,
  ): Promise<{ readonly floats: Float32Array; readonly words: Uint32Array }>;
  readOutput(): Promise<{ bytes: Uint8Array; width: number; height: number; rowStride: number }>;
}

/**
 * Compile a graph, render its first frame on Dawn (frame 0 unless the test asks for another),
 * and hand the test a session to read from.
 * Required, never skipped: skipping turns the one test that can see a fault into a green
 * tick on every machine without a GPU.
 */
export async function onDawn<T>(
  graph: GraphDocument,
  body: (session: CurveSession) => Promise<T>,
  size = SIZE,
  firstFrame = 0,
): Promise<T> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const plan = compileCurveGraph(graph, size);
  const refused = plan.diagnostics.filter((entry) => entry.severity === "error").map((entry) => entry.message);
  if (refused.length > 0) throw new Error(`the graph did not compile: ${refused.join(" | ")}`);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((entry) => {
    if (entry.severity === "error") errors.push(`${entry.code}: ${entry.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    const renderFrame = (frameIndex = 0): void => {
      backend.render(compiled, {
        // §V437: a frame is made by its constructor, so every clock it carries agrees.
        frame: frameFromClock({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7, fps: 60 }),
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [size, size],
      });
      if (errors.length > 0) throw new Error(`the device refused the frame: ${errors.join(" | ")}`);
    };
    renderFrame(firstFrame);
    return await body({
      plan,
      renderFrame,
      read: async (nodeId, schema, capacity, attribute) =>
        pointRegionSlice(await backend.readBuffer(pointStorageId(nodeId)), schema, capacity, attribute),
      readOutput: async () => {
        const frame = plan.outputs.find((output) => output.nodeId === "output_probe") ?? plan.outputs[0];
        return backend.readOutput(frame?.resourceId ?? "");
      },
    });
  } finally {
    backend.dispose();
  }
}

/** Point `index` of a vec3f or vec4f region: 16 bytes a point either way, so four floats. */
export const vecAt = (floats: Float32Array, index: number, size: 3 | 4 = 3): number[] =>
  Array.from(floats.subarray(index * 4, index * 4 + size));
