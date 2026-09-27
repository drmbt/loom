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

function setup(outputId: string | undefined, options: { readonly hideCursor?: boolean } = {}) {
  const frame = document.createElement("iframe");
  document.body.appendChild(frame);
  const child = frame.contentWindow as Window;
  const presented: Presented[] = [];
  const closed: string[] = [];
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
      fullscreen: true,
      hideCursor: options.hideCursor ?? true,
      onClosed: (id) => closed.push(id),
    },
  );
  return { frame, child, handle, presented, closed, requested: () => requested };
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
    expect(child.document.body.children).toHaveLength(1);
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

  it("returns null when the browser blocks the popup", () => {
    const handle = openPerformWindow(
      { open: () => null, present: () => { throw new Error("must not present"); }, parent: window },
      { nodeId: "w", name: "loom-perform-77", title: "", features: "", outputId: "t", fullscreen: false, hideCursor: false, onClosed: () => {} },
    );
    expect(handle).toBeNull();
  });
});
