import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileReference } from "@domain/media/file-reference.ts";
import {
  createIndexedDbFileHandleStore, createRetainedFiles,
  type RetainedFileHandle, type RetainedFilesEnvironment,
} from "./retained-files.ts";

const ID = "b73b4a69-b9ca-4f38-b7ee-2ab67029fd61";
const reference = createFileReference(ID, "video", "take 1.mp4");
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };

function fixture() {
  const handle: RetainedFileHandle = {
    name: "take 1.mp4",
    getFile: vi.fn(async () => new File(["movie"], "take 1.mp4", { type: "video/mp4" })),
    queryPermission: vi.fn(async () => "granted" as const),
    requestPermission: vi.fn(async () => "granted" as const),
  };
  const handles = new Map<string, RetainedFileHandle>();
  const environment: RetainedFilesEnvironment = {
    handlesStore: {
      get: vi.fn(async (id) => handles.get(id)),
      put: vi.fn(async (id, retained) => { handles.set(id, retained); }),
    },
    createId: () => ID,
    createObjectURL: vi.fn(() => "blob:temporary"),
    revokeObjectURL: vi.fn(),
  };
  const files = createRetainedFiles(environment);
  return { handle, handles, environment, files };
}

afterEach(() => vi.unstubAllGlobals());

describe("retained file capabilities and temporary URL ownership", () => {
  it("persists only a handle identity, then resolves fresh URLs after a new broker opens", async () => {
    const { handle, files, environment } = fixture();
    expect(await files.remember(handle, "video")).toBe(reference);
    expect(environment.handlesStore.put).toHaveBeenCalledWith(ID, handle);
    expect(handle.getFile).not.toHaveBeenCalled();
    const first = files.acquire(reference);
    await settle();
    expect(files.snapshot(reference)).toEqual({ kind: "ready", url: "blob:temporary#take%201.mp4" });
    first.release();
    await settle();
    expect(environment.revokeObjectURL).toHaveBeenCalledWith("blob:temporary");
    const reopened = createRetainedFiles({ ...environment, createObjectURL: () => "blob:after-reload" });
    const second = reopened.acquire(reference);
    await settle();
    expect(environment.handlesStore.get).toHaveBeenCalledWith(ID);
    expect(reopened.snapshot(reference)).toEqual({ kind: "ready", url: "blob:after-reload#take%201.mp4" });
    expect(handle.queryPermission).toHaveBeenCalledTimes(2);
    expect(handle.requestPermission).not.toHaveBeenCalled();
    second.release();
  });

  it("shares one lookup, file read, URL and stable snapshot between concurrent leases", async () => {
    const { handle, handles, files, environment } = fixture();
    handles.set(ID, handle);
    const change = vi.fn();
    const off = files.subscribe(change);
    const pending = files.snapshot(reference);
    expect(files.snapshot(reference)).toBe(pending);
    const first = files.acquire(reference);
    const second = files.acquire(reference);
    await settle();
    const ready = files.snapshot(reference);
    expect(files.snapshot(reference)).toBe(ready);
    expect(environment.handlesStore.get).toHaveBeenCalledTimes(1);
    expect(handle.getFile).toHaveBeenCalledTimes(1);
    expect(environment.createObjectURL).toHaveBeenCalledTimes(1);
    expect(change).toHaveBeenCalledTimes(1);
    expect(files.revision()).toBe(1);
    first.release(); first.release();
    await settle();
    expect(files.snapshot(reference)).toBe(ready);
    expect(environment.revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(environment.revokeObjectURL).not.toHaveBeenCalled();
    await settle();
    expect(files.snapshot(reference)).toBe(pending);
    expect(environment.revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(files.revision()).toBe(2);
    off();
    const third = files.acquire(reference);
    await settle();
    expect(change).toHaveBeenCalledTimes(2);
    third.release();
  });

  it("same-turn release/reacquire keeps the URL and pending acquisition", async () => {
    const { handle, handles, files, environment } = fixture();
    handles.set(ID, handle);
    const query = deferred<PermissionState>();
    vi.mocked(handle.queryPermission).mockReturnValue(query.promise);
    const first = files.acquire(reference);
    await settle();
    first.release();
    const second = files.acquire(reference);
    query.resolve("granted");
    await settle();
    expect(handle.queryPermission).toHaveBeenCalledTimes(1);
    expect(handle.getFile).toHaveBeenCalledTimes(1);
    const ready = files.snapshot(reference);
    second.release();
    const third = files.acquire(reference);
    await settle();
    expect(files.snapshot(reference)).toBe(ready);
    expect(environment.revokeObjectURL).not.toHaveBeenCalled();
    third.release();
  });

  it("queries permission without prompting or reading bytes, then prompts synchronously on Allow", async () => {
    const { handle, handles, files } = fixture();
    handles.set(ID, handle);
    vi.mocked(handle.queryPermission).mockResolvedValue("prompt");
    const lease = files.acquire(reference);
    await settle();
    expect(files.snapshot(reference)).toMatchObject({ kind: "permission", message: expect.stringContaining("take 1.mp4") });
    expect(handle.getFile).not.toHaveBeenCalled();
    expect(handle.requestPermission).not.toHaveBeenCalled();
    const request = deferred<PermissionState>();
    vi.mocked(handle.requestPermission).mockReturnValue(request.promise);
    const allowing = files.allow(reference);
    expect(handle.requestPermission).toHaveBeenCalledWith({ mode: "read" });
    expect(files.allow(reference)).toBe(allowing);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
    request.resolve("granted");
    await allowing;
    expect(files.snapshot(reference).kind).toBe("ready");
    expect(handle.getFile).toHaveBeenCalledTimes(1);
    await files.allow(reference);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it("reports denied access without reading or substituting a different file", async () => {
    const { handle, handles, files } = fixture();
    handles.set(ID, handle);
    vi.mocked(handle.queryPermission).mockResolvedValue("denied");
    vi.mocked(handle.requestPermission).mockResolvedValue("denied");
    const lease = files.acquire(reference);
    await settle();
    await files.allow(reference);
    expect(files.snapshot(reference)).toMatchObject({ kind: "permission", message: expect.stringContaining("not granted") });
    expect(handle.getFile).not.toHaveBeenCalled();
    lease.release();
  });

  it("reports missing persisted handles by file name", async () => {
    const { files, environment } = fixture();
    const lease = files.acquire(reference);
    await settle();
    expect(files.snapshot(reference)).toMatchObject({ kind: "missing", message: expect.stringContaining("take 1.mp4") });
    expect(environment.createObjectURL).not.toHaveBeenCalled();
    await expect(files.allow(reference)).rejects.toThrow("must be acquired");
    lease.release();
  });

  it.each([
    ["NotFoundError", "missing"], ["NotAllowedError", "permission"], ["NotReadableError", "error"],
  ])("classifies a native %s diagnostic without relying on instanceof Error", async (name, kind) => {
    const { handle, handles, files, environment } = fixture();
    handles.set(ID, handle);
    vi.mocked(handle.getFile).mockRejectedValue({ name, message: "native failure" });
    const lease = files.acquire(reference);
    await settle();
    expect(files.snapshot(reference)).toMatchObject({ kind, message: expect.stringContaining("take 1.mp4") });
    expect(environment.createObjectURL).not.toHaveBeenCalled();
    lease.release();
  });

  it("surfaces storage read failures, and refuses registration before a failed write completes", async () => {
    const { handle, files, environment } = fixture();
    vi.mocked(environment.handlesStore.put).mockRejectedValue(new Error("quota exceeded"));
    await expect(files.remember(handle, "video")).rejects.toThrow("quota exceeded");
    vi.mocked(environment.handlesStore.get).mockRejectedValue(new Error("database unavailable"));
    const lease = files.acquire(reference);
    await settle();
    expect(files.snapshot(reference)).toMatchObject({ kind: "error", message: expect.stringContaining("database unavailable") });
    expect(handle.getFile).not.toHaveBeenCalled();
    lease.release();
  });

  it("disowns a late file read, while a new acquisition alone publishes its own URL", async () => {
    const { handle, handles, files, environment } = fixture();
    handles.set(ID, handle);
    const oldFile = deferred<File>();
    vi.mocked(handle.getFile).mockReturnValueOnce(oldFile.promise);
    const first = files.acquire(reference);
    await settle();
    first.release();
    await settle();
    const second = files.acquire(reference);
    await settle();
    const ready = files.snapshot(reference);
    oldFile.resolve(new File(["old"], "old.mp4"));
    await settle();
    expect(files.snapshot(reference)).toBe(ready);
    expect(environment.createObjectURL).toHaveBeenCalledTimes(1);
    expect(handle.getFile).toHaveBeenCalledTimes(2);
    second.release();
  });

  it("disowns pending permission activation after the final lease releases", async () => {
    const { handle, handles, files, environment } = fixture();
    handles.set(ID, handle);
    vi.mocked(handle.queryPermission).mockResolvedValue("prompt");
    const request = deferred<PermissionState>();
    vi.mocked(handle.requestPermission).mockReturnValue(request.promise);
    const lease = files.acquire(reference);
    await settle();
    const allowing = files.allow(reference);
    lease.release();
    await settle();
    request.resolve("granted");
    await allowing;
    expect(files.snapshot(reference).kind).toBe("pending");
    expect(handle.getFile).not.toHaveBeenCalled();
    expect(environment.createObjectURL).not.toHaveBeenCalled();
  });

  it("never publishes the old stored handle after an acquisition is released", async () => {
    const { handle, files, environment } = fixture();
    const lookup = deferred<RetainedFileHandle | undefined>();
    vi.mocked(environment.handlesStore.get).mockReturnValue(lookup.promise);
    const lease = files.acquire(reference);
    lease.release();
    await settle();
    lookup.resolve(handle);
    await settle();
    expect(handle.queryPermission).not.toHaveBeenCalled();
    expect(files.snapshot(reference).kind).toBe("pending");
  });

  it("rejects invalid owned references instead of treating them as URLs", () => {
    const { files } = fixture();
    expect(() => files.acquire("loom-file:broken")).toThrow();
    expect(() => files.acquire("blob:legacy")).toThrow("Invalid retained file reference");
  });

  it("reports unavailable IndexedDB rather than keeping an in-memory-only reference", async () => {
    vi.stubGlobal("indexedDB", undefined);
    const { handle } = fixture();
    const store = createIndexedDbFileHandleStore();
    await expect(store.put(ID, handle)).rejects.toThrow("IndexedDB is unavailable");
    await expect(store.get(ID)).rejects.toThrow("IndexedDB is unavailable");
  });

  it("explicit relink preserves the handle ID and refreshes every active reference to that ID", async () => {
    const { files, environment, handle } = fixture();
    const alias = createFileReference(ID, "audio", "old alias.wav");
    const original = files.acquire(reference);
    const other = files.acquire(alias);
    await settle();
    expect(files.snapshot(reference).kind).toBe("missing");
    expect(files.snapshot(alias).kind).toBe("missing");
    const relinked = await files.remember({ ...handle, name: "replacement.mp4" }, "video", reference);
    expect(relinked).toBe(createFileReference(ID, "video", "replacement.mp4"));
    await settle();
    expect(environment.handlesStore.put).toHaveBeenCalledWith(ID, expect.objectContaining({ name: "replacement.mp4" }));
    expect(files.snapshot(reference).kind).toBe("ready");
    expect(files.snapshot(alias).kind).toBe("ready");
    expect(handle.getFile).toHaveBeenCalledTimes(2);
    expect(handle.requestPermission).not.toHaveBeenCalled();
    const replacement = files.acquire(relinked);
    await settle();
    expect(files.snapshot(relinked).kind).toBe("ready");
    original.release(); other.release(); replacement.release();
  });

  it("relink retains old decoder URLs until their leases release", async () => {
    const { files, environment, handle } = fixture();
    await files.remember(handle, "video");
    vi.mocked(environment.createObjectURL).mockReturnValueOnce("blob:old").mockReturnValueOnce("blob:new");
    const lease = files.acquire(reference);
    await settle();
    const replacement = { ...handle, getFile: vi.fn(async () => new File(["new"], "take 1.mp4")) };
    await files.remember(replacement, "video", reference);
    await settle();
    expect(files.snapshot(reference)).toEqual({ kind: "ready", url: "blob:new#take%201.mp4" });
    expect(environment.revokeObjectURL).not.toHaveBeenCalled();
    lease.release();
    await settle();
    expect(environment.revokeObjectURL).toHaveBeenCalledWith("blob:old");
    expect(environment.revokeObjectURL).toHaveBeenCalledWith("blob:new");
  });

  it("a relink disowns the previous handle's pending file read", async () => {
    const { files, environment, handle } = fixture();
    await files.remember(handle, "video");
    const pending = deferred<File>();
    vi.mocked(handle.getFile).mockReturnValueOnce(pending.promise);
    const lease = files.acquire(reference);
    await settle();
    const replacement = { ...handle, getFile: vi.fn(async () => new File(["replacement"], "take 1.mp4")) };
    await files.remember(replacement, "video", reference);
    await settle();
    const ready = files.snapshot(reference);
    pending.resolve(new File(["old"], "old.mp4"));
    await settle();
    expect(files.snapshot(reference)).toBe(ready);
    expect(environment.createObjectURL).toHaveBeenCalledTimes(1);
    lease.release();
  });

  it("relinking a stale video alias to an image uses the decoded filename for runtime classification", async () => {
    const { files, handle } = fixture();
    const lease = files.acquire(reference);
    await settle();
    const image = {
      ...handle,
      name: "new image.png",
      getFile: vi.fn(async () => new File(["image"], "new image.png", { type: "image/png" })),
    };
    const relinked = await files.remember(image, "image", reference);
    await settle();
    expect(relinked).toBe(createFileReference(ID, "image", "new image.png"));
    expect(files.snapshot(reference)).toEqual({ kind: "ready", url: "blob:temporary#new%20image.png" });
    lease.release();
  });

  it("uses a renamed File's current name even when the retained handle and reference keep old names", async () => {
    const { files, handles, handle } = fixture();
    handles.set(ID, handle);
    vi.mocked(handle.getFile).mockResolvedValue(new File(["image"], "renamed.png", { type: "image/png" }));
    const lease = files.acquire(reference);
    await settle();
    expect(handle.name).toBe("take 1.mp4");
    expect(files.snapshot(reference)).toEqual({ kind: "ready", url: "blob:temporary#renamed.png" });
    lease.release();
  });

  it("permission notifications cannot reentrantly create a second permission request", async () => {
    const { files, handles, handle } = fixture();
    handles.set(ID, handle);
    vi.mocked(handle.queryPermission).mockResolvedValue("prompt");
    const lease = files.acquire(reference);
    await settle();
    let nested: Promise<void> | undefined;
    const off = files.subscribe(() => {
      if (files.snapshot(reference).kind === "pending") nested = files.allow(reference);
    });
    const allowing = files.allow(reference);
    expect(nested).toBe(allowing);
    expect(handle.requestPermission).toHaveBeenCalledTimes(1);
    await allowing;
    off(); lease.release();
  });

  it("waits for IndexedDB transaction commit before considering a handle retained", async () => {
    const { handle } = fixture();
    const request = { result: undefined };
    const put = vi.fn(() => request);
    const transaction = {
      objectStore: () => ({ put }),
      oncomplete: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      error: null,
    };
    const database = { transaction: () => transaction, close: vi.fn() };
    const opening = { result: database, onsuccess: undefined as (() => void) | undefined };
    vi.stubGlobal("indexedDB", { open: () => opening });
    let committed = false;
    const storing = createIndexedDbFileHandleStore().put(ID, handle).then(() => { committed = true; });
    opening.onsuccess?.();
    await settle();
    expect(put).toHaveBeenCalledWith(handle, ID);
    expect(committed).toBe(false);
    transaction.oncomplete?.();
    await storing;
    expect(committed).toBe(true);
    expect(database.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a transaction that aborts after its write request succeeds", async () => {
    const { handle } = fixture();
    const transaction = {
      objectStore: () => ({ put: () => ({ result: ID }) }),
      oncomplete: undefined as (() => void) | undefined,
      onabort: undefined as (() => void) | undefined,
      onerror: undefined as (() => void) | undefined,
      error: new Error("disk write aborted"),
    };
    const database = { transaction: () => transaction, close: vi.fn() };
    const opening = { result: database, onsuccess: undefined as (() => void) | undefined };
    vi.stubGlobal("indexedDB", { open: () => opening });
    const storing = createIndexedDbFileHandleStore().put(ID, handle);
    const rejected = expect(storing).rejects.toThrow("disk write aborted");
    opening.onsuccess?.();
    await settle();
    transaction.onabort?.();
    await rejected;
    expect(database.close).toHaveBeenCalledTimes(1);
  });
});
