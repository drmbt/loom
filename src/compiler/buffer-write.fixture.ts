import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";
import type { NodeCompileContext, NodeDefinition } from "../domain/types/node-definition.ts";
import type { StoredParameter } from "../domain/types/parameters.ts";
import { RGBA_TEXTURE } from "../nodes/definitions/common-ports.ts";
import { readCompileInputs } from "../nodes/definitions/compile-context.ts";
import { wgsl } from "../runtime/backend/wgsl.ts";
import { scratchResourceId } from "./resources.ts";

/**
 * T1623b slice 2 — TEST FIXTURE, not a product node: the smallest node that owns a table of
 * rows as VALUES (`BufferWritePassDescriptor`) and draws from it.
 *
 * It stands where a Render will stand with its named Lights: the table is a scratch buffer
 * of the node's own, its rows come from parameters, and its fragment shader walks as many
 * rows as the table says are live. The picture is the sum of the live rows, so a test reads
 * a row back as a pixel.
 *
 *  - row i is (Gain × (i + 1), 0.25 × (i + 1), 0.5, 1);
 *  - Rows is how many are live: a VALUE, so a driven Rows grows and shrinks the table with
 *    no rebuild;
 *  - Capacity is how many the table has room for: STRUCTURE (`compileTime`), since it sizes
 *    the buffer.
 *
 * The shader holds no row and no count: its text is the same at every Rows.
 */

const SHOW = wgsl`@group(0) @binding(0) var<storage, read> table: array<u32>;

struct ProbeVertex {
  @builtin(position) position: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> ProbeVertex {
  var out: ProbeVertex;
  out.position = vec4f(f32(i32(vertex & 1u) * 4 - 1), f32(i32(vertex >> 1u) * 4 - 1), 0.0, 1.0);
  return out;
}

@fragment
fn fs() -> @location(0) vec4f {
  var sum = vec3f(0.0);
  let live = table[0];
  for (var row = 0u; row < live; row++) {
    let at = 4u + row * 4u;
    sum += vec3f(bitcast<f32>(table[at]), bitcast<f32>(table[at + 1u]), bitcast<f32>(table[at + 2u]));
  }
  return vec4f(sum, 1.0);
}`;

/** The rows the node writes for these values: what a test expects to read back. */
export function tableProbeRows(gain: number, rows: number): number[] {
  return Array.from({ length: Math.max(0, Math.floor(rows)) }, (_, index) => [gain * (index + 1), 0.25 * (index + 1), 0.5, 1]).flat();
}

export const tableProbeNode: NodeDefinition = {
  type: "tableProbe",
  version: 1,
  title: "Table Probe",
  category: "generator",
  description: "Test fixture: draws the sum of the live rows of a table it owns as values.",
  tags: ["test"],
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    gain: { type: "number", label: "Gain", default: 1 },
    rows: { type: "number", label: "Rows", default: 2, min: 0, step: 1, range: "floor" },
    capacity: { type: "number", label: "Capacity", default: 4, min: 1, step: 1, range: "floor", compileTime: true },
  },
  compile(context: NodeCompileContext) {
    const { nodeId, parameters } = readCompileInputs(context);
    const number = (key: string, fallback: number): number => (typeof parameters[key] === "number" ? (parameters[key] as number) : fallback);
    const capacity = Math.max(1, Math.floor(number("capacity", 4)));
    const rows = tableProbeRows(number("gain", 1), number("rows", 2));
    const table = scratchResourceId(nodeId, "table");
    return {
      /* One header of four words (the count is its first), then the rows. */
      scratch: [{ key: "table", kind: "buffer", stride: 4, capacity: 4 + capacity * 4 }],
      passes: [
        { kind: "write", id: "rows", resourceId: table, offset: 16, row: ["f32", "f32", "f32", "f32"], capacity, countOffset: 0, values: { rows, count: rows.length / 4 } },
        { kind: "draw", id: "show", shader: SHOW, topology: "triangle-list", instances: 1, vertexCount: 3, buffers: [{ binding: "table", resourceId: table }], clear: true },
      ],
    };
  },
};

/** One Table Probe into an Output. */
export function tableProbeGraph(parameters: Readonly<Record<string, StoredParameter>> = {}): GraphDocument {
  const node = (id: string, type: string, own: GraphNode["parameters"]): GraphNode => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: own, label: id });
  return {
    revision: 1,
    nodes: {
      probe_table: node("probe_table", "tableProbe", { ...parameters }),
      output_frame: node("output_frame", "output", {}),
    },
    edges: { e1: { id: "e1", source: { nodeId: "probe_table", portId: "out" }, target: { nodeId: "output_frame", portId: "input" } } },
    groups: {},
  };
}
