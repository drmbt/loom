import { occOf } from "../models/depth-runner.ts";
import type { FloatMap } from "./float-map.ts";

export interface PreparedMapMetadata {
  readonly version: 1;
  readonly kind: "depth" | "mask";
  readonly source: { readonly sha256: string; readonly width: number; readonly height: number };
  readonly model: { readonly id: string; readonly url: string };
  readonly inputSide: number;
  readonly registration: "letterbox" | "stretch";
  readonly range: { readonly low: number; readonly high: number };
}

function invalid(message: string): never {
  throw new Error(`Invalid prepared map: ${message}`);
}

function record(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    invalid(`${name} must contain exactly ${keys.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalid(`${name} must be a positive integer`);
}

function finite(value: unknown, name: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${name} must be finite`);
}

/** Preparation provenance is versioned and strict; unprepared numerical maps are not guessed. */
export function preparedMetadata(map: FloatMap): PreparedMapMetadata {
  const metadata = record(map.metadata?.preparation,
    ["version", "kind", "source", "model", "inputSide", "registration", "range"], "preparation metadata");
  if (metadata.version !== 1) invalid("unsupported preparation version");
  if (metadata.kind !== "depth" && metadata.kind !== "mask") invalid("kind must be depth or mask");
  const source = record(metadata.source, ["sha256", "width", "height"], "source");
  if (typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) invalid("source sha256 must be a lowercase SHA-256 digest");
  positiveInteger(source.width, "source width");
  positiveInteger(source.height, "source height");
  const model = record(metadata.model, ["id", "url"], "model");
  for (const key of ["id", "url"] as const) {
    if (typeof model[key] !== "string" || model[key].trim().length === 0) invalid(`model ${key} must be nonempty`);
  }
  positiveInteger(metadata.inputSide, "inputSide");
  if (metadata.registration !== "letterbox" && metadata.registration !== "stretch") invalid("registration must be letterbox or stretch");
  if (metadata.kind === "mask" && metadata.registration !== "stretch") invalid("mask registration must be stretch");
  const range = record(metadata.range, ["low", "high"], "range");
  finite(range.low, "range low");
  finite(range.high, "range high");
  if (range.low > range.high) invalid("range low must not exceed high");
  if (metadata.kind === "mask" && (range.low !== 0 || range.high !== 1)) invalid("mask range must be 0..1");
  return metadata as unknown as PreparedMapMetadata;
}

function dimensions(width: number, height: number): void {
  positiveInteger(width, "width");
  positiveInteger(height, "height");
  if (width * height > 64_000_000) invalid("dimensions exceed 64000000 samples");
}

function validateSamples(map: FloatMap, kind?: "depth" | "mask"): void {
  dimensions(map.width, map.height);
  if (!(map.values instanceof Float32Array) || map.values.length !== map.width * map.height) invalid("sample count must match dimensions");
  for (const value of map.values) {
    finite(value, "sample");
    if (kind === "mask" && (value < 0 || value > 1)) invalid("mask samples must be probabilities in 0..1");
  }
}

/** Bounds include only texel centers within the source's occupied band. */
function occupiedBounds(map: FloatMap, metadata?: PreparedMapMetadata): readonly [number, number, number, number] {
  const [occX, occY] = metadata?.registration === "letterbox"
    ? occOf(metadata.source.width, metadata.source.height) : [1, 1];
  const x0 = Math.max(0, Math.ceil((1 - occX) * map.width / 2 - 0.5));
  const y0 = Math.max(0, Math.ceil((1 - occY) * map.height / 2 - 0.5));
  const x1 = Math.min(map.width - 1, Math.floor((1 + occX) * map.width / 2 - 0.5));
  const y1 = Math.min(map.height - 1, Math.floor((1 + occY) * map.height / 2 - 0.5));
  if (x0 > x1 || y0 > y1) invalid("letterbox band contains no native samples");
  return [x0, y0, x1, y1];
}

/** Keep native float32 values untouched; normalization is separate display metadata. */
export function makePreparedMap(
  values: Float32Array, width: number, height: number,
  input: Omit<PreparedMapMetadata, "version" | "range">,
): FloatMap {
  const preparation: PreparedMapMetadata = {
    ...input, version: 1, range: { low: 0, high: 1 },
    source: { ...input.source }, model: { ...input.model },
  };
  const map: FloatMap = { values, width, height, metadata: { preparation } };
  preparedMetadata(map);
  validateSamples(map, preparation.kind);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  if (preparation.kind === "depth") {
    const [x0, y0, x1, y1] = occupiedBounds(map, preparation);
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const value = values[y * width + x]!;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
  } else {
    low = 0;
    high = 1;
  }
  return { ...map, values: values.slice(), metadata: { preparation: { ...preparation, range: { low, high } } } };
}

