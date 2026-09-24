/**
 * T1353b — a minimal GLB WRITER for tests: builds real glTF 2.0 binaries so the decoder,
 * the node and the Dawn claims read the same container a Blender export produces, never
 * a hand-shaped object that skips the parse.
 */

export interface FixturePrimitive {
  readonly positions: ReadonlyArray<number>;
  readonly normals?: ReadonlyArray<number>;
  readonly uvs?: ReadonlyArray<number>;
  /** rgba floats per vertex. */
  readonly colors?: ReadonlyArray<number>;
  readonly indices?: ReadonlyArray<number>;
  readonly material?: number;
}

export interface FixtureNode {
  readonly name?: string;
  readonly mesh?: ReadonlyArray<FixturePrimitive>;
  readonly meshName?: string;
  readonly translation?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
  readonly extras?: Record<string, unknown>;
  readonly camera?: { readonly yfovDeg: number; readonly near: number; readonly far: number };
  readonly children?: ReadonlyArray<FixtureNode>;
}

export interface FixtureMaterial {
  readonly name: string;
  readonly baseColor?: readonly [number, number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
  readonly emissive?: readonly [number, number, number];
  readonly emissiveStrength?: number;
  readonly extras?: Record<string, unknown>;
}

export interface FixtureScene {
  readonly nodes: ReadonlyArray<FixtureNode>;
  readonly materials?: ReadonlyArray<FixtureMaterial>;
  readonly extensionsRequired?: ReadonlyArray<string>;
}

export function encodeFixtureGlb(scene: FixtureScene): Uint8Array {
  const chunks: Uint8Array[] = [];
  let binLength = 0;
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  const meshes: Array<Record<string, unknown>> = [];
  const cameras: Array<Record<string, unknown>> = [];
  const nodes: Array<Record<string, unknown>> = [];

  const addAccessor = (data: ReadonlyArray<number>, type: string, componentType: 5126 | 5125): number => {
    const typed = componentType === 5126 ? new Float32Array(data) : new Uint32Array(data);
    const bytes = new Uint8Array(typed.buffer);
    const padded = (bytes.byteLength + 3) & ~3;
    const chunk = new Uint8Array(padded);
    chunk.set(bytes);
    bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes.byteLength });
    chunks.push(chunk);
    binLength += padded;
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type] ?? 1;
    const accessor: Record<string, unknown> = {
      bufferView: bufferViews.length - 1,
      componentType,
      count: data.length / components,
      type,
    };
    if (type === "VEC3" && componentType === 5126) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i += 3) {
        for (let c = 0; c < 3; c += 1) {
          min[c] = Math.min(min[c] as number, data[i + c] as number);
          max[c] = Math.max(max[c] as number, data[i + c] as number);
        }
      }
      accessor["min"] = min;
      accessor["max"] = max;
    }
    accessors.push(accessor);
    return accessors.length - 1;
  };

  const addNode = (node: FixtureNode): number => {
    const out: Record<string, unknown> = {};
    if (node.name !== undefined) out["name"] = node.name;
    if (node.translation !== undefined) out["translation"] = [...node.translation];
    if (node.rotation !== undefined) out["rotation"] = [...node.rotation];
    if (node.scale !== undefined) out["scale"] = [...node.scale];
    if (node.extras !== undefined) out["extras"] = node.extras;
    if (node.mesh !== undefined) {
      const primitives = node.mesh.map((primitive) => {
        const attributes: Record<string, number> = { POSITION: addAccessor(primitive.positions, "VEC3", 5126) };
        if (primitive.normals !== undefined) attributes["NORMAL"] = addAccessor(primitive.normals, "VEC3", 5126);
        if (primitive.uvs !== undefined) attributes["TEXCOORD_0"] = addAccessor(primitive.uvs, "VEC2", 5126);
        if (primitive.colors !== undefined) attributes["COLOR_0"] = addAccessor(primitive.colors, "VEC4", 5126);
        const encoded: Record<string, unknown> = { attributes };
        if (primitive.indices !== undefined) encoded["indices"] = addAccessor(primitive.indices, "SCALAR", 5125);
        if (primitive.material !== undefined) encoded["material"] = primitive.material;
        return encoded;
      });
      meshes.push({ ...(node.meshName === undefined ? {} : { name: node.meshName }), primitives });
      out["mesh"] = meshes.length - 1;
    }
    if (node.camera !== undefined) {
      cameras.push({
        type: "perspective",
        perspective: { yfov: (node.camera.yfovDeg * Math.PI) / 180, znear: node.camera.near, zfar: node.camera.far, aspectRatio: 16 / 9 },
      });
      out["camera"] = cameras.length - 1;
    }
    const index = nodes.length;
    nodes.push(out);
    if (node.children !== undefined && node.children.length > 0) {
      out["children"] = node.children.map(addNode);
    }
    return index;
  };

  const roots = scene.nodes.map(addNode);
  const materials = (scene.materials ?? []).map((material) => ({
    name: material.name,
    pbrMetallicRoughness: {
      baseColorFactor: [...(material.baseColor ?? [1, 1, 1, 1])],
      metallicFactor: material.metallic ?? 0,
      roughnessFactor: material.roughness ?? 0.5,
    },
    ...(material.emissive === undefined ? {} : { emissiveFactor: [...material.emissive] }),
    ...(material.emissiveStrength === undefined
      ? {}
      : { extensions: { KHR_materials_emissive_strength: { emissiveStrength: material.emissiveStrength } } }),
    ...(material.extras === undefined ? {} : { extras: material.extras }),
  }));

  const json: Record<string, unknown> = {
    asset: { version: "2.0", generator: "loom glb.fixture" },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    ...(meshes.length === 0 ? {} : { meshes }),
    ...(cameras.length === 0 ? {} : { cameras }),
    ...(materials.length === 0 ? {} : { materials }),
    ...(accessors.length === 0 ? {} : { accessors, bufferViews, buffers: [{ byteLength: binLength }] }),
    ...(scene.extensionsRequired === undefined ? {} : { extensionsRequired: [...scene.extensionsRequired], extensionsUsed: [...scene.extensionsRequired] }),
  };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPadded = (jsonBytes.byteLength + 3) & ~3;
  const total = 12 + 8 + jsonPadded + (binLength > 0 ? 8 + binLength : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonPadded, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.byteLength, 20 + jsonPadded);
  if (binLength > 0) {
    let at = 20 + jsonPadded;
    view.setUint32(at, binLength, true);
    view.setUint32(at + 4, 0x004e4942, true);
    at += 8;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
  }
  return out;
}

/** A unit cube (±0.5) as 24 vertices / 12 triangles with face normals — the fixture workhorse. */
export function cubePrimitive(material?: number): FixturePrimitive {
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const faces: Array<{ n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }> = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ];
  for (const face of faces) {
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
      positions.push(
        face.n[0] * 0.5 + face.u[0] * su * 0.5 + face.v[0] * sv * 0.5,
        face.n[1] * 0.5 + face.u[1] * su * 0.5 + face.v[1] * sv * 0.5,
        face.n[2] * 0.5 + face.u[2] * su * 0.5 + face.v[2] * sv * 0.5,
      );
      normals.push(...face.n);
      uvs.push((su + 1) / 2, (sv + 1) / 2);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, uvs, indices, ...(material === undefined ? {} : { material }) };
}
