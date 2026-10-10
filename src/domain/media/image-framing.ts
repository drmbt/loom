import { z } from "zod";
import { isParameterSlot, storedStaticValue } from "../parameters/slots.ts";
import type { StoredParameter } from "../types/parameters.ts";

export const imageFramingSchema = z.object({
  x: z.number().finite().min(0).max(1),
  y: z.number().finite().min(0).max(1),
  zoom: z.number().finite().min(1).max(8),
}).strict();

export type ImageFraming = z.infer<typeof imageFramingSchema>;
export const DEFAULT_IMAGE_FRAMING: ImageFraming = { x: 0.5, y: 0.5, zoom: 1 };

interface ImageSize { readonly width: number; readonly height: number }

export function imageFramingParameters(framing: ImageFraming): Record<string, number> {
  const parsed = imageFramingSchema.parse(framing);
  return { imageAnchorX: parsed.x, imageAnchorY: parsed.y, imageZoom: parsed.zoom };
}

/** Absent fields retain centered legacy framing; bound values require a snapshot. */
export function imageFramingFromParameters(parameters: Readonly<Record<string, StoredParameter>>): ImageFraming {
  const read = (key: string) => {
    const stored = parameters[key];
    if (isParameterSlot(stored) && stored.mode !== "static")
      throw new Error(`Image framing setting ${key} requires static mode. Snapshot its value before alignment.`);
    return storedStaticValue(stored);
  };
  return imageFramingSchema.parse({ x: read("imageAnchorX") ?? DEFAULT_IMAGE_FRAMING.x,
    y: read("imageAnchorY") ?? DEFAULT_IMAGE_FRAMING.y, zoom: read("imageZoom") ?? DEFAULT_IMAGE_FRAMING.zoom });
}

function dimensions(size: ImageSize, name: string): void {
  if (!size || ![size.width, size.height].every(value => Number.isSafeInteger(value) && value > 0))
    throw new Error(`${name} dimensions must be positive safe integers.`);
}

/** Source crop and target placement share the same normalized anchoring contract. */
export function imagePlacement(source: ImageSize, target: ImageSize, fit: "fit" | "fill" | "stretch",
  framing: ImageFraming = DEFAULT_IMAGE_FRAMING) {
  dimensions(source, "Source");
  dimensions(target, "Target");
  const { x, y, zoom } = imageFramingSchema.parse(framing);
  if (fit !== "fit" && fit !== "fill" && fit !== "stretch") throw new Error(`Invalid image fit mode: ${String(fit)}`);
  const ratio = (source.width / source.height) / (target.width / target.height);
  const sx = (fit === "stretch" ? 1 : fit === "fit" ? Math.min(1, ratio) : Math.max(1, ratio)) * zoom;
  const sy = (fit === "stretch" ? 1 : fit === "fit" ? Math.min(1, 1 / ratio) : Math.max(1, 1 / ratio)) * zoom;
  const sourceWidth = source.width * Math.min(1, 1 / sx);
  const sourceHeight = source.height * Math.min(1, 1 / sy);
  const destinationWidth = target.width * Math.min(1, sx);
  const destinationHeight = target.height * Math.min(1, sy);
  return {
    source: { x: Math.max(0, source.width - sourceWidth) * x, y: Math.max(0, source.height - sourceHeight) * y,
      width: sourceWidth, height: sourceHeight },
    destination: { x: Math.max(0, target.width - destinationWidth) * x, y: Math.max(0, target.height - destinationHeight) * y,
      width: destinationWidth, height: destinationHeight },
  };
}
