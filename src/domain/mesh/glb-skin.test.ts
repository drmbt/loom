import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { decodeGlb } from "./glb.ts";
import { cubePrimitive, encodeFixtureGlb, type FixtureScene } from "./glb.fixture.ts";
import { meshLayout, prepareMesh } from "../../points/mesh.ts";

/**
 * T1401b — glTF SKINS in the decoder.
 */

const SQRT1_2 = Math.SQRT1_2;

/** A scene that walks every unskinned path the decoder has: hierarchy, mirror, parts, camera, marker, materials. */
const UNSKINNED: FixtureScene = {
  materials: [
    { name: "paint", baseColor: [1, 0.5, 0.25, 1], roughness: 0.3, metallic: 0.7, extras: { loom_heat: 0.5 } },
    { name: "lamp", baseColor: [0.2, 0.2, 0.2, 1], emissive: [1, 0.5, 0.1], emissiveStrength: 4 },
  ],
  nodes: [
    {
      name: "root",
      translation: [1, 2, 3],
      rotation: [0, SQRT1_2, 0, SQRT1_2],
      children: [
        { name: "body", scale: [2, 1, 0.5], mesh: [cubePrimitive(0)] },
        { name: "door", extras: { loom_part: "door" }, translation: [0, 1, 0], mesh: [cubePrimitive(1)], children: [{ name: "handle", extras: { loom_part: "handle", loom_parent: "door" }, mesh: [cubePrimitive(0)] }] },
        { name: "emit.spark", translation: [0, 3, 0], extras: { loom_kind: "spark" } },
      ],
    },
    { name: "mirror", scale: [-1, 1, 1], mesh: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], colors: [1, 0, 0, 1, 0, 1, 0, 1, 0, 0, 1, 0.5], indices: [0, 1, 2] }] },
    { name: "bare", mesh: [{ positions: [0, 0, 0, 1, 0, 0, 0, 0, -1] }] },
    { name: "shot.a", translation: [0, 1, 5], camera: { yfovDeg: 40, near: 0.1, far: 50 } },
  ],
};

function digest(glb: Uint8Array): string {
  const hash = createHash("sha256");
  const mesh = decodeGlb(glb);
  hash.update(JSON.stringify(Object.keys(mesh)));
  for (const array of [mesh.positions, mesh.normals, mesh.uvs, mesh.colors, mesh.surface, mesh.emissive, mesh.indices]) {
    hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
  }
  hash.update(JSON.stringify([mesh.vertexCount, mesh.triangleCount, mesh.parts, mesh.cameras, mesh.markers, mesh.bounds, mesh.warnings]));
  const prepared = prepareMesh(glb, "");
  if (prepared === null) throw new Error("fixture is empty");
  // The facts as they were before skins (T1401b adds `joints`, asserted empty on its own).
  hash.update(JSON.stringify({ vertices: prepared.facts.vertices, triangles: prepared.facts.triangles, parts: prepared.facts.parts }));
  hash.update(prepared.points);
  hash.update(prepared.indices);
  return hash.digest("hex");
}

/** Column-major translation. */
const translate = (x: number, y: number, z: number): number[] => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

/**
 * A two-joint leg. The walk is armature → hip → offset (NOT a joint) → knee, so the knee's
 * parent in the table is found THROUGH a non-joint node. The skin lists knee before hip, so
 * the table (walk order) must remap skin-local indices. The skinned node sits at (5, 5, 5),
 * which glTF says to ignore. Heads: hip (0, 1, 0), knee (0.1, 0.5, 0); the IBMs are their
 * inverse rest worlds, so at rest joint world × IBM is the identity.
 */
