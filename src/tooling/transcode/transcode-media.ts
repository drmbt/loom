import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  decide,
  dxvTagFromHex,
  parseManifest,
  parseProbe,
  progressSeconds,
  proxyArgs,
  proxyFileName,
  type AlphaCodec,
  type Manifest,
  type ManifestEntry,
  type ProbedMedia,
} from "./plan.ts";

/**
 * VN103 — TRANSCODE MEDIA CHROMIUM CANNOT PLAY INTO CACHED PROXIES (the tool; the app's
 * import calls it later through the local helper).
 *
 *   node --import ./src/tooling/alias-hooks.ts src/tooling/transcode/transcode-media.ts \
 *     [--cache <dir>] [--jobs <n>] [--ffmpeg <path>] [--ffprobe <path>] [--alpha auto|hevc|vp9] [--dry-run] <file>…
 *
 * Every file is probed; what Chromium plays is left alone; DXV, HAP, ProRes, QuickTime
 * Animation and the rest become H.264 MP4 (opaque), or HEVC-with-alpha `.mov` (macOS,
 * VideoToolbox) / VP9 WebM with alpha (elsewhere) when the source has alpha (`plan.ts`).
 *
 * ## Where the proxies go: one cache folder, keyed by content
 *
 * `~/Library/Caches/Loom/proxies` on macOS (`$XDG_CACHE_HOME/loom/proxies`, else
 * `~/.cache/loom/proxies`, on Linux; `%LOCALAPPDATA%\Loom\proxies` on Windows), with
 * `manifest.json` mapping each source path to its proxy. Not beside the source, because:
 *  - show media lives on removable drives, read-only shares and cloud-synced folders (the
 *    Tinashe composition reads from all three); a proxy written into a Google Drive folder
 *    is gigabytes uploaded nobody asked for, and a read-only volume refuses it outright;
 *  - the same clip sits in several folders (`DRMBT2025/` and `DRMBT_2025/` hold identical
 *    files), and a content-hash key in one folder transcodes it once;
 *  - a cache is the OS's word for "safe to delete, rebuilt on demand", which a proxy is.
 * The file name is the sha256 of the source, the recipe version and the kind, so a moved or
 * renamed source still finds its proxy, and a changed recipe never reuses a stale one.
 *
 * Hashing a whole multi-gigabyte file is the slow part of a re-run, so the manifest keeps
 * each source's size and mtime beside its hash and a file that has changed neither is not
 * re-read.
 */

export interface TranscodeOptions {
  readonly cacheDir?: string;
  /** How many ffmpeg processes at once. Each one is itself multi-threaded. */
  readonly jobs?: number;
  readonly ffmpeg?: string;
  readonly ffprobe?: string;
  /**
   * Which codec carries alpha. `auto` (the default): HEVC through VideoToolbox when ffmpeg
   * has `hevc_videotoolbox` on macOS, else VP9.
   */
  readonly alpha?: AlphaCodec | "auto";
  /** Probe and decide, encode nothing. */
  readonly dryRun?: boolean;
  readonly onEvent?: (event: TranscodeEvent) => void;
}

export type TranscodeEvent =
  | { readonly type: "probe"; readonly source: string; readonly index: number; readonly total: number }
  | { readonly type: "decided"; readonly source: string; readonly entry: ManifestEntry; readonly cached: boolean }
  | { readonly type: "progress"; readonly source: string; readonly fraction: number }
  | { readonly type: "done"; readonly source: string; readonly entry: ManifestEntry }
  | { readonly type: "error"; readonly source: string; readonly message: string };

export interface TranscodeResult {
  readonly cacheDir: string;
  readonly manifestPath: string;
  readonly entries: Record<string, ManifestEntry>;
  readonly errors: Record<string, string>;
}

/** ffmpeg (or ffprobe) is not installed where we looked. The message says what to do. */
export class FfmpegMissingError extends Error {
  constructor(tool: string, path: string) {
    super(
      `${tool} was not found (looked for "${path}"). Loom needs ffmpeg to turn DXV, HAP and ProRes into media the browser plays. `
      + "Install it (macOS: `brew install ffmpeg`; Linux: your package manager; Windows: `winget install ffmpeg`) "
      + `or pass --${tool} <path>.`,
    );
    this.name = "FfmpegMissingError";
  }
}

/** The platform's cache folder for proxies. */
export function defaultProxyCacheDir(): string {
  const env = process.env;
  if (platform() === "darwin") return join(homedir(), "Library", "Caches", "Loom", "proxies");
  if (platform() === "win32") return join(env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local"), "Loom", "proxies");
  return join(env["XDG_CACHE_HOME"] ?? join(homedir(), ".cache"), "loom", "proxies");
}

interface Run {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

function run(tool: string, command: string, args: readonly string[], onStdout?: (chunk: string) => void): Promise<Run> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (onStdout === undefined) stdout += chunk;
      else onStdout(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      // Keep the tail only: a failing encode can print a line per frame.
      stderr = (stderr + chunk).slice(-8_000);
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      reject(error.code === "ENOENT" ? new FfmpegMissingError(tool, command) : error);
    });
    child.on("close", (exitCode) => resolvePromise({ exitCode, stdout, stderr }));
  });
}

