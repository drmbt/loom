import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphNode, ProjectSettings } from "../../../domain/types/graph.ts";
import { renderHeadless } from "../../../tests/headless/render-harness.ts";
import { decodeComponents } from "../../../tests/headless/pixel-compare.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T1427b on a REAL device (§V147): the Render's Env Filter = Prefiltered.
 *
 * The bug: rough and matte surfaces read a SHARP environment through a handful of taps
 * (8 across the roughness cone, 5 for the diffuse fill), so a small bright source in the map
 * — a lamp in an HDRI — lands on some taps and not others: a rough floor shows the lamp as a
 * scatter of separate blobs, and it streaks as the surface moves. Three claims:
 *
 *  1. THE BUG AND THE FIX. A rough metal floor under a 3° lamp at 50× the sky: above half
 *     the frame's peak, Taps shows several separate regions (the lamp repeated per tap) and
 *     Prefiltered exactly one (one soft lobe), wider than all the tap blobs together.
 *  2. ENERGY. Under a UNIFORM sky every filter must give the same picture, because every
 *     average of a constant is the constant: Prefiltered is Taps to the byte over the whole
 *     frame, for a dielectric that reads both halves (specular and irradiance). A level that
 *     lost or gained light (a wrong divide, a tile read out of its rect, a clamp at the seam)
 *     fails this. And the sky really is lit into it: intensity 0 is a different picture.
 *  3. A MIRROR IS UNTOUCHED. At roughness 0 both filters read the sharp map: the same bytes.
 */

const W = 128;
const H = 64;
const settings = (format: "rgba8unorm" | "rgba16float"): ProjectSettings => ({
  outputResolution: { width: W, height: H },
  workingFormat: format,
  colorPolicy: { workingSpace: "linear", displayTransform: "none" },
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
});

/** A 3° disc toward (0, 0.8, −0.6) at 50 over a 0.02 sky, as an equirect (row 0 = zenith). */
const LAMP_SKY = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let theta = uv.y * 3.14159265;
  let phi = (uv.x - 0.5) * 6.2831853;
  let direction = vec3f(sin(theta) * sin(phi), cos(theta), -sin(theta) * cos(phi));
  let lamp = dot(direction, vec3f(0.0, 0.8, -0.6)) > cos(0.0523599);
  return vec4f(vec3f(select(0.02, 50.0, lamp)), 1.0);
}`;

/** The pointGrid laid flat: a 6 × 6 m floor at y = 0. */
const FLOOR_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x * 3.0, 0.0, -p.position.y * 3.0);
  return q;
}`;

function node(id: string, type: string, parameters: Record<string, unknown>, extra: Partial<GraphNode> = {}): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: parameters as GraphNode["parameters"], label: `${id}1`, ...extra };
}

function graph(sky: "lamp" | "uniform", material: Record<string, unknown>, render: Record<string, unknown>): GraphDocument {
  const skyNodes: GraphNode[] =
    sky === "lamp"
      ? [
          node("seed", "solid", { color: [0, 0, 0, 1] }, { resolution: { mode: "fixed", width: 512, height: 256 } } as Partial<GraphNode>),
          node("sky", "customWgsl", { source: LAMP_SKY }, { resolution: { mode: "fixed", width: 512, height: 256 } } as Partial<GraphNode>),
        ]
      : [node("sky", "solid", { color: [1, 1, 1, 1] })];
  const nodes = [
    ...skyNodes,
    node("grid", "pointGrid", { count: 1024, cols: 32, rows: 32, sizeX: 2, sizeY: 2 }),
    node("flat", "pointKernel", {
      capacity: 1024,
      seed: 7,
      attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
      kernel: FLOOR_KERNEL,
    }),
    node("mat", "materialPbr", material),
    node("geo", "geometry", { mode: "surface", material: "mat1" }),
    node("cam", "camera", { eye: [0, 1.2, 2.5], lookAt: [0, 0, -0.5], fov: 55, near: 0.1, far: 100 }),
    node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "", ambientIntensity: 0, ...render }),
    node("out", "output", {}),
  ];
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "flat", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "flat", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      e4: { id: "e4", source: { nodeId: "sky", portId: "out" }, target: { nodeId: "shot", portId: "environment" } },
      ...(sky === "lamp" ? { e5: { id: "e5", source: { nodeId: "seed", portId: "out" }, target: { nodeId: "sky", portId: "input" } } } : {}),
    },
    groups: {},
  } as never;
}