function leg(options: { kneeTurn?: boolean; jointsComponent?: 5121 | 5123; weightsComponent?: 5126 | 5121 | 5123; extra?: FixtureScene["nodes"] } = {}): FixtureScene {
  const q = Math.SQRT1_2;
  return {
    skins: [{ joints: ["knee", "hip"], inverseBindMatrices: [translate(-0.1, -0.5, 0), translate(0, -1, 0)] }],
    nodes: [
      {
        name: "armature",
        translation: [0, 1, 0],
        children: [
          {
            name: "hip",
            children: [{ name: "offset", translation: [0.1, 0, 0], children: [{ name: "knee", translation: [0, -0.5, 0], ...(options.kneeTurn === true ? { rotation: [0, 0, q, q] as const } : {}) }] }],
          },
        ],
      },
      {
        name: "body",
        translation: [5, 5, 5],
        skin: 0,
        mesh: [
          {
            // v0 on the hip; v1 at the knee head; v2 below the knee; v3 split hip/knee (raw 0.25 + 0.25).
            positions: [0, 1, 0, 0.1, 0.5, 0, 0.1, 0, 0, 0.1, 0, 0],
            normals: [0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1],
            indices: [0, 1, 2, 1, 2, 3],
            // skin-local: 0 = knee, 1 = hip
            joints: [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0],
            weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0.25, 0.25, 0, 0],
            ...(options.jointsComponent === undefined ? {} : { jointsComponent: options.jointsComponent }),
            ...(options.weightsComponent === undefined ? {} : { weightsComponent: options.weightsComponent }),
          },
        ],
      },
      { name: "emit.spot", translation: [0, 2, 0] },
      ...(options.extra ?? []),
    ],
  };
}

const quad = (array: Float32Array | Uint16Array, vertex: number): number[] => Array.from(array.subarray(vertex * 4, vertex * 4 + 4));
const point = (array: Float32Array, vertex: number): number[] => Array.from(array.subarray(vertex * 3, vertex * 3 + 3)).map((x) => Math.round(x * 1e6) / 1e6 + 0);

