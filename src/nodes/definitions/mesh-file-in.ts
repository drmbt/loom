import type { CompiledNodeDescription, NodeDefinition, PointsetAttributeRef } from "../../domain/types/node-definition.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { meshLayout, meshSourceIdsFor } from "../../points/mesh.ts";
import { formatTopology } from "../../points/topology.ts";
import { readCompileInputs } from "./compile-context.ts";
import { readNumber } from "./parameter-readers.ts";

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
 */

const POINTS_KEY = "meshPoints";
const INDICES_KEY = "meshIndices";
const MEASURED = "Measured from the file: the loader writes it when the file is read.";

export const meshFileInNode: NodeDefinition = {
  type: "meshFileIn",
  version: 1,
  title: "Mesh File In",
  category: "points",
  description:
    "Loads a glTF binary (.glb) as a pointset: one point per vertex with position, normal, uv, color, surface (roughness, metallic, heat, part) and emissive, in world space, with the triangles riding the edge as mesh topology. Wire it to a Geometry in Surface mode to draw it, or through a Point Kernel first to move its parts — objects exported with a loom_part property carry their part's index in surface.w. Select keeps only matching object, part or material names (globs), which is how a scene bigger than one buffer splits across several of these. A skinned file also carries joints (four joint indices) and weights per vertex, with the joint table (index:name<parent@head) in Joints, for a Point Kernel to pose. Vertices, Triangles, Parts and Joints are measured from the file by the loader. Draws nothing until a file is loaded.",
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
        "Space-separated globs (* and ?) matched against each object's name, its part's name and its material's name. Empty keeps everything. Changing it re-reads the file.",
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
    return {
      passes: [],
      scratch: [
        { kind: "buffer", key: POINTS_KEY, stride: 4, capacity: layout.bytes / 4, sourceId: sources.points },
        { kind: "buffer", key: INDICES_KEY, stride: 4, capacity: triangles * 3, sourceId: sources.indices },
      ],
      pointsets: {
        out: {
          pairs,
          capacity: vertices,
          topology: formatTopology({ kind: "mesh", triangles, indexBuffer }),
        },
      },
    };
  },
};
