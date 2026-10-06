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
  /** The points of the kernel that fed this one (a `KernelSource`), in the same frame; undefined with none. */
  readonly source?: KernelPoints;
}

/** A kernel whose points are the read one's Points In: as many of them, with its own schema and parameters. */
export interface KernelSource {
  readonly kernel: string;
  readonly attributes: string;
  readonly parameters: Record<string, number | number[]>;
  /** Which of ITS attributes to hand back (its position always is). */
  readonly names: readonly string[];
}

/**
 * One kernel's points, with these parameters; over a grid when `over` says its size, or over another kernel's
 * points when it is a `KernelSource`. `frames` steps that many frames and reads the last (a thing that moves on the
 * clock is somewhere else then).
 */
export async function kernelPoints(kernel: string, attributes: string, capacity: number, parameters: Record<string, number | number[]>, names: readonly string[], over?: { cols: number; rows: number } | KernelSource, frames = 1): Promise<KernelPoints> {
  const dawnError = (await probeDawn()).error;
  if (dawnError !== undefined) throw new Error(`Dawn unavailable: ${dawnError}`);
  const grid = over !== undefined && "cols" in over ? over : undefined;
  const source = over !== undefined && "kernel" in over ? over : undefined;
  const read = node("kernel_read", "pointKernel", [0, 0], { capacity, attributes, kernel, ...parameters });
  const fed = source === undefined ? undefined : node("kernel_source", "pointKernel", [0, 0], { capacity, attributes: source.attributes, kernel: source.kernel, ...source.parameters });
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(
      [
        ...(grid === undefined ? [] : [node("grid_read", "pointGrid", [0, 0], { cols: grid.cols, rows: grid.rows, count: grid.cols * grid.rows, sizeX: 2, sizeY: 2 })]),
        ...(fed === undefined ? [] : [fed]),
        read,
        node("material_dot", "materialUnlit", [0, 0], {}, { label: "material_dot" }),
        node("geometry_read", "geometry", [0, 0], { mode: "points", material: "material_dot" }, { label: "geometry_read" }),
        node("camera_any", "camera", [0, 0], {}, { label: "camera_any" }),
        node("render_shot", "render", [0, 0], { scenes: "geometry_read", camera: "camera_any", lights: "" }, { label: "render_shot" }),
        node("output_frame", "output", [0, 0], {}, { label: "output_frame" }),
      ],
      [...(grid === undefined ? [] : [edge("grid-read", ["grid_read", "out"], ["kernel_read", "in"])]), ...(fed === undefined ? [] : [edge("source-read", ["kernel_source", "out"], ["kernel_read", "in"])]), edge("read-geo", ["kernel_read", "out"], ["geometry_read", "points"]), edge("shot-out", ["render_shot", "out"], ["output_frame", "input"])],
    ),
    settings: settings({ outputResolution: { width: 64, height: 64 } }),
    frames,
    outputNodeId: "output_frame",
    probeBuffers: [pointStorageId("kernel_read"), ...(fed === undefined ? [] : [pointStorageId("kernel_source")])],
  });
  const errors = result.diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((diagnostic) => diagnostic.message).join("; "));
  const pointsOf = (which: typeof read, wanted: readonly string[]): KernelPoints => {
    const packed = (result.buffers ?? {})[pointStorageId(which.id)];
    if (packed === undefined) throw new Error("probe buffers missing");
    const slices = new Map(["position", ...wanted].map((name) => [name, kernelRegionSlice(which as never, packed, name).floats]));
    const of = (name: string, point: number): number[] => {
      const floats = slices.get(name);
      if (floats === undefined) throw new Error(`attribute ${name} was not read`);
      const stride = floats.length / capacity;
      return Array.from(floats.slice(point * stride, point * stride + stride));
    };
    return { position: (point) => of("position", point).slice(0, 3) as Vec, of };
  };
  return { ...pointsOf(read, names), ...(fed === undefined || source === undefined ? {} : { source: pointsOf(fed, source.names) }) };
}
