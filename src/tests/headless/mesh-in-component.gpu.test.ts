// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppRuntime } from "../../app/app-runtime.ts";
import { useMeshSources } from "../../app/use-mesh-sources.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { toInstance } from "../../domain/components/addressing.ts";
import { cameraPayloadMatrix, transformPoint } from "../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { meshSourceIdsFor, prepareMesh } from "../../points/mesh.ts";
import type { LoomBackend } from "../../runtime/backend/index.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * Adapted from drmbt's PR #4 (VN33): extract a Mesh File In into a component through the app's
 * commands, instantiate it twice, and load different files through validated overrides.
 * Each Geometry must render only its own instance's mesh (§V321). Cover both direct and
 * nested instances using main's existing descendant write path.
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
const EYE = [0, 0, 6] as const;

type Vec3 = readonly [number, number, number];
const TOP: Vec3 = [0, 1.2, 0];
const BOTTOM_LEFT: Vec3 = [-1.5, -1.2, 0];
const BOTTOM_RIGHT: Vec3 = [1.5, -1.2, 0];

const ONE = encodeFixtureGlb({ nodes: [{ name: "top", translation: [...TOP], mesh: [cubePrimitive()] }] });
const TWO = encodeFixtureGlb({
  nodes: [
    { name: "left", translation: [...BOTTOM_LEFT], mesh: [cubePrimitive()] },
    { name: "right", translation: [...BOTTOM_RIGHT], mesh: [cubePrimitive()] },
  ],
});

function texelOf(world: Vec3): number {
  const matrix = cameraPayloadMatrix({ eye: EYE, lookAt: [0, 0, 0], fovDeg: 60, near: 0.1, far: 100, ortho: false, orthoHeight: 2 }, 1);
  const clip = transformPoint(matrix, world);
  const x = Math.floor(((clip[0] / clip[3]) * 0.5 + 0.5) * SIZE);
  const y = Math.floor((0.5 - (clip[1] / clip[3]) * 0.5) * SIZE);
  return (y * SIZE + x) * 4;
}
const lit = (bytes: Uint8Array, world: Vec3): boolean => {
  const at = texelOf(world);
  if (at < 0 || at + 2 >= bytes.length) throw new Error(`Fixture sample ${world.join(",")} is outside the captured frame`);
  return bytes[at]! + bytes[at + 1]! + bytes[at + 2]! > 0;
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function stage(nested: boolean) {
  const runtime = createAppRuntime({ identityStorage: null });
  const { bus, invocation } = runtime;
  // The composition root supplies this read before an internal edit can be validated.
  bus.attachFlattenedGraph(() => runtime.flattened.current());
  const added = await bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
    { op: "addNode", ref: "$mesh", type: "meshFileIn", position: { x: 0, y: 0 }, label: "mesh_stage", parameters: { file: "media/one.glb" } },
    { op: "addNode", ref: "$a", type: "geometry", position: { x: 200, y: 0 }, label: "geometry_a", parameters: { mode: "surface" } },
    { op: "connect", source: { nodeId: "$mesh", portId: "out" }, target: { nodeId: "$a", portId: "points" } },
  ] }, invocation);
  expect(added.status).toBe("applied");
  const meshId = added.output.createdIds["$mesh"]!;
  let saved = await bus.execute("component.saveSelection", { nodeIds: [meshId], name: "Stage" }, invocation);
  expect(saved.status).toBe("applied");
  let internalNodeId = meshId;
  if (nested) {
    const inner = saved.output.instanceNodeId!;
    saved = await bus.execute("component.saveSelection", { nodeIds: [inner], name: "Venue" }, invocation);
    expect(saved.status).toBe("applied");
    internalNodeId = toInstance([inner], meshId);
  }
  const port = saved.output.exposedOutputs[0]!;
  const placed = await bus.execute("component.instantiate", { componentId: saved.output.componentId! }, invocation);
  expect(placed.status).toBe("applied");
  const first = saved.output.instanceNodeId!;
  const second = placed.output.nodeId!;
  const rest = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations: [
    { op: "addNode", ref: "$b", type: "geometry", position: { x: 200, y: 200 }, label: "geometry_b", parameters: { mode: "surface" } },
    { op: "connect", source: { nodeId: second, portId: port }, target: { nodeId: "$b", portId: "points" } },
    { op: "addNode", ref: "$cam", type: "camera", position: { x: 400, y: 0 }, label: "camera_lens", parameters: { eye: [...EYE], lookAt: [0, 0, 0] } },
    { op: "addNode", ref: "$shot", type: "render", position: { x: 600, y: 0 }, label: "render_shot",
      parameters: { scenes: "geometry_a geometry_b", camera: "camera_lens", lights: "", background: [0, 0, 0, 1], ambientColor: [1, 1, 1, 1], ambientIntensity: 0.5 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 800, y: 0 }, label: "output_main" },
    { op: "connect", source: { nodeId: "$shot", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
    // The second instance loads the other file: its own override, through the same op.
    { op: "setParameters", nodeId: second, internalNodeId, parameters: { file: "media/two.glb" } },
  ] }, invocation);
  expect(rest.diagnostics).toEqual([]);
  expect(rest.status).toBe("applied");
  return { runtime, flatA: toInstance([first], internalNodeId), flatB: toInstance([second], internalNodeId), shot: rest.output.createdIds["$shot"]! };
}

