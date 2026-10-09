import { useLayoutEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, PointerEvent as ReactPointerEvent } from "react";
import { newRegion, parseClipTrack, regionEnd, serializeClipTrack, PLAY_MODES, type ClipTrack, type Region } from "@domain/regions/model.ts";
import { ticksPerFrame, TICKS_PER_SECOND, type FrameRate } from "@domain/time/ticks.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { retainedFiles } from "@ui/files/retained-files.ts";
import { captureDroppedFiles, resolveDroppedMedia, transcodeFirstMessage, type CapturedFile } from "../media-drop/media-drop.ts";
import type { BeatGrid } from "./beat-grid.ts";
import { CLIP_ROW_HEIGHT, CLIP_RULER_HEIGHT, clipHit, clipStripHeight, paintClipLanes, type ClipPart } from "./clip-draw.ts";
import { deleteRegion, freshRegionId, moveRegion, placeRegion, PLAY_MODE_BADGE, setRegionFields, trimRegionEnd, trimRegionStart, type RegionFields } from "./clip-edits.ts";
import { snapTicks, type SnapMode } from "./timeline-edits.ts";
import { frameAtX } from "./timeline-draw.ts";
import { lanesStored, type ClipTrackView } from "./timeline-model.ts";
import { tickToX, xToTick, type TimelineView } from "./timeline-view.ts";
import styles from "./timeline-pane.module.css";
import { videoDurationSeconds } from "./video-duration.ts";

/**
 * VN106 — CLIP TRACKS IN THE TIMELINE: a lane per `clipTrack` node, ABOVE the dope strip and
 * the curve editor, on the same view transform (one `TimelineView`, so a region's edge and
 * a key on the same tick line up), under its own ruler.
 *
 * GESTURES (Ableton's arrangement view; the pure edits are `clip-edits.ts`):
 *  - drag a region's body: move it (its start snaps);
 *  - drag its left edge: trim the start, slipping the source;
 *  - drag its right edge: trim the length up to one pass of the source; ALT-drag extends
 *    past it, so the play mode (loop, bounce, hold, clear) fills the rest;
 *  - click: select it, and its popover sets play mode, direction, speed, BPM-sync beats,
 *    fades and the source in/out, or deletes it;
 *  - the ruler: click or drag to seek;
 *  - drop a video file on a lane: a region at the drop time, as long as the media, with
 *    the file retained the way media-drop retains it; dropped ON a region, the file
 *    RELINKS that region (an imported offline clip, a transcoded proxy) and keeps its timing.
 * Snapping is the pane's snap mode (frames, seconds, bar, beat, 1/8, 1/16).
 *
 * WRITES. A region never overlaps its neighbours: a move or trim clamps against them. Every
 * gesture is ONE `setParameters` on the node's `track` text through the parameter editor
 * (`setStored`, live while the drag runs and commit on release), so a gesture is one undo
 * step and a drag that ends where it began writes nothing.
 */

export interface ClipLanesProps {
  readonly graph: GraphDocument;
  readonly rows: readonly ClipTrackView[];
  readonly view: TimelineView;
  readonly rate: FrameRate;
  readonly snap: SnapMode;
  readonly grid: BeatGrid | null;
  readonly playheadTicks: () => number | null;
  readonly editor: ParameterEditor;
  readonly onSeek?: ((frameIndex: number) => void) | undefined;
  readonly onNotice: (notice: string | null) => void;
  /** Repaint trigger: the pane's sampled frame. */
  readonly frame: number | null;
  /** Injected in tests: a video file's duration in seconds. Defaults to reading a `<video>`'s metadata. */
  readonly probeDuration?: (file: File) => Promise<number>;
}

interface ClipDrag {
  readonly nodeId: NodeId;
  readonly regionId: string;
  readonly part: ClipPart;
  readonly origin: ClipTrack;
  readonly tempo: number;
  /** Where in the region (ticks from its start) the body was grabbed. */
  readonly grab: number;
  readonly x: number;
  moved: boolean;
  last: ClipTrack;
}

const isFileDrag = (event: ReactDragEvent<HTMLElement>): boolean => Array.from(event.dataTransfer?.types ?? []).includes("Files");

