import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platform } from "node:os";
import { FfmpegMissingError, transcodeMedia, type TranscodeEvent } from "./transcode-media.ts";

/**
 * VN103 — the tool against REAL ffmpeg, on fixtures generated here (a 1 s DXV DXT1 clip, a
 * ProRes 4444 clip with half alpha, an H.264 clip). Nothing is committed and nothing lands in
 * the repository: fixtures and proxies live in a temp folder removed afterwards.
 *
 * Skipped, with the reason, where ffmpeg is not installed (upstream CI may lack it); the
 * missing-ffmpeg report itself is asserted either way.
 */
const HAVE_FFMPEG = spawnSync("ffmpeg", ["-hide_banner", "-version"]).status === 0
  && spawnSync("ffprobe", ["-hide_banner", "-version"]).status === 0;

/** The first frame's centre pixel as RGBA bytes, decoded by ffmpeg. */
function centrePixel(path: string, decoder: string[] = []): number[] {
  const raw = execFileSync("ffmpeg", ["-v", "error", ...decoder, "-i", path, "-frames:v", "1",
    "-vf", "crop=2:2:(iw-2)/2:(ih-2)/2,format=rgba", "-f", "rawvideo", "-"]);
  return [...raw.subarray(0, 4)];
}

describe.skipIf(!HAVE_FFMPEG)("VN103 transcode tool (needs ffmpeg on PATH)", () => {
  let dir = "";
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "loom-vn103-"));
    const ff = (...args: string[]) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args]);
    ff("-f", "lavfi", "-i", "color=red:s=64x48:d=1:r=30", "-c:v", "dxv", join(dir, "red-dxt1.mov"));
    ff("-f", "lavfi", "-i", "color=0x2040ff@0.5:s=64x48:d=1:r=30,format=yuva444p10le",
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le", join(dir, "blue-alpha.mov"));
    ff("-f", "lavfi", "-i", "color=green:s=64x48:d=1:r=30", "-c:v", "libx264", "-pix_fmt", "yuv420p", join(dir, "green.mp4"));
    copyFileSync(join(dir, "red-dxt1.mov"), join(dir, "red-copy.mov"));
  });
  afterAll(() => {
    if (dir !== "") rmSync(dir, { recursive: true, force: true });
  });

  it("proxies DXV to H.264 and alpha ProRes to VP9 with alpha, keeps H.264, and reuses by content", async () => {
    const cache = join(dir, "cache");
    const events: TranscodeEvent[] = [];
    const sources = ["red-dxt1.mov", "blue-alpha.mov", "green.mp4", "red-copy.mov"].map((name) => join(dir, name));
    const result = await transcodeMedia(sources, { cacheDir: cache, jobs: 2, alpha: "vp9", onEvent: (event) => events.push(event) });
    expect(result.errors).toEqual({});

    const dxv = result.entries[join(dir, "red-dxt1.mov")];
    expect(dxv).toMatchObject({ decision: "proxy", alpha: false, codec: "dxv/DXT1" });
    expect(dxv?.proxy).toMatch(/-r1-h264\.mp4$/);
    // The duplicate encodes ONCE: same hash, same proxy.
    expect(result.entries[join(dir, "red-copy.mov")]?.proxy).toBe(dxv?.proxy);
    expect(events.filter((event) => event.type === "done")).toHaveLength(2);
    expect(events.some((event) => event.type === "progress")).toBe(true);

    const alpha = result.entries[join(dir, "blue-alpha.mov")];
    expect(alpha).toMatchObject({ decision: "proxy", alpha: true });
    expect(alpha?.proxy).toMatch(/-r1-vp9alpha\.webm$/);
    expect(result.entries[join(dir, "green.mp4")]).toMatchObject({ decision: "keep", proxy: null });

    // What a consumer reads back: the proxy's pixels. Red stays red; the alpha clip keeps half alpha
    // (libvpx-vp9 is the decoder that reads the WebM alpha plane, as Chromium's does).
    const [r, g, b] = centrePixel(dxv?.proxy ?? "");
    expect(r).toBeGreaterThan(230);
    expect(g).toBeLessThan(25);
    expect(b).toBeLessThan(25);
    const pixel = centrePixel(alpha?.proxy ?? "", ["-c:v", "libvpx-vp9"]);
    expect(Math.abs((pixel[3] ?? 0) - 128)).toBeLessThanOrEqual(3);
    expect(pixel[2]).toBeGreaterThan(200);

    // The manifest on disk says the same.
    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as { entries: Record<string, { proxy: string | null }> };
    expect(manifest.entries[join(dir, "red-dxt1.mov")]?.proxy).toBe(dxv?.proxy);

    // A second run encodes nothing: every proxy is found by its content hash.
    const again: TranscodeEvent[] = [];
    await transcodeMedia(sources, { cacheDir: cache, alpha: "vp9", onEvent: (event) => again.push(event) });
    expect(again.filter((event) => event.type === "done")).toHaveLength(0);
    expect(again.filter((event) => event.type === "decided" && event.cached)).toHaveLength(3);
  }, 60_000);

  // The macOS default: VideoToolbox HEVC with alpha. FFmpeg 9's own HEVC decoder reads the
  // alpha layer back, so the pixel is checked the same way as the VP9 one.
  it.skipIf(platform() !== "darwin" || spawnSync("ffmpeg", ["-hide_banner", "-encoders"]).stdout.toString().indexOf("hevc_videotoolbox") < 0)(
    "on macOS, alpha defaults to HEVC with alpha in a .mov, and the alpha survives", async () => {
      const result = await transcodeMedia([join(dir, "blue-alpha.mov")], { cacheDir: join(dir, "hevc") });
      const entry = result.entries[join(dir, "blue-alpha.mov")];
      expect(entry?.proxy).toMatch(/-r1-hevcalpha\.mov$/);
      const pixel = centrePixel(entry?.proxy ?? "");
      expect(Math.abs((pixel[3] ?? 0) - 128)).toBeLessThanOrEqual(4);
      expect(pixel[2]).toBeGreaterThan(200);
    }, 60_000);

  it("a file ffprobe cannot read is reported by name; the rest carry on", async () => {
    const result = await transcodeMedia([join(dir, "missing.mov"), join(dir, "green.mp4")], { cacheDir: join(dir, "cache2") });
    expect(Object.keys(result.errors)).toEqual([join(dir, "missing.mov")]);
    expect(result.entries[join(dir, "green.mp4")]?.decision).toBe("keep");
  });

  it("a dry run decides and writes no proxy", async () => {
    const cache = join(dir, "dry");
    const events: TranscodeEvent[] = [];
    await transcodeMedia([join(dir, "red-dxt1.mov")], { cacheDir: cache, dryRun: true, onEvent: (event) => events.push(event) });
    const decided = events.find((event) => event.type === "decided");
    expect(decided?.type === "decided" && decided.entry.proxy !== null && !existsSync(decided.entry.proxy)).toBe(true);
  });
});

describe("VN103 transcode tool without ffmpeg", () => {
  it("says ffmpeg is missing, by name, with how to install it", async () => {
    const error = await transcodeMedia(["/nowhere.mov"], {
      ffmpeg: "/definitely/not/ffmpeg", cacheDir: join(tmpdir(), "loom-vn103-unused"),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FfmpegMissingError);
    expect(String((error as Error).message)).toMatch(/ffmpeg was not found .*brew install ffmpeg/);
  });
});
