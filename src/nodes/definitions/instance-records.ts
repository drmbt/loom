import { scratchResourceId } from "../../compiler/resources.ts";
import type { PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import { COMPONENT_COUNTS, POINT_ATTRIBUTE_TYPES, type PointAttributeSchema, type PointAttributeType } from "../../points/attributes.ts";
import { packAttributes } from "../../points/packing.ts";
import type { BufferBindingDescriptor } from "../../runtime/backend/plan.ts";
import type { InstanceRecordOffsets, PackedRead } from "../shaders/instance-resolve.wgsl.ts";

/**
 * T1581b — the INSTANCE RECORDS of a mesh-instancing geometry, at the node seam
 * (docs/mesh-instancing-design-2026-10-05.md, D8).
 *
 * One record per instance slot: the three rows of `Object · Instance_i` (a 3×4 matrix), the
 * instance's tint when Tint is mapped, and one region per `struct Instance` field the
 * geometry bound to a point attribute. The Geometry node resolves them once a frame
 * (`instanceResolveWgsl`); every draw of that geometry, in every Render that names it,
 * reads them. The layout is the packed-pointset layout every producer uses (T1076) —
 * independent regions, 256-aligned — so a later region (a cull's meta, last frame's
 * matrix for motion vectors) moves nothing that exists.
 *
 * F1: a geometry that can leave instances out (`compact`: it has a Group, or its points are
 * counted) has one region more, `visible`, the slots of the instances that ARE drawn, dense
 * and in slot order; and beside the records it owns four u32 of indirect arguments (the
 * shape's vertex count and how many instances are visible). Its draws read both, so an
 * instance its Group rejects, or a dead slot of a counted set, is in no draw. A geometry
 * that draws every point has neither: its draws take a literal count.
 */

/** The scratch key of a geometry's record buffer. */
export const INSTANCE_RECORDS_KEY = "instanceRecords";
/** The scratch key of a geometry's indirect arguments: (vertexCount, visible instances, 0, 0). */
export const INSTANCE_ARGS_KEY = "instanceArgs";
/** T1689b: the indirect arguments of the draws of a geometry's SHADOW MESH: its vertex count, the same instances. */
export const INSTANCE_SHADOW_ARGS_KEY = "instanceShadowArgs";

const ROW = (name: string): PointAttributeSchema => ({ name, type: "vec4f", default: [0, 0, 0, 0] });

/** What a record holds beyond its matrix. */
export interface InstanceRecordOptions {
  readonly tint: boolean;
  /** F1: the geometry leaves instances out, so it lists and counts the ones it draws. */
  readonly compact?: boolean;
  /** The material's `struct Instance` fields this geometry bound, each a region of its own type. */
  readonly fields?: ReadonlyArray<{ readonly name: string; readonly type: PointAttributeType }>;
  /** T1689b: the geometry has a shadow mesh: when it compacts, that mesh's draws need arguments of their own. */
  readonly shadowMesh?: boolean;
}

/** The region a bound instance field is stored under. Prefixed: a field may be called `tint`. */
const fieldRegion = (name: string): string => `field_${name}`;

/** The record's attributes, in layout order. `tint` exists only when Tint is mapped. */
export function instanceRecordAttributes(options: InstanceRecordOptions): ReadonlyArray<PointAttributeSchema> {
  return [
    ROW("m0"),
    ROW("m1"),
    ROW("m2"),
    ...(options.compact === true ? [{ name: "visible", type: "u32" as const, default: [0] }] : []),
    ...(options.tint ? [ROW("tint")] : []),
    ...(options.fields ?? []).map((field) => ({ name: fieldRegion(field.name), type: field.type, default: new Array<number>(COMPONENT_COUNTS[field.type]).fill(0) })),
  ];
}

export interface InstanceRecordStorage {
  readonly ok: true;
  readonly resourceId: string;
  /** A plain buffer of u32 words: written by the resolve pass, read by the draws, never swapped. */
  readonly scratch: { readonly kind: "buffer"; readonly key: string; readonly stride: number; readonly capacity: number };
  readonly offsets: InstanceRecordOffsets;
  /** F1, when compacting: the indirect arguments every draw of the geometry reads, written by the resolve pass. */
  readonly args?: {
    readonly resourceId: string;
    readonly scratch: { readonly kind: "buffer"; readonly key: string; readonly stride: number; readonly capacity: number; readonly usage: "indirect" };
  };
  /** T1689b, when compacting AND the geometry has a shadow mesh: that mesh's own indirect arguments, written by the same pass. */
  readonly shadowArgs?: {
    readonly resourceId: string;
    readonly scratch: { readonly kind: "buffer"; readonly key: string; readonly stride: number; readonly capacity: number; readonly usage: "indirect" };
  };
}

export function instanceRecordStorage(
  nodeId: string,
  capacity: number,
  options: InstanceRecordOptions,
): InstanceRecordStorage | { readonly ok: false; readonly errors: ReadonlyArray<string> } {
  const layout = packAttributes(instanceRecordAttributes(options), capacity);
  if (!layout.ok) return { ok: false, errors: layout.errors };
  const offset = (name: string): number => (layout.byName.get(name) as { offset: number }).offset;
  return {
    ok: true,
    resourceId: scratchResourceId(nodeId, INSTANCE_RECORDS_KEY),
    scratch: { kind: "buffer", key: INSTANCE_RECORDS_KEY, stride: 4, capacity: layout.bytes / 4 },
    ...(options.compact === true
      ? { args: { resourceId: scratchResourceId(nodeId, INSTANCE_ARGS_KEY), scratch: { kind: "buffer" as const, key: INSTANCE_ARGS_KEY, stride: 4, capacity: 4, usage: "indirect" as const } } }
      : {}),
    ...(options.compact === true && options.shadowMesh === true
      ? { shadowArgs: { resourceId: scratchResourceId(nodeId, INSTANCE_SHADOW_ARGS_KEY), scratch: { kind: "buffer" as const, key: INSTANCE_SHADOW_ARGS_KEY, stride: 4, capacity: 4, usage: "indirect" as const } } }
      : {}),
    offsets: {
      m0: offset("m0"),
      m1: offset("m1"),
      m2: offset("m2"),
      ...(options.compact === true ? { visible: offset("visible") } : {}),
      ...(options.tint ? { tint: offset("tint") } : {}),
      ...(options.fields === undefined || options.fields.length === 0
        ? {}
        : { fields: Object.fromEntries(options.fields.map((field) => [field.name, { offset: offset(fieldRegion(field.name)), type: field.type }])) }),
    },
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
