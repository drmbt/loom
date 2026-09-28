/**
 * T1353b — the GLB DECODER: glTF 2.0 binary in, one world-space triangle soup out.
 *
 * Pure and headless (no DOM, no GPU, no clock), so the compiler's headless callers, the
 * MCP server and the Dawn tests decode exactly what the browser decodes.
 *
 * ## The subset, and why it is a subset
 *
 * We control the exporter (`tools/blender/furnace/`), so this accepts what that exporter
 * writes and REFUSES everything else by name rather than rendering a plausible wrong
 * shape: TRIANGLES primitives; float32 positions/normals/uvs; u8/u16/u32 indices; COLOR_0
 * as float or normalized u8/u16; the metallic-roughness FACTORS; `emissiveFactor` with
 * `KHR_materials_emissive_strength`; node TRS/matrix hierarchies; perspective cameras;
 * `extras`; skins with four influences (T1401b, below). Refused: Draco, meshopt, sparse
 * accessors, morph targets, more than four influences (JOINTS_1), and any
 * `extensionsRequired` entry not on the list above. Image textures are IGNORED with a
 * warning (the factors still apply) — v1 materials are factor + vertex colour. Animation
 * clips are ignored: the file's node pose is what is read.
 *
 * ## What comes out
 *
 * Every mesh primitive, transformed into WORLD space by its node's world matrix (normals
 * by the inverse transpose), concatenated in node order into one vertex list and one
 * index list. Per vertex the material's factors are FLATTENED onto the vertex (colour ×
 * COLOR_0, roughness, metallic, emissive, heat), so one draw carries a whole scene with
 * many materials. Nodes carrying `extras.loom_part` become PARTS: every vertex under
 * such a node carries its part index, and the part's pivot is the node's world origin.
 *
 * ## Skins (T1401b)
 *
 * A skinned primitive is placed the way glTF skins it — Σ weight × joint world × inverse
 * bind — so its vertices land in world space at the file's pose (the bind pose, for a file
 * exported at rest), exactly where an unskinned export of the same mesh would put them, and
 * the skinned node's own transform is ignored as the spec says. What comes out beside them
 * is what a kernel needs to pose them: per vertex four joint indices and four weights
 * (normalised to sum 1), and ONE joint table for the whole selection — every joint of every
 * skin a selected primitive uses, in scene-walk order, so a joint's parent (its nearest
 * ancestor node that is also in the table) always has a smaller index. A vertex the
 * selection holds unskinned carries weights of zero: nothing moves it.
 *
 * T1440b: a PROP PARENTED TO A BONE — an unskinned mesh node under a joint node, which is
 * how Blender exports an object with a Bone parent (sunglasses on the head) — is bound
 * rigidly to that joint: weight 1 on its nearest joint ancestor, placed at its rest world as
 * before. That is glTF's own meaning (the child moves with its joint's pose), so the kernel
 * that poses the skin carries the prop with it. The joint's skin joins the selection's table
 * even when no skinned primitive is selected, so a prop decoded on its own indexes the same
 * table as the body it rides on.
 */

export interface DecodedJoint {
  readonly name: string;
  /** Table index of the nearest ancestor node that is also a joint; −1 at a root. Always less than the joint's own index. */
  readonly parent: number;
  /** World position of the joint node's origin at rest — the head a kernel turns the joint about. */
  readonly head: readonly [number, number, number];
  /** The joint node's world matrix at rest, column-major 4×4 (glTF order). */
  readonly bind: readonly number[];
}

export interface DecodedSkin {
  readonly joints: ReadonlyArray<DecodedJoint>;
  /** Four indices into `joints` per vertex. */
  readonly indices: Uint16Array;
  /** Four weights per vertex, summing to 1 on a skinned vertex; all zero on an unskinned one. */
  readonly weights: Float32Array;
  /** T1410b: present when `DecodeOptions.clip` named an animation — its baked joint poses. */
  readonly pose?: DecodedPose;
}

/**
 * T1410b — a glTF animation BAKED into per-joint poses at a fixed rate. `table` holds, for
 * frame f (time min(f / rate, duration)) and table joint j, the joint's DELTA — its animated
 * world matrix times the inverse of its rest world — as three rows of a 3×4 affine matrix,
 * frame-major: `((f · joints + j) · 3 + row) · 4`. A skinned vertex, which the decoder places
 * at the rest pose, lands where glTF skinning puts it at that time under Σ weight × delta.
 */
export interface DecodedPose {
  readonly clip: string;
  readonly rate: number;
  readonly frames: number;
  readonly duration: number;
  readonly table: Float32Array;
}

export interface DecodedPart {
  readonly name: string;
  /** 1-based; 0 is "not a part" (static). */
  readonly index: number;
  /** The part node's world-space origin — the physical pivot the exporter placed. */
  readonly pivot: readonly [number, number, number];
  /** The part node's world rotation as a unit quaternion (x, y, z, w). */
  readonly rotation: readonly [number, number, number, number];
  readonly vertexStart: number;
  readonly vertexCount: number;
  /** T1363b: the enclosing part's name (`extras.loom_parent`); absent at the top of a rig. */
  readonly parent?: string;
}

export interface DecodedCamera {
  readonly name: string;
  /** World position. */
  readonly eye: readonly [number, number, number];
  /** World-space unit forward (the camera's −Z). */
  readonly forward: readonly [number, number, number];
  /** World-space unit up (the camera's +Y). */
  readonly up: readonly [number, number, number];
  /** Vertical field of view, degrees. */
  readonly fovDeg: number;
  readonly near: number;
  readonly far: number;
}

/** An `emit.*` (or any named, meshless) node: a world-space position and its −Z direction. */
export interface DecodedMarker {
  readonly name: string;
  readonly position: readonly [number, number, number];
  readonly direction: readonly [number, number, number];
  /**
   * T1363b: the node's `extras`, verbatim — what the exporter said about the marker (a
   * lamp's colour, lumens and cone; an opening's size). Absent when the node carries none.
   */
  readonly extras?: Readonly<Record<string, unknown>>;
}

export interface DecodedMesh {
  readonly vertexCount: number;
  readonly triangleCount: number;
  /** xyz per vertex. */
  readonly positions: Float32Array;
  /** xyz per vertex, unit length. */
  readonly normals: Float32Array;
  /** uv per vertex (0 when the primitive has none). */
  readonly uvs: Float32Array;
  /** Linear rgba per vertex: baseColorFactor × COLOR_0. */
  readonly colors: Float32Array;
  /** Per vertex: roughness, metallic, heat (`extras.loom_heat`), part index. */
  readonly surface: Float32Array;
  /** Linear rgb radiance per vertex: emissiveFactor × emissiveStrength. */
  readonly emissive: Float32Array;
  readonly indices: Uint32Array;
  readonly parts: ReadonlyArray<DecodedPart>;
  readonly cameras: ReadonlyArray<DecodedCamera>;
  readonly markers: ReadonlyArray<DecodedMarker>;
  readonly bounds: { readonly min: readonly [number, number, number]; readonly max: readonly [number, number, number] };
  /** Non-fatal notes (ignored textures, generated normals). */
  readonly warnings: ReadonlyArray<string>;
  /** T1401b: present only when a selected primitive is skinned. */
  readonly skin?: DecodedSkin;
  /** T1410b: the file's animation names, in file order; absent when it has none. */
  readonly clips?: ReadonlyArray<string>;
}

