import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { cameraBasis } from "../../domain/geometry/camera.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
// The sanctioned Dawn host: `src/runtime/backend/vgpu/` is the only place a `vgpu` import
// is legal (§V3), and this is that boundary's node entry point.
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { decodeHalf, TOLERANCE_CROSS_GPU_HDR } from "../../tests/headless/pixel-compare.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { LIGHT_GUARD_ABOVE } from "../shaders/scene-render.wgsl.ts";
import { allNodeDefinitions } from "./index.ts";

/**
 * B260 — A RENDER WITH MANY LIGHTS STILL DRAWS THE SUM OF ITS LIGHTS.
 *
 * Above `LIGHT_GUARD_ABOVE` lights every light's block does its work under a test of the
 * light's own intensity (the stopgap for the cost cliff, `scene-light-guard.test.ts`). What a
 * person reads back must not know: the picture is ambient plus every light's term, and this
 * computes that sum on the CPU from the scene, per pixel, and compares VALUES. No clock.
 *
 * The scene is built so the answer is arithmetic:
 *  - an orthographic camera straight down over a flat floor at y = 0 and the flat top of one
 *    box at y = 2, so a pixel's world point is known exactly and its normal is the y axis;
 *  - a white Phong material with BLACK specular, so a light's term is its diffuse term alone:
 *    colour × intensity × falloff × |N·L|, the generators' own two-sided lambert;
 *  - four times the threshold in lights, a quarter each of: directional; point with the soft
 *    falloff; point with Inverse Square and a Range that leaves some sampled pixels outside
 *    it (exactly zero there); and point lights of intensity ZERO, which the guard skips and
 *    which add nothing either way.
 *
 * The floor is a grid surface and the box a primitive instance, so both generators' guarded
 * blocks are in the picture. What would fail it: a guard that skips a light that is on (every
 * on light gives each sampled pixel more than the tolerance, asserted), one whose blocks no
 * longer add up, or a block that leaks out of its test.
 */

const SIZE = 64;
const LIGHTS = 4 * LIGHT_GUARD_ABOVE;
const AMBIENT = 0.05;
const ORTHO_HEIGHT = 8;
const EYE = [0, 10, 0] as const;
const LOOK_AT = [0, 0, 0] as const;
const BOX_TOP = 2;

const settings: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 64,
  previewFps: 30,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry(allNodeDefinitions).view();

interface TestLight {
  readonly kind: "directional" | "point";
  readonly intensity: number;
  readonly vector: readonly [number, number, number];
  readonly falloff: "soft" | "inverseSquare";
  readonly range: number;
}

/** The lights, as data the document and the formula both read. */
const lights: TestLight[] = Array.from({ length: LIGHTS }, (_, index): TestLight => {
  const turn = index * 2.399963; // the golden angle, so no two lights line up
  /* Well above the box's top, so no term is large: the sum stays under 2 everywhere (asserted),
     where a half float's step is under the tolerance. */
  const place: [number, number, number] = [Math.cos(turn) * (1 + (index % 5) * 0.5), 4 + (index % 3) * 0.4, Math.sin(turn) * (1 + (index % 7) * 0.4)];
  switch (index % 4) {
    case 0:
      return { kind: "directional", intensity: 0.02 + index * 0.001, vector: [Math.cos(turn) * 0.6, -1, Math.sin(turn) * 0.6], falloff: "soft", range: 0 };
    case 1:
      return { kind: "point", intensity: 0.3, vector: place, falloff: "soft", range: 0 };
    case 2:
      return { kind: "point", intensity: 0.35, vector: place, falloff: "inverseSquare", range: 6 };
    default:
      return { kind: "point", intensity: 0, vector: place, falloff: "inverseSquare", range: 0 };
  }
});

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  return { id, type, definitionVersion: registry.get(type)?.version ?? 1, position: { x: 0, y: 0 }, parameters, label: id };
}

const ATTRS = '[{"name":"position","type":"vec3f","semantic":"position","default":[0,0,0]}]';
const kernel = (position: string): string => `fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = ${position};\n  return q;\n}`;

