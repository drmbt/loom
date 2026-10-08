/** Single-channel numerical images; samples never pass through colour encoding. */
export const FLOAT_MAP_EXTENSION = ".loomf32";
export const FLOAT_MAP_MIME_TYPE = "application/x-loom-f32";

export interface FloatMap {
  readonly width: number;
  readonly height: number;
  readonly values: Float32Array;
  readonly metadata?: Record<string, unknown>;
}

// LOOMF32\0, uint32 LE version, uint32 LE JSON byte length, UTF-8 JSON, float32 LE samples.
const MAGIC = new Uint8Array([0x4c, 0x4f, 0x4f, 0x4d, 0x46, 0x33, 0x32, 0x00]);
const VERSION = 1;
const PREFIX_BYTES = 16;
const MAX_SAMPLES = 64_000_000;
const MAX_HEADER_BYTES = 1_048_576;

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

export function encodeFloatMap(map: FloatMap): Uint8Array {
  const count = sampleCount(map.width, map.height);
  if (!(map.values instanceof Float32Array) || map.values.length !== count) {
    invalid("sample count does not match dimensions");
  }
  for (const value of map.values) {
    if (!Number.isFinite(value)) invalid("samples must be finite");
  }
  if (map.metadata !== undefined) validateMetadata(map.metadata);
  const header = new TextEncoder().encode(JSON.stringify({
    width: map.width,
    height: map.height,
    ...(map.metadata === undefined ? {} : { metadata: map.metadata }),
  }));
  if (header.length > MAX_HEADER_BYTES) invalid("header exceeds 1048576 bytes");
  const bytes = new Uint8Array(PREFIX_BYTES + header.length + count * 4);
  bytes.set(MAGIC);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, VERSION, true);
  view.setUint32(12, header.length, true);
  bytes.set(header, PREFIX_BYTES);
  for (let index = 0; index < count; index += 1) {
    view.setFloat32(PREFIX_BYTES + header.length + index * 4, map.values[index]!, true);
  }
  return bytes;
}

export function decodeFloatMap(input: ArrayBuffer | Uint8Array): FloatMap {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < PREFIX_BYTES) invalid("truncated prefix");
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) invalid("unrecognised signature");
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(8, true) !== VERSION) invalid("unsupported version");
  const headerLength = view.getUint32(12, true);
  if (headerLength < 1 || headerLength > MAX_HEADER_BYTES) invalid("invalid header length");
  const payloadOffset = PREFIX_BYTES + headerLength;
  if (payloadOffset > bytes.length) invalid("truncated header");
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(PREFIX_BYTES, payloadOffset)));
  } catch {
    invalid("header must be UTF-8 JSON");
  }
  if (!isRecord(header) || Object.keys(header).some((key) => !["width", "height", "metadata"].includes(key))) {
    invalid("header must contain only width, height and optional metadata");
  }
  const count = sampleCount(header.width, header.height);
  if (Object.hasOwn(header, "metadata")) validateMetadata(header.metadata);
  if (bytes.length !== payloadOffset + count * 4) invalid("payload length does not match dimensions");
  const values = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    const value = view.getFloat32(payloadOffset + index * 4, true);
    if (!Number.isFinite(value)) invalid("samples must be finite");
    values[index] = value;
  }
  return {
    width: header.width as number,
    height: header.height as number,
    values,
    ...(Object.hasOwn(header, "metadata") ? { metadata: header.metadata as Record<string, unknown> } : {}),
  };
}