async function measure({ runtime, flatA, flatB }: Awaited<ReturnType<typeof stage>>): Promise<void> {
  const files: Record<string, Uint8Array> = { "media/one.glb": ONE, "media/two.glb": TWO };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const bytes = files[url];
    if (bytes === undefined) throw new Error(`Unexpected fixture file: ${url}`);
    return new Response(new Uint8Array(bytes));
  }));
  const live = new Map<string, unknown>();
  const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>((id, source) => {
    live.set(id, source.currentFrame()?.bytes);
    return () => live.delete(id);
  });
  const backend = { registerMediaSource } as unknown as LoomBackend;
  const definitionsBefore = JSON.stringify(runtime.components.all());
  const hook = renderHook(() => {
    useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
    const compiled = useGraphCompile(runtime, TIER_B_CAPABILITIES);
    return useMeshSources(runtime, backend, compiled.flatGraph);
  });
  try {
    await waitFor(() => expect([...live.keys()].sort()).toEqual([
      meshSourceIdsFor(flatA).points, meshSourceIdsFor(flatA).indices, meshSourceIdsFor(flatB).points, meshSourceIdsFor(flatB).indices,
    ].sort()), { timeout: 5000 });
    for (const [id, bytes] of [[flatA, ONE], [flatB, TWO]] as const) {
      const prepared = prepareMesh(bytes, "");
      if (prepared === null) throw new Error("Fixture must contain a mesh");
      expect(runtime.flattened.current().graph.nodes[id]!.parameters).toMatchObject(prepared.facts);
      const sources = meshSourceIdsFor(id);
      expect(live.get(sources.points)).toEqual(prepared.points);
      expect(live.get(sources.indices)).toEqual(prepared.indices);
    }
    expect(hook.result.current.diagnostics).toEqual([]);
    expect(JSON.stringify(runtime.components.all())).toBe(definitionsBefore);
  } finally { hook.unmount(); }
  expect([...live]).toEqual([]);
}

describe("VN33: extracted mesh components load independent files", () => {
  it.each([false, true])("the app loader sizes both extracted instances (nested=%s)", async nested => {
    const fixture = await stage(nested);
    try { await measure(fixture); } finally { fixture.runtime.dispose(); }
  });

  it.each([false, true])("each Geometry draws only its own instance's mesh on Dawn (nested=%s)", async nested => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const fixture = await stage(nested);
    const { runtime, flatA, flatB, shot } = fixture;
    try {
      await measure(fixture);

      const document = runtime.bus.store.getGraph();
      const render = async (scenes: string): Promise<Uint8Array> => {
        const graph: GraphDocument = { ...document, nodes: { ...document.nodes, [shot]: {
          ...document.nodes[shot]!, parameters: { ...document.nodes[shot]!.parameters, scenes },
        } } };
        const result = await renderHeadless({
          host: nodeGpuHost(),
          graph,
          components: runtime.components.view(),
          settings: SETTINGS,
          frames: 2,
          outputNodeId: shot,
          outputPortId: "out",
          meshes: { [flatA]: ONE, [flatB]: TWO },
        });
        expect(result.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
        const frame = result.frames[result.frames.length - 1];
        if (frame === undefined) throw new Error("no frame captured");
        return frame.bytes;
      };

      const a = await render("geometry_a");
      expect([lit(a, TOP), lit(a, BOTTOM_LEFT), lit(a, BOTTOM_RIGHT)]).toEqual([true, false, false]);
      const b = await render("geometry_b");
      expect([lit(b, TOP), lit(b, BOTTOM_LEFT), lit(b, BOTTOM_RIGHT)]).toEqual([false, true, true]);
    } finally { runtime.dispose(); }
  }, 60_000);
});
