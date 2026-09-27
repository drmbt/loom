import type { PresentableCanvas, PresentationHandle, PresentationOptions } from "@runtime/backend/backend-types.ts";

/**
 * One perform window: a chromeless browser window showing a Window Out's target (§T1391b).
 *
 * No React. The window is opened by a COMMAND from a user gesture (a click, a key), and a
 * popup may only be opened synchronously inside that gesture — so this is a plain function
 * the command calls, not an effect that runs a frame later with the activation spent.
 *
 * ## What is in the window
 *
 * One canvas, created IN the child document (a configured canvas moved across documents
 * stops painting, T705), filling the window with the bitmap scaled to fit. The backend
 * sizes that bitmap to the Window Out's target (`sizing: "source"`), so on a matching
 * screen the picture is 1:1. Nothing else: no toolbar, no selector — the viewer's chrome is
 * exactly what a perform surface must not carry.
 *
 * ## Fullscreen
 *
 * Asked for in the `window.open` features (Chrome's fullscreen popup, granted with the
 * window-management permission). Where that is not granted the window opens placed and
 * sized on its screen, and a click inside it goes fullscreen — the Fullscreen API needs a
 * gesture IN that window. A double click toggles, as on the viewer (T813).
 *
 * ## Lifetime
 *
 * Closing the window (its close button, Escape out of a kiosk, the OS) disposes the
 * presentation and reports `onClosed`, so the node stops rendering. A reload of the editor
 * closes every perform window: an orphaned popup with no page behind it would freeze on its
 * last frame, looking live.
 */

export interface PerformWindowRequest {
  readonly nodeId: string;
  /** `performWindowName(nodeId)` — reopening focuses the same window. */
  readonly name: string;
  readonly title: string;
  /** `placementFeatures(...)`. */
  readonly features: string;
  /** The Window Out's `$target` resource, or undefined until the plan has one. */
  readonly outputId: string | undefined;
  readonly fullscreen: boolean;
  readonly hideCursor: boolean;
  readonly onClosed: (nodeId: string) => void;
}

export interface PerformWindowDeps {
  /** `window.open`. Injected so a test can hand in a jsdom window. */
  readonly open: (name: string, features: string) => Window | null;
  readonly present: (canvas: PresentableCanvas, options: PresentationOptions) => PresentationHandle;
  /** The editor's own window, for the reload-closes-children rule. */
  readonly parent: Window;
}

export interface PerformWindowHandle {
  readonly nodeId: string;
  readonly window: Window;
  /** Repoint at the node's target after a recompile (or its first appearance). */
  setOutput(outputId: string | undefined): void;
  setHideCursor(hidden: boolean): void;
  close(): void;
  readonly closed: boolean;
}

/** The real opener: `window.open` against `about:blank`, nothing else. */
export function browserPerformOpener(host: Window): PerformWindowDeps["open"] {
  return (name, features) => host.open("", name, features);
}

export function openPerformWindow(deps: PerformWindowDeps, request: PerformWindowRequest): PerformWindowHandle | null {
  const child = deps.open(request.name, request.features);
  if (child === null) return null;

  const doc = child.document;
  doc.title = request.title;
  // A window REUSED by name (the node's window was already open) starts clean.
  doc.body.replaceChildren();
  const body = doc.body.style;
  body.margin = "0";
  body.background = "black";
  body.overflow = "hidden";
  body.cursor = request.hideCursor ? "none" : "default";

  const canvas = doc.createElement("canvas");
  canvas.dataset["performWindow"] = request.nodeId;
  const style = canvas.style;
  style.display = "block";
  style.width = "100vw";
  style.height = "100vh";
  style.objectFit = "contain";
  doc.body.appendChild(canvas);

  let outputId = request.outputId;
  let presentation: PresentationHandle | undefined;
  const attach = (): void => {
    if (outputId === undefined || presentation !== undefined) return;
    presentation = deps.present(canvas, { outputId, label: `perform:${request.nodeId}`, sizing: "source" });
  };
  attach();

  const toggleFullscreen = (): void => {
    if (doc.fullscreenElement === null) void doc.documentElement.requestFullscreen?.().catch(() => undefined);
    else void doc.exitFullscreen?.().catch(() => undefined);
  };
  const onClick = (): void => {
    if (request.fullscreen && doc.fullscreenElement === null) toggleFullscreen();
  };
  doc.addEventListener("click", onClick);
  doc.addEventListener("dblclick", toggleFullscreen);

  let closed = false;
  const teardown = (): void => {
    if (closed) return;
    closed = true;
    presentation?.dispose();
    presentation = undefined;
    doc.removeEventListener("click", onClick);
    doc.removeEventListener("dblclick", toggleFullscreen);
    child.removeEventListener("pagehide", onChildGone);
    deps.parent.removeEventListener("pagehide", onParentGone);
    request.onClosed(request.nodeId);
  };
  const onChildGone = (): void => teardown();
  const onParentGone = (): void => child.close();
  child.addEventListener("pagehide", onChildGone);
  deps.parent.addEventListener("pagehide", onParentGone);

  return {
    nodeId: request.nodeId,
    window: child,
    setOutput(next) {
      if (closed || next === outputId) return;
      outputId = next;
      if (next === undefined) {
        presentation?.dispose();
        presentation = undefined;
      } else if (presentation === undefined) {
        attach();
      } else {
        presentation.setOutput(next);
      }
    },
    setHideCursor(hidden) {
      body.cursor = hidden ? "none" : "default";
    },
    close() {
      teardown();
      child.close();
    },
    get closed() {
      return closed;
    },
  };
}
