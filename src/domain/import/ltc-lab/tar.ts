/**
 * VN100 — A MINIMAL USTAR READER for ltc-lab's `.ltcshow.tar`.
 *
 * The writer is ltc-lab `server/package.mjs` (`tarStream`): plain ustar, 512-byte blocks,
 * no compression, and a pax `x` header carrying `path=` before any entry whose name is
 * over 100 bytes or not printable ASCII. This reads exactly that: regular files (`0` and
 * the old `\0`), the pax `path` record, and ustar's `prefix` field for archives other
 * tools wrote. Directories and links are skipped. Bytes are views into the input, never
 * copies, so a show with its audio costs no second buffer; `scanUstar` reads only the
 * files asked for, over any `RangeReader`.
 *
 * Pure: no DOM, no Node API, no clock.
 */

const BLOCK = 512;

export interface TarEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

export type TarRead = { readonly ok: true; readonly entries: readonly TarEntry[] } | { readonly ok: false; readonly reason: string };

const utf8 = new TextDecoder("utf-8");

function field(block: Uint8Array, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return utf8.decode(end < 0 ? slice : slice.subarray(0, end));
}

function octal(block: Uint8Array, offset: number, length: number): number | null {
  const text = field(block, offset, length).trim();
  if (text === "") return 0;
  if (!/^[0-7]+$/.test(text)) return null;
  return parseInt(text, 8);
}

function checksumMatches(block: Uint8Array): boolean {
  const stored = octal(block, 148, 8);
  if (stored === null) return false;
  let sum = 0;
  for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 32 : (block[index] as number);
  return sum === stored;
}

/** `len key=value\n` records (POSIX pax); only `path` matters here. */
function paxPath(data: Uint8Array): string | null {
  const text = utf8.decode(data);
  let at = 0;
  let path: string | null = null;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 0) break;
    const length = Number(text.slice(at, space));
    if (!Number.isInteger(length) || length <= 0) break;
    // The length counts BYTES; ltc-lab escapes nothing, so re-measure in bytes.
    const recordBytes = new TextEncoder().encode(text.slice(at)).subarray(0, length);
    const record = utf8.decode(recordBytes);
    const body = record.slice(record.indexOf(" ") + 1).replace(/\n$/, "");
    const equals = body.indexOf("=");
    if (equals > 0 && body.slice(0, equals) === "path") path = body.slice(equals + 1);
    at += record.length;
  }
  return path;
}

const allZero = (block: Uint8Array): boolean => block.every((byte) => byte === 0);

/** Random access to an archive: a file on disk in the helper, or bytes in memory. */
export interface RangeReader {
  size(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesReader(bytes: Uint8Array): RangeReader {
  return {
    size: () => Promise.resolve(bytes.length),
    read: (offset, length) => Promise.resolve(bytes.subarray(offset, offset + length)),
  };
}

/** Every file in the archive: its name and size, read or not. */
export interface TarListing {
  readonly name: string;
  readonly size: number;
}

export type TarScan =
  | { readonly ok: true; readonly entries: readonly TarEntry[]; readonly listing: readonly TarListing[] }
  | { readonly ok: false; readonly reason: string };

/**
 * Walk the archive header by header and read the data of only the files `want` names, so
 * a show of several hundred MB (stems, video) costs the bytes of what is imported and the
 * 512 bytes of each header. `listing` names everything, read or not, for the report.
 * `want` sees what was read so far, so a decision can follow an earlier file (the audio a
 * project.json names, which precedes it in ltc-lab's archive order).
 */
export async function scanUstar(reader: RangeReader, want: (name: string, readSoFar: readonly TarEntry[]) => boolean): Promise<TarScan> {
  const entries: TarEntry[] = [];
  const listing: TarListing[] = [];
  const total = await reader.size();
  let offset = 0;
  let pendingPath: string | null = null;
  while (offset + BLOCK <= total) {
    const header = await reader.read(offset, BLOCK);
    if (header.length < BLOCK || allZero(header)) break;
    if (!checksumMatches(header)) return { ok: false, reason: `not a tar archive: the header at byte ${offset} fails its checksum` };
    const size = octal(header, 124, 12);
    if (size === null) return { ok: false, reason: `the tar header at byte ${offset} has an unreadable size` };
    const type = String.fromCharCode(header[156] as number);
    const dataStart = offset + BLOCK;
    if (dataStart + size > total) return { ok: false, reason: `the tar archive is truncated: "${field(header, 0, 100)}" runs past the end` };
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") {
      pendingPath = paxPath(await reader.read(dataStart, size));
      continue;
    }
    if (type === "g") continue;
    const prefix = field(header, 345, 155);
    const name = pendingPath ?? (prefix === "" ? field(header, 0, 100) : `${prefix}/${field(header, 0, 100)}`);
    pendingPath = null;
    if (type !== "0" && type !== "\0") continue;
    listing.push({ name, size });
    if (want(name, entries)) entries.push({ name, bytes: await reader.read(dataStart, size) });
  }
  return { ok: true, entries, listing };
}

/** The whole archive in memory, every file read. */
export async function readUstar(bytes: Uint8Array): Promise<TarRead> {
  const scan = await scanUstar(bytesReader(bytes), () => true);
  return scan.ok ? { ok: true, entries: scan.entries } : scan;
}

/** A ustar archive of the given files (tests and fixtures; ltc-lab's writer is the reference). */
export function writeUstar(files: readonly TarEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const blocks: Uint8Array[] = [];
  const header = (name: string, size: number, type: string): Uint8Array => {
    const block = new Uint8Array(BLOCK);
    const put = (text: string, at: number): void => block.set(encoder.encode(text), at);
    put(name.slice(0, 100), 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${size.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    put(type, 156);
    put("ustar\0", 257);
    put("00", 263);
    let sum = 0;
    for (const byte of block) sum += byte;
    put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    return block;
  };
  const padded = (data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(Math.ceil(data.length / BLOCK) * BLOCK);
    out.set(data);
    return out;
  };
  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    if (nameBytes.length > 100 || /[^\x20-\x7e]/.test(file.name)) {
      const body = ` path=${file.name}\n`;
      let length = encoder.encode(body).length + 1;
      while (String(length).length + encoder.encode(body).length !== length) length = String(length).length + encoder.encode(body).length;
      const pax = encoder.encode(`${length}${body}`);
      blocks.push(header("PaxHeader", pax.length, "x"), padded(pax));
    }
    blocks.push(header(file.name.replace(/[^\x20-\x7e]/g, "_").slice(-100), file.bytes.length, "0"), padded(file.bytes));
  }
  blocks.push(new Uint8Array(BLOCK * 2));
  const total = blocks.reduce((sum, block) => sum + block.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}
