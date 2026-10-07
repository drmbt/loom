// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { graphOf, instanceNode, node } from "@domain/components/test-support.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
import { cubePrimitive, encodeFixtureGlb } from "@domain/mesh/glb.fixture.ts";
import { createFileReference } from "@domain/media/file-reference.ts";
import { slotFromValue } from "@domain/parameters/slots.ts";
import { buildProjectFile } from "@domain/project/project-file.ts";
import { parseProjectDocument } from "@domain/project/serialize.ts";
import { meshSourceIdsFor, prepareMesh } from "@/points/mesh.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { useMeshSources } from "./use-mesh-sources.ts";
import { useGraphCompile } from "./use-graph-compile.ts";
import { TIER_B_CAPABILITIES } from "@/examples/runner.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("mesh file source bindings", () => {
  it("feeds a premeasured internal mesh without changing its shared definition", async () => {
    const bytes = encodeFixtureGlb({ nodes: [{ name: "cube", mesh: [cubePrimitive()] }] });
    const prepared = prepareMesh(bytes, "");
    if (prepared === null) throw new Error("Cube fixture must contain a mesh");
    const definition: GraphComponentDefinition = {
      componentId: "meshAsset", version: 1, name: "Mesh Asset",
      graph: graphOf([node("mesh", "meshFileIn", { file: "media/cube.glb", ...prepared.facts }, { label: "mesh_asset" })]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "mesh", portId: "out" }], parameters: [],
    };
    const runtime = createAppRuntime({ identityStorage: null, components: [definition] });
    const unregister = vi.fn();
    const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>(() => unregister);
    const backend = { registerMediaSource } as unknown as LoomBackend;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(bytes))));
    try {
      const placed = await runtime.bus.execute("component.instantiate", { componentId: definition.componentId }, runtime.invocation);
      expect(placed.status).toBe("applied");
      const definitionBefore = JSON.stringify(runtime.components.get(definition.componentId, 1));
      const revisionBefore = runtime.bus.store.getRevision();
      const mesh = Object.values(runtime.flattened.current().graph.nodes).find(each => each.type === "meshFileIn");
      if (mesh === undefined) throw new Error("Component must flatten to its mesh");
      const hook = renderHook(() => useMeshSources(runtime, backend, runtime.flattened.current().graph));
      await waitFor(() => expect(registerMediaSource).toHaveBeenCalledTimes(2));
      expect(registerMediaSource.mock.calls.map(call => call[0])).toEqual(Object.values(meshSourceIdsFor(mesh.id)).slice(0, 2));
      expect(hook.result.current.diagnostics).toEqual([]);
      expect(runtime.bus.store.getRevision()).toBe(revisionBefore);
      expect(JSON.stringify(runtime.components.get(definition.componentId, 1))).toBe(definitionBefore);
      hook.unmount();
      expect(unregister).toHaveBeenCalledTimes(2);
    } finally { runtime.dispose(); }
  });

  it.each([false, true])("measures and feeds independent files per linked mesh instance (nested=%s)", async nested => {
    const small = encodeFixtureGlb({ nodes: [{ name: "a", mesh: [cubePrimitive()] }] });
    const large = encodeFixtureGlb({ nodes: [{ name: "a", mesh: [cubePrimitive()] }, { name: "b", translation: [4, 0, 0], mesh: [cubePrimitive()] }] });
    const prepared = [small, large].map(bytes => {
      const mesh = prepareMesh(bytes, "");
      if (mesh === null) throw new Error("Fixture must contain a mesh");
      return mesh;
    });
    const fileParameter: GraphComponentDefinition["parameters"][number] = {
      key: "file", definition: { type: "asset", label: "File", kind: "gltf" }, targets: [{ nodeId: "mesh", key: "file" }],
    };
    const definition: GraphComponentDefinition = {
      componentId: "meshAsset", version: 1, name: "Mesh Asset",
      graph: graphOf([node("mesh", "meshFileIn", {}, { label: "mesh_asset" })]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "mesh", portId: "out" }], parameters: [fileParameter],
    };
    const outer: GraphComponentDefinition = {
      componentId: "meshShell", version: 1, name: "Mesh Shell",
      graph: graphOf([instanceNode("inner", definition.componentId, 1)]),
      inputs: [], outputs: [{ externalId: "out", label: "Out", nodeId: "inner", portId: "out" }],
      parameters: [{ ...fileParameter, targets: [{ nodeId: "inner", key: "file" }] }],
    };
    const runtime = createAppRuntime({ identityStorage: null, components: nested ? [definition, outer] : [definition] });
    const moved = encodeFixtureGlb({ nodes: [{ name: "a", translation: [8, 0, 0], mesh: [cubePrimitive()] }] });
    const movedMesh = prepareMesh(moved, "");
    if (movedMesh === null) throw new Error("Moved fixture must contain a mesh");
    const files = ["media/small.glb", "media/large.glb"];
    const fetchFile = vi.fn(async (url: string) => {
      const bytes = url === files[0] ? small : url === files[1] ? large : url === "media/moved.glb" ? moved : undefined;
      if (bytes === undefined) throw new Error(`Unexpected fixture file: ${url}`);
      return new Response(new Uint8Array(bytes));
    });
    vi.stubGlobal("fetch", fetchFile);
    const unregister = vi.fn();
    const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>(() => unregister);
    const backend = { registerMediaSource } as unknown as LoomBackend;
    try {
      const instances: string[] = [];
      for (const file of files) {
        const placed = await runtime.bus.execute("component.instantiate", { componentId: nested ? outer.componentId : definition.componentId }, runtime.invocation);
        expect(placed.status).toBe("applied");
        const id = placed.output.nodeId!;
        instances.push(id);
        const written = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
          { op: "setParameters", nodeId: id, parameters: { file } },
        ] }, runtime.invocation);
        expect(written.status).toBe("applied");
      }
      const definitionsBefore = JSON.stringify(runtime.components.all());
      const hook = renderHook(() => {
        useSyncExternalStore(runtime.bus.store.subscribe, runtime.bus.store.getGraph);
        const compiled = useGraphCompile(runtime, TIER_B_CAPABILITIES);
        return useMeshSources(runtime, backend, compiled.flatGraph);
      });
      await waitFor(() => {
        const flat = runtime.flattened.current().graph;
        for (const [index, owner] of instances.entries()) {
          const meshId = `${owner}/${nested ? "inner/" : ""}mesh`;
          const parameters = flat.nodes[meshId]?.parameters;
          expect(parameters).toMatchObject(prepared[index]!.facts);
          const ids = meshSourceIdsFor(meshId);
          for (const [sourceId, bytes] of [[ids.points, prepared[index]!.points], [ids.indices, prepared[index]!.indices]] as const) {
            const call = registerMediaSource.mock.calls.findLast(each => each[0] === sourceId);
            expect(call?.[1].currentFrame()?.bytes).toEqual(bytes);
          }
        }
      });
      expect(hook.result.current.diagnostics).toEqual([]);
      expect(fetchFile).toHaveBeenCalledTimes(2);
      const firstFacts = runtime.flattened.current().graph.nodes[`${instances[0]}/${nested ? "inner/" : ""}mesh`]!.parameters;
      await act(async () => {
        const changed = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
          { op: "setParameters", nodeId: instances[1]!, parameters: { file: "media/moved.glb" } },
        ] }, runtime.invocation);
        expect(changed.status).toBe("applied");
      });
      const secondMeshId = `${instances[1]}/${nested ? "inner/" : ""}mesh`;
      await waitFor(() => {
        expect(runtime.flattened.current().graph.nodes[secondMeshId]!.parameters).toMatchObject(movedMesh.facts);
        const call = registerMediaSource.mock.calls.findLast(each => each[0] === meshSourceIdsFor(secondMeshId).points);
        expect(call?.[1].currentFrame()?.bytes).toEqual(movedMesh.points);
      });
      expect(runtime.flattened.current().graph.nodes[`${instances[0]}/${nested ? "inner/" : ""}mesh`]!.parameters).toEqual(firstFacts);
      expect(fetchFile).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(runtime.components.all())).toBe(definitionsBefore);
      hook.unmount();
      expect(unregister).toHaveBeenCalledTimes(registerMediaSource.mock.calls.length);
      const saved = buildProjectFile({ document: runtime.projectDocument(), components: runtime.components.all() });
      const parsed = parseProjectDocument(saved.text);
      if (!parsed.ok) throw new Error(parsed.reason);
      const reopened = createAppRuntime({ identityStorage: null, document: parsed.document, components: runtime.components.all() });
      const beforeReopen = registerMediaSource.mock.calls.length;
      try {
        const reloaded = renderHook(() => useMeshSources(reopened, backend, reopened.flattened.current().graph));
        await waitFor(() => expect(registerMediaSource.mock.calls.length).toBe(beforeReopen + 4));
        expect(reloaded.result.current.diagnostics).toEqual([]);
        expect(reopened.flattened.current().graph.nodes[secondMeshId]!.parameters).toMatchObject(movedMesh.facts);
        reloaded.unmount();
        expect(unregister).toHaveBeenCalledTimes(registerMediaSource.mock.calls.length);
      } finally { reopened.dispose(); }
    } finally { runtime.dispose(); }
  });

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
