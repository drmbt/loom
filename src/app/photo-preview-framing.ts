export type PreviewImageFit = "fit" | "fill" | "stretch";
interface ImageSize { readonly width: number; readonly height: number }

/** A proportional resize may round its shorter dimension to the nearest whole pixel. */
export function hasMatchingPhotoAspect(a: ImageSize, b: ImageSize): boolean {
  const [smaller, larger] = a.width * a.height <= b.width * b.height ? [a, b] : [b, a];
  return smaller.height === Math.round(smaller.width * larger.height / larger.width)
    || smaller.width === Math.round(smaller.height * larger.width / larger.height);
}

/** Canvas and graph use the same source crop and destination anchoring. */
export { imagePlacement as previewPhotoPlacement } from "@domain/media/image-framing.ts";
