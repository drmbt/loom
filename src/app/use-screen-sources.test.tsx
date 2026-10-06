// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
import { StrictMode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoomBackend, MediaSource } from "@runtime/backend/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import { createAppRuntime } from "./app-runtime.ts";
import { useScreenSources } from "./use-screen-sources.ts";
import type { OpenedScreenCapture, ScreenCaptureEnvironment } from "./screen-capture.ts";

afterEach(cleanup);

function capture(label = "Video tab") {
  const listeners = new Map<string, Set<() => void>>();
  const ended = new Set<() => void>();
  const element = {
    videoWidth: 640, videoHeight: 360,
    addEventListener(type: string, callback: () => void) {
      const callbacks = listeners.get(type) ?? new Set();
      callbacks.add(callback); listeners.set(type, callbacks);
    },
    removeEventListener(type: string, callback: () => void) { listeners.get(type)?.delete(callback); },
    emit(type: string) { for (const callback of [...(listeners.get(type) ?? [])]) callback(); },
  };
  return {
    element, label, stop: vi.fn(),
    onEnded(callback: () => void) { ended.add(callback); return () => { ended.delete(callback); }; },
    end() { for (const callback of [...ended]) callback(); },
    listenerCount() { return [...listeners.values()].reduce((count, callbacks) => count + callbacks.size, 0) + ended.size; },
  } satisfies OpenedScreenCapture & { end(): void; listenerCount(): number };
}

