import { PHOTO_DEPTH_MODELS, PHOTO_MASK, PHOTO_FACADE } from "@runtime/models/model-catalogue.ts";
import { supportsPhotoDepthSize, supportsPhotoMaskSize } from "@domain/media/preparation-sizes.ts";
import { createModelAcquisition, progressText, type ModelDescriptor } from "@runtime/models/model-acquisition.ts";
import { cacheModelStore } from "@runtime/models/cache-model-store.ts";
import { createWorkerRunner, type WorkerRunTarget } from "@runtime/models/worker-runner.ts";
import type { WorkerLike } from "@runtime/models/inference-protocol.ts";
import { occOf } from "@runtime/models/depth-runner.ts";
import { makePreparedMap, withDepthRecipe, preparedMetadata, depthRecipeOf, rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import { refineFacadeMask, type FacadeMaskSettings } from "@runtime/media/facade-mask.ts";
import type { FloatMap } from "@runtime/media/float-map.ts";
import { encodePreparedMap, PREPARED_MAP_EXTENSION, PREPARED_MAP_MIME_TYPE } from "@runtime/media/prepared-map-file.ts";
import { photoDepthRecipeSchema, photoDepthInputSize, MARIGOLD_BUNDLE_ID, depthInferenceKey, depthRefinementSize, type PhotoDepthRecipe } from "@domain/media/photo-depth-recipe.ts";
import { refineBrowserPhotoDepth } from "@runtime/backend/photo-depth-refinement.ts";
import type { WorkerRunner } from "@runtime/models/worker-runner.ts";
import { photoDepthUnavailableReason } from "@runtime/models/photo-depth-models.ts";
import { hasNativePreparation, probeNativePreparation, runNativePreparation } from "@devices/native-preparation.ts";
import { encodeDepthImage, DEPTH_IMAGE_FORMATS, type DepthImageFormat } from "@runtime/media/depth-image.ts";
import { preparedMapFilename } from "@runtime/media/prepared-map-name.ts";
import { retainedFiles, type RetainedFileHandle } from "@ui/files/retained-files.ts";
import bundledFacadeUrl from "../runtime/models/assets/topformer-ade20k.onnx?url";

export interface PreparationPhoto {
  readonly bitmap: ImageBitmap;
  readonly sha256: string;
  readonly name: string;
}

export type PhotoPreparationRequest =
  | { readonly kind: "depth"; readonly photo: PreparationPhoto; readonly recipe: PhotoDepthRecipe }
  | { readonly kind: "mask"; readonly photo: PreparationPhoto; readonly inputSide: number; readonly facade?: FacadeMaskSettings };

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
  if (store === null && !hasNativePreparation()) throw new Error("Model caching is unavailable in this browser context.");
  const descriptors = new Map<string, ModelDescriptor>([...PHOTO_DEPTH_MODELS, PHOTO_MASK, PHOTO_FACADE].map(model => [model.id, model]));
  const acquisition = store === null ? null : createModelAcquisition({
    store,
    // TopFormer's upstream download rejects browser Fetch Metadata. This exact,
    // hash-verified asset is served with Loom, not selected after a failed request.
    fetch: (url, options) => fetch(options.descriptor.id === PHOTO_FACADE.id ? bundledFacadeUrl : url, { signal: options.signal }),
    onStateChange: (id, state) => {
      if (state.kind === "downloading") onProgress({ phase: "downloading",
        message: `${descriptors.get(id)!.label} · ${progressText(state.received, state.total)}`,
        ...(state.total !== undefined && state.total > 0 ? { fraction: Math.min(1, state.received / state.total) } : {}) });
      else if (state.kind === "failed") onProgress({ phase: "preparing", message: state.reason });
    },
  });
  const targets = new Map<string, WorkerRunTarget>();
  let runner: WorkerRunner | null = null;
  let active: AbortController | null = null;
  let disposed = false;
  const begin = () => {
    if (disposed) throw new Error("Photo preparation was closed.");
    if (active !== null) throw new Error("Photo preparation is already running.");
    active = new AbortController();
    return active;
  };
  const retire = () => {
    runner?.retainNodes([]);
    runner?.dispose();
    runner = null;
    targets.clear();
    active = null;
  };
  return {
    async run(request: PhotoPreparationRequest): Promise<FloatMap> {
      const abort = begin();
      try {
        const { kind, photo } = request;
        if (kind === "depth" && "facade" in request) throw new Error("Facade settings apply only to masks.");
        const recipe = kind === "depth" ? photoDepthRecipeSchema.parse(request.recipe) : null;
        if (recipe?.version === 2) {
          const capability = await probeNativePreparation();
          abort.signal.throwIfAborted();
          const reason = photoDepthUnavailableReason(recipe, globalThis.navigator?.gpu !== undefined, capability);
          if (reason !== null) throw new Error(reason);
          const { width, height } = photoDepthInputSize(recipe, photo.bitmap.width, photo.bitmap.height);
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (context === null) throw new Error("Native photo preparation requires a 2D canvas.");
          context.drawImage(photo.bitmap, 0, 0, width, height);
          const rgba = new Uint8Array(context.getImageData(0, 0, width, height).data).buffer;
          const result = await runNativePreparation({ modelId: recipe.modelId, inputSide: recipe.inputSide,
            seed: recipe.seed, width, height, rgba }, progress => onProgress({
              phase: progress.phase === "downloading" ? "downloading" : progress.phase === "loading" ? "preparing" : "processing",
              message: progress.message, ...(progress.fraction === undefined ? {} : { fraction: progress.fraction }),
            }), abort.signal);
          abort.signal.throwIfAborted();
          const map = makePreparedMap(new Float32Array(result.values), result.width, result.height, { kind: "depth",
            source: { sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height },
            model: { id: recipe.modelId, url: `loom:model-bundle/${MARIGOLD_BUNDLE_ID}` }, inputSide: recipe.inputSide, registration: "stretch" });
          onProgress({ phase: "finishing", message: "Marigold finished · native log-depth float32 preserved" });
          return withDepthRecipe(map, { ...recipe, refinement: null }, null, result.semantics);
        }
        if (acquisition === null) throw new Error("Browser model caching is unavailable in this context.");
        if (recipe !== null) {
          const reason = photoDepthUnavailableReason(recipe, globalThis.navigator?.gpu !== undefined);
          if (reason !== null) throw new Error(reason);
        }
        const facade = request.kind === "mask" ? request.facade : undefined;
        const descriptor = recipe !== null ? PHOTO_DEPTH_MODELS.find(model => model.id === recipe.modelId)
          : facade === undefined ? PHOTO_MASK : PHOTO_FACADE;
        if (descriptor === undefined) throw new Error(`The selected photo depth model is unavailable: ${recipe!.modelId}.`);
        const detailSide = recipe?.inputSide ?? (request as Extract<PhotoPreparationRequest, { kind: "mask" }>).inputSide;
        if (kind === "depth" ? !supportsPhotoDepthSize(detailSide) : !supportsPhotoMaskSize(detailSide)) {
          throw new Error(`Unsupported ${kind} input size.`);
        }
        const side = facade === undefined ? detailSide : 512;
        const nodeId = crypto.randomUUID();
        targets.set(nodeId, { modelId: descriptor.id, nodeType: kind === "depth" ? "depth" : "matte",
          width: side, height: side, side, sourceWidth: photo.bitmap.width, sourceHeight: photo.bitmap.height,
          providers: [recipe?.backend ?? "wasm"], ratio: 0, smoothing: 1 });
        const worker = new Worker(new URL("../runtime/models/inference.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
        runner = createWorkerRunner({ worker, describe: id => targets.get(id), weightsFor: async id => {
          onProgress({ phase: "preparing", message: "Opening the model cache…" });
          const weights = await acquisition.acquire(descriptors.get(id)!);
          abort.signal.throwIfAborted();
          if (weights !== undefined) onProgress({ phase: "processing", message: "Running the model on your photo…" });
          return weights;
        }, onMeasured: (_id, measurement) => onProgress({ phase: "finishing",
          message: `${measurement.backend} · ${Math.round(measurement.millis)} ms · preparing float32 output` }) });
        onProgress({ phase: "preparing", message: `Preparing ${kind} input…` });
        const texels = photoTexels(photo, side, kind === "depth");
        onProgress({ phase: "processing", message: `Processing ${kind} · ${side} × ${side}` });
        const { raw } = await runner.runRaw(nodeId, texels.buffer as ArrayBuffer);
        abort.signal.throwIfAborted();
        const map = makePreparedMap(raw.values, raw.width, raw.height, { kind,
          source: { sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height },
          model: { id: descriptor.id, url: descriptor.url }, inputSide: side,
          registration: kind === "depth" ? "letterbox" : "stretch" });
        if (recipe !== null) return withDepthRecipe(map, { ...recipe, refinement: null });
        if (facade === undefined) return map;
        onProgress({ phase: "finishing", message: "Refining walls, openings and reflective glass…" });
        return refineFacadeMask(map, { width: detailSide, height: detailSide,
          texels: photoTexels(photo, detailSide, false) }, facade);
      } catch (error) {
        if (error instanceof AggregateError) throw error;
        abort.signal.throwIfAborted();
        throw error;
      } finally { retire(); }
    },
    async refine(photo: PreparationPhoto, native: FloatMap, recipe: PhotoDepthRecipe, maxLongEdge: number, savedNativeSha256?: string): Promise<FloatMap> {
      const abort = begin();
      try {
        const metadata = preparedMetadata(native);
        if (metadata.kind !== "depth" || (metadata.version === 2 && metadata.stage !== "native")) throw new Error("Refinement requires the saved native depth prediction.");
        if (metadata.source.sha256 !== photo.sha256 || metadata.source.width !== photo.bitmap.width || metadata.source.height !== photo.bitmap.height) throw new Error("Native depth belongs to a different photo.");
        if (depthInferenceKey(depthRecipeOf(native)) !== depthInferenceKey(recipe)) throw new Error("Native depth differs from the selected model, size or backend. Run depth again.");
        const target = depthRefinementSize(recipe, photo.bitmap.width, photo.bitmap.height, maxLongEdge);
        const scale = Math.min(1, Math.max(native.width, native.height) / Math.max(photo.bitmap.width, photo.bitmap.height));
        const input = { width: Math.max(1, Math.round(photo.bitmap.width * scale)), height: Math.max(1, Math.round(photo.bitmap.height * scale)) };
        const values = rasterizeFloatMap(native, "depth", input.width, input.height);
        const canvas = document.createElement("canvas");
        canvas.width = target.width; canvas.height = target.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context === null) throw new Error("Photo refinement requires a 2D canvas.");
        context.drawImage(photo.bitmap, 0, 0, target.width, target.height);
        const rgba = new Uint8Array(context.getImageData(0, 0, target.width, target.height).data.buffer);
        if (savedNativeSha256 !== undefined && !/^[a-f0-9]{64}$/.test(savedNativeSha256)) throw new Error("Saved native depth identity must be a lowercase SHA-256 digest.");
        const nativeSha256 = savedNativeSha256 ?? [...new Uint8Array(await crypto.subtle.digest("SHA-256", encodePreparedMap(native).buffer as ArrayBuffer))].map(value => value.toString(16).padStart(2, "0")).join("");
        abort.signal.throwIfAborted();
        const refined = await refineBrowserPhotoDepth({ ...input, values }, { ...target, rgba }, target, recipe.refinement!, {
          signal: abort.signal,
          onStage: (stage, total, width, height) => onProgress({ phase: "processing", message: `Guided depth refinement · pass ${stage} of ${total} · ${width} × ${height}` }),
        });
        abort.signal.throwIfAborted();
        const map = makePreparedMap(refined, target.width, target.height, { kind: "depth", source: metadata.source,
          model: metadata.model, inputSide: metadata.inputSide, registration: "stretch" });
        const registered = { ...map, metadata: { preparation: { ...preparedMetadata(map), range: { low: 0, high: 1 } } } };
        return withDepthRecipe(registered, recipe, { sha256: nativeSha256,
          width: native.width, height: native.height });
      } catch (error) { abort.signal.throwIfAborted(); throw error; }
      finally { retire(); }
    },
    cancel() {
      active?.abort(new DOMException("Photo preparation cancelled.", "AbortError"));
      runner?.dispose(); runner = null;
      for (const descriptor of descriptors.values()) acquisition?.cancel(descriptor.id);
    },
    dispose() {
      disposed = true;
      active?.abort(new Error("Photo preparation was closed."));
      runner?.dispose(); runner = null;
      for (const descriptor of descriptors.values()) acquisition?.cancel(descriptor.id);
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
  const bytes = encodePreparedMap(map);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  const handle = await picker.call(window, { suggestedName: preparedMapFilename(map, name, fingerprint),
    types: [{ description: "Loom OpenEXR float32 map", accept: { [PREPARED_MAP_MIME_TYPE]: [".exr"] } }] });
  onProgress?.({ phase: "saving", message: "Writing the float32 map…" });
  const writable = await handle.createWritable();
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { await writable.abort(); throw error; }
  return retainedFiles().remember(handle, "binary");
}

/** Interchange exports are separate from the reusable float32 preparation artifact. */
export async function exportDepthImage(map: FloatMap, name: string, format: DepthImageFormat): Promise<void> {
  if (preparedMetadata(map).kind !== "depth") throw new Error("Depth image export requires a prepared depth map.");
  const descriptor = DEPTH_IMAGE_FORMATS.find(item => item.id === format);
  if (descriptor === undefined) throw new Error("Unsupported depth image format.");
  const bytes = encodeDepthImage(map, format);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  const filename = preparedMapFilename(map, name, fingerprint).slice(0, -PREPARED_MAP_EXTENSION.length) + `-${format}${descriptor.extension}`;
  const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<WritableHandle> }).showSaveFilePicker;
  if (picker === undefined) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: descriptor.mime }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const handle = await picker.call(window, { suggestedName: filename,
    types: [{ description: descriptor.label, accept: { [descriptor.mime]: [descriptor.extension] } }] });
  const writable = await handle.createWritable();
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { await writable.abort(); throw error; }
}
