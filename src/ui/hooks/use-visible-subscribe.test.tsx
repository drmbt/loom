// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { useVisibleSubscribe } from "./use-visible-subscribe.ts";

function source() {
  const listeners = new Set<() => void>();
  const off = vi.fn();
  let value = 0;
  return {
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); off(); };
    }),
    off,
    read: () => value,
    emit: () => { value++; for (const listener of [...listeners]) listener(); },
  };
}

function observers() {
  const instances: Observer[] = [];
  class Observer {
    private readonly callback: MutationCallback;
    constructor(callback: MutationCallback) { this.callback = callback; instances.push(this); }
    observe = vi.fn();
    disconnect = vi.fn();
    takeRecords = (): MutationRecord[] => [];
    emit = (): void => this.callback([], this);
  }
  return { Observer, instances };
}

function element() {
  const box = document.createElement("div");
  document.body.append(box);
  let visible = true;
  const check = vi.fn(() => visible);
  box.checkVisibility = check;
  return { box, check, show: (next: boolean) => { visible = next; } };
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("one visibility gate shares work across its subscribers", () => {
  it("94 listeners share one observer, subscription and visibility check per emission", () => {
    const watched = observers();
    vi.stubGlobal("MutationObserver", watched.Observer);
    const view = element(), store = source();
    const ref = { current: view.box as Element | null };
    const hook = renderHook(() => useVisibleSubscribe(ref, store.subscribe));
    const listeners = Array.from({ length: 94 }, () => vi.fn());
    const stop = listeners.map(listener => hook.result.current(listener));
    expect(watched.instances).toHaveLength(1);
    expect(store.subscribe).toHaveBeenCalledOnce();
    expect(view.check).toHaveBeenCalledOnce();
    view.check.mockClear();
    store.emit();
    expect(view.check).toHaveBeenCalledOnce();
    for (const listener of listeners) expect(listener).toHaveBeenCalledOnce();

    view.show(false);
    store.emit();
    for (const listener of listeners) expect(listener).toHaveBeenCalledOnce();
    view.show(true);
    view.check.mockClear();
    watched.instances[0]!.emit();
    expect(view.check).toHaveBeenCalledOnce();
    for (const listener of listeners) expect(listener).toHaveBeenCalledTimes(2);
    watched.instances[0]!.emit();
    for (const listener of listeners) expect(listener).toHaveBeenCalledTimes(2);

    stop[0]!();
    expect(store.off).not.toHaveBeenCalled();
    expect(watched.instances[0]!.disconnect).not.toHaveBeenCalled();
    store.emit();
    expect(listeners[0]).toHaveBeenCalledTimes(2);
    for (const listener of listeners.slice(1)) expect(listener).toHaveBeenCalledTimes(3);
    for (const unsubscribe of stop.slice(1)) unsubscribe();
    expect(store.off).toHaveBeenCalledOnce();
    expect(watched.instances[0]!.disconnect).toHaveBeenCalledOnce();
    watched.instances[0]!.emit();
    expect(watched.instances).toHaveLength(1);
    const stopAgain = hook.result.current(listeners[0]!);
    expect(watched.instances).toHaveLength(2);
    expect(store.subscribe).toHaveBeenCalledTimes(2);
    stopAgain();
  });

  it("moves observation to the floated element's own document when the ref changes", () => {
    const watched = observers(), floated = observers();
    vi.stubGlobal("MutationObserver", watched.Observer);
    const view = element(), store = source();
    const ref = { current: view.box as Element | null };
    const hook = renderHook(() => useVisibleSubscribe(ref, store.subscribe));
    const listener = vi.fn();
    const stop = hook.result.current(listener);
    const iframe = document.createElement("iframe");
    document.body.append(iframe);
    const foreignDocument = iframe.contentDocument!;
    Object.defineProperty(iframe.contentWindow!, "MutationObserver", { configurable: true, value: floated.Observer });
    const foreign = foreignDocument.createElement("div");
    foreignDocument.body.append(foreign);
    foreign.checkVisibility = vi.fn(() => true);
    ref.current = foreign;
    store.emit();
    expect(watched.instances[0]!.disconnect).toHaveBeenCalledOnce();
    expect(floated.instances).toHaveLength(1);
    expect(floated.instances[0]!.observe).toHaveBeenCalledWith(foreignDocument.body, { attributes: true });
    expect(foreign.checkVisibility).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledOnce();
    stop();
    expect(floated.instances[0]!.disconnect).toHaveBeenCalledOnce();
  });

  it("external-store consumers replace ref and subscription without retaining the old gate", () => {
    const watched = observers();
    vi.stubGlobal("MutationObserver", watched.Observer);
    const first = element(), next = element();
    const initial = source(), replacement = source();
    const initialProps = { ref: { current: first.box as Element | null }, store: initial };
    const hook = renderHook(({ ref, store }) =>
      useSyncExternalStore(useVisibleSubscribe(ref, store.subscribe), store.read, store.read), { initialProps });
    act(() => initial.emit());
    expect(hook.result.current).toBe(1);
    hook.rerender({ ref: { current: next.box }, store: replacement });
    expect(initial.off).toHaveBeenCalledOnce();
    expect(watched.instances[0]!.disconnect).toHaveBeenCalledOnce();
    act(() => initial.emit());
    expect(hook.result.current).toBe(0);
    act(() => replacement.emit());
    expect(hook.result.current).toBe(1);
    expect(replacement.subscribe).toHaveBeenCalledOnce();
    hook.unmount();
    expect(replacement.off).toHaveBeenCalledOnce();
    expect(watched.instances[1]!.disconnect).toHaveBeenCalledOnce();
  });
});
