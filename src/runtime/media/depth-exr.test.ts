import { deflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { DEFAULT_PHOTO_DEPTH_RECIPE } from "../../domain/media/photo-depth-recipe.ts";
import { makePreparedMap, preparedMetadata, withDepthRecipe } from "./prepared-map.ts";
import { decodeDepthExr, decodeNumericalExr, encodeDepthExr } from "./depth-exr.ts";
import type { FloatMap } from "./float-map.ts";

const bits = (values: Float32Array) => new Uint32Array(values.buffer, values.byteOffset, values.length);
const samples = () => new Float32Array([-8.5, -0, 2 ** -149, 1 + 2 ** -23, 3.25, 2 ** 80]);
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Independent structural inspection; does not call the production header reader. */
function inspect(bytes: Uint8Array) {
  const view = viewOf(bytes);
  let position = 8;
  const string = () => {
    const end = bytes.indexOf(0, position);
    expect(end).toBeGreaterThanOrEqual(position);
    const text = new TextDecoder().decode(bytes.subarray(position, end));
    position = end + 1;
    return text;
  };
  const attributes = new Map<string, { type: string; start: number; sizePosition: number; position: number; size: number }>();
  while (bytes[position] !== 0) {
    const start = position, name = string(), type = string(), sizePosition = position;
    const size = view.getInt32(position, true);
    position += 4;
    attributes.set(name, { type, start, sizePosition, position, size });
    position += size;
  }
  return { view, attributes, table: position + 1 };
}

function bytesOf(values: number[], kind: "int" | "float" = "int") {
  const bytes = new Uint8Array(values.length * 4), view = viewOf(bytes);
  values.forEach((value, index) => {
    if (kind === "float") view.setFloat32(index * 4, value, true);
    else view.setInt32(index * 4, value, true);
  });
  return bytes;
}

/** Independent producer with a shifted window and physically reversed rows. */
function externalFixture({ channel = "Z", type = 2, compression = 0, flags = 0, duplicate = false, multipleChannels = false, chunkCount = undefined as number | undefined } = {}) {
  const parts: Uint8Array[] = [bytesOf([20_000_630, 2 | flags])];
  const put = (name: string, type: string, value: Uint8Array) => {
    parts.push(new TextEncoder().encode(`${name}\0${type}\0`), bytesOf([value.length]), value);
  };
  const channelBytes = new Uint8Array(channel.length + 1 + 16 + 1);
  channelBytes.set(new TextEncoder().encode(channel));
  const channelView = viewOf(channelBytes), start = channel.length + 1;
  channelView.setInt32(start, type, true);
  channelView.setInt32(start + 8, 1, true);
  channelView.setInt32(start + 12, 1, true);
  if (multipleChannels) {
    const list = new Uint8Array(channelBytes.length + 18);
    list.set(channelBytes.subarray(0, channelBytes.length - 1));
    const second = new Uint8Array(18), secondView = viewOf(second);
    second[0] = 0x59;
    secondView.setInt32(2, 2, true); secondView.setInt32(10, 1, true); secondView.setInt32(14, 1, true);
    list.set(second, channelBytes.length - 1);
    put("channels", "chlist", list);
  } else put("channels", "chlist", channelBytes);
  put("compression", "compression", new Uint8Array([compression]));
  put("dataWindow", "box2i", bytesOf([-11, 23, -9, 24]));
  put("displayWindow", "box2i", bytesOf([-20, 10, 20, 40]));
  put("lineOrder", "lineOrder", new Uint8Array([1]));
  put("pixelAspectRatio", "float", bytesOf([1], "float"));
  put("screenWindowCenter", "v2f", bytesOf([0, 0], "float"));
  put("screenWindowWidth", "float", bytesOf([1], "float"));
  if (chunkCount !== undefined) put("chunkCount", "int", bytesOf([chunkCount]));
  if (duplicate) put("lineOrder", "lineOrder", new Uint8Array([1]));
  parts.push(new Uint8Array([0]));
  const headerBytes = parts.reduce((sum, part) => sum + part.length, 0);
  const dataStart = headerBytes + 16, chunkBytes = 20;
  const bytes = new Uint8Array(dataStart + 2 * chunkBytes), view = viewOf(bytes);
  let position = 0;
  for (const part of parts) { bytes.set(part, position); position += part.length; }
  view.setBigUint64(headerBytes, BigInt(dataStart + chunkBytes), true);
  view.setBigUint64(headerBytes + 8, BigInt(dataStart), true);
  const values = samples();
  for (let row = 0; row < 2; row++) {
    const offset = dataStart + (1 - row) * chunkBytes;
    view.setInt32(offset, 23 + row, true);
    view.setInt32(offset + 4, 12, true);
    for (let x = 0; x < 3; x++) view.setFloat32(offset + 8 + x * 4, values[row * 3 + x]!, true);
  }
  return bytes;
}

/** Independent ZIP producer: planar little-endian floats, shuffle, difference predictor, zlib. */
function zipFixture(compression: 2 | 3, options: { raw?: boolean; decodedExtra?: number; chunkCount?: number } = {}) {
  const width = 32, height = 19, lines = compression === 3 ? 16 : 1, count = Math.ceil(height / lines);
  const template = externalFixture({ compression, chunkCount: options.chunkCount }), header = inspect(template);
  const windowOffset = header.attributes.get("dataWindow")!.position;
  header.view.setInt32(windowOffset + 8, -11 + width - 1, true);
  header.view.setInt32(windowOffset + 12, 23 + height - 1, true);
  const native = samples(), values = Float32Array.from({ length: width * height }, (_, index) => native[index % native.length]!);
  const chunks: { bytes: Uint8Array; rows: number; rawBytes: number }[] = [];
  for (let block = 0; block < count; block++) {
    const rows = Math.min(lines, height - block * lines);
    const raw = new Uint8Array(width * rows * 4), rawView = viewOf(raw);
    for (let pixel = 0; pixel < width * rows; pixel++) rawView.setFloat32(pixel * 4, values[block * lines * width + pixel]!, true);
    const shuffled = new Uint8Array(raw.length), half = raw.length / 2;
    for (let byte = 0; byte < raw.length; byte++) shuffled[byte % 2 === 0 ? byte / 2 : half + Math.floor(byte / 2)] = raw[byte]!;
    let previous = shuffled[0]!;
    for (let byte = 1; byte < shuffled.length; byte++) {
      const current = shuffled[byte]!; shuffled[byte] = (current - previous + 128) & 255; previous = current;
    }
    let predicted = shuffled;
    if (options.decodedExtra !== undefined && block === 0) {
      predicted = new Uint8Array(shuffled.length + options.decodedExtra);
      predicted.set(shuffled.subarray(0, predicted.length));
    }
    const packed = options.raw ? raw : new Uint8Array(deflateSync(predicted));
    expect(packed.length).toBeLessThanOrEqual(raw.length);
    const chunk = new Uint8Array(8 + packed.length), view = viewOf(chunk);
    view.setInt32(0, 23 + block * lines, true); view.setInt32(4, packed.length, true); chunk.set(packed, 8);
    chunks.push({ bytes: chunk, rows, rawBytes: raw.length });
  }
  const table = header.table, dataStart = table + count * 8;
  const bytes = new Uint8Array(dataStart + chunks.reduce((sum, chunk) => sum + chunk.bytes.length, 0)), view = viewOf(bytes);
  bytes.set(template.subarray(0, table));
  let offset = dataStart;
  // Reverse physical block order. The offset table still indexes increasing y.
  for (let block = count - 1; block >= 0; block--) {
    view.setBigUint64(table + block * 8, BigInt(offset), true);
    bytes.set(chunks[block]!.bytes, offset); offset += chunks[block]!.bytes.length;
  }
  return { bytes, values, width, height, chunks, table, dataStart };
}

describe("numerical FLOAT32 depth OpenEXR", () => {
  it.each([2, 3] as const)("imports lossless ZIP profile %i with exact Float32 bits, shifted origin and reversed blocks", async compression => {
    const fixture = zipFixture(compression), { bytes, values, width, height } = fixture;
    const map = await decodeNumericalExr(bytes);
    expect([map.width, map.height]).toEqual([width, height]);
    expect(bits(map.values)).toEqual(bits(values));
    expect(map.metadata).toBeUndefined();
    expect(fixture.chunks.every(chunk => chunk.bytes.length - 8 < chunk.rawBytes)).toBe(true);
    if (compression === 3) expect(fixture.chunks.map(chunk => chunk.rows)).toEqual([16, 3]);
    else expect(fixture.chunks).toHaveLength(19);
    expect(() => decodeDepthExr(bytes)).toThrow(/compression/);
  });

  it.each([2, 3] as const)("reads profile %i raw blocks when ZIP cannot reduce their size, without predictor conversion", async compression => {
    const fixture = zipFixture(compression, { raw: true });
    const map = await decodeNumericalExr(fixture.bytes);
    expect(bits(map.values)).toEqual(bits(fixture.values));
    expect(fixture.chunks.every(chunk => chunk.bytes.length - 8 === chunk.rawBytes)).toBe(true);
  });

  it("uses the same strict canonical header and metadata reader through the async import API", async () => {
    const source: FloatMap = { width: 3, height: 2, values: samples(), metadata: { note: "Canonical numerical pixels" } };
    const file = encodeDepthExr(source), decoded = await decodeNumericalExr(file);
    expect(decoded).toEqual(decodeDepthExr(file));
    expect(bits(decoded.values)).toEqual(bits(source.values));
    expect(decoded.metadata).toEqual(source.metadata);
  });

  it("rejects corrupt ZIP blocks, wrong decompressed counts and decompression beyond the declared dimensions", async () => {
    const corrupt = zipFixture(3), view = viewOf(corrupt.bytes);
    const offset = Number(view.getBigUint64(corrupt.table, true));
    corrupt.bytes[offset + 8] = 0;
    await expect(decodeNumericalExr(corrupt.bytes)).rejects.toThrow(/ZIP decompression failed/);
    await expect(decodeNumericalExr(zipFixture(3, { decodedExtra: -1 }).bytes)).rejects.toThrow(/decompressed byte count/);
    await expect(decodeNumericalExr(zipFixture(3, { decodedExtra: 128 }).bytes)).rejects.toThrow(/decompression.*exceeds.*dimensions/);
  });

  it("validates compression block counts, safe offsets, block y and packed size before inflating", async () => {
    const mutate = async (change: (fixture: ReturnType<typeof zipFixture>, view: DataView) => void, error: RegExp) => {
      const fixture = zipFixture(3), view = viewOf(fixture.bytes);
      change(fixture, view);
      await expect(decodeNumericalExr(fixture.bytes)).rejects.toThrow(error);
    };
    await expect(decodeNumericalExr(zipFixture(3, { chunkCount: 19 }).bytes)).rejects.toThrow(/chunk count/);
    await mutate((fixture, view) => view.setBigUint64(fixture.table, 2n ** 63n, true), /safe integer/);
    await mutate((fixture, view) => view.setBigUint64(fixture.table, 8n, true), /offset.*bounds/);
    await mutate((fixture, view) => view.setInt32(Number(view.getBigUint64(fixture.table, true)), 24, true), /scanline y/);
    await mutate((fixture, view) => view.setInt32(Number(view.getBigUint64(fixture.table, true)) + 4, fixture.chunks[0]!.rawBytes + 1, true), /data size/);
    await mutate((fixture, view) => view.setBigUint64(fixture.table, view.getBigUint64(fixture.table + 8, true), true), /scanline y/);
    const truncated = zipFixture(3).bytes;
    await expect(decodeNumericalExr(truncated.subarray(0, truncated.length - 1))).rejects.toThrow(/truncated/);
    const trailing = new Uint8Array(truncated.length + 1); trailing.set(truncated);
    await expect(decodeNumericalExr(trailing)).rejects.toThrow(/payload length/);
  });

  it("keeps unsupported channels and profiles explicit in compressed import instead of guessing or widening precision", async () => {
    await expect(decodeNumericalExr(externalFixture({ compression: 2, type: 1 }))).rejects.toThrow(/FLOAT32.*HALF/);
    await expect(decodeNumericalExr(externalFixture({ compression: 3, multipleChannels: true }))).rejects.toThrow(/multiple channels/);
    await expect(decodeNumericalExr(externalFixture({ compression: 4 }))).rejects.toThrow(/compression 4/);
  });

  it("writes standard attributes, increasing-y offsets, exact raw FLOAT bits and the shared metadata envelope", () => {
    const values = samples();
    const map: FloatMap = { width: 3, height: 2, values, metadata: { description: "façade", settings: { seed: 2025 } } };
    const bytes = encodeDepthExr(map), before = bits(values).slice();
    const { view, attributes, table } = inspect(bytes);
    expect(view.getUint32(0, true)).toBe(20_000_630);
    expect(view.getUint32(4, true)).toBe(2);
    const attribute = (name: string, type: string, size?: number) => {
      const value = attributes.get(name)!;
      expect(value.type).toBe(type);
      if (size !== undefined) expect(value.size).toBe(size);
      return bytes.subarray(value.position, value.position + value.size);
    };
    const channels = attribute("channels", "chlist", 19);
    expect([...channels.subarray(0, 2)]).toEqual([89, 0]);
    const channelView = viewOf(channels);
    expect(channelView.getInt32(2, true)).toBe(2);
    expect([...channels.subarray(6, 10)]).toEqual([0, 0, 0, 0]);
    expect(channelView.getInt32(10, true)).toBe(1);
    expect(channelView.getInt32(14, true)).toBe(1);
    expect(channels[18]).toBe(0);
    expect([...attribute("compression", "compression", 1)]).toEqual([0]);
    expect([...attribute("lineOrder", "lineOrder", 1)]).toEqual([0]);
    expect(attribute("dataWindow", "box2i", 16)).toEqual(bytesOf([0, 0, 2, 1]));
    expect(attribute("displayWindow", "box2i", 16)).toEqual(bytesOf([0, 0, 2, 1]));
    expect(attribute("pixelAspectRatio", "float", 4)).toEqual(bytesOf([1], "float"));
    expect(attribute("screenWindowCenter", "v2f", 8)).toEqual(bytesOf([0, 0], "float"));
    expect(attribute("screenWindowWidth", "float", 4)).toEqual(bytesOf([1], "float"));
    const envelope = JSON.parse(new TextDecoder().decode(attribute("loomDepth", "string")));
    expect(envelope).toMatchObject({ version: 1, encoding: "float32", low: -8.5, inverse: false, metadata: map.metadata });
    for (let row = 0; row < 2; row++) {
      const offset = Number(view.getBigUint64(table + row * 8, true));
      expect(offset).toBe(table + 16 + row * 20);
      expect(view.getInt32(offset, true)).toBe(row);
      expect(view.getInt32(offset + 4, true)).toBe(12);
      for (let x = 0; x < 3; x++) expect(view.getUint32(offset + 8 + x * 4, true)).toBe(before[row * 3 + x]);
    }
    const restored = decodeDepthExr(bytes);
    expect(bits(restored.values)).toEqual(before);
    expect(restored.metadata).toEqual(map.metadata);
    expect(encodeDepthExr(restored)).toEqual(bytes);
    expect(bits(values)).toEqual(before);
  });

  it.each(["Y", "Z", "Depth"])("reads an untagged %s channel with nonzero origins and physically reversed chunks", channel => {
    const bytes = externalFixture({ channel });
    const padded = new Uint8Array(bytes.length + 13);
    padded.set(bytes, 7);
    const restored = decodeDepthExr(padded.subarray(7, 7 + bytes.length));
    expect([restored.width, restored.height]).toEqual([3, 2]);
    expect(bits(restored.values)).toEqual(bits(samples()));
    expect(restored.metadata).toBeUndefined();
    expect(Object.is(restored.values[1], -0)).toBe(true);
  });

  it("retains prepared depth provenance without changing native values or their convention", () => {
    const native = withDepthRecipe(makePreparedMap(samples(), 3, 2, { kind: "depth",
      source: { sha256: "a".repeat(64), width: 3, height: 2 },
      model: { id: DEFAULT_PHOTO_DEPTH_RECIPE.modelId, url: "https://models.example/pinned/depth.onnx" },
      inputSide: 518, registration: "stretch" }), DEFAULT_PHOTO_DEPTH_RECIPE);
    const restored = decodeDepthExr(encodeDepthExr(native));
    expect(bits(restored.values)).toEqual(bits(native.values));
    expect(preparedMetadata(restored)).toEqual(preparedMetadata(native));
  });

  it.each([
    [{ flags: 0x1000 }, /multipart/], [{ flags: 0x800 }, /deep/], [{ flags: 0x200 }, /tiled/],
    [{ flags: 0x100 }, /unknown file flags/], [{ compression: 3 }, /compression 3.*uncompressed/],
    [{ type: 1 }, /FLOAT32.*HALF/], [{ type: 0 }, /FLOAT32.*UINT/], [{ channel: "R" }, /channel R/],
  ] as const)("refuses unsupported storage without channel selection or colour conversion: %j", (options, error) => {
    expect(() => decodeDepthExr(externalFixture(options))).toThrow(error);
  });

  it("rejects duplicate attributes, multiple channels and subsampling explicitly", () => {
    expect(() => decodeDepthExr(externalFixture({ duplicate: true }))).toThrow(/duplicate lineOrder/);
    const multiple = externalFixture({ multipleChannels: true });
    expect(() => decodeDepthExr(multiple)).toThrow(/multiple channels/);
    const subsampled = externalFixture(), header = inspect(subsampled);
    header.view.setInt32(header.attributes.get("channels")!.position + 10, 2, true);
    expect(() => decodeDepthExr(subsampled)).toThrow(/subsampled/);
  });

  it("bounds dimensions and every scanline offset, y coordinate and payload size", () => {
    const mutate = (change: (bytes: Uint8Array, header: ReturnType<typeof inspect>) => void, error: RegExp) => {
      const bytes = externalFixture(), header = inspect(bytes);
      change(bytes, header);
      expect(() => decodeDepthExr(bytes)).toThrow(error);
    };
    mutate((_, header) => header.view.setInt32(header.attributes.get("dataWindow")!.position + 8, 64_000_000, true), /64 million/);
    mutate((_, header) => header.view.setBigUint64(header.table, 2n ** 63n, true), /safe integer/);
    mutate((_, header) => header.view.setBigUint64(header.table, 8n, true), /offset.*bounds/);
    mutate((_, header) => header.view.setBigUint64(header.table, BigInt(header.table + 17), true), /offset.*bounds/);
    mutate((_, header) => header.view.setBigUint64(header.table, header.view.getBigUint64(header.table + 8, true), true), /scanline y/);
    mutate((_, header) => header.view.setInt32(Number(header.view.getBigUint64(header.table, true)), 22, true), /scanline y/);
    mutate((_, header) => header.view.setInt32(Number(header.view.getBigUint64(header.table, true)) + 4, 8, true), /data size/);
    mutate((_, header) => header.view.setFloat32(Number(header.view.getBigUint64(header.table, true)) + 8, NaN, true), /samples must be finite/);
    mutate((_, header) => header.view.setInt32(header.attributes.get("compression")!.sizePosition, -1, true), /attribute payload/);
  });

  it("rejects corrupt signatures, truncated headers/tables/rows and malformed metadata", () => {
    const bytes = externalFixture(), header = inspect(bytes);
    for (const length of [0, 7, 20, header.table - 1, header.table + 7, bytes.length - 1]) {
      expect(() => decodeDepthExr(bytes.subarray(0, length))).toThrow(/Invalid depth EXR/);
    }
    const corrupt = bytes.slice(); corrupt[0] = 0;
    expect(() => decodeDepthExr(corrupt)).toThrow(/signature/);
    const tagged = encodeDepthExr({ width: 3, height: 2, values: samples() });
    const metadataOffset = inspect(tagged).attributes.get("loomDepth")!.position;
    tagged[metadataOffset] = 0xff;
    expect(() => decodeDepthExr(tagged)).toThrow(/not valid UTF-8/);
    expect(() => encodeDepthExr({ width: 3, height: 2, values: new Float32Array(6).fill(Infinity) })).toThrow(/samples must be finite/);
  });
});
