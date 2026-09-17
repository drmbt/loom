import type { Mp4StreamParts } from "./mp4-muxer.ts";

interface WritableFileStream {
  write(data: Blob | BufferSource): Promise<void>;
  seek(position: number): Promise<void>;
  close(): Promise<void>;
  abort?: (reason?: unknown) => Promise<void>;
}

interface SpoolFileHandle {
  createWritable(): Promise<WritableFileStream>;
  getFile(): Promise<File>;
}

interface SpoolDirectory {
  getFileHandle(name: string, options: { create: true }): Promise<SpoolFileHandle>;
  removeEntry(name: string): Promise<void>;
}

export interface MediaSpoolResult {
  readonly file: Blob;
  dispose(): Promise<void>;
}

export interface MediaSpool {
  write(bytes: Uint8Array): Promise<void>;
  finish(parts: Mp4StreamParts): Promise<MediaSpoolResult>;
  abort(reason?: unknown): Promise<void>;
}

export type MediaSpoolMode = "opfs" | "memory";

function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

/**
 * Encoded packets land on disk as they arrive. `memory` is an explicit test seam only;
 * production never silently falls back to retaining a long take in the JavaScript heap.
 */
export async function createMediaSpool(mode: MediaSpoolMode, ftyp: Uint8Array): Promise<MediaSpool> {
  if (mode === "memory") return memorySpool();
  const storage = (globalThis as typeof globalThis & {
    navigator?: Navigator & { storage?: { getDirectory?: () => Promise<SpoolDirectory> } };
  }).navigator?.storage;
  if (typeof storage?.getDirectory !== "function") {
    throw new Error("Origin-private file storage is unavailable; bounded video export requires OPFS.");
  }

  const directory = await storage.getDirectory();
  if (typeof globalThis.crypto?.randomUUID !== "function") {
    throw new Error("Secure temporary-file naming is unavailable; bounded video export cannot start.");
  }
  const token = globalThis.crypto.randomUUID();
  const finalName = `.loom-render-${token}.mp4`;
  const remove = async (name: string): Promise<void> => {
    try {
      await directory.removeEntry(name);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "NotFoundError") throw error;
    }
  };
  const finalHandle = await directory.getFileHandle(finalName, { create: true });
  let mediaWriter: WritableFileStream | undefined;
  const cleanupErrors = async (reason: unknown, abortWriter: boolean): Promise<unknown[]> => {
    const errors: unknown[] = [];
    if (abortWriter && mediaWriter !== undefined) {
      try {
        await mediaWriter.abort?.(reason);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await remove(finalName);
    } catch (error) {
      errors.push(error);
    }
    return errors;
  };
  try {
    mediaWriter = await finalHandle.createWritable();
    await mediaWriter.write(owned(ftyp));
    await mediaWriter.write(new Uint8Array(16));
  } catch (error) {
    const cleanup = await cleanupErrors(error, true);
    if (cleanup.length > 0) {
      throw new AggregateError(
        [error, ...cleanup],
        "Video spool setup failed and its temporary storage could not be fully removed.",
        { cause: error },
      );
    }
    throw error;
  }
  const writer = mediaWriter;
  let writerOpen = true;

  return {
    write(bytes) {
      if (!writerOpen) throw new Error("The media spool is closed.");
      return writer.write(owned(bytes));
    },
    async finish(parts) {
      if (!writerOpen) throw new Error("The media spool is closed.");
      try {
        await writer.write(owned(parts.moov));
        await writer.seek(parts.ftyp.length);
        await writer.write(owned(parts.mdatHeader));
        await writer.close();
        writerOpen = false;
      } catch (error) {
        writerOpen = false;
        const cleanup = await cleanupErrors(error, true);
        if (cleanup.length > 0) {
          throw new AggregateError(
            [error, ...cleanup],
            "MP4 finalization failed and its temporary storage could not be fully removed.",
            { cause: error },
          );
        }
        throw error;
      }
      const file = await finalHandle.getFile();
      return {
        file,
        dispose: () => remove(finalName),
      };
    },
    async abort(reason) {
      const shouldAbortWriter = writerOpen;
      if (writerOpen) {
        writerOpen = false;
      }
      const cleanup = await cleanupErrors(reason, shouldAbortWriter);
      if (cleanup.length > 0) {
        throw new AggregateError(
          cleanup,
          "The cancelled video export's temporary storage could not be fully removed.",
          { cause: cleanup.at(-1) },
        );
      }
    },
  };
}

function memorySpool(): MediaSpool {
  const packets: Uint8Array[] = [];
  let open = true;
  return {
    write(bytes) {
      if (!open) throw new Error("The media spool is closed.");
      packets.push(bytes);
      return Promise.resolve();
    },
    finish(parts) {
      if (!open) throw new Error("The media spool is closed.");
      open = false;
      return Promise.resolve({
        file: new Blob(
          [owned(parts.ftyp), owned(parts.mdatHeader), ...packets.map(owned), owned(parts.moov)],
          { type: "video/mp4" },
        ),
        dispose: () => Promise.resolve(),
      });
    },
    abort() {
      open = false;
      packets.length = 0;
      return Promise.resolve();
    },
  };
}
