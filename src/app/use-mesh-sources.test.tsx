// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cubePrimitive, encodeFixtureGlb } from "@domain/mesh/glb.fixture.ts";
import { createFileReference } from "@domain/media/file-reference.ts";
import { slotFromValue } from "@domain/parameters/slots.ts";
import { meshSourceIdsFor, prepareMesh } from "@/points/mesh.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { useMeshSources } from "./use-mesh-sources.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("mesh file source bindings", () => {
  it.each([false, true])("reads a resolved file, registers decoded buffers, and releases them (slot=%s)", async slot => {
    const bytes = encodeFixtureGlb({ nodes: [{ name: "cube", mesh: [cubePrimitive()] }] });
    const prepared = prepareMesh(bytes, "");
    if (prepared === null) throw new Error("Cube fixture must contain a mesh");
    const fetchFile = vi.fn(async () => new Response(new Uint8Array(bytes)));
    vi.stubGlobal("fetch", fetchFile);
    const unregister = vi.fn();
    const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>(() => unregister);
    const backend = { registerMediaSource } as unknown as LoomBackend;
    const runtime = createAppRuntime({ identityStorage: null });
    try {
      const reference = createFileReference("cube-file", "gltf", "cube.glb");
      const added = await runtime.bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
        { op: "addNode", ref: "$mesh", type: "meshFileIn", position: { x: 0, y: 0 },
          parameters: { file: reference, ...prepared.facts } },
      ] }, runtime.invocation);
      expect(added.status).toBe("applied");
      const id = added.output.createdIds["$mesh"]!;
      const graph = runtime.flattened.current().graph;
      const url = "blob:reopened#cube.glb";
      const view = { ...graph, nodes: { ...graph.nodes, [id]: { ...graph.nodes[id]!,
        parameters: { ...graph.nodes[id]!.parameters, file: slot ? slotFromValue(url) : url },
      } } };
      const hook = renderHook(() => useMeshSources(runtime, backend, view));
      await waitFor(() => expect(registerMediaSource).toHaveBeenCalledTimes(2));
      expect(fetchFile).toHaveBeenCalledWith(url);
      const ids = meshSourceIdsFor(id);
      expect(registerMediaSource.mock.calls.map(call => call[0])).toEqual([ids.points, ids.indices]);
      expect(hook.result.current.diagnostics).toEqual([]);
      expect(runtime.bus.store.getGraph().nodes[id]!.parameters.file).toBe(reference);
      hook.unmount();
      expect(unregister).toHaveBeenCalledTimes(2);
    } finally { runtime.dispose(); }
  });

  /*
   * VNB8 — the literal bug: the app keeps one loader for its whole life, and it used to keep
   * every file it had read, by URL, for that life too. Rebuild the GLB on disk, open a project
   * sized for the NEW file, and the loader measured the OLD bytes it still held and wrote
   * their counts back over the project's — so a Point Kernel sized to the new mesh refused
   * the stale one and the whole document stopped compiling. A load mints a new
   * documentIdentity; that is when a file must be read again.
   */
  it("VNB8: a project opened after its file changed on disk reads the new file, not the one read before", async () => {
    const before = encodeFixtureGlb({ nodes: [{ name: "a", mesh: [cubePrimitive()] }] });
    const after = encodeFixtureGlb({ nodes: [{ name: "a", mesh: [cubePrimitive()] }, { name: "b", mesh: [cubePrimitive()] }] });
    const factsOf = (bytes: Uint8Array) => {
      const prepared = prepareMesh(bytes, "");
      if (prepared === null) throw new Error("fixture must contain a mesh");
      return prepared.facts;
    };
    expect(factsOf(after).vertices).not.toBe(factsOf(before).vertices);
    let served = before;
    const fetchFile = vi.fn(async () => new Response(new Uint8Array(served)));
    vi.stubGlobal("fetch", fetchFile);
    const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>(() => () => {});
    const backend = { registerMediaSource } as unknown as LoomBackend;
    const url = "media/stage.glb";
    const open = async (bytes: Uint8Array) => {
      const runtime = createAppRuntime({ identityStorage: null });
      const added = await runtime.bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
        { op: "addNode", ref: "$mesh", type: "meshFileIn", position: { x: 0, y: 0 }, parameters: { file: url, ...factsOf(bytes) } },
      ] }, runtime.invocation);
      expect(added.status).toBe("applied");
      return { runtime, id: added.output.createdIds["$mesh"]!, graph: runtime.flattened.current().graph };
    };
    const first = await open(before);
    const second = await open(after);
    try {
      const hook = renderHook((props: { runtime: typeof first.runtime; graph: typeof first.graph }) => useMeshSources(props.runtime, backend, props.graph), { initialProps: first });
      await waitFor(() => expect(registerMediaSource).toHaveBeenCalledTimes(2));
      served = after; // the export is rebuilt on disk
      hook.rerender(second); // and the next project opened is sized for it
      await waitFor(() => expect(registerMediaSource).toHaveBeenCalledTimes(4));
      expect(fetchFile).toHaveBeenCalledTimes(2);
      expect(second.runtime.bus.store.getGraph().nodes[second.id]!.parameters["vertices"]).toBe(factsOf(after).vertices);
      hook.unmount();
    } finally {
      first.runtime.dispose();
      second.runtime.dispose();
    }
  });

  /*
   * T1598b: Bounds is a measured fact that SIZES NOTHING. A document saved before it existed
   * has every other fact right, so its mesh must feed at once, exactly as it did; the sphere
   * is then written beside the others. Treated as one more "is this node sized for the file"
   * fact it would have left every such mesh empty until the next edit.
   */
  it("feeds a mesh measured before Bounds existed, and writes its Bounds", async () => {
    const bytes = encodeFixtureGlb({ nodes: [{ name: "cube", translation: [3, 0, 0], mesh: [cubePrimitive()] }] });
    const prepared = prepareMesh(bytes, "");
    if (prepared === null) throw new Error("Cube fixture must contain a mesh");
    expect(prepared.facts.bounds).toBe("3,0,0,0.8661");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes))));
    const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>(() => vi.fn());
    const backend = { registerMediaSource } as unknown as LoomBackend;
    const runtime = createAppRuntime({ identityStorage: null });
    try {
      const { bounds: _bounds, ...before } = prepared.facts;
      const added = await runtime.bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
        { op: "addNode", ref: "$mesh", type: "meshFileIn", position: { x: 0, y: 0 }, parameters: { file: "blob:saved#cube.glb", ...before } },
      ] }, runtime.invocation);
      expect(added.status).toBe("applied");
      const id = added.output.createdIds["$mesh"]!;
      expect(runtime.bus.store.getGraph().nodes[id]!.parameters["bounds"]).not.toBe(prepared.facts.bounds);
      const hook = renderHook(() => useMeshSources(runtime, backend, runtime.flattened.current().graph));
      await waitFor(() => expect(registerMediaSource).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(runtime.bus.store.getGraph().nodes[id]!.parameters["bounds"]).toBe("3,0,0,0.8661"));
      expect(hook.result.current.diagnostics).toEqual([]);
      hook.unmount();
    } finally { runtime.dispose(); }
  });
});
