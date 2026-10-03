import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useStoreApi } from "@xyflow/react";
import type { ReactFlowState } from "@xyflow/react";
import type { NodeId } from "@domain/types/ids.ts";
import { fitInsideRegion } from "@editor/nodes/preview-fit.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import { GRID_WARP_MIN, gridWarpInverse, gridWarpPoint, parsePointKey } from "@nodes/definitions/grid-warp.ts";
import type { GridAxis, WarpGrid } from "@nodes/definitions/grid-warp.ts";
import { GRID_WARP_MAX } from "@nodes/shaders/grid-warp.wgsl.ts";
import { slotScreenRect } from "@runtime/previews/index.ts";
import { ContextMenuContent, ContextMenuItem, ContextMenuRoot, ContextMenuTrigger } from "@ui/primitives/context-menu.tsx";
import type { OrbitCameraBasis, PreviewOrbit } from "@runtime/previews/index.ts";
import { handleScreenPoint, pointerToPlane, tileCamera } from "./gizmo-projection.ts";
import type { PictureRect, TileCamera } from "./gizmo-projection.ts";
import type { GizmoHandle, Vec3GizmoStore } from "./vec3-gizmo-store.ts";
import type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";
import styles from "./viewer.module.css";

/**
 * T935 — THE HANDLES, DRAWN ON THE PICTURE THEY BELONG TO.
 *
 * ## The host, and why the viewer pane is not one yet
 *
 * §V633 is structural and it decides this file's shape: `.react-flow__viewport` is a
 * transformed element at z-index 2 and therefore a stacking context, while the shared
 * preview surface composites every live tile at 30 — so anything drawn inside a node's
 * preview slot is painted over exactly when the tile is live, which is exactly when there
 * is something to point at. §T892 already solved this once for the camera toggle: a
 * PANE-LEVEL layer that is a SIBLING of the compositing surface, at `--z-canvas-chrome`
 * (31), `pointer-events: none` with `auto` on each control. This is a second layer of the
 * same kind rather than more children of that one, because the two answer different
 * questions — one control per orbitable tile, versus N handles per parameter — and
 * `preview-inspect-overlay.tsx`'s selector is built around the first.
 *
 * The pointer problem solves itself here for §T892's reason, restated because it is the
 * load-bearing part: a handle is not a descendant of `NodePreviewSlot`, so pressing one
 * cannot start the tile's orbit gesture, and it is outside React Flow entirely, so
 * d3-zoom (which listens on `.react-flow__pane`) never sees the press either. Structure,
 * not a `stopPropagation` someone can delete.
 *
 * THE BIG VIEWER PANE HAS NO SUCH LAYER, and that is a finding rather than an omission:
 * `app/side-panes.tsx`'s viewer is a `<canvas>` filling a `.picture` box, handed straight
 * to `backend.present`. Gizmos there need that pane to grow an overlay sibling first — a
 * `src/app` change with its own hit-testing — which is why this row lands on the graph
 * pane's tiles and says so. THE ASPECT HALF OF THAT DIVERGENCE IS GONE (T1158): the viewer
 * used to stretch the blit to a `16 / 9` frame while a node tile letterboxed, and it now
 * letterboxes through `fitInsideRegion`, the same §V118 call used below.
 *
 * ## Positioned, never measured — with one deliberate exception
 *
 * Placement uses `slotScreenRect` over `fitInsideRegion`, which is the exact arithmetic
 * `use-node-previews.ts` composites the tile with (§V118's letterbox included — the
 * picture is not the slot whenever the output's aspect differs, and a handle placed on the
 * slot would sit in the black bars). Per-frame `getBoundingClientRect` is the
 * forced-layout-during-pan mistake design note §2 warns about.
 *
 * The exception is ONE measurement at `pointerdown`: pointer events carry client
 * coordinates and every rect above is in PANE coordinates, so the layer's own origin has
 * to be measured to convert. Once per gesture, at the moment of the action (§V657), never
 * per frame.
 *
 * ## Why an animation frame, and why it is not a per-frame re-render
 *
 * A handle must follow the camera. Canvas pan, canvas zoom and an uncommitted node drag
 * arrive through React Flow's own store (§V112). The INSPECTION ORBIT does not: `apply`
 * and `zoom` on `PreviewOrbitStore` deliberately notify nobody, because the preview tick
 * samples them per frame and §T714's stutter is what happens when that becomes React
 * state. So the subscription below composes React Flow's store with an animation frame,
 * and `read()` returns the CACHED array whenever nothing moved — the frame is a poll, and
 * a poll that finds no change re-renders nothing. During an orbit drag this layer costs
 * what §T892's button already costs during a pan: a few absolutely-positioned elements.
 *
 * The loop does not start at all while `active` is false, which is every document with no
 * 3D tile offering a world-space vec3.
 *
 * ## §T1491b — picture handles, on a texture tile
 *
 * A Corner Pin's four pins are points on the node's OWN OUTPUT PICTURE (normalised, y up),
 * so its tile offers them with no camera at all: the fitted picture rect above IS the
 * coordinate frame, a pin at (u, v) sits at `rect.x + u·width, rect.y + (1 − v)·height`, and
 * a drag inverts that. Everything else is this layer's and the store's, unchanged — the
 * placement arithmetic §V118 letterboxes, the one measurement at pointerdown, the refusal,
 * the live/commit gesture that is one undo group. A tile carries a `basis` only when it is
 * a 3D picture; a texture tile carries none and offers only picture handles. A pin past the
 * frame (overscan) is drawn past the picture, where its value puts it — it is still the
 * point the drag moves.
 *
 * ## §T1534b — a Grid Warp's rows and columns, inserted and deleted on its picture
 *
 * The gestures, and why these:
 *
 *  - OPTION/ALT + CLICK on the picture inserts a COLUMN through the clicked place;
 *    OPTION/ALT + SHIFT + CLICK inserts a ROW. While the modifier is held the line that a
 *    click would insert is drawn under the pointer, along the warped surface, so the
 *    choice is visible before it is made. Alt is the tile's own key already (T675: the
 *    camera key on a 3D tile, and the only modifier React Flow leaves free); a Grid Warp
 *    tile has no camera, so on it alt means the grid's own tool — MadMapper's Alt+click.
 *    The capture surface exists only while alt is down, so a plain press on the tile
 *    still selects and drags the node exactly as before.
 *  - RIGHT-CLICK ON A POINT opens "Delete column N" / "Delete row N" (MadMapper's Remove
 *    Vertical / Horizontal; Stoner's select-a-point-then-Delete-Row). Right-click is not a
 *    drag button, so the left-button drag of that same point is untouched.
 *
 * The click is in OUTPUT space; `gridWarpInverse` finds the grid coordinate under it on the
 * mesh the shader draws, so the line lands where it looks like it lands, and a click off
 * the surface does nothing. Both write through the bus (`gridWarp.insertLine`,
 * `gridWarp.deleteLine`) as one undo step; the caps (2..8) are honoured before the press
 * (no line is offered, the menu row is disabled with the reason) and refused by the command.
 */

