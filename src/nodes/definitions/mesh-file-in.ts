import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { MESH_ATTRIBUTES, meshLayout, meshSourceIdsFor } from "../../points/mesh.ts";
import { formatTopology } from "../../points/topology.ts";
import { MESH_CLIP_WGSL } from "../shaders/mesh-clip.wgsl.ts";
import { readCompileInputs } from "./compile-context.ts";
import { readFlag, readNumber } from "./parameter-readers.ts";
import { attributeBinding, packedPointStorage } from "./point-storage.ts";

/**
 * T1353b — MESH FILE IN: a glTF binary as a POINTSET. TouchDesigner's File In POP.
 *
 * Every vertex is a point carrying `position`, `normal`, `uv`, `color`, `surface`
 * (roughness, metallic, heat, part) and `emissive`, in world space with the file's node
 * transforms baked. The connectivity rides the edge as a `mesh:` topology claim naming
 * this node's index buffer, so a Geometry in Surface mode draws the triangles — and
 * everything between can treat the vertices as points: a Point Kernel animates a part
 * (`p.surface.w` is its index) or tears the mesh apart, and the claim survives it.
 *
 * ## Sizes are parameters, bytes are a source
 *
 * Compilation is pure and cannot open a file, but a buffer's size is structural. So the
 * node carries what it was sized for — Vertices, Triangles, Parts — as compile-time
 * parameters the LOADER writes through the bus when it reads the file (the Movie File In
 * idiom: its intrinsic resolution lands on the node the same way). The bytes arrive at run
 * time under `meshSourceIdsFor(nodeId)` (§V135: the plan carries keys, never bytes). Until
 * they do the index buffer is zero — every triangle degenerate — so the node draws nothing
 * rather than garbage.
 *
 * ## A skinned file (T1401b)
 *
 * When the selection holds a glTF skin the loader also writes Joints — the decoded joint
 * table, `index:name<parent@head` — and a non-empty Joints is what sizes the buffer for two
 * more attributes: `joints` (four table indices, as floats) and `weights` (their weights,
 * sum 1; zero on a vertex nothing skins). The vertices stay at the bind pose; posing is a
 * Point Kernel's work, reading `p.joints`/`p.weights` and turning each joint about its head.
 *
 * ## A clip (T1410b)
 *
 * Clip names one of the file's animations (Clips lists them). The loader bakes it into a pose
 * table — each joint's delta at Clip Rate samples a second, Clip Frames of them — fed as a
 * third buffer, and one compute pass poses every vertex at the frame clock: the published
 * `position` and `normal` are the performance, the rest (joints, weights, …) ride as before,
 * so a kernel downstream still turns the posed figure (a yaw, a place, a knob on top).
 */

const POINTS_KEY = "meshPoints";
const INDICES_KEY = "meshIndices";
const POSE_KEY = "meshPose";
const MEASURED = "Measured from the file: the loader writes it when the file is read.";

