import type { AssetReference } from "@domain/types/graph.ts";
import { createFileReference, parseFileReference } from "@domain/media/file-reference.ts";

export interface RetainedFileHandle {
  readonly name: string;
  getFile(): Promise<File>;
  queryPermission(options: { mode: "read" }): Promise<PermissionState>;
  requestPermission(options: { mode: "read" }): Promise<PermissionState>;
}

export type RetainedFileSnapshot =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "permission" | "missing" | "error"; readonly message: string };

export interface RetainedFileHandleStore {
  get(id: string): Promise<RetainedFileHandle | undefined>;
  put(id: string, handle: RetainedFileHandle): Promise<void>;
}

export interface RetainedFiles {
  remember(handle: RetainedFileHandle, kind: AssetReference["kind"], existingReference?: string): Promise<string>;
  acquire(reference: string): { release(): void };
  snapshot(reference: string): RetainedFileSnapshot;
  subscribe(listener: () => void): () => void;
  revision(): number;
  /** Call only from a user gesture. Never asks for permission during acquisition. */
  allow(reference: string): Promise<void>;
}

export interface RetainedFilesEnvironment {
  readonly handlesStore: RetainedFileHandleStore;
  readonly createId: () => string;
  readonly createObjectURL: (file: File) => string;
  readonly revokeObjectURL: (url: string) => void;
}

const PENDING: RetainedFileSnapshot = Object.freeze({ kind: "pending" });
const READ = { mode: "read" } as const;

interface Entry {
  readonly asset: AssetReference & { source: { kind: "fileHandle"; handleId: string } };
  handle: RetainedFileHandle | undefined;
  snapshot: RetainedFileSnapshot;
  leases: number;
  generation: number;
  resolving: boolean;
  allowing: Promise<void> | undefined;
  readonly retiredUrls: Set<string>;
}

function fileAsset(reference: string): AssetReference & { source: { kind: "fileHandle"; handleId: string } } {
  const asset = parseFileReference(reference);
  if (asset === null || asset.source.kind !== "fileHandle") {
    throw new Error(`Invalid retained file reference: ${reference}`);
  }
  return asset as AssetReference & { source: { kind: "fileHandle"; handleId: string } };
}

function failure(asset: AssetReference, error: unknown): RetainedFileSnapshot {
  const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined;
  const detail = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message : String(error);
  if (name === "NotFoundError") return { kind: "missing", message: `The file "${asset.name}" is missing. Choose it again to relink it.` };
  if (name === "NotAllowedError" || name === "SecurityError") {
    return { kind: "permission", message: `Read access to "${asset.name}" is required. Allow access to reopen it.` };
  }
  return { kind: "error", message: `The retained file "${asset.name}" could not be opened: ${detail}` };
}

