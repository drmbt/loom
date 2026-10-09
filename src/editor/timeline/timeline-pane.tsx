import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent } from "react";
import { compileAutomation, evaluateNormalized, type ResolvedLane } from "@domain/automation/evaluate.ts";
import { serializeAutomation, type AutomationDocument, type AutomationLane } from "@domain/automation/model.ts";
import { setLaneMute } from "@domain/automation/mute.ts";
import { laneRenameOperations } from "@domain/automation/rename.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { isParameterSlot } from "@domain/parameters/slots.ts";
import { framesToTicks, rateOf, ticksPerFrame } from "@domain/time/ticks.ts";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { FrameRange, GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { AUTOMATION_NODE_TYPE, playheadTicks } from "@nodes/definitions/automation.ts";
import { createParameterEditor, type ParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { isTextEntryTarget } from "@editor/keymap/context.ts";
import { useKeymapPane } from "@editor/keymap/pane.ts";
import { LaneList } from "./lane-list.tsx";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { ParameterDragPayload } from "@ui/controls/parameter-drag-context.ts";
import { laneDropOperations } from "../parameter-drag/lane-drop.ts";
import { RULER_HEIGHT, frameAtX, paintTimeline, type DrawLane } from "./timeline-draw.ts";
import {
  addLane,
  copyKeys,
  deleteKeys,
  deleteLane,
  insertKey,
  insertKeyOnAllLanes,
  moveKeys,
  moveLane,
  nudgeMultiplier,
  pasteKeys,
  sameRef,
  scaleKeys,
  setHandle,
  setHandlesLinked,
  setLaneProps,
  snapTicks,
  stepKey,
  BEAT_SNAP_MODES,
  type KeyClipboard,
  type KeyRef,
  type SnapMode,
} from "./timeline-edits.ts";
import { hitBox, hitTest, marquee, selectionBox, type BoxPart, type Rect } from "./timeline-hit.ts";
import { DopeStrip } from "./dope-strip.tsx";
import { KeyTable } from "./key-table.tsx";
import { automationNodes, clipTrackViews, currentAutomationNode, laneReferenceCounts, lanesStored, type AutomationNodeView } from "./timeline-model.ts";
import { ClipLanes } from "./clip-lanes.tsx";
import { TimelineImport } from "./timeline-import.tsx";
import { CLIP_TRACK_NODE_TYPE } from "@nodes/definitions/clip-track.ts";
import { TimelineStatus } from "./timeline-status.tsx";
import { ReferenceControls } from "./reference-controls.tsx";
import { useReferenceMedia } from "./use-reference-media.ts";
import { beatGridOf } from "./beat-grid.ts";
import type { WaveformPeaks } from "./waveform-peaks.ts";
import {
  DEFAULT_VIEW,
  displayValue,
  followPage,
  frameAll,
  pan,
  storedDelta,
  storedValue,
  xToTick,
  yToValue,
  zoomTimeAt,
  zoomValueAt,
  type TimelineView,
  type ValueMode,
} from "./timeline-view.ts";
import styles from "./timeline-pane.module.css";

/**
 * VN62 — THE TIMELINE PANE: a lane list beside a curve editor, in the bottom tray.
 *
 * WRITES. Every key and lane edit is ONE `setParameters` on the automation node's `lanes`
 * per gesture, through `createParameterEditor` (`setStored`, live while a drag runs and
 * commit on release): a drag is one transaction, so one undo step (§V15), and a drag that
 * ends where it began writes nothing. A rename and a new node are one `graph.applyPatch`.
 * Every gesture is computed from the document it STARTED from (`timeline-edits.ts`).
 *
 * KEYS. The pane takes focus on pointer-down (`useKeymapPane`, context `global`, so the
 * graph's bindings, which are scoped to `graph`, do not apply while it holds focus), and
 * every key it handles is `preventDefault`ed, which the keymap honours: Delete over the
 * timeline deletes keys, never the graph's selected node, and Mod+C copies keys, not nodes.
 *
 * TIME. The playhead comes from the frame the app last rendered (a ref read, §V16),
 * sampled at 10 Hz and repainted per display frame only while playing. A seek is the
 * app's `transport.seek` (`onSeek`); this pane never moves the clock itself.
 */

export interface TimelinePaneProps {
  readonly graph: GraphDocument;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** The app's graph selection, primary LAST (the order the canvas reports). */
  readonly selection: readonly NodeId[];
  readonly latestFrame: () => FrameInputs | null;
  readonly fps: number;
  readonly range: FrameRange;
  readonly playing?: boolean;
  readonly onSeek?: ((frameIndex: number) => void) | undefined;
  /** Injected in tests; the pane builds its own over `bus` otherwise. */
  readonly editor?: ParameterEditor;
  /** VN63: reads a dropped parameter's definition (its min/max). Absent = the lane list takes no drops. */
  readonly registry?: NodeRegistryView;
  /** VN64: injected in tests, the reference waveform's loader. Absent: decode the file. */
  readonly loadPeaks?: (file: string) => Promise<WaveformPeaks>;
  /** VN106: injected in tests, a dropped video's duration in seconds. */
  readonly probeDuration?: (file: File) => Promise<number>;
}

type Drag =
  /** `selection` is the drag's own: the click that started it may not have re-rendered yet. */
  | { kind: "keys"; nodeId: NodeId; origin: AutomationDocument; last: AutomationDocument; selection: readonly KeyRef[]; x: number; y: number; moved: boolean }
  | { kind: "handle"; nodeId: NodeId; origin: AutomationDocument; last: AutomationDocument; ref: KeyRef; side: "in" | "out" }
  | { kind: "box"; nodeId: NodeId; origin: AutomationDocument; last: AutomationDocument; selection: readonly KeyRef[]; part: BoxPart; box: Rect; pivotTicks: number | null }
  | { kind: "marquee"; rect: Rect; additive: boolean }
  | { kind: "pan"; x: number; y: number }
  | { kind: "seek" };

const SAMPLE_MS = 100;

/** The snap menu's words for the beat divisions. */
const BEAT_SNAP_LABELS: Readonly<Record<(typeof BEAT_SNAP_MODES)[number], string>> = { bars: "bar", beats: "beat", eighths: "1/8", sixteenths: "1/16" };

export function TimelinePane(props: TimelinePaneProps) {
  const { graph, bus, invocation, selection, latestFrame, fps, range, playing = false, onSeek } = props;
  const rate = useMemo(() => rateOf(fps), [fps]);
  const ownEditor = useMemo(() => props.editor ?? createParameterEditor({ bus, context: invocation }), [bus, invocation, props.editor]);
  useEffect(() => () => {
    if (props.editor === undefined) ownEditor.dispose();
  }, [ownEditor, props.editor]);

  const [lastTouched, setLastTouched] = useState<NodeId | null>(null);
  const [view, setView] = useState<TimelineView>(DEFAULT_VIEW);
  const [mode, setMode] = useState<ValueMode>("normalized");
  const [follow, setFollow] = useState(true);
  const [snap, setSnap] = useState<SnapMode>("frames");
  const [keySelection, setKeySelection] = useState<{ nodeId: NodeId | null; refs: readonly KeyRef[] }>({ nodeId: null, refs: [] });
  const [soloSelection, setSoloSelection] = useState<{ nodeId: NodeId | null; laneId: string | null }>({ nodeId: null, laneId: null });
  const [marqueeRect, setMarqueeRect] = useState<Rect | null>(null);
  const [frame, setFrame] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showTable, setShowTable] = useState(false);
  const clipboard = useRef<KeyClipboard | null>(null);
  const drag = useRef<Drag | null>(null);
  const held = useRef(new Set<string>());
  const hoverTicks = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const paneRef = useRef<HTMLDivElement | null>(null);
  const keymapPane = useKeymapPane("global", paneRef);
  const referenceMedia = useReferenceMedia({ graph, bus, invocation, fps, range, ...(props.loadPeaks === undefined ? {} : { loadPeaks: props.loadPeaks }) });
  const waveform = referenceMedia.waveform;
  // VN68: the reference track's declared beat clock, drawn on the ruler and snapped to.
  const grid = useMemo(() => beatGridOf(graph, referenceMedia.reference), [graph, referenceMedia.reference]);

  const nodes = useMemo(() => automationNodes(graph), [graph]);
  // VN106: the clip tracks, drawn above the lanes.
  const clipRows = useMemo(() => clipTrackViews(graph), [graph]);
  const current = currentAutomationNode(nodes, selection[selection.length - 1] ?? null, lastTouched);
  const currentId = current?.id ?? null;
  const keys = useMemo(() => keySelection.nodeId === currentId ? keySelection.refs : [], [keySelection, currentId]);
  const solo = soloSelection.nodeId === currentId ? soloSelection.laneId : null;
  const setKeys = (refs: readonly KeyRef[]): void => setKeySelection({ nodeId: currentId, refs });
  const setSolo = (laneId: string | null): void => setSoloSelection({ nodeId: currentId, laneId });
  const references = useMemo(() => laneReferenceCounts(graph, current?.name ?? null), [graph, current?.name]);
  const document = current?.document ?? null;
  const resolved = useMemo<readonly ResolvedLane[]>(() => {
    if (current === null) return [];
    const stored = graph.nodes[current.id]?.parameters["lanes"];
    const compiled = compileAutomation(isParameterSlot(stored) ? (stored.bindings.static?.kind === "static" ? stored.bindings.static.value : "") : stored);
    return compiled.ok ? compiled.compiled.lanes : [];
  }, [current, graph]);
  const shown = useMemo(() => resolved.filter((lane) => solo === null || lane.lane.id === solo), [resolved, solo]);
  /** Houdini's box transform around the selection, in curve-area pixels (needs the canvas's size, so read per render). */
  const box = selectionBox({ view, height: Math.max(1, (canvasRef.current?.clientHeight ?? 0) - RULER_HEIGHT), mode }, shown, keys);

  // The playhead: a 10 Hz sample of the last rendered frame (§V16).
  const playhead = useRef<number | null>(null);
  useEffect(() => {
    const sample = () => {
      const inputs = latestFrame();
      playhead.current = inputs === null ? null : playheadTicks(inputs.frame);
      setFrame(inputs === null ? null : inputs.frame.frameIndex);
    };
    sample();
    const timer = setInterval(sample, SAMPLE_MS);
    return () => clearInterval(timer);
  }, [latestFrame]);

  const width = (): number => canvasRef.current?.clientWidth ?? 0;
  const curveHeight = (): number => Math.max(1, (canvasRef.current?.clientHeight ?? 0) - RULER_HEIGHT);

  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const lanes: DrawLane[] = shown.map((lane) => ({ resolved: lane, faint: lane.lane.mute }));
    paintTimeline(canvas, {
      view,
      mode,
      rate,
      lanes,
      selection: keys,
      playheadTicks: playhead.current,
      range: [framesToTicks(range.start, rate), framesToTicks(range.end + 1, rate)],
      marquee: marqueeRect,
      box,
      frameLabels: false,
      waveform,
      grid,
    });
  }, [box, grid, keys, marqueeRect, mode, range.end, range.start, rate, shown, view, waveform]);

  useLayoutEffect(() => paint(), [paint, frame]);
  // Smooth while playing: one repaint per display frame, and none while paused.
  useEffect(() => {
    if (!playing || typeof requestAnimationFrame === "undefined") return;
    let handle = 0;
    const tick = () => {
      const inputs = latestFrame();
      playhead.current = inputs === null ? null : playheadTicks(inputs.frame);
      paint();
      handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [latestFrame, paint, playing]);
  // Follow-playhead paging.
  useEffect(() => {
    if (!follow || playhead.current === null) return;
    const next = followPage(view, width(), playhead.current);
    if (next !== view) setView(next);
  }, [follow, frame, view]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [paint]);

  // ── Writes ─────────────────────────────────────────────────────────────────────────

  /** One gesture's write: live while it runs, commit to close it. Skipped when nothing changed. */
  const write = useCallback(
    (node: AutomationNodeView, next: AutomationDocument, phase: "live" | "commit", origin?: AutomationDocument) => {
      if (!node.editable) return;
      const text = serializeAutomation(next);
      const before = serializeAutomation(origin ?? node.document ?? next);
      const stored = graph.nodes[node.id]?.parameters["lanes"];
      if (text === before && phase === "commit" && !ownEditor.isEditing(node.id, "lanes")) return;
      setLastTouched(node.id);
      ownEditor.setStored(node.id, { lanes: lanesStored(stored, text) }, phase);
    },
    [graph, ownEditor],
  );

  const commitOnce = useCallback(
    (next: AutomationDocument) => {
      if (current === null || document === null) return;
      write(current, next, "commit");
    },
    [current, document, write],
  );

  const applyOperations = useCallback(
    async (operations: GraphPatchOperation[], label: string) => {
      const result = await bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), operations, label }, invocation);
      return result;
    },
    [bus, invocation],
  );

  const playheadOrZero = (): number => playhead.current ?? 0;

  const onAddLane = useCallback(async () => {
    if (current !== null && document !== null) {
      const added = addLane(document, snapTicks(playheadOrZero(), "frames", rate));
      commitOnce(added.document);
      return;
    }
    // No automation node yet: create one holding the lane, in ONE patch.
    const lanes = serializeAutomation(addLane({ version: 1, lanes: [] }, snapTicks(playheadOrZero(), "frames", rate)).document);
    const result = await applyOperations(
      [{ op: "addNode", ref: "$automation", type: AUTOMATION_NODE_TYPE, position: { x: 0, y: 0 }, parameters: { lanes } } as GraphPatchOperation],
      "Add automation lane",
    );
    const created = result.output.status === "applied" ? result.output.createdIds["$automation"] : undefined;
    if (created !== undefined) setLastTouched(created);
  }, [applyOperations, commitOnce, current, document, rate]);

  /** VN106: "+ track" — a new Clip Track node, right of everything, in ONE patch. */
  const onAddClipTrack = useCallback(async () => {
    const positions = Object.values(graph.nodes).map((node) => node.position);
    const position = positions.length === 0 ? { x: 0, y: 0 } : { x: Math.max(...positions.map((each) => each.x)) + 320, y: Math.min(...positions.map((each) => each.y)) };
    const result = await applyOperations([{ op: "addNode", ref: "$clipTrack", type: CLIP_TRACK_NODE_TYPE, position } as GraphPatchOperation], "Add clip track");
    if (result.output.status !== "applied") setNotice(result.diagnostics[0]?.message ?? "The clip track was refused.");
  }, [applyOperations, graph]);

  const onRename = useCallback(
    (nodeId: NodeId, laneId: string, name: string): string | null => {
      const plan = laneRenameOperations(graph, nodeId, laneId, name);
      if (!plan.ok) return plan.reason;
      if (plan.operations.length > 0) void applyOperations(plan.operations, "Rename lane");
      setLastTouched(nodeId);
      return null;
    },
    [applyOperations, graph],
  );

  /** VN63: a parameter dropped on the lane list, as ONE patch: the lane (or none) and the reference. */
  const onDropParameter = async (source: ParameterDragPayload, nodeId: NodeId | null, laneId: string | null): Promise<void> => {
    const registry = props.registry;
    if (registry === undefined) return;
    const target = laneId !== null && nodeId !== null
      ? { kind: "existing" as const, automationNodeId: nodeId, laneId }
      : { kind: "new" as const, automationNodeId: nodeId ?? current?.id ?? null, atTicks: snapTicks(playheadOrZero(), "frames", rate) };
    const plan = laneDropOperations(graph, registry, source, target, bus.readScope());
    if (!plan.ok) return setNotice(plan.notice);
    const result = await applyOperations(plan.operations, laneId === null ? "Automate parameter" : "Reference lane");
    if (result.output.status !== "applied") return setNotice(result.diagnostics[0]?.message ?? "The drop was refused.");
    setNotice(null);
    const created = result.output.createdIds["$automation"];
    setLastTouched(created ?? target.automationNodeId);
  };

  const editLane = (nodeId: NodeId, edit: (document: AutomationDocument) => AutomationDocument): void => {
    const node = nodes.find((each) => each.id === nodeId);
    if (node === undefined || node.document === null) return;
    write(node, edit(node.document), "commit");
  };

  const onToggleMute = (nodeId: NodeId, lane: AutomationLane): void => {
    const node = nodes.find((each) => each.id === nodeId);
    if (node === undefined || !node.editable) return;
    const muted = setLaneMute(serializeAutomation(node.document!), lane.id, !lane.mute, playheadOrZero());
    if (!muted.ok) return setNotice(muted.reason);
    const stored = graph.nodes[nodeId]?.parameters["lanes"];
    setLastTouched(nodeId);
    ownEditor.setStored(nodeId, { lanes: lanesStored(stored, muted.text) }, "commit");
  };

  // ── Pointer ────────────────────────────────────────────────────────────────────────

  const local = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const box = canvasRef.current?.getBoundingClientRect();
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) - RULER_HEIGHT };
  };
  const geometry = () => ({ view, height: curveHeight(), mode });
  const handlesOf = (ref: KeyRef): boolean => keys.some((each) => sameRef(each, ref));

  /** The lane an Alt-click inserts on: the one whose curve is nearest the pointer at that time. */
  const laneAt = (x: number, y: number): ResolvedLane | null => {
    let best: ResolvedLane | null = null;
    let distance = Infinity;
    const t = xToTick(view, x);
    const value = yToValue(view, curveHeight(), y);
    for (const lane of shown) {
      if (lane.lane.lock) continue;
      const d = Math.abs(displayValue(lane.lane, evaluateNormalized(lane, t), mode) - value);
      if (d < distance) {
        best = lane;
        distance = d;
      }
    }
    return best;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const { x, y } = local(event);
    if (event.button === 1) {
      drag.current = { kind: "pan", x: event.clientX, y: event.clientY };
      return;
    }
    if (y < 0) {
      drag.current = { kind: "seek" };
      onSeek?.(frameAtX(view, x, rate));
      return;
    }
    if (current === null || document === null) return;
    const t = snapTicks(xToTick(view, x), snap, rate, grid);
    if (event.altKey && (event.ctrlKey || event.metaKey)) {
      const inserted = insertKeyOnAllLanes(document, t);
      commitOnce(inserted.document);
      setKeys(inserted.refs);
      return;
    }
    if (event.altKey) {
      const lane = laneAt(x, y);
      if (lane === null) return;
      const v = storedValue(lane.lane, yToValue(view, curveHeight(), y), mode);
      const inserted = insertKey(document, lane.lane.id, t, Math.min(1, Math.max(0, v)));
      commitOnce(inserted.document);
      if (inserted.ref !== null) setKeys([inserted.ref]);
      return;
    }
    const hit = hitTest(geometry(), shown, x, y, handlesOf);
    if (hit.kind === "handle") {
      drag.current = { kind: "handle", nodeId: current.id, origin: document, last: document, ref: hit.ref, side: hit.side };
      return;
    }
    if (hit.kind === "key") {
      const already = keys.some((each) => sameRef(each, hit.ref));
      const next = event.shiftKey ? (already ? keys.filter((each) => !sameRef(each, hit.ref)) : [...keys, hit.ref]) : already ? keys : [hit.ref];
      setKeys(next);
      drag.current = { kind: "keys", nodeId: current.id, origin: document, last: document, selection: next, x, y, moved: false };
      return;
    }
    if (box !== null && !event.shiftKey) {
      const part = hitBox(box, x, y);
      if (part !== null) {
        // The pivot is the opposite edge, or the playhead with Ctrl / Cmd held (time edges).
        const pivotTicks = event.ctrlKey || event.metaKey ? playheadOrZero() : null;
        drag.current = { kind: "box", nodeId: current.id, origin: document, last: document, selection: keys, part, box, pivotTicks };
        return;
      }
      if (x >= box.x0 && x <= box.x1 && y >= box.y0 && y <= box.y1) {
        drag.current = { kind: "keys", nodeId: current.id, origin: document, last: document, selection: keys, x, y, moved: false };
        return;
      }
    }
    drag.current = { kind: "marquee", rect: { x0: x, y0: y, x1: x, y1: y }, additive: event.shiftKey };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const { x, y } = local(event);
    hoverTicks.current = y >= 0 ? xToTick(view, x) : null;
    const current_ = drag.current;
    if (current_ === null) return;
    if (current_.kind === "pan") {
      setView((previous) => pan(previous, curveHeight(), event.clientX - current_.x, event.clientY - current_.y));
      drag.current = { ...current_, x: event.clientX, y: event.clientY };
      return;
    }
    if (current_.kind === "seek") {
      onSeek?.(frameAtX(view, x, rate));
      return;
    }
    if (current_.kind === "marquee") {
      const rect = { ...current_.rect, x1: x, y1: y };
      drag.current = { ...current_, rect };
      setMarqueeRect(rect);
      return;
    }
    const node = nodes.find((each) => each.id === current_.nodeId);
    if (node === undefined) return;
    if (current_.kind === "handle") {
      const lane = current_.origin.lanes.find((each) => each.id === current_.ref.lane);
      const key = lane?.keys.find((each) => each.id === current_.ref.key);
      if (lane === undefined || key === undefined) return;
      const dt = xToTick(view, x) - key.t;
      const dv = storedValue(lane, yToValue(view, curveHeight(), y), mode) - key.v;
      const next = setHandle(current_.origin, current_.ref, current_.side, [dt, dv]);
      drag.current = { ...current_, last: next };
      write(node, next, "live", current_.origin);
      return;
    }
    if (current_.kind === "box") {
      const { box: from, part } = current_;
      const firstLane = current_.origin.lanes.find((lane) => current_.selection.some((ref) => ref.lane === lane.id)) ?? { min: 0, max: 1 };
      let next = current_.origin;
      if (part === "left" || part === "right") {
        const edge = xToTick(view, part === "left" ? from.x0 : from.x1);
        const pivot = current_.pivotTicks ?? xToTick(view, part === "left" ? from.x1 : from.x0);
        const sx = (snapTicks(xToTick(view, x), snap, rate, grid) - pivot) / (edge - pivot);
        if (Number.isFinite(sx) && sx > 0) next = scaleKeys(current_.origin, current_.selection, pivot, 0, sx, 1);
      } else {
        const valueAt = (pixel: number): number => storedValue(firstLane, yToValue(view, curveHeight(), pixel), mode);
        const edge = valueAt(part === "top" ? from.y0 : from.y1);
        const pivot = valueAt(part === "top" ? from.y1 : from.y0);
        const sy = (valueAt(y) - pivot) / (edge - pivot);
        if (Number.isFinite(sy)) next = scaleKeys(current_.origin, current_.selection, 0, pivot, 1, sy);
      }
      drag.current = { ...current_, last: next };
      write(node, next, "live", current_.origin);
      return;
    }
    // Keys: D / F held scale about the playhead (time) and the grab point (value); else move.
    let dx = x - current_.x;
    let dy = y - current_.y;
    if (!current_.moved && Math.hypot(dx, dy) < 3) return;
    const scaleTime = held.current.has("d");
    const scaleValue = held.current.has("f");
    if (scaleTime || scaleValue) {
      const pivotT = playheadOrZero();
      const pivotV = storedValue(resolved[0]?.lane ?? { min: 0, max: 1 }, yToValue(view, curveHeight(), current_.y), mode);
      const sx = scaleTime ? Math.max(0.01, 1 + dx / 200) : 1;
      const sy = scaleValue ? 1 - dy / 200 : 1;
      const next = scaleKeys(current_.origin, current_.selection, pivotT, pivotV, sx, sy);
      drag.current = { ...current_, moved: true, last: next };
      write(node, next, "live", current_.origin);
      return;
    }
    // Shift locks to time, Shift+Ctrl to value (Keyframer's axis lock).
    if (event.shiftKey && (event.ctrlKey || event.metaKey)) dx = 0;
    else if (event.shiftKey) dy = 0;
    const dt = snapTicks(dx * view.ticksPerPixel, snap, rate, grid, true);
    const firstLane = current_.origin.lanes.find((lane) => current_.selection.some((ref) => ref.lane === lane.id));
    const dv = firstLane === undefined ? 0 : storedDelta(firstLane, -dy * ((view.valueHigh - view.valueLow) / curveHeight()), mode);
    const next = moveKeys(current_.origin, current_.selection, dt, dv).document;
    drag.current = { ...current_, moved: true, last: next };
    write(node, next, "live", current_.origin);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const current_ = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (current_ === null) return;
    if (current_.kind === "marquee") {
      setMarqueeRect(null);
      const caught = marquee(geometry(), shown, current_.rect, (lane, ticks) => evaluateNormalized(lane, ticks));
      setKeys(current_.additive ? [...keys, ...caught.filter((ref) => !keys.some((each) => sameRef(each, ref)))] : caught);
      return;
    }
    if (current_.kind === "keys" || current_.kind === "handle" || current_.kind === "box") {
      if (current_.kind === "keys" && !current_.moved) return;
      const node = nodes.find((each) => each.id === current_.nodeId);
      if (node === undefined) return;
      // Close the gesture with the last document it wrote: one transaction, one undo step.
      write(node, current_.last, "commit", current_.origin);
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>): void => {
    const { x, y } = local(event);
    const factor = Math.exp(event.deltaY * 0.0015);
    if (event.altKey) setView((previous) => zoomValueAt(previous, curveHeight(), y, factor));
    else if (event.shiftKey) setView((previous) => ({ ...previous, startTicks: previous.startTicks + event.deltaY * previous.ticksPerPixel }));
    else setView((previous) => zoomTimeAt(previous, x, factor));
  };

  // ── Keys ───────────────────────────────────────────────────────────────────────────

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (isTextEntryTarget(event.target)) return;
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };
    if (key === "d" || key === "f") {
      held.current.add(key);
      return handled();
    }
    if (key === "h") {
      setView(frameAll(shown, width(), mode));
      return handled();
    }
    if (document === null) return;
    if (key === "delete" || key === "backspace") {
      if (keys.length === 0) return handled();
      const deleted = deleteKeys(document, keys);
      commitOnce(deleted.document);
      setKeys(deleted.kept);
      setNotice(deleted.kept.length > 0 ? "A lane keeps at least one key." : null);
      return handled();
    }
    if (mod && key === "c") {
      clipboard.current = copyKeys(document, keys);
      return handled();
    }
    if (mod && key === "v") {
      if (clipboard.current !== null) {
        const at = snapTicks(hoverTicks.current ?? playheadOrZero(), snap, rate, grid);
        const pasted = pasteKeys(document, clipboard.current, at, keys[0]?.lane ?? document.lanes[0]?.id ?? null);
        commitOnce(pasted.document);
        setKeys(pasted.refs);
      }
      return handled();
    }
    if (key === "tab") {
      const next = stepKey(document, keys[keys.length - 1] ?? null, event.shiftKey ? -1 : 1, solo === null ? undefined : new Set([solo]));
      setKeys(next === null ? [] : [next]);
      return handled();
    }
    if (key === "t") {
      const selected = document.lanes.flatMap((lane) => lane.keys.filter((each) => keys.some((ref) => ref.lane === lane.id && ref.key === each.id)));
      const linked = !selected.every((each) => each.handle === "aligned");
      commitOnce(setHandlesLinked(document, keys, linked));
      return handled();
    }
    if (key.startsWith("arrow")) {
      const multiplier = nudgeMultiplier(event);
      const dt = key === "arrowleft" ? -1 : key === "arrowright" ? 1 : 0;
      const dv = key === "arrowup" ? 1 : key === "arrowdown" ? -1 : 0;
      commitOnce(moveKeys(document, keys, dt * multiplier * ticksPerFrame(rate), dv * multiplier * 0.01).document);
      return handled();
    }
  };
  const onKeyUp = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    held.current.delete(event.key.toLowerCase());
  };

  return (
    <div
      ref={paneRef}
      className={styles.pane}
      tabIndex={keymapPane.tabIndex}
      data-keymap-context={keymapPane["data-keymap-context"]}
      onPointerDown={keymapPane.onPointerDown}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onDragOver={referenceMedia.onDragOver}
      onDrop={referenceMedia.onDrop}
      data-timeline-pane=""
    >
      <LaneList
        nodes={nodes}
        current={current}
        references={references}
        solo={solo}
        onMakeCurrent={setLastTouched}
        onAddLane={() => void onAddLane()}
        onRename={onRename}
        onColour={(nodeId, laneId, colour) => editLane(nodeId, (document_) => setLaneProps(document_, laneId, { color: colour }))}
        onToggleMute={onToggleMute}
        onToggleLock={(nodeId, lane) => editLane(nodeId, (document_) => setLaneProps(document_, lane.id, { lock: !lane.lock }))}
        onSolo={setSolo}
        onMove={(nodeId, laneId, index) => editLane(nodeId, (document_) => moveLane(document_, laneId, index))}
        onDelete={(nodeId, laneId) => editLane(nodeId, (document_) => deleteLane(document_, laneId))}
        {...(props.registry === undefined ? {} : { onDropParameter: (source: ParameterDragPayload, nodeId: NodeId | null, laneId: string | null) => void onDropParameter(source, nodeId, laneId) })}
      />
      <div className={styles.editor}>
        <div className={styles.toolbar}>
          <TimelineStatus frame={frame} fps={fps} range={range} />
          <span className={styles.spacer} />
          {notice !== null && <span className={styles.notice}>{notice}</span>}
          {referenceMedia.notice !== null && <span className={styles.notice} data-timeline-reference-notice="">{referenceMedia.notice}</span>}
          <ReferenceControls media={referenceMedia} />
          <button type="button" className={styles.toggle} onClick={() => void onAddClipTrack()} title="A new clip track: regions of video above the lanes" data-add-clip-track="">
            + track
          </button>
          <TimelineImport graph={graph} bus={bus} invocation={invocation} onNotice={setNotice} />
          <label className={styles.option}>
            snap
            <select value={snap} onChange={(event) => setSnap(event.target.value as SnapMode)} aria-label="snap">
              <option value="frames">frames</option>
              <option value="seconds">seconds</option>
              {BEAT_SNAP_MODES.map((division) => (
                <option key={division} value={division} disabled={grid === null} title={grid === null ? "Declare a tempo on the reference track" : undefined}>
                  {BEAT_SNAP_LABELS[division]}
                </option>
              ))}
              <option value="off">off</option>
            </select>
          </label>
          <button type="button" className={styles.toggle} data-on={mode === "normalized" ? "" : undefined} onClick={() => setMode(mode === "normalized" ? "values" : "normalized")} title="each lane in its own 0..1 (off: output values)">
            0..1
          </button>
          <button type="button" className={styles.toggle} data-on={follow ? "" : undefined} onClick={() => setFollow(!follow)} title="Follow the playhead, a page at a time">
            follow
          </button>
          <button type="button" className={styles.toggle} onClick={() => setView(frameAll(shown, width(), mode))} title="Frame all keys and handles (H)">
            H
          </button>
          <button type="button" className={styles.toggle} data-on={showTable ? "" : undefined} onClick={() => setShowTable(!showTable)} title="the selected keys as a table">
            table
          </button>
        </div>
        <div className={styles.body}>
        <div className={styles.curve}>
        {clipRows.length > 0 && (
          <ClipLanes
            graph={graph}
            rows={clipRows}
            view={view}
            rate={rate}
            snap={snap}
            grid={grid}
            playheadTicks={() => playhead.current}
            editor={ownEditor}
            onSeek={onSeek}
            onNotice={setNotice}
            frame={frame}
            {...(props.probeDuration === undefined ? {} : { probeDuration: props.probeDuration })}
          />
        )}
        <DopeStrip
          graph={graph}
          nodes={nodes}
          view={view}
          rate={rate}
          snap={snap}
          grid={grid}
          playheadTicks={() => playhead.current}
          bus={bus}
          invocation={invocation}
          currentNode={current?.id ?? null}
          onSelect={(nodeId, refs) => {
            if (nodeId !== null) setLastTouched(nodeId);
            setKeySelection({ nodeId, refs });
          }}
        />
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          data-timeline-canvas=""
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onWheel={onWheel}
          onContextMenu={(event) => event.preventDefault()}
        />
        </div>
        {showTable && current !== null && document !== null && (
          <div className={styles.side}>
            <KeyTable document={document} selection={keys} rate={rate} editable={current.editable} onChange={commitOnce} />
          </div>
        )}
        </div>
        {current === null && clipRows.length === 0 && <div className={styles.empty}>no lanes — + adds one</div>}
      </div>
    </div>
  );
}
