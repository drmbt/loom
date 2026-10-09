/**
 * VN103 — WHICH MEDIA CHROMIUM CANNOT PLAY, AND WHAT TO TURN IT INTO. Pure: no ffmpeg, no
 * file system. `transcode-media.ts` runs the processes; this decides.
 *
 * Loom plays video through a `<video>` element, so it plays what Chromium decodes: H.264
 * (8-bit 4:2:0), HEVC, VP8, VP9 and AV1, plus the stills `movieFileIn` opens itself. A
 * Resolume composition is mostly DXV3 (Resolume's GPU codec), with HAP and ProRes beside it,
 * and Chromium decodes none of them. Those become PROXIES:
 *
 *  - opaque sources → H.264 in MP4 (yuv420p, every Chromium build decodes it in hardware);
 *  - sources with alpha → VP9 in WebM with an alpha plane (the one Chromium codec that
 *    carries alpha through a `<video>` element).
 *
 * ## Alpha is read from the CODEC, not from the decoder's pixel format
 *
 * FFmpeg's DXV and HAP decoders both report `rgba` whatever the file holds, so the pixel
 * format cannot tell DXT1 from DXT5. DXV says which in the first four bytes of every packet
 * (a little-endian tag: `DXT1`, `DXT5`, `YCG6`, `YG10`); HAP says it in the sample entry's
 * fourcc (`Hap1`, `HapY` opaque; `Hap5`, `HapM`, `HapA`, `Hap7` alpha). Everything else
 * reports its alpha honestly in the pixel format (`yuva444p12le` for ProRes 4444 with
 * alpha, `argb` for QuickTime Animation with alpha).
 */

/** What `ffprobe -show_streams -show_format -of json` says about one file, reduced. */
export interface ProbedStream {
  readonly codecName: string;
  /** The container fourcc, e.g. `DXD3`, `Hap5`, `ap4h`, `avc1`. */
  readonly codecTag: string;
  readonly pixFmt: string;
  readonly width: number;
  readonly height: number;
}

export interface ProbedMedia {
  /** The first video stream, or null for an audio-only file. */
  readonly video: ProbedStream | null;
  readonly hasAudio: boolean;
  /** Seconds, or 0 when the container does not say. */
  readonly duration: number;
  readonly formatName: string;
  /**
   * For DXV only: the tag in the first video packet (`DXT1`, `DXT5`, `YCG6`, `YG10`, or
   * whatever four characters an older file carries). Null when it was not read.
   */
  readonly dxvTag: string | null;
}

export type ProxyKind = "h264" | "vp9alpha";

export type Decision =
  | { readonly action: "keep"; readonly reason: string }
  | { readonly action: "proxy"; readonly kind: ProxyKind; readonly alpha: boolean; readonly reason: string }
  | { readonly action: "refuse"; readonly reason: string };

/**
 * Bumped whenever the encoder settings change, so an old proxy is never reused for a new
 * recipe: it is part of every proxy's file name.
 */
export const PROXY_RECIPE_VERSION = 1;

/** The codecs Chromium decodes in a `<video>` element on every desktop platform. */
const PLAYABLE_VIDEO = new Set(["h264", "hevc", "vp8", "vp9", "av1"]);
/** The stills `movieFileIn` opens itself (`pictureFileKind`); ffprobe names them as codecs. */
const STILL_CODECS = new Set(["png", "mjpeg", "webp", "gif", "bmp", "av1"]);
/** Containers ffprobe reports for a single image rather than a movie. */
const IMAGE_FORMATS = /(^|,)(png_pipe|jpeg_pipe|webp_pipe|gif|bmp_pipe|image2|avif)(,|$)/;
/** H.264 pixel formats Chromium decodes. 4:2:2, 4:4:4 and 10-bit H.264 it does not. */
const PLAYABLE_H264_PIXFMT = new Set(["yuv420p", "yuvj420p", "nv12"]);