/** Throws `FfmpegMissingError` when either tool cannot be started. */
export async function checkFfmpeg(ffmpeg = "ffmpeg", ffprobe = "ffprobe"): Promise<void> {
  await run("ffmpeg", ffmpeg, ["-hide_banner", "-version"]);
  await run("ffprobe", ffprobe, ["-hide_banner", "-version"]);
}

/** HEVC with alpha when this is macOS and ffmpeg was built with VideoToolbox; VP9 otherwise. */
export async function preferredAlphaCodec(ffmpeg = "ffmpeg"): Promise<AlphaCodec> {
  if (platform() !== "darwin") return "vp9";
  const encoders = await run("ffmpeg", ffmpeg, ["-hide_banner", "-encoders"]);
  return /\bhevc_videotoolbox\b/.test(encoders.stdout) ? "hevc" : "vp9";
}

/** Probe one file: streams and format, plus the first DXV packet's tag when it is DXV. */
export async function probeMedia(path: string, ffprobe = "ffprobe"): Promise<ProbedMedia> {
  const probe = await run("ffprobe", ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  if (probe.exitCode !== 0) throw new Error(`ffprobe could not read the file: ${probe.stderr.trim() || `exit ${String(probe.exitCode)}`}`);
  const first = parseProbe(probe.stdout, null);
  if (first.video?.codecName !== "dxv") return first;
  const packet = await run("ffprobe", ffprobe,
    ["-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1", "-show_packets", "-show_data", "-of", "default", path]);
  const line = /^00000000: ([0-9a-f]{4}) ([0-9a-f]{4})/m.exec(packet.stdout);
  return parseProbe(probe.stdout, line === null ? null : dxvTagFromHex(`${line[1] ?? ""}${line[2] ?? ""}`));
}

/** sha256 of the whole file, streamed. */
export function hashFile(path: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolvePromise(hash.digest("hex")));
  });
}

/** Run `work` over `items` with at most `limit` in flight. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      await work(items[index] as T, index);
    }
  });
  await Promise.all(lanes);
}

/**
 * Probe, decide and (unless `dryRun`) transcode every path. Never throws for one bad file:
 * its error lands in `errors` and the rest carry on. Throws `FfmpegMissingError` up front
 * when ffmpeg or ffprobe is missing, before anything is hashed.
 */
