import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import type { GraphDocument, ProjectSettings } from "../../../domain/types/graph.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";

/**
 * AN INDIRECT DRAW IS A DRAW OF ITS FRAME, in plan order (found on the way to T1581b's F1).
 *
 * A geometry over a COUNTED pointset draws indirect: the GPU reads the instance count from a
 * buffer. The backend used to hand that draw to vgpu's `Draw.draw()`, which builds its own
 * command buffer, CLEARS its target and submits at once. Inside a Render that is wrong twice:
 *
 *  - on the direct path (export, every headless render) the draw cleared the backdrop and
 *    every geometry drawn before it;
 *  - on the loop path (the app: one open frame) it ran BEFORE the frame's own passes, so the
 *    backdrop's clear then erased it.
 *
 * Nothing saw either, because every counted geometry under test stood alone on black. Here
 * a counted set of boxes shares a Render with a backdrop and a literal Surface, in both
 * draw orders and on both paths, and the claim is the whole picture.
 */

const SIZE = 64;
const UNIT = 8;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};
const CAPABILITIES = { tier: "B", features: [], formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"], timestampQuery: false, limits: { maxTextureDimension2D: 8192 } } as never;

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({ id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label });
const edge = (id: string, from: string, to: string, port: string) => ({ id, source: { nodeId: from, portId: "out" }, target: { nodeId: to, portId: port } });

/**
 * A red sheet one unit square at (0, −2), a literal draw; and eight slots of white boxes
 * half a unit square on y = 2, of which the four with even ids live (x = −3.5, −1.5, 0.5,
 * 2.5), drawn indirect off the live count. Over a blue backdrop.
 */
function scene(order: "sheet first" | "boxes first"): GraphDocument {
  const nodes = [
    node("grid", "pointGrid", { cols: 2, rows: 2, count: 4 }, "grid_sheet"),
    node(
      "sim",
      "pointKernelAdvanced",
      {
        capacity: 8,
        seed: 1,
        kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) { q.id = ctx.index; }
  q.position = vec3f(f32(q.id) - 3.5, 2.0, 0.0);
  q.velocity = vec3f(0.0);
  if (q.id % 2u == 1u) { q.alive = 0u; }
  return q;
}`,
      },
      "kernel_sim",
    ),
    node("red", "materialUnlit", { color: [1, 0, 0, 1] }, "material_red"),
    node("white", "materialUnlit", { color: [1, 1, 1, 1] }, "material_white"),
    node("sheet", "geometry", { mode: "surface", material: "material_red", objectScale: [0.5, 0.5, 1], translate: [0, -2, 0] }, "geometry_sheet"),
    node("boxes", "geometry", { mode: "instances", shape: "box", scale: 0.25, material: "material_white" }, "geometry_boxes"),
    node("cam", "camera", { eye: [0, 0, 5], lookAt: [0, 0, 0], ortho: true, orthoHeight: SIZE / UNIT, near: 0.1, far: 100 }, "camera_lens"),
    node("shot", "render", { scenes: order === "sheet first" ? "geometry_sheet geometry_boxes" : "geometry_boxes geometry_sheet", camera: "camera_lens", lights: "", background: [0, 0, 1, 1] }, "render_shot"),
    node("out", "output", {}, "output_main"),
  ];
  const edges = [edge("e1", "grid", "sheet", "points"), edge("e2", "sim", "boxes", "points"), edge("e3", "shot", "out", "input")];
  return { revision: 1, nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])), edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])), groups: {} } as never;
}

/** The picture as letters: R the sheet, W a box, B the backdrop, ? anything else. */
function letters(bytes: Uint8Array): string[] {
  return Array.from({ length: SIZE }, (_, y) =>
    Array.from({ length: SIZE }, (_, x) => {
      const at = (y * SIZE + x) * 4;
      const rgb = `${bytes[at]},${bytes[at + 1]},${bytes[at + 2]}`;
      return rgb === "255,0,0" ? "R" : rgb === "255,255,255" ? "W" : rgb === "0,0,255" ? "B" : "?";
    }).join(""),
  );
}

/** What the scene is, from its numbers: each rectangle is (centre x, y; size; letter). */
function expected(): string[] {
  const rects: Array<[number, number, number, string]> = [[0, -2, 1, "R"], [-3.5, 2, 0.5, "W"], [-1.5, 2, 0.5, "W"], [0.5, 2, 0.5, "W"], [2.5, 2, 0.5, "W"]];
  return Array.from({ length: SIZE }, (_, row) =>
    Array.from({ length: SIZE }, (_, column) => {
      const x = (column + 0.5 - SIZE / 2) / UNIT;
      const y = (SIZE / 2 - (row + 0.5)) / UNIT;
      return rects.find(([cx, cy, size]) => Math.abs(x - cx) < size / 2 && Math.abs(y - cy) < size / 2)?.[3] ?? "B";
    }).join(""),
  );
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Three frames (the lifecycle compacts on the first), on one of the backend's two paths. */
async function render(order: "sheet first" | "boxes first", path: "direct" | "loop"): Promise<Uint8Array> {
  const document = scene(order);
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const plan = compileGraph({ graph: document, settings: SETTINGS, registry: createNodeRegistry(allNodeDefinitions).view(), capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  // The claim is about an INDIRECT draw: the fixture must still be one.
  const indirect = plan.passes.filter((pass) => pass.kind === "draw" && typeof pass.instances === "object");
  expect(indirect.map((pass) => pass.id.slice(pass.id.indexOf("#") + 1))).toEqual([`shot:scene:${order === "boxes first" ? 0 : 1}`]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    const frame = (frameIndex: number): void =>
      backend.render(compiled, {
        frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SIZE, SIZE],
      });
    for (let index = 0; index < 3; index += 1) {
      if (path === "direct") {
        frame(index);
        continue;
      }
      // One tick of the backend's own loop: the app's path, ONE frame open around the render.
      let rendered = false;
      const control = backend.loop(() => {
        if (rendered) return;
        rendered = true;
        frame(index);
      });
      await until(() => rendered, `loop tick ${index}`);
      control.stop();
    }
    const output = plan.outputs.find((row) => row.nodeId === "shot") ?? plan.outputs[0]!;
    return (await backend.readOutput(output.resourceId)).bytes;
  } finally {
    backend.dispose();
  }
}

describe("an indirect draw keeps its place among its frame's draws (§V147)", () => {
  for (const path of ["direct", "loop"] as const) {
    for (const order of ["sheet first", "boxes first"] as const) {
      it(`${path} path, ${order}: the backdrop, the literal surface and the counted boxes are all in the picture`, async () => {
        expect(letters(await render(order, path))).toEqual(expected());
      }, 120_000);
    }
  }
});