describe("decodeGlb skins (T1401b)", () => {
  it("decodes an unskinned file byte-identically to the decoder before skins (pinned digest)", () => {
    // The digest was taken with the pre-T1401b decoder, fixture writer and packer (HEAD
    // 29a9c425). Any drift on the unskinned path — a changed placement, an extra key on the
    // output, a moved attribute region — changes it.
    expect(digest(encodeFixtureGlb(UNSKINNED))).toBe("409524a4e8100e4d02503c71750d09cd72c7711f75326f288d3ede667f7247e6");
    const mesh = decodeGlb(encodeFixtureGlb(UNSKINNED));
    expect(mesh.skin).toBeUndefined();
    expect(prepareMesh(encodeFixtureGlb(UNSKINNED), "")?.facts.joints).toBe("");
  });

  it("builds ONE joint table in walk order: parents found through non-joint nodes, rest heads and bind matrices from the hierarchy", () => {
    const mesh = decodeGlb(encodeFixtureGlb(leg()));
    const skin = mesh.skin;
    if (skin === undefined) throw new Error("expected a skin");
    expect(skin.joints.map((joint) => [joint.name, joint.parent])).toEqual([["hip", -1], ["knee", 0]]);
    expect(skin.joints.map((joint) => joint.head.map((x) => Math.round(x * 1e6) / 1e6))).toEqual([[0, 1, 0], [0.1, 0.5, 0]]);
    // The bind matrix is the joint's world matrix: identity rotation, the head as translation.
    expect(skin.joints[1]?.bind).toEqual(translate(0.1, 0.5, 0).map((x, i) => (i === 12 ? expect.closeTo(x, 12) : x)));
    // A joint is a bone, not a marker; a real marker still is one.
    expect(mesh.markers.map((marker) => marker.name)).toEqual(["emit.spot"]);
  });

  it("remaps each vertex's skin-local joints onto the table and normalises its four weights", () => {
    const skin = decodeGlb(encodeFixtureGlb(leg())).skin!;
    // skin-local 1 (hip) is table 0; skin-local 0 (knee) is table 1.
    expect(quad(skin.indices, 0)).toEqual([0, 0, 0, 0]);
    expect(quad(skin.weights, 0)).toEqual([1, 0, 0, 0]);
    expect(quad(skin.indices, 2)).toEqual([1, 0, 0, 0]);
    // v3's file pair (hip, knee) = local (1, 0) → table (0, 1).
    expect(quad(skin.indices, 3)).toEqual([0, 1, 0, 0]);
    // 0.25 + 0.25 in the file is half and half after normalisation.
    expect(quad(skin.weights, 3)).toEqual([0.5, 0.5, 0, 0]);
  });

  it("places skinned vertices by Σ weight × joint world × inverse bind: at rest exactly where the mesh says, the skinned node's own transform ignored", () => {
    const mesh = decodeGlb(encodeFixtureGlb(leg()));
    // Not shifted by the body node's (5, 5, 5).
    expect([0, 1, 2, 3].map((v) => point(mesh.positions, v))).toEqual([[0, 1, 0], [0.1, 0.5, 0], [0.1, 0, 0], [0.1, 0, 0]]);
  });

  it("follows the file's pose: a knee turned 90° about Z carries its vertices and normals round its head, and a split vertex lands halfway", () => {
    const mesh = decodeGlb(encodeFixtureGlb(leg({ kneeTurn: true })));
    // v2 is (0, −0.5, 0) from the knee head (0.1, 0.5, 0); +90° about Z takes it to (0.5, 0, 0).
    expect(point(mesh.positions, 2)).toEqual([0.6, 0.5, 0]);
    // v3 is half hip (rest: (0.1, 0, 0)), half knee ((0.6, 0.5, 0)) — linear blend.
    expect(point(mesh.positions, 3)).toEqual([0.35, 0.25, 0]);
    // v0 is all hip, which did not move.
    expect(point(mesh.positions, 0)).toEqual([0, 1, 0]);
    // v2's normal +X turns onto +Y with the knee.
    expect(point(mesh.normals, 2)).toEqual([0, 1, 0]);
    // The knee's rest head is where the turned knee is — the table and the vertices agree on one pose.
    expect(mesh.skin!.joints[1]!.head.map((x) => Math.round(x * 1e6) / 1e6)).toEqual([0.1, 0.5, 0]);
  });

  it("reads JOINTS_0 as u8 or u16 and WEIGHTS_0 as float or normalized u8/u16 to the same skin", () => {
    const reference = decodeGlb(encodeFixtureGlb(leg())).skin!;
    for (const [jointsComponent, weightsComponent] of [[5121, 5121], [5123, 5123], [5121, 5126]] as const) {
      const skin = decodeGlb(encodeFixtureGlb(leg({ jointsComponent, weightsComponent }))).skin!;
      expect(Array.from(skin.indices)).toEqual(Array.from(reference.indices));
      // 0.25 quantizes to 64/255 or 16384/65535 — equal pairs, so still exactly half after normalising.
      expect(Array.from(skin.weights)).toEqual(Array.from(reference.weights));
    }
  });

  it("gives a vertex the selection holds unskinned zero weights, so nothing moves it", () => {
    const mesh = decodeGlb(encodeFixtureGlb(leg({ extra: [{ name: "rock", translation: [2, 0, 0], mesh: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] }] })));
    expect(mesh.vertexCount).toBe(7);
    expect(quad(mesh.skin!.weights, 4)).toEqual([0, 0, 0, 0]);
    expect(point(mesh.positions, 4)).toEqual([2, 0, 0]);
    // Selected alone, the rock is an unskinned file's rock: no skin at all.
    expect(decodeGlb(encodeFixtureGlb(leg({ extra: [{ name: "rock", mesh: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0] }] }] })), { select: "rock" }).skin).toBeUndefined();
  });

  it("T1440b: binds a prop parented to a bone rigidly to it, and a prop selected alone indexes the body's table", () => {
    // Blender's Bone parent exports the prop as an unskinned child of the joint node.
    const scene: FixtureScene = {
      skins: [{ joints: ["hip", "knee"] }],
      nodes: [
        { name: "hip", translation: [0, 1, 0], children: [{ name: "knee", translation: [0, -0.5, 0], children: [{ name: "pad", translation: [0, -0.2, 0], mesh: [{ positions: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2] }] }] }] },
        { name: "body", skin: 0, mesh: [{ positions: [0, 1, 0, 0, 0.5, 0, 0, 0, 0], indices: [0, 1, 2], joints: [0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0], weights: [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0] }] },
      ],
    };
    const glb = encodeFixtureGlb(scene);
    const whole = decodeGlb(glb);
    // The pad is walked first (under the hip): vertices 0..2, at its rest world, all knee.
    expect([0, 1, 2].map((v) => point(whole.positions, v))).toEqual([[0, 0.3, 0], [1, 0.3, 0], [0, 1.3, 0]]);
    expect([0, 1, 2].map((v) => [...quad(whole.skin!.indices, v), ...quad(whole.skin!.weights, v)])).toEqual(Array.from({ length: 3 }, () => [1, 0, 0, 0, 1, 0, 0, 0]));
    // Alone, the pad still carries the skin's whole table — the same one the body's kernel reads.
    const alone = prepareMesh(glb, "pad");
    expect(alone?.facts.vertices).toBe(3);
    expect(alone?.facts.joints).toBe(prepareMesh(glb, "")?.facts.joints);
    expect(alone?.facts.joints).toBe("0:hip@0,1,0 1:knee<0@0,0.5,0");
    expect(quad(alone!.mesh.skin!.indices, 0)).toEqual([1, 0, 0, 0]);
  });

  it("publishes the table as the node's Joints fact and packs joints/weights after the six unskinned regions", () => {
    const glb = encodeFixtureGlb(leg());
    const prepared = prepareMesh(glb, "");
    if (prepared === null) throw new Error("empty");
    expect(prepared.facts.joints).toBe("0:hip@0,1,0 1:knee<0@0.1,0.5,0");
    const skinnedLayout = meshLayout(4, true);
    const plainLayout = meshLayout(4);
    if (!skinnedLayout.ok || !plainLayout.ok) throw new Error("layout");
    // Every unskinned region keeps its offset; the two new ones follow.
    for (const region of plainLayout.regions) expect(skinnedLayout.byName.get(region.name)?.offset).toBe(region.offset);
    expect(prepared.points.byteLength).toBe(skinnedLayout.bytes);
    const words = new Float32Array(prepared.points.buffer, prepared.points.byteOffset, prepared.points.byteLength / 4);
    const read = (name: string, vertex: number): number[] => {
      const region = skinnedLayout.byName.get(name)!;
      const at = region.offset / 4 + vertex * (region.stride / 4);
      return Array.from(words.subarray(at, at + 4));
    };
    expect(read("joints", 2)).toEqual([1, 0, 0, 0]);
    expect(read("weights", 3)).toEqual([0.5, 0.5, 0, 0]);
  });

  it("refuses by name what it still cannot decode: more than four influences, morph targets", () => {
    const eight = leg();
    const body = eight.nodes[1]!;
    const withMore: FixtureScene = { ...eight, nodes: [eight.nodes[0]!, { ...body, mesh: [{ ...body.mesh![0]!, extraAttributes: ["JOINTS_1"] }] }] };
    expect(() => decodeGlb(encodeFixtureGlb(withMore))).toThrowError(/JOINTS_1: more than four influences/);
    const morph: FixtureScene = { nodes: [{ name: "blob", mesh: [{ ...cubePrimitive(), morphTargets: true }] }] };
    expect(() => decodeGlb(encodeFixtureGlb(morph))).toThrowError(/morph targets/);
  });
});
