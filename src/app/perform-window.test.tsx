import { afterEach, describe, expect, it } from "vitest";
import type { PresentableCanvas, PresentationOptions } from "@runtime/backend/backend-types.ts";
import { openPerformWindow } from "./perform-window.ts";

/**
 * §T1391b — one perform window, against a real (jsdom) child document: an iframe's window
 * stands in for the popup. Asserted on what the backend is handed and on the window's
 * lifetime, which is what decides whether the node keeps rendering.
 */

interface Presented {
  readonly canvas: PresentableCanvas;
  readonly options: PresentationOptions;
  outputs: string[];
  disposed: boolean;
}

function setup(outputId: string | undefined, options: {
  readonly hideCursor?: boolean;
  readonly fullscreen?: boolean;
  readonly requestFullscreen?: (doc: Document, options: FullscreenOptions | undefined) => Promise<void>;
} = {}) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const child = frame.contentWindow as Window;
  Object.defineProperty(child.document, "fullscreenElement", { value: null, writable: true, configurable: true });
  if (options.requestFullscreen !== undefined) {
    child.document.documentElement.requestFullscreen = (params) => options.requestFullscreen!(child.document, params);
  }
  const presented: Presented[] = [];
  const closed: string[] = [];
  const fullscreenChanges: string[] = [];
  let requested: { name: string; features: string } | undefined;
  const handle = openPerformWindow(
    {
      open: (name, features) => {
        requested = { name, features };
        return child;
      },
      present: (canvas, presentOptions) => {
        const entry: Presented = { canvas, options: presentOptions, outputs: [presentOptions.outputId], disposed: false };
        presented.push(entry);
        return {
          id: `p${String(presented.length)}`,
          get outputId() {
            return entry.outputs.at(-1) ?? "";
          },
          setOutput: (next) => entry.outputs.push(next),
          dispose: () => {
            entry.disposed = true;
          },
        };
      },
      parent: window,
    },
    {
      nodeId: "win1",
      name: "loom-perform-77696e31",
      title: "Loom — win1",
      features: "popup=yes,width=960,height=540",
      outputId,
      fullscreen: options.fullscreen ?? true,
      hideCursor: options.hideCursor ?? true,
      onClosed: (id) => closed.push(id),
      onFullscreenChanged: (id) => fullscreenChanges.push(id),
      onMappingKey: () => false,
    },
  );
  return { frame, child, handle, presented, closed, fullscreenChanges, requested: () => requested };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("a perform window", () => {
  it("presents a canvas that lives IN the child document, sized to the target", () => {
    const { child, handle, presented, requested } = setup("target:win1:$target");
    expect(handle).not.toBeNull();
    expect(requested()).toEqual({ name: "loom-perform-77696e31", features: "popup=yes,width=960,height=540" });
    expect(presented).toHaveLength(1);
    const canvas = presented[0]!.canvas as unknown as HTMLCanvasElement;
    expect(canvas.ownerDocument).toBe(child.document);
    expect(child.document.body.querySelectorAll("canvas")).toHaveLength(1);
    expect(handle!.fullscreenMessage).toBe("Fullscreen is unavailable in this browser.");
    expect(child.document.body.querySelector<HTMLButtonElement>("[data-perform-fullscreen-notice]")?.disabled).toBe(true);
    expect(presented[0]!.options).toEqual({ outputId: "target:win1:$target", label: "perform:win1", sizing: "source" });
    expect(child.document.body.style.cursor).toBe("none");
  });

  it("waits for the target a recompile brings, then follows it", () => {
    const { handle, presented } = setup(undefined);
    expect(presented).toHaveLength(0);
    handle!.setOutput("target:win1:$target");
    expect(presented.map((entry) => entry.options.outputId)).toEqual(["target:win1:$target"]);
    handle!.setOutput("target:win1:$target#2");
    expect(presented[0]!.outputs).toEqual(["target:win1:$target", "target:win1:$target#2"]);
  });

  it("closing it disposes the presentation and reports the node, once", () => {
    const { handle, presented, closed } = setup("t");
    handle!.close();
    handle!.close();
    expect(presented[0]!.disposed).toBe(true);
    expect(closed).toEqual(["win1"]);
    expect(handle!.closed).toBe(true);
  });

  it("the window going away on its own (pagehide) does the same", () => {
    const { child, presented, closed } = setup("t");
    child.dispatchEvent(new Event("pagehide"));
    expect(presented[0]!.disposed).toBe(true);
    expect(closed).toEqual(["win1"]);
  });

  it("shows the pointer when Hide cursor is off, and follows the parameter live", () => {
    const { child, handle } = setup("t", { hideCursor: false });
    expect(child.document.body.style.cursor).toBe("default");
    handle!.setHideCursor(true);
    expect(child.document.body.style.cursor).toBe("none");
  });

  it("requests HTML fullscreen on open rather than relying on popup features", async () => {
    const requests: Array<{ doc: Document; options: FullscreenOptions | undefined }> = [];
    const { child, handle } = setup("t", { requestFullscreen: (doc, options) => {
      requests.push({ doc, options });
      Object.defineProperty(doc, "fullscreenElement", { value: doc.documentElement, configurable: true });
      return Promise.resolve();
    } });
    expect(requests).toEqual([{ doc: child.document, options: { navigationUI: "hide" } }]);
    await Promise.resolve();
    expect(handle!.fullscreenMessage).toBeNull();
    expect(child.document.querySelector("[data-perform-fullscreen-notice]")).toBeNull();
  });

  it("does not request fullscreen when that setting is off", () => {
    let requests = 0;
    const { handle } = setup("t", { fullscreen: false, requestFullscreen: () => {
      requests += 1;
      return Promise.resolve();
    } });
    expect(requests).toBe(0);
    expect(handle!.fullscreenMessage).toBeNull();
  });

  it("reports a refused automatic request and retries from a child click", async () => {
    let requests = 0;
    const { child, handle, fullscreenChanges } = setup("t", { requestFullscreen: (doc) => {
      requests += 1;
      if (requests === 1) return Promise.reject(new TypeError("Permissions check failed"));
      Object.defineProperty(doc, "fullscreenElement", { value: doc.documentElement, configurable: true });
      return Promise.resolve();
    } });
    await Promise.resolve();
    expect(handle!.fullscreenMessage).toContain("Permissions check failed");
    expect(fullscreenChanges).toContain("win1");
    const notice = child.document.querySelector<HTMLButtonElement>("[data-perform-fullscreen-notice]");
    expect(notice?.getAttribute("aria-label")).toBe("Enter fullscreen");
    notice!.click();
    await Promise.resolve();
    expect(requests).toBe(2);
    expect(handle!.fullscreenMessage).toBeNull();
    expect(child.document.querySelector("[data-perform-fullscreen-notice]")).toBeNull();
  });

  it("does not report a late fullscreen failure after the window closes", async () => {
    let reject: (reason: Error) => void = () => { throw new Error("no pending request"); };
    const { child, handle, fullscreenChanges } = setup("t", { requestFullscreen: () => new Promise((_resolve, onRejected) => { reject = onRejected; }) });
    const doc = child.document;
    handle!.close();
    reject(new Error("closed"));
    await Promise.resolve();
    expect(fullscreenChanges).toEqual([]);
    expect(doc.querySelector("[data-perform-fullscreen-notice]")).toBeNull();
  });

  it("ignores an old refusal after a later child request succeeds", async () => {
    let requests = 0;
    let rejectInitial: (reason: Error) => void = () => { throw new Error("no initial request"); };
    const { child, handle } = setup("t", { requestFullscreen: (doc) => {
      requests += 1;
      if (requests === 1) return new Promise((_resolve, reject) => { rejectInitial = reject; });
      Object.defineProperty(doc, "fullscreenElement", { value: doc.documentElement, configurable: true });
      return Promise.resolve();
    } });
    child.document.body.click();
    await Promise.resolve();
    expect(requests).toBe(2);
    rejectInitial(new Error("old permission refusal"));
    await Promise.resolve();
    expect(handle!.fullscreenMessage).toBeNull();
    expect(child.document.querySelector("[data-perform-fullscreen-notice]")).toBeNull();
  });

  it("§T1536b: a double click on the mapping layer is a mapping gesture, never a fullscreen toggle", () => {
    const { child } = setup("t");
    const doc = child.document;
    const realm = child as Window & typeof globalThis;
    // Windowed (jsdom implements no Fullscreen API): a toggle would REQUEST fullscreen.
    Object.defineProperty(doc, "fullscreenElement", { value: null, configurable: true });
    let requests = 0;
    doc.documentElement.requestFullscreen = () => {
      requests += 1;
      return Promise.resolve();
    };
    const layer = doc.createElement("div");
    layer.dataset["performMapping"] = "on";
    const handle = doc.createElement("button");
    layer.appendChild(handle);
    doc.body.appendChild(layer);
    handle.dispatchEvent(new realm.MouseEvent("dblclick", { bubbles: true }));
    handle.dispatchEvent(new realm.MouseEvent("click", { bubbles: true }));
    expect(requests).toBe(0);
    doc.body.dispatchEvent(new realm.MouseEvent("dblclick", { bubbles: true }));
    expect(requests).toBe(1);
  });

  it("returns null when the browser blocks the popup", () => {
    const handle = openPerformWindow(
      { open: () => null, present: () => { throw new Error("must not present"); }, parent: window },
      { nodeId: "w", name: "loom-perform-77", title: "", features: "", outputId: "t", fullscreen: false, hideCursor: false, onClosed: () => {}, onFullscreenChanged: () => {}, onMappingKey: () => false },
    );
    expect(handle).toBeNull();
  });
});