export function createRetainedFiles(environment: RetainedFilesEnvironment): RetainedFiles {
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  let revision = 0;
  const entryOf = (reference: string): Entry => {
    let entry = entries.get(reference);
    if (entry === undefined) {
      entry = { asset: fileAsset(reference), handle: undefined, snapshot: PENDING, leases: 0, generation: 0, resolving: false, allowing: undefined, retiredUrls: new Set() };
      entries.set(reference, entry);
    }
    return entry;
  };
  const publish = (entry: Entry, snapshot: RetainedFileSnapshot) => {
    if (entry.snapshot === snapshot) return;
    entry.snapshot = snapshot;
    revision++;
    for (const listener of [...listeners]) listener();
  };
  const active = (entry: Entry, generation: number) => entry.leases > 0 && entry.generation === generation;
  const decode = async (entry: Entry, generation: number, handle: RetainedFileHandle) => {
    const file = await handle.getFile();
    if (!active(entry, generation)) return;
    const url = `${environment.createObjectURL(file)}#${encodeURIComponent(file.name)}`;
    publish(entry, { kind: "ready", url });
  };
  const resolve = async (entry: Entry, generation: number) => {
    try {
      const handle = entry.handle ?? await environment.handlesStore.get(entry.asset.source.handleId);
      if (!active(entry, generation)) return;
      if (handle === undefined) {
        publish(entry, { kind: "missing", message: `No retained file handle exists for "${entry.asset.name}" in this browser. Choose it again to relink it.` });
        return;
      }
      entry.handle = handle;
      const permission = await handle.queryPermission(READ);
      if (!active(entry, generation)) return;
      if (permission !== "granted") {
        publish(entry, { kind: "permission", message: `Read access to "${entry.asset.name}" is required. Allow access to reopen it.` });
        return;
      }
      await decode(entry, generation, handle);
    } catch (error) {
      if (active(entry, generation)) publish(entry, failure(entry.asset, error));
    } finally {
      if (entry.generation === generation) entry.resolving = false;
    }
  };

  return {
    async remember(handle, kind, existingReference) {
      const id = existingReference === undefined ? environment.createId() : fileAsset(existingReference).source.handleId;
      const reference = createFileReference(id, kind, handle.name);
      await environment.handlesStore.put(id, handle);
      entryOf(reference).handle = handle;
      if (existingReference !== undefined) {
        for (const entry of [...entries.values()]) {
          if (entry.asset.source.handleId !== id) continue;
          // Existing decoders may still consume the old URL until their leases release.
          if (entry.snapshot.kind === "ready") entry.retiredUrls.add(entry.snapshot.url.split("#")[0] as string);
          entry.handle = handle;
          entry.generation++;
          entry.allowing = undefined;
          entry.resolving = entry.leases > 0;
          publish(entry, PENDING);
          if (entry.leases > 0) void resolve(entry, entry.generation);
        }
      }
      return reference;
    },
    acquire(reference) {
      const entry = entryOf(reference);
      entry.leases++;
      if (entry.leases === 1 && entry.snapshot === PENDING && !entry.resolving && entry.allowing === undefined) {
        entry.resolving = true;
        void resolve(entry, ++entry.generation);
      }
      let released = false;
      return { release() {
        if (released) return;
        released = true;
        entry.leases--;
        if (entry.leases !== 0) return;
        queueMicrotask(() => {
          if (entry.leases !== 0) return;
          entry.generation++;
          entry.resolving = false;
          entry.allowing = undefined;
          if (entry.snapshot.kind === "ready") environment.revokeObjectURL(entry.snapshot.url.split("#")[0] as string);
          for (const url of entry.retiredUrls) environment.revokeObjectURL(url);
          entry.retiredUrls.clear();
          publish(entry, PENDING);
        });
      } };
    },
    snapshot(reference) { return entryOf(reference).snapshot; },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    revision() { return revision; },
    allow(reference) {
      const entry = entryOf(reference);
      if (entry.allowing !== undefined) return entry.allowing;
      if (entry.snapshot.kind === "ready") return Promise.resolve();
      if (entry.handle === undefined || entry.leases === 0) {
        return Promise.reject(new Error(`The retained file "${entry.asset.name}" must be acquired before allowing access.`));
      }
      const handle = entry.handle;
      const generation = ++entry.generation;
      let requested: Promise<PermissionState>;
      // This call precedes every await and notification, preserving user activation.
      try { requested = handle.requestPermission(READ); }
      catch (error) { publish(entry, failure(entry.asset, error)); return Promise.resolve(); }
      const allowing: Promise<void> = (async () => {
        try {
          const permission = await requested;
          if (!active(entry, generation)) return;
          if (permission !== "granted") {
            publish(entry, { kind: "permission", message: `Read access to "${entry.asset.name}" was not granted. Allow access to reopen it.` });
            return;
          }
          await decode(entry, generation, handle);
        } catch (error) {
          if (active(entry, generation)) publish(entry, failure(entry.asset, error));
        } finally {
          if (entry.generation === generation) entry.allowing = undefined;
        }
      })();
      entry.allowing = allowing;
      publish(entry, PENDING);
      return allowing;
    },
  };
}

/** Handles are browser-local capabilities. Only their opaque IDs enter project files. */
export function createIndexedDbFileHandleStore(): RetainedFileHandleStore {
  const open = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is unavailable; file references cannot be retained.")); return; }
    let blocked = false;
    // A new storage address after the Loom rename (§T899), so it carries the new name.
    const request = indexedDB.open("loom.retained-files", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("handles");
    request.onsuccess = () => { if (blocked) request.result.close(); else resolve(request.result); };
    request.onerror = () => reject(request.error ?? new Error("Retained file storage could not be opened."));
    request.onblocked = () => { blocked = true; reject(new Error("Retained file storage is blocked by another browser session.")); };
  });
  const run = async <T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const database = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const transaction = database.transaction("handles", mode);
        const request = operation(transaction.objectStore("handles"));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onabort = () => reject(transaction.error ?? new Error("Retained file storage transaction aborted."));
        transaction.onerror = () => reject(transaction.error ?? new Error("Retained file storage transaction failed."));
      });
    } finally { database.close(); }
  };
  return {
    get: (id) => run("readonly", (store) => store.get(id) as IDBRequest<RetainedFileHandle | undefined>),
    async put(id, handle) { await run("readwrite", (store) => store.put(handle, id)); },
  };
}

let browserFiles: RetainedFiles | undefined;
export function retainedFiles(): RetainedFiles {
  browserFiles ??= createRetainedFiles({
    handlesStore: createIndexedDbFileHandleStore(),
    createId: () => crypto.randomUUID(),
    createObjectURL: (file) => URL.createObjectURL(file),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
  });
  return browserFiles;
}
