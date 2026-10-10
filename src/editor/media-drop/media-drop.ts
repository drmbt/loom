import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { AssetReference, GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { nodeNames } from "@domain/graph/names.ts";
import { kindOfType, roleFromText, withKind } from "@domain/graph/node-kinds.ts";
import { pictureFileKind } from "@domain/media/picture-file.ts";
import type { RetainedFileHandle, RetainedFiles } from "@ui/files/retained-files.ts";
import { containerVerdict } from "./container-codec.ts";

/**
 * VN99 — MEDIA FILES DROPPED ON THE CANVAS (and, VN64, on the timeline).
 *
 * A video, a still or an audio file becomes a `movieFileIn` / `audioFileIn` holding the
 * file the way the inspector's picker holds it: a File System Access handle is RETAINED
 * (`retainedFiles().remember`, so the reference survives a reload in this profile), and
 * where the host gives no handle the file falls back to a session `blob:` URL, the same
 * fallback the picker's `<input type=file>` path takes. Every node of one drop is ONE
 * `graph.applyPatch`, so one undo removes the drop.
 *
 * Three steps, because the browser's rules force the first one:
 *  1. `captureDroppedFiles` runs INSIDE the drop event. `DataTransferItem`s are emptied as
 *     soon as the handler returns, so the handle request has to start synchronously.
 *  2. `resolveDroppedMedia` (async) sniffs each movie's codec, refusing the ones Chromium
 *     cannot decode by name, and retains the rest.
 *  3. `mediaDropOperations` (pure) turns the resolved files into the patch.
 */

/** What a dropped file is to Loom. */
export type DroppedKind = "video" | "still" | "audio" | "component" | "other";

const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "mov", "webm", "ogv", "mkv", "avi", "mxf", "qt"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "wave", "ogg", "oga", "opus", "m4a", "aac", "flac", "aif", "aiff"]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 || dot === name.length - 1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** The MIME type when the host gives one, the extension otherwise. */
export function classifyDroppedFile(name: string, mime: string): DroppedKind {
  const extension = extensionOf(name);
  if (extension === "json") return "component";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (AUDIO_EXTENSIONS.has(extension)) return "audio";
  if (mime.startsWith("image/") || pictureFileKind(`#${name}`) !== "video") return "still";
  return "other";
}

/** One dropped file, and the handle request started while the event was live. */
export interface CapturedFile {
  readonly file: File;
  readonly handle: Promise<RetainedFileHandle | null>;
}

interface HandleItem {
  readonly kind: string;
  getAsFile(): File | null;
  getAsFileSystemHandle?: () => Promise<unknown>;
}

/** Synchronous: call from inside the drop handler. Items when the host has them, else `files`. */
export function captureDroppedFiles(transfer: { readonly items?: unknown; readonly files?: ArrayLike<File> | null }): CapturedFile[] {
  const items = transfer.items as ArrayLike<HandleItem> | undefined;
  const captured: CapturedFile[] = [];
  if (items !== undefined && items !== null && typeof items.length === "number" && items.length > 0) {
    for (const item of Array.from(items)) {
      if (item.kind !== "file") continue;
      const file = item.getAsFile();
      if (file === null) continue;
      let handle: Promise<RetainedFileHandle | null> = Promise.resolve(null);
      try {
        const requested = item.getAsFileSystemHandle?.();
        if (requested !== undefined) {
          handle = requested.then(
            (value) => (isFileHandle(value) ? value : null),
            () => null,
          );
        }
      } catch {
        // A host that throws here (no File System Access) gets the session fallback.
      }
      captured.push({ file, handle });
    }
    if (captured.length > 0) return captured;
  }
  return Array.from(transfer.files ?? []).map((file) => ({ file, handle: Promise.resolve(null) }));
}

function isFileHandle(value: unknown): value is RetainedFileHandle {
  return typeof value === "object" && value !== null
    && (value as { kind?: unknown }).kind === "file"
    && typeof (value as { getFile?: unknown }).getFile === "function"
    && typeof (value as { queryPermission?: unknown }).queryPermission === "function";
}

/** A media file ready to become a node: its kind and the reference its `file` holds. */
export interface ResolvedMedia {
  readonly name: string;
  readonly kind: "video" | "still" | "audio";
  readonly reference: string;
  /** True when the reference is a retained handle; false for the session-only `blob:` fallback. */
  readonly retained: boolean;
}

export interface MediaDropEnvironment {
  readonly files: Pick<RetainedFiles, "remember"> | null;
  readonly createObjectURL: (file: File) => string;
}

