import type { PointAttributeSchema } from "./attributes.ts";
import { packAttributes, type PackedLayout, type PackedLayoutResult } from "./packing.ts";
import { decodeGlb, type DecodedJoint, type DecodedMesh } from "../domain/mesh/glb.ts";

/**
 * T1353b — a decoded mesh AS A POINTSET: the vertex attributes a `meshFileIn` publishes,
 * and the bytes that fill them.
 *
 * One schema, used by both ends. The node packs it to size its buffer and publish its
 * regions; the loader packs the decoded arrays into exactly those regions. They cannot
 * disagree about where `normal` starts, because they call the same function.
 *
 * Per vertex, 88 bytes: `vec3f` strides 16 (WGSL alignment), so a 1.5 M-vertex selection
 * fills the 128 MiB baseline binding (`MAX_STORAGE_BUFFER_BINDING_BYTES`) — which is what
 * the node's Select is for.
 */
export const MESH_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "normal", type: "vec3f", qualifier: "direction", default: [0, 1, 0] },
  { name: "uv", type: "vec2f", default: [0, 0] },
  { name: "color", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  /** roughness, metallic, heat (`loom_heat`), part index (0 = static). */
  { name: "surface", type: "vec4f", default: [1, 0, 0, 0] },
  /** Linear rgb radiance, unlit and additive. */
  { name: "emissive", type: "vec3f", qualifier: "color", default: [0, 0, 0] },
];

/**
 * T1401b — a SKINNED selection's two extra attributes, after the six above (so every region
 * the unskinned layout has keeps its offset): four joint indices into the node's joint table
 * as floats, and their four weights (sum 1; all zero on a vertex nothing skins). 120 bytes a
 * vertex in all, so a skinned selection fills the binding at 1,118,481 vertices.
 */
export const MESH_SKIN_ATTRIBUTES: ReadonlyArray<PointAttributeSchema> = [
  ...MESH_ATTRIBUTES,
  { name: "joints", type: "vec4f", default: [0, 0, 0, 0] },
  { name: "weights", type: "vec4f", default: [0, 0, 0, 0] },
];

/** The registry keys a mesh node's buffers are fed from (§V135: keys, never bytes). T1410b: `pose`, a clip's baked joint poses. */
export function meshSourceIdsFor(nodeId: string): { readonly points: string; readonly indices: string; readonly pose: string } {
  return { points: `mesh:${nodeId}:points`, indices: `mesh:${nodeId}:indices`, pose: `mesh:${nodeId}:pose` };
}

export function meshLayout(vertexCount: number, skinned = false): PackedLayoutResult {
  return packAttributes(skinned ? MESH_SKIN_ATTRIBUTES : MESH_ATTRIBUTES, vertexCount);
}

/**
 * The packed attribute bytes for `mesh`, laid out by `layout` (which must be
 * `meshLayout(mesh.vertexCount, mesh.skin !== undefined)`). vec3 attributes are written at stride 16 with the
 * fourth lane zero, exactly as a WGSL `array<vec3f>` reads them.
 */
export function packMeshAttributes(mesh: DecodedMesh, layout: PackedLayout): Uint8Array {
  if (layout.capacity !== mesh.vertexCount) {
    throw new Error(`packMeshAttributes: layout sized for ${layout.capacity} vertices, mesh has ${mesh.vertexCount}.`);
  }
  const out = new Float32Array(layout.bytes / 4);
  const sources: Readonly<Record<string, { data: ArrayLike<number>; components: number }>> = {
    position: { data: mesh.positions, components: 3 },
    normal: { data: mesh.normals, components: 3 },
    uv: { data: mesh.uvs, components: 2 },
    color: { data: mesh.colors, components: 4 },
    surface: { data: mesh.surface, components: 4 },
    emissive: { data: mesh.emissive, components: 3 },
    ...(mesh.skin === undefined ? {} : { joints: { data: mesh.skin.indices, components: 4 }, weights: { data: mesh.skin.weights, components: 4 } }),
  };
  for (const region of layout.regions) {
    const source = sources[region.name];
    if (source === undefined) throw new Error(`packMeshAttributes: no source for attribute "${region.name}".`);
    const base = region.offset / 4;
    const strideWords = region.stride / 4;
    for (let vertex = 0; vertex < mesh.vertexCount; vertex += 1) {
      const at = base + vertex * strideWords;
      for (let c = 0; c < source.components; c += 1) {
        out[at + c] = source.data[vertex * source.components + c] as number;
      }
    }
  }
  return new Uint8Array(out.buffer);
}

