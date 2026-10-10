import type { LoomBackend } from "@runtime/backend/index.ts";
import type { MediaSource } from "@runtime/backend/backend-types.ts";
import { nativeOutputSender } from "./native-output-channel.ts";
import { nativeMediaFrame } from "./native-input.ts";

/**
 * VN85: the page half of the native FFGL host. The shape is native-inference.ts's (person
 * mask's native path): the node's input copy is presented to an OffscreenCanvas, handed as an
 * ImageBitmap to the desktop's hidden capture window, processed by the plugin in Electron's
 * main process (src/desktop/native-ffgl.cjs), and returned as a VideoFrame, bottom row first.
 * Time, BPM and parameter writes for a frame go first, through `prepare`; nothing here reads a
 * clock (§V44).
 */
export interface FfglPluginDescription {
  readonly id: string;
  readonly name: string;
  readonly pluginType: number;
  readonly version: string;
  readonly clock: { readonly mode: "host" | "wallclock" | "none" };
  readonly parameters: readonly unknown[];
}
export interface FfglFrameRequest {
  readonly time: number;
  readonly bpm: number;
  readonly barPhase: number;
  /** The frame interval in seconds: the plugin clock's step across a seek. */
  readonly interval: number;
  /** A render take restarting: the plugin clock starts again at `time`. */
  readonly reset?: boolean;
  readonly parameters: ReadonlyArray<readonly [number, number | boolean | string]>;
  readonly pulses: readonly number[];
}
export interface NativeFfglMetadata { session: string; sequence: number; width: number; height: number; bottomUp: boolean }
export interface DesktopFfglBridge {
  list(): Promise<{ plugins: ReadonlyArray<{ name: string; folderIndex: number; shadowed: number }>; excluded: ReadonlyArray<{ name: string; reason: string }> }>;
  describe(plugin: string): Promise<FfglPluginDescription>;
  open(name: string, plugin: string, width: number, height: number,
    consume: (frame: VideoFrame, metadata: NativeFfglMetadata) => Promise<void>): Promise<{ session: string; plugin: FfglPluginDescription }>;
  prepare(session: string, frame: FfglFrameRequest): Promise<void>;
  status(session: string): Promise<{ frames: number; busy: boolean; error: string | null }>;
  close(session: string): Promise<unknown>;
}
export function desktopFfglBridge(): DesktopFfglBridge | undefined {
  return (window as Window & { loomDesktop?: { ffgl?: DesktopFfglBridge } }).loomDesktop?.ffgl;
}

/** The FFGL manifest a node stores, from what the desktop's probe read out of the plugin. */
export function manifestFromDescription(description: FfglPluginDescription): string {
  const { id, name, version, pluginType, parameters } = description;
  return JSON.stringify({ format: 1, id, name, version, pluginType, parameters });
}

/** One plugin instance for one node: input presentation → native host → media source. */
export function createNativeFfglSource(backend: LoomBackend, bridge: DesktopFfglBridge, options: {
  plugin: string;
  /** The node's input copy; absent for a source plugin, which is given a transparent frame. */
  inputResourceId?: string;
  size: readonly [number, number];
}) {
  const name = `loom-ffgl-${crypto.randomUUID()}`;
  const [width, height] = options.size;
  const canvas = new OffscreenCanvas(width, height);
  const presentation = options.inputResourceId === undefined ? undefined
    : backend.present(canvas, { outputId: options.inputResourceId, sizing: "source", label: "ffgl-input" });
  // A source plugin generates: its input is a transparent frame of the node's size.
  const blank = presentation === undefined ? canvas.getContext("2d") : null;
  const sender = nativeOutputSender(name);
  let closed = false;
  let closing: Promise<void> | undefined;
  let image: VideoFrame | undefined;
  let sequence = 0;
  let request: { resolve(metadata: NativeFfglMetadata): void; reject(error: Error): void } | undefined;
  let running = false;
  let description: FfglPluginDescription | undefined;
  const discard = () => { image?.close(); image = undefined; };
  const opened = bridge.open(name, options.plugin, width, height, async (frame, metadata) => {
    if (closed) return;
    if (!request) throw new Error("Native FFGL delivered an unrequested result");
    if (metadata.session !== session || metadata.sequence <= sequence || metadata.width !== width || metadata.height !== height || metadata.bottomUp !== true)
      throw new Error("Native FFGL returned invalid result metadata");
    discard();
    image = frame.clone(); sequence = metadata.sequence;
    request.resolve(metadata); request = undefined;
  }).then(result => { description = result.plugin; return result.session; });
  let session: string | undefined;
  const ready: Promise<void> = Promise.all([opened, sender.promise]).then(([id]) => { session = id; });
  void ready.catch(() => undefined);
  let releaseScheduled = false;
  // The backend uploads a delivered frame once; the external texture keeps its pixels. The
  // VideoFrame is closed right after, because holding it holds the shared-texture import, and
  // main frees the plugin's output surface (and lets the next frame through) only when every
  // reference is released. Holding it was a deadlock on the second frame.
  const source: MediaSource = { currentFrame() {
    const frame = image;
    if (closed || !frame) return undefined;
    if (!releaseScheduled) {
      releaseScheduled = true;
      queueMicrotask(() => { releaseScheduled = false; if (image === frame) discard(); });
    }
    return nativeMediaFrame("ffgl", frame, sequence);
  } };
  return {
    source, ready,
    get description() { return description; },
    get available() { return !closed && !running && sender.available; },
    /** Processes the node's current input with this frame's time and writes. Resolves when the result is in. */
    async run(frame: FfglFrameRequest): Promise<NativeFfglMetadata> {
      if (closed || running) throw new Error("Native FFGL source is closed or busy");
      running = true;
      try {
        await ready; await sender.waitAvailable();
        if (closed || session === undefined) throw new Error("Native FFGL source closed before capture");
        if (presentation && !presentation.describe?.().presentedFrames) throw new Error("Native FFGL input has not been rendered");
        await bridge.prepare(session, frame);
        blank?.clearRect(0, 0, width, height);
        const bitmap = canvas.transferToImageBitmap();
        const result = new Promise<NativeFfglMetadata>((resolve, reject) => { request = { resolve, reject }; });
        try { sender.send(bitmap); } catch (error) { bitmap.close(); request = undefined; throw error; }
        // A capture or plugin error arrives through the same bounded channel, as Vision's does.
        void sender.waitAvailable().then(async () => {
          if (!request || session === undefined) return;
          const status = await bridge.status(session);
          throw new Error(status.error ?? "Native FFGL acknowledged a capture without delivering a result");
        }).catch(error => { request?.reject(error instanceof Error ? error : new Error(String(error))); request = undefined; });
        return await result;
      } finally { running = false; }
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true; discard(); presentation?.dispose(); sender.close();
      request?.reject(new Error("Native FFGL source closed")); request = undefined;
      closing = opened.then(id => bridge.close(id)).then(() => undefined, () => undefined);
      return closing;
    },
  };
}
