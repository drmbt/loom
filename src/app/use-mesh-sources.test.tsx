// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { useSyncExternalStore } from "react";
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

/*
 * VN33 — the literal bug: a Mesh File In inside a component drew nothing. The loader found
 * the node by `getGraph().nodes[nodeId]`, an inner node's id is flattened (`instance/inner`)
 * and the document does not hold it, so the facts were never written and the node stayed
 * the one-vertex stand-in. They are now that INSTANCE's overrides: each instance carries the
 * size of the file it loads, and the shared definition is not touched.
 */
describe("VN33: a mesh inside a component", () => {
  const one = encodeFixtureGlb({ nodes: [{ name: "a", mesh: [cubePrimitive()] }] });
  const two = encodeFixtureGlb({ nodes: [{ name: "a", mesh: [cubePrimitive()] }, { name: "b", translation: [3, 0, 0], mesh: [cubePrimitive()] }] });
  const factsOf = (bytes: Uint8Array) => {
    const prepared = prepareMesh(bytes, "");
    if (prepared === null) throw new Error("fixture must contain a mesh");
    return prepared.facts;
  };

  async function fixture(nested = false) {
    const runtime = createAppRuntime({ identityStorage: null });
    const { bus, invocation } = runtime;
    const added = await bus.execute("graph.applyPatch", { baseRevision: 0, operations: [
      { op: "addNode", ref: "$mesh", type: "meshFileIn", position: { x: 0, y: 0 }, parameters: { file: "media/one.glb" } },
      { op: "addNode", ref: "$geo", type: "geometry", position: { x: 200, y: 0 } },
      { op: "connect", source: { nodeId: "$mesh", portId: "out" }, target: { nodeId: "$geo", portId: "points" } },
    ] }, invocation);
    expect(added.status).toBe("applied");
    const meshId = added.output.createdIds["$mesh"]!;
    let saved = await bus.execute("component.saveSelection", { nodeIds: [meshId], name: "Stage" }, invocation);
    expect(saved.status).toBe("applied");
    if (nested) {
      saved = await bus.execute("component.saveSelection", { nodeIds: [saved.output.instanceNodeId!], name: "Venue" }, invocation);
      expect(saved.status).toBe("applied");
    }
    const second = await bus.execute("component.instantiate", { componentId: saved.output.componentId! }, invocation);
    expect(second.status).toBe("applied");
    return { runtime, meshId, componentId: saved.output.componentId!, first: saved.output.instanceNodeId!, second: second.output.nodeId! };
  }

  const serve = (files: Record<string, Uint8Array>) =>
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array(files[url]!))));
  const useFlatGraph = (runtime: ReturnType<typeof createAppRuntime>) =>
    useSyncExternalStore(runtime.bus.store.subscribe, () => runtime.flattened.current().graph);

  it("sizes each instance for the file IT loads, through the bus, and leaves the definition alone", async () => {
    const { runtime, meshId, componentId, first, second } = await fixture();
    try {
      // The second instance loads another file: its own override, beside the size.
      const routed = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId: second, internalNodeId: meshId, parameters: { file: "media/two.glb" } },
      ] }, runtime.invocation);
      expect(routed.status).toBe("applied");
      serve({ "media/one.glb": one, "media/two.glb": two });
      const definitionBefore = JSON.stringify(runtime.components.latest(componentId));
      // What is registered NOW: the effect re-runs after each write and releases what it fed.
      const live = new Map<string, Uint8Array>();
      const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>((id, source) => {
        live.set(id, source.currentFrame()!.bytes as Uint8Array);
        return () => live.delete(id);
      });
      const backend = { registerMediaSource } as unknown as LoomBackend;
      const stateOf = () => [first, second].map(id => JSON.stringify(runtime.bus.store.getGraph().nodes[id]!.state ?? {}));
      const before = stateOf();

      const hook = renderHook(() => useMeshSources(runtime, backend, useFlatGraph(runtime)));
      const ids = [meshSourceIdsFor(`${first}/${meshId}`), meshSourceIdsFor(`${second}/${meshId}`)];
      await waitFor(() => expect([...live.keys()].sort()).toEqual([ids[0]!.points, ids[0]!.indices, ids[1]!.points, ids[1]!.indices].sort()));
      expect(hook.result.current.diagnostics).toEqual([]);
      // Each instance is fed ITS file's bytes.
      expect(live.get(ids[0]!.points)).toEqual(prepareMesh(one, "")!.points);
      expect(live.get(ids[1]!.points)).toEqual(prepareMesh(two, "")!.points);

      const flat = runtime.flattened.current().graph.nodes;
      for (const [instance, facts] of [[first, factsOf(one)], [second, factsOf(two)]] as const) {
        expect(flat[`${instance}/${meshId}`]!.parameters).toMatchObject({ vertices: facts.vertices, triangles: facts.triangles, parts: facts.parts, bounds: facts.bounds });
      }
      expect(factsOf(two).vertices).not.toBe(factsOf(one).vertices);
      // Nothing was written into the shared definition.
      expect(JSON.stringify(runtime.components.latest(componentId))).toBe(definitionBefore);
      hook.unmount();

      // One measure is one undo step: two undos restore both instances exactly as they were.
      const measured = stateOf();
      expect(measured.filter((state, index) => state !== before[index])).toHaveLength(2);
      expect((await runtime.bus.execute("graph.undo", {}, runtime.invocation)).status).toBe("applied");
      expect(stateOf().filter((state, index) => state === before[index])).toHaveLength(1);
      expect((await runtime.bus.execute("graph.undo", {}, runtime.invocation)).status).toBe("applied");
      expect(stateOf()).toEqual(before);
      expect(runtime.flattened.current().graph.nodes[`${second}/${meshId}`]!.parameters["file"]).toBe("media/two.glb");
    } finally { runtime.dispose(); }
  });

  it("the op refuses a node that is not an instance, and a nested path, by name", async () => {
    const { runtime, meshId, first } = await fixture();
    try {
      const geo = Object.values(runtime.bus.store.getGraph().nodes).find(node => node.type === "geometry")!.id;
      const send = (nodeId: string, internalNodeId: string) => runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), operations: [
        { op: "setParameters", nodeId, internalNodeId, parameters: { vertices: 8 } },
      ] }, runtime.invocation);
      const plain = await send(geo, meshId);
      expect(plain.status).toBe("rejected");
      expect(plain.diagnostics.map(d => d.code)).toEqual(["parameter.internal.notComponent"]);
      const nested = await send(first, `${meshId}/${meshId}`);
      expect(nested.status).toBe("rejected");
      expect(nested.diagnostics.map(d => d.code)).toEqual(["parameter.internal.nested"]);
    } finally { runtime.dispose(); }
  });

  it("refuses a mesh inside a NESTED component by name, and feeds nothing", async () => {
    const { runtime } = await fixture(true);
    try {
      serve({ "media/one.glb": one });
      const registerMediaSource = vi.fn<LoomBackend["registerMediaSource"]>(() => () => {});
      const backend = { registerMediaSource } as unknown as LoomBackend;
      const revision = runtime.bus.store.getRevision();
      const hook = renderHook(() => useMeshSources(runtime, backend, useFlatGraph(runtime)));
      await waitFor(() => expect(hook.result.current.diagnostics).toHaveLength(2));
      expect(hook.result.current.diagnostics.map(d => d.code)).toEqual(["mesh.unsizable", "mesh.unsizable"]);
      expect(hook.result.current.diagnostics[0]!.message).toContain("nested component");
      expect(registerMediaSource).not.toHaveBeenCalled();
      expect(runtime.bus.store.getRevision()).toBe(revision);
      hook.unmount();
    } finally { runtime.dispose(); }
  });
});