export function ClipLanes(props: ClipLanesProps) {
  const { rows, view, rate, snap, grid, editor } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drag = useRef<ClipDrag | null>(null);
  const [selected, setSelected] = useState<{ nodeId: NodeId; regionId: string } | null>(null);
  /** The popover opens on a click that did not drag, and closes on the next press. */
  const [popover, setPopover] = useState(false);
  const minLength = ticksPerFrame(rate);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    paintClipLanes(canvas, { view, rate, rows, selected, playheadTicks: props.playheadTicks(), grid });
  });

  const rowOf = (nodeId: NodeId): ClipTrackView | undefined => rows.find((row) => row.id === nodeId);

  /** One gesture's write. Skipped when a commit would change nothing and no live write is open. */
  const write = (nodeId: NodeId, track: ClipTrack, phase: "live" | "commit", origin?: ClipTrack): void => {
    const row = rowOf(nodeId);
    if (row === undefined || !row.editable) return;
    const text = serializeClipTrack(track);
    const parsed = parseClipTrack(text);
    if (!parsed.ok) {
      props.onNotice(parsed.reason);
      return;
    }
    if (phase === "commit" && origin !== undefined && text === serializeClipTrack(origin) && !editor.isEditing(nodeId, "track")) return;
    editor.setStored(nodeId, { track: lanesStored(props.graph.nodes[nodeId]?.parameters["track"], text) }, phase);
  };

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0) return;
    const { x, y } = local(event);
    const hit = clipHit(view, rows, x, y);
    if (hit === null) return;
    setPopover(false);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (hit.kind === "ruler") {
      drag.current = null;
      props.onSeek?.(frameAtX(view, x, rate));
      seeking.current = true;
      return;
    }
    if (hit.kind === "row") {
      setSelected(null);
      return;
    }
    const row = rows[hit.row]!;
    setSelected({ nodeId: row.id, regionId: hit.region.id });
    if (row.track === null || !row.editable) {
      setPopover(true);
      return;
    }
    drag.current = {
      nodeId: row.id, regionId: hit.region.id, part: hit.part, origin: row.track, last: row.track, tempo: row.tempo,
      grab: xToTick(view, x) - hit.region.timelineStart, x, moved: false,
    };
  };
  const seeking = useRef(false);

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const { x } = local(event);
    if (seeking.current) {
      props.onSeek?.(frameAtX(view, x, rate));
      return;
    }
    const current = drag.current;
    if (current === null) return;
    if (!current.moved && Math.abs(x - current.x) < 3) return;
    current.moved = true;
    const at = xToTick(view, x);
    let next: ClipTrack;
    if (current.part === "body") next = moveRegion(current.origin, current.regionId, snapTicks(at - current.grab, snap, rate, grid));
    else if (current.part === "left") next = trimRegionStart(current.origin, current.regionId, snapTicks(at, snap, rate, grid), current.tempo, minLength);
    else next = trimRegionEnd(current.origin, current.regionId, snapTicks(at, snap, rate, grid), { extend: event.altKey, tempoBpm: current.tempo, minLength });
    if (next === current.last) return;
    current.last = next;
    write(current.nodeId, next, "live", current.origin);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    seeking.current = false;
    const current = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (current === null) return;
    if (!current.moved) {
      setPopover(true);
      return;
    }
    // Close the gesture with the last track it wrote: one transaction, one undo step.
    write(current.nodeId, current.last, "commit", current.origin);
  };

  // ── Media dropped on a lane ──────────────────────────────────────────────────────────

  const dropMedia = async (nodeId: NodeId, atTicks: number, captured: readonly CapturedFile[], onto: string | null): Promise<void> => {
    const resolved = await resolveDroppedMedia(captured, {
      files: typeof indexedDB === "undefined" ? null : retainedFiles(),
      createObjectURL: (file) => URL.createObjectURL(file),
    });
    const notices = resolved.refusals.map((each) => each.message);
    if (resolved.components.length > 0) notices.push("A component file goes on the canvas, not a clip track.");
    const row = rowOf(nodeId);
    let track = row?.track ?? null;
    if (row === undefined || track === null || !row.editable) {
      props.onNotice(row?.error ?? "This clip track's regions are not editable here.");
      return;
    }
    // Onto a region: RELINK it (an offline import, a moved file, a proxy) and keep its timing.
    const target = onto === null ? undefined : track.regions.find((region) => region.id === onto);
    const firstVideo = resolved.media.find((media) => media.kind === "video");
    if (target !== undefined && firstVideo !== undefined) {
      if (resolved.media.length > 1) notices.push(`A region takes one file; it took "${firstVideo.name}".`);
      props.onNotice(notices.length === 0 ? null : notices.join(" "));
      write(nodeId, setRegionFields(track, target.id, { media: firstVideo.reference }), "commit");
      return;
    }
    const probe = props.probeDuration ?? videoDurationSeconds;
    let at = atTicks;
    let placed = 0;
    for (const media of resolved.media) {
      if (media.kind !== "video") {
        notices.push(`"${media.name}" is ${media.kind === "audio" ? "audio" : "a still image"}; a clip track takes video.`);
        continue;
      }
      const file = captured.find((each) => each.file.name === media.name)?.file;
      let seconds: number;
      try {
        if (file === undefined) throw new Error("the file is gone");
        seconds = await probe(file);
      } catch (error) {
        notices.push(transcodeFirstMessage(media.name, `media that will not open (${error instanceof Error ? error.message : String(error)})`));
        continue;
      }
      const ticks = Math.max(1, Math.round(seconds * TICKS_PER_SECOND));
      const region = newRegion(freshRegionId(track), media.reference, { sourceIn: 0, sourceOut: ticks, timelineStart: at, length: ticks });
      const next = placeRegion(track, region, minLength);
      if (next === null) {
        notices.push(`No room for "${media.name}" there.`);
        continue;
      }
      track = next;
      const landed = next.regions.find((each) => each.id === region.id)!;
      at = regionEnd(landed);
      placed += 1;
    }
    props.onNotice(notices.length === 0 ? null : notices.join(" "));
    if (placed > 0) write(nodeId, track, "commit", row.track ?? undefined);
  };

  const onDragOver = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return;
    const { x, y } = local(event);
    const hit = clipHit(view, rows, x, y);
    if (hit === null || hit.kind === "ruler") return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDrop = (event: ReactDragEvent<HTMLDivElement>): void => {
    if (!isFileDrag(event)) return;
    const { x, y } = local(event);
    const hit = clipHit(view, rows, x, y);
    if (hit === null || hit.kind === "ruler") return;
    // Inside the event: the browser empties the items when it returns.
    const captured = captureDroppedFiles(event.dataTransfer);
    if (captured.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    void dropMedia(rows[hit.row]!.id, snapTicks(xToTick(view, x), snap, rate, grid), captured, hit.kind === "region" ? hit.region.id : null);
  };

  // ── The selected region's popover ────────────────────────────────────────────────────

  const selectedRow = selected === null ? undefined : rowOf(selected.nodeId);
  const selectedRegion = selectedRow?.track?.regions.find((region) => region.id === selected?.regionId);
  const rowIndex = selectedRow === undefined ? -1 : rows.indexOf(selectedRow);
  const edit = (fields: RegionFields): void => {
    if (selectedRow?.track == null || selectedRegion === undefined) return;
    write(selectedRow.id, setRegionFields(selectedRow.track, selectedRegion.id, fields), "commit");
  };

  return (
    <div className={styles.clipLanes} data-clip-lanes="" onDragOver={onDragOver} onDrop={onDrop}>
      <canvas
        ref={canvasRef}
        className={styles.clipCanvas}
        style={{ height: clipStripHeight(rows.length) }}
        data-clip-canvas=""
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onContextMenu={(event) => event.preventDefault()}
      />
      {selectedRow !== undefined && selectedRegion !== undefined && popover && (
        <RegionPopover
          key={`${selectedRow.id} ${selectedRegion.id}`}
          region={selectedRegion}
          editable={selectedRow.editable}
          left={Math.max(0, Math.min(tickToX(view, selectedRegion.timelineStart), (canvasRef.current?.clientWidth ?? 400) - 300))}
          top={CLIP_RULER_HEIGHT + (rowIndex + 1) * CLIP_ROW_HEIGHT}
          onEdit={edit}
          onDelete={() => {
            if (selectedRow.track === null) return;
            write(selectedRow.id, deleteRegion(selectedRow.track, selectedRegion.id), "commit");
            setSelected(null);
          }}
          onClose={() => setPopover(false)}
        />
      )}
    </div>
  );
}