/** Bilinear sampling uses image texel centers and excludes letterbox padding for depth. */
export function rasterizeFloatMap(
  map: FloatMap, interpretation: "raw" | "depth" | "mask", width: number, height: number,
): Float32Array {
  dimensions(width, height);
  if (!["raw", "depth", "mask"].includes(interpretation)) invalid("unknown interpretation");
  const metadata = interpretation === "raw" ? undefined : preparedMetadata(map);
  if (metadata && interpretation !== metadata.kind) invalid(`interpretation ${interpretation} does not match ${metadata.kind}`);
  validateSamples(map, metadata?.kind);
  if (interpretation !== "depth" && width === map.width && height === map.height) return map.values.slice();
  const [x0, y0, x1, y1] = occupiedBounds(map, metadata);
  const [occX, occY] = metadata?.registration === "letterbox"
    ? occOf(metadata.source.width, metadata.source.height) : [1, 1];
  const result = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const sy = Math.min(y1, Math.max(y0, (((y + 0.5) / height - 0.5) * occY + 0.5) * map.height - 0.5));
    const ya = Math.floor(sy);
    const yb = Math.min(y1, ya + 1);
    for (let x = 0; x < width; x += 1) {
      const sx = Math.min(x1, Math.max(x0, (((x + 0.5) / width - 0.5) * occX + 0.5) * map.width - 0.5));
      const xa = Math.floor(sx);
      const xb = Math.min(x1, xa + 1);
      const a = map.values[ya * map.width + xa]!;
      const b = map.values[ya * map.width + xb]!;
      const c = map.values[yb * map.width + xa]!;
      const d = map.values[yb * map.width + xb]!;
      const top = a + (b - a) * (sx - xa);
      const bottom = c + (d - c) * (sx - xa);
      const raw = top + (bottom - top) * (sy - ya);
      result[y * width + x] = interpretation === "depth" && metadata
        ? (metadata.range.high === metadata.range.low ? 0.5 : (raw - metadata.range.low) / (metadata.range.high - metadata.range.low))
        : raw;
    }
  }
  return result;
}

/** Native pixel coordinates; the swept circular brush is continuous, with no stamp gaps. */
export function paintMaskStroke(
  map: FloatMap, from: { x: number; y: number }, to: { x: number; y: number }, radius: number, value: 0 | 1,
): FloatMap {
  const stroke = beginMaskStroke(map);
  stroke.paint(from, to, radius, value);
  return stroke.finish();
}

/** One owned copy and validation per gesture; completed maps and undo snapshots stay untouched. */
export function beginMaskStroke(map: FloatMap) {
  const metadata = preparedMetadata(map);
  if (metadata.kind !== "mask") invalid("painting requires a prepared mask");
  validateSamples(map, "mask");
  const draft = { ...map, values: map.values.slice() };
  let finished = false;
  return {
    paint(from: { x: number; y: number }, to: { x: number; y: number }, radius: number, value: 0 | 1): FloatMap {
      if (finished) invalid("stroke is already finished");
      paintMaskValues(draft, from, to, radius, value);
      return draft;
    },
    finish(): FloatMap {
      if (finished) invalid("stroke is already finished");
      finished = true;
      return draft;
    },
  };
}

function paintMaskValues(
  map: FloatMap, from: { x: number; y: number }, to: { x: number; y: number }, radius: number, value: 0 | 1,
): void {
  for (const coordinate of [from.x, from.y, to.x, to.y, radius]) finite(coordinate, "brush coordinate/radius");
  if (radius <= 0) invalid("brush radius must be positive");
  if (value !== 0 && value !== 1) invalid("brush value must be 0 or 1");
  const values = map.values;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  finite(length, "brush length");
  const ux = length === 0 ? 0 : dx / length;
  const uy = length === 0 ? 0 : dy / length;
  const x0 = Math.max(0, Math.ceil(Math.min(from.x, to.x) - radius));
  const y0 = Math.max(0, Math.ceil(Math.min(from.y, to.y) - radius));
  const x1 = Math.min(map.width - 1, Math.floor(Math.max(from.x, to.x) + radius));
  const y1 = Math.min(map.height - 1, Math.floor(Math.max(from.y, to.y) + radius));
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const along = Math.min(length, Math.max(0, (x - from.x) * ux + (y - from.y) * uy));
      if (Math.hypot(x - from.x - along * ux, y - from.y - along * uy) <= radius) values[y * map.width + x] = value;
    }
  }
}
