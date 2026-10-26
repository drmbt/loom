import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { serializeAutomation, type AutomationDocument } from "@domain/automation/model.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { FrameRate } from "@domain/time/ticks.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { DOPE_ROW_HEIGHT, dopeHit, dopeRows, refsAtTicks, retimeColumns } from "./dope-sheet.ts";
import { beginGesture, type GestureWriter } from "./gesture-writer.ts";
import { snapTicks, type KeyRef, type SnapMode } from "./timeline-edits.ts";
import type { BeatGrid } from "./beat-grid.ts";
import { lanesStored, type AutomationNodeView } from "./timeline-model.ts";
import { tokenColour } from "./timeline-draw.ts";
import { tickToX, type TimelineView } from "./timeline-view.ts";
import styles from "./timeline-pane.module.css";

/**
 * VN62 — THE DOPE-SHEET STRIP, above the curve editor on the same time axis: a summary
 * row of every automation node's keys, then a row per node. Click a diamond to select the
 * keys on that tick (the curve editor shows them selected for the current node); drag it
 * to retime every key on that tick in the row's scope as ONE gesture, one undo step, even
 * when the summary row moves keys in several nodes (`gesture-writer.ts`).
 */
export interface DopeStripProps {
  readonly graph: GraphDocument;
  readonly nodes: readonly AutomationNodeView[];
  readonly view: TimelineView;
  readonly rate: FrameRate;
  readonly snap: SnapMode;
  /** VN68: the reference's beat grid, for the beat snap modes. */
  readonly grid?: BeatGrid | null;
  readonly playheadTicks: () => number | null;
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** The keys of `nodeId` on the clicked ticks, for the curve editor's selection. */
  readonly onSelect: (nodeId: NodeId | null, refs: readonly KeyRef[]) => void;
  readonly currentNode: NodeId | null;
}

interface StripDrag {
  readonly x: number;
  readonly ticks: ReadonlySet<number>;
  readonly origin: ReadonlyMap<NodeId, AutomationDocument>;
  readonly writer: GestureWriter;
  moved: boolean;
}

export function DopeStrip(props: DopeStripProps) {
  const { nodes, view, rate } = props;
  const rows = dopeRows(nodes);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [selected, setSelected] = useState<{ row: string; ticks: ReadonlySet<number> } | null>(null);
  const drag = useRef<StripDrag | null>(null);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ratio = canvas.ownerDocument.defaultView?.devicePixelRatio ?? 1;
    const width = Math.max(1, canvas.clientWidth);
    const height = rows.length * DOPE_ROW_HEIGHT;
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(height * ratio);
    const context = canvas.getContext("2d");
    if (context === null) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.fillStyle = tokenColour(canvas, "bg-panel");
    context.fillRect(0, 0, width, height);
    context.font = `9px ${getComputedStyle(canvas).getPropertyValue("--font-mono").trim() || "monospace"}`;
    context.textBaseline = "middle";
    rows.forEach((row, index) => {
      const middle = index * DOPE_ROW_HEIGHT + DOPE_ROW_HEIGHT / 2;
      context.fillStyle = tokenColour(canvas, index === 0 ? "bg-raise" : "bg-sunken");
      context.fillRect(0, index * DOPE_ROW_HEIGHT, width, DOPE_ROW_HEIGHT - 1);
      context.fillStyle = tokenColour(canvas, "text-dim");
      context.fillText(row.label, 4, middle);
      for (const tick of row.columns) {
        const x = tickToX(view, tick);
        if (x < -4 || x > width + 4) continue;
        const isSelected = selected !== null && selected.row === row.id && selected.ticks.has(tick);
        context.fillStyle = tokenColour(canvas, isSelected ? "signal" : index === 0 ? "text" : "text-dim");
        context.beginPath();
        context.moveTo(x, middle - 4);
        context.lineTo(x + 4, middle);
        context.lineTo(x, middle + 4);
        context.lineTo(x - 4, middle);
        context.closePath();
        context.fill();
      }
    });
    const playhead = props.playheadTicks();
    if (playhead !== null) {
      context.strokeStyle = tokenColour(canvas, "signal");
      const x = Math.round(tickToX(view, playhead)) + 0.5;
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }
  });

  // The selection names ticks; a retime moves them, so follow the drag's last distance.
  useEffect(() => {
    if (selected !== null && !rows.some((row) => row.id === selected.row)) setSelected(null);
  }, [rows, selected]);

  const documentsOf = (nodeIds: readonly NodeId[]): Map<NodeId, AutomationDocument> => {
    const documents = new Map<NodeId, AutomationDocument>();
    for (const nodeId of nodeIds) {
      const node = nodes.find((each) => each.id === nodeId);
      if (node?.document != null && node.editable) documents.set(nodeId, node.document);
    }
    return documents;
  };

  const select = (rowId: string, ticks: ReadonlySet<number>, nodeIds: readonly NodeId[]): void => {
    setSelected({ row: rowId, ticks });
    const target = props.currentNode !== null && nodeIds.includes(props.currentNode) ? props.currentNode : (nodeIds[0] ?? null);
    const document = nodes.find((node) => node.id === target)?.document ?? null;
    props.onSelect(target, document === null ? [] : refsAtTicks(document, ticks));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const box = event.currentTarget.getBoundingClientRect();
    const hit = dopeHit(view, rows, event.clientX - box.left, event.clientY - box.top);
    if (hit === null) {
      setSelected(null);
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const already = selected !== null && selected.row === hit.row.id;
    const ticks = event.shiftKey && already ? new Set([...selected.ticks, hit.tick]) : already && selected.ticks.has(hit.tick) ? selected.ticks : new Set([hit.tick]);
    select(hit.row.id, ticks, hit.row.nodes);
    drag.current = { x: event.clientX, ticks, origin: documentsOf(hit.row.nodes), writer: beginGesture(props.bus, props.invocation, "Retime keys"), moved: false };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const current = drag.current;
    if (current === null) return;
    const dx = event.clientX - current.x;
    if (!current.moved && Math.abs(dx) < 3) return;
    current.moved = true;
    const retimed = retimeColumns(current.origin, current.ticks, snapTicks(dx * view.ticksPerPixel, props.snap, rate, props.grid ?? null, true));
    const operations: GraphPatchOperation[] = [];
    // Every node in scope is written, moved or not, so a drag back to the start restores it.
    for (const [nodeId, origin] of current.origin) {
      const next = retimed.documents.get(nodeId) ?? origin;
      operations.push({ op: "setParameters", nodeId, parameters: { lanes: lanesStored(props.graph.nodes[nodeId]?.parameters["lanes"], serializeAutomation(next)) } });
    }
    current.writer.write(operations);
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const current = drag.current;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (current === null) return;
    void current.writer.end();
    if (current.moved) setSelected(null);
  };

  return (
    <canvas
      ref={canvasRef}
      className={styles.dope}
      style={{ height: rows.length * DOPE_ROW_HEIGHT }}
      data-dope-strip=""
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}
