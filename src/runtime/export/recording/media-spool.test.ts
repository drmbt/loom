import { afterEach, describe, expect, it, vi } from "vitest";

import { createMediaSpool } from "./media-spool.ts";

afterEach(() => vi.unstubAllGlobals());

class FakeDirectory {
  readonly files = new Map<string, Uint8Array>();
  writeFailureAt: number | null = null;
  removeFailure: Error | null = null;
  abortFailure: Error | null = null;
  aborts = 0;
  removals = 0;

  async getFileHandle(name: string): Promise<{
    createWritable(): Promise<{
      write(data: Blob | BufferSource): Promise<void>;
      seek(position: number): Promise<void>;
      close(): Promise<void>;
      abort(): Promise<void>;
    }>;
    getFile(): Promise<File>;
  }> {
    if (!this.files.has(name)) this.files.set(name, new Uint8Array(0));
    return {
      createWritable: async () => {
        let position = 0;
        let writes = 0;
        return {
          write: async (data) => {
            writes += 1;
            if (writes === this.writeFailureAt) throw new Error("quota exhausted");
            const bytes = data instanceof Blob
              ? new Uint8Array(await data.arrayBuffer())
              : ArrayBuffer.isView(data)
                ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
                : new Uint8Array(data);
            const before = this.files.get(name) ?? new Uint8Array(0);
            const next = new Uint8Array(Math.max(before.length, position + bytes.length));
            next.set(before);
            next.set(bytes, position);
            position += bytes.length;
            this.files.set(name, next);
          },
          seek: async (next) => { position = next; },
          close: async () => undefined,
          abort: async () => {
            this.aborts += 1;
            if (this.abortFailure !== null) throw this.abortFailure;
          },
        };
      },
      getFile: async () => new Blob([new Uint8Array(this.files.get(name) ?? new Uint8Array(0))]) as File,
    };
  }

  async removeEntry(name: string): Promise<void> {
    this.removals += 1;
    if (this.removeFailure !== null) throw this.removeFailure;
    this.files.delete(name);
  }
}

function install(directory: FakeDirectory): void {
  vi.stubGlobal("navigator", { storage: { getDirectory: async () => directory } });
  vi.stubGlobal("crypto", { randomUUID: () => "test" });
}

describe("disk-backed media spool", () => {
  it("patches the mdat header in place and removes the OPFS file after disposal", async () => {
    const directory = new FakeDirectory();
    install(directory);
    const spool = await createMediaSpool("opfs", Uint8Array.of(1, 2));
    await spool.write(Uint8Array.of(3, 4, 5));
    const stored = await spool.finish({
      ftyp: Uint8Array.of(1, 2),
      mdatHeader: Uint8Array.from({ length: 16 }, (_, index) => 20 + index),
      moov: Uint8Array.of(6, 7),
    });

    expect(Array.from(new Uint8Array(await stored.file.arrayBuffer()))).toEqual([
      1, 2,
      ...Array.from({ length: 16 }, (_, index) => 20 + index),
      3, 4, 5,
      6, 7,
    ]);
    expect(directory.files.size).toBe(1);
    await stored.dispose();
    expect(directory.files.size).toBe(0);
  });

  it("removes an unfinished take on cancellation", async () => {
    const directory = new FakeDirectory();
    install(directory);
    const spool = await createMediaSpool("opfs", Uint8Array.of(1));
    await spool.write(Uint8Array.of(2, 3));
    await spool.abort(new Error("cancelled"));
    expect(directory.files.size).toBe(0);
  });

  it("refuses production spooling explicitly when OPFS is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    await expect(createMediaSpool("opfs", new Uint8Array(0))).rejects.toThrow(/OPFS/);
  });

  it("aborts the writer and removes its entry when initial header storage fails", async () => {
    const directory = new FakeDirectory();
    directory.writeFailureAt = 2;
    install(directory);
    await expect(createMediaSpool("opfs", Uint8Array.of(1))).rejects.toThrow("quota exhausted");
    expect(directory.aborts).toBe(1);
    expect(directory.files.size).toBe(0);
  });

  it("surfaces a cleanup failure instead of reporting disposal as successful", async () => {
    const directory = new FakeDirectory();
    install(directory);
    const spool = await createMediaSpool("opfs", Uint8Array.of(1));
    const stored = await spool.finish({
      ftyp: Uint8Array.of(1),
      mdatHeader: new Uint8Array(16),
      moov: Uint8Array.of(2),
    });
    directory.removeFailure = new Error("cleanup denied");
    await expect(stored.dispose()).rejects.toThrow("cleanup denied");
  });

  it("still removes the entry when aborting its writer fails", async () => {
    const directory = new FakeDirectory();
    directory.abortFailure = new Error("abort denied");
    install(directory);
    const spool = await createMediaSpool("opfs", Uint8Array.of(1));
    await expect(spool.abort(new Error("cancelled"))).rejects.toThrow(/temporary storage/);
    expect(directory.aborts).toBe(1);
    expect(directory.removals).toBe(1);
    expect(directory.files.size).toBe(0);
  });
});