function graph(): GraphDocument {
  const names = lights.map((_, index) => `light_l${index}`);
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid_floor", "pointGrid", { cols: 16, rows: 16, count: 256, sizeX: 16, sizeY: 16 }),
        node("kernel_floor", "pointKernel", { capacity: 256, attributes: ATTRS, kernel: kernel("vec3f(p.position.x, 0.0, p.position.y)") }),
        node("geometry_floor", "geometry", { mode: "surface", material: "material_white" }),
        node("grid_box", "pointGrid", { cols: 1, rows: 1, count: 1, sizeX: 1, sizeY: 1 }),
        /* A unit half-extent box centred at (-2, 1, 0): its top is the square x in [-3, -1], z in [-1, 1] at y = 2. */
        node("kernel_box", "pointKernel", { capacity: 1, attributes: ATTRS, kernel: kernel("vec3f(-2.0, 1.0, 0.0)") }),
        node("geometry_box", "geometry", { mode: "instances", shape: "box", scale: 1, material: "material_white" }),
        node("material_white", "materialPhong", { color: [1, 1, 1, 1], specular: [0, 0, 0, 1], shininess: 10, roughness: 1 }),
        node("camera_down", "camera", { eye: [...EYE], lookAt: [...LOOK_AT], ortho: true, orthoHeight: ORTHO_HEIGHT, near: 0.1, far: 40 }),
        ...lights.map((light, index) =>
          node(
            names[index] as string,
            "light",
            light.kind === "directional"
              ? { kind: "directional", color: [1, 1, 1, 1], intensity: light.intensity, direction: [...light.vector], shadows: false }
              : { kind: "point", color: [1, 1, 1, 1], intensity: light.intensity, position: [...light.vector], falloff: light.falloff, range: light.range, shadows: false },
          ),
        ),
        node("render_shot", "render", {
          scenes: "geometry_floor geometry_box",
          camera: "camera_down",
          lights: names.join(" "),
          ambientColor: [1, 1, 1, 1],
          ambientIntensity: AMBIENT,
          background: [0, 0, 0, 1],
        }),
        node("output_frame", "output", {}),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid_floor", portId: "out" }, target: { nodeId: "kernel_floor", portId: "in" } },
      e2: { id: "e2", source: { nodeId: "kernel_floor", portId: "out" }, target: { nodeId: "geometry_floor", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "grid_box", portId: "out" }, target: { nodeId: "kernel_box", portId: "in" } },
      e4: { id: "e4", source: { nodeId: "kernel_box", portId: "out" }, target: { nodeId: "geometry_box", portId: "points" } },
      e5: { id: "e5", source: { nodeId: "render_shot", portId: "out" }, target: { nodeId: "output_frame", portId: "input" } },
    },
    groups: {},
  };
}

/** The world point a pixel's centre sees: the camera's own basis, an orthographic frame, the surface's height. */
function worldAt(px: number, py: number, height: number): [number, number, number] {
  const { right, up } = cameraBasis(EYE, LOOK_AT, 0);
  const x = (((px + 0.5) / SIZE) * 2 - 1) * (ORTHO_HEIGHT / 2);
  const y = (1 - ((py + 0.5) / SIZE) * 2) * (ORTHO_HEIGHT / 2);
  return [LOOK_AT[0] + right[0] * x + up[0] * y, height, LOOK_AT[2] + right[2] * x + up[2] * y];
}

/** One light's term at a point whose normal is the y axis: the light block's own arithmetic. */
function term(light: TestLight, world: readonly [number, number, number]): number {
  if (light.kind === "directional") {
    const length = Math.hypot(...light.vector);
    return light.intensity * Math.abs(light.vector[1] / length);
  }
  const offset = [light.vector[0] - world[0], light.vector[1] - world[1], light.vector[2] - world[2]] as const;
  const distance = Math.max(Math.hypot(...offset), 1e-4);
  let attenuation = light.falloff === "inverseSquare" ? 1 / Math.max(distance * distance, 1e-4) : 1 / (1 + distance * distance);
  if (light.range > 0) {
    const reach = distance / light.range;
    const window = Math.min(1, Math.max(0, 1 - reach ** 4));
    attenuation *= window * window;
  }
  return light.intensity * attenuation * Math.abs(offset[1] / distance);
}