export interface DecodeOptions {
  /**
   * Space-separated globs (`*` and `?`) choosing which primitives to keep. A bare glob
   * matches the object's name, its mesh's name, its part's name or its material's name;
   * `part:<glob>` matches only the part name (`part:*` = every moving part) and
   * `material:<glob>` only the material. A leading `!` EXCLUDES what it matches, so
   * `!part:*` is the static plant. Empty keeps all. This is how a scene larger than one
   * storage binding is split across nodes.
   */
  readonly select?: string;
  /** T1410b: the animation to bake into the skin's pose table, by name (`clips` lists them). */
  readonly clip?: string;
  /** T1410b: the pose table's samples per second (default 30). */
  readonly clipRate?: number;
}

export class GlbDecodeError extends Error {
  override readonly name = "GlbDecodeError";
}

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

/** Extensions we READ; anything else in extensionsRequired is refused. */
const SUPPORTED_EXTENSIONS = new Set(["KHR_materials_emissive_strength", "KHR_lights_punctual"]);
/** Named because a user who meets them should know it was the compression, not the file. */
const REFUSED_EXTENSIONS: Readonly<Record<string, string>> = {
  KHR_draco_mesh_compression: "Draco compression",
  EXT_meshopt_compression: "meshopt compression",
  KHR_mesh_quantization: "quantized attributes",
  EXT_mesh_gpu_instancing: "GPU instancing (realize instances on export)",
};

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
/** Column-major 4×4, glTF's own order. */
type Mat4 = Float64Array;

interface GltfAccessor {
  bufferView?: number;
  byteOffset?: number;
  componentType: number;
  normalized?: boolean;
  count: number;
  type: string;
  sparse?: unknown;
}
interface GltfBufferView {
  buffer: number;
  byteOffset?: number;
  byteLength: number;
  byteStride?: number;
}
interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
  mode?: number;
  targets?: unknown;
  extensions?: Record<string, unknown>;
}
interface GltfMaterial {
  name?: string;
  pbrMetallicRoughness?: {
    baseColorFactor?: number[];
    metallicFactor?: number;
    roughnessFactor?: number;
    baseColorTexture?: unknown;
    metallicRoughnessTexture?: unknown;
  };
  emissiveFactor?: number[];
  emissiveTexture?: unknown;
  normalTexture?: unknown;
  extensions?: { KHR_materials_emissive_strength?: { emissiveStrength?: number } };
  extras?: Record<string, unknown>;
}
interface GltfNode {
  name?: string;
  children?: number[];
  mesh?: number;
  camera?: number;
  skin?: number;
  matrix?: number[];
  translation?: number[];
  rotation?: number[];
  scale?: number[];
  extras?: Record<string, unknown>;
}
interface GltfJson {
  asset?: { version?: string };
  scene?: number;
  scenes?: Array<{ nodes?: number[] }>;
  nodes?: GltfNode[];
  meshes?: Array<{ name?: string; primitives: GltfPrimitive[] }>;
  materials?: GltfMaterial[];
  accessors?: GltfAccessor[];
  bufferViews?: GltfBufferView[];
  buffers?: Array<{ byteLength: number; uri?: string }>;
  cameras?: Array<{ name?: string; type: string; perspective?: { yfov: number; znear: number; zfar?: number } }>;
  skins?: Array<{ joints: number[]; inverseBindMatrices?: number; name?: string }>;
  animations?: Array<{
    name?: string;
    channels: Array<{ sampler: number; target: { node?: number; path: string } }>;
    samplers: Array<{ input: number; output: number; interpolation?: string }>;
  }>;
  extensionsRequired?: string[];
  extensionsUsed?: string[];
}

const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };
const COMPONENT_BYTES: Readonly<Record<number, number>> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };

/** Splits the container into its JSON and BIN chunks. */
function readContainer(bytes: Uint8Array): { json: GltfJson; bin: Uint8Array | undefined } {
  if (bytes.byteLength < 20) throw new GlbDecodeError("Not a GLB: shorter than its 12-byte header plus one chunk.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new GlbDecodeError('Not a GLB: the file does not start with "glTF". Export glTF Binary (.glb).');
  const version = view.getUint32(4, true);
  if (version !== 2) throw new GlbDecodeError(`GLB container version ${version}; only version 2 is read.`);
  const total = Math.min(view.getUint32(8, true), bytes.byteLength);
  let offset = 12;
  let json: GltfJson | undefined;
  let bin: Uint8Array | undefined;
  while (offset + 8 <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > total) throw new GlbDecodeError(`GLB chunk at byte ${offset} runs past the end of the file.`);
    const chunk = bytes.subarray(start, start + length);
    if (type === CHUNK_JSON && json === undefined) {
      try {
        json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson;
      } catch (error) {
        throw new GlbDecodeError(`GLB JSON chunk does not parse: ${String(error)}`);
      }
    } else if (type === CHUNK_BIN && bin === undefined) {
      bin = chunk;
    }
    offset = start + ((length + 3) & ~3);
  }
  if (json === undefined) throw new GlbDecodeError("GLB has no JSON chunk.");
  return { json, bin };
}

function identity(): Mat4 {
  const m = new Float64Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float64Array(16);
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

function composeTrs(t: readonly number[], r: readonly number[], s: readonly number[]): Mat4 {
  const [x, y, z, w] = [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1];
  const [sx, sy, sz] = [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1];
  const m = new Float64Array(16);
  m[0] = (1 - 2 * (y * y + z * z)) * sx;
  m[1] = 2 * (x * y + z * w) * sx;
  m[2] = 2 * (x * z - y * w) * sx;
  m[4] = 2 * (x * y - z * w) * sy;
  m[5] = (1 - 2 * (x * x + z * z)) * sy;
  m[6] = 2 * (y * z + x * w) * sy;
  m[8] = 2 * (x * z + y * w) * sz;
  m[9] = 2 * (y * z - x * w) * sz;
  m[10] = (1 - 2 * (x * x + y * y)) * sz;
  m[12] = t[0] ?? 0;
  m[13] = t[1] ?? 0;
  m[14] = t[2] ?? 0;
  m[15] = 1;
  return m;
}

function localMatrix(node: GltfNode): Mat4 {
  if (Array.isArray(node.matrix) && node.matrix.length === 16) return Float64Array.from(node.matrix);
  return composeTrs(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1]);
}

function transformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z + (m[12] as number),
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z + (m[13] as number),
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z + (m[14] as number),
  ];
}

