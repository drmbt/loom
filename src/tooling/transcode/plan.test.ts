import { describe, expect, it } from "vitest";
import {
  decide,
  dxvTagFromHex,
  parseManifest,
  parseProbe,
  pixFmtHasAlpha,
  progressSeconds,
  proxyArgs,
  proxyFileName,
  type ProbedMedia,
} from "./plan.ts";

const media = (codecName: string, pixFmt: string, extra: Partial<ProbedMedia> = {}, codecTag = ""): ProbedMedia => ({
  video: { codecName, codecTag, pixFmt, width: 1920, height: 1080 },
  hasAudio: false,
  duration: 10,
  formatName: "mov,mp4,m4a,3gp,3g2,mj2",
  dxvTag: null,
  ...extra,
});

describe("VN103 plan: what Chromium plays, and what the rest becomes", () => {
  it("reads the DXV tag the way FFmpeg does (a little-endian fourcc)", () => {
    // The first bytes of a real DXV3 DXT1 packet: `1TXD`.
    expect(dxvTagFromHex("3154 5844 0400 0000")).toBe("DXT1");
    expect(dxvTagFromHex("35545844")).toBe("DXT5");
    expect(dxvTagFromHex("36474359")).toBe("YCG6");
    expect(dxvTagFromHex("30314759")).toBe("YG10");
    expect(dxvTagFromHex("3154")).toBeNull();
  });

  it("DXV: DXT1 and YCG6 are opaque → H.264; DXT5, YG10 and an unread tag keep alpha → VP9", () => {
    // FFmpeg reports `rgba` for every DXV variant, which is why the tag decides and not the pixel format.
    expect(decide(media("dxv", "rgba", { dxvTag: "DXT1" }))).toMatchObject({ action: "proxy", kind: "h264", alpha: false });
    expect(decide(media("dxv", "rgba", { dxvTag: "YCG6" }))).toMatchObject({ action: "proxy", kind: "h264" });
    expect(decide(media("dxv", "rgba", { dxvTag: "DXT5" }))).toMatchObject({ action: "proxy", kind: "vp9alpha", alpha: true });
    expect(decide(media("dxv", "rgba", { dxvTag: "YG10" }))).toMatchObject({ action: "proxy", kind: "vp9alpha" });
    expect(decide(media("dxv", "rgba", { dxvTag: null }))).toMatchObject({ action: "proxy", kind: "vp9alpha" });
  });

  it("alpha goes to HEVC (.mov, VideoToolbox) when asked, opaque stays H.264 either way", () => {
    expect(decide(media("dxv", "rgba", { dxvTag: "DXT5" }), "hevc")).toMatchObject({ kind: "hevcalpha", alpha: true });
    expect(decide(media("dxv", "rgba", { dxvTag: "DXT1" }), "hevc")).toMatchObject({ kind: "h264" });
    expect(proxyFileName("b".repeat(64), "hevcalpha")).toBe(`${"b".repeat(32)}-r1-hevcalpha.mov`);
    expect(proxyArgs("/in.mov", "/out.mov", "hevcalpha", false))
      .toEqual(expect.arrayContaining(["hevc_videotoolbox", "bgra", "-alpha_quality", "hvc1", "-an"]));
  });

  it("HAP: the fourcc decides alpha (Hap1/HapY opaque; Hap5/HapM/HapA alpha)", () => {
    expect(decide(media("hap", "rgb0", {}, "Hap1"))).toMatchObject({ kind: "h264" });
    expect(decide(media("hap", "rgba", {}, "HapY"))).toMatchObject({ kind: "h264" });
    expect(decide(media("hap", "rgba", {}, "Hap5"))).toMatchObject({ kind: "vp9alpha" });
    expect(decide(media("hap", "rgba", {}, "HapM"))).toMatchObject({ kind: "vp9alpha" });
  });

  it("ProRes: 4444 with alpha → VP9, 422 and 4444 without → H.264", () => {
    expect(decide(media("prores", "yuva444p12le", {}, "ap4h"))).toMatchObject({ kind: "vp9alpha" });
    expect(decide(media("prores", "yuv444p12le", {}, "ap4h"))).toMatchObject({ kind: "h264" });
    expect(decide(media("prores", "yuv422p10le", {}, "apcn"))).toMatchObject({ kind: "h264" });
    expect(decide(media("qtrle", "argb"))).toMatchObject({ kind: "vp9alpha" });
    expect(decide(media("qtrle", "rgb24"))).toMatchObject({ kind: "h264" });
  });

  it("leaves what Chromium plays alone, but not 10-bit or 4:2:2 H.264", () => {
    for (const codec of ["h264", "hevc", "vp8", "vp9", "av1"]) {
      expect(decide(media(codec, "yuv420p")).action).toBe("keep");
    }
    expect(decide(media("hevc", "yuv420p10le")).action).toBe("keep");
    expect(decide(media("h264", "yuv422p10le"))).toMatchObject({ action: "proxy", kind: "h264" });
    expect(decide(media("png", "rgba", { formatName: "png_pipe" })).action).toBe("keep");
    expect(decide(media("mjpeg", "yuvj420p", { formatName: "jpeg_pipe" })).action).toBe("keep");
    // A PNG-in-MOV (a QuickTime PNG movie) is NOT a still: it is a movie Chromium cannot play.
    expect(decide(media("png", "rgba"))).toMatchObject({ action: "proxy", kind: "vp9alpha" });
  });

  it("audio-only is kept; nothing at all is refused", () => {
    expect(decide({ video: null, hasAudio: true, duration: 3, formatName: "wav", dxvTag: null }).action).toBe("keep");
    expect(decide({ video: null, hasAudio: false, duration: 0, formatName: "data", dxvTag: null }).action).toBe("refuse");
  });

  it("names a proxy by hash, recipe and kind", () => {
    const hash = "a".repeat(64);
    expect(proxyFileName(hash, "h264")).toBe(`${"a".repeat(32)}-r1-h264.mp4`);
    expect(proxyFileName(hash, "vp9alpha")).toBe(`${"a".repeat(32)}-r1-vp9alpha.webm`);
  });

  it("builds the encoder arguments for each kind, audio optional", () => {
    const h264 = proxyArgs("/in.mov", "/out.mp4", "h264", false);
    expect(h264).toEqual(expect.arrayContaining(["libx264", "yuv420p", "+faststart", "-an"]));
    expect(h264.at(-1)).toBe("/out.mp4");
    const vp9 = proxyArgs("/in.mov", "/out.webm", "vp9alpha", true);
    expect(vp9).toEqual(expect.arrayContaining(["libvpx-vp9", "yuva420p", "libopus", "0:a:0"]));
    expect(vp9).not.toContain("-an");
  });

  it("parses ffprobe JSON, skipping attached cover pictures", () => {
    const json = JSON.stringify({
      streams: [
        { codec_type: "video", codec_name: "mjpeg", disposition: { attached_pic: 1 } },
        { codec_type: "video", codec_name: "dxv", codec_tag_string: "DXD3", pix_fmt: "rgba", width: 64, height: 48 },
        { codec_type: "audio", codec_name: "pcm_s16le" },
      ],
      format: { duration: "1.000000", format_name: "mov,mp4" },
    });
    expect(parseProbe(json, "DXT1")).toEqual({
      video: { codecName: "dxv", codecTag: "DXD3", pixFmt: "rgba", width: 64, height: 48 },
      hasAudio: true, duration: 1, formatName: "mov,mp4", dxvTag: "DXT1",
    });
  });

  it("reads progress in seconds from either key (out_time_ms is microseconds too)", () => {
    expect(progressSeconds("frame=3\nout_time_us=1500000\n")).toBe(1.5);
    expect(progressSeconds("out_time_ms=250000\n")).toBe(0.25);
    expect(progressSeconds("frame=3\n")).toBeNull();
  });

  it("alpha pixel formats", () => {
    expect(["rgba", "yuva420p", "gbrap10le", "ya8", "argb", "bgra"].every(pixFmtHasAlpha)).toBe(true);
    expect(["rgb24", "yuv420p", "gbrp", "rgb0", "nv12"].some(pixFmtHasAlpha)).toBe(false);
  });

  it("a manifest that is not one reads as empty rather than throwing", () => {
    expect(parseManifest(null).entries).toEqual({});
    expect(parseManifest("{not json").entries).toEqual({});
    expect(parseManifest(JSON.stringify({ version: 2, entries: {} })).entries).toEqual({});
  });
});