interface RegionPopoverProps {
  readonly region: Region;
  readonly editable: boolean;
  readonly left: number;
  readonly top: number;
  readonly onEdit: (fields: RegionFields) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

const seconds = (ticks: number): number => Math.round((ticks / TICKS_PER_SECOND) * 1000) / 1000;
const toTicks = (value: number): number => Math.round(value * TICKS_PER_SECOND);

/** A number field that writes on Enter or blur, once, and only a finite value. */
function NumberField(props: { label: string; value: number; min?: number; step?: number; disabled: boolean; onCommit: (value: number) => void; name: string }) {
  const commit = (input: HTMLInputElement): void => {
    const value = Number(input.value);
    if (input.value.trim() === "" || !Number.isFinite(value) || value === props.value) return;
    props.onCommit(value);
  };
  return (
    <label className={styles.popoverField}>
      {props.label}
      <input
        key={props.value}
        type="number"
        className={styles.popoverInput}
        defaultValue={props.value}
        min={props.min}
        step={props.step ?? "any"}
        disabled={props.disabled}
        data-region-field={props.name}
        onBlur={(event) => commit(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(event.currentTarget);
        }}
      />
    </label>
  );
}

function RegionPopover({ region, editable, left, top, onEdit, onDelete, onClose }: RegionPopoverProps) {
  const disabled = !editable;
  return (
    <div className={styles.popover} style={{ left, top }} data-region-popover={region.id} onPointerDown={(event) => event.stopPropagation()}>
      <label className={styles.popoverField}>
        mode
        <select value={region.playMode} disabled={disabled} data-region-field="playMode" onChange={(event) => onEdit({ playMode: event.target.value as Region["playMode"] })}>
          {PLAY_MODES.map((mode) => <option key={mode} value={mode}>{PLAY_MODE_BADGE[mode]}</option>)}
        </select>
      </label>
      <label className={styles.popoverField}>
        direction
        <select value={region.direction} disabled={disabled} data-region-field="direction" onChange={(event) => onEdit({ direction: event.target.value as Region["direction"] })}>
          <option value="forward">forward</option>
          <option value="reverse">reverse</option>
        </select>
      </label>
      <NumberField label="speed" name="speed" value={region.speed} min={0} disabled={disabled || region.bpmSync !== undefined} onCommit={(speed) => onEdit({ speed: Math.max(0, speed) })} />
      <label className={styles.popoverField} title="Play in..out in this many beats at the track's tempo">
        <input
          type="checkbox"
          checked={region.bpmSync !== undefined}
          disabled={disabled}
          data-region-field="bpmSyncOn"
          onChange={(event) => onEdit({ bpmSync: event.target.checked ? { beats: 4 } : undefined })}
        />
        bpm sync
      </label>
      {region.bpmSync !== undefined && (
        <NumberField label="beats" name="beats" value={region.bpmSync.beats} min={0} disabled={disabled} onCommit={(beats) => { if (beats > 0) onEdit({ bpmSync: { beats } }); }} />
      )}
      <NumberField label="in s" name="sourceIn" value={seconds(region.sourceIn)} min={0} disabled={disabled} onCommit={(value) => onEdit({ sourceIn: Math.max(0, toTicks(value)) })} />
      <NumberField label="out s" name="sourceOut" value={seconds(region.sourceOut)} min={0} disabled={disabled} onCommit={(value) => onEdit({ sourceOut: toTicks(value) })} />
      <NumberField label="fade in s" name="fadeIn" value={seconds(region.fadeIn)} min={0} disabled={disabled} onCommit={(value) => onEdit({ fadeIn: Math.max(0, toTicks(value)) })} />
      <NumberField label="fade out s" name="fadeOut" value={seconds(region.fadeOut)} min={0} disabled={disabled} onCommit={(value) => onEdit({ fadeOut: Math.max(0, toTicks(value)) })} />
      <button type="button" className={styles.danger} disabled={disabled} onClick={onDelete} data-region-delete="">delete</button>
      <button type="button" className={styles.toggle} onClick={onClose} aria-label="close">×</button>
    </div>
  );
}
