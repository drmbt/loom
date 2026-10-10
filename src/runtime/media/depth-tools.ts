import { z } from "zod";
import { validateFloatMap, type FloatMap } from "./float-map.ts";
import { makePreparedMap, preparedMetadata, rasterizeFloatMap } from "./prepared-map.ts";
import { depthRangeSchema, type DepthRangeSettings } from "../../domain/media/depth-range.ts";
export { depthRangeSchema, DEFAULT_DEPTH_RANGE, type DepthRangeSettings } from "../../domain/media/depth-range.ts";

const rangeFields = {
  low: z.number().finite().min(0).max(1),
  high: z.number().finite().min(0).max(1),
  softness: z.number().finite().min(0).max(0.25),
};
const ordered = (settings: { low: number; high: number }) => settings.high > settings.low;

export interface DepthRangeMaskMetadata extends DepthRangeSettings {
  readonly version: 1;
  readonly parentSha256: string;
}

const MODEL_ID = "loom-depth-range-mask";
const MODEL_URL = "loom:depth-range-mask";
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/, "Depth mask parent must be a lowercase SHA-256 digest.");
const metadataSchema = z.object({ version: z.literal(1), ...rangeFields, parentSha256: digestSchema }).strict().refine(ordered, {
  message: "Depth range high must exceed low.", path: ["high"],
});

function invalid(message: string): never { throw new Error(`Invalid depth range mask: ${message}`); }

function smoothstep(low: number, high: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - low) / (high - low)));
  return t * t * (3 - 2 * t);
}

/** A working remap only. Native depth, its range and its preparation recipe stay untouched. */
export function remapDepthValues(map: FloatMap, width: number, height: number, settings: DepthRangeSettings): Float32Array {
  const { low, high } = depthRangeSchema.parse(settings);
  const values = rasterizeFloatMap(map, "depth", width, height);
  for (let index = 0; index < values.length; index++) values[index] = Math.max(0, Math.min(1, (values[index]! - low) / (high - low)));
  return values;
}

/** Derive independent float32 mask confidence from a registered depth band. */
export function createDepthRangeMask(map: FloatMap, targetWidth: number, targetHeight: number,
  settings: DepthRangeSettings, parentSha256: string): FloatMap {
  const { low, high, softness } = depthRangeSchema.parse(settings);
  const parent = digestSchema.parse(parentSha256);
  const preparation = preparedMetadata(map);
  if (preparation.kind !== "depth") invalid("source must be a prepared depth map");
  const values = rasterizeFloatMap(map, "depth", targetWidth, targetHeight);
  for (let index = 0; index < values.length; index++) {
    const value = values[index]!;
    if (softness === 0) values[index] = Number(value >= low && value <= high);
    else {
      // Full-range ends include the nearest/farthest samples at full confidence.
      const lower = low === 0 ? 1 : smoothstep(low - softness, low + softness, value);
      const upper = high === 1 ? 1 : 1 - smoothstep(high - softness, high + softness, value);
      values[index] = lower * upper;
    }
  }
  const mask = makePreparedMap(values, targetWidth, targetHeight, {
    kind: "mask", source: preparation.source, inputSide: Math.max(targetWidth, targetHeight),
    registration: "stretch", model: { id: MODEL_ID, url: MODEL_URL },
  });
  const depthMask: DepthRangeMaskMetadata = { version: 1, low, high, softness, parentSha256: parent };
  return { ...mask, metadata: { ...mask.metadata, depthMask } };
}

/** A recognized derived mask must retain its complete recipe and parent identity. */
export function depthRangeMaskSettings(map: FloatMap): DepthRangeMaskMetadata | undefined {
  const preparation = preparedMetadata(map);
  if (preparation.model.id !== MODEL_ID) return undefined;
  if (preparation.kind !== "mask" || preparation.model.url !== MODEL_URL) invalid("preparation must identify a depth range mask");
  const value = map.metadata?.depthMask;
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid("depthMask metadata must be a plain object");
  const parsed = metadataSchema.safeParse(value);
  if (!parsed.success) invalid(`depthMask metadata: ${parsed.error.message}`);
  validateFloatMap(map);
  if (preparation.inputSide !== Math.max(map.width, map.height)) invalid("inputSide must match mask dimensions");
  for (const value of map.values) if (value < 0 || value > 1) invalid("mask confidence must be in 0..1");
  return parsed.data;
}