function transformDirection(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [
    (m[0] as number) * x + (m[4] as number) * y + (m[8] as number) * z,
    (m[1] as number) * x + (m[5] as number) * y + (m[9] as number) * z,
    (m[2] as number) * x + (m[6] as number) * y + (m[10] as number) * z,
  ];
}

/** The inverse-transpose 3×3 (as columns), for normals under non-uniform scale. */
function normalMatrix(m: Mat4): [Vec3, Vec3, Vec3] {
  const a = [m[0], m[1], m[2], m[4], m[5], m[6], m[8], m[9], m[10]] as number[];
  const [a00, a01, a02, a10, a11, a12, a20, a21, a22] = a as [number, number, number, number, number, number, number, number, number];
  // Columns of the upper 3×3 are (a00,a01,a02), (a10,a11,a12), (a20,a21,a22).
  const c0: Vec3 = [a11 * a22 - a12 * a21, a12 * a20 - a10 * a22, a10 * a21 - a11 * a20];
  const c1: Vec3 = [a21 * a02 - a22 * a01, a22 * a00 - a20 * a02, a20 * a01 - a21 * a00];
  const c2: Vec3 = [a01 * a12 - a02 * a11, a02 * a10 - a00 * a12, a00 * a11 - a01 * a10];
  // The cofactor matrix IS the inverse-transpose up to the determinant, whose sign alone
  // matters after normalisation — and a mirrored node flips it, so keep it.
  const det = a00 * c0[0] + a01 * c0[1] + a02 * c0[2];
  const s = det < 0 ? -1 : 1;
  return [
    [c0[0] * s, c0[1] * s, c0[2] * s],
    [c1[0] * s, c1[1] * s, c1[2] * s],
    [c2[0] * s, c2[1] * s, c2[2] * s],
  ];
}

function normalize3(v: Vec3): Vec3 {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 1e-20 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 0];
}

/** Rotation of a world matrix as a unit quaternion (scale removed). */
function matrixRotation(m: Mat4): Quat {
  const cx = normalize3([m[0] as number, m[1] as number, m[2] as number]);
  const cy = normalize3([m[4] as number, m[5] as number, m[6] as number]);
  const cz = normalize3([m[8] as number, m[9] as number, m[10] as number]);
  const [m00, m10, m20] = cx;
  const [m01, m11, m21] = cy;
  const [m02, m12, m22] = cz;
  const trace = m00 + m11 + m22;
  let q: Quat;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s];
  }
  const length = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/** Glob with `*` and `?`, whole-string, case-sensitive. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** T1410b: an affine matrix's inverse (the rest worlds a pose is measured from). */
function invertAffine(m: Mat4): Mat4 {
  const [a, b, c] = [m[0] as number, m[1] as number, m[2] as number];
  const [d, e, f] = [m[4] as number, m[5] as number, m[6] as number];
  const [g, h, i] = [m[8] as number, m[9] as number, m[10] as number];
  const det = a * (e * i - h * f) - d * (b * i - h * c) + g * (b * f - e * c);
  const s = Math.abs(det) < 1e-12 ? 0 : 1 / det;
  const out = new Float64Array(16);
  out[0] = (e * i - h * f) * s;
  out[1] = (h * c - b * i) * s;
  out[2] = (b * f - e * c) * s;
  out[4] = (g * f - d * i) * s;
  out[5] = (a * i - g * c) * s;
  out[6] = (d * c - a * f) * s;
  out[8] = (d * h - g * e) * s;
  out[9] = (g * b - a * h) * s;
  out[10] = (a * e - d * b) * s;
  const [tx, ty, tz] = [m[12] as number, m[13] as number, m[14] as number];
  out[12] = -((out[0] as number) * tx + (out[4] as number) * ty + (out[8] as number) * tz);
  out[13] = -((out[1] as number) * tx + (out[5] as number) * ty + (out[9] as number) * tz);
  out[14] = -((out[2] as number) * tx + (out[6] as number) * ty + (out[10] as number) * tz);
  out[15] = 1;
  return out;
}

/** Spherical interpolation between unit quaternions, the short way round (glTF LINEAR rotation). */
function slerp(a: readonly number[], b: readonly number[], u: number): Quat {
  let [bx, by, bz, bw] = [b[0] as number, b[1] as number, b[2] as number, b[3] as number];
  let cos = (a[0] as number) * bx + (a[1] as number) * by + (a[2] as number) * bz + (a[3] as number) * bw;
  if (cos < 0) {
    [bx, by, bz, bw] = [-bx, -by, -bz, -bw];
    cos = -cos;
  }
  let wa = 1 - u;
  let wb = u;
  if (cos < 0.9995) {
    const angle = Math.acos(Math.min(1, cos));
    const sin = Math.sin(angle);
    wa = Math.sin((1 - u) * angle) / sin;
    wb = Math.sin(u * angle) / sin;
  }
  const q: Quat = [wa * (a[0] as number) + wb * bx, wa * (a[1] as number) + wb * by, wa * (a[2] as number) + wb * bz, wa * (a[3] as number) + wb * bw];
  const length = Math.hypot(...q) || 1;
  return [q[0] / length, q[1] / length, q[2] / length, q[3] / length];
}

/**
 * T1410b — bake one glTF animation into the table joints' DELTA poses (`DecodedPose`).
 *
 * Each channel is sampled the way glTF defines it — STEP holds a key, LINEAR lerps
 * translation and scale and slerps rotation, CUBICSPLINE runs the Hermite form over its
 * in-tangent / value / out-tangent triples (a rotation renormalised) — and before the first
 * key or after the last it holds the end value. A channel replaces its node's REST
 * translation, rotation or scale; every other node keeps its rest local. Worlds are walked
 * parent-first in scene order, so an animated ancestor that is not itself a joint (an
 * armature object) still moves its joints. Morph-target weights are not decoded: a
 * `weights` channel is skipped with a warning.
 */
