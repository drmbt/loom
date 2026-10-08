import { DEPTH_ACCURATE, PHOTO_MASK } from "@runtime/models/model-catalogue.ts";
import { supportsPhotoDepthSize, supportsPhotoMaskSize } from "@domain/media/preparation-sizes.ts";
import { createModelAcquisition, progressText, type ModelDescriptor } from "@runtime/models/model-acquisition.ts";
import { cacheModelStore } from "@runtime/models/cache-model-store.ts";
import { createWorkerRunner, type WorkerRunTarget } from "@runtime/models/worker-runner.ts";
import type { WorkerLike } from "@runtime/models/inference-protocol.ts";
import { occOf } from "@runtime/models/depth-runner.ts";
import { makePreparedMap } from "@runtime/media/prepared-map.ts";
import { encodeFloatMap, FLOAT_MAP_EXTENSION, FLOAT_MAP_MIME_TYPE, type FloatMap } from "@runtime/media/float-map.ts";
import { retainedFiles, type RetainedFileHandle } from "@ui/files/retained-files.ts";

export interface PreparationPhoto {
  readonly bitmap: ImageBitmap;
  readonly sha256: string;
  readonly name: string;
}

export interface PreparationProgress {
  readonly phase: "preparing" | "downloading" | "processing" | "finishing" | "saving";
  readonly message: string;
  /** Only byte transfers have measurable completion; inference stays indeterminate. */
  readonly fraction?: number;
}

export async function decodePreparationPhoto(url: string, name: string, signal: AbortSignal): Promise<PreparationPhoto> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The photo could not be opened (${response.status}).`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  if (signal.aborted) { bitmap.close(); throw signal.reason; }
  return { bitmap, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""), name };
}

/** Only colour photographs use canvas decoding. Inferred depth never passes through it. */
function photoTexels(photo: PreparationPhoto, side: number, letterbox: boolean): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = side;
  canvas.height = side;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("Photo preparation requires a 2D canvas.");
  context.drawImage(photo.bitmap, 0, 0, side, side);
  const rgba = context.getImageData(0, 0, side, side).data;
  const [occX, occY] = letterbox ? occOf(photo.bitmap.width, photo.bitmap.height) : [1, 1];
  const texels = new Float32Array(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const sx = Math.max(0, Math.min(side - 1, Math.floor((((x + 0.5) / side - 0.5) / occX + 0.5) * side)));
      const sy = Math.max(0, Math.min(side - 1, Math.floor((((y + 0.5) / side - 0.5) / occY + 0.5) * side)));
      const source = 4 * (sy * side + sx);
      const target = 4 * (y * side + x);
      for (let channel = 0; channel < 4; channel++) texels[target + channel] = rgba[source + channel]! / 255;
    }
  }
  return texels;
}

/** One explicit preparation session, reusing the model cache, protocol and worker core. */
export function createPhotoPreparer(onProgress: (progress: PreparationProgress) => void) {
  const store = cacheModelStore();
  if (store === null) throw new Error("Model caching is unavailable in this browser context.");
  const descriptors = new Map<string, ModelDescriptor>([DEPTH_ACCURATE, PHOTO_MASK].map(model => [model.id, model]));
  const acquisition = createModelAcquisition({
    store,
    fetch: (url, options) => fetch(url, { signal: options.signal }),
    onStateChange: (id, state) => {
      if (state.kind === "downloading") onProgress({ phase: "downloading",
        message: `${descriptors.get(id)!.label} · ${progressText(state.received, state.total)}`,
        ...(state.total !== undefined && state.total > 0 ? { fraction: Math.min(1, state.received / state.total) } : {}) });
      else if (state.kind === "failed") onProgress({ phase: "preparing", message: state.reason });
    },
  });
  const targets = new Map<string, WorkerRunTarget>();
  const worker = new Worker(new URL("../runtime/models/inference.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
  const runner = createWorkerRunner({ worker, describe: id => targets.get(id), weightsFor: async id => {
    onProgress({ phase: "preparing", message: "Opening the model cache…" });
    const weights = await acquisition.acquire(descriptors.get(id)!);
    if (weights !== undefined) onProgress({ phase: "processing", message: "Running the model on your photo…" });
    return weights;
  }, onMeasured: (_id, measurement) => onProgress({ phase: "finishing",
    message: `${measurement.backend} · ${Math.round(measurement.millis)} ms · preparing float32 output` }) });
  let disposed = false;
  return {
    async run(kind: "depth" | "mask", photo: PreparationPhoto, depthSide: number, maskSide = 1024): Promise<FloatMap> {
      if (disposed) throw new Error("Photo preparation was closed.");
      const descriptor = kind === "depth" ? DEPTH_ACCURATE : PHOTO_MASK;
      const side = kind === "depth" ? depthSide : maskSide;
      if (kind === "depth" ? !supportsPhotoDepthSize(side) : !supportsPhotoMaskSize(side)) {
        throw new Error(`Unsupported ${kind} input size.`);
      }
      const nodeId = crypto.randomUUID();
      targets.set(nodeId, { modelId: descriptor.id, nodeType: kind === "depth" ? "depth" : "matte",
        width: side, height: side, side, sourceWidth: photo.bitmap.width, sourceHeight: photo.bitmap.height,
        providers: ["wasm"], ratio: 0, smoothing: 1 });
      try {
        onProgress({ phase: "preparing", message: `Preparing ${kind} input…` });
        const texels = photoTexels(photo, side, kind === "depth");
        onProgress({ phase: "processing", message: `Processing ${kind} · ${side} × ${side}` });
        const { raw } = await runner.runRaw(nodeId, texels.buffer as ArrayBuffer);
        if (disposed) throw new Error("Photo preparation was closed.");
        return makePreparedMap(raw.values, raw.width, raw.height, { kind,
          source: { sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height },
          model: { id: descriptor.id, url: descriptor.url }, inputSide: side,
          registration: kind === "depth" ? "letterbox" : "stretch" });
      } finally {
        targets.delete(nodeId);
        runner.retainNodes([...targets.keys()]);
      }
    },
    dispose() {
      disposed = true;
      runner.dispose();
      for (const descriptor of descriptors.values()) acquisition.cancel(descriptor.id);
    },
  };
}

interface WritableHandle extends RetainedFileHandle {
  createWritable(): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}

/** Save real external bytes and retain their handle; session object URLs are never persisted. */
export async function savePreparedMap(map: FloatMap, name: string, onProgress?: (progress: PreparationProgress) => void): Promise<string> {
  const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<WritableHandle> }).showSaveFilePicker;
  if (picker === undefined) throw new Error("Saving reusable maps requires File System Access in this browser.");
  const handle = await picker.call(window, { suggestedName: `${name}${FLOAT_MAP_EXTENSION}`,
    types: [{ description: "Loom float32 map", accept: { [FLOAT_MAP_MIME_TYPE]: [FLOAT_MAP_EXTENSION] } }] });
  onProgress?.({ phase: "saving", message: "Writing the float32 map…" });
  const bytes = encodeFloatMap(map);
  const writable = await handle.createWritable();
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { await writable.abort(); throw error; }
  return retainedFiles().remember(handle, "binary");
}