/** Everything one tile needs to place and drag its handles. */
export interface PreviewGizmoTile {
  /**
   * The compiler's published basis for this tile's synthesized pass. Absent on a texture
   * tile, which has no camera and offers only picture handles (§T1491b).
   */
  readonly basis?: OrbitCameraBasis;
  /** This pane's live inspection deltas, or undefined for the baked framing. */
  readonly orbit: PreviewOrbit | undefined;
  /** The synthesized target's pixel size — §V118's letterbox input. */
  readonly source: readonly [number, number];
  readonly handles: readonly GizmoHandle[];
  /** §T1534b: a Grid Warp's effective grid — its rows and columns can be inserted and deleted here. */
  readonly grid?: WarpGrid | undefined;
}

/** §T1534b — what the overlay asks of the document for a Grid Warp's lines. The caller dispatches on the bus. */
export interface GridLineActions {
  /** Insert a line at `at`, 0..1 along the surface as the grid lies. */
  insert(nodeId: NodeId, axis: GridAxis, at: number): void;
  /** Delete column or row `index` (from 0). */
  remove(nodeId: NodeId, axis: GridAxis, index: number): void;
}

export interface PreviewGizmoOverlaysProps {
  /** Where each node's preview slot is, in its own node's coordinates (§V111). */
  bounds: PreviewSlotBoundsStore;
  /**
   * One tile's facts, or null where there is nothing to draw. Called per node per frame,
   * so the caller memoizes what it can — but it must read the ORBIT freshly, because that
   * is the input no store notifies about.
   */
  tile: (nodeId: NodeId) => PreviewGizmoTile | null;
  /** The document-writing store every drag goes through (§V29). */
  store: Vec3GizmoStore;
  /** False when no node in this document offers a handle: the frame loop stays off. */
  active: boolean;
  /** §T1534b: a Grid Warp's line insert/delete. Absent, its tile offers only the point drags. */
  lines?: GridLineActions | undefined;
}

