import { useState } from "react";
import type { DragEvent } from "react";
import { carriesParameter, readParameterDrag, type ParameterDragPayload } from "@ui/controls/parameter-drag-context.ts";
import type { AutomationLane } from "@domain/automation/model.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { LANE_PALETTE } from "./timeline-edits.ts";
import type { AutomationNodeView } from "./timeline-model.ts";
import styles from "./timeline-pane.module.css";

/**
 * VN62 — THE LANE LIST: every automation node, grouped, its lanes beneath it. The header
 * names the CURRENT node, so a + never lands somewhere surprising. Every action is a
 * callback; the pane turns each into ONE write through the bus.
 */
export interface LaneListProps {
  readonly nodes: readonly AutomationNodeView[];
  readonly current: AutomationNodeView | null;
  /** lane name → how many parameters read it, for the current node (derived, never stored). */
  readonly references: ReadonlyMap<string, number>;
  readonly solo: string | null;
  readonly onMakeCurrent: (nodeId: NodeId) => void;
  readonly onAddLane: () => void;
  readonly onRename: (nodeId: NodeId, laneId: string, name: string) => string | null;
  readonly onColour: (nodeId: NodeId, laneId: string, colour: string) => void;
  readonly onToggleMute: (nodeId: NodeId, lane: AutomationLane) => void;
  readonly onToggleLock: (nodeId: NodeId, lane: AutomationLane) => void;
  readonly onSolo: (laneId: string | null) => void;
  readonly onMove: (nodeId: NodeId, laneId: string, index: number) => void;
  readonly onDelete: (nodeId: NodeId, laneId: string) => void;
  /**
   * VN63 — a parameter dropped on the list. On a lane: `laneId` names it, and only the
   * reference is written. Anywhere else: a new lane, on `nodeId` (a group's header) or on
   * the current node (null).
   */
  readonly onDropParameter?: (source: ParameterDragPayload, nodeId: NodeId | null, laneId: string | null) => void;
}