function bakeClip(input: {
  readonly animation: NonNullable<GltfJson["animations"]>[number];
  readonly name: string;
  readonly rate: number;
  readonly nodes: ReadonlyArray<GltfNode>;
  readonly walked: ReadonlyMap<number, { world: Mat4; parent: number; order: number }>;
  readonly tableNodes: ReadonlyArray<number>;
  readonly readFloats: (index: number, what: string) => { data: Float32Array; components: number; count: number };
  readonly warnings: string[];
}): DecodedPose {
  const { animation, name, nodes, walked, tableNodes, readFloats, warnings } = input;
  const rate = Number.isFinite(input.rate) && input.rate > 0 ? input.rate : 30;
  interface Track { node: number; path: "translation" | "rotation" | "scale"; times: Float32Array; values: Float32Array; width: number; mode: "LINEAR" | "STEP" | "CUBICSPLINE" }
  const tracks: Track[] = [];
  let duration = 0;
  let skippedWeights = 0;
  for (const channel of animation.channels) {
    const where = `Animation "${name}"`;
    const node = channel.target.node;
    if (node === undefined) continue;
    const path = channel.target.path;
    if (path === "weights") {
      skippedWeights += 1;
      continue;
    }
    if (path !== "translation" && path !== "rotation" && path !== "scale") throw new GlbDecodeError(`${where} animates "${path}", which is not decoded.`);
    if (Array.isArray(nodes[node]?.matrix)) throw new GlbDecodeError(`${where} animates node "${nodes[node]?.name ?? node}", which carries a matrix; glTF animates TRS nodes only.`);
    const sampler = animation.samplers[channel.sampler];
    if (sampler === undefined) throw new GlbDecodeError(`${where} names sampler ${channel.sampler}, which does not exist.`);
    const mode = sampler.interpolation ?? "LINEAR";
    if (mode !== "LINEAR" && mode !== "STEP" && mode !== "CUBICSPLINE") throw new GlbDecodeError(`${where} interpolates by "${mode}", which is not decoded.`);
    const times = readFloats(sampler.input, `${where} input`).data;
    const values = readFloats(sampler.output, `${where} output`).data;
    const width = path === "rotation" ? 4 : 3;
    if (values.length !== times.length * width * (mode === "CUBICSPLINE" ? 3 : 1)) throw new GlbDecodeError(`${where}: a ${path} sampler has ${values.length} values for ${times.length} keys.`);
    if (times.length > 0) duration = Math.max(duration, times[times.length - 1] as number);
    tracks.push({ node, path, times, values, width, mode });
  }
  if (skippedWeights > 0) warnings.push(`Animation "${name}": ${skippedWeights} morph-weight channel(s) skipped; morph targets are not decoded.`);

  const value = (track: Track, key: number, slot: number): number[] => {
    const base = track.mode === "CUBICSPLINE" ? (key * 3 + slot) * track.width : key * track.width;
    return Array.from(track.values.subarray(base, base + track.width));
  };
  const sample = (track: Track, t: number): number[] => {
    const { times } = track;
    const last = times.length - 1;
    const valueSlot = track.mode === "CUBICSPLINE" ? 1 : 0;
    if (last < 0) return [];
    if (t <= (times[0] as number)) return value(track, 0, valueSlot);
    if (t >= (times[last] as number)) return value(track, last, valueSlot);
    let k = 0;
    while (k < last - 1 && (times[k + 1] as number) <= t) k += 1;
    const t0 = times[k] as number;
    const dt = (times[k + 1] as number) - t0;
    const u = dt > 0 ? (t - t0) / dt : 0;
    if (track.mode === "STEP") return value(track, k, 0);
    if (track.mode === "LINEAR") {
      const a = value(track, k, 0);
      const b = value(track, k + 1, 0);
      return track.path === "rotation" ? slerp(a, b, u) : a.map((x, c) => x + ((b[c] as number) - x) * u);
    }
    const [p0, m0, p1, m1] = [value(track, k, 1), value(track, k, 2), value(track, k + 1, 1), value(track, k + 1, 0)];
    const u2 = u * u;
    const u3 = u2 * u;
    const out = p0.map((_, c) =>
      (2 * u3 - 3 * u2 + 1) * (p0[c] as number) + (u3 - 2 * u2 + u) * dt * (m0[c] as number) + (-2 * u3 + 3 * u2) * (p1[c] as number) + (u3 - u2) * dt * (m1[c] as number),
    );
    if (track.path !== "rotation") return out;
    const length = Math.hypot(...out) || 1;
    return out.map((x) => x / length);
  };

  const order = [...walked.entries()].sort((a, b) => a[1].order - b[1].order);
  const restInverse = tableNodes.map((jointNode) => invertAffine((walked.get(jointNode) as { world: Mat4 }).world));
  const frames = Math.floor(duration * rate + 1e-6) + 1;
  const table = new Float32Array(frames * tableNodes.length * 12);
  const worlds = new Map<number, Mat4>();
  for (let frame = 0; frame < frames; frame += 1) {
    const t = Math.min(frame / rate, duration);
    const overrides = new Map<number, { translation?: number[]; rotation?: number[]; scale?: number[] }>();
    for (const track of tracks) {
      const entry = overrides.get(track.node) ?? {};
      entry[track.path] = sample(track, t);
      overrides.set(track.node, entry);
    }
    worlds.clear();
    for (const [nodeIndex, entry] of order) {
      const node = nodes[nodeIndex] as GltfNode;
      const animated = overrides.get(nodeIndex);
      const local =
        animated === undefined
          ? localMatrix(node)
          : composeTrs(animated.translation ?? node.translation ?? [0, 0, 0], animated.rotation ?? node.rotation ?? [0, 0, 0, 1], animated.scale ?? node.scale ?? [1, 1, 1]);
      worlds.set(nodeIndex, entry.parent < 0 ? local : multiply(worlds.get(entry.parent) ?? identity(), local));
    }
    tableNodes.forEach((jointNode, joint) => {
      const delta = multiply(worlds.get(jointNode) ?? identity(), restInverse[joint] as Mat4);
      const at = (frame * tableNodes.length + joint) * 12;
      for (let row = 0; row < 3; row += 1) {
        table[at + row * 4] = delta[row] as number;
        table[at + row * 4 + 1] = delta[4 + row] as number;
        table[at + row * 4 + 2] = delta[8 + row] as number;
        table[at + row * 4 + 3] = delta[12 + row] as number;
      }
    });
  }
  return { clip: name, rate, frames, duration, table };
}