interface Placement {
  readonly nodeId: NodeId;
  readonly handle: GizmoHandle;
  /** Null on a texture tile: its picture handles are placed by the rect alone (§T1491b). */
  readonly camera: TileCamera | null;
  readonly rect: PictureRect;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
  /** §T1534b: the tile's Grid Warp grid, or null on every other tile. */
  readonly grid: WarpGrid | null;
}

const EMPTY: readonly Placement[] = [];

/** By value: a caller that derives the grid afresh per frame must not re-render the layer per frame. */
function sameGrid(a: WarpGrid | null, b: WarpGrid | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const sameNumbers = (x: readonly number[] | undefined, y: readonly number[] | undefined): boolean =>
    x === y || (x !== undefined && y !== undefined && x.length === y.length && x.every((value, index) => value === y[index]));
  return (
    a.columns === b.columns &&
    a.rows === b.rows &&
    a.smooth === b.smooth &&
    a.points.length === b.points.length &&
    a.points.every((point, index) => sameNumbers(point, b.points[index])) &&
    sameNumbers(a.us, b.us) &&
    sameNumbers(a.vs, b.vs)
  );
}

function samePlacements(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    if (right === undefined) return false;
    // The camera is compared through its POSE, not its matrix: two poses that project
    // this handle to the same pixel can still define different drag planes, and the
    // pointerdown handler reads the camera off the cached placement.
    const pose = (side: Placement): readonly number[] =>
      side.camera === null ? [] : [...side.camera.pose.eye, ...side.camera.pose.lookAt];
    return (
      left.nodeId === right.nodeId &&
      sameGrid(left.grid, right.grid) &&
      left.handle.key === right.handle.key &&
      left.handle.refusal === right.handle.refusal &&
      left.handle.value.length === right.handle.value.length &&
      left.handle.value.every((v, i) => v === right.handle.value[i]) &&
      left.x === right.x &&
      left.y === right.y &&
      left.zoom === right.zoom &&
      left.rect.x === right.rect.x &&
      left.rect.y === right.rect.y &&
      left.rect.width === right.rect.width &&
      left.rect.height === right.rect.height &&
      pose(left).length === pose(right).length &&
      pose(left).every((v, i) => v === pose(right)[i])
    );
  });
}

