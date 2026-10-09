/**
 * A minimal, progressive MP4 muxer for H.264 (T111).
 *
 * `VideoEncoder` produces H.264 access units; it does not produce a file. Something has to
 * write the container, and the locked decision is WebCodecs → mp4 with no MediaRecorder
 * stopgap (§C recording), so the container is ours.
 *
 * Layout is `ftyp` / `mdat` / `moov`, in that order. That ordering is what makes this
 * tractable: `stco` chunk offsets have to point into `mdat`, so writing `mdat` first means
 * every offset is known before `moov` is built. A `moov`-first file needs either a second
 * pass or fragmentation. Encoded payload streams to disk; only sample metadata remains
 * here until the encoder flushes.
 *
 * DOM-free and dependency-free, so it runs in a worker, in Node, and in a unit test.
 */

function u8(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function u16(value: number): Uint8Array {
  return u8((value >>> 8) & 0xff, value & 0xff);
}

function u32(value: number): Uint8Array {
  return u8((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("MP4 64-bit value is outside JavaScript's safe integer range.");
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value - high * 0x1_0000_0000;
  return concat([u32(high), u32(low)]);
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, (character) => character.charCodeAt(0) & 0xff);
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u32(body.length + 8), ascii(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]): Uint8Array {
  return box(type, u8(version, (flags >>> 16) & 0xff, (flags >>> 8) & 0xff, flags & 0xff), ...payload);
}

const UNITY_MATRIX = concat([
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x00010000),
  u32(0),
  u32(0),
  u32(0),
  u32(0x40000000),
]);

export interface Mp4Sample {
  /** Present for the in-memory muxer. A streamed mux keeps only byteLength. */
  readonly bytes?: Uint8Array;
  readonly byteLength?: number;
  readonly keyFrame: boolean;
  /** In media timescale units. */
  readonly duration: number;
}

export interface Mp4AudioSample {
  readonly bytes?: Uint8Array;
  readonly byteLength?: number;
  /** In audio sample-rate units. AAC-LC access units normally contain 1024 samples. */
  readonly duration: number;
}

export interface Mp4AudioTrack {
  readonly sampleRate: number;
  readonly channelCount: number;
  readonly samples: ReadonlyArray<Mp4AudioSample>;
  /** MPEG-4 AudioSpecificConfig from the encoder's `decoderConfig.description`. */
  readonly codecDescription: Uint8Array;
  readonly bitrate?: number;
  /** Decoder priming to skip, in audio sample-rate units. */
  readonly mediaStart?: number;
  /** Audible duration after priming, in audio sample-rate units. */
  readonly presentationDuration?: number;
}

export interface Mp4MuxInput {
  readonly width: number;
  readonly height: number;
  /** Media timescale. `fps * 1000` keeps every per-frame duration an exact integer. */
  readonly timescale: number;
  readonly samples: ReadonlyArray<Mp4Sample>;
  /** `avcC` payload from the encoder's `decoderConfig.description`. */
  readonly codecDescription: Uint8Array;
  /** Optional AAC-LC track. Samples are interleaved at chunk granularity after video. */
  readonly audio?: Mp4AudioTrack;
  /** VN104 — optional start timecode, written as a QuickTime `tmcd` track the video references. */
  readonly timecode?: Mp4TimecodeTrack;
  /** VN104 — `mov` writes a QuickTime `ftyp` (brand `qt  `); the box tree is the same. Default `mp4`. */
  readonly container?: Mp4Container;
}

export type Mp4Container = "mp4" | "mov";

/**
 * VN104 — a QuickTime timecode track: one 4-byte sample holding the FRAME COUNT of the first
 * video frame, counted from 00:00:00:00 at `framesPerSecond` (the nominal rate: 30 at 29.97).
 * With `dropFrame`, a reader turns that count back into a drop-frame label, so the count is
 * `timecodeToFrame(label)`, never the label's digits read as if non-drop.
 *
 * `timescale` / `frameDuration` are the video track's, so the two tracks agree on a frame.
 */
export interface Mp4TimecodeTrack {
  readonly startFrame: number;
  readonly framesPerSecond: number;
  readonly dropFrame: boolean;
  readonly timescale: number;
  readonly frameDuration: number;
}

/** The single 4-byte `tmcd` sample: the start frame count, big-endian. */
export function timecodeSampleBytes(timecode: Mp4TimecodeTrack): Uint8Array {
  return u32(timecode.startFrame);
}

const MOVIE_TIMESCALE = 1000;

/** Media timescale that keeps a per-frame duration integral for any integer-ish fps. */
export function timescaleFor(fps: number): number {
  return Math.round(fps * 1000);
}

export function sampleDurationFor(fps: number): number {
  return Math.round(timescaleFor(fps) / fps);
}

export function mp4FileTypeBox(container: Mp4Container = "mp4"): Uint8Array {
  // QuickTime: major brand `qt  `, minor version 0x20050300 as Apple's own writers use.
  return container === "mov"
    ? box("ftyp", ascii("qt  "), u32(0x20050300), ascii("qt  "))
    : box("ftyp", ascii("isom"), u32(0x200), ascii("isom"), ascii("iso2"), ascii("avc1"), ascii("mp41"));
}

function durationRuns(samples: ReadonlyArray<{ readonly duration: number }>): Uint8Array {
  const entries: Array<[number, number]> = [];
  for (const sample of samples) {
    const last = entries[entries.length - 1];
    if (last && last[1] === sample.duration) last[0] += 1;
    else entries.push([1, sample.duration]);
  }
  return fullBox(
    "stts",
    0,
    0,
    u32(entries.length),
    ...entries.map((entry) => concat([u32(entry[0]), u32(entry[1])])),
  );
}

function sampleSizes(samples: ReadonlyArray<{ readonly bytes?: Uint8Array; readonly byteLength?: number }>): Uint8Array {
  // One typed table avoids one Uint8Array plus one spread argument per sample. AAC has
  // about 169k packets per hour at 48 kHz; spreading that list can exceed JavaScript's
  // call-argument limit during finalization even though the resulting table is small.
  const table = new Uint8Array(8 + samples.length * 4);
  const view = new DataView(table.buffer);
  view.setUint32(0, 0);
  view.setUint32(4, samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    view.setUint32(8 + index * 4, sampleSize(samples[index]!));
  }
  return fullBox("stsz", 0, 0, table);
}

function sampleSize(sample: { readonly bytes?: Uint8Array; readonly byteLength?: number }): number {
  const size = sample.bytes?.length ?? sample.byteLength;
  if (!Number.isInteger(size) || size === undefined || size < 0) {
    throw new Error("Every MP4 sample must declare a non-negative byte length.");
  }
  return size;
}

function descriptorLength(length: number): Uint8Array {
  const encoded = [length & 0x7f];
  let remaining = length >>> 7;
  while (remaining > 0) {
    encoded.unshift((remaining & 0x7f) | 0x80);
    remaining >>>= 7;
  }
  return Uint8Array.from(encoded);
}

function descriptor(tag: number, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload);
  return concat([u8(tag), descriptorLength(body.length), body]);
}