/** Drop handlers for one place on the list; `over` marks it while a parameter is above it. */
function dropZone(
  onDropParameter: LaneListProps["onDropParameter"],
  nodeId: NodeId | null,
  laneId: string | null,
  setOver: (zone: string | null) => void,
  zone: string,
) {
  if (onDropParameter === undefined) return {};
  return {
    onDragOver: (event: DragEvent<HTMLElement>): void => {
      if (!carriesParameter(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "link";
      setOver(zone);
    },
    onDragLeave: (): void => setOver(null),
    onDrop: (event: DragEvent<HTMLElement>): void => {
      setOver(null);
      const source = readParameterDrag(event.dataTransfer);
      if (source === null) return;
      event.preventDefault();
      event.stopPropagation();
      onDropParameter(source, nodeId, laneId);
    },
  };
}

const nextColour = (colour: string): string => {
  const index = (LANE_PALETTE as readonly string[]).indexOf(colour);
  return LANE_PALETTE[(index + 1) % LANE_PALETTE.length]!;
};

export function LaneList(props: LaneListProps) {
  const { nodes, current } = props;
  const [renaming, setRenaming] = useState<{ lane: string; text: string; error: string | null } | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const drop = (nodeId: NodeId | null, laneId: string | null, zone: string) => dropZone(props.onDropParameter, nodeId, laneId, setOver, zone);

  return (
    <div className={styles.lanes} data-drop-over={over === "list" ? "" : undefined} data-lane-drop="list" {...drop(null, null, "list")}>
      <div className={styles.lanesHeader}>
        <span className={styles.currentName} data-current-node={current?.id ?? ""}>
          {current === null ? "no automation node" : (current.name ?? current.id)}
        </span>
        <button
          type="button"
          className={styles.iconButton}
          onClick={props.onAddLane}
          disabled={current !== null && !current.editable}
          title={current === null ? "Add a lane in a new automation node" : `Add a lane to ${current.name ?? current.id}`}
          aria-label="add lane"
        >
          +
        </button>
      </div>
      {nodes.map((node) => (
        <div key={node.id} className={styles.group} data-automation-node={node.id} data-drop-over={over === node.id ? "" : undefined} {...drop(node.id, null, node.id)}>
          <button
            type="button"
            className={styles.groupName}
            data-current={node.id === current?.id ? "" : undefined}
            onClick={() => props.onMakeCurrent(node.id)}
          >
            {node.name ?? node.id}
          </button>
          {node.error !== null && <div className={styles.error}>{node.error}</div>}
          {node.id === current?.id &&
            node.document?.lanes.map((lane, index) => {
              const references = props.references.get(lane.name) ?? 0;
              return (
                <div
                  key={lane.id}
                  className={styles.lane}
                  data-lane={lane.id}
                  data-muted={lane.mute ? "" : undefined}
                  data-drop-over={over === `${node.id} ${lane.id}` ? "" : undefined}
                  {...drop(node.id, lane.id, `${node.id} ${lane.id}`)}
                >
                  <button
                    type="button"
                    className={styles.swatch}
                    style={{ background: `var(--${lane.color}, var(--signal))` }}
                    onClick={() => props.onColour(node.id, lane.id, nextColour(lane.color))}
                    aria-label={`colour of ${lane.name}`}
                    disabled={!node.editable}
                  />
                  {renaming?.lane === lane.id ? (
                    <input
                      className={styles.renameField}
                      aria-label={`rename ${lane.name}`}
                      value={renaming.text}
                      autoFocus
                      onChange={(event) => setRenaming({ ...renaming, text: event.target.value, error: null })}
                      onBlur={() => setRenaming(null)}
                      onKeyDown={(event) => {
                        // A field's keys are the field's: none reach the curve editor or the graph.
                        event.stopPropagation();
                        if (event.key === "Escape") setRenaming(null);
                        if (event.key === "Enter") {
                          const error = props.onRename(node.id, lane.id, renaming.text.trim());
                          setRenaming(error === null ? null : { ...renaming, error });
                        }
                      }}
                      title={renaming.error ?? undefined}
                      aria-invalid={renaming.error !== null}
                    />
                  ) : (
                    <span
                      className={styles.laneName}
                      onDoubleClick={() => node.editable && setRenaming({ lane: lane.id, text: lane.name, error: null })}
                      title={`op('${node.name ?? "?"}').chan.${lane.name} — double-click to rename`}
                    >
                      {lane.name}
                    </span>
                  )}
                  <span className={styles.refs} title="parameters that read this lane" data-references={references}>
                    {references}
                  </span>
                  <button type="button" className={styles.toggle} data-on={lane.mute ? "" : undefined} onClick={() => props.onToggleMute(node.id, lane)} disabled={!node.editable} aria-label={`mute ${lane.name}`} title="Mute: hold the value at the playhead">
                    M
                  </button>
                  <button type="button" className={styles.toggle} data-on={props.solo === lane.id ? "" : undefined} onClick={() => props.onSolo(props.solo === lane.id ? null : lane.id)} aria-label={`solo ${lane.name}`} title="Solo: show only this lane (view only)">
                    S
                  </button>
                  <button type="button" className={styles.toggle} data-on={lane.lock ? "" : undefined} onClick={() => props.onToggleLock(node.id, lane)} disabled={!node.editable} aria-label={`lock ${lane.name}`} title="Lock: refuse edits to this lane's keys">
                    L
                  </button>
                  <button type="button" className={styles.toggle} onClick={() => props.onMove(node.id, lane.id, index - 1)} disabled={!node.editable || index === 0} aria-label={`move ${lane.name} up`}>
                    ↑
                  </button>
                  <button type="button" className={styles.toggle} onClick={() => props.onMove(node.id, lane.id, index + 1)} disabled={!node.editable || index === (node.document?.lanes.length ?? 0) - 1} aria-label={`move ${lane.name} down`}>
                    ↓
                  </button>
                  {confirming === lane.id ? (
                    <button
                      type="button"
                      className={styles.danger}
                      onClick={() => {
                        setConfirming(null);
                        props.onDelete(node.id, lane.id);
                      }}
                      onBlur={() => setConfirming(null)}
                      aria-label={`confirm delete ${lane.name}`}
                    >
                      {references === 0 ? "delete?" : `delete? ${references} read${references === 1 ? "s" : ""} it`}
                    </button>
                  ) : (
                    <button type="button" className={styles.toggle} onClick={() => setConfirming(lane.id)} disabled={!node.editable} aria-label={`delete ${lane.name}`}>
                      ×
                    </button>
                  )}
                </div>
              );
            })}
        </div>
      ))}
    </div>
  );
}
