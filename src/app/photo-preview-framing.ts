export type PreviewImageFit = "fit" | "fill" | "stretch";
interface ImageSize { readonly width: number; readonly height: number }

/** A proportional resize may round its shorter dimension to the nearest whole pixel. */
export function hasMatchingPhotoAspect(a: ImageSize, b: ImageSize): boolean {
  const [smaller, larger] = a.width * a.height <= b.width * b.height ? [a, b] : [b, a];
  return smaller.height === Math.round(smaller.width * larger.height / larger.width)
    || smaller.width === Math.round(smaller.height * larger.width / larger.height);
}

/** Canvas equivalent of Movie File In's imageFit, centered in the reference frame. */
export function previewPhotoPlacement(source: ImageSize, target: ImageSize, fit: PreviewImageFit) {
  if (fit === "stretch") return {
    source: { x: 0, y: 0, width: source.width, height: source.height },
    destination: { x: 0, y: 0, width: target.width, height: target.height },
  };
  const scale = fit === "fill" ? Math.max(target.width / source.width, target.height / source.height)
    : Math.min(target.width / source.width, target.height / source.height);
  const width = fit === "fill" ? target.width / scale : source.width;
  const height = fit === "fill" ? target.height / scale : source.height;
  return {
    source: { x: (source.width - width) / 2, y: (source.height - height) / 2, width, height },
    destination: { x: (target.width - width * scale) / 2, y: (target.height - height * scale) / 2,
      width: width * scale, height: height * scale },
  };
}
