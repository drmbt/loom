import { expect, it } from "vitest";
import type { ColorSpace } from "../../domain/types/ports.ts";
import { decodeToLinear, encodePlaneToRgba8, toRgba8At, transferForSpace, type TransferMode } from "./image.ts";

it.each([
  ["encoded", undefined], ["linear", undefined], ["data", undefined],
  ["encoded", "raw"], ["encoded", "srgb"], ["linear", "raw"],
] as const)("same-size half-float conversion matches the full plane for every bit pattern (%s, %s)", (space, transfer) => {
  const width = 256, height = 256, rowStride = width * 8 + 16;
  // Exercise row padding and a nonzero, unaligned byte offset as well as every possible
  // half-float in each channel: negatives, subnormals, infinities and all NaN payloads.
  const backing = new Uint8Array(rowStride * height + 3);
  const bytes = backing.subarray(3);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const bits = y * width + x, offset = y * rowStride + x * 8;
    for (let channel = 0; channel < 4; channel++) view.setUint16(offset + channel * 2, (bits + channel * 7777) % 65536, true);
  }
  const image = { width, height, rowStride, bytes, format: "rgba16float" as const };
  const options: {space: ColorSpace; transfer?: TransferMode} = {space};
  if (transfer !== undefined) options.transfer = transfer;
  const expected = encodePlaneToRgba8(decodeToLinear(image, space), transfer ?? transferForSpace(space));
  const actual = toRgba8At(image, width, height, options);
  expect(Buffer.compare(Buffer.from(actual.data), Buffer.from(expected.data))).toBe(0);
});