export async function transcodeMedia(paths: readonly string[], options: TranscodeOptions = {}): Promise<TranscodeResult> {
  const ffmpeg = options.ffmpeg ?? "ffmpeg";
  const ffprobe = options.ffprobe ?? "ffprobe";
  await checkFfmpeg(ffmpeg, ffprobe);
  const alphaCodec = options.alpha === undefined || options.alpha === "auto" ? await preferredAlphaCodec(ffmpeg) : options.alpha;
  const cacheDir = resolve(options.cacheDir ?? defaultProxyCacheDir());
  mkdirSync(cacheDir, { recursive: true });
  const manifestPath = join(cacheDir, "manifest.json");
  const manifest: Manifest = parseManifest(existsSync(manifestPath) ? readFileSync(manifestPath, "utf8") : null);
  const entries = manifest.entries;
  const errors: Record<string, string> = {};
  const emit = options.onEvent ?? (() => undefined);
  const save = () => {
    const temporary = `${manifestPath}.${String(process.pid)}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`);
    renameSync(temporary, manifestPath);
  };
  const sources = [...new Set(paths.map((path) => resolve(path)))];
  const jobs = options.jobs ?? 2;
  // Two files with one hash encode once: the second waits on the first's promise.
  const inFlight = new Map<string, Promise<void>>();

  await pool(sources, jobs, async (source, index) => {
    try {
      emit({ type: "probe", source, index, total: sources.length });
      const stat = statSync(source);
      const known = entries[source];
      const hash = known !== undefined && known.size === stat.size && known.mtimeMs === stat.mtimeMs
        ? known.hash : await hashFile(source);
      const media = await probeMedia(source, ffprobe);
      const decision = decide(media, alphaCodec);
      const base = {
        size: stat.size, mtimeMs: stat.mtimeMs, hash, reason: decision.reason,
        codec: media.video === null ? "audio" : media.dxvTag === null ? media.video.codecName : `${media.video.codecName}/${media.dxvTag}`,
        width: media.video?.width ?? 0, height: media.video?.height ?? 0, duration: media.duration,
      };
      if (decision.action !== "proxy") {
        const entry: ManifestEntry = { ...base, decision: decision.action, proxy: null, alpha: false };
        entries[source] = entry;
        save();
        emit({ type: "decided", source, entry, cached: false });
        return;
      }
      const proxy = join(cacheDir, proxyFileName(hash, decision.kind));
      const planned: ManifestEntry = { ...base, decision: "proxy", proxy, alpha: decision.alpha };
      const pending = inFlight.get(proxy);
      if (pending !== undefined) await pending;
      if (existsSync(proxy)) {
        const reused = known?.proxy === proxy && known.encodeSeconds !== undefined ? { ...planned, encodeSeconds: known.encodeSeconds } : planned;
        entries[source] = reused;
        save();
        emit({ type: "decided", source, entry: reused, cached: true });
        return;
      }
      emit({ type: "decided", source, entry: planned, cached: false });
      if (options.dryRun === true) return;
      const encode = (async () => {
        const partial = `${proxy}.partial${decision.kind === "h264" ? ".mp4" : decision.kind === "hevcalpha" ? ".mov" : ".webm"}`;
        const started = performance.now();
        let buffer = "";
        const result = await run("ffmpeg", ffmpeg, proxyArgs(source, partial, decision.kind, media.hasAudio), (chunk) => {
          buffer += chunk;
          const blocks = buffer.split(/progress=\w+\n/);
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const seconds = progressSeconds(block);
            if (seconds !== null && media.duration > 0) {
              emit({ type: "progress", source, fraction: Math.min(1, seconds / media.duration) });
            }
          }
        });
        if (result.exitCode !== 0) {
          rmSync(partial, { force: true });
          throw new Error(`ffmpeg failed (exit ${String(result.exitCode)}): ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
        }
        renameSync(partial, proxy);
        const entry: ManifestEntry = { ...planned, encodeSeconds: (performance.now() - started) / 1000 };
        entries[source] = entry;
        save();
        emit({ type: "done", source, entry });
      })();
      inFlight.set(proxy, encode);
      try {
        await encode;
      } finally {
        inFlight.delete(proxy);
      }
    } catch (error) {
      if (error instanceof FfmpegMissingError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      errors[source] = message;
      emit({ type: "error", source, message });
    }
  });
  return { cacheDir, manifestPath, entries: { ...entries }, errors };
}

function parseArgs(argv: readonly string[]): { paths: string[]; options: TranscodeOptions } | string {
  const paths: string[] = [];
  const options: { -readonly [K in keyof TranscodeOptions]: TranscodeOptions[K] } = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const value = (): string => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    if (arg === "--cache") options.cacheDir = value();
    else if (arg === "--jobs") options.jobs = Math.max(1, Number.parseInt(value(), 10) || 1);
    else if (arg === "--ffmpeg") options.ffmpeg = value();
    else if (arg === "--ffprobe") options.ffprobe = value();
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--alpha") {
      const codec = value();
      if (codec !== "hevc" && codec !== "vp9" && codec !== "auto") throw new Error("--alpha takes hevc, vp9 or auto");
      options.alpha = codec;
    }
    else if (arg === "--help" || arg === "-h") return "usage";
    else paths.push(arg);
  }
  return { paths, options };
}

async function main(argv: readonly string[]): Promise<number> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
  if (typeof parsed === "string" || parsed.paths.length === 0) {
    process.stdout.write("usage: transcode-media.ts [--cache <dir>] [--jobs <n>] [--ffmpeg <path>] [--ffprobe <path>] [--alpha auto|hevc|vp9] [--dry-run] <file>…\n");
    return typeof parsed === "string" ? 0 : 2;
  }
  const lastShown = new Map<string, number>();
  try {
    const result = await transcodeMedia(parsed.paths, {
      ...parsed.options,
      onEvent: (event) => {
        const name = basename(event.source);
        if (event.type === "decided") {
          const what = event.entry.decision === "proxy"
            ? `${event.cached ? "cached" : "proxy"} ${basename(event.entry.proxy ?? "").replace(/^.*-r\d+-|\..*$/g, "")}` : event.entry.decision;
          process.stdout.write(`${name}: ${what} (${event.entry.reason})\n`);
        } else if (event.type === "progress") {
          const percent = Math.floor(event.fraction * 10) * 10;
          if ((lastShown.get(event.source) ?? -1) < percent) {
            lastShown.set(event.source, percent);
            process.stdout.write(`${name}: ${String(percent)}%\n`);
          }
        } else if (event.type === "done") {
          process.stdout.write(`${name}: done in ${(event.entry.encodeSeconds ?? 0).toFixed(1)} s → ${event.entry.proxy ?? ""}\n`);
        } else if (event.type === "error") {
          process.stderr.write(`${name}: FAILED: ${event.message}\n`);
        }
      },
    });
    process.stdout.write(`manifest: ${result.manifestPath}\n`);
    return Object.keys(result.errors).length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof FfmpegMissingError ? 3 : 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}
