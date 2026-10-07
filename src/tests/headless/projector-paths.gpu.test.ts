import { describe, expect, it } from "vitest";

import { createAppRuntime } from "../../app/app-runtime.ts";
import { cameraPayloadMatrix, transformPoint } from "../../domain/geometry/camera.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * VN35 — ONE PROJECTOR COMPONENT, THREE INSTANCES, THREE DIFFERENT PROJECTORS BOUND, on Dawn.
 *
 * Proposal 01 §2.2: B41 renumbers the names inside the second and later instances, so the
 * outer Render could reach a component's projector only by a bare name, and a bare name
 * reaches the FIRST copy. A reusable projector component was impossible. A path names one
 * copy: `projector_left/projector_beam`.
 *
 * Built through the app's own commands: one projector saved as the component "Projector",
 * placed three times, each instance named, aimed at its own third of a flat stage and lit
 * its own pure colour through its own overrides (VN33's `internalNodeId`). Pure 0/1 colours
 * are fixed points of the display decode (§V56), so each beam is exactly one channel.
 *
 * The claim is read from pixels (§V147, the arithmetic of `projector-render.gpu.test.ts`):
 * the centre of third k is lit at full strength in colour k ONLY, and the other two channels
 * there are the ambient floor. That is possible only if all three projectors are bound, each
 * once. Against the code before VN35 the paths name nothing and the compile refuses them; the
 * bare name, written the old way, lights the left third alone.
 */

const SIZE = 64;
const SETTINGS: ProjectSettings = {
  outputResolution: { width: SIZE, height: SIZE },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

/** Three thirds of the stage, and the beam that lands on each: red, green, blue. */
const BEAMS = [
  { name: "projector_left", x: -0.66, color: [1, 0, 0, 1] },
  { name: "projector_mid", x: 0, color: [0, 1, 0, 1] },
  { name: "projector_right", x: 0.66, color: [0, 0, 1, 1] },
] as const;

/* Albedo 0.8 under white ambient 0.12; a beam on its own axis at its throw distance adds one
   light's worth (|N·L| = 1, falloff 1). Throw ratio 6 from 4 out: half-width 1/3, so each
   beam stays in its own third. */
const FLOOR = Math.round(0.8 * 0.12 * 255);
const FULL = Math.round(0.8 * (0.12 + 1) * 255);

const camera = cameraPayloadMatrix({ eye: [0, 0, 3], lookAt: [0, 0, 0], fovDeg: 55, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
function rgbAt(bytes: Uint8Array, x: number): [number, number, number] {
  const clip = transformPoint(camera, [x, 0, 0]);
  const px = Math.round(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const py = Math.round((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  const at = (py * SIZE + px) * 4;
  return [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];
}

async function stage(): Promise<{ graph: GraphDocument; shot: string; components: ReturnType<ReturnType<typeof createAppRuntime>["components"]["view"]> }> {
  const runtime = createAppRuntime({ identityStorage: null });
  const { bus, invocation } = runtime;
  const added = await bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
    { op: "addNode", ref: "$beam", type: "projector", position: { x: 0, y: 0 }, label: "projector_beam",
      parameters: { throwRatio: 6, occlusion: false } },
  ] }, invocation);
  expect(added.status).toBe("applied");
  const beam = added.output.createdIds["$beam"]!;
  const saved = await bus.execute("component.saveSelection", { nodeIds: [beam], name: "Projector" }, invocation);
  expect(saved.status).toBe("applied");
  const instances = [saved.output.instanceNodeId!];
  for (let copy = 1; copy < BEAMS.length; copy += 1) {
    const placed = await bus.execute("component.instantiate", { componentId: saved.output.componentId! }, invocation);
    expect(placed.status).toBe("applied");
    instances.push(placed.output.nodeId!);
  }
  for (const [index, spec] of BEAMS.entries()) {
    const renamed = await bus.execute("node.rename", { nodeId: instances[index]!, label: spec.name }, invocation);
    expect(renamed.status).toBe("applied");
  }

  const rest = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [
    ...BEAMS.map((spec, index) => ({
      op: "setParameters" as const,
      nodeId: instances[index]!,
      internalNodeId: beam,
      parameters: { eye: [spec.x, 0, 4], lookAt: [spec.x, 0, 0], color: [...spec.color] },
    })),
    { op: "addNode", ref: "$grid", type: "pointGrid", position: { x: 0, y: 300 }, label: "grid_stage", parameters: { cols: 8, rows: 8 } },
    { op: "addNode", ref: "$geo", type: "geometry", position: { x: 200, y: 300 }, label: "geometry_stage", parameters: { mode: "surface" } },
    { op: "connect", source: { nodeId: "$grid", portId: "out" }, target: { nodeId: "$geo", portId: "points" } },
    { op: "addNode", ref: "$cam", type: "camera", position: { x: 200, y: 450 }, label: "camera_stage", parameters: { eye: [0, 0, 3], lookAt: [0, 0, 0] } },
    { op: "addNode", ref: "$shot", type: "render", position: { x: 400, y: 300 }, label: "render_stage", parameters: {
      scenes: "geometry_stage", camera: "camera_stage", lights: "",
      projectors: BEAMS.map((spec) => `${spec.name}/projector_beam`).join(" "),
      ambientColor: [1, 1, 1, 1], ambientIntensity: 0.12,
    } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 600, y: 300 }, label: "output_main" },
    { op: "connect", source: { nodeId: "$shot", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
  ] }, invocation);
  expect(rest.status).toBe("applied");
  return { graph: bus.store.getGraph(), shot: rest.output.createdIds["$shot"]!, components: runtime.components.view() };
}

async function render(staged: Awaited<ReturnType<typeof stage>>, projectors?: string) {
  const { graph, shot } = staged;
  const node = graph.nodes[shot]!;
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: projectors === undefined ? graph : { ...graph, nodes: { ...graph.nodes, [shot]: { ...node, parameters: { ...node.parameters, projectors } } } },
    components: staged.components,
    settings: SETTINGS,
    frames: 2,
    outputNodeId: shot,
    outputPortId: "out",
  });
  const frame = result.frames[result.frames.length - 1];
  if (frame === undefined) throw new Error("no frame captured");
  return { bytes: frame.bytes, diagnostics: result.diagnostics };
}

describe("VN35: three instances of one Projector component, three projectors bound by path (Dawn)", () => {
  it("each third of the stage is lit by its own instance's projector and no other", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const staged = await stage();
    const { bytes, diagnostics } = await render(staged);
    expect(diagnostics.filter((d) => d.severity === "error" || d.code === "compiler/reference-cross-scope")).toEqual([]);
    expect(BEAMS.map((spec) => rgbAt(bytes, spec.x))).toEqual([
      [FULL, FLOOR, FLOOR],
      [FLOOR, FULL, FLOOR],
      [FLOOR, FLOOR, FULL],
    ]);
  }, 120_000);

  it("the bare name, the old way, binds the first copy only, and the compile now says so", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const staged = await stage();
    const { bytes, diagnostics } = await render(staged, "projector_beam");
    expect(BEAMS.map((spec) => rgbAt(bytes, spec.x))).toEqual([
      [FULL, FLOOR, FLOOR],
      [FLOOR, FLOOR, FLOOR],
      [FLOOR, FLOOR, FLOOR],
    ]);
    expect(diagnostics.filter((d) => d.code === "compiler/reference-cross-scope").map((d) => d.suggestion)).toEqual([
      expect.stringContaining('"projector_left/projector_beam"'),
    ]);
  }, 120_000);
});