export function PreviewGizmoOverlays({ bounds, tile, store, active, lines }: PreviewGizmoOverlaysProps) {
  const boxes = useSyncExternalStore(bounds.subscribe, bounds.snapshot, bounds.snapshot);

  const select = useMemo(
    () =>
      (state: ReactFlowState): readonly Placement[] => {
        const [tx, ty, zoom] = state.transform;
        const placements: Placement[] = [];
        // Driven by the MEASURED SLOTS, exactly as the inspect overlay is: a node with no
        // published slot has no picture to draw a handle on.
        for (const [id, box] of boxes) {
          const facts = tile(id);
          if (facts === null || facts.handles.length === 0) continue;
          const internal = state.nodeLookup.get(id);
          if (internal === undefined) continue;
          // §V118 — the PICTURE, not the slot. `use-node-previews.ts` composites the tile
          // into this same fitted box, so a handle placed on the slot would land in the
          // letterbox bars whenever the output's aspect differs from the node's.
          const fitted = fitInsideRegion(box, facts.source);
          const rect = slotScreenRect(
            {
              x: internal.position.x + box.x + fitted.x,
              y: internal.position.y + box.y + fitted.y,
              width: fitted.width,
              height: fitted.height,
            },
            { x: tx, y: ty, zoom },
          );
          const camera = facts.basis === undefined ? null : tileCamera(facts.basis, facts.orbit);
          const grid = facts.grid ?? null;
          for (const handle of facts.handles) {
            if (handle.space === "picture") {
              // §T1491b — y UP in the value, y DOWN on the screen.
              const [u, v] = handle.value;
              const x = rect.x + u * rect.width;
              const y = rect.y + (1 - v) * rect.height;
              placements.push({ nodeId: id, handle, camera, rect, x, y, zoom, grid });
              continue;
            }
            if (camera === null) continue;
            const point = handleScreenPoint(camera, handle.value, rect);
            // Off-frame and behind-camera are both "nowhere to draw it". The tile orbits
            // and dollies, so the value is one wheel turn from being reachable; a handle
            // clamped to the edge would claim a position the parameter does not have.
            if (!point.visible) continue;
            placements.push({ nodeId: id, handle, camera, rect, x: point.x, y: point.y, zoom, grid });
          }
        }
        return placements;
      },
    [boxes, tile],
  );

  /*
   * React Flow's own store (a pan, a zoom, an uncommitted node drag — §V112) composed
   * with an animation frame (the inspection orbit, which notifies nobody by design).
   * Subscribed through `useStoreApi` rather than React Flow's selector hook, whose NAME
   * `no-document-store.test.ts` bans anywhere in this directory: in every other file here
   * it would mean a document subscription, and arguing that this instance means a
   * different store is exactly the erosion the guard exists to prevent.
   */
  const api = useStoreApi();
  const cached = useRef<readonly Placement[]>(EMPTY);
  const read = useCallback(() => {
    const next = select(api.getState());
    if (samePlacements(cached.current, next)) return cached.current;
    cached.current = next;
    return next;
  }, [api, select]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = api.subscribe(listener);
      if (!active) return unsubscribe;
      let frame = requestAnimationFrame(function poll() {
        listener();
        frame = requestAnimationFrame(poll);
      });
      return () => {
        cancelAnimationFrame(frame);
        unsubscribe();
      };
    },
    [api, active],
  );
  const placements = useSyncExternalStore(subscribe, read, read);

  const layer = useRef<HTMLDivElement | null>(null);
  /** §T1534b: one line surface per Grid Warp tile, from its first placement. */
  const surfaces = useMemo(() => {
    const seen = new Map<NodeId, GridSurface>();
    for (const { nodeId, rect, grid } of placements) if (grid !== null && !seen.has(nodeId)) seen.set(nodeId, { nodeId, rect, grid });
    return [...seen.values()];
  }, [placements]);
  const modifiers = useModifierKeys(lines !== undefined && surfaces.length > 0);
  if (placements.length === 0) return null;
  return (
    <div ref={layer} className={styles.previewChrome} data-testid="preview-gizmo-overlays">
      {/* Under the handles, so a handle stays draggable with alt held. */}
      {lines !== undefined && modifiers.alt
        ? surfaces.map((surface) => (
            <GridLineSurface
              key={surface.nodeId}
              surface={surface}
              axis={modifiers.shift ? "row" : "column"}
              lines={lines}
              layer={layer}
            />
          ))
        : null}
      {placements.map((placement) => (
        <GizmoHandleControl
          key={`${placement.nodeId} ${placement.handle.key}`}
          placement={placement}
          store={store}
          layer={layer}
          lines={lines}
        />
      ))}
    </div>
  );
}

/**
 * §T1534b — whether alt and shift are down, while any tile could use them. Read off every
 * key and pointer event (a pointer move carries the modifiers, so a key released while the
 * window was elsewhere corrects itself on the next move), and dropped on blur.
 */
function useModifierKeys(enabled: boolean): { readonly alt: boolean; readonly shift: boolean } {
  const [state, setState] = useState(NO_MODIFIERS);
  useEffect(() => {
    if (!enabled) return;
    const update = (event: KeyboardEvent | PointerEvent): void => {
      setState((previous) =>
        previous.alt === event.altKey && previous.shift === event.shiftKey ? previous : { alt: event.altKey, shift: event.shiftKey },
      );
    };
    const reset = (): void => setState(NO_MODIFIERS);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("pointermove", update);
    window.addEventListener("blur", reset);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("pointermove", update);
      window.removeEventListener("blur", reset);
    };
  }, [enabled]);
  return enabled ? state : NO_MODIFIERS;
}

