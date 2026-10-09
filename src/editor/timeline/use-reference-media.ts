import { useCallback, useEffect, useMemo, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { FrameRange, GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { timelineReferenceOf, type TimelineReference } from "@domain/media/timeline-reference.ts";
import { retainedFiles, type RetainedFileHandle } from "@ui/files/retained-files.ts";
import { captureDroppedFiles, resolveDroppedMedia, type CapturedFile } from "../media-drop/media-drop.ts";
import type { DrawWaveform } from "./timeline-draw.ts";
import { waveformPeaksFor } from "./waveform-loader.ts";
import type { WaveformPeaks } from "./waveform-peaks.ts";
import {
  adoptReferenceOperations,
  mediaSecondsMapper,
  rangeFromMedia,
  referenceCandidates,
  referenceDropOperations,
  referenceFile,
} from "./reference-media.ts";

/**
 * VN64 — the timeline pane's reference media: which node it is, its waveform, and the
 * gestures that set it (a file dropped on the pane, "Reference media…", adopting a node,
 * "Set project length from media"). Every write is one command on the bus.
 */

export type PeaksState =
  | { readonly kind: "none" }
  | { readonly kind: "loading"; readonly file: string }
  | { readonly kind: "ready"; readonly file: string; readonly peaks: WaveformPeaks }
  | { readonly kind: "failed"; readonly file: string; readonly message: string };

export interface ReferenceMedia {
  readonly reference: TimelineReference | null;
  readonly candidates: ReadonlyArray<{ nodeId: NodeId; name: string }>;
  readonly peaks: PeaksState;
  readonly waveform: DrawWaveform | null;
  readonly notice: string | null;
  readonly clearNotice: () => void;
  readonly onDragOver: (event: ReactDragEvent<HTMLElement>) => void;
  readonly onDrop: (event: ReactDragEvent<HTMLElement>) => void;
  readonly pickFile: () => void;
  readonly adopt: (nodeId: NodeId) => void;
  readonly setLengthFromMedia: () => void;
}

export interface ReferenceMediaOptions {
  readonly graph: GraphDocument;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  readonly fps: number;
  readonly range: FrameRange;
  /** Injected in tests: the peaks of a file. Defaults to the decoding loader. */
  readonly loadPeaks?: (file: string) => Promise<WaveformPeaks>;
}

const isFileDrag = (event: ReactDragEvent<HTMLElement>): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

type PickerWindow = { showOpenFilePicker?: (options: unknown) => Promise<RetainedFileHandle[]> };

export function useReferenceMedia(options: ReferenceMediaOptions): ReferenceMedia {
  const { graph, bus, invocation, fps, range } = options;
  const loadPeaks = options.loadPeaks ?? waveformPeaksFor;
  const reference = useMemo(() => timelineReferenceOf(graph), [graph]);
  const candidates = useMemo(() => referenceCandidates(graph), [graph]);
  const file = referenceFile(graph, reference);
  const [peaks, setPeaks] = useState<PeaksState>({ kind: "none" });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (file === null) {
      setPeaks({ kind: "none" });
      return;
    }
    let live = true;
    setPeaks({ kind: "loading", file });
    loadPeaks(file).then(
      (loaded) => { if (live) setPeaks({ kind: "ready", file, peaks: loaded }); },
      (error: unknown) => { if (live) setPeaks({ kind: "failed", file, message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { live = false; };
  }, [file, loadPeaks]);

  const ready = peaks.kind === "ready" && peaks.file === file ? peaks.peaks : null;
  const waveform = useMemo<DrawWaveform | null>(
    () => (reference === null || ready === null ? null : { peaks: ready, mediaSecondsAt: mediaSecondsMapper(graph, reference, ready.durationSeconds) }),
    [graph, ready, reference],
  );

  const apply = useCallback(
    async (operations: GraphPatchOperation[], label: string): Promise<boolean> => {
      if (operations.length === 0) return false;
      const result = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations, label }, invocation);
      if (result.status !== "applied") {
        setNotice(result.diagnostics[0]?.message ?? "The reference media change was refused.");
        return false;
      }
      return true;
    },
    [bus, invocation],
  );

  const takeFiles = useCallback(
    async (captured: readonly CapturedFile[]) => {
      const resolved = await resolveDroppedMedia(captured, {
        files: typeof indexedDB === "undefined" ? null : retainedFiles(),
        createObjectURL: (file_) => URL.createObjectURL(file_),
      });
      const first = resolved.media[0];
      const messages = [
        ...resolved.refusals.map((each) => each.message),
        ...(resolved.components.length > 0 ? ["A component file goes on the canvas, not the timeline."] : []),
        ...(resolved.media.length > 1 ? [`The timeline takes one reference file; it took "${first!.name}".`] : []),
        ...(first?.kind === "still" ? [`"${first.name}" is a still image, which has no time to score against.`] : []),
      ];
      setNotice(messages.length === 0 ? null : messages.join(" "));
      if (first === undefined || first.kind === "still") return;
      await apply(referenceDropOperations(graph, first), `Reference media ${first.name}`);
    },
    [apply, graph],
  );

  const onDragOver = useCallback((event: ReactDragEvent<HTMLElement>) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      if (!isFileDrag(event)) return;
      // Inside the event: the browser empties the items when it returns.
      const captured = captureDroppedFiles(event.dataTransfer);
      if (captured.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      void takeFiles(captured);
    },
    [takeFiles],
  );

  const pickFile = useCallback(() => {
    const picker = (window as unknown as PickerWindow).showOpenFilePicker;
    if (picker !== undefined) {
      void picker.call(window, {
        multiple: false,
        types: [{ description: "Reference media", accept: { "video/*": [".mp4", ".m4v", ".mov", ".webm"], "audio/*": [".mp3", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".aif", ".aiff"] } }],
      }).then(async (handles) => {
        const handle = handles[0];
        if (handle === undefined) return;
        await takeFiles([{ file: await handle.getFile(), handle: Promise.resolve(handle) }]);
      }).catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setNotice(error instanceof Error ? error.message : String(error));
      });
      return;
    }
    // No File System Access: a session-only pick, the picker's own fallback.
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*,audio/*";
    input.onchange = () => {
      const picked = input.files?.[0];
      if (picked !== undefined) void takeFiles([{ file: picked, handle: Promise.resolve(null) }]);
    };
    input.click();
  }, [takeFiles]);

  const adopt = useCallback(
    (nodeId: NodeId) => {
      void apply(adoptReferenceOperations(graph, nodeId), "Use as reference media").then((ok) => { if (ok) setNotice(null); });
    },
    [apply, graph],
  );

  const setLengthFromMedia = useCallback(() => {
    if (ready === null) return;
    const planned = rangeFromMedia(ready.durationSeconds, fps, range);
    if (planned === null) return;
    void bus.execute("project.setSettings", { settings: { frameRange: planned.range }, label: "Set project length from media" }, invocation).then((result) => {
      setNotice(result.status !== "applied" ? (result.diagnostics[0]?.message ?? "The range was refused.") : planned.notice);
    });
  }, [bus, fps, invocation, range, ready]);

  return {
    reference,
    candidates,
    peaks,
    waveform,
    notice: notice ?? reference?.warning ?? null,
    clearNotice: () => setNotice(null),
    onDragOver,
    onDrop,
    pickFile,
    adopt,
    setLengthFromMedia,
  };
}
