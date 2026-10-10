/**
 * VN99 — WHICH CODEC A DROPPED MOVIE CARRIES, read from the container, not the extension.
 *
 * A `.mov` is as likely to hold DXV, HAP or ProRes (none of which Chromium decodes) as
 * H.264, and the extension cannot tell them apart. The sample description (`stsd`) of an
 * ISO base media file (MP4, MOV, M4V) names each track's codec as a four-character code, so
 * the drop reads box HEADERS down `moov/trak/mdia/minf/stbl/stsd` (a few small slices, never
 * the media data) and refuses a codec on the list below by name. A codec not on the list is
 * accepted: the decoder is the authority, and the movie node already reports a file it
 * could not play. A refusal list rather than an allow list, for the same reason
 * `picture-file.ts` attempts what it does not offer: Chromium builds differ (Electron with
 * proprietary codecs plays HEVC, a plain Chromium does not).
 *
 * AVI and MXF are refused by container: Chromium plays neither, whatever is inside.
 */

/** A codec the browser cannot decode, named for the sentence. */
export interface UndecodableCodec {
  readonly fourcc: string;
  readonly name: string;
}

const UNDECODABLE: Readonly<Record<string, string>> = {
  DXD3: "DXV (Resolume)", DXDI: "DXV (Resolume)", DXT1: "DXV (Resolume)", DXT3: "DXV (Resolume)", DXT5: "DXV (Resolume)", DXV3: "DXV (Resolume)",
  Hap1: "HAP", Hap5: "HAP", HapY: "HAP Q", HapM: "HAP Q Alpha", HapA: "HAP Alpha", Hap7: "HAP R", HapH: "HAP HDR",
  apcn: "Apple ProRes 422", apch: "Apple ProRes 422 HQ", apcs: "Apple ProRes 422 LT", apco: "Apple ProRes 422 Proxy",
  ap4h: "Apple ProRes 4444", ap4x: "Apple ProRes 4444 XQ", aprn: "Apple ProRes RAW", aprh: "Apple ProRes RAW HQ",
  AVdn: "Avid DNxHD", AVdh: "Avid DNxHR",
  CFHD: "GoPro CineForm",
  nclc: "NotchLC",
  "rle ": "QuickTime Animation",
  jpeg: "Photo JPEG", mjpa: "Motion JPEG", mjpb: "Motion JPEG", AVDJ: "Motion JPEG",
  "png ": "QuickTime PNG",
  "2vuy": "uncompressed 4:2:2", v210: "uncompressed 10-bit 4:2:2", "raw ": "uncompressed RGB",
  icod: "Apple Intermediate Codec",
};

/** The name of a codec on the refusal list, or null. Exported for the table's own test. */
export function undecodableCodecName(fourcc: string): string | null {
  return Object.hasOwn(UNDECODABLE, fourcc) ? (UNDECODABLE[fourcc] as string) : null;
}

/** What the sniff found: a codec to refuse, or nothing to object to. */
export type ContainerVerdict =
  | { readonly playable: true }
  | { readonly playable: false; readonly what: string };

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
/** Bounds a hostile or corrupt file: nothing legitimate has this many boxes at one level. */
const MAX_BOXES = 4096;

async function bytes(blob: Blob, start: number, end: number): Promise<DataView> {
  const slice = blob.slice(start, Math.min(end, blob.size));
  const buffer = typeof slice.arrayBuffer === "function"
    ? await slice.arrayBuffer()
    : await new Response(slice).arrayBuffer();
  return new DataView(buffer);
}

const fourccAt = (view: DataView, offset: number): string =>
  String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));

/** The boxes in [start, end): type, payload start and end. Stops at the first malformed header. */
async function boxes(blob: Blob, start: number, end: number): Promise<Array<{ type: string; body: number; end: number }>> {
  const found: Array<{ type: string; body: number; end: number }> = [];
  let at = start;
  while (at + 8 <= end && found.length < MAX_BOXES) {
    const header = await bytes(blob, at, at + 16);
    if (header.byteLength < 8) break;
    let size = header.getUint32(0);
    const type = fourccAt(header, 4);
    let body = at + 8;
    if (size === 1) {
      if (header.byteLength < 16) break;
      size = Number(header.getBigUint64(8));
      body = at + 16;
    } else if (size === 0) {
      size = end - at;
    }
    if (size < body - at || at + size > end) break;
    found.push({ type, body, end: at + size });
    at += size;
  }
  return found;
}

/** Every sample-entry four-cc in every track's `stsd`. */
export async function sampleEntryCodecs(blob: Blob): Promise<string[]> {
  const codecs: string[] = [];
  const walk = async (start: number, end: number, depth: number): Promise<void> => {
    for (const box of await boxes(blob, start, end)) {
      if (CONTAINERS.has(box.type) && depth < 6) {
        await walk(box.body, box.end, depth + 1);
      } else if (box.type === "stsd") {
        // Full box: version + flags (4), entry count (4), then sample entries.
        const head = await bytes(blob, box.body, box.body + 8);
        if (head.byteLength < 8) continue;
        const count = Math.min(head.getUint32(4), 64);
        let at = box.body + 8;
        for (let index = 0; index < count && at + 8 <= box.end; index += 1) {
          const entry = await bytes(blob, at, at + 8);
          if (entry.byteLength < 8) break;
          const size = entry.getUint32(0);
          codecs.push(fourccAt(entry, 4));
          if (size < 8) break;
          at += size;
        }
      }
    }
  };
  await walk(0, blob.size, 0);
  return codecs;
}

/** Whether the browser can be expected to decode this movie file, and if not, what it holds. */
export async function containerVerdict(blob: Blob): Promise<ContainerVerdict> {
  if (blob.size < 12) return { playable: true };
  const head = await bytes(blob, 0, 12);
  const riff = fourccAt(head, 0) === "RIFF" && fourccAt(head, 8) === "AVI ";
  if (riff) return { playable: false, what: "an AVI container" };
  // MXF: the SMPTE header partition key starts 06 0E 2B 34.
  if (head.getUint32(0) === 0x060e2b34) return { playable: false, what: "an MXF container" };
  const type = fourccAt(head, 4);
  if (!["ftyp", "moov", "wide", "free", "mdat", "skip", "pnot"].includes(type)) return { playable: true };
  for (const fourcc of await sampleEntryCodecs(blob)) {
    const name = undecodableCodecName(fourcc);
    if (name !== null) return { playable: false, what: `${name} (${fourcc.trim()})` };
  }
  return { playable: true };
}