/** HAP fourccs that carry alpha. `Hap1` (DXT1) and `HapY` (scaled YCoCg DXT5) do not. */
const HAP_ALPHA_TAGS = new Set(["Hap5", "HapM", "HapA", "Hap7", "HapH"]);
/** DXV packet tags without alpha. `DXT5` and `YG10` carry it. */
const DXV_OPAQUE_TAGS = new Set(["DXT1", "YCG6"]);

/**
 * The DXV tag from the first bytes of a packet, as hex (`31545844…`). The tag is a
 * little-endian u32 of a big-endian fourcc (FFmpeg `dxv.c`: `bytestream2_get_le32` against
 * `MKBETAG('D','X','T','1')`), so the bytes on disk read `1TXD` and are reversed here.
 */
export function dxvTagFromHex(hex: string): string | null {
  const clean = hex.replace(/[^0-9a-fA-F]/g, "");
  if (clean.length < 8) return null;
  const bytes: number[] = [];
  for (let i = 0; i < 8; i += 2) bytes.push(Number.parseInt(clean.slice(i, i + 2), 16));
  return String.fromCharCode(...bytes.reverse());
}

/** Does the pixel format carry an alpha plane? (`rgba`, `yuva420p`, `gbrap`, `ya8`, `argb` …) */
export function pixFmtHasAlpha(pixFmt: string): boolean {
  return /^(yuva|gbrap|ya\d|rgba|bgra|argb|abgr|rgba64|bgra64)/.test(pixFmt);
}

/** Whether the SOURCE carries alpha, by the codec's own word where the pixel format lies. */
export function sourceHasAlpha(media: ProbedMedia): boolean {
  const video = media.video;
  if (video === null) return false;
  if (video.codecName === "dxv") {
    // An unread or unknown tag is treated as alpha: a VP9 proxy of an opaque clip is merely
    // larger, an H.264 proxy of an alpha clip loses the alpha.
    return media.dxvTag === null || !DXV_OPAQUE_TAGS.has(media.dxvTag);
  }
  if (video.codecName === "hap") return HAP_ALPHA_TAGS.has(video.codecTag);
  return pixFmtHasAlpha(video.pixFmt);
}

/** Keep, proxy (and as what), or refuse, for one probed file. */
export function decide(media: ProbedMedia): Decision {
  const video = media.video;
  if (video === null) {
    return media.hasAudio
      ? { action: "keep", reason: "audio only; the browser decodes it (or the audio path reports it by name)" }
      : { action: "refuse", reason: "no video or audio stream" };
  }
  if (STILL_CODECS.has(video.codecName) && IMAGE_FORMATS.test(media.formatName)) {
    return { action: "keep", reason: `a ${video.codecName} still; Movie File In opens it directly` };
  }
  if (PLAYABLE_VIDEO.has(video.codecName)) {
    if (video.codecName !== "h264" || PLAYABLE_H264_PIXFMT.has(video.pixFmt)) {
      return { action: "keep", reason: `${video.codecName} ${video.pixFmt} plays in Chromium` };
    }
  }
  if (video.width <= 0 || video.height <= 0) {
    return { action: "refuse", reason: `${video.codecName} reports no picture size` };
  }
  const alpha = sourceHasAlpha(media);
  const what = video.codecName === "dxv" ? `DXV ${media.dxvTag ?? "(unknown variant)"}`
    : video.codecName === "hap" ? `HAP ${video.codecTag}`
    : `${video.codecName} ${video.pixFmt}`;
  return alpha
    ? { action: "proxy", kind: "vp9alpha", alpha, reason: `${what} has alpha; Chromium cannot decode it` }
    : { action: "proxy", kind: "h264", alpha, reason: `${what} is opaque; Chromium cannot decode it` };
}

/** The proxy's file name in the cache: content hash, recipe, kind. */
export function proxyFileName(contentHash: string, kind: ProxyKind): string {
  const ext = kind === "h264" ? "mp4" : "webm";
  return `${contentHash.slice(0, 32)}-r${PROXY_RECIPE_VERSION}-${kind}.${ext}`;
}

