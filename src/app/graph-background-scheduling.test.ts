// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { useViewerSynthesis } from "./use-viewer-synthesis.ts";
import { useGraphBackground } from "./use-graph-background.ts";
import { createPreviewSinkStore } from "./preview-sinks.ts";

const calls = vi.hoisted(() => ({ update: vi.fn(), reset: vi.fn(), create: vi.fn() }));
vi.mock("@runtime/previews/index.ts", () => ({
  DEFAULT_PREVIEW_VIEW: {}, EMPTY_PREVIEW_PROGRAM: {}, createPreviewSystem: () => {calls.create();return calls;},
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("background selection scans only on graph/output changes, while rendering still ticks", () => {
  let tick!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { tick = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const ownKeys = vi.fn(Reflect.ownKeys);
  const graph = { revision: 1, nodes: new Proxy({
    a: { id: "a", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ui: { background: true } },
  }, { ownKeys }), edges: {}, groups: {} } as GraphDocument;
  const host = { dispose: vi.fn(), setPreviewProgram: vi.fn() };
  const backend = { previewHost: () => host, status: { deviceGeneration: 0 } } as unknown as LoomBackend;
  const canvasRef = { current: document.createElement("canvas") };
  const previewSinks = { set: vi.fn() };
  const inputs = { backend, canvasRef, graph, compiledOutputs: [] as ResolvedOutput[], previewSinks,
    previewFps: 30, previewLongEdge: 320, documentIdentity: "one" };
  const view = renderHook(props => useGraphBackground(props), { initialProps: inputs });
  act(() => { for (let i = 0; i < 60; i++) tick(i); });
  expect(ownKeys).toHaveBeenCalledTimes(1);
  expect(calls.update.mock.calls.length).toBeGreaterThanOrEqual(60);
  expect(previewSinks.set).toHaveBeenLastCalledWith([{ nodeId: "a", portId: "out" }], expect.any(Object));

  const output = { nodeId: "a", portId: "out", resourceId: "target:a:out", resourceKind: "target",
    size: [1280, 720], format: "rgba8unorm", space: "linear", temporal: false } as ResolvedOutput;
  view.rerender({ ...inputs, compiledOutputs: [output] }); act(() => tick(61));
  expect(ownKeys).toHaveBeenCalledTimes(2);
  expect(calls.update.mock.lastCall?.[0].requests[0].source.resourceId).toBe("target:a:out");

  view.rerender({ ...inputs, graph: { ...graph, nodes: {} }, documentIdentity: "two" }); act(() => tick(62));
  expect(calls.update.mock.lastCall?.[0].requests).toEqual([]);
  expect(host.setPreviewProgram).toHaveBeenCalled();
  view.unmount(); expect(host.dispose).toHaveBeenCalledOnce();
});

it("unused background submits nothing; removing the final mark clears once and can resume", () => {
  let tick!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { tick = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const host = { dispose: vi.fn(), setPreviewProgram: vi.fn() };
  const status = { deviceGeneration: 0 };
  const backend = { previewHost: () => host, status } as unknown as LoomBackend;
  const canvas = document.createElement("canvas");
  const measure = vi.spyOn(canvas, "getBoundingClientRect");
  const graph = { revision: 1, nodes: {}, edges: {}, groups: {} } as GraphDocument;
  const inputs = { backend, canvasRef: { current: canvas }, graph, compiledOutputs: [] as ResolvedOutput[],
    previewFps: 30, previewLongEdge: 320, documentIdentity: "one" };
  const view = renderHook(props => useGraphBackground(props), { initialProps: inputs });
  act(() => { for (let frame = 0; frame < 60; frame++) tick(frame); });
  expect(calls.update).not.toHaveBeenCalled();
  expect(measure).not.toHaveBeenCalled();

  const marked = { ...graph, nodes: {
    a: { id: "a", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ui: { background: true } },
  } } as GraphDocument;
  const output = { nodeId: "a", portId: "out", resourceId: "target:a:out", resourceKind: "target",
    size: [1280, 720], format: "rgba8unorm", space: "linear", temporal: false } as ResolvedOutput;
  view.rerender({ ...inputs, graph: marked, compiledOutputs: [output] });
  act(() => tick(60));
  expect(calls.update).toHaveBeenCalledOnce();
  expect(calls.update.mock.lastCall?.[0].requests).toHaveLength(1);

  view.rerender(inputs);
  act(() => { for (let frame = 61; frame < 121; frame++) tick(frame); });
  expect(calls.update).toHaveBeenCalledTimes(2);
  expect(calls.update.mock.lastCall?.[0].requests).toEqual([]);
  expect(measure).toHaveBeenCalledTimes(2);
  status.deviceGeneration++;
  act(() => tick(121));
  expect(calls.reset).toHaveBeenCalledOnce();
  expect(calls.update).toHaveBeenCalledTimes(2);

  view.rerender({ ...inputs, graph: marked, compiledOutputs: [output] });
  act(() => tick(122));
  expect(calls.update).toHaveBeenCalledTimes(3);
  expect(calls.update.mock.lastCall?.[0].requests).toHaveLength(1);
  view.unmount();
  measure.mockRestore();
});

it("background removal, document replacement and unmount retain another quiet consumer's demand", () => {
  vi.useFakeTimers();
  try {
    let tick!: FrameRequestCallback;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { tick = callback; return 1; });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const host = { dispose: vi.fn(), setPreviewProgram: vi.fn() };
    const backend = { previewHost: () => host, status: { deviceGeneration: 0 } } as unknown as LoomBackend;
    const previewSinks = createPreviewSinkStore(() => Date.now());
    previewSinks.set([{ nodeId: "quiet-tile", portId: "out" }], {});
    const graph = { revision: 1, nodes: {
      a: { id: "a", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ui: { background: true } },
    }, edges: {}, groups: {} } as GraphDocument;
    const inputs = { backend, canvasRef: { current: document.createElement("canvas") }, graph,
      compiledOutputs: [] as ResolvedOutput[], previewSinks, previewFps: 30, previewLongEdge: 320, documentIdentity: "one" };
    const view = renderHook(props => useGraphBackground(props), { initialProps: inputs });
    act(() => tick(0));
    expect(previewSinks.get().map(sink => sink.nodeId)).toEqual(["a", "quiet-tile"]);

    view.rerender({ ...inputs, graph: { ...graph, nodes: {} } });
    act(() => { tick(1); vi.advanceTimersByTime(1401); });
    expect(previewSinks.get().map(sink => sink.nodeId)).toEqual(["quiet-tile"]);

    view.rerender(inputs);
    act(() => tick(2));
    const nextGraph = { ...graph, nodes: { b: { ...graph.nodes["a"]!, id: "b" } } } as GraphDocument;
    view.rerender({ ...inputs, graph: nextGraph, documentIdentity: "two" });
    act(() => { tick(3); vi.advanceTimersByTime(1401); });
    expect(previewSinks.get().map(sink => sink.nodeId)).toEqual(["b", "quiet-tile"]);
    const replacementSinks = createPreviewSinkStore(() => Date.now());
    replacementSinks.set([{ nodeId: "other-tile", portId: "out" }], {});
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    view.rerender({ ...inputs, graph: nextGraph, documentIdentity: "two", previewSinks: replacementSinks });
    // No rAF and no graph/plan/identity edit: replacing only the writer resynchronizes.
    act(() => vi.advanceTimersByTime(1401));
    visibility.mockRestore();
    expect(previewSinks.get().map(sink => sink.nodeId)).toEqual(["quiet-tile"]);
    expect(replacementSinks.get().map(sink => sink.nodeId)).toEqual(["b", "other-tile"]);
    view.unmount();
    act(() => vi.advanceTimersByTime(1401));
    expect(replacementSinks.get().map(sink => sink.nodeId)).toEqual(["other-tile"]);
  } finally { vi.useRealTimers(); }
});

it.each(["background","viewer"] as const)("%s pauses live during export and resumes without recreating its preview system", kind => {
  let tick!:FrameRequestCallback,exporting=false;
  vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{tick=callback;return 1;});
  vi.stubGlobal("cancelAnimationFrame",vi.fn());
  const host={dispose:vi.fn(),setPreviewProgram:vi.fn()};
  const previewHost=vi.fn(()=>host);
  const status={deviceGeneration:0,framesSubmitted:0};
  const backend={previewHost,status} as unknown as LoomBackend;
  const graph={revision:1,nodes:{a:{id:"a",type:"noise",definitionVersion:1,position:{x:0,y:0},parameters:{},ui:{background:true}}},edges:{},groups:{}} as GraphDocument;
  const output={nodeId:"a",portId:"out",resourceId:"target:a:out",resourceKind:"target",size:[64,64],format:"rgba8unorm",space:"linear",temporal:false} as ResolvedOutput;
  const previewSinks={set:vi.fn()};
  const inputs={backend,canvasRef:{current:document.createElement("canvas")},graph,compiledOutputs:[output],output,
    previewSinks,previewFps:30,previewLongEdge:320,documentIdentity:"one",isExporting:()=>exporting};
  const usePreview=kind==="background"?useGraphBackground:useViewerSynthesis;
  const view=renderHook(()=>usePreview(inputs));
  act(()=>tick(0));
  const updates=calls.update.mock.calls.length,registrations=previewSinks.set.mock.calls.length;
  expect(updates).toBeGreaterThan(0);
  exporting=true;
  act(()=>{for(let i=1;i<=5;i++){status.framesSubmitted++;tick(i);}});
  expect(calls.update).toHaveBeenCalledTimes(updates);
  expect(previewSinks.set).toHaveBeenCalledTimes(registrations);
  expect(host.dispose).not.toHaveBeenCalled();
  exporting=false;act(()=>tick(6));
  expect(calls.update).toHaveBeenCalledTimes(updates+1);
  expect(previewHost).toHaveBeenCalledOnce();expect(calls.create).toHaveBeenCalledOnce();
  // Export suspension must not suppress device-loss invalidation (§V23).
  exporting=true;status.deviceGeneration++;act(()=>tick(7));
  expect(calls.reset).toHaveBeenCalled();
  expect(calls.update).toHaveBeenCalledTimes(updates+1);
  view.unmount();expect(host.dispose).toHaveBeenCalledOnce();
});