export function decodeGlb(input: ArrayBuffer | Uint8Array, options: DecodeOptions = {}): DecodedMesh {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { json, bin } = readContainer(bytes);
  const warnings: string[] = [];

  if (json.asset?.version !== undefined && !json.asset.version.startsWith("2.")) {
    throw new GlbDecodeError(`glTF asset version "${json.asset.version}"; only 2.x is read.`);
  }
  for (const extension of json.extensionsRequired ?? []) {
    const refused = REFUSED_EXTENSIONS[extension];
    if (refused !== undefined) throw new GlbDecodeError(`The file requires ${extension} (${refused}), which Loom does not decode. Re-export without it.`);
    if (!SUPPORTED_EXTENSIONS.has(extension)) throw new GlbDecodeError(`The file requires the glTF extension ${extension}, which Loom does not decode.`);
  }
  for (const buffer of json.buffers ?? []) {
    if (buffer.uri !== undefined) throw new GlbDecodeError(`The file references an external buffer ("${buffer.uri.slice(0, 40)}"); export a self-contained .glb.`);
  }

  const accessors = json.accessors ?? [];
  const views = json.bufferViews ?? [];

  /** Reads accessor `index` as `components` floats per element, applying normalisation. */
  const readFloats = (index: number, what: string): { data: Float32Array; components: number; count: number } => {
    const accessor = accessors[index];
    if (accessor === undefined) throw new GlbDecodeError(`${what}: accessor ${index} does not exist.`);
    if (accessor.sparse !== undefined) throw new GlbDecodeError(`${what}: sparse accessors are not decoded; re-export without them.`);
    const components = COMPONENTS[accessor.type];
    const componentBytes = COMPONENT_BYTES[accessor.componentType];
    if (components === undefined || componentBytes === undefined) throw new GlbDecodeError(`${what}: accessor type ${accessor.type}/${accessor.componentType} is not decoded.`);
    const out = new Float32Array(accessor.count * components);
    if (accessor.bufferView === undefined) return { data: out, components, count: accessor.count };
    const view = views[accessor.bufferView];
    if (view === undefined || bin === undefined) throw new GlbDecodeError(`${what}: accessor ${index} points at a missing buffer view or an empty BIN chunk.`);
    if (view.buffer !== 0) throw new GlbDecodeError(`${what}: only buffer 0 (the GLB BIN chunk) is read.`);
    const elementBytes = components * componentBytes;
    const stride = view.byteStride ?? elementBytes;
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const last = base + stride * Math.max(0, accessor.count - 1) + elementBytes;
    if (last > bin.byteLength || last > (view.byteOffset ?? 0) + view.byteLength) {
      throw new GlbDecodeError(`${what}: accessor ${index} reads past its buffer view.`);
    }
    const data = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
    const normalized = accessor.normalized === true;
    for (let element = 0; element < accessor.count; element += 1) {
      const at = base + element * stride;
      for (let c = 0; c < components; c += 1) {
        const o = at + c * componentBytes;
        let value: number;
        switch (accessor.componentType) {
          case 5126: value = data.getFloat32(o, true); break;
          case 5125: value = data.getUint32(o, true); break;
          case 5123: value = data.getUint16(o, true); if (normalized) value /= 65535; break;
          case 5122: value = data.getInt16(o, true); if (normalized) value = Math.max(value / 32767, -1); break;
          case 5121: value = data.getUint8(o); if (normalized) value /= 255; break;
          default: value = data.getInt8(o); if (normalized) value = Math.max(value / 127, -1); break;
        }
        out[element * components + c] = value;
      }
    }
    return { data: out, components, count: accessor.count };
  };

  interface Selector { readonly negate: boolean; readonly scope: "any" | "part" | "material"; readonly pattern: RegExp }
  const selectors: Selector[] = (options.select ?? "").split(/\s+/).filter((token) => token !== "").map((token) => {
    const negate = token.startsWith("!");
    const body = negate ? token.slice(1) : token;
    const scope = body.startsWith("part:") ? "part" : body.startsWith("material:") ? "material" : "any";
    return { negate, scope, pattern: globToRegExp(scope === "any" ? body : body.slice(scope.length + 1)) };
  });
  const includes = selectors.filter((selector) => !selector.negate);
  const excludes = selectors.filter((selector) => selector.negate);
  const matches = (selector: Selector, names: { node?: string; mesh?: string; part?: string; material?: string }): boolean => {
    const candidates =
      selector.scope === "part" ? [names.part] : selector.scope === "material" ? [names.material] : [names.node, names.mesh, names.part, names.material];
    return candidates.some((name) => name !== undefined && selector.pattern.test(name));
  };
  const selected = (names: { node?: string; mesh?: string; part?: string; material?: string }): boolean =>
    (includes.length === 0 || includes.some((selector) => matches(selector, names))) &&
    !excludes.some((selector) => matches(selector, names));

  // Walk the default scene (or every root when there is none) in node order.
  const nodes = json.nodes ?? [];
  const sceneIndex = json.scene ?? 0;
  const roots = json.scenes?.[sceneIndex]?.nodes ?? nodes.map((_, index) => index).filter((index) => !nodes.some((n) => n.children?.includes(index)));

  interface Visit { readonly node: number; readonly world: Mat4; readonly part: number }
  const partNames = new Map<string, number>();
  const parts: Array<{ name: string; index: number; pivot: Vec3; rotation: Quat; vertexStart: number; vertexCount: number; parent?: string }> = [];
  const visits: Visit[] = [];
  const cameras: DecodedCamera[] = [];
  const markers: DecodedMarker[] = [];
  // T1401b: a skin joint is a bone, not a marker; and the skin needs every node's world
  // matrix, its parent and its place in the walk (the joint table's order).
  const skins = json.skins ?? [];
  const jointNodes = new Set(skins.flatMap((skin) => skin.joints));
  const walked = new Map<number, { world: Mat4; parent: number; order: number }>();
  const stack: Array<{ node: number; parent: Mat4; parentNode: number; part: number; depth: number }> = roots
    .map((node) => ({ node, parent: identity(), parentNode: -1, part: 0, depth: 0 }))
    .reverse();
  while (stack.length > 0) {
    const { node: nodeIndex, parent, parentNode, part: inherited, depth } = stack.pop() as (typeof stack)[number];
    const node = nodes[nodeIndex];
    if (node === undefined) throw new GlbDecodeError(`The scene names node ${nodeIndex}, which does not exist.`);
    if (depth > 256) throw new GlbDecodeError("The node hierarchy is deeper than 256 levels (a cycle?).");
    const world = multiply(parent, localMatrix(node));
    walked.set(nodeIndex, { world, parent: parentNode, order: walked.size });
    let part = inherited;
    const partName = node.extras?.["loom_part"];
    if (typeof partName === "string" && partName !== "") {
      const known = partNames.get(partName);
      if (known !== undefined) {
        part = known;
      } else {
        part = parts.length + 1;
        partNames.set(partName, part);
        const parentName = node.extras?.["loom_parent"];
        parts.push({
          name: partName,
          index: part,
          pivot: transformPoint(world, 0, 0, 0),
          rotation: matrixRotation(world),
          vertexStart: 0,
          vertexCount: 0,
          ...(typeof parentName === "string" && parentName !== "" ? { parent: parentName } : {}),
        });
      }
    }
    if (node.mesh !== undefined) visits.push({ node: nodeIndex, world, part });
    if (node.camera !== undefined) {
      const camera = json.cameras?.[node.camera];
      if (camera?.type === "perspective" && camera.perspective !== undefined) {
        cameras.push({
          name: node.name ?? camera.name ?? `camera${cameras.length}`,
          eye: transformPoint(world, 0, 0, 0),
          forward: normalize3(transformDirection(world, 0, 0, -1)),
          up: normalize3(transformDirection(world, 0, 1, 0)),
          fovDeg: (camera.perspective.yfov * 180) / Math.PI,
          near: camera.perspective.znear,
          far: camera.perspective.zfar ?? 1000,
        });
      }
    } else if (node.mesh === undefined && node.name !== undefined && (node.children ?? []).length === 0 && !jointNodes.has(nodeIndex)) {
      markers.push({
        name: node.name,
        position: transformPoint(world, 0, 0, 0),
        direction: normalize3(transformDirection(world, 0, 0, -1)),
        ...(node.extras === undefined || Object.keys(node.extras).length === 0 ? {} : { extras: node.extras }),
      });
    }
    for (const child of [...(node.children ?? [])].reverse()) {
      stack.push({ node: child, parent: world, parentNode: nodeIndex, part, depth: depth + 1 });
    }
  }

  // Pass 1: size the output so pass 2 writes straight into final arrays.
  const materials = json.materials ?? [];
  interface Plan { visit: Visit; primitive: GltfPrimitive; vertices: number; indices: number; skin?: number; bone?: number }
  /** T1440b: an unskinned node's nearest ancestor that is a skin joint, the bone it is parented to. */
  const boneOf = (nodeIndex: number): number | undefined => {
    let at = walked.get(nodeIndex)?.parent ?? -1;
    while (at >= 0 && !jointNodes.has(at)) at = walked.get(at)?.parent ?? -1;
    return at >= 0 ? at : undefined;
  };
  const plans: Plan[] = [];
  const textured = new Set<string>();
  for (const visit of visits) {
    const node = nodes[visit.node] as GltfNode;
    const mesh = json.meshes?.[node.mesh as number];
    if (mesh === undefined) throw new GlbDecodeError(`Node "${node.name ?? visit.node}" names mesh ${String(node.mesh)}, which does not exist.`);
    const partName = visit.part === 0 ? undefined : parts[visit.part - 1]?.name;
    for (const primitive of mesh.primitives) {
      const material = primitive.material === undefined ? undefined : materials[primitive.material];
      const names: { node?: string; mesh?: string; part?: string; material?: string } = {};
      if (node.name !== undefined) names.node = node.name;
      if (mesh.name !== undefined) names.mesh = mesh.name;
      if (partName !== undefined) names.part = partName;
      if (material?.name !== undefined) names.material = material.name;
      if (!selected(names)) continue;
      const mode = primitive.mode ?? 4;
      if (mode !== 4) {
        warnings.push(`Mesh "${mesh.name ?? node.mesh}" has a non-triangle primitive (mode ${mode}); skipped.`);
        continue;
      }
      if (primitive.targets !== undefined) throw new GlbDecodeError(`Mesh "${mesh.name ?? node.mesh}" has morph targets, which are not decoded. Apply shape keys on export.`);
      for (const extension of Object.keys(primitive.extensions ?? {})) {
        const refused = REFUSED_EXTENSIONS[extension];
        if (refused !== undefined) throw new GlbDecodeError(`Mesh "${mesh.name ?? node.mesh}" uses ${extension} (${refused}), which Loom does not decode.`);
      }
      const position = primitive.attributes["POSITION"];
      if (position === undefined) throw new GlbDecodeError(`Mesh "${mesh.name ?? node.mesh}" has a primitive with no POSITION.`);
      const vertices = accessors[position]?.count ?? 0;
      const indices = primitive.indices === undefined ? vertices : (accessors[primitive.indices]?.count ?? 0);
      if (indices % 3 !== 0) throw new GlbDecodeError(`Mesh "${mesh.name ?? node.mesh}" has ${indices} indices, not a whole number of triangles.`);
      if (material !== undefined) {
        const pbr = material.pbrMetallicRoughness;
        if (pbr?.baseColorTexture !== undefined || pbr?.metallicRoughnessTexture !== undefined || material.emissiveTexture !== undefined || material.normalTexture !== undefined) {
          textured.add(material.name ?? String(primitive.material));
        }
      }
      if (node.skin === undefined) {
        const bone = boneOf(visit.node);
        plans.push({ visit, primitive, vertices, indices, ...(bone === undefined ? {} : { bone }) });
        continue;
      }
      const where = `Skinned mesh "${mesh.name ?? node.name ?? node.mesh}"`;
      if (skins[node.skin] === undefined) throw new GlbDecodeError(`${where} names skin ${node.skin}, which does not exist.`);
      if (primitive.attributes["JOINTS_0"] === undefined || primitive.attributes["WEIGHTS_0"] === undefined) {
        throw new GlbDecodeError(`${where} has a primitive without JOINTS_0 and WEIGHTS_0.`);
      }
      const more = Object.keys(primitive.attributes).find((name) => /^(JOINTS|WEIGHTS)_[1-9]/.test(name));
      if (more !== undefined) throw new GlbDecodeError(`${where} has ${more}: more than four influences per vertex are not decoded. Export with four (Blender: Bone Influences 4).`);
      plans.push({ visit, primitive, vertices, indices, skin: node.skin });
    }
  }

  // T1401b: ONE joint table for the selection — every joint of every skin a selected
  // primitive uses, in walk order, so a parent always precedes its children.
  // T1440b: a bone-parented prop brings the first skin that lists its bone.
  const skinOfBone = (jointNode: number): number => skins.findIndex((skin) => skin.joints.includes(jointNode));
  const usedSkins = [
    ...new Set(plans.flatMap((plan) => (plan.skin !== undefined ? [plan.skin] : plan.bone !== undefined ? [skinOfBone(plan.bone)] : []))),
  ];
  const tableNodes = [...new Set(usedSkins.flatMap((skin) => (skins[skin] as { joints: number[] }).joints))];
  for (const jointNode of tableNodes) {
    if (!walked.has(jointNode)) throw new GlbDecodeError(`Skin joint node ${jointNode} ("${nodes[jointNode]?.name ?? ""}") is not in the scene, so it has no pose.`);
  }
  tableNodes.sort((a, b) => (walked.get(a) as { order: number }).order - (walked.get(b) as { order: number }).order);
  if (tableNodes.length > 0xffff) throw new GlbDecodeError(`The selection's skins name ${tableNodes.length} joints; at most 65535 are decoded.`);
  const tableIndex = new Map(tableNodes.map((jointNode, index) => [jointNode, index]));
  const joints: DecodedJoint[] = tableNodes.map((jointNode) => {
    const entry = walked.get(jointNode) as { world: Mat4; parent: number };
    let ancestor = entry.parent;
    while (ancestor >= 0 && !tableIndex.has(ancestor)) ancestor = (walked.get(ancestor) as { parent: number }).parent;
    return {
      name: nodes[jointNode]?.name ?? `joint${jointNode}`,
      parent: ancestor >= 0 ? (tableIndex.get(ancestor) as number) : -1,
      head: transformPoint(entry.world, 0, 0, 0),
      bind: Array.from(entry.world),
    };
  });
  /** Per used skin: each skin-local joint's table index and its skinning matrix (joint world × inverse bind). */
  const skinning = new Map<number, { table: number[]; matrices: Mat4[] }>();
  for (const skinIndex of usedSkins) {
    const skin = skins[skinIndex] as { joints: number[]; inverseBindMatrices?: number };
    const ibm = skin.inverseBindMatrices === undefined ? undefined : readFloats(skin.inverseBindMatrices, `skin ${skinIndex} inverseBindMatrices`);
    if (ibm !== undefined && (ibm.components !== 16 || ibm.count < skin.joints.length)) {
      throw new GlbDecodeError(`Skin ${skinIndex}: inverseBindMatrices must be one MAT4 per joint (${skin.joints.length}).`);
    }
    skinning.set(skinIndex, {
      table: skin.joints.map((jointNode) => tableIndex.get(jointNode) as number),
      matrices: skin.joints.map((jointNode, j) =>
        multiply((walked.get(jointNode) as { world: Mat4 }).world, ibm === undefined ? identity() : Float64Array.from(ibm.data.subarray(j * 16, j * 16 + 16))),
      ),
    });
  }
  if (textured.size > 0) {
    warnings.push(`Image textures are ignored in this build (factors and vertex colours apply): ${[...textured].sort().join(", ")}.`);
  }

  /** JOINTS_0 as u8/u16 and WEIGHTS_0 as float or normalized u8/u16 — the glTF-legal encodings, refused otherwise. */
  const readSkinAttribute = (primitive: GltfPrimitive, name: "JOINTS_0" | "WEIGHTS_0"): Float32Array => {
    const index = primitive.attributes[name] as number;
    const accessor = accessors[index];
    const legal =
      accessor !== undefined &&
      accessor.type === "VEC4" &&
      (name === "JOINTS_0"
        ? (accessor.componentType === 5121 || accessor.componentType === 5123) && accessor.normalized !== true
        : accessor.componentType === 5126 || ((accessor.componentType === 5121 || accessor.componentType === 5123) && accessor.normalized === true));
    if (!legal) {
      throw new GlbDecodeError(
        `${name}: accessor ${index} is ${accessor?.type ?? "missing"}/${accessor?.componentType ?? "?"}${accessor?.normalized === true ? " normalized" : ""}; ${name === "JOINTS_0" ? "joints are VEC4 of u8 or u16" : "weights are VEC4 of float or normalized u8/u16"}.`,
      );
    }
    return readFloats(index, name).data;
  };

  const vertexCount = plans.reduce((sum, plan) => sum + plan.vertices, 0);
  const indexCount = plans.reduce((sum, plan) => sum + plan.indices, 0);
  if (vertexCount > 0xffffffff) throw new GlbDecodeError("More than 2³² vertices.");
  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  const colors = new Float32Array(vertexCount * 4);
  const surface = new Float32Array(vertexCount * 4);
  const emissive = new Float32Array(vertexCount * 3);
  const indices = new Uint32Array(indexCount);
  const skinned = usedSkins.length > 0;

  // T1410b: the named animation, baked into the table joints' poses.
  const clipNames = (json.animations ?? []).map((animation, index) => animation.name ?? `clip${index}`);
  let pose: DecodedPose | undefined;
  if (options.clip !== undefined && options.clip !== "") {
    const clipIndex = clipNames.indexOf(options.clip);
    if (clipIndex < 0) throw new GlbDecodeError(`The file has no animation "${options.clip}"; it holds ${clipNames.length === 0 ? "none" : clipNames.map((name) => `"${name}"`).join(", ")}.`);
    if (!skinned) throw new GlbDecodeError(`Animation "${options.clip}" poses a skin's joints, and the selection holds nothing skinned.`);
    pose = bakeClip({
      animation: (json.animations ?? [])[clipIndex] as NonNullable<GltfJson["animations"]>[number],
      name: options.clip,
      rate: options.clipRate ?? 30,
      nodes,
      walked,
      tableNodes,
      readFloats,
      warnings,
    });
  }
  const jointIndices = new Uint16Array(skinned ? vertexCount * 4 : 0);
  const jointWeights = new Float32Array(skinned ? vertexCount * 4 : 0);
  let unweighted = 0;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];

  let vertexBase = 0;
  let indexBase = 0;
  let generatedNormals = 0;
  for (const plan of plans) {
    const { primitive, visit } = plan;
    const skin = plan.skin === undefined ? undefined : (skinning.get(plan.skin) as { table: number[]; matrices: Mat4[] });
    // A skinned node's own transform is ignored (glTF); its winding follows its skinning.
    const world = skin === undefined ? visit.world : (skin.matrices[0] ?? visit.world);
    const nm = normalMatrix(world);
    const jointsIn = skin === undefined ? undefined : readSkinAttribute(primitive, "JOINTS_0");
    const weightsIn = skin === undefined ? undefined : readSkinAttribute(primitive, "WEIGHTS_0");
    const pos = readFloats(primitive.attributes["POSITION"] as number, "POSITION");
    const nrmIndex = primitive.attributes["NORMAL"];
    const nrm = nrmIndex === undefined ? undefined : readFloats(nrmIndex, "NORMAL");
    const uvIndex = primitive.attributes["TEXCOORD_0"];
    const uv = uvIndex === undefined ? undefined : readFloats(uvIndex, "TEXCOORD_0");
    const colorIndex = primitive.attributes["COLOR_0"];
    const color = colorIndex === undefined ? undefined : readFloats(colorIndex, "COLOR_0");
    const material = primitive.material === undefined ? undefined : materials[primitive.material];
    const pbr = material?.pbrMetallicRoughness;
    const base = pbr?.baseColorFactor ?? [1, 1, 1, 1];
    const roughness = pbr?.roughnessFactor ?? 1;
    const metallic = pbr?.metallicFactor ?? 1;
    const strength = material?.extensions?.KHR_materials_emissive_strength?.emissiveStrength ?? 1;
    const emit = material?.emissiveFactor ?? [0, 0, 0];
    const heatRaw = material?.extras?.["loom_heat"];
    const heat = typeof heatRaw === "number" && Number.isFinite(heatRaw) ? Math.min(1, Math.max(0, heatRaw)) : 0;

    for (let v = 0; v < plan.vertices; v += 1) {
      const o = vertexBase + v;
      let m = world;
      let mn = nm;
      if (skin !== undefined && jointsIn !== undefined && weightsIn !== undefined) {
        const blended = blendSkin(skin, jointsIn, weightsIn, v, o, jointIndices, jointWeights);
        if (blended === undefined) {
          // No weight at all: placed by the skin's first joint (at rest, where every
          // skinned vertex is placed), zero weights, so no joint moves it.
          unweighted += 1;
        } else {
          m = blended;
          mn = normalMatrix(blended);
        }
      } else if (plan.bone !== undefined) {
        // T1440b: rigid on its bone, at its rest world (m stays the node's own).
        jointIndices[o * 4] = tableIndex.get(plan.bone) as number;
        jointWeights[o * 4] = 1;
      }
      const p = transformPoint(m, pos.data[v * 3] as number, pos.data[v * 3 + 1] as number, pos.data[v * 3 + 2] as number);
      positions.set(p, o * 3);
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis] as number, p[axis] as number);
        max[axis] = Math.max(max[axis] as number, p[axis] as number);
      }
      if (nrm !== undefined) {
        const [x, y, z] = [nrm.data[v * 3] as number, nrm.data[v * 3 + 1] as number, nrm.data[v * 3 + 2] as number];
        const n = normalize3([
          mn[0][0] * x + mn[1][0] * y + mn[2][0] * z,
          mn[0][1] * x + mn[1][1] * y + mn[2][1] * z,
          mn[0][2] * x + mn[1][2] * y + mn[2][2] * z,
        ]);
        normals.set(n, o * 3);
      }
      if (uv !== undefined) {
        uvs[o * 2] = uv.data[v * 2] as number;
        uvs[o * 2 + 1] = uv.data[v * 2 + 1] as number;
      }
      const cr = color === undefined ? 1 : (color.data[v * color.components] as number);
      const cg = color === undefined ? 1 : (color.data[v * color.components + 1] as number);
      const cb = color === undefined ? 1 : (color.data[v * color.components + 2] as number);
      const ca = color === undefined || color.components < 4 ? 1 : (color.data[v * 4 + 3] as number);
      colors[o * 4] = (base[0] ?? 1) * cr;
      colors[o * 4 + 1] = (base[1] ?? 1) * cg;
      colors[o * 4 + 2] = (base[2] ?? 1) * cb;
      colors[o * 4 + 3] = (base[3] ?? 1) * ca;
      surface[o * 4] = roughness;
      surface[o * 4 + 1] = metallic;
      surface[o * 4 + 2] = heat;
      surface[o * 4 + 3] = visit.part;
      emissive[o * 3] = (emit[0] ?? 0) * strength;
      emissive[o * 3 + 1] = (emit[1] ?? 0) * strength;
      emissive[o * 3 + 2] = (emit[2] ?? 0) * strength;
    }

    const localIndices = primitive.indices === undefined ? undefined : readFloats(primitive.indices, "indices");
    for (let i = 0; i < plan.indices; i += 1) {
      const local = localIndices === undefined ? i : (localIndices.data[i] as number);
      if (local >= plan.vertices) throw new GlbDecodeError(`An index (${local}) addresses past its primitive's ${plan.vertices} vertices.`);
      indices[indexBase + i] = vertexBase + local;
    }
    // A mirrored node (negative determinant) reverses winding; flip it back so the
    // front face stays front. Two-sided lighting hides it in shading, culling would not.
    const det =
      (world[0] as number) * ((world[5] as number) * (world[10] as number) - (world[9] as number) * (world[6] as number)) -
      (world[4] as number) * ((world[1] as number) * (world[10] as number) - (world[9] as number) * (world[2] as number)) +
      (world[8] as number) * ((world[1] as number) * (world[6] as number) - (world[5] as number) * (world[2] as number));
    if (det < 0) {
      for (let i = indexBase; i < indexBase + plan.indices; i += 3) {
        const swap = indices[i + 1] as number;
        indices[i + 1] = indices[i + 2] as number;
        indices[i + 2] = swap;
      }
    }
    if (nrm === undefined) {
      // Area-weighted smooth normals over this primitive's own triangles.
      generatedNormals += 1;
      for (let i = indexBase; i < indexBase + plan.indices; i += 3) {
        const a = indices[i] as number;
        const b = indices[i + 1] as number;
        const c = indices[i + 2] as number;
        const ax = positions[a * 3] as number, ay = positions[a * 3 + 1] as number, az = positions[a * 3 + 2] as number;
        const ux = (positions[b * 3] as number) - ax, uy = (positions[b * 3 + 1] as number) - ay, uz = (positions[b * 3 + 2] as number) - az;
        const vx = (positions[c * 3] as number) - ax, vy = (positions[c * 3 + 1] as number) - ay, vz = (positions[c * 3 + 2] as number) - az;
        const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
        for (const corner of [a, b, c]) {
          normals[corner * 3] = (normals[corner * 3] as number) + n[0];
          normals[corner * 3 + 1] = (normals[corner * 3 + 1] as number) + n[1];
          normals[corner * 3 + 2] = (normals[corner * 3 + 2] as number) + n[2];
        }
      }
      for (let v = vertexBase; v < vertexBase + plan.vertices; v += 1) {
        normals.set(normalize3([normals[v * 3] as number, normals[v * 3 + 1] as number, normals[v * 3 + 2] as number]), v * 3);
      }
    }
    if (visit.part !== 0) {
      const part = parts[visit.part - 1];
      if (part !== undefined) {
        if (part.vertexCount === 0) part.vertexStart = vertexBase;
        part.vertexCount = vertexBase + plan.vertices - part.vertexStart;
      }
    }
    vertexBase += plan.vertices;
    indexBase += plan.indices;
  }
  if (generatedNormals > 0) warnings.push(`${generatedNormals} primitive(s) had no NORMAL; smooth normals were generated.`);
  if (unweighted > 0) warnings.push(`${unweighted} skinned vertex(es) had no joint weight; they are placed by the skin's first joint and no joint moves them.`);

  return {
    vertexCount,
    triangleCount: indexCount / 3,
    positions,
    normals,
    uvs,
    colors,
    surface,
    emissive,
    indices,
    parts,
    cameras,
    markers,
    bounds: vertexCount === 0 ? { min: [0, 0, 0], max: [0, 0, 0] } : { min, max },
    warnings,
    ...(skinned ? { skin: { joints, indices: jointIndices, weights: jointWeights, ...(pose === undefined ? {} : { pose }) } } : {}),
    ...(clipNames.length === 0 ? {} : { clips: clipNames }),
  };
}