function chunkOffsetBox(chunkOffset: number): Uint8Array {
  return chunkOffset <= 0xffff_ffff
    ? fullBox("stco", 0, 0, u32(1), u32(chunkOffset))
    : fullBox("co64", 0, 0, u32(1), u64(chunkOffset));
}

function audioTrackBox(audio: Mp4AudioTrack, chunkOffset: number, movieDuration: number): Uint8Array {
  const stts = durationRuns(audio.samples);
  const stsz = sampleSizes(audio.samples);
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(audio.samples.length), u32(1));
  const stco = chunkOffsetBox(chunkOffset);

  const decoderSpecificInfo = descriptor(0x05, audio.codecDescription);
  const bitrate = audio.bitrate ?? 0;
  const decoderConfig = descriptor(
    0x04,
    u8(0x40), // MPEG-4 Audio
    u8(0x15), // audio stream, upstream=false, reserved=1
    u8(0, 0, 0), // bufferSizeDB; WebCodecs does not expose this
    u32(bitrate),
    u32(bitrate),
    decoderSpecificInfo,
  );
  const esDescriptor = descriptor(0x03, u16(2), u8(0), decoderConfig, descriptor(0x06, u8(0x02)));
  const esds = fullBox("esds", 0, 0, esDescriptor);
  const mp4a = box(
    "mp4a",
    new Uint8Array(6),
    u16(1), // data_reference_index
    u32(0),
    u32(0), // reserved
    u16(audio.channelCount),
    u16(16), // sample size
    u16(0),
    u16(0), // pre_defined + reserved
    u32(audio.sampleRate << 16),
    esds,
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), mp4a);
  const stbl = box("stbl", stsd, stts, stsc, stsz, stco);
  const dref = fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1));
  const minf = box("minf", fullBox("smhd", 0, 0, u16(0), u16(0)), box("dinf", dref), stbl);
  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    ascii("soun"),
    u32(0),
    u32(0),
    u32(0),
    ascii("Loom\0"),
  );
  const mediaDuration = audio.samples.reduce((total, sample) => total + sample.duration, 0);
  const mdhd = fullBox(
    "mdhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(audio.sampleRate),
    u32(mediaDuration),
    u16(0x55c4),
    u16(0),
  );
  const tkhd = fullBox(
    "tkhd",
    0,
    0x000003,
    u32(0),
    u32(0),
    u32(2),
    u32(0),
    u32(movieDuration),
    u32(0),
    u32(0),
    u16(0),
    u16(0),
    u16(0x0100), // volume 1.0
    u16(0),
    UNITY_MATRIX,
    u32(0),
    u32(0),
  );
  const mediaStart = audio.mediaStart ?? 0;
  const edit = mediaStart > 0 || audio.presentationDuration !== undefined
    ? box(
      "edts",
      fullBox(
        "elst",
        0,
        0,
        u32(1),
        u32(movieDuration),
        u32(mediaStart),
        u16(1),
        u16(0),
      ),
    )
    : undefined;
  return edit === undefined
    ? box("trak", tkhd, box("mdia", mdhd, hdlr, minf))
    : box("trak", tkhd, edit, box("mdia", mdhd, hdlr, minf));
}