/**
 * The ffmpeg arguments that write one proxy. `-progress pipe:1` streams `out_time_us=…`
 * lines the runner turns into a percentage.
 *
 * H.264: CRF 18, `veryfast`, yuv420p, even dimensions (4:2:0 needs them), `+faststart` so a
 * `<video>` seeks before the whole file has loaded, a keyframe every second so a seek lands
 * quickly. VP9 alpha: `yuva420p`, constant quality 30, `row-mt`, `good` at speed 4 (realtime
 * deadline visibly bands gradients). Audio, when present, rides along as AAC / Opus.
 */
export function proxyArgs(source: string, output: string, kind: ProxyKind, hasAudio: boolean): string[] {
  const common = ["-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats", "-i", source,
    "-map", "0:v:0", ...(hasAudio ? ["-map", "0:a:0"] : []), "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2"];
  if (kind === "h264") {
    return [...common, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-force_key_frames", "expr:gte(t,n_forced*1)", "-movflags", "+faststart",
      ...(hasAudio ? ["-c:a", "aac", "-b:a", "192k"] : ["-an"]), output];
  }
  return [...common, "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", "30",
    "-deadline", "good", "-cpu-used", "4", "-row-mt", "1", "-g", "60",
    ...(hasAudio ? ["-c:a", "libopus", "-b:a", "160k"] : ["-an"]), output];
}

/** One `-progress` block's position in seconds, or null when the block carries none. */
export function progressSeconds(block: string): number | null {
  const match = /out_time_us=(\d+)/.exec(block) ?? /out_time_ms=(\d+)/.exec(block);
  if (match === null || match[1] === undefined) return null;
  // `out_time_ms` is microseconds too, despite its name (a long-standing FFmpeg quirk).
  return Number(match[1]) / 1e6;
}

/** Reduce `ffprobe -of json` output to what `decide` reads. */
export function parseProbe(json: string, dxvTag: string | null): ProbedMedia {
  const data = JSON.parse(json) as {
    streams?: Array<Record<string, unknown>>;
    format?: Record<string, unknown>;
  };
  const streams = data.streams ?? [];
  const video = streams.find((stream) => stream["codec_type"] === "video"
    && (stream["disposition"] as Record<string, unknown> | undefined)?.["attached_pic"] !== 1);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");
  const count = (value: unknown): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return {
    video: video === undefined ? null : {
      codecName: text(video["codec_name"]),
      codecTag: text(video["codec_tag_string"]),
      pixFmt: text(video["pix_fmt"]),
      width: count(video["width"]),
      height: count(video["height"]),
    },
    hasAudio: streams.some((stream) => stream["codec_type"] === "audio"),
    duration: count(data.format?.["duration"]),
    formatName: text(data.format?.["format_name"]),
    dxvTag,
  };
}

/** The manifest written beside the proxies: source path → what was decided and where it went. */
export interface ManifestEntry {
  /** Size and mtime the hash was taken at; a change in either re-hashes. */
  readonly size: number;
  readonly mtimeMs: number;
  /** sha256 of the whole file, hex. */
  readonly hash: string;
  readonly decision: "keep" | "proxy" | "refuse";
  readonly reason: string;
  /** Absolute path of the proxy; null when the source is kept or refused. */
  readonly proxy: string | null;
  readonly alpha: boolean;
  readonly codec: string;
  readonly width: number;
  readonly height: number;
  readonly duration: number;
  /** Seconds of encoding, when this run made the proxy. */
  readonly encodeSeconds?: number;
}

export interface Manifest {
  readonly version: 1;
  readonly entries: Record<string, ManifestEntry>;
}

export const EMPTY_MANIFEST: Manifest = { version: 1, entries: {} };

/** A manifest from disk, or an empty one when the text is not one (never throws). */
export function parseManifest(text: string | null): Manifest {
  if (text === null) return { version: 1, entries: {} };
  try {
    const data = JSON.parse(text) as Partial<Manifest>;
    if (data.version !== 1 || typeof data.entries !== "object" || data.entries === null) return { version: 1, entries: {} };
    return { version: 1, entries: { ...data.entries } };
  } catch {
    return { version: 1, entries: {} };
  }
}
