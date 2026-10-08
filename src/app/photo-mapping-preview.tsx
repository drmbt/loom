import { useEffect, useRef, useState } from "react";
import { rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import type { FloatMap } from "@runtime/media/float-map.ts";
import type { PreparationPhoto } from "./photo-preparation.ts";
import { previewPhotoPlacement, type PreviewImageFit } from "./photo-preview-framing.ts";

// v17-allow-dynamic-color: canvas colours visualize prepared maps and animated coverage, not UI theme colours.

export interface PhotoMappingPreviewProps {
  readonly photo: PreparationPhoto | null;
  readonly previewPhoto: PreparationPhoto | null;
  readonly depth: FloatMap | null;
  readonly mask: FloatMap | null;
  readonly matching: boolean;
  readonly previewFit?: PreviewImageFit;
  readonly fullFrame?: boolean;
  readonly previewOpacity?: number;
}

/** Display-sized copies only: native depth and mask samples never pass through canvas. */
function prepareMappingPreview(photo: PreparationPhoto, depth: FloatMap | null, mask: FloatMap | null, fullFrame: boolean) {
  const scale = Math.min(1, 480 / photo.bitmap.width, 240 / photo.bitmap.height);
  const width = Math.max(1, Math.round(photo.bitmap.width * scale));
  const height = Math.max(1, Math.round(photo.bitmap.height * scale));
  if (!fullFrame && mask === null) throw new Error("A surface preview requires a prepared mask.");
  const coverage = fullFrame ? new Float32Array(width * height).fill(1) : rasterizeFloatMap(mask!, "mask", width, height);
  const relief = depth === null ? null : rasterizeFloatMap(depth, "depth", width, height);
  const fill = new Uint8ClampedArray(width * height * 4);
  const boundary: number[] = [];
  const radius = Math.max(1, Math.round(Math.min(width, height) * 0.012));
  const covered = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && coverage[y * width + x]! >= 0.5;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    const offset = index * 4;
    const d = relief === null ? 0.5 : relief[index]!;
    const contour = relief !== null && Math.abs((d * 12) % 1 - 0.5) < 0.09;
    fill[offset] = 40 + d * 160;
    fill[offset + 1] = 155 - d * 95;
    fill[offset + 2] = 230;
    fill[offset + 3] = coverage[index]! * (contour ? 95 : 42);
    if (covered(x, y) && (!covered(x - radius, y) || !covered(x + radius, y)
      || !covered(x, y - radius) || !covered(x, y + radius))) boundary.push(index);
  }
  return { width, height, fill, boundary: Uint32Array.from(boundary), coverage };
}

function guidance({ photo, mask, matching, fullFrame = false }: PhotoMappingPreviewProps): string | null {
  if (photo === null) return "Choose a reference photo to see the live mapping preview.";
  if (mask === null && !fullFrame) return "Prepare or open a mask to preview its animated outline.";
  if (!matching) return "Use maps that match the reference photo for this preview.";
  return null;
}

/** A small UI diagnostic; it runs no inference and owns no photo bitmaps or network state. */
export function PhotoMappingPreview(props: PhotoMappingPreviewProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const message = guidance(props);
  const { photo, previewPhoto, depth, mask, matching, previewFit = "stretch", fullFrame = false, previewOpacity = 0.35 } = props;
  useEffect(() => {
    if (photo === null || guidance({ photo, previewPhoto, depth, mask, matching, fullFrame }) !== null) return;
    const target = canvas.current;
    if (target === null) throw new Error("The mapping preview canvas was not mounted.");
    const context = target.getContext("2d");
    const fillCanvas = document.createElement("canvas");
    const edgeCanvas = document.createElement("canvas");
    const fillContext = fillCanvas.getContext("2d");
    const edgeContext = edgeCanvas.getContext("2d");
    if (context === null || fillContext === null || edgeContext === null) {
      setError("The mapping preview requires a 2D canvas.");
      return;
    }
    let raster: ReturnType<typeof prepareMappingPreview>;
    try { raster = prepareMappingPreview(photo, depth, mask, fullFrame); }
    catch (failure) { setError(failure instanceof Error ? failure.message : String(failure)); return; }
    setError(null);
    const { width, height, fill, boundary, coverage } = raster;
    for (const element of [target, fillCanvas, edgeCanvas]) { element.width = width; element.height = height; }
    const fillImage = fillContext.createImageData(width, height);
    fillImage.data.set(fill);
    for (let i = 3; i < fillImage.data.length; i += 4) fillImage.data[i] = fillImage.data[i]! * previewOpacity;
    fillContext.putImageData(fillImage, 0, 0);
    const edgeImage = edgeContext.createImageData(width, height);
    const background = previewPhoto === null ? photo.bitmap : previewPhoto.bitmap;
    const placement = previewPhotoPlacement(background, { width, height }, previewFit);
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reduced = motion.matches;
    let stopped = false;
    let frame = 0;
    function draw(time: number) {
      context!.clearRect(0, 0, width, height);
      context!.drawImage(background, placement.source.x, placement.source.y, placement.source.width, placement.source.height,
        placement.destination.x, placement.destination.y, placement.destination.width, placement.destination.height);
      context!.drawImage(fillCanvas, 0, 0);
      for (const index of boundary) {
        const x = index % width;
        const y = Math.floor(index / width);
        const wave = 0.5 + 0.5 * Math.sin((x / width + y / height) * Math.PI * 5 - time * 0.0025);
        const offset = index * 4;
        edgeImage.data[offset] = 35 + wave * 220;
        edgeImage.data[offset + 1] = 230 - wave * 175;
        edgeImage.data[offset + 2] = 255;
        edgeImage.data[offset + 3] = coverage[index]! * 255 * Math.min(1, previewOpacity * 2);
      }
      edgeContext!.putImageData(edgeImage, 0, 0);
      context!.drawImage(edgeCanvas, 0, 0);
    }
    function animate(time: number) {
      if (stopped || reduced) return;
      draw(time);
      frame = requestAnimationFrame(animate);
    }
    function changeMotion(event: MediaQueryListEvent) {
      reduced = event.matches;
      cancelAnimationFrame(frame);
      draw(0);
      if (!reduced) frame = requestAnimationFrame(animate);
    }
    draw(0);
    if (!reduced) frame = requestAnimationFrame(animate);
    motion.addEventListener("change", changeMotion);
    return () => { stopped = true; cancelAnimationFrame(frame); motion.removeEventListener("change", changeMotion); };
  }, [photo, previewPhoto, depth, mask, matching, previewFit, fullFrame, previewOpacity]);
  if (message !== null) return <p>{message}</p>;
  return <figure style={{ margin: 0, width: "100%" }}>
    <canvas ref={canvas} role="img" aria-label="Animated mapping preview" hidden={error !== null}
      style={{ display: error === null ? "block" : "none", width: "100%", height: "auto", maxWidth: `${Math.min(480, 240 * photo!.bitmap.width / photo!.bitmap.height)}px`, margin: "0 auto", objectFit: "contain" }} />
    {error === null ? <figcaption style={{ textAlign: "center", fontSize: "var(--fs-meta)", color: "var(--text-dim)" }}>Live outline · preview only</figcaption>
      : <p role="alert">{error}</p>}
  </figure>;
}