export const meshFileInNode: NodeDefinition = {
  type: "meshFileIn",
  version: 1,
  title: "Mesh File In",
  category: "points",
  description:
    "Loads a glTF binary (.glb) as a pointset: one point per vertex with position, normal, uv, color, surface (roughness, metallic, heat, part) and emissive, in world space, with the triangles riding the edge as mesh topology. Wire it to a Geometry in Surface mode to draw it, or through a Point Kernel first to move its parts — objects exported with a loom_part property carry their part's index in surface.w. Select keeps only matching object, part or material names (globs), which is how a scene bigger than one buffer splits across several of these. A skinned file also carries joints (four joint indices) and weights per vertex, with the joint table (index:name<parent@head) in Joints, for a Point Kernel to pose; an unskinned object parented to a bone (sunglasses on the head) is bound wholly to that joint, so it rides the pose. Vertices, Triangles, Parts and Joints are measured from the file by the loader. Draws nothing until a file is loaded.",
  tags: ["mesh", "gltf", "glb", "file", "import", "blender", "geometry", "points", "skin", "skeleton", "rig"],
  inputs: [],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: { kind: "pointset", requires: [{ name: "position", type: "vec3f" }, { name: "normal", type: "vec3f" }] },
    },
  ],
  parameters: {
    file: { type: "asset", label: "File", kind: "gltf", group: "File" },
    select: {
      type: "string",
      label: "Select",
      default: "",
      group: "File",
      compileTime: true,
      description:
        "Space-separated globs (* and ?) matched against each object's name, its part's name and its material's name; a leading ! drops what matches. Empty keeps everything. Changing it re-reads the file and re-measures Vertices, Triangles, Parts and Joints for what it keeps (the app's loader and offline renders alike, T1416b).",
    },
    vertices: {
      type: "number",
      label: "Vertices",
      default: 0,
      min: 0,
      step: 1,
      range: "floor",
      group: "File",
      compileTime: true,
      inactiveWhen: () => MEASURED,
    },
    triangles: {
      type: "number",
      label: "Triangles",
      default: 0,
      min: 0,
      step: 1,
      range: "floor",
      group: "File",
      compileTime: true,
      inactiveWhen: () => MEASURED,
    },
    parts: {
      type: "string",
      label: "Parts",
      default: "",
      group: "File",
      compileTime: true,
      description: "index:name for every loom_part the selection holds — the numbers a kernel branches on (surface.w).",
      inactiveWhen: () => MEASURED,
    },
    clip: {
      type: "string",
      label: "Clip",
      default: "",
      group: "Clip",
      compileTime: true,
      description:
        "T1410b: the glTF animation to play, by name (Clips lists the file's). Its joint poses are baked at Clip Rate and pose every vertex at the frame clock — a Blender-authored performance, no kernel. Empty = the rest pose. Needs a skinned selection.",
    },
    clipRate: {
      type: "number",
      label: "Clip Rate",
      default: 30,
      min: 1,
      max: 240,
      range: "bounded",
      group: "Clip",
      compileTime: true,
      description: "Samples per second the clip is baked at; between two the pose blends linearly. The clip's own key rate is exact.",
    },
    clipSpeed: { type: "number", label: "Clip Speed", default: 1, group: "Clip", description: "Seconds of clip per second of the frame clock (absTime)." },
    clipOffset: { type: "number", label: "Clip Offset", default: 0, group: "Clip", unit: "seconds", description: "Clip time at absTime 0." },
    clipLoop: { type: "boolean", label: "Clip Loop", default: true, group: "Clip", description: "Wrap over the baked span; off holds the last pose." },
    clips: {
      type: "string",
      label: "Clips",
      default: "",
      group: "Clip",
      compileTime: true,
      description: "The file's animation names, space-separated.",
      inactiveWhen: () => MEASURED,
    },
    clipFrames: {
      type: "number",
      label: "Clip Frames",
      default: 0,
      min: 0,
      step: 1,
      range: "floor",
      group: "Clip",
      compileTime: true,
      description: "Frames in the baked pose table; sizes its buffer.",
      inactiveWhen: () => MEASURED,
    },
    joints: {
      type: "string",
      label: "Joints",
      default: "",
      group: "File",
      compileTime: true,
      description:
        "The skin's joint table, index:name<parent@x,y,z (the rest head in world metres) — the numbers p.joints holds. Empty when the selection is unskinned; non-empty adds the joints and weights attributes.",
      inactiveWhen: () => MEASURED,
    },
  },
  compile(context): CompiledNodeDescription {
    const { nodeId, parameters } = readCompileInputs(context as Parameters<typeof readCompileInputs>[0]);
    const measuredVertices = Math.max(0, Math.round(readNumber(parameters, "vertices", 0)));
    const measuredTriangles = Math.max(0, Math.round(readNumber(parameters, "triangles", 0)));
    /* Nothing loaded is a NORMAL state, the Movie File In one: the node still publishes a
       pointset (one vertex, one triangle, all zero until fed — degenerate, so it draws
       nothing) and the graph downstream keeps compiling, instead of every consumer
       failing on a missing edge the user has not had a chance to fill yet. */
    const empty = measuredVertices === 0 || measuredTriangles === 0;
    const vertices = empty ? 1 : measuredVertices;
    const triangles = empty ? 1 : measuredTriangles;
    const skinned = typeof parameters["joints"] === "string" && parameters["joints"].trim() !== "";
    const layout = meshLayout(vertices, skinned);
    if (!layout.ok) {
      return {
        passes: [],
        diagnostics: layout.errors.map((error) => ({
          severity: "error" as const,
          code: "node.mesh.size",
          message: `Node "${nodeId}": ${error}`,
          nodeId,
          suggestion: "Split the file across several Mesh File In nodes with Select (by object, part or material name).",
        })),
      };
    }
    const sources = meshSourceIdsFor(nodeId);
    const pointsBuffer = scratchResourceId(nodeId, POINTS_KEY);
    const indexBuffer = scratchResourceId(nodeId, INDICES_KEY);
    const pairs: Record<string, PointsetAttributeRef> = {};
    for (const region of layout.regions) {
      // A fed buffer is written once and never swapped, so its one half IS both halves;
      // "read" is the honest name for data this frame did not produce.
      pairs[region.name] = { buffer: pointsBuffer, half: "read", offset: region.offset, bytes: region.bytes, type: region.type };
    }
    const clip = playClip(nodeId, parameters, { vertices, skinned, empty, rest: pairs, poseSource: sources.pose });
    if ("refusal" in clip) return { passes: [], diagnostics: [clip.refusal] };
    return {
      passes: clip.passes,
      scratch: [
        { kind: "buffer", key: POINTS_KEY, stride: 4, capacity: layout.bytes / 4, sourceId: sources.points },
        { kind: "buffer", key: INDICES_KEY, stride: 4, capacity: triangles * 3, sourceId: sources.indices },
        ...clip.scratch,
      ],
      pointsets: {
        out: {
          pairs: { ...pairs, ...clip.pairs },
          capacity: vertices,
          topology: formatTopology({ kind: "mesh", triangles, indexBuffer }),
        },
      },
    };
  },
};