/** The index list as bytes: u32 per corner, three per triangle. */
export function packMeshIndices(mesh: DecodedMesh): Uint8Array {
  return new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength);
}

/**
 * What the node records about the file it was sized for, as its compile-time
 * parameters. Parts are listed as `index:name` so a kernel author can read the number to
 * branch on straight off the inspector.
 */
export function meshFacts(mesh: DecodedMesh): MeshFacts {
  return {
    vertices: mesh.vertexCount,
    triangles: mesh.triangleCount,
    parts: mesh.parts.map((part) => `${part.index}:${part.name}`).join(" "),
    joints: formatJointTable(mesh.skin?.joints ?? []),
    clips: (mesh.clips ?? []).map((name) => name.replace(/\s+/g, "_")).join(" "),
    clipFrames: mesh.skin?.pose?.frames ?? 0,
  };
}

export interface MeshFacts {
  readonly vertices: number;
  readonly triangles: number;
  readonly parts: string;
  /** T1401b: the joint table, `formatJointTable`; empty = unskinned (no joints/weights attributes). */
  readonly joints: string;
  /** T1410b: the file's animation names, space-separated. */
  readonly clips: string;
  /** T1410b: frames in the chosen clip's baked pose table; 0 = no clip chosen (or none in the file). */
  readonly clipFrames: number;
}

/**
 * T1401b — the joint table as the node's `joints` parameter: one `index:name<parent@x,y,z`
 * per joint (`<parent` absent at a root; the rest head in world metres), space-separated —
 * what a kernel author reads to know which index `p.joints` names and where it turns.
 */
export function formatJointTable(joints: ReadonlyArray<DecodedJoint>): string {
  const metres = (value: number): string => String(Number(value.toFixed(4)));
  return joints
    .map((joint, index) => `${index}:${joint.name.replace(/\s+/g, "_")}${joint.parent < 0 ? "" : `<${joint.parent}`}@${joint.head.map(metres).join(",")}`)
    .join(" ");
}

/** A mesh ready to feed: the node's facts and the two byte payloads its sources serve. */
export interface PreparedMesh {
  readonly facts: MeshFacts;
  readonly points: Uint8Array;
  readonly indices: Uint8Array;
  /** T1410b: the chosen clip's pose table as bytes (`DecodedPose.table`); absent without one. */
  readonly pose?: Uint8Array;
  readonly mesh: DecodedMesh;
}

/**
 * Decode → pack, the ONE path both the app's loader and the headless harness take, so an
 * offline render feeds the bytes the browser feeds. `null` when the selection is empty
 * (nothing to feed; the node's own diagnostic says so). Throws `GlbDecodeError` on a file
 * the decoder refuses, and a plain Error when the selection overflows one binding.
 */
export function prepareMesh(glb: Uint8Array, select: string, clip: { readonly name?: string; readonly rate?: number } = {}): PreparedMesh | null {
  const mesh = decodeGlb(glb, { select, ...(clip.name === undefined || clip.name === "" ? {} : { clip: clip.name, ...(clip.rate === undefined ? {} : { clipRate: clip.rate }) }) });
  if (mesh.vertexCount === 0 || mesh.triangleCount === 0) return null;
  const layout = meshLayout(mesh.vertexCount, mesh.skin !== undefined);
  if (!layout.ok) throw new Error(layout.errors.join("; "));
  const table = mesh.skin?.pose?.table;
  return {
    facts: meshFacts(mesh),
    points: packMeshAttributes(mesh, layout),
    indices: packMeshIndices(mesh),
    ...(table === undefined ? {} : { pose: new Uint8Array(table.buffer, table.byteOffset, table.byteLength) }),
    mesh,
  };
}
