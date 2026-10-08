import { createContext } from "react";

/**
 * VN63 — DRAGGING A PARAMETER'S NAME CARRIES A REFERENCE TO IT.
 *
 * Ctrl/Cmd-drag on a parameter's name carries a reference. Plain dragging keeps the
 * immediate value ladder (T1026's compound scrub, `label-drag.ts`). Dropped on another parameter it becomes `op('<src>').par.<key>`;
 * dropped on the timeline's lane list it becomes a lane the parameter reads.
 *
 * The drag is HTML5 drag and drop, so it can leave the row: the payload is
 * `application/x-loom-parameter` (`{ nodeId, key }`), with `text/plain` carrying the
 * reference as an expression for any text field it lands in.
 *
 * `src/ui` cannot reach the graph or the bus (§V1028's layering), so what a drag carries
 * and what a drop writes come from this context, which the composition root provides
 * (`src/editor/parameter-drag/`). With no provider, names are not draggable and rows are
 * not drop targets: the controls behave exactly as before.
 */

export const PARAMETER_DRAG_TYPE = "application/x-loom-parameter";

export interface ParameterDragPayload {
  readonly nodeId: string;
  readonly key: string;
}

export interface ParameterDragService {
  /** The text a drag of this parameter carries (`op('noise1').par.period`), or null when it cannot be referenced (an unnamed node). */
  readonly referenceText: (source: ParameterDragPayload) => string | null;
  /** A drop of `source` onto the parameter row `target`. */
  readonly dropOnParameter: (target: ParameterDragPayload, source: ParameterDragPayload) => void;
}

export const ParameterDragContext = createContext<ParameterDragService | null>(null);

/** The node a control row belongs to: the closest element that names one (the inspector's root does). */
export function nodeIdOf(element: Element | null): string | null {
  return element?.closest("[data-node-id]")?.getAttribute("data-node-id") ?? null;
}

/** Write a parameter drag into a DataTransfer. */
export function writeParameterDrag(transfer: DataTransfer, source: ParameterDragPayload, text: string): void {
  transfer.setData(PARAMETER_DRAG_TYPE, JSON.stringify({ nodeId: source.nodeId, key: source.key }));
  transfer.setData("text/plain", text);
  transfer.effectAllowed = "copyLink";
}

/** Whether a drag in progress carries a parameter (readable during dragover, when the data itself is not). */
export function carriesParameter(transfer: DataTransfer | null): boolean {
  return transfer !== null && Array.from(transfer.types).includes(PARAMETER_DRAG_TYPE);
}

/** The parameter a drop carries, or null. */
export function readParameterDrag(transfer: DataTransfer | null): ParameterDragPayload | null {
  const raw = transfer?.getData(PARAMETER_DRAG_TYPE) ?? "";
  if (raw === "") return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const { nodeId, key } = parsed as Record<string, unknown>;
    return typeof nodeId === "string" && typeof key === "string" && nodeId !== "" && key !== "" ? { nodeId, key } : null;
  } catch {
    return null;
  }
}
