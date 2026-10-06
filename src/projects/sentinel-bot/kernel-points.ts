import { pointStorageId } from "../../nodes/definitions/point-storage.ts";
import { kernelRegionSlice } from "../../nodes/definitions/test-support.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { edge, graph, node, settings } from "../../examples/documents/builders.ts";

/**
 * T1561b — test support: ONE KERNEL'S POINTS, read back off a real GPU.
 *
 * The places of the piece (the dock, the temple, the robots' searchlights) are point kernels, and what each owes is
 * said of the points it writes. This runs one kernel alone, over a grid when it needs one, and hands back any of
 * its attributes by name. It throws when Dawn is unavailable, with the probe's own words: it never skips.
 */

export type Vec = [number, number, number];

export interface KernelPoints {
  position(point: number): Vec;
  /** A named attribute of a point, as its components. (A vec3f is stored four wide: the first three are it.) */
  of(name: string, point: number): number[];
}

/** One kernel's points, with these parameters; over a grid when `grid` says its size. */
export async function kernelPoints(kernel: string, attributes: string, capacity: number, parameters: Record<string, number | number[]>, names: readonly string[], grid?: { cols: number; rows: number }): Promise<KernelPoints> {
  const dawnError = (await probeDawn()).error;
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const read = node("kernel_read", "pointKernel", [0, 0], { capacity, attributes, kernel, ...parameters });
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        ...(grid === undefined ? [] : [node("grid_read", "pointGrid", [0, 0], { cols: grid.cols, rows: grid.rows, count: grid.cols * grid.rows, sizeX: 2, sizeY: 2 })]),
        read,
        node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
        node("geometry_read", "geometry", [0, 0], { mode: "points", material: "material_dot" }, { label: "geometry_read" }),
        node("camera_any", "camera", [0, 0], {}, { label: "camera_any" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_read", camera: "camera_any", lights: "" }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [...(grid === undefined ? [] : [edge("grid-read", ["grid_read", "out"], ["kernel_read", "in"])]), edge("read-geo", ["kernel_read", "out"], ["geometry_read", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: 64, height: 64 } }),
    frames: 1,
    outputNodeId: "output_frame",
    probeBuffers: [pointStorageId("kernel_read")],
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const packed = (result.buffers ?? {})[pointStorageId("kernel_read")];
  if (packed === undefined) throw new Error("probe buffers missing");
  const slices = new Map(["position", ...names].map((name) => [name, kernelRegionSlice(read as never, packed, name).floats]));
  const of = (name: string, point: number): number[] => {
    const floats = slices.get(name);
    if (floats === undefined) throw new Error(`attribute ${name} was not read`);
    const stride = floats.length / capacity;
    return Array.from(floats.slice(point * stride, point * stride + stride));
  };
  return { position: (point) => of("position", point).slice(0, 3) as Vec, of };
}
