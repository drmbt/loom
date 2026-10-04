import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { authoredGraph, type GraphDocument } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import { createVec3GizmoStore } from "@editor/viewer/index.ts";
import type { GridLineActions } from "@editor/viewer/index.ts";
import { createMappingOverlay, mappingOverlayView } from "./perform-mapping-overlay.ts";
import type { MappingOverlayView } from "./perform-mapping-overlay.ts";
import { liveParameters, mappingTargetsAt, viewerPicture } from "./perform-mapping.ts";
import type { LiveReads, MappingTarget, Size } from "./perform-mapping.ts";

/**
 * §T1536b (viewer slice) — EDIT MAPPING IN THE VIEWER PANE, so mapping can be done in the
 * editor without a projector.
 *
 * The perform window's layer (`perform-mapping-overlay.ts`), mounted in a host element over
 * the viewer's frame: the same handles, the same gestures, the same write path (a parameter
 * editor on the bus with the app's invocation — one undo group per drag), the same Grid Warp
 * line insert/delete commands. Never drawn into the picture: the layer is DOM beside the
 * canvas, and the presentation is not touched.
 *
 * ## Which node's handles
 *
 * The viewer shows one node's output, and that node decides (`mappingTargetsAt`):
 *  - it IS a Corner Pin / Grid Warp → its own handles, straight into the picture box;
 *  - it is DOWNSTREAM of one → the window's chain walk from that node: the nearest mapping
 *    node, crossed through Corner Pins (§T1538b), refused by name past anything else;
 *  - it is upstream of one, or unrelated → nothing, and a one-line note says so.
 * The frame is the viewer's own contain-fit (`viewerPicture`, the `fitInsideRegion` call
 * `.picture` is sized by), where the window has its Fit and its letterbox. Every target on
 * the chain is offered (`targets`, for the bar's picker, as the window's inspector section
 * offers them), nearest first and the nearest by default — so a Grid Warp behind the Corner
 * Pin on screen is edited THROUGH it (§T1538b) once it is picked.
 *
 * ## Values are the ones on screen, read as the window reads them (§T1539b)
 *
 * A crossed Corner Pin whose corners are driven (an expression, a channel, a bind, a preset
 * morph in flight) is placed, not refused: it is resolved through the window's own resolve
 * (`liveParameters`) with the app's live reads (`reads`: the frame last rendered, the
 * compile's channels, the morphs), so the viewer and a perform window put the same handle at
 * the same picture point.
 *
 * Re-derived on the window's triggers — a toggle, a document change (a drag lands there
 * first), a new plan, a new output or size, and a resize of the frame — never per frame: a
 * corner that keeps moving is placed where it was at the last of those. The document is the
 * pane's own `graph` prop, the authored one, never a raw store read of this hook's. `M` is the
 * keymap's `viewer.editMapping` row; Escape is answered here, only while the mode is on.
 */

export interface ViewerMappingOptions {
  readonly bus: LoomBus;
  /**
   * The AUTHORED document as a React value (the pane's `graph`, `useGraphCompile`'s
   * subscription): the nodes the user placed, whose parameters a drag writes. Handed in
   * rather than read off the store, so the layer follows the same document the pane renders
   * (a dragged handle lands in the document first, then here).
   */
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  /** Who a drag is: the local human, as on the node's preview tile. */
  readonly invocation: InvocationContext;
  /** The output on screen — its node and its resolved size — or null when there is none. */
  readonly output: { readonly nodeId: string; readonly size: Size } | null;
  /** Changes when the pane's surface moves to another document (a floated pane, T705). */
  readonly surfaceKey: unknown;
  /**
   * §T1539b: what a crossed Corner Pin is resolved with — the window's live reads (§T1525b).
   * REQUIRED: an optional getter nothing supplies is how a reader resolves without it.
   */
  readonly reads: LiveReads;
  /** The plan on screen: a new one re-derives, as on the window (its channels came with it). */
  readonly plan: unknown;
}

/** One mapping node the viewer could edit, for the picker. */
export interface ViewerMappingChoice {
  readonly nodeId: string;
  /** `Corner Pin "<name>"`. */
  readonly label: string;
  /** Null when its handles land exactly; the named reason otherwise. */
  readonly refusal: string | null;
}

export interface ViewerMapping {
  readonly editing: boolean;
  /** While editing: every mapping node on the shown node's chain, nearest first. */
  readonly targets: readonly ViewerMappingChoice[];
  /** The one being edited (the nearest, until another is chosen). */
  readonly chosen: string | undefined;
  /** Edit another of `targets`. Stable. */
  readonly choose: (nodeId: string) => void;
  /** Set the mode (`undefined` toggles); returns the mode now in effect. Stable. */
  readonly setEditing: (on: boolean | undefined) => boolean;
  /** The element the layer mounts in: an empty box over the viewer's frame. */
  readonly hostRef: RefObject<HTMLDivElement | null>;
  /** Escape leaves the mode; true when it did (the key is then consumed). Stable. */
  readonly onKeyDown: (event: ReactKeyboardEvent) => boolean;
}

export const VIEWER_MAPPING_ABSENT_NOTE =
  "Nothing to map here: the viewer shows no Corner Pin or Grid Warp, and none feeds what it shows.";
