import type { LoomBackend } from "@runtime/backend/index.ts";
import type { PresentableCanvas } from "@runtime/backend/backend-types.ts";
import type { NativeVideoTransport } from "./native-video.ts";

/** Transferred native-output surface, existing backend; never a graph copy. */
export interface NativeOutputSelection {
  readonly resourceId: string;
  readonly size: readonly [number, number];
}
export interface DesktopOutputBridge {
  readonly nativeOutput: true;
  /** VN132: `alpha` opens a transparent output window, so the published frame keeps the sink's alpha. */
  open(name: string, width: number, height: number, publisherName: string, options?: NativeOutputOptions): Promise<void>;
  close(name: string): Promise<void>;
  resize(name: string, width: number, height: number): Promise<void>;
  status(name: string): Promise<{ copied: number; dropped: number; error: string | null }>;
}
export interface NativeOutputOptions {
  /** VN132: publish the sink's alpha, read as premultiplied. Off: an opaque frame, as before. */
  readonly alpha?: boolean;
}
export type NativeOutputTransport = NativeVideoTransport;
export function desktopOutputBridge(transport: NativeOutputTransport = "syphon"): DesktopOutputBridge | undefined {
  const desktop = (window as Window & { loomDesktop?: unknown }).loomDesktop;
  const candidate = transport === "syphon" ? desktop : typeof desktop === "object" && desktop !== null
    ? (desktop as Record<string, unknown>)[transport === "ndi" ? "ndiOutput" : "spoutOutput"] : undefined;
  if (typeof candidate !== "object" || candidate === null || !("nativeOutput" in candidate) || candidate.nativeOutput !== true) return undefined;
  if (["open", "close", "resize", "status"].some(key => typeof (candidate as Record<string, unknown>)[key] !== "function"))
    throw new Error(`Invalid ${transport} native output bridge: an advertised output requires open, close, resize and status methods.`);
  return candidate as DesktopOutputBridge;
}
export function attachNativeOutput(backend: LoomBackend, selection: NativeOutputSelection, canvas: PresentableCanvas,
  options: NativeOutputOptions = {}) {
  canvas.width = selection.size[0]; canvas.height = selection.size[1];
  let disposed = false;
  const presentation = backend.present(canvas, { outputId: selection.resourceId, label: "native-sdr-output",
    ...(options.alpha ? { surfaceAlpha: "premultiplied" as const } : {}) });
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    presentation.dispose();
  };
  return {
    presentedFrames() {
      if (!presentation.describe) throw new Error("Native output requires presentation progress diagnostics");
      return presentation.describe().presentedFrames;
    },
    update(next: NativeOutputSelection) {
      if (disposed) throw new Error("Native output is closed");
      if (canvas.width !== next.size[0]) canvas.width = next.size[0];
      if (canvas.height !== next.size[1]) canvas.height = next.size[1];
      presentation.setOutput(next.resourceId);
    },
    dispose,
  };
}
