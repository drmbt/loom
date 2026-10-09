import type { Mp4Container } from "./mp4-muxer.ts";

/**
 * VN104 — the container a render is written in: QuickTime `.mov`.
 *
 * The box tree is the same as the `.mp4` the renderer wrote before (H.264 + AAC), and ffprobe
 * reads the `tmcd` start timecode from either. `.mov` is chosen because the timecode track is
 * a QuickTime construct (QuickTime, Resolve, Premiere and Final Cut read it natively from a
 * `.mov`), because Resolume's own media (DXV, HAP, ProRes) is `.mov`, and because a later
 * DXV output can only be `.mov`. Chromium plays H.264 in `.mov`, so a render re-imports.
 */
export const RENDER_CONTAINER: Mp4Container = "mov";

export interface RenderContainerFile {
  readonly extension: string;
  readonly mime: string;
  readonly pickerTypes: ReadonlyArray<{
    readonly description: string;
    readonly accept: Readonly<Record<string, readonly string[]>>;
  }>;
}

/** The file name extension, mime type and save-picker filter for a container. */
export function renderContainerFile(container: Mp4Container): RenderContainerFile {
  return container === "mov"
    ? { extension: ".mov", mime: "video/quicktime", pickerTypes: [{ description: "QuickTime movie", accept: { "video/quicktime": [".mov"] } }] }
    : { extension: ".mp4", mime: "video/mp4", pickerTypes: [{ description: "MPEG-4 video", accept: { "video/mp4": [".mp4"] } }] };
}