/**
 * VN104 — the QuickTime timecode track (`tmcd`), laid out as FFmpeg's mov/mp4 writer lays it
 * out, which is what ffprobe, Resolve, Premiere and QuickTime read a file's start timecode
 * from. The video track points at it with `tref`/`tmcd`; without that reference readers still
 * see a data track but do not attach its timecode to the video.
 */
function timecodeTrackBox(timecode: Mp4TimecodeTrack, trackId: number, chunkOffset: number, mediaDuration: number, movieDuration: number): Uint8Array {
  const { framesPerSecond, timescale, frameDuration } = timecode;
  if (!Number.isInteger(framesPerSecond) || framesPerSecond <= 0 || framesPerSecond > 255) {
    throw new Error(`A timecode track counts 1..255 frames a second; got ${String(framesPerSecond)}.`);
  }
  if (!Number.isSafeInteger(timecode.startFrame) || timecode.startFrame < 0 || timecode.startFrame > 0xffff_ffff) {
    throw new Error(`A start timecode is a whole frame count ≥ 0; got ${String(timecode.startFrame)}.`);
  }
  // Flags: bit 0 drop-frame, bit 1 "wraps at 24 hours" (every SMPTE reader assumes it).
  const flags = (timecode.dropFrame ? 0x1 : 0) | 0x2;
  const tmcdEntry = box(
    "tmcd",
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    u32(0), // reserved
    u32(flags),
    u32(timescale),
    u32(frameDuration),
    u8(framesPerSecond),
    u8(0, 0, 0), // reserved, padded as FFmpeg pads it
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), tmcdEntry);
  const stts = fullBox("stts", 0, 0, u32(1), u32(1), u32(mediaDuration));
  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(1), u32(1));
  const stsz = fullBox("stsz", 0, 0, u32(4), u32(1));
  const stbl = box("stbl", stsd, stts, stsc, stsz, chunkOffsetBox(chunkOffset));
  const dref = fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1));
  // Base media header (`gmhd`) carrying the timecode media information (`tcmi`): how a
  // QuickTime player would draw the timecode if the track were shown. Required by Apple's
  // readers to recognise the track as timecode.
  const gmin = fullBox("gmin", 0, 0, u16(0x40), u16(0x8000), u16(0x8000), u16(0x8000), u16(0), u16(0));
  const fontName = ascii("Lucida Grande");
  const tcmi = fullBox(
    "tcmi",
    0,
    0,
    u16(0), // text font
    u16(0), // text face
    u16(12), // text size
    u16(0), // reserved
    u16(0xffff), u16(0xffff), u16(0xffff), // text colour
    u16(0), u16(0), u16(0), // background colour
    u8(fontName.length),
    fontName,
  );
  const gmhd = box("gmhd", gmin, box("tmcd", tcmi));
  const minf = box("minf", gmhd, box("dinf", dref), stbl);
  const hdlr = fullBox("hdlr", 0, 0, u32(0), ascii("tmcd"), u32(0), u32(0), u32(0), ascii("Loom timecode\0"));
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0));
  const tkhd = fullBox(
    "tkhd",
    0,
    0x000002, // in movie, NOT enabled: a timecode track is metadata, never presented
    u32(0),
    u32(0),
    u32(trackId),
    u32(0),
    u32(movieDuration),
    u32(0),
    u32(0),
    u16(0),
    u16(0),
    u16(0),
    u16(0),
    UNITY_MATRIX,
    u32(0),
    u32(0),
  );
  return box("trak", tkhd, box("mdia", mdhd, hdlr, minf));
}