function backend() {
  const sources = new Map<string, MediaSource>();
  const register = vi.fn((id: string, source: MediaSource) => {
    sources.set(id, source);
    return () => { if (sources.get(id) === source) sources.delete(id); };
  });
  return { backend: { registerMediaSource: register } as unknown as LoomBackend, sources, register };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function setup(environment: ScreenCaptureEnvironment, withoutBackend = false) {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Tester" } });
  const added = await runtime.bus.execute("graph.applyPatch", {
    baseRevision: runtime.bus.store.getRevision(), label: "Screen input",
    operations: [{ op: "addNode", ref: "$screen", type: "screenIn", position: { x: 0, y: 0 } }],
  }, runtime.invocation);
  expect(added.status).toBe("applied");
  const graph = runtime.bus.store.getGraph();
  const id = Object.keys(graph.nodes)[0]!;
  const gpu = backend();
  const props = { runtime, graph, backend: withoutBackend ? null : gpu.backend, environment };
  const hook = renderHook(input => useScreenSources(input.runtime, input.backend, flatDocument(input.graph), input.environment), {
    initialProps: props, wrapper: StrictMode,
  });
  return { ...hook, props, id, gpu, runtime };
}

describe("Screen In session ownership", () => {
  it("never opens on restoration or StrictMode mount, and invokes the picker on the start stack", async () => {
    const opening = deferred<OpenedScreenCapture>();
    const open = vi.fn(() => opening.promise);
    const h = await setup({ open });
    expect(open).not.toHaveBeenCalled();
    let started!: Promise<void>;
    act(() => {
      started = h.result.current.start(h.id);
      expect(open).toHaveBeenCalledTimes(1);
    });
    expect(h.result.current.statuses[h.id]?.phase).toBe("choosing");
    const stream = capture();
    await act(async () => { opening.resolve(stream); await started; });
    expect(h.result.current.statuses[h.id]?.phase).toBe("sharing");
    const source = h.gpu.sources.get(mediaSourceIdFor(h.id))!;
    expect(source.currentFrame()).toBeUndefined();
    stream.element.emit("timeupdate");
    const frame = source.currentFrame();
    expect(frame?.image).toBe(stream.element);
    expect(source.currentFrame()?.frameId).toBe(frame?.frameId);
    expect(h.runtime.bus.store.getGraph().nodes[h.id]?.resolution).toBeUndefined();
    const revision = h.runtime.bus.store.getRevision();
    await act(async () => { stream.element.emit("resize"); });
    expect(h.runtime.bus.store.getRevision()).toBe(revision);
    stream.element.videoWidth = 800;
    await act(async () => { stream.element.emit("resize"); });
    expect(h.runtime.bus.store.getRevision()).toBe(revision);
    expect(h.runtime.bus.store.getGraph().nodes[h.id]?.resolution).toBeUndefined();
    h.unmount();
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(stream.listenerCount()).toBe(0);
    expect(h.gpu.sources.size).toBe(0);
  });

  it("discards a stream returned after Stop, without registering or changing resolution", async () => {
    const opening = deferred<OpenedScreenCapture>();
    const h = await setup({ open: () => opening.promise });
    const revision = h.runtime.bus.store.getRevision();
    let started!: Promise<void>;
    act(() => { started = h.result.current.start(h.id); h.result.current.stop(h.id); });
    const stream = capture();
    await act(async () => { opening.resolve(stream); await started; });
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(h.gpu.register).not.toHaveBeenCalled();
    expect(h.runtime.bus.store.getRevision()).toBe(revision);
    expect(h.result.current.statuses[h.id]?.phase).toBe("idle");
  });

  it("aborts in-progress browser preparation on Stop instead of waiting for playback", async () => {
    let signal!: AbortSignal;
    const h = await setup({ open: current => {
      if (!current) throw new Error("Capture preparation requires its owner's cancellation signal.");
      signal = current;
      return new Promise((_resolve, reject) => current.addEventListener("abort", () => reject(current.reason), { once: true }));
    } });
    let started!: Promise<void>;
    act(() => { started = h.result.current.start(h.id); });
    expect(signal.aborted).toBe(false);
    await act(async () => { h.result.current.stop(h.id); await started; });
    expect(signal.aborted).toBe(true);
    expect(h.result.current.statuses[h.id]?.phase).toBe("idle");
    expect(h.gpu.sources.size).toBe(0);
  });

  it("keeps the current stream on re-share refusal, then replaces and stops it exactly once", async () => {
    const first = capture("First tab"), second = capture("Second tab");
    const open = vi.fn().mockResolvedValueOnce(first).mockRejectedValueOnce(new DOMException("Denied", "NotAllowedError")).mockResolvedValueOnce(second);
    const h = await setup({ open });
    await act(async () => { await h.result.current.start(h.id); });
    await act(async () => { await h.result.current.start(h.id); });
    expect(h.result.current.statuses[h.id]).toMatchObject({ phase: "sharing", label: "First tab", message: expect.stringContaining("cancelled") });
    expect(first.stop).not.toHaveBeenCalled();
    await act(async () => { await h.result.current.start(h.id); });
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(h.gpu.sources.get(mediaSourceIdFor(h.id))).toBeDefined();
    expect(h.result.current.statuses[h.id]).toEqual({ phase: "sharing", label: "Second tab" });
    act(() => { second.end(); });
    expect(second.stop).toHaveBeenCalledTimes(1);
    expect(second.listenerCount()).toBe(0);
    expect(h.gpu.sources.size).toBe(0);
    expect(h.result.current.statuses[h.id]?.phase).toBe("ended");
  });

  it("owns only the newest concurrent picker result", async () => {
    const a = deferred<OpenedScreenCapture>(), b = deferred<OpenedScreenCapture>();
    const open = vi.fn().mockReturnValueOnce(a.promise).mockReturnValueOnce(b.promise);
    const h = await setup({ open });
    let first!: Promise<void>, second!: Promise<void>;
    act(() => { first = h.result.current.start(h.id); second = h.result.current.start(h.id); });
    const old = capture("Old"), current = capture("Current");
    await act(async () => { b.resolve(current); await second; a.resolve(old); await first; });
    expect(old.stop).toHaveBeenCalledTimes(1);
    expect(current.stop).not.toHaveBeenCalled();
    expect(h.result.current.statuses[h.id]?.label).toBe("Current");
    expect(h.gpu.register).toHaveBeenCalledTimes(1);
  });

  it("keeps the replacement picker alive when the old shared surface ends", async () => {
    const first = capture("Old tab");
    const replacement = deferred<OpenedScreenCapture>();
    const open = vi.fn().mockResolvedValueOnce(first).mockReturnValueOnce(replacement.promise);
    const h = await setup({ open });
    await act(async () => { await h.result.current.start(h.id); });
    let started!: Promise<void>;
    act(() => { started = h.result.current.start(h.id); first.end(); });
    expect(first.stop).toHaveBeenCalledTimes(1);
    expect(h.result.current.statuses[h.id]).toEqual({ phase: "choosing" });
    const next = capture("New tab");
    await act(async () => { replacement.resolve(next); await started; });
    expect(next.stop).not.toHaveBeenCalled();
    expect(h.result.current.statuses[h.id]).toEqual({ phase: "sharing", label: "New tab" });
    expect(h.gpu.sources.size).toBe(1);
  });

  it.each(["muted", "bypassed", "deleted"])("retires a %s node and does not reopen it on graph edits", async flag => {
    const stream = capture();
    const open = vi.fn(async () => stream);
    const h = await setup({ open });
    await act(async () => { await h.result.current.start(h.id); });
    const graph = h.runtime.bus.store.getGraph();
    h.rerender({ ...h.props, graph: { ...graph, revision: graph.revision + 1 } });
    expect(open).toHaveBeenCalledTimes(1);
    expect(stream.stop).not.toHaveBeenCalled();
    const node = graph.nodes[h.id]!;
    const nodes = flag === "deleted" ? {} : { [h.id]: { ...node, ui: { [flag]: true } } };
    h.rerender({ ...h.props, graph: { ...graph, nodes } });
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(h.gpu.sources.size).toBe(0);
    expect(h.result.current.statuses[h.id]).toBeUndefined();
  });

  it("starts without a backend, attaches on readiness and survives device replacement without re-prompting", async () => {
    const stream = capture();
    const open = vi.fn(async () => stream);
    const h = await setup({ open }, true);
    await act(async () => { await h.result.current.start(h.id); });
    expect(h.result.current.statuses[h.id]?.phase).toBe("sharing");
    expect(h.gpu.register).not.toHaveBeenCalled();
    h.rerender({ ...h.props, backend: h.gpu.backend });
    expect(h.gpu.sources.size).toBe(1);
    const next = backend();
    h.rerender({ ...h.props, backend: next.backend });
    expect(h.gpu.sources.size).toBe(0);
    expect(next.sources.size).toBe(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(stream.stop).not.toHaveBeenCalled();
    h.unmount();
    expect(next.sources.size).toBe(0);
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it("does not leak a pending result across project identity changes, even with the same node id", async () => {
    const opening = deferred<OpenedScreenCapture>();
    const h = await setup({ open: () => opening.promise });
    let started!: Promise<void>;
    act(() => { started = h.result.current.start(h.id); });
    h.rerender({ ...h.props, runtime: { ...h.runtime, documentIdentity: "another-project" } });
    const stream = capture();
    await act(async () => { opening.resolve(stream); await started; });
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(h.gpu.register).not.toHaveBeenCalled();
    expect(h.result.current.statuses).toEqual({});
  });

  it("cleans a late result after unmount and releases an active stream on pagehide", async () => {
    const opening = deferred<OpenedScreenCapture>();
    const h = await setup({ open: () => opening.promise });
    let started!: Promise<void>;
    act(() => { started = h.result.current.start(h.id); });
    h.unmount();
    const late = capture();
    await act(async () => { opening.resolve(late); await started; });
    expect(late.stop).toHaveBeenCalledTimes(1);
    const stream = capture();
    const active = await setup({ open: async () => stream });
    await act(async () => { await active.result.current.start(active.id); });
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(active.gpu.sources.size).toBe(0);
    expect(active.result.current.statuses[active.id]?.phase).toBe("ended");
    active.unmount();
    expect(stream.stop).toHaveBeenCalledTimes(1);
  });

  it("reports registration failures and stops the acquired stream", async () => {
    const stream = capture();
    const h = await setup({ open: async () => stream });
    h.gpu.register.mockImplementation(() => { throw new Error("Registration failed"); });
    await act(async () => { await h.result.current.start(h.id); });
    expect(stream.stop).toHaveBeenCalledTimes(1);
    expect(stream.listenerCount()).toBe(0);
    expect(h.result.current.diagnostics).toEqual([expect.objectContaining({ code: "media.screenCapture", message: "Registration failed", nodeId: h.id })]);
  });

  it("preserves a Common resolution override when sharing and when the source resizes", async () => {
    const stream = capture();
    const h = await setup({ open: async () => stream });
    await h.runtime.bus.execute("node.setResolution", { nodeId: h.id, resolution: { mode: "fixed", width: 320, height: 180 } }, h.runtime.invocation);
    h.rerender({ ...h.props, graph: h.runtime.bus.store.getGraph() });
    const revision = h.runtime.bus.store.getRevision();
    await act(async () => { await h.result.current.start(h.id); });
    stream.element.videoWidth = 1920;
    stream.element.videoHeight = 1080;
    await act(async () => { stream.element.emit("resize"); });
    expect(h.runtime.bus.store.getGraph().nodes[h.id]?.resolution).toEqual({ mode: "fixed", width: 320, height: 180 });
    expect(h.runtime.bus.store.getRevision()).toBe(revision);
    expect(h.result.current.diagnostics).toEqual([]);
  });
});