const expectedAt = (world: readonly [number, number, number]): number => AMBIENT + lights.reduce((sum, light) => sum + term(light, world), 0);

/* Pixels on the floor away from the box, and pixels well inside the box's top. Which pixel is
   which is decided from the world point, so the camera's handedness is not assumed here. */
const SAMPLES: ReadonlyArray<readonly [number, number]> = [
  [6, 6], [57, 6], [6, 57], [57, 57], [32, 5], [32, 58], [20, 14], [44, 50], [12, 40], [50, 14],
  [16, 32], [48, 32], [14, 28], [50, 36], [18, 35], [46, 29],
];

describe("B260: above the light threshold the picture is still the sum of its lights", () => {
  it(`draws ambient plus every one of ${LIGHTS} lights' terms, on a grid surface and on a primitive instance`, async () => {
    // Required, never skipped: without a GPU this would be a green tick about nothing.
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const plan = compileGraph({ graph: graph(), settings, registry, capabilities });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    let image: Awaited<ReturnType<typeof backend.readOutput>>;
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [SIZE, SIZE],
      });
      // The Render's own target: linear light, before any output transfer.
      image = await backend.readOutput("target:render_shot:out");
    } finally {
      backend.dispose();
    }
    expect(image.format).toBe("rgba16float");
    const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
    const red = (px: number, py: number): number => decodeHalf(view.getUint16(py * image.rowStride + px * 8, true));

    let onFloor = 0;
    let onBox = 0;
    /** Each light's largest term over the sampled pixels. */
    const clearest = lights.map(() => 0);
    for (const [px, py] of SAMPLES) {
      const flat = worldAt(px, py, 0);
      /* The box's top, with a margin of three pixels from its edges. */
      const top = flat[0] > -3 + 0.4 && flat[0] < -1 - 0.4 && Math.abs(flat[2]) < 1 - 0.4;
      /* And the floor only where the box is nowhere near. */
      const clear = flat[0] > -1 + 0.4 || flat[0] < -3 - 0.4 || Math.abs(flat[2]) > 1 + 0.4;
      expect(top || clear, `pixel ${px},${py} sits on the box's edge: move the sample`).toBe(true);
      const world: [number, number, number] = top ? [flat[0], BOX_TOP, flat[2]] : flat;
      if (top) onBox += 1;
      else onFloor += 1;

      for (const [index, light] of lights.entries()) clearest[index] = Math.max(clearest[index] as number, term(light, world));

      const expected = expectedAt(world);
      expect(expected).toBeLessThan(2);
      const got = red(px, py);
      expect(Math.abs(got - expected), `pixel ${px},${py} (${top ? "box top" : "floor"}): drew ${got.toFixed(5)}, the sum is ${expected.toFixed(5)}`).toBeLessThanOrEqual(TOLERANCE_CROSS_GPU_HDR);
    }
    /* The claim has teeth only if a missing light would show: every light that is on gives
       some sampled pixel several times the tolerance, and a light that is off gives none. */
    for (const [index, light] of lights.entries()) {
      if (light.intensity === 0) expect(clearest[index]).toBe(0);
      else expect(clearest[index], `light ${index} is too faint at every sampled pixel to be missed`).toBeGreaterThan(4 * TOLERANCE_CROSS_GPU_HDR);
    }
    /* Both generators were looked at, and the Range left some pixel dark for some light. */
    expect(onFloor).toBeGreaterThanOrEqual(4);
    expect(onBox).toBeGreaterThanOrEqual(2);
    const outOfRange = SAMPLES.some(([px, py]) => lights.some((light) => light.range > 0 && term(light, worldAt(px, py, 0)) === 0));
    expect(outOfRange).toBe(true);
  }, 120_000);
});