export interface ResolvedDrop {
  readonly media: readonly ResolvedMedia[];
  readonly components: readonly File[];
  readonly refusals: readonly RuntimeDiagnostic[];
}

/** The sentence a refused movie gets. Exported so the timeline's drop says the same thing. */
export function transcodeFirstMessage(fileName: string, what: string): string {
  return `"${fileName}" holds ${what}, which the browser cannot decode. Transcode it first (H.264 or VP9 in .mp4/.webm), then drop the result.`;
}

/** Async: classify, sniff each movie's codec, retain what will play. */
export async function resolveDroppedMedia(captured: readonly CapturedFile[], environment: MediaDropEnvironment): Promise<ResolvedDrop> {
  const media: ResolvedMedia[] = [];
  const components: File[] = [];
  const refusals: RuntimeDiagnostic[] = [];
  for (const { file, handle } of captured) {
    const kind = classifyDroppedFile(file.name, file.type ?? "");
    if (kind === "component") {
      components.push(file);
      continue;
    }
    if (kind === "other") {
      refusals.push({
        severity: "error",
        code: "media.drop.unsupported",
        message: `"${file.name}" is not a video, image, audio or .loom.json component file, so nothing was made from it.`,
      });
      continue;
    }
    if (kind === "video") {
      const verdict = await containerVerdict(file).catch(() => ({ playable: true as const }));
      if (!verdict.playable) {
        refusals.push({ severity: "error", code: "media.drop.transcodeFirst", message: transcodeFirstMessage(file.name, verdict.what) });
        continue;
      }
    }
    const referenceKind: AssetReference["kind"] = kind === "still" ? "image" : kind;
    const retainedHandle = await handle;
    let reference: string | null = null;
    if (retainedHandle !== null && environment.files !== null) {
      reference = await environment.files.remember(retainedHandle, referenceKind).catch(() => null);
    }
    media.push(reference !== null
      ? { name: file.name, kind, reference, retained: true }
      : { name: file.name, kind, reference: `${environment.createObjectURL(file)}#${encodeURIComponent(file.name)}`, retained: false });
  }
  return { media, components, refusals };
}

/** The node type a medium becomes. */
export function mediaNodeType(kind: ResolvedMedia["kind"]): "movieFileIn" | "audioFileIn" {
  return kind === "audio" ? "audioFileIn" : "movieFileIn";
}

/**
 * `movie_<file>` / `audiofile_<file>`: the kind, then the file's name without its extension
 * as the role, lowercased; the next free number after it when the name is taken (in the
 * graph, or by an earlier file of the same drop). A name with nothing a role can hold is
 * left to the patch's own numbering (`movie1`).
 */
export function mediaNodeName(fileName: string, type: string, taken: Set<string>): string | undefined {
  const dot = fileName.lastIndexOf(".");
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const role = roleFromText(stem).toLowerCase();
  if (role === "") return undefined;
  const base = withKind(kindOfType(type), role);
  let name = base;
  for (let ordinal = 2; taken.has(name); ordinal += 1) name = `${base}${ordinal}`;
  taken.add(name);
  return name;
}

/** How far apart the nodes of one drop land, side by side, in graph units. */
export const MEDIA_DROP_SPACING = 240;

/**
 * The patch for one drop: a node per file at the drop point, laid out left to right, each
 * holding its file and locked to the timeline (so a scrub finds the same frame and a render
 * reproduces, §V436). Refs are `$media0`, `$media1`, … in file order.
 */
export function mediaDropOperations(
  graph: GraphDocument,
  media: readonly ResolvedMedia[],
  at: { readonly x: number; readonly y: number },
  extra: Readonly<Record<string, unknown>> = {},
): GraphPatchOperation[] {
  const taken = new Set(nodeNames(graph).keys());
  return media.map((each, index) => {
    const type = mediaNodeType(each.kind);
    const label = mediaNodeName(each.name, type, taken);
    const parameters: Record<string, unknown> = { file: each.reference, ...extra };
    if (each.kind !== "still") parameters["playMode"] = "timeline";
    return {
      op: "addNode",
      ref: `$media${index}`,
      type,
      position: { x: at.x + index * MEDIA_DROP_SPACING, y: at.y },
      parameters,
      ...(label === undefined ? {} : { label }),
    } as GraphPatchOperation;
  });
}

/** The label a drop's patch carries in the undo history. */
export function mediaDropLabel(media: readonly ResolvedMedia[]): string {
  return media.length === 1 ? `Drop ${media[0]!.name}` : `Drop ${media.length} media files`;
}
