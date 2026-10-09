import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";

/**
 * VN104 — a rendered file carries its start timecode where readers look for it. The take is
 * encoded by the shipped WebCodecs encoder and muxer in the browser, then read back OUTSIDE
 * Loom by ffprobe (the reader Resolve, Resolume's tooling and most pipelines share). Needs
 * `ffprobe` on PATH; it fails, never skips, without it.
 */

interface Case {
  readonly fps: number;
  readonly text: string;
  readonly container: "mov" | "mp4";
  readonly audio: boolean;
}

async function encode(page: import("@playwright/test").Page, input: Case): Promise<number[]> {
  return page.evaluate(async ({ fps, text, container, audio }) => {
    const modulePath = "/src/runtime/export/recording/webcodecs.ts";
    const timecodePath = "/src/runtime/export/recording/start-timecode.ts";
    const { createWebCodecsEncoder } = await import(/* @vite-ignore */ modulePath) as typeof import(
      "../../runtime/export/recording/webcodecs.ts"
    );
    const { parseStartTimecode } = await import(/* @vite-ignore */ timecodePath) as typeof import(
      "../../runtime/export/recording/start-timecode.ts"
    );
    const start = parseStartTimecode(text, fps);
    if ("error" in start) throw new Error(start.error);
    const soundtrack = Float32Array.from({ length: 4800 }, (_v, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000) * 0.5);
    const encoder = createWebCodecsEncoder({
      bitrate: 200_000,
      spool: "memory",
      timecode: start,
      container,
      ...(audio ? { audio: () => ({ sampleRate: 48_000, channelCount: 1, samples: soundtrack }) } : {}),
    });
    await encoder.configure({ width: 64, height: 64, fps });
    for (let frame = 0; frame < 3; frame += 1) {
      await encoder.encode({
        image: { width: 64, height: 64, data: new Uint8Array(64 * 64 * 4).fill(frame * 60) },
        frameIndex: frame,
        timestampMicros: Math.round((frame * 1_000_000) / fps),
        durationMicros: Math.round(1_000_000 / fps),
        keyFrame: frame === 0,
      });
    }
    const output = await encoder.finish();
    const bytes = output.bytes instanceof Blob ? new Uint8Array(await output.bytes.arrayBuffer()) : output.bytes;
    return Array.from(bytes);
  }, input);
}

function probe(path: string): { streams: Array<{ codec_type: string; codec_tag_string: string; tags?: { timecode?: string } }>; format: { format_name: string } } {
  return JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", path], { encoding: "utf8" })) as ReturnType<typeof probe>;
}

const CASES: ReadonlyArray<Case> = [
  { fps: 30000 / 1001, text: "01:00:00;02", container: "mov", audio: true },
  { fps: 30000 / 1001, text: "00:09:59;29", container: "mp4", audio: false },
  { fps: 25, text: "10:20:30:12", container: "mov", audio: false },
  { fps: 60, text: "23:59:59:59", container: "mp4", audio: true },
];

test("an exported take reports its start timecode to ffprobe, drop-frame included", async ({ page }) => {
  await page.goto("/");
  const directory = mkdtempSync(join(tmpdir(), "loom-tc-"));
  try {
    for (const input of CASES) {
      const path = join(directory, `take.${input.container}`);
      writeFileSync(path, Uint8Array.from(await encode(page, input)));
      const probed = probe(path);
      const video = probed.streams.find((stream) => stream.codec_type === "video");
      const data = probed.streams.find((stream) => stream.codec_tag_string === "tmcd");
      expect(video?.tags?.timecode, `${input.text} in .${input.container}`).toBe(input.text);
      expect(data?.tags?.timecode).toBe(input.text);
      expect(probed.format.format_name).toContain("mov");
      if (input.audio) expect(probed.streams.some((stream) => stream.codec_type === "audio")).toBe(true);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
