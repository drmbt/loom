import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T722 — the camera's depth, readable, §V147 exact.
 *
 * The stage is arithmetic: a flat wall exactly 3 units in front of the camera, far
 * plane 10 — every wall texel must read R = 3/10 = 0.3, and the un-covered border
 * (the clear plate) reads the far plane's 1.0. Off, the plan carries no depth target
 * and no sweep (§V309), which is what makes the switch a price and not a default.
 */

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

function depthGraph(depthOutput: boolean, material: "materialPhong" | "materialGlass" | "materialUnlit" = "materialPhong", distant = false): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        node("grid", "pointGrid", { cols: 8, rows: 8 }, "grid1"),
        node("mat", material, {}, "mat1"),
        node("geo", "geometry", { mode: "surface", material: "mat1" }, "geo1"),
        node("sun", "light", { kind: "directional", direction: [0, 0, -1], shadows: true, shadowExtent: 3 }, "sun1"),
        node("cam", "camera", { eye: [0, 0, distant ? 90 : 3], lookAt: [0, 0, 0], fov: distant ? 2 : 55, near: 0.1, far: distant ? 100 : 10 }, "cam1"),
        node("shot", "render", { scenes: "geo1", camera: "cam1", lights: "sun1", depthOutput, ambientOcclusion: true }, "shot1"),
        // The depth consumer: displace's disp port is DATA space — the same §V13 gate
        // that (correctly) refuses depth into a colour input accepts it here, which is
        // also the first real use: displacement by camera depth.
        ...(depthOutput ? [node("push", "displace", { weight: [0.02, 0.02] }, "push1")] : []),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } },
      ...(depthOutput
        ? {
            e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "push", portId: "source" } },
            e3: { id: "e3", source: { nodeId: "shot", portId: "depth" }, target: { nodeId: "push", portId: "disp" } },
            e4: { id: "e4", source: { nodeId: "push", portId: "out" }, target: { nodeId: "out", portId: "input" } },
          }
        : {
            e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
          }),
    },
    groups: {},
  } as never;
}

function planFor(graph: GraphDocument) {
  return compileGraph({
    graph,
    settings: {
      outputResolution: { width: 64, height: 64 },
      workingFormat: "rgba16float",
      randomSeed: 7,
      previewLongEdge: 192,
      previewFps: 20,
      limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
    } as never,
    registry: createNodeRegistry(allNodeDefinitions).view(),
    capabilities: {
      tier: "B",
      features: [],
      formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
      timestampQuery: false,
      limits: { maxTextureDimension2D: 8192 },
    } as never,
  });
}

