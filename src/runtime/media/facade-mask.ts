import { srgbToLinear } from "../export/pixel-format.ts";
import type { FloatMap } from "./float-map.ts";
import { makePreparedMap, preparedMetadata, rasterizeFloatMap } from "./prepared-map.ts";

export interface FacadeMaskSettings {
  readonly darkCutoff: number;
  readonly feather: number;
  readonly excludeBlueGlass: boolean;
}

export interface FacadeMaskMetadata extends FacadeMaskSettings {
  readonly version: 1;
  readonly detailSide: number;
  readonly envelopeWidth: number;
  readonly envelopeHeight: number;
}

export interface FacadeReferencePhoto {
  readonly width: number;
  readonly height: number;
  /** Display-encoded sRGB RGBA channels in 0..1 at the desired mask resolution. */
  readonly texels: Float32Array;
}

export const FACADE_MASK_DEFAULTS: FacadeMaskSettings = Object.freeze({
  darkCutoff: 0.018,
  feather: 0.012,
  excludeBlueGlass: true,
});

const MODEL_ID = "facade-surfaces-v1";
const METADATA_KEYS = ["version", "detailSide", "darkCutoff", "feather", "excludeBlueGlass", "envelopeWidth", "envelopeHeight"] as const;

function invalid(message: string): never {
  throw new Error(`Invalid facade mask: ${message}`);
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${name} must be a positive integer`);
}

function dimensions(width: unknown, height: unknown): void {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  if (width * height > 64_000_000) invalid("dimensions exceed 64000000 samples");
}

function probability(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) invalid(`${name} must be finite and in 0..1`);
}

function validateSettings(settings: FacadeMaskSettings): void {
  probability(settings.darkCutoff, "darkCutoff");
  probability(settings.feather, "feather");
  if (typeof settings.excludeBlueGlass !== "boolean") invalid("excludeBlueGlass must be a boolean");
}

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A colour heuristic for reflected blue/cyan glass; painted walls may need a restore stroke. */
function blueGlass(red: number, green: number, blue: number): number {
  const maximum = Math.max(red, green, blue);
  if (maximum === 0) return 0;
  const saturation = (maximum - Math.min(red, green, blue)) / maximum;
  const coolness = Math.min(green - red * 1.13, blue - red * 1.18);
  return smoothstep(0.01, 0.08, coolness) * smoothstep(0.15, 0.4, saturation);
}

/** Recognized facade maps must contain their complete, versioned refinement recipe. */
export function facadeMaskSettings(map: FloatMap): FacadeMaskMetadata | undefined {
  const preparation = preparedMetadata(map);
  if (preparation.model.id !== MODEL_ID) return undefined;
  if (preparation.kind !== "mask") invalid("facade preparation must be a mask");
  const value = map.metadata?.facade;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== METADATA_KEYS.length || METADATA_KEYS.some((key) => !Object.hasOwn(value, key))) {
    invalid(`facade metadata must contain exactly ${METADATA_KEYS.join(", ")}`);
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.version !== 1) invalid("unsupported facade metadata version");
  positiveInteger(metadata.detailSide, "detailSide");
  positiveInteger(metadata.envelopeWidth, "envelopeWidth");
  positiveInteger(metadata.envelopeHeight, "envelopeHeight");
  dimensions(metadata.envelopeWidth, metadata.envelopeHeight);
  dimensions(map.width, map.height);
  if (metadata.detailSide !== Math.max(map.width, map.height)) invalid("detailSide must match mask dimensions");
  validateSettings(metadata as unknown as FacadeMaskSettings);
  return metadata as unknown as FacadeMaskMetadata;
}

/** Refine a semantic wall envelope with reference-photo openings, keeping native AI provenance. */
export function refineFacadeMask(
  envelope: FloatMap,
  photo: FacadeReferencePhoto,
  settings: FacadeMaskSettings = FACADE_MASK_DEFAULTS,
): FloatMap {
  validateSettings(settings);
  dimensions(photo.width, photo.height);
  if (!(photo.texels instanceof Float32Array) || photo.texels.length !== photo.width * photo.height * 4) {
    invalid("photo sample count must match RGBA dimensions");
  }
  for (const channel of photo.texels) probability(channel, "photo channel");
  const preparation = preparedMetadata(envelope);
  if (preparation.kind !== "mask") invalid("envelope must be a prepared mask");
  const values = rasterizeFloatMap(envelope, "mask", photo.width, photo.height);
  for (let index = 0; index < values.length; index += 1) {
    const red = photo.texels[index * 4]!;
    const green = photo.texels[index * 4 + 1]!;
    const blue = photo.texels[index * 4 + 2]!;
    const luminance = 0.2126 * srgbToLinear(red) + 0.7152 * srgbToLinear(green) + 0.0722 * srgbToLinear(blue);
    const opaque = settings.feather === 0
      ? Number(luminance >= settings.darkCutoff)
      : smoothstep(settings.darkCutoff - settings.feather, settings.darkCutoff + settings.feather, luminance);
    values[index] = values[index]! * opaque * (settings.excludeBlueGlass ? 1 - blueGlass(red, green, blue) : 1);
  }
  const map = makePreparedMap(values, photo.width, photo.height, {
    kind: "mask", source: preparation.source,
    model: { id: MODEL_ID, url: preparation.model.url },
    inputSide: preparation.inputSide, registration: "stretch",
  });
  const facade: FacadeMaskMetadata = {
    version: 1, detailSide: Math.max(photo.width, photo.height),
    darkCutoff: settings.darkCutoff, feather: settings.feather, excludeBlueGlass: settings.excludeBlueGlass,
    envelopeWidth: envelope.width, envelopeHeight: envelope.height,
  };
  return { ...map, metadata: { ...map.metadata, facade } };
}
