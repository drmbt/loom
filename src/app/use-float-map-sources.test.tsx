// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flatDocument } from "@compiler/test-support.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { depthRecipeParameters, type PhotoDepthRecipe } from "@domain/media/photo-depth-recipe.ts";
import type { LoomBackend, MediaSource } from "@runtime/backend/index.ts";
import { encodeDepthExr } from "@runtime/media/depth-exr.ts";
import { makePreparedMap, withDepthRecipe } from "@runtime/media/prepared-map.ts";
import { PHOTO_DEPTH_LARGE_Q4F16, PHOTO_DEPTH_LARGE_FP16 } from "@runtime/models/model-catalogue.ts";
import { floatMapSourceIdFor } from "@nodes/definitions/float-map-in.ts";
import { useFloatMapSources } from "./use-float-map-sources.ts";

const photo = new Uint8Array([1, 2, 3]);
const photoHash = createHash("sha256").update(photo).digest("hex");

function graph(file = "/map.loom.exr", interpretation = "raw", photoUrl = "") {
  return flatDocument({
    revision: 1, groups: {}, edges: {},
    nodes: { map: { id: "map", type: "floatMapIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { file, interpretation, photo: photoUrl } } },
  } as unknown as GraphDocument);
}

function compiled(width = 2, height = 1, materialized = true): CompiledGraph {
  return { outputs: materialized ? [{ nodeId: "map", portId: "out", size: [width, height] }] : [] } as unknown as CompiledGraph;
}

function fakeBackend() {
  const sources = new Map<string, MediaSource>();
  const releases: string[] = [];
  const register = vi.fn((id: string, source: MediaSource) => {
    sources.set(id, source);
    return () => { sources.delete(id); releases.push(id); };
  });
  return { backend: { registerMediaSource: register } as unknown as LoomBackend, sources, releases, register };
}

function response(bytes: Uint8Array) {
  return { ok: true, status: 200, arrayBuffer: async () => bytes.slice().buffer as ArrayBuffer };
}

function raw(values = new Float32Array([1, 1 + 2 ** -23])) {
  return encodeDepthExr({ width: 2, height: 1, values });
}

function prepared(kind: "depth" | "mask" = "depth") {
  return encodeDepthExr(makePreparedMap(new Float32Array([0, 1]), 2, 1, {
    kind, source: { sha256: photoHash, width: 2, height: 1 },
    model: { id: "model", url: "https://example.com/model.onnx" }, inputSide: 518, registration: "stretch",
  }));
}

const largeRecipe: PhotoDepthRecipe = {
  version: 1, modelId: PHOTO_DEPTH_LARGE_Q4F16.id, inputSide: 518, backend: "webgpu", refinement: null,
};

function recipeGraph(recipe: PhotoDepthRecipe) {
  const document = graph("/map", "depth", "/photo");
  Object.assign(document.nodes["map"]!.parameters, depthRecipeParameters(recipe), { nativeMap: "/missing-native" });
  return document;
}

function preparedDepthV2(recipe = largeRecipe, url = PHOTO_DEPTH_LARGE_Q4F16.url) {
  const map = makePreparedMap(new Float32Array([4, 4 + 2 ** -21, 8]), 3, 1, {
    kind: "depth", source: { sha256: photoHash, width: 3, height: 1 },
    model: { id: recipe.modelId, url }, inputSide: recipe.inputSide, registration: "stretch",
  });
  return withDepthRecipe(map, recipe, recipe.refinement === null ? null : { sha256: "f".repeat(64), width: 3, height: 1 });
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("saved float map sources", () => {
  it("renders saved nondefault depth without inference or fetching its native parent", async () => {
    const backend = fakeBackend();
    const bytes = encodeDepthExr(preparedDepthV2());
    const fetchMock = vi.fn(async (url: string) => response(url === "/photo" ? photo : bytes));
    const worker = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("Worker", worker);
    const view = renderHook(() => useFloatMapSources(backend.backend, recipeGraph(largeRecipe), compiled(3, 1)));
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    const frame = backend.sources.get(floatMapSourceIdFor("map"))!.currentFrame()!;
    expect(new Float32Array(frame.bytes!.buffer, frame.bytes!.byteOffset, 3)).toEqual(new Float32Array([0, 2 ** -23, 1]));
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/map", "/photo"]);
    expect(worker).not.toHaveBeenCalled();
    expect(view.result.current.diagnostics).toEqual([]);
    await expect(view.result.current.settle()).resolves.toBeUndefined();
  });

  it.each([
    ["model", { depthModel: PHOTO_DEPTH_LARGE_FP16.id }],
    ["backend", { depthBackend: "wasm" }],
    ["refinement target", { refinementTarget: "4096" }],
    ["refinement radius", { refineRadius: 3 }],
    ["refinement spatial sigma", { refineSpatialSigma: 3 }],
    ["refinement color sigma", { refineColorSigma: 0.2 }],
  ])("invalidates a saved refined map after its %s changes and refuses export", async (_name, changes) => {
    const backend = fakeBackend();
    const recipe: PhotoDepthRecipe = { ...largeRecipe, refinement: { target: "source", radius: 2, spatialSigma: 2, colorSigma: 0.1 } };
    const bytes = encodeDepthExr(preparedDepthV2(recipe));
    const fetchMock = vi.fn(async (url: string) => response(url === "/photo" ? photo : bytes));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(({ doc }) => useFloatMapSources(backend.backend, doc, compiled(3, 1)), { initialProps: { doc: recipeGraph(recipe) } });
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    // Rendering the verified final map does not require the native prediction file.
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/map", "/photo"]);
    const changed = recipeGraph(recipe);
    Object.assign(changed.nodes["map"]!.parameters, changes);
    view.rerender({ doc: changed });
    expect(backend.sources.size).toBe(0);
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.settingsMismatch"));
    await expect(view.result.current.settle()).rejects.toThrow("Depth preparation settings differ");
    expect(backend.releases).toEqual([floatMapSourceIdFor("map")]);
    expect(backend.register).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/map", "/photo", "/map"]);
  });

  it("renders a saved model revision independently of the current inference catalogue", async () => {
    const backend = fakeBackend();
    const bytes = encodeDepthExr(preparedDepthV2(largeRecipe, "https://example.com/different-revision.onnx"));
    const fetchMock = vi.fn(async (url: string) => response(url === "/photo" ? photo : bytes));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(() => useFloatMapSources(backend.backend, recipeGraph(largeRecipe), compiled(3, 1)));
    await waitFor(() => expect(backend.register).toHaveBeenCalledOnce());
    await expect(view.result.current.settle()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/map", "/photo"]);
  });

  it("reports corrupt version 2 provenance explicitly and refuses export", async () => {
    const backend = fakeBackend();
    const map = preparedDepthV2();
    const bytes = encodeDepthExr(map);
    const prefix = new TextEncoder().encode('"semantics":"');
    const start = bytes.findIndex((_value, index) => prefix.every((value, offset) => bytes[index + offset] === value));
    expect(start).toBeGreaterThan(0);
    const offset = start + prefix.length;
    bytes.set(new TextEncoder().encode("metric-invalid!!"), offset);
    vi.stubGlobal("fetch", vi.fn(async () => response(bytes)));
    const view = renderHook(() => useFloatMapSources(backend.backend, recipeGraph(largeRecipe), compiled(3, 1)));
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.corrupt"));
    await expect(view.result.current.settle()).rejects.toThrow("unknown depth semantics");
    expect(backend.register).not.toHaveBeenCalled();
  });

  it("refuses invalid preparation selectors without blaming a valid saved map", async () => {
    const backend = fakeBackend();
    const document = recipeGraph(largeRecipe);
    document.nodes["map"]!.parameters["depthBackend"] = "unavailable-backend";
    vi.stubGlobal("fetch", vi.fn(async () => response(encodeDepthExr(preparedDepthV2()))));
    const view = renderHook(() => useFloatMapSources(backend.backend, document, compiled(3, 1)));
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.settingsMismatch"));
    await expect(view.result.current.settle()).rejects.toThrow("Depth preparation settings are invalid");
    expect(backend.register).not.toHaveBeenCalled();
  });

  it("keeps raw maps independent of preparation selectors", async () => {
    const backend = fakeBackend();
    const values = new Float32Array([-0, 1 + 2 ** -23]);
    const fetchMock = vi.fn<(url: string) => Promise<ReturnType<typeof response>>>(async () => response(raw(values)));
    vi.stubGlobal("fetch", fetchMock);
    const document = graph("/map", "raw", "/unavailable-photo");
    Object.assign(document.nodes["map"]!.parameters, { depthModel: "unavailable-model", refinementTarget: "invalid", nativeMap: "/unavailable-native" });
    const view = renderHook(() => useFloatMapSources(backend.backend, document, compiled()));
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    const frame = backend.sources.get(floatMapSourceIdFor("map"))!.currentFrame()!;
    expect(new Uint8Array(frame.bytes!)).toEqual(new Uint8Array(values.buffer));
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/map"]);
    await expect(view.result.current.settle()).resolves.toBeUndefined();
  });

  it("marks depth detail changes out of date and refuses export until regenerated", async () => {
    const backend = fakeBackend();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url === "/photo" ? photo : prepared())));
    const doc = graph("/map", "depth", "/photo");
    doc.nodes["map"]!.parameters["inputSide"] = "266";
    const view = renderHook(() => useFloatMapSources(backend.backend, doc, compiled()));
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.settingsMismatch"));
    expect(backend.register).not.toHaveBeenCalled();
    await expect(view.result.current.settle()).rejects.toThrow("Depth detail differs");
  });

  it("awaits data upload before export and rejects missing or corrupt maps", async () => {
    const backend = fakeBackend();
    let complete: ((value: ReturnType<typeof response>) => void) | undefined;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<ReturnType<typeof response>>(resolve => { complete = resolve; })));
    const view = renderHook(({ doc }) => useFloatMapSources(backend.backend, doc, compiled()), { initialProps: { doc: graph() } });
    let settled = false;
    const pending = view.result.current.settle().then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    await act(async () => { complete!(response(raw())); await pending; });
    expect(settled).toBe(true);
    expect(backend.register).toHaveBeenCalledTimes(1);
    view.rerender({ doc: graph("") });
    await expect(view.result.current.settle()).rejects.toThrow("Choose a saved float map");
    view.rerender({ doc: graph("/bad") });
    await act(async () => { complete!(response(new Uint8Array([0]))); });
    await expect(view.result.current.settle()).rejects.toThrow("Unrecognized numerical map");
  });
  it("uploads once with exact float32 bytes and retains identical requests", async () => {
    const backend = fakeBackend();
    const values = new Float32Array([-0, 1 + 2 ** -23]);
    const fetchMock = vi.fn(async () => response(raw(values)));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(({ doc, plan }) => useFloatMapSources(backend.backend, doc, plan), { initialProps: { doc: graph(), plan: compiled() } });
    expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.loading");
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    const source = backend.sources.get(floatMapSourceIdFor("map"))!;
    expect(source.ended).toBe(true);
    const frame = source.currentFrame()!;
    expect(frame.frameId).toBe(1);
    expect(new Uint8Array(frame.bytes!)).toEqual(new Uint8Array(values.buffer));
    expect(source.currentFrame()).toBe(frame);
    expect(view.result.current.diagnostics).toEqual([]);
    view.rerender({ doc: { ...graph(), revision: 2 }, plan: compiled() });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(backend.register).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(backend.releases).toEqual([floatMapSourceIdFor("map")]);
  });

  it("refuses stale photo provenance and matching-kind failures", async () => {
    const backend = fakeBackend();
    const fetchMock = vi.fn(async (url: string) => response(url === "/photo" ? new Uint8Array([9]) : prepared()));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(({ doc }) => useFloatMapSources(backend.backend, doc, compiled()), { initialProps: { doc: graph("/map", "depth", "/photo") } });
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.sourceMismatch"));
    expect(backend.register).not.toHaveBeenCalled();
    view.rerender({ doc: graph("/map", "mask", "/photo") });
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.interpretation"));
    expect(backend.register).not.toHaveBeenCalled();
  });

  it("verifies prepared depth and loads normalized samples without inference", async () => {
    const backend = fakeBackend();
    const fetchMock = vi.fn(async (url: string) => response(url === "/photo" ? photo : prepared()));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(() => useFloatMapSources(backend.backend, graph("/map", "depth", "/photo"), compiled()));
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    const bytes = backend.sources.get(floatMapSourceIdFor("map"))!.currentFrame()!.bytes!;
    expect(new Float32Array(bytes.buffer, bytes.byteOffset, 2)).toEqual(new Float32Array([0, 1]));
    expect(view.result.current.diagnostics).toEqual([]);
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/map", "/photo"]);
  });

  it("tracks the wired photo file and refuses stale results after its replacement", async () => {
    const backend = fakeBackend();
    const fetchMock = vi.fn(async (url: string) => response(url === "/map" ? prepared() : url === "/photo" ? photo : new Uint8Array([7])));
    vi.stubGlobal("fetch", fetchMock);
    const wired = (url: string) => {
      const document = graph("/map", "depth", "/copied-reference");
      return flatDocument({ ...document,
        nodes: { ...document.nodes, movie: { id: "movie", type: "movieFileIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { file: url } } },
        edges: { picture: { id: "picture", source: { nodeId: "movie", portId: "out" }, target: { nodeId: "map", portId: "picture" } } },
      });
    };
    const view = renderHook(({ doc }) => useFloatMapSources(backend.backend, doc, compiled()), { initialProps: { doc: wired("/photo") } });
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    view.rerender({ doc: wired("/different-photo") });
    expect(backend.sources.size).toBe(0);
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.sourceMismatch"));
    expect(fetchMock.mock.calls.map(call => call[0])).toEqual(["/map", "/photo", "/map", "/different-photo"]);
  });

  it("aborts replaced fetches and never publishes their late completion", async () => {
    const backend = fakeBackend();
    let finish: ((value: ReturnType<typeof response>) => void) | undefined;
    const fetchMock = vi.fn((url: string) => url === "/old" ? new Promise<ReturnType<typeof response>>(resolve => { finish = resolve; }) : Promise.resolve(response(raw(new Float32Array([3, 4])))));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(({ doc }) => useFloatMapSources(backend.backend, doc, compiled()), { initialProps: { doc: graph("/old") } });
    const signal = (fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal!;
    view.rerender({ doc: graph("/new") });
    expect(signal.aborted).toBe(true);
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    await act(async () => { finish!(response(raw())); });
    expect(backend.register).toHaveBeenCalledTimes(1);
  });

  it("releases a loaded source before a replacement loads or fails", async () => {
    const backend = fakeBackend();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => response(url === "/bad" ? new Uint8Array([0]) : raw())));
    const view = renderHook(({ doc }) => useFloatMapSources(backend.backend, doc, compiled()), { initialProps: { doc: graph() } });
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    view.rerender({ doc: graph("/bad") });
    expect(backend.sources.size).toBe(0);
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.corrupt"));
    expect(backend.releases).toHaveLength(1);
  });

  it("aborts on unmount before a pending response can register", async () => {
    const backend = fakeBackend();
    let finish: ((value: ReturnType<typeof response>) => void) | undefined;
    const fetchMock = vi.fn<(url: string, options: RequestInit) => Promise<ReturnType<typeof response>>>(() => new Promise(resolve => { finish = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(() => useFloatMapSources(backend.backend, graph(), compiled()));
    const signal = fetchMock.mock.calls[0]![1].signal!;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => { finish!(response(raw())); });
    expect(backend.register).not.toHaveBeenCalled();
  });

  it("reloads and rasterizes to changed output dimensions", async () => {
    const backend = fakeBackend();
    vi.stubGlobal("fetch", vi.fn(async () => response(raw(new Float32Array([0, 4])))));
    const view = renderHook(({ plan }) => useFloatMapSources(backend.backend, graph(), plan), { initialProps: { plan: compiled() } });
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(1));
    view.rerender({ plan: compiled(4, 1) });
    expect(backend.sources.size).toBe(0);
    await waitFor(() => expect(backend.register).toHaveBeenCalledTimes(2));
    const bytes = backend.sources.get(floatMapSourceIdFor("map"))!.currentFrame()!.bytes!;
    expect(new Float32Array(bytes.buffer, bytes.byteOffset, 4)).toEqual(new Float32Array([0, 1, 3, 4]));
  });

  it("re-registers for a replacement backend and releases on pruning", async () => {
    const first = fakeBackend();
    const second = fakeBackend();
    vi.stubGlobal("fetch", vi.fn(async () => response(raw())));
    const view = renderHook(({ backend, plan }) => useFloatMapSources(backend, graph(), plan), { initialProps: { backend: first.backend, plan: compiled() } });
    await waitFor(() => expect(first.register).toHaveBeenCalledTimes(1));
    view.rerender({ backend: second.backend, plan: compiled() });
    expect(first.releases).toHaveLength(1);
    await waitFor(() => expect(second.register).toHaveBeenCalledTimes(1));
    view.rerender({ backend: second.backend, plan: compiled(2, 1, false) });
    expect(second.releases).toHaveLength(1);
    expect(view.result.current.diagnostics).toEqual([]);
  });

  it("reports missing maps, missing photos and HTTP failures explicitly", async () => {
    const backend = fakeBackend();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404 }));
    vi.stubGlobal("fetch", fetchMock);
    const view = renderHook(({ doc }) => useFloatMapSources(backend.backend, doc, compiled()), { initialProps: { doc: graph("") } });
    expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.missing");
    view.rerender({ doc: graph("/map", "depth") });
    expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.sourceMissing");
    expect(fetchMock).not.toHaveBeenCalled();
    view.rerender({ doc: graph("/bad") });
    await waitFor(() => expect(view.result.current.diagnostics[0]?.code).toBe("floatMap.unavailable"));
  });
});
