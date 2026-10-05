import { scratchResourceId } from "../../compiler/resources.ts";
import type { PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import { POINT_ATTRIBUTE_TYPES, type PointAttributeSchema, type PointAttributeType } from "../../points/attributes.ts";
import { packAttributes } from "../../points/packing.ts";
import type { BufferBindingDescriptor } from "../../runtime/backend/plan.ts";
import type { InstanceRecordOffsets, PackedRead } from "../shaders/instance-resolve.wgsl.ts";

/**
 * T1581b — the INSTANCE RECORDS of a mesh-instancing geometry, at the node seam
 * (docs/mesh-instancing-design-2026-10-05.md, D8).
 *
 * One record per instance slot: the three rows of `Object · Instance_i` (a 3×4 matrix), and
 * the instance's tint when Tint is mapped. The Geometry node resolves them once a frame
 * (`instanceResolveWgsl`); every draw of that geometry, in every Render that names it,
 * reads them. The layout is the packed-pointset layout every producer uses (T1076) —
 * independent regions, 256-aligned — so a later region (a cull's meta, last frame's
 * matrix for motion vectors) moves nothing that exists.
 */

/** The scratch key of a geometry's record buffer. */
export const INSTANCE_RECORDS_KEY = "instanceRecords";

const ROW = (name: string): PointAttributeSchema => ({ name, type: "vec4f", default: [0, 0, 0, 0] });

/** The record's attributes, in layout order. `tint` exists only when Tint is mapped. */
export function instanceRecordAttributes(options: { readonly tint: boolean }): ReadonlyArray<PointAttributeSchema> {
  return [ROW("m0"), ROW("m1"), ROW("m2"), ...(options.tint ? [ROW("tint")] : [])];
}

export interface InstanceRecordStorage {
  readonly ok: true;
  readonly resourceId: string;
  /** A plain buffer of u32 words: written by the resolve pass, read by the draws, never swapped. */
  readonly scratch: { readonly kind: "buffer"; readonly key: string; readonly stride: number; readonly capacity: number };
  readonly offsets: InstanceRecordOffsets;
}

export function instanceRecordStorage(
  nodeId: string,
  capacity: number,
  options: { readonly tint: boolean },
): InstanceRecordStorage | { readonly ok: false; readonly errors: ReadonlyArray<string> } {
  const layout = packAttributes(instanceRecordAttributes(options), capacity);
  if (!layout.ok) return { ok: false, errors: layout.errors };
  const offset = (name: string): number => (layout.byName.get(name) as { offset: number }).offset;
  return {
    ok: true,
    resourceId: scratchResourceId(nodeId, INSTANCE_RECORDS_KEY),
    scratch: { kind: "buffer", key: INSTANCE_RECORDS_KEY, stride: 4, capacity: layout.bytes / 4 },
    offsets: { m0: offset("m0"), m1: offset("m1"), m2: offset("m2"), ...(options.tint ? { tint: offset("tint") } : {}) },
  };
}

/** True when `type` is one a packed accessor can read. */
export function isPackedType(type: string | undefined): type is PointAttributeType {
  return type !== undefined && (POINT_ATTRIBUTE_TYPES as readonly string[]).includes(type);
}

/**
 * The buffers one pass binds WHOLE, in first-use order, and the read each attribute
 * resolves to. Two attributes of one producer share a binding — which is the whole reason
 * a mesh-instance pass spends bindings per producer and not per attribute (§V588).
 */
export interface PackedGroups {
  /** The read for one attribute region of the edge payload. */
  read(ref: Pick<PointsetAttributeRef, "buffer" | "half" | "offset">, type: PointAttributeType): PackedRead;
  /** The group index of a plain buffer bound whole (the records). */
  whole(resourceId: string): number;
  /** The plan bindings, named `<prefix><index>`. */
  bindings(prefix: string): BufferBindingDescriptor[];
  readonly count: number;
}

export function packedGroups(): PackedGroups {
  const order: Array<{ resourceId: string; half?: "read" | "write" }> = [];
  const index = new Map<string, number>();
  const groupOf = (resourceId: string, half?: "read" | "write"): number => {
    const key = `${resourceId}:${half ?? ""}`;
    const known = index.get(key);
    if (known !== undefined) return known;
    index.set(key, order.length);
    order.push({ resourceId, ...(half === undefined ? {} : { half }) });
    return order.length - 1;
  };
  return {
    read: (ref, type) => ({ group: groupOf(ref.buffer, ref.half), offset: ref.offset, type }),
    whole: (resourceId) => groupOf(resourceId),
    bindings: (prefix) => order.map((group, at) => ({ binding: `${prefix}${at}`, resourceId: group.resourceId, ...(group.half === undefined ? {} : { half: group.half }) })),
    get count() {
      return order.length;
    },
  };
}
