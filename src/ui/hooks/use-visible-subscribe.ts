import { useMemo } from "react";
import type { RefObject } from "react";

/**
 * A visibility gate for external-store subscriptions (T1239).
 *
 * The telemetry hub and the value-history ring notify at 10 Hz whether or not anything
 * that renders them is on screen. Every dock pane stays MOUNTED while hidden (§V96), so a
 * hidden Performance tab re-rendered its whole table ten times a second for nobody — and
 * on E24 that was most of the idle commit budget. This hook wraps a store's `subscribe` so
 * the listener runs only while the subscribing element is SEEN, and runs once more the
 * instant the element is seen again. All consumers of this gate share one store
 * subscription and one observer, so a telemetry table checks visibility once per tick.
 * The store keeps aggregating; only the DOM
 * stops. A pane that comes back shows current data on its first paint (§V86) and never
 * rendered while it was hidden.
 *
 * ## Who decides an element is seen: `isElementVisible`, and nobody else (T1691b, T1683b)
 *
 * Four reasons for the one answer "nobody can see what a write here would change":
 *
 *  1. NO BOX: `display:none` on it or an ancestor (a hidden tab, a hidden pane).
 *  2. COVERED: another element is fullscreen and this one is not inside it. A Viewer taken
 *     fullscreen covers the whole editor; the browser still paints and rasters what is
 *     under it (measured on a 220-node project: 9.7 to 10.2 ms of raster a frame behind
 *     the Viewer).
 *  3. OFF SCREEN: its box is outside the window, or outside the nearest ancestor that says
 *     it clips its content to a view (`VIEW_CLIP_ATTRIBUTE`: the graph canvas, whose tiles
 *     are panned out of it).
 *  4. TOO SMALL (only for a subscriber that says what size it reads at, `legibleScale`):
 *     the element is drawn at less than that share of its own size. A node tile on a
 *     canvas fitted to 220 nodes is drawn at 5 %: a value bar is 0.2 px tall and its
 *     number half a pixel. Its ten writes a second changed nothing a person could read and
 *     made the browser raster the whole canvas again, 12 to 13 ms of every frame on the
 *     GPU process's main thread, which is what held that project at 24 frames a second
 *     where it runs at 47 without them.
 *
 * The scale is read from the element's own box (on-screen height over layout height), so
 * nothing has to tell a tile the canvas's zoom, no property is inherited through the nodes
 * (T1597b measured what that costs), and a scale from any other source counts the same.
 *
 * ## Nothing stale
 *
 * An element that becomes seen is told AT ONCE, before the frame that shows it paints:
 * its listener runs, so it reads the store as it is now. What can make it seen:
 *
 *  - an attribute of an ancestor (a `display:none` class or `data-state` is how every pane
 *    and tab hides; the canvas's pan and zoom are a `style` on the viewport; a dragged node
 *    is a `style` on its wrapper): ONE MutationObserver over the ancestors, whose callback
 *    is a microtask;
 *  - leaving fullscreen, and the window resized: one listener each, both run by the
 *    browser before it paints.
 *
 * A change of geometry that is none of those (a pane's edge dragged while a tile sits
 * outside it) is noticed on the store's next tick, which is where every reason is checked.
 *
 * Why not an IntersectionObserver: `Element.checkVisibility()` and a box answer
 * synchronously, so the decision is made on the tick itself. An IntersectionObserver
 * delivers a task AFTER the frame that first shows the element, which is exactly one stale
 * paint, and one created in the main window never fires for a pane floated into another one.
 * Every primitive here comes from the element's own document, so a floated pane works, and
 * the ancestor chain is re-collected whenever it changed (a pane moved between zones).
 *
 * Where `checkVisibility` does not exist (jsdom) everything counts as seen, and an element
 * whose box has no size is not measured (jsdom again, and an empty box paints nothing).
 */

export type Subscribe = (listener: () => void) => () => void;

/**
 * On an element that clips what is inside it to a view of its own: a subscriber under it
 * whose box lies outside it is off screen. Read here, written by the owner of the view.
 */
export const VIEW_CLIP_ATTRIBUTE = "data-view-clip";

interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const apart = (a: Box, b: Box): boolean => a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom;

