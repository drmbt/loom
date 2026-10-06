// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppRuntime } from "../../app/app-runtime.ts";
import { useMeshSources } from "../../app/use-mesh-sources.ts";
import { cameraPayloadMatrix, transformPoint } from "../../domain/geometry/camera.ts";
import { cubePrimitive, encodeFixtureGlb } from "../../domain/mesh/glb.fixture.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { meshSourceIdsFor } from "../../points/mesh.ts";
import type { LoomBackend } from "../../runtime/backend/index.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "./render-harness.ts";

/**
 * VN33 — A MESH FILE IN INSIDE A COMPONENT DREW NOTHING, through the real stack on Dawn.
 *
 * The loader (`useMeshSources`) measures the file and writes the facts that SIZE the node.
 * It found the node with `getGraph().nodes[nodeId]`; an inner node's id is flattened
 * (`instance/inner`), the document does not hold it, so the facts were never written and
 * the node compiled as the one-vertex stand-in. The harness feeds a mesh by its flat id and
 * refuses a node not sized for the file, so the unfixed loader fails here by name.
 *
 * Built through the app's own commands: a mesh saved as a component, instanced twice, the
 * second instance loading another file. The loader's writes land as each instance's
 * overrides, and the render of each instance's Geometry alone draws ITS file and nothing of
 * the other's (§V321): file one is a cube above the axis, file two two cubes below it.
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
  return (bytes[at] ?? 0) + (bytes[at + 1] ?? 0) + (bytes[at + 2] ?? 0) > 0;
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function stage() {
  const runtime = createAppRuntime({ identityStorage: null });
  const { bus, invocation } = runtime;
  const added = await bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
    { op: "addNode", ref: "$mesh", type: "meshFileIn", position: { x: 0, y: 0 }, label: "mesh_stage", parameters: { file: "media/one.glb" } },
    { op: "addNode", ref: "$a", type: "geometry", position: { x: 200, y: 0 }, label: "geometry_a", parameters: { mode: "surface" } },
    { op: "connect", source: { nodeId: "$mesh", portId: "out" }, target: { nodeId: "$a", portId: "points" } },
  ] }, invocation);
  expect(added.status).toBe("applied");
  const meshId = added.output.createdIds["$mesh"]!;
  const saved = await bus.execute("component.saveSelection", { nodeIds: [meshId], name: "Stage" }, invocation);
  expect(saved.status).toBe("applied");
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
    { op: "setParameters", nodeId: second, internalNodeId: meshId, parameters: { file: "media/two.glb" } },
  ] }, invocation);
  expect(rest.diagnostics).toEqual([]);
  expect(rest.status).toBe("applied");
  return { runtime, meshId, first, second, shot: rest.output.createdIds["$shot"]! };
}

describe("VN33: a Mesh File In inside a component draws, each instance its own file (Dawn)", () => {
  it("the loader sizes both instances, and each Geometry draws its own instance's mesh", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const { runtime, meshId, first, second, shot } = await stage();
    try {
      const flatA = `${first}/${meshId}`;
      const flatB = `${second}/${meshId}`;

      // THE LOADER: the app's hook, reading the files, writing the facts through the bus.
      const files: Record<string, Uint8Array> = { "media/one.glb": ONE, "media/two.glb": TWO };
      vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array(files[url]!))));
      const live = new Set<string>();
      const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>((id) => { live.add(id); return () => live.delete(id); });
      const backend = { registerMediaSource } as unknown as LoomBackend;
      const hook = renderHook(() =>
        useMeshSources(runtime, backend, useSyncExternalStore(runtime.bus.store.subscribe, () => runtime.flattened.current().graph)),
      );
      // The loader feeds a node only once it is sized for the file: both fed is both sized.
      await waitFor(() => expect([...live].sort()).toEqual([
        meshSourceIdsFor(flatA).points, meshSourceIdsFor(flatA).indices, meshSourceIdsFor(flatB).points, meshSourceIdsFor(flatB).indices,
      ].sort()), { timeout: 5000 });
      expect(hook.result.current.diagnostics).toEqual([]);
      hook.unmount();

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
