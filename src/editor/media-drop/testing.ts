/** VN99 test fixtures: the few ISO BMFF boxes the codec sniff reads, nothing else. */

/** One ISO BMFF box: big-endian size, four-cc, payload. */
export function box(type: string, ...payload: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const size = 8 + payload.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  let at = 8;
  for (const part of payload) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A movie whose one video track's sample entry is `codec` — just the boxes the sniff reads. */
export function movieWithCodec(codec: string, opts: { moovLast?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const stsdHead = new Uint8Array(8);
  new DataView(stsdHead.buffer).setUint32(4, 1);
  const entry = box(codec, new Uint8Array(78));
  const moov = box("moov", box("trak", box("mdia", box("minf", box("stbl", box("stsd", stsdHead, entry))))));
  const ftyp = box("ftyp", new TextEncoder().encode("qt  \0\0\0\0qt  "));
  const mdat = box("mdat", new Uint8Array(4096));
  const parts = opts.moovLast === true ? [ftyp, mdat, moov] : [ftyp, moov, mdat];
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    all.set(part, at);
    at += part.length;
  }
  return all;
}