export interface Mp4StreamParts {
  readonly ftyp: Uint8Array;
  readonly mdatHeader: Uint8Array;
  readonly moov: Uint8Array;
}

interface StreamedMediaLengths {
  readonly video: number;
  readonly audio: number;
  /** The timecode sample, written to the spool after the audio (4 bytes, or 0). */
  readonly timecode: number;
}

export function muxMp4(input: Mp4MuxInput): Uint8Array {
  return buildMp4(input, null) as Uint8Array;
}

/** Container metadata for media payload already written to a disk spool. */
export function mp4StreamParts(input: Mp4MuxInput): Mp4StreamParts {
  const video = input.samples.reduce((total, sample) => total + sampleSize(sample), 0);
  const audio = input.audio?.samples.reduce((total, sample) => total + sampleSize(sample), 0) ?? 0;
  const timecode = input.timecode === undefined ? 0 : timecodeSampleBytes(input.timecode).length;
  return buildMp4(input, { video, audio, timecode }) as Mp4StreamParts;
}

function buildMp4(input: Mp4MuxInput, streamed: StreamedMediaLengths | null): Uint8Array | Mp4StreamParts {
  const { samples, timescale } = input;
  if (samples.length === 0) throw new Error("Cannot mux an MP4 with no samples.");
  if (input.codecDescription.length === 0) {
    throw new Error(
      "Cannot mux an MP4 without an avcC decoder description. The encoder must be configured " +
        'with avc: { format: "avc" } so it reports one — annex-B output has no avcC and would ' +
        "produce a file no player can decode.",
    );
  }
  if (input.audio) {
    if (input.audio.samples.length === 0) throw new Error("Cannot mux an AAC track with no samples.");
    if (input.audio.codecDescription.length === 0) {
      throw new Error("Cannot mux an AAC track without an AudioSpecificConfig decoder description.");
    }
    if (!Number.isInteger(input.audio.sampleRate) || input.audio.sampleRate <= 0 || input.audio.sampleRate > 0xffff) {
      throw new Error("AAC sample rate must be an integer between 1 and 65535 Hz.");
    }
    if (!Number.isInteger(input.audio.channelCount) || input.audio.channelCount <= 0 || input.audio.channelCount > 0xffff) {
      throw new Error("AAC channel count must be an integer between 1 and 65535.");
    }
    const encodedDuration = input.audio.samples.reduce((total, sample) => total + sample.duration, 0);
    const mediaStart = input.audio.mediaStart ?? 0;
    const presentationDuration = input.audio.presentationDuration ?? encodedDuration - mediaStart;
    if (mediaStart < 0 || presentationDuration <= 0 || mediaStart + presentationDuration > encodedDuration) {
      throw new Error("AAC edit range must fit inside the encoded audio duration.");
    }
  }

  const mediaDuration = samples.reduce((total, sample) => total + sample.duration, 0);
  const videoMovieDuration = Math.round((mediaDuration * MOVIE_TIMESCALE) / timescale);
  const audioEncodedDuration = input.audio?.samples.reduce((total, sample) => total + sample.duration, 0) ?? 0;
  const audioMediaDuration = input.audio?.presentationDuration ??
    (input.audio ? audioEncodedDuration - (input.audio.mediaStart ?? 0) : 0);
  const audioMovieDuration = input.audio
    ? Math.round((audioMediaDuration * MOVIE_TIMESCALE) / input.audio.sampleRate)
    : 0;
  const movieDuration = Math.max(videoMovieDuration, audioMovieDuration);

  const ftyp = mp4FileTypeBox(input.container);
  const videoBytes = streamed === null
    ? concat(samples.map((sample) => {
      if (sample.bytes === undefined) throw new Error("In-memory MP4 samples must carry bytes.");
      return sample.bytes;
    }))
    : new Uint8Array(0);
  const audioBytes = streamed === null && input.audio
    ? concat(input.audio.samples.map((sample) => {
      if (sample.bytes === undefined) throw new Error("In-memory MP4 audio samples must carry bytes.");
      return sample.bytes;
    }))
    : new Uint8Array(0);
  const timecodeBytes = streamed === null && input.timecode ? timecodeSampleBytes(input.timecode) : new Uint8Array(0);
  const mediaBytes = streamed === null ? concat([videoBytes, audioBytes, timecodeBytes]) : new Uint8Array(0);
  const mdat = streamed === null ? box("mdat", mediaBytes) : null;
  // Samples are written back to back in one chunk, so the chunk offset is simply where
  // `mdat`'s payload starts.
  const chunkOffset = ftyp.length + (streamed === null ? 8 : 16);

  // stts: one entry per distinct duration run. Constant-fps takes collapse to a single entry.
  const stts = durationRuns(samples);

  const stsz = sampleSizes(samples);

  const stsc = fullBox("stsc", 0, 0, u32(1), u32(1), u32(samples.length), u32(1));
  const stco = chunkOffsetBox(chunkOffset);

  // stss lists sync samples, 1-based. Omitted entirely when every sample is a sync sample —
  // which is what "no stss" means, and writing one listing all of them is equivalent but
  // larger.
  const syncSamples = samples
    .map((sample, index) => (sample.keyFrame ? index + 1 : 0))
    .filter((index) => index > 0);
  const stss =
    syncSamples.length === samples.length
      ? []
      : [fullBox("stss", 0, 0, u32(syncSamples.length), ...syncSamples.map(u32))];

  const avcC = box("avcC", input.codecDescription);
  const avc1 = box(
    "avc1",
    u8(0, 0, 0, 0, 0, 0), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    u32(0),
    u32(0),
    u32(0), // pre_defined[3]
    u16(input.width),
    u16(input.height),
    u32(0x00480000), // 72dpi horizontal
    u32(0x00480000), // 72dpi vertical
    u32(0), // reserved
    u16(1), // frame_count
    new Uint8Array(32), // compressorname
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    avcC,
  );
  const stsd = fullBox("stsd", 0, 0, u32(1), avc1);
  const stbl = box("stbl", stsd, stts, ...stss, stsc, stsz, stco);

  const dref = fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1));
  const dinf = box("dinf", dref);
  const vmhd = fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
  const minf = box("minf", vmhd, dinf, stbl);

  const hdlr = fullBox(
    "hdlr",
    0,
    0,
    u32(0),
    ascii("vide"),
    u32(0),
    u32(0),
    u32(0),
    ascii("Loom\0"),
  );
  const mdhd = fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(mediaDuration), u16(0x55c4), u16(0));
  const mdia = box("mdia", mdhd, hdlr, minf);

  const tkhd = fullBox(
    "tkhd",
    0,
    0x000003, // track enabled + in movie
    u32(0),
    u32(0),
    u32(1), // track_ID
    u32(0), // reserved
    u32(videoMovieDuration),
    u32(0),
    u32(0), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume (0 for video)
    u16(0), // reserved
    UNITY_MATRIX,
    u32(input.width << 16),
    u32(input.height << 16),
  );
  const timecodeTrackId = input.audio ? 3 : 2;
  const tref = input.timecode ? [box("tref", box("tmcd", u32(timecodeTrackId)))] : [];
  const trak = box("trak", tkhd, ...tref, mdia);
  const audioTrak = input.audio
    ? audioTrackBox(input.audio, chunkOffset + (streamed?.video ?? videoBytes.length), audioMovieDuration)
    : undefined;
  const timecodeTrak = input.timecode
    ? timecodeTrackBox(
      input.timecode,
      timecodeTrackId,
      chunkOffset + (streamed?.video ?? videoBytes.length) + (streamed?.audio ?? audioBytes.length),
      Math.round((mediaDuration * input.timecode.timescale) / timescale),
      videoMovieDuration,
    )
    : undefined;

  const mvhd = fullBox(
    "mvhd",
    0,
    0,
    u32(0),
    u32(0),
    u32(MOVIE_TIMESCALE),
    u32(movieDuration),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    u16(0), // reserved
    u32(0),
    u32(0), // reserved
    UNITY_MATRIX,
    new Uint8Array(24), // pre_defined
    u32(2 + (input.audio ? 1 : 0) + (input.timecode ? 1 : 0)), // next_track_ID
  );
  const moov = box("moov", mvhd, trak, ...(audioTrak ? [audioTrak] : []), ...(timecodeTrak ? [timecodeTrak] : []));

  if (streamed !== null) {
    const mdatSize = 16 + streamed.video + streamed.audio + streamed.timecode;
    return { ftyp, mdatHeader: concat([u32(1), ascii("mdat"), u64(mdatSize)]), moov };
  }
  return concat([ftyp, mdat as Uint8Array, moov]);
}

/**
 * `avc1.PPCCLL` from the SPS inside an avcC record: profile_idc, constraint flags, level_idc
 * are bytes 1..3. Reported rather than hardcoded so the mime type describes the file that was
 * actually produced.
 */
export function avcCodecString(description: Uint8Array): string {
  if (description.length < 4) return "avc1";
  const hex = (value: number): string => value.toString(16).padStart(2, "0");
  return `avc1.${hex(description[1] ?? 0)}${hex(description[2] ?? 0)}${hex(description[3] ?? 0)}`;
}
