import { describe, expect, it } from "vitest";

import { bytesReader, readUstar, scanUstar, writeUstar, type RangeReader } from "./tar.ts";

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

describe("VN100 ustar reader", () => {
  it("reads back every file, a long (pax) name and a non-ASCII one included", async () => {
    const long = `media/audio/${"x".repeat(120)} (POPSTAR TOUR 2026 SHOW_REFS) v1.3.wav`;
    const archive = writeUstar([
      { name: "manifest.json", bytes: text('{"format":"ltcshow"}') },
      { name: long, bytes: new Uint8Array([1, 2, 3, 4, 5]) },
      { name: "media/audio/I'D RATHER — BE ALONE.wav", bytes: new Uint8Array(1025).fill(7) },
    ]);
    const read = await readUstar(archive);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.entries.map((entry) => entry.name)).toEqual(["manifest.json", long, "media/audio/I'D RATHER — BE ALONE.wav"]);
    expect(decode(read.entries[0]!.bytes)).toBe('{"format":"ltcshow"}');
    expect([...read.entries[1]!.bytes]).toEqual([1, 2, 3, 4, 5]);
    expect(read.entries[2]!.bytes.length).toBe(1025);
    expect(read.entries[2]!.bytes.every((byte) => byte === 7)).toBe(true);
  });

  it("reads only the files asked for: a skipped file's data is never touched", async () => {
    const stem = new Uint8Array(4096).fill(9);
    const archive = writeUstar([
      { name: "project.json", bytes: text("{}") },
      { name: "stems/t1/drums.wav", bytes: stem },
      { name: "media/audio/a.wav", bytes: text("RIFF") },
    ]);
    const touched: Array<[number, number]> = [];
    const inner = bytesReader(archive);
    const reader: RangeReader = {
      size: () => inner.size(),
      read: (offset, length) => {
        touched.push([offset, length]);
        return inner.read(offset, length);
      },
    };
    const scan = await scanUstar(reader, (name) => !name.startsWith("stems/"));
    expect(scan.ok).toBe(true);
    if (!scan.ok) return;
    expect(scan.entries.map((entry) => entry.name)).toEqual(["project.json", "media/audio/a.wav"]);
    expect(scan.listing.map((entry) => [entry.name, entry.size])).toEqual([
      ["project.json", 2],
      ["stems/t1/drums.wav", 4096],
      ["media/audio/a.wav", 4],
    ]);
    // Only 512-byte headers and the two small files: no read reaches the stem's size.
    expect(touched.every(([, length]) => length <= 512)).toBe(true);
    expect(touched.some(([, length]) => length === 4096)).toBe(false);
  });

  it("refuses bytes that are not a tar, naming the failed checksum", async () => {
    const junk = new Uint8Array(1024).fill(65);
    const read = await readUstar(junk);
    expect(read).toEqual({ ok: false, reason: "not a tar archive: the header at byte 0 fails its checksum" });
  });

  it("refuses a truncated archive by the entry that runs past the end", async () => {
    const archive = writeUstar([{ name: "project.json", bytes: new Uint8Array(2000) }]);
    const read = await readUstar(archive.subarray(0, 1024));
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toContain('"project.json" runs past the end');
  });
});