/**
 * T1401b — one skinned vertex: writes its four table indices and normalised weights at
 * output vertex `o`, and returns Σ weight × skinning matrix, the vertex's placement. A
 * vertex whose weights sum to nothing returns `undefined` and keeps zero weights.
 */
function blendSkin(
  skin: { readonly table: readonly number[]; readonly matrices: readonly Mat4[] },
  joints: Float32Array,
  weights: Float32Array,
  v: number,
  o: number,
  outIndices: Uint16Array,
  outWeights: Float32Array,
): Mat4 | undefined {
  let sum = 0;
  for (let k = 0; k < 4; k += 1) {
    const weight = weights[v * 4 + k] as number;
    if (weight > 0) sum += weight;
  }
  if (!(sum > 0)) return undefined;
  const blended = new Float64Array(16);
  for (let k = 0; k < 4; k += 1) {
    const raw = weights[v * 4 + k] as number;
    if (!(raw > 0)) continue;
    const local = joints[v * 4 + k] as number;
    const matrix = skin.matrices[local];
    if (matrix === undefined) throw new GlbDecodeError(`JOINTS_0 names joint ${local} of a skin with ${skin.matrices.length}.`);
    const weight = raw / sum;
    outIndices[o * 4 + k] = skin.table[local] as number;
    outWeights[o * 4 + k] = weight;
    for (let e = 0; e < 16; e += 1) blended[e] = (blended[e] as number) + weight * (matrix[e] as number);
  }
  return blended;
}