const NO_MODIFIERS: { readonly alt: boolean; readonly shift: boolean } = { alt: false, shift: false };

interface GridSurface {
  readonly nodeId: NodeId;
  readonly rect: PictureRect;
  readonly grid: WarpGrid;
}

/** Points along a line of the grid, every sub-quad vertex the shader draws: 16 per cell. */
const LINE_STEPS_PER_CELL = 16;

/**
 * §T1534b — a Grid Warp's picture while alt is held: a press inserts the line through the
 * pressed place, and hovering draws that line first. Only mounted while alt is down, so it
 * never takes a plain press from the node.
 */
function GridLineSurface({
  surface,
  axis,
  lines,
  layer,
}: {
  surface: GridSurface;
  axis: GridAxis;
  lines: GridLineActions;
  layer: RefObject<HTMLDivElement | null>;
}) {
  const { nodeId, rect, grid } = surface;
  const [hover, setHover] = useState<{ readonly gu: number; readonly gv: number } | null>(null);
  const full = (axis === "column" ? grid.columns : grid.rows) >= GRID_WARP_MAX;

  /** The grid coordinate under the pointer, on the drawn mesh — or null off the surface. */
  const locate = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      // Pointer events are in client coordinates and the rect in pane coordinates: the
      // layer's origin, measured at the event (§V657), converts.
      const box = layer.current?.getBoundingClientRect();
      const u = (event.clientX - (box?.left ?? 0) - rect.x) / rect.width;
      const v = 1 - (event.clientY - (box?.top ?? 0) - rect.y) / rect.height;
      return gridWarpInverse(grid, [u, v]);
    },
    [grid, layer, rect],
  );

  const onPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => setHover(locate(event)), [locate]);
  const onPointerLeave = useCallback(() => setHover(null), []);
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      const at = locate(event);
      if (at === null || full) return;
      lines.insert(nodeId, axis, axis === "column" ? at.gu / (grid.columns - 1) : at.gv / (grid.rows - 1));
    },
    [axis, full, grid, lines, locate, nodeId],
  );

  let preview: string | null = null;
  if (hover !== null && !full) {
    const along = axis === "column" ? grid.rows : grid.columns;
    const steps = (along - 1) * LINE_STEPS_PER_CELL;
    const points: string[] = [];
    for (let step = 0; step <= steps; step += 1) {
      const g = step / LINE_STEPS_PER_CELL;
      const [px, py] = axis === "column" ? gridWarpPoint(grid, hover.gu, g) : gridWarpPoint(grid, g, hover.gv);
      points.push(`${String(px * rect.width)},${String((1 - py) * rect.height)}`);
    }
    preview = points.join(" ");
  }

  const other = axis === "column" ? "hold Shift for a row" : "release Shift for a column";
  return (
    <div
      className={styles.gridSurface}
      data-testid={`preview-grid-surface-${nodeId}`}
      data-full={full ? "true" : undefined}
      title={full ? `A Grid Warp has at most ${String(GRID_WARP_MAX)} ${axis}s` : `Click to insert a ${axis} here (${other})`}
      style={{ left: `${String(rect.x)}px`, top: `${String(rect.y)}px`, width: `${String(rect.width)}px`, height: `${String(rect.height)}px` }}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
      onPointerDown={onPointerDown}
    >
      {preview === null ? null : (
        <svg className={styles.gridLine} data-testid={`preview-grid-line-${nodeId}`} aria-hidden="true">
          <polyline points={preview} />
        </svg>
      )}
    </div>
  );
}

/**
 * One handle. A press either opens a gesture or is REFUSED with its reason (§T935(b)).
 *
 * The refusal is not a disabled attribute: a disabled control shows no tooltip, which is
 * how §T896's picker lost the ability to say why, and the whole point of showing a driven
 * parameter's handle is that the user can find out what owns it. So the element stays
 * live, the press writes nothing, and the reason is on the accessible name and the title —
 * one string, `GIZMO_LOCKED_REASON`, read by both and by the test.
 */