async function render(
  format: "rgba8unorm" | "rgba16float",
  sky: "lamp" | "uniform",
  material: Record<string, unknown>,
  parameters: Record<string, unknown>,
): Promise<{ bytes: Uint8Array; red: (x: number, y: number) => number }> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graph(sky, material, parameters),
    settings: settings(format),
    frames: 1,
    outputNodeId: "shot",
    outputPortId: "out",
  });
  expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  const pixels = decodeComponents(frame.bytes, frame.format);
  return { bytes: frame.bytes, red: (x, y) => pixels[(y * W + x) * 4] ?? Number.NaN };
}

/**
 * How many separate bright regions the frame holds: 4-connected pixels at or above half the
 * frame's peak. One lamp reflected by one rough surface is ONE region; a lamp repeated per
 * tap is several.
 */
function brightRegions(red: (x: number, y: number) => number): { readonly regions: number; readonly area: number } {
  let peak = 0;
  for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) peak = Math.max(peak, red(x, y));
  const bright = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H && red(x, y) >= peak / 2;
  const seen = new Set<number>();
  let regions = 0;
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      if (!bright(x, y) || seen.has(y * W + x)) continue;
      regions += 1;
      const stack = [[x, y]];
      seen.add(y * W + x);
      while (stack.length > 0) {
        const [cx, cy] = stack.pop()!;
        for (const [nx, ny] of [[cx! + 1, cy!], [cx! - 1, cy!], [cx!, cy! + 1], [cx!, cy! - 1]] as const) {
          if (bright(nx, ny) && !seen.has(ny * W + nx)) {
            seen.add(ny * W + nx);
            stack.push([nx, ny]);
          }
        }
      }
    }
  }
  return { regions, area: seen.size };
}

describe("the prefiltered environment on Dawn (T1427b, §V147)", () => {
  it("a rough floor shows a small bright lamp as several tap blobs under Taps, one soft lobe under Prefiltered", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const rough = { color: [1, 1, 1, 1], metallic: 1, roughness: 1 };
    const taps = await render("rgba16float", "lamp", rough, {});
    const prefiltered = await render("rgba16float", "lamp", rough, { environmentFilter: "prefiltered" });
    const scattered = brightRegions(taps.red);
    const lobe = brightRegions(prefiltered.red);
    expect(scattered.regions).toBeGreaterThan(1);
    expect(lobe.regions).toBe(1);
    // and it is a BLUR, not one sharp copy of the lamp: the one lobe outspreads every tap blob together
    expect(lobe.area).toBeGreaterThan(scattered.area);
  });

  it("under a uniform sky Prefiltered is Taps to the byte (energy), and the sky is really in the picture", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const dielectric = { color: [0.6, 0.6, 0.6, 1], metallic: 0, roughness: 0.7 };
    const taps = await render("rgba8unorm", "uniform", dielectric, { environmentIntensity: 0.5 });
    const prefiltered = await render("rgba8unorm", "uniform", dielectric, { environmentIntensity: 0.5, environmentFilter: "prefiltered" });
    expect(prefiltered.bytes).toEqual(taps.bytes);
    const dark = await render("rgba8unorm", "uniform", dielectric, { environmentIntensity: 0, environmentFilter: "prefiltered" });
    expect(dark.bytes).not.toEqual(prefiltered.bytes);
  });

  it("a mirror reads the sharp map under either filter: the same bytes", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const mirror = { color: [1, 1, 1, 1], metallic: 1, roughness: 0 };
    const taps = await render("rgba16float", "lamp", mirror, {});
    const prefiltered = await render("rgba16float", "lamp", mirror, { environmentFilter: "prefiltered" });
    expect(prefiltered.bytes).toEqual(taps.bytes);
  });
});

