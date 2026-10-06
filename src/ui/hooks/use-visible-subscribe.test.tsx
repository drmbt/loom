// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSyncExternalStore } from "react";
import { VIEW_CLIP_ATTRIBUTE, isElementVisible, useVisibleSubscribe } from "./use-visible-subscribe.ts";

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

/**
 * T1691b, T1683b — WHY THIS MATTERS: a node tile on a canvas fitted to 220 nodes wrote its
 * bars ten times a second at a fifth of a pixel tall, and a fullscreen Viewer still paid
 * for every tile under it. Each write is a raster of the canvas. So the three reasons below
 * must STOP the listener, and each must give it back the moment the reason ends, with no
 * tick of the store in between: a tile that waits for the next tick shows an old value for
 * up to a tenth of a second, and for ever while nothing is playing.
 */
describe("T1691b — an element nobody can see or read is not told, and is told at once when it can be", () => {
  /** A box with a size on screen (`at`) and a size in its own layout (`layout`), under a parent that may clip a view. */
  function placed() {
    const parent = document.createElement("div");
    const box = document.createElement("div");
    parent.append(box);
    document.body.append(parent);
    const at = { left: 100, top: 100, width: 200, height: 40 };
    let laidOut = 40;
    box.checkVisibility = () => true;
    box.getBoundingClientRect = () => new DOMRect(at.left, at.top, at.width, at.height);
    Object.defineProperty(box, "offsetHeight", { configurable: true, get: () => laidOut });
    return { parent, box, at, layout: (next: number) => { laidOut = next; } };
  }
  function gated(view: ReturnType<typeof placed>, legibleScale?: number) {
    const watched = observers();
    vi.stubGlobal("MutationObserver", watched.Observer);
    const store = source();
    const ref = { current: view.box as Element | null };
    const hook = renderHook(() => useVisibleSubscribe(ref, store.subscribe, legibleScale));
    const listener = vi.fn();
    const stop = hook.result.current(listener);
    /** An attribute of an ancestor changed: the canvas zoomed or panned, a pane was shown. */
    const ancestorChanged = (): void => watched.instances[watched.instances.length - 1]!.emit();
    return { store, listener, stop, ancestorChanged };
  }

  it("TOO SMALL: drawn at 5 % of its size it is not told; zoomed to 50 % it is told before any tick", () => {
    const view = placed();
    view.at.height = 2;
    const { store, listener, ancestorChanged } = gated(view, 0.25);
    store.emit();
    store.emit();
    expect(listener, "a tile at a twentieth of its size was written").not.toHaveBeenCalled();
    view.at.height = 20;
    ancestorChanged();
    expect(listener, "the tile grew readable and was not told: it shows the value from before").toHaveBeenCalledOnce();
    store.emit();
    expect(listener).toHaveBeenCalledTimes(2);
    // Exactly at the line it reads: a quarter is legible, under it is not.
    view.at.height = 10;
    store.emit();
    expect(listener).toHaveBeenCalledTimes(3);
    view.at.height = 9.9;
    store.emit();
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("the size rule is only for a subscriber that says what size it reads at: a small panel is still told", () => {
    const view = placed();
    view.at.height = 2;
    const { store, listener } = gated(view);
    store.emit();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("OFF SCREEN: outside the view its ancestor clips to, or outside the window, it is not told; panned in, it is told at once", () => {
    const view = placed();
    view.parent.setAttribute(VIEW_CLIP_ATTRIBUTE, "");
    view.parent.getBoundingClientRect = () => new DOMRect(0, 0, 500, 400);
    view.at.left = 600;
    const { store, listener, ancestorChanged } = gated(view);
    store.emit();
    expect(listener, "a tile panned out of the canvas was written").not.toHaveBeenCalled();
    // One pixel of it inside the view is on screen.
    view.at.left = 499;
    ancestorChanged();
    expect(listener, "the tile came into the view and was not told").toHaveBeenCalledOnce();
    // Inside its view, and the view itself is beyond the window's edge.
    view.parent.getBoundingClientRect = () => new DOMRect(0, 0, 5000, 400);
    view.at.left = window.innerWidth + 10;
    store.emit();
    expect(listener).toHaveBeenCalledOnce();
  });

  it("COVERED: under another element's fullscreen it is not told; the moment fullscreen ends it is, with no tick", () => {
    const view = placed();
    const viewer = document.createElement("div");
    document.body.append(viewer);
    let fullscreen: Element | null = viewer;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fullscreen });
    try {
      const { store, listener, stop } = gated(view);
      store.emit();
      expect(listener, "a tile under a fullscreen Viewer was written").not.toHaveBeenCalled();
      fullscreen = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(listener, "fullscreen ended and the tile was not told: it shows the value from before").toHaveBeenCalledOnce();
      // The app itself fullscreen covers nothing of it.
      fullscreen = document.documentElement;
      store.emit();
      expect(listener).toHaveBeenCalledTimes(2);
      // Nothing is left listening once the last subscriber is gone.
      fullscreen = viewer;
      store.emit();
      stop();
      fullscreen = null;
      document.dispatchEvent(new Event("fullscreenchange"));
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(document, "fullscreenElement");
    }
  });

  it("the window resized over a tile that was outside it: told at once", () => {
    const view = placed();
    view.at.left = window.innerWidth + 50;
    const { store, listener } = gated(view);
    store.emit();
    expect(listener).not.toHaveBeenCalled();
    view.at.left = 10;
    window.dispatchEvent(new Event("resize"));
    expect(listener).toHaveBeenCalledOnce();
  });

  it("one predicate answers for everyone who asks whether an element is seen", () => {
    const view = placed();
    expect(isElementVisible(view.box)).toBe(true);
    view.at.height = 2;
    expect(isElementVisible(view.box), "no size was asked for").toBe(true);
    expect(isElementVisible(view.box, 0.25)).toBe(false);
    // A box with no size at all is not measured: nothing says how large it is drawn.
    view.at.width = 0;
    view.at.height = 0;
    expect(isElementVisible(view.box, 0.25)).toBe(true);
  });
});