function GizmoHandleControl({
  placement,
  store,
  layer,
  lines,
}: {
  placement: Placement;
  store: Vec3GizmoStore;
  layer: RefObject<HTMLDivElement | null>;
  lines: GridLineActions | undefined;
}) {
  const { nodeId, handle, camera, rect, x, y, zoom } = placement;
  const locked = handle.refusal !== null;
  /** Captured at pointerdown and not re-read: the drag's plane is the one it began on. */
  const drag = useRef<{
    pointerId: number;
    origin: { x: number; y: number };
    grabX: number;
    grabY: number;
    /** The handle as the press found it: its space, and the value the plane goes through. */
    start: GizmoHandle;
    camera: TileCamera | null;
    rect: PictureRect;
  } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      // Refused BEFORE the pointer is captured, so a locked handle leaves the press to
      // whatever is under it rather than swallowing it into a gesture that writes nothing.
      if (store.begin(nodeId, handle) !== null) return;
      const box = layer.current?.getBoundingClientRect();
      const origin = { x: box?.left ?? 0, y: box?.top ?? 0 };
      drag.current = {
        pointerId: event.pointerId,
        origin,
        // Press-anywhere-on-the-handle must not teleport the value to the pointer: the
        // offset between the press and the handle's own centre rides along.
        grabX: event.clientX - origin.x - x,
        grabY: event.clientY - origin.y - y,
        start: handle,
        camera,
        rect,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
    },
    [camera, handle, layer, nodeId, rect, store, x, y],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      const pointer = {
        x: event.clientX - active.origin.x - active.grabX,
        y: event.clientY - active.origin.y - active.grabY,
      };
      if (active.start.space === "picture") {
        // §T1491b — the placement inverted: the picture rect is the whole frame.
        const { rect: frame } = active;
        store.drag(nodeId, handle.key, [
          (pointer.x - frame.x) / frame.width,
          1 - (pointer.y - frame.y) / frame.height,
        ]);
        return;
      }
      if (active.camera === null) return;
      store.drag(nodeId, handle.key, pointerToPlane(active.camera, active.start.value, active.rect, pointer));
    },
    [handle.key, nodeId, store],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      store.end(nodeId, handle.key);
    },
    [handle.key, nodeId, store],
  );

  // §T1534b — a Grid Warp's point also names its column and row, for the delete menu.
  const place = placement.grid !== null && lines !== undefined ? parsePointKey(handle.key) : null;
  const button = (
    <button
      type="button"
      className={styles.gizmoHandle}
      data-testid={`preview-gizmo-${nodeId}-${handle.key}`}
      data-locked={locked ? "true" : undefined}
      aria-label={locked ? `${handle.label} handle — ${handle.refusal ?? ""}` : `${handle.label} handle`}
      title={
        locked
          ? (handle.refusal ?? "")
          : handle.space === "picture"
            ? place === null
              ? `Drag ${handle.label} on the picture`
              : `Drag ${handle.label} on the picture; right-click to delete its row or column, Option-click the picture to add one`
            : `Drag ${handle.label} across the view plane`
      }
      style={{ ...cssVars({ "--chrome-zoom": zoom }), left: `${String(x)}px`, top: `${String(y)}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
  if (place === null || placement.grid === null || lines === undefined) return button;
  const { columns, rows } = placement.grid;
  return (
    <ContextMenuRoot>
      <ContextMenuTrigger asChild>{button}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem danger disabled={columns <= GRID_WARP_MIN} onSelect={() => lines.remove(nodeId, "column", place.column)}>
          {`Delete column ${String(place.column + 1)}`}
          {columns <= GRID_WARP_MIN ? ` — ${String(GRID_WARP_MIN)} is the fewest` : ""}
        </ContextMenuItem>
        <ContextMenuItem danger disabled={rows <= GRID_WARP_MIN} onSelect={() => lines.remove(nodeId, "row", place.row)}>
          {`Delete row ${String(place.row + 1)}`}
          {rows <= GRID_WARP_MIN ? ` — ${String(GRID_WARP_MIN)} is the fewest` : ""}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenuRoot>
  );
}
