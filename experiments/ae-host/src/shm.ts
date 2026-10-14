// VN118: the shared-memory transport, isolated so it can switch (PROTOCOL.md v1 § Shared
// memory slots). POSIX shm_open/mmap through `loom-shm.node`, a 90-line N-API addon
// (native/loom_shm.c) shipped beside the executable. If the protocol ever moves to
// file-backed slots, only this module changes.
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";

interface ShmAddon {
  map(name: string, size: number, create?: boolean): ArrayBuffer;
  unlink(name: string): boolean;
}

let addon: ShmAddon | undefined;

/** Beside the executable (the SEA and the shipped layout), else LOOM_SHM_ADDON, else the dev build. */
function loadAddon(): ShmAddon {
  if (addon) return addon;
  const candidates = [
    process.env["LOOM_SHM_ADDON"],
    join(dirname(process.execPath), "loom-shm.node"),
    resolve(__dirnameOf(), "../.cache/build/loom-shm.node"),
    resolve(process.cwd(), "experiments/ae-host/.cache/build/loom-shm.node"),
  ].filter((p): p is string => typeof p === "string" && p !== "");
  const found = candidates.find((p) => existsSync(p));
  if (found === undefined) throw new Error(`loom-shm.node not found (looked in ${candidates.join(", ")})`);
  addon = createRequire(process.execPath)(found) as ShmAddon;
  return addon;
}

function __dirnameOf(): string {
  // ESM dev run: this file's directory. Bundled (CJS) the dev path is never the one found.
  try { return dirname(new URL(import.meta.url).pathname); } catch { return process.cwd(); }
}

/** The host's side: slots created by the effect, mapped on first use, remapped if they grew. */
export class SlotMap {
  private readonly slots = new Map<number, Uint8Array>();
  private readonly prefix: string;
  constructor(prefix: string) {
    this.prefix = prefix;
  }

  name(slot: number): string {
    return `${this.prefix}${slot}`;
  }

  /** A view of at least `bytes` bytes of slot `slot`. */
  view(slot: number, bytes: number): Uint8Array {
    if (!Number.isInteger(slot) || slot < 0) throw new Error(`bad slot ${slot}`);
    let mapped = this.slots.get(slot);
    if (mapped === undefined || mapped.byteLength < bytes) {
      // Not yet mapped, or the effect recreated it larger: map the current object.
      mapped = new Uint8Array(loadAddon().map(this.name(slot), bytes, false));
      this.slots.set(slot, mapped);
    }
    return mapped.subarray(0, bytes);
  }

  clear(): void {
    this.slots.clear();
  }
}

/** The effect's side (the test client): create and size a slot. */
export function createSlot(name: string, bytes: number): Uint8Array {
  return new Uint8Array(loadAddon().map(name, bytes, true)).subarray(0, bytes);
}

export function unlinkSlot(name: string): boolean {
  return loadAddon().unlink(name);
}
