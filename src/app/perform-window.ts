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
 * Requested through the child's Fullscreen API on open. The popup feature is retained
 * for the desktop host; the old Chrome fullscreen-popup experiment does not provide this
 * in an ordinary browser. Chrome permits the automatic request only with automatic
 * fullscreen permission: window-management alone is insufficient, and opening a popup
 * consumes the opener's activation. A refusal is shown here and in the inspector; a click
 * in the child requests fullscreen with its own gesture. A double click toggles (T813).
 *
 * ## Edit mapping (§T1536b)
 *
 * `M` toggles the window's "edit mapping" mode and Escape leaves it — keys of THIS window,
 * like the double click, answered by `onMappingKey` and consumed only when it acts (so
 * Escape outside the mode still reaches the keymap). The handles themselves are a DOM layer
 * over the canvas (`perform-mapping-overlay.ts`, `[data-perform-mapping]`); a click or a
 * double click on that layer is a mapping gesture, never a fullscreen toggle.
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
  /** Fullscreen changed or a request was refused; refresh the owning inspector's status. */
  readonly onFullscreenChanged: (nodeId: string) => void;
  /** §T1536b: `M` (toggle) or Escape (leave) in the window; true when it acted. */
  readonly onMappingKey: (nodeId: string, key: "toggle" | "leave") => boolean;
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
  /** A browser refusal, until a successful request or fullscreen change clears it. */
  readonly fullscreenMessage: string | null;
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

  let closed = false;
  let fullscreenMessage: string | null = null;
  let fullscreenRequest = 0;
  let fullscreenNotice: HTMLButtonElement | undefined;
  const reportFullscreen = (message: string | null): void => {
    if (closed || message === fullscreenMessage) return;
    fullscreenMessage = message;
    if (message === null) {
      fullscreenNotice?.remove();
      fullscreenNotice = undefined;
    } else {
      if (fullscreenNotice === undefined) {
        const theme = deps.parent.getComputedStyle(deps.parent.document.documentElement);
        for (const name of ["--bg-panel", "--text", "--line", "--font-ui", "--fs-ui"]) {
          doc.documentElement.style.setProperty(name, theme.getPropertyValue(name));
        }
        fullscreenNotice = doc.createElement("button");
        fullscreenNotice.type = "button";
        fullscreenNotice.dataset["performFullscreenNotice"] = request.nodeId;
        Object.assign(fullscreenNotice.style, {
          position: "fixed", bottom: "24px", left: "50%", transform: "translateX(-50%)",
          maxWidth: "calc(100vw - 32px)", padding: "12px 16px", background: "var(--bg-panel)",
          color: "var(--text)", border: "1px solid var(--line)", borderRadius: "4px", cursor: "pointer",
          font: "var(--fs-ui) var(--font-ui)", zIndex: "1",
        });
        fullscreenNotice.addEventListener("click", (event) => {
          event.stopPropagation();
          toggleFullscreen();
        });
        doc.body.appendChild(fullscreenNotice);
      }
      const supported = typeof doc.documentElement.requestFullscreen === "function";
      const action = doc.fullscreenElement ? "Exit fullscreen" : "Enter fullscreen";
      fullscreenNotice.disabled = !supported;
      fullscreenNotice.setAttribute("aria-label", supported ? action : "Fullscreen unavailable");
      fullscreenNotice.textContent = supported ? `${message} ${action}.` : message;
    }
    request.onFullscreenChanged(request.nodeId);
  };
  const fullscreenFailure = (error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error);
    reportFullscreen(`Fullscreen was refused by the browser: ${reason}`);
  };
  const followFullscreenRequest = (start: () => Promise<void>): void => {
    const current = ++fullscreenRequest;
    void start().then(
      () => { if (current === fullscreenRequest) reportFullscreen(null); },
      (error: unknown) => { if (current === fullscreenRequest) fullscreenFailure(error); },
    );
  };
  const enterFullscreen = (): void => {
    if (doc.fullscreenElement) return;
    if (typeof doc.documentElement.requestFullscreen !== "function") {
      reportFullscreen("Fullscreen is unavailable in this browser.");
      return;
    }
    followFullscreenRequest(() => doc.documentElement.requestFullscreen({ navigationUI: "hide" }));
  };
  const toggleFullscreen = (): void => {
    if (!doc.fullscreenElement) enterFullscreen();
    else if (typeof doc.exitFullscreen !== "function") reportFullscreen("Exiting fullscreen is unavailable in this browser.");
    else followFullscreenRequest(() => doc.exitFullscreen());
  };
  const onFullscreenChange = (): void => {
    // A completed browser transition owns the status, even if an older request settles later.
    fullscreenRequest += 1;
    reportFullscreen(null);
    if (!closed) request.onFullscreenChanged(request.nodeId);
  };
  /** §T1536b: a press on the mapping layer is a mapping gesture. */
  const onMappingLayer = (event: Event): boolean =>
    // Duck-typed: an element of the child document is no `instanceof` the editor's classes.
    typeof (event.target as Element | null)?.closest === "function" && (event.target as Element).closest("[data-perform-mapping]") !== null;
  const onClick = (event: MouseEvent): void => {
    if (onMappingLayer(event)) return;
    if (request.fullscreen && !doc.fullscreenElement) enterFullscreen();
  };
  const onDoubleClick = (event: MouseEvent): void => {
    if (!onMappingLayer(event)) toggleFullscreen();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
    const key = event.key === "Escape" ? "leave" : event.key === "m" || event.key === "M" ? "toggle" : null;
    if (key !== null && request.onMappingKey(request.nodeId, key)) {
      // Consumed: the keymap listening on this window skips a handled key.
      event.preventDefault();
    }
  };
  doc.addEventListener("click", onClick);
  doc.addEventListener("dblclick", onDoubleClick);
  doc.addEventListener("keydown", onKeyDown);
  doc.addEventListener("fullscreenchange", onFullscreenChange);

  const teardown = (): void => {
    if (closed) return;
    closed = true;
    presentation?.dispose();
    presentation = undefined;
    doc.removeEventListener("click", onClick);
    doc.removeEventListener("dblclick", onDoubleClick);
    doc.removeEventListener("keydown", onKeyDown);
    doc.removeEventListener("fullscreenchange", onFullscreenChange);
    fullscreenNotice?.remove();
    child.removeEventListener("pagehide", onChildGone);
    deps.parent.removeEventListener("pagehide", onParentGone);
    request.onClosed(request.nodeId);
  };
  const onChildGone = (): void => teardown();
  const onParentGone = (): void => child.close();
  child.addEventListener("pagehide", onChildGone);
  deps.parent.addEventListener("pagehide", onParentGone);
  if (request.fullscreen) enterFullscreen();

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
      // T1530b: called every frame while open — write only when the answer changed.
      const cursor = hidden ? "none" : "default";
      if (body.cursor !== cursor) body.cursor = cursor;
    },
    get fullscreenMessage() {
      return fullscreenMessage;
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