/**
 * T1410b — the clip pass, when Clip names a baked animation: the pose table as a third fed
 * buffer and one dispatch writing posed `position` and `normal` into this node's own storage,
 * which replace the rest pairs on the edge. Nothing chosen (or nothing baked yet — the loader
 * has not measured Clip Frames) is the rest pose, exactly the node without a clip.
 */
function playClip(
  nodeId: string,
  parameters: Readonly<Record<string, unknown>>,
  mesh: { readonly vertices: number; readonly skinned: boolean; readonly empty: boolean; readonly rest: Readonly<Record<string, PointsetAttributeRef>>; readonly poseSource: string },
):
  | { readonly passes: DispatchPassDescriptor[]; readonly scratch: Array<{ kind: "buffer"; key: string; stride: number; capacity: number; sourceId: string } | { kind: "bufferPair"; key: string; stride: number; capacity: number }>; readonly pairs: Record<string, PointsetAttributeRef> }
  | { readonly refusal: { severity: "error"; code: string; message: string; nodeId: string; suggestion: string } } {
  const none = { passes: [], scratch: [], pairs: {} };
  const name = typeof parameters["clip"] === "string" ? parameters["clip"].trim() : "";
  if (name === "" || mesh.empty) return none;
  if (!mesh.skinned) {
    return {
      refusal: {
        severity: "error",
        code: "node.mesh.clip",
        message: `Node "${nodeId}": Clip "${name}" poses a skin's joints, and this selection is not skinned (Joints is empty).`,
        nodeId,
        suggestion: "Select the skinned object (the one with an Armature), or clear Clip.",
      },
    };
  }
  const frames = Math.max(0, Math.round(readNumber(parameters as never, "clipFrames", 0)));
  const joints = (typeof parameters["joints"] === "string" ? parameters["joints"] : "").split(/\s+/).filter((entry) => entry !== "").length;
  if (frames === 0 || joints === 0) return none;
  const storage = packedPointStorage(nodeId, MESH_ATTRIBUTES.filter((attribute) => attribute.name === "position" || attribute.name === "normal"), mesh.vertices, "write");
  if (!storage.ok) {
    return { refusal: { severity: "error", code: "node.mesh.size", message: `Node "${nodeId}": ${storage.errors.join(" ")}`, nodeId, suggestion: "Split the file with Select." } };
  }
  const rest = (attribute: string): PointsetAttributeRef => mesh.rest[attribute] as PointsetAttributeRef;
  const pass: DispatchPassDescriptor = {
    kind: "dispatch",
    id: `${nodeId}:clip`,
    shader: MESH_CLIP_WGSL,
    entryPoint: "main",
    workgroups: [Math.ceil(mesh.vertices / 64), 1, 1],
    buffers: [
      attributeBinding("in_position", rest("position")),
      attributeBinding("in_normal", rest("normal")),
      attributeBinding("in_joints", rest("joints")),
      attributeBinding("in_weights", rest("weights")),
      { binding: "pose", resourceId: scratchResourceId(nodeId, POSE_KEY) },
      attributeBinding("out_position", storage.pairs["position"] as PointsetAttributeRef),
      attributeBinding("out_normal", storage.pairs["normal"] as PointsetAttributeRef),
    ],
    uniforms: {
      count: mesh.vertices,
      joints,
      frames,
      looping: readFlag(parameters as never, "clipLoop", true),
      rate: Math.max(1, readNumber(parameters as never, "clipRate", 30)),
      speed: readNumber(parameters as never, "clipSpeed", 1),
      offset: readNumber(parameters as never, "clipOffset", 0),
      // Declared so the backend writes the absolute clock here every frame (T489).
      absTimeSeconds: 0,
    },
    uniformBinding: "params",
    nodeId,
  };
  return {
    passes: [pass],
    scratch: [{ kind: "buffer", key: POSE_KEY, stride: 16, capacity: frames * joints * 3, sourceId: mesh.poseSource }, storage.scratch],
    pairs: { position: storage.pairs["position"] as PointsetAttributeRef, normal: storage.pairs["normal"] as PointsetAttributeRef },
  };
}