describe("the render's depth output (T722, §V147, §V309)", () => {
  it.each(["beam", "points"] as const)("%s: additive soft geometry exports its actual camera footprint without casting", async (mode) => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = depthGraph(true, "materialUnlit");
    Object.assign(graph.nodes["grid"]!.parameters, { cols: 2, rows: 1, count: 2 });
    graph.nodes["place"] = node("place", "pointKernel", {
      capacity: 2,
      attributes: JSON.stringify([
        { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
        { name: "tip", type: "vec3f", default: [0, 0, 0] },
        { name: "size", type: "f32", default: [0] },
        { name: "enabled", type: "f32", default: [0] },
      ]),
      kernel: `fn process(p:Point,ctx:PointCtx)->Point {
        var q=p;
        q.position=vec3f(${mode === "beam" ? "-0.6" : "0.0"}, f32(ctx.index)*0.7, 0);
        q.tip=vec3f(0.6,f32(ctx.index)*0.7,0);
        q.size=0.5;q.enabled=select(1.0,0.0,ctx.index==1u);return q;
      }`,
    }, "place1") as never;
    Object.assign(graph.nodes["geo"]!.parameters, {
      mode, endpoint: "tip", soft: 1, spherical: true, blend: "additive", group: "p.enabled > 0.5",
      scale: { mode: "map", bindings: { static: { kind: "static", value: 0.4 }, map: { kind: "map", attribute: "size" } } },
    });
    graph.edges["e1"] = { id: "e1", source: { nodeId: "place", portId: "out" }, target: { nodeId: "geo", portId: "points" } };
    graph.edges["seed"] = { id: "seed", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "place", portId: "in" } };
    const plan = planFor(graph);
    expect(plan.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    for (const prefix of ["shot:shadow:0:", "shot:ao:depth:"]) {
      expect(plan.passes.filter(pass => pass.id.includes(prefix) && !pass.id.endsWith(":clear"))).toHaveLength(0);
    }
    const litGraph = structuredClone(graph);
    litGraph.nodes["mat"] = { ...litGraph.nodes["mat"]!, type: "materialPhong" };
    const litPlan = planFor(litGraph);
    expect(litPlan.diagnostics.filter(d => d.severity === "error")).toEqual([]);
    for (const prefix of ["shot:shadow:0:", "shot:ao:depth:"]) {
      // This is a camera-facing primitive rule, not merely the unlit-material skip.
      expect(litPlan.passes.filter(pass => pass.id.includes(prefix) && !pass.id.endsWith(":clear"))).toHaveLength(0);
    }
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 }, resolution: [64, 64],
      } as never);
      const depth = await backend.readOutput("target:shot:depth");
      const color = await backend.readOutput("target:shot:out");
      const depths = new Uint16Array(depth.bytes.buffer, depth.bytes.byteOffset, depth.bytes.byteLength / 2);
      const colors = new Uint16Array(color.bytes.buffer, color.bytes.byteOffset, color.bytes.byteLength / 2);
      // Positive half floats preserve ordering. .3 lies between half encodings .2998 and .3003.
      const at = (x:number,y:number) => (y*64+x)*4;
      expect(depths[at(32,32)]).toBeGreaterThanOrEqual(0x34cc);
      expect(depths[at(32,32)]).toBeLessThanOrEqual(0x34cd);
      expect(colors[at(32,32)]).toBeGreaterThan(0);
      for (const [x,y] of [[32,5],[32,18],[5,32]] as const) {
        expect(depths[at(x,y)]).toBe(0x3c00);
        expect(colors[at(x,y)]).toBe(0);
      }
      if (mode === "points") {
        // Inside the billboard square, outside its soft sphere: no invisible depth stamp.
        expect(depths[at(35,35)]).toBe(0x3c00);
        expect(colors[at(35,35)]).toBe(0);
      }
    } finally { backend.dispose(); }
  }, 120_000);

  it("B226: a Render read ONLY through its Depth (a light's-eye depth view) compiles and writes depth", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = depthGraph(true);
    // Nothing reads `out`: the displace's source is a ramp, only its disp is the render.
    graph.nodes["ramp"] = node("ramp", "ramp", {}, "ramp1") as never;
    graph.edges["e2"] = { id: "e2", source: { nodeId: "ramp", portId: "out" }, target: { nodeId: "push", portId: "source" } };
    const plan = planFor(graph);
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      } as never);
      const depth = await backend.readOutput("target:shot:depth");
      const half = new Uint16Array(depth.bytes.buffer, depth.bytes.byteOffset, depth.bytes.byteLength / 2);
      // The wall 3 in front of a far-10 camera: 0.3 lies between half encodings .2998 and .3003.
      expect(half[(32 * 64 + 32) * 4]).toBeGreaterThanOrEqual(0x34cc);
      expect(half[(32 * 64 + 32) * 4]).toBeLessThanOrEqual(0x34cd);
    } finally {
      backend.dispose();
    }
  }, 120_000);

  it("off: no depth target, no sweep — the switch is the price", () => {
    const plan = planFor(depthGraph(false));
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.resources.some((resource) => resource.id === "target:shot:depth")).toBe(false);
    expect(plan.passes.some((pass) => pass.id.includes("depthOut"))).toBe(false);
  });

  it.each([
    { material: "materialPhong", distant: false },
    { material: "materialGlass", distant: false },
    { material: "materialUnlit", distant: false },
    { material: "materialUnlit", distant: true },
  ] as const)("$material (distant=$distant): camera visibility agrees with rendered surfaces; caster policy preserved", async ({ material, distant }) => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const plan = planFor(depthGraph(true, material, distant));
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.resources.some((resource) => resource.id === "target:shot:depth")).toBe(true);
    // A camera sees glass and emissive surfaces even though neither blocks illumination.
    // Assert actual rendered depth below as well: a pass alone cannot prove visibility.
    for (const prefix of ["shot:shadow:0:", "shot:ao:depth:"]) {
      const draws = plan.passes.filter((pass) => pass.id.includes(prefix) && !pass.id.endsWith(":clear"));
      expect(draws).toHaveLength(material === "materialPhong" ? 1 : 0);
    }

    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [64, 64],
      } as never);
      const image = await backend.readOutput("target:shot:depth");
      // rgba16float rows: 4 half floats per texel. readOutput returns bytes; decode
      // through the Float16 view the format implies.
      const half = new Uint16Array(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength / 2);
      const decode = (h: number): number => {
        const sign = (h & 0x8000) !== 0 ? -1 : 1;
        const exponent = (h >> 10) & 0x1f;
        const mantissa = h & 0x3ff;
        if (exponent === 0) return sign * mantissa * 2 ** -24;
        if (exponent === 31) return mantissa === 0 ? sign * Infinity : NaN;
        return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
      };
      const texel = (x: number, y: number): number => decode(half[(y * 64 + x) * 4]!);
      // The wall (the ±1 grid at z = 0) sits exactly 3 from the eye; far is 10.
      expect(texel(32, 32)).toBeCloseTo(distant ? 0.9 : 0.3, 3);
      // The corner sees past the grid: the clear plate — the far plane's 1.0.
      expect(texel(1, 1)).toBeCloseTo(1.0, 3);
      if (distant) {
        // At 90 units the projected depth is .999889. The backdrop used to write
        // .999 and hide this valid surface despite the correct exported depth.
        const color = await backend.readOutput("target:shot:out");
        const values = new Uint16Array(color.bytes.buffer, color.bytes.byteOffset, color.bytes.byteLength / 2);
        expect(decode(values[(32 * 64 + 32) * 4]!)).toBeGreaterThan(0.5);
        expect(decode(values[(1 * 64 + 1) * 4]!)).toBe(0);
      }
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
