// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { PreviewFrameCommand } from "@runtime/previews/index.ts";
import { useViewerSynthesis } from "./use-viewer-synthesis.ts";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/*
 * T1409b — with a perform window driving the show, the viewer's synthesized picture (a
 * camera/scene row, §B220) is drawn on THAT window's frames. The editor's rAF is stubbed to a
 * request nobody ever answers: a hidden editor tab.
 */
it("draws the synthesized row on the perform window's frames while the editor's are parked", () => {
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  const waiting: Array<(time: number) => void> = [];
  const performWindow = {
    requestAnimationFrame: (callback: (time: number) => void) => waiting.push(callback),
    cancelAnimationFrame: () => {},
  };
  const drawn: PreviewFrameCommand[] = [];
  const backend = {
    status: { deviceGeneration: 1 },
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: (command: PreviewFrameCommand) => drawn.push(command),
      dispose: () => {},
    }),
    frames: performWindow,
  } as unknown as LoomBackend;
  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;
  const output = {
    nodeId: "cam", portId: "out", resourceId: "scenePreview:cam:out", resourceKind: "target",
    size: [960, 540], format: "rgba8unorm", space: "linear", temporal: false,
    synthesis: { kind: "camera", depth: true, passes: [{ id: "cam#scenePreview:out" }] },
  } as unknown as ResolvedOutput;

  renderHook(() => useViewerSynthesis({
    backend, canvasRef: { current: canvas }, output,
    previewFps: 20, previewLongEdge: 192, documentIdentity: "document-under-test",
  }));
  for (const callback of waiting.splice(0)) callback(0);

  expect(drawn.at(-1)?.composite.map((tile) => tile.ref)).toEqual([{ nodeId: "cam", portId: "out" }]);
});