export const VIEWER_MAPPING_NO_OUTPUT_NOTE = "The viewer shows no output, so there is nothing to map.";
/** The bar toggle's hover-help, off and on (§V90: carried by the control, never painted). */
export const VIEWER_MAPPING_HINT = "Edit mapping: Corner Pin / Grid Warp handles over the picture (M).";
export const VIEWER_MAPPING_HINT_ON = "Editing mapping — drag the handles over the picture. M or Escape stops.";

export function useViewerMapping({ bus, graph, registry, invocation, output, surfaceKey, reads, plan }: ViewerMappingOptions): ViewerMapping {
  const [editing, setEditingState] = useState(false);
  const editingRef = useRef(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const readsRef = useRef({ graph, registry, output, invocation, reads });
  readsRef.current = { graph, registry, output, invocation, reads };
  /** The live session's re-derive, for an output change; null while the mode is off. */
  const refreshRef = useRef<(() => void) | null>(null);
  const [targets, setTargets] = useState<readonly ViewerMappingChoice[]>([]);
  const targetsKeyRef = useRef("[]");
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  /** The picked target; when it is not on the chain any more, the nearest is edited. */
  const pickedRef = useRef<string | null>(null);
  const choose = useCallback((nodeId: string): void => {
    pickedRef.current = nodeId;
    refreshRef.current?.();
  }, []);

  const setEditing = useCallback((on: boolean | undefined): boolean => {
    const next = on ?? !editingRef.current;
    editingRef.current = next;
    setEditingState(next);
    return next;
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    const view = host?.ownerDocument.defaultView ?? null;
    if (!editing || host === null || view === null) return;
    const editor = createParameterEditor({ bus, context: readsRef.current.invocation });
    let message: string | null = null;
    /** The picker's rows, published only when they change (a drag re-derives on every write). */
    const publish = (all: readonly MappingTarget[], target: MappingTarget | undefined): void => {
      const rows = all.map((entry) => ({ nodeId: entry.nodeId, label: `${entry.title} "${entry.name}"`, refusal: entry.refusal }));
      const key = JSON.stringify(rows);
      if (key !== targetsKeyRef.current) {
        targetsKeyRef.current = key;
        setTargets(rows);
      }
      setChosen(target?.nodeId);
    };
    const viewOf = (): MappingOverlayView => {
      const { graph, registry: nodes, output: shown, reads: live } = readsRef.current;
      if (shown === null) {
        publish([], undefined);
        return { note: VIEWER_MAPPING_NO_OUTPUT_NOTE };
      }
      const all = mappingTargetsAt(graph, nodes, shown.nodeId);
      const target = all.find((entry) => entry.nodeId === pickedRef.current) ?? all[0];
      publish(all, target);
      return mappingOverlayView({
        graph,
        registry: nodes,
        target,
        absent: VIEWER_MAPPING_ABSENT_NOTE,
        where: "the viewer",
        // §T1539b: the crossed Corner Pins as on screen — the window's resolve, the app's live reads.
        valuesOf: (nodeId) => {
          const node = graph.nodes[nodeId];
          return node === undefined ? undefined : liveParameters(node, authoredGraph(graph), nodes, live).values;
        },
        frame: (lens) => ({ size: shown.size, place: (size) => viewerPicture(shown.size, size, lens) }),
        message,
      });
    };
    const refresh = (): void => overlay.update(viewOf());
    const report = (result: { status: string; diagnostics?: ReadonlyArray<{ message: string }> | undefined }): void => {
      if (refreshRef.current !== refresh) return;
      message = result.status === "applied" ? null : (result.diagnostics?.[0]?.message ?? "The edit was refused.");
      refresh();
    };
    // §T1534b's line insert/delete, on the bus as the tile's (`graph-pane.tsx`).
    const lines: GridLineActions = {
      insert: (nodeId, axis, at) => void bus.execute("gridWarp.insertLine", { nodeId, axis, at }, readsRef.current.invocation).then(report),
      remove: (nodeId, axis, index) => void bus.execute("gridWarp.deleteLine", { nodeId, axis, index }, readsRef.current.invocation).then(report),
    };
    // The viewer's document carries the editor's stylesheet, so the tokens are inherited.
    const overlay = createMappingOverlay({ window: view, host, store: createVec3GizmoStore({ editor }), lines, tokens: {} });
    refreshRef.current = refresh;
    refresh();
    return () => {
      refreshRef.current = null;
      overlay.dispose();
      editor.dispose();
      targetsKeyRef.current = "[]";
      setTargets([]);
      setChosen(undefined);
    };
  }, [editing, bus, surfaceKey]);

  // The document moved (a dragged handle lands there first), a new plan, another node is on
  // screen, or the same one at a new size: the layer follows.
  const shownKey = output === null ? null : `${output.nodeId}:${output.size.join("x")}`;
  useEffect(() => {
    refreshRef.current?.();
  }, [graph, plan, shownKey, registry]);

  const onKeyDown = useCallback((event: ReactKeyboardEvent): boolean => {
    if (event.key !== "Escape" || !editingRef.current) return false;
    event.preventDefault();
    event.stopPropagation();
    setEditing(false);
    return true;
  }, [setEditing]);

  return { editing, targets, chosen, choose, setEditing, hostRef, onKeyDown };
}
