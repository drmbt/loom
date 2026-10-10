import { DEFAULT_IMAGE_FRAMING, type ImageFraming } from "@domain/media/image-framing.ts";
import { DEFAULT_PROJECT_FPS } from "@domain/types/graph.ts";
import { frameFromClock } from "@domain/types/frame.ts";
import { useEffect, useRef, useState } from "react";
import { rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import { remapDepthValues, type DepthRangeSettings } from "@runtime/media/depth-tools.ts";
import type { FloatMap } from "@runtime/media/float-map.ts";
import type { MediaSource, PresentationHandle } from "@runtime/backend/index.ts";
import type { PreparationPhoto } from "./photo-preparation.ts";
import type { PreviewImageFit } from "./photo-preview-framing.ts";
import { PHOTO_MAPPING_SHADER } from "./photo-mapping-effects.ts";
import { createPhotoEffectRenderer } from "./photo-effect-renderer.ts";

export interface PhotoMappingPreviewProps {
  readonly photo: PreparationPhoto | null;
  readonly previewPhoto: PreparationPhoto | null;
  /** Keep native sample buffers out of React's development prop-detail serialization. */
  readonly readMaps: () => { readonly depth: FloatMap | null; readonly mask: FloatMap | null };
  readonly matching: boolean;
  readonly previewFit?: PreviewImageFit;
  readonly previewFraming?: ImageFraming;
  readonly fullFrame?: boolean;
  readonly previewOpacity?: number;
  readonly mode?: number;
  readonly maxLongEdge?: number;
  readonly depthRange?: DepthRangeSettings;
  readonly testPattern?: boolean;
  readonly videoUrl?: string;
}

function whileActive<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

function guidance(photo: PreparationPhoto | null, mask: FloatMap | null, matching: boolean, fullFrame: boolean): string | null {
  if (photo === null) return "Choose a reference photo to see the live mapping preview.";
  if (mask === null && !fullFrame) return "Prepare or open a mask to preview the projection effect.";
  if (!matching) return "Use maps that match the reference photo for this preview.";
  return null;
}

/** An owned WebGPU rendering of the actual projection network; it runs no inference. */
export function PhotoMappingPreview({ photo, previewPhoto, readMaps, matching, previewFit = "stretch",
  previewFraming = DEFAULT_IMAGE_FRAMING, fullFrame = false, previewOpacity = 0.35,
  mode = 0, maxLongEdge = 960, depthRange, testPattern = false, videoUrl }: PhotoMappingPreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const { depth, mask } = readMaps();
  const message = guidance(photo, mask, matching, fullFrame);
  useEffect(() => {
    if (photo === null || guidance(photo, mask, matching, fullFrame) !== null) return;
    const target = canvas.current;
    if (target === null) throw new Error("The mapping preview canvas was not mounted.");
    setError(null); setReady(false);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = motion.matches, stopped = false;
    let pendingFrame: number | null = null;
    let renderer: Awaited<ReturnType<typeof createPhotoEffectRenderer>> | null = null;
    let presentation: PresentationHandle | null = null;
    const lifetime = new AbortController();
    let ownedVideo: HTMLVideoElement | null = null;
    let loadedListener: (() => void) | null = null;
    let frameIndex = 0, previousSeconds = 0;
    const stop = () => {
      stopped = true;
      lifetime.abort(new DOMException("Projection video preview retired.", "AbortError"));
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
      motion.removeEventListener("change", changeMotion);
      try { presentation?.dispose(); }
      finally {
        presentation = null;
        try { renderer?.dispose(); }
        finally {
          renderer = null;
          if (ownedVideo !== null) {
            ownedVideo.removeEventListener("error", videoError);
            if (loadedListener !== null) ownedVideo.removeEventListener("loadeddata", loadedListener);
            loadedListener = null;
            ownedVideo.pause(); ownedVideo.removeAttribute("src"); ownedVideo.load(); ownedVideo = null;
          }
        }
      }
    };
    const fail = (failure: unknown) => {
      if (stopped) return;
      setError(failure instanceof Error ? failure.message : String(failure));
      setReady(false); stop();
    };
    function videoError() {
      const error = ownedVideo?.error;
      fail(new Error("Projection video could not be decoded: " + (error?.message || "media error " + String(error?.code ?? "unknown"))));
    }
    async function playVideo() {
      const video = ownedVideo;
      if (video === null) return;
      try { await whileActive(video.play(), lifetime.signal); }
      catch (failure) {
        // Switching to reduced motion deliberately pauses a pending play request.
        if (!stopped && reduced && failure instanceof DOMException && failure.name === "AbortError") return;
        throw failure;
      }
      if (reduced || stopped) video.pause();
    }
    async function loadVideo(): Promise<{ source: MediaSource; size: readonly [number, number] }> {
      if (videoUrl === undefined || videoUrl.trim().length === 0) throw new Error("Choose a video to preview the mapped video effect.");
      const video = document.createElement("video");
      ownedVideo = video;
      video.muted = true; video.loop = true; video.playsInline = true; video.preload = "auto";
      video.addEventListener("error", videoError);
      const loaded = new Promise<void>(resolve => {
        loadedListener = () => {
          video.removeEventListener("loadeddata", loadedListener!); loadedListener = null; resolve();
        };
        video.addEventListener("loadeddata", loadedListener);
      });
      video.src = videoUrl; video.load();
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) await whileActive(loaded, lifetime.signal);
      else { video.removeEventListener("loadeddata", loadedListener!); loadedListener = null; }
      lifetime.signal.throwIfAborted();
      if (!Number.isSafeInteger(video.videoWidth) || !Number.isSafeInteger(video.videoHeight) || video.videoWidth < 1 || video.videoHeight < 1)
        throw new Error("Projection video decoded no valid image dimensions.");
      if (!reduced) await playVideo();
      lifetime.signal.throwIfAborted();
      let sequence = 0, lastTime = NaN;
      return { source: { currentFrame() {
        if (stopped) throw new Error("Projection video source was retired.");
        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return undefined;
        if (video.currentTime !== lastTime) { lastTime = video.currentTime; sequence++; }
        return { image: video, frameId: sequence };
      } }, size: [video.videoWidth, video.videoHeight] };
    }
    function draw(time: number) {
      if (renderer === null || stopped) return;
      const seconds = time / 1000;
      const index = frameIndex++;
      renderer.draw({ frame: frameFromClock({ timeSeconds: seconds, deltaSeconds: Math.max(0, seconds - previousSeconds),
        frameIndex: index, absFrameIndex: index, absTimeSeconds: seconds, mode: "realtime", randomSeed: 1, fps: DEFAULT_PROJECT_FPS }),
      pointer: { x: 0, y: 0, buttons: 0 }, resolution: [target!.width, target!.height] });
      previousSeconds = seconds;
    }
    function animate(time: number) {
      pendingFrame = null;
      if (stopped || reduced) return;
      try { draw(time); pendingFrame = requestAnimationFrame(animate); }
      catch (failure) { fail(failure); }
    }
    function changeMotion(event: MediaQueryListEvent) {
      if (stopped) return;
      reduced = event.matches;
      if (reduced) ownedVideo?.pause();
      if (pendingFrame !== null) cancelAnimationFrame(pendingFrame);
      pendingFrame = null;
      if (renderer === null) return;
      if (!reduced && ownedVideo !== null) {
        void playVideo().then(() => {
          if (stopped || reduced) return;
          draw(0); pendingFrame = requestAnimationFrame(animate);
        }).catch(fail);
        return;
      }
      try { draw(0); if (!reduced) pendingFrame = requestAnimationFrame(animate); }
      catch (failure) { fail(failure); }
    }
    motion.addEventListener("change", changeMotion);
    void (async () => {
      if (!Number.isSafeInteger(maxLongEdge) || maxLongEdge < 1) throw new Error("Projection preview maximum edge must be a positive integer.");
      const scale = Math.min(1, maxLongEdge / Math.max(photo.bitmap.width, photo.bitmap.height));
      const width = Math.max(1, Math.round(photo.bitmap.width * scale));
      const height = Math.max(1, Math.round(photo.bitmap.height * scale));
      if (width * height > 64_000_000) throw new Error("Projection preview exceeds 64 million samples.");
      const relief = depth === null ? new Float32Array(width * height).fill(0.5)
        : depthRange === undefined ? rasterizeFloatMap(depth, "depth", width, height) : remapDepthValues(depth, width, height, depthRange);
      const coverage = fullFrame ? new Float32Array(width * height).fill(1) : rasterizeFloatMap(mask!, "mask", width, height);
      const video = mode === 9 && !testPattern ? await loadVideo() : undefined;
      lifetime.signal.throwIfAborted();
      const created = await createPhotoEffectRenderer({ width, height, shader: PHOTO_MAPPING_SHADER,
        photo: { image: photo.bitmap, frameId: 1 }, photoSize: [photo.bitmap.width, photo.bitmap.height],
        ...(previewPhoto === null ? {} : { previewPhoto: { image: previewPhoto.bitmap, frameId: 1 },
          previewPhotoSize: [previewPhoto.bitmap.width, previewPhoto.bitmap.height] as const, previewFit, previewFraming }),
        ...(video === undefined ? {} : { video: video.source, videoSize: video.size }),
        depth: relief, mask: coverage, mode, previewOpacity, testPattern });
      if (stopped) { created.dispose(); return; }
      renderer = created;
      target.width = width; target.height = height;
      presentation = renderer.present(target);
      draw(0); setReady(true);
      if (!reduced) pendingFrame = requestAnimationFrame(animate);
    })().catch(fail);
    return stop;
  }, [photo, previewPhoto, depth, mask, matching, previewFit, previewFraming, fullFrame, previewOpacity, mode, maxLongEdge, depthRange, testPattern, videoUrl]);
  if (message !== null) return <p>{message}</p>;
  const caption = "Projection effect · " + (depth === null ? "neutral depth" : "depth") + " + " + (fullFrame ? "full frame" : "surface mask");
  return <figure style={{ margin: 0, width: "100%", height: "100%", position: "relative" }}>
    <canvas ref={canvas} role="img" aria-label="Animated mapping preview" hidden={error !== null}
      style={{ display: error === null ? "block" : "none", width: "100%", height: "100%", objectFit: "contain" }} />
    {error === null ? <figcaption style={{ position: "absolute", bottom: 0, width: "100%", textAlign: "center", fontSize: "var(--fs-meta)", color: "var(--text-dim)", background: "var(--bg-overlay)" }}>{ready ? caption : "Preparing projection effect…"}</figcaption>
      : <p role="note">Projection effect preview unavailable: {error}</p>}
  </figure>;
}
