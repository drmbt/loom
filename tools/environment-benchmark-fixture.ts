import type { GraphDocument, GraphNode, ProjectSettings } from "../src/domain/types/graph.ts";

export const environmentBenchmarkSettings: ProjectSettings = {
  outputResolution: { width: 512, height: 256 }, workingFormat: "rgba16float",
  colorPolicy: { workingSpace: "linear", displayTransform: "none" }, randomSeed: 7,
  previewLongEdge: 64, previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

/** The HDR lamp and rough floor from environment-prefilter.gpu.test.ts; two camera renders share the sky. */
export function environmentBenchmarkGraph(): GraphDocument {
  const node = (id: string, type: string, label: string, parameters: Record<string, unknown>, extra: Partial<GraphNode> = {}): GraphNode => ({
    id, type, label, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: parameters as GraphNode["parameters"], ...extra,
  });
  const size = { resolution: { mode: "fixed", width: 512, height: 256 } } as Partial<GraphNode>;
  const nodes = [
    node("seed", "solid", "solid_gain", { color: [1, 1, 1, 1] }, size),
    node("sky", "customWgsl", "wgsl_sky", { source: `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let theta = uv.y * 3.14159265;
  let phi = (uv.x - 0.5) * 6.2831853;
  let direction = vec3f(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
  let lamp = dot(direction, vec3f(0.0, 0.8, -0.6)) > cos(0.0523599);
  let gain = textureLoad(inputTexture, vec2i(0), 0).r;
  return vec4f(vec3f(select(0.02, 50.0, lamp) * gain), 1.0);
}` }, size),
    node("grid", "pointGrid", "grid_floor", { count: 1024, cols: 32, rows: 32, sizeX: 2, sizeY: 2 }),
    node("flat", "pointKernel", "kernel_floor", { capacity: 1024, seed: 7,
      attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
      kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p; q.position = vec3f(p.position.x * 3.0, 0.0, -p.position.y * 3.0); return q;
}` }),
    node("mat", "materialPbr", "material_floor", { color: [1, 1, 1, 1], metallic: 1, roughness: 0.85 }),
    node("geo", "geometry", "geometry_floor", { mode: "surface", material: "material_floor" }),
    node("cam", "camera", "camera_floor", { eye: [0, 1.2, 2.5], lookAt: [0, 0, -0.5], fov: 55, near: 0.1, far: 100 }),
    ...["a", "b"].flatMap(role => [
      node(`shot_${role}`, "render", `render_${role}`, { scenes: "geometry_floor", camera: "camera_floor", lights: "", ambientIntensity: 0, environmentFilter: "prefiltered" }),
      node(`out_${role}`, "output", `output_${role}`, {}),
    ]),
  ];
  const pairs = [["grid", "out", "flat", "in"], ["flat", "out", "geo", "points"], ["seed", "out", "sky", "input"],
    ...["a", "b"].flatMap(role => [["shot_" + role, "out", "out_" + role, "input"], ["sky", "out", "shot_" + role, "environment"]])];
  return { revision: 1, nodes: Object.fromEntries(nodes.map(entry => [entry.id, entry])),
    edges: Object.fromEntries(pairs.map(([sourceNode, sourcePort, targetNode, targetPort], index) => [`e${index}`, {
      id: `e${index}`, source: { nodeId: sourceNode!, portId: sourcePort! }, target: { nodeId: targetNode!, portId: targetPort! },
    }])), groups: {} } as GraphDocument;
}