/**
 * True while a write to this element could change something a person sees: see the four
 * reasons above. `legibleScale` is the share of its own size below which what the element
 * draws cannot be read (0, the default: it has no such size).
 */
export function isElementVisible(element: Element, legibleScale = 0): boolean {
  if (typeof element.checkVisibility !== "function") return true;
  if (!element.checkVisibility()) return false;
  const doc = element.ownerDocument;
  const covering = doc.fullscreenElement;
  if (covering !== null && covering !== undefined && !covering.contains(element)) return false;
  const box = element.getBoundingClientRect();
  if (box.width === 0 && box.height === 0) return true;
  const view = doc.defaultView;
  if (view !== null && apart(box, { left: 0, top: 0, right: view.innerWidth, bottom: view.innerHeight })) return false;
  const clip = element.closest(`[${VIEW_CLIP_ATTRIBUTE}]`);
  if (clip !== null && apart(box, clip.getBoundingClientRect())) return false;
  if (legibleScale > 0) {
    const laidOut = (element as Partial<HTMLElement>).offsetHeight;
    if (typeof laidOut === "number" && laidOut > 0 && box.height / laidOut < legibleScale) return false;
  }
  return true;
}

function ancestorsOf(element: Element): Element[] {
  const chain: Element[] = [];
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    chain.push(node);
  }
  return chain;
}

function sameChain(a: readonly Element[], b: readonly Element[]): boolean {
  return a.length === b.length && a.every((node, index) => node === b[index]);
}

export function useVisibleSubscribe(
  ref: RefObject<Element | null>,
  subscribe: Subscribe,
  legibleScale = 0,
): Subscribe {
  return useMemo(
    () => {
      const listeners = new Set<() => void>();
      let element: Element | null = null;
      let visible = true;
      let chain: Element[] = [];
      let observer: MutationObserver | null = null;
      let observedDocument: Document | null = null;
      let unsubscribe: (() => void) | null = null;

      const notify = (): void => {
        for (const listener of [...listeners]) {
          if (listeners.has(listener)) listener();
        }
      };

      /** Re-reads visibility; true when it just flipped to visible. */
      const check = (): boolean => {
        const now = element === null || isElementVisible(element, legibleScale);
        const shown = now && !visible;
        visible = now;
        return shown;
      };

      /** What the browser says changed that no attribute of an ancestor shows: fullscreen left, the window resized. */
      const moved = (): void => {
        if (listeners.size === 0) return;
        if (check()) notify();
      };
      const listen = (doc: Document | null, on: boolean): void => {
        if (doc === null) return;
        if (on) {
          doc.addEventListener("fullscreenchange", moved);
          doc.defaultView?.addEventListener("resize", moved);
        } else {
          doc.removeEventListener("fullscreenchange", moved);
          doc.defaultView?.removeEventListener("resize", moved);
        }
      };

      const arm = (): void => {
        const nextElement = ref.current;
        const next = nextElement === null ? [] : ancestorsOf(nextElement);
        const nextDocument = nextElement?.ownerDocument ?? null;
        if (observer !== null && element === nextElement && observedDocument === nextDocument && sameChain(chain, next)) return;
        observer?.disconnect();
        if (observedDocument !== nextDocument) {
          listen(observedDocument, false);
          listen(nextDocument, true);
        }
        element = nextElement;
        observedDocument = nextDocument;
        chain = next;
        const Observer = nextDocument?.defaultView?.MutationObserver;
        if (Observer === undefined) {
          observer = null;
          return;
        }
        observer = new Observer(() => {
          if (listeners.size === 0) return;
          arm();
          if (check()) notify();
        });
        for (const node of chain) observer.observe(node, { attributes: true });
      };

      return (listener: () => void): (() => void) => {
        const entry = (): void => listener();
        listeners.add(entry);
        if (listeners.size === 1) {
          arm();
          check();
          unsubscribe = subscribe(() => {
            if (listeners.size === 0) return;
            arm();
            check();
            if (visible) notify();
          });
        }
        return () => {
          listeners.delete(entry);
          if (listeners.size !== 0) return;
          observer?.disconnect();
          observer = null;
          listen(observedDocument, false);
          unsubscribe?.();
          unsubscribe = null;
          element = null;
          observedDocument = null;
          chain = [];
        };
      };
    },
    [ref, subscribe, legibleScale],
  );
}
