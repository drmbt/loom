/** Single-channel numerical images; samples never pass through colour encoding. */
export interface FloatMap {
  readonly width: number;
  readonly height: number;
  readonly values: Float32Array;
  readonly metadata?: Record<string, unknown>;
}

const MAX_SAMPLES = 64_000_000;

function invalid(message: string): never {
  throw new Error(`Invalid float map: ${message}`);
}

function sampleCount(width: unknown, height: unknown): number {
  if (
    typeof width !== "number" || typeof height !== "number" ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    width < 1 || height < 1 || width > MAX_SAMPLES || height > MAX_SAMPLES ||
    width * height > MAX_SAMPLES
  ) invalid("dimensions must be positive integers with at most 64000000 samples");
  return width * height;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Reject JSON's lossy coercions (undefined, nonfinite numbers, dates, cycles). */
function validateJson(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!Array.isArray(value) && !isRecord(value)) invalid("metadata must contain JSON values");
  if (ancestors.has(value)) invalid("metadata must not contain cycles");
  ancestors.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) validateJson(child, ancestors);
  ancestors.delete(value);
}

function validateMetadata(metadata: unknown): asserts metadata is Record<string, unknown> {
  if (!isRecord(metadata)) invalid("metadata must be a JSON object");
  validateJson(metadata);
}

export function validateFloatMap(map: FloatMap): number {
  const count = sampleCount(map.width, map.height);
  if (!(map.values instanceof Float32Array) || map.values.length !== count) {
    invalid("sample count does not match dimensions");
  }
  for (const value of map.values) {
    if (!Number.isFinite(value)) invalid("samples must be finite");
  }
  if (map.metadata !== undefined) validateMetadata(map.metadata);
  return count;
}
