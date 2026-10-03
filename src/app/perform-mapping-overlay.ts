import type { NodeId } from "@domain/types/ids.ts";
import { GRID_WARP_MIN, gridWarpInverse, gridWarpPoint, parsePointKey } from "@nodes/definitions/grid-warp.ts";
import type { GridAxis, WarpGrid } from "@nodes/definitions/grid-warp.ts";
import { GRID_WARP_MAX } from "@nodes/shaders/grid-warp.wgsl.ts";
import type { GridLineActions, PictureGizmoHandle, Vec3GizmoStore } from "@editor/viewer/index.ts";
import { windowPicture } from "./perform-mapping.ts";
import type { PictureLens, Point, WindowPicture, WindowPictureFacts } from "./perform-mapping.ts";

/**
 * §T1536b — THE MAPPING HANDLES, DRAWN ON THE PERFORM WINDOW.
 *
 * Plain DOM in the perform window's own document, like `perform-window.ts` (no React: the
 * window is a document the editor's React tree does not own, and a portal across documents
 * would carry the editor's Radix menus and stylesheets with it). It sits OVER the canvas —
 * a fixed layer, `pointer-events: none` but on its controls — and never draws into the
 * presented texture: the Window Out's target, which an export or a screenshot reads, is the
 * same bytes with the mode on or off.
 *
 * What it draws and how a drag writes are the tile's (§T1491b, T935, §T1534b), not a copy of
 * them: the handles are `pictureHandlesFor`'s (via `gizmoTilesFor`, so what is offered and
 * what is refused is decided in one place), every drag goes through the same
 * `Vec3GizmoStore` — begin / live / commit, one undo group, the parameter editor's actor —
 * and a Grid Warp's line insert/delete is the same `GridLineActions` the tile calls. The
 * only thing that differs is the coordinate frame: `windowPicture` (any Corner Pins crossed,
 * §T1538b, then the Window Out's Fit, then the canvas's letterbox) where the tile has its
 * fitted rect. Every outline is mapped point by point through it: a Grid Warp's lines are
 * sampled first, then each sample is mapped, so a Corner Pin downstream bends them exactly as
 * it bends the picture; a sample with no place (past a Corner Pin's horizon) breaks the line.
 * Pointer events in this document are already in window CSS pixels (the body has no margin),
 * so nothing is measured.
 *
 * The gestures are the tile's: drag a point; Option/Alt-click the picture inserts a column
 * through the place (Alt+Shift a row), with the line drawn under the pointer while Alt is
 * held; right-click a Grid Warp point for "Delete column N" / "Delete row N".
 */

export interface MappingOverlayEdit {
  readonly nodeId: NodeId;
  readonly handles: readonly PictureGizmoHandle[];
  /** A Grid Warp's effective grid; undefined for a Corner Pin (its outline is the pin quad). */
  readonly grid: WarpGrid | undefined;
  readonly picture: WindowPictureFacts;
  /** §T1538b: the Corner Pins between the node and the window, in picture order. */
  readonly lens: PictureLens;
}

export interface MappingOverlayView {
  /** What the window says above the picture: the target, or why nothing is drawn. */
  readonly note: string;
  /** Present only when the handles land exactly; absent, the note is a refusal. */
  readonly edit?: MappingOverlayEdit | undefined;
}

export interface MappingOverlayDeps {
  /** The perform window. */
  readonly window: Window;
  readonly store: Vec3GizmoStore;
  readonly lines: GridLineActions;
  /** Token values from the editor's stylesheet, set on the layer as custom properties. */
  readonly tokens: Readonly<Record<string, string>>;
}

export interface MappingOverlay {
  readonly element: HTMLElement;
  update(view: MappingOverlayView): void;
  dispose(): void;
}

/** The editor tokens the layer is drawn with — read from the editor, never spelled here. */
export const MAPPING_OVERLAY_TOKENS = ["--signal", "--bg-sunken", "--bg-panel", "--line", "--text", "--text-dim", "--font-ui", "--fs-ui"] as const;

/** Points along a grid line: every sub-quad vertex the shader draws, 16 per cell (§T1534b). */
const STEPS_PER_CELL = 16;
const SVG = "http://www.w3.org/2000/svg";
const HANDLE_SIZE = 18;

interface DragState {
  readonly pointerId: number;
  readonly key: string;
  readonly grabX: number;
  readonly grabY: number;
  readonly picture: WindowPicture;
}

export function createMappingOverlay({ window: child, store, lines, tokens }: MappingOverlayDeps): MappingOverlay {
  const doc = child.document;
  const root = doc.createElement("div");
  root.dataset["performMapping"] = "on";
  root.dataset["testid"] = "perform-mapping";
  for (const [name, value] of Object.entries(tokens)) if (value !== "") root.style.setProperty(name, value);
  Object.assign(root.style, { position: "fixed", inset: "0", pointerEvents: "none", overflow: "hidden", fontFamily: "var(--font-ui)", fontSize: "var(--fs-ui)" });

  const svg = doc.createElementNS(SVG, "svg");
  svg.setAttribute("aria-hidden", "true");
  Object.assign((svg as SVGSVGElement).style, { position: "absolute", inset: "0", width: "100%", height: "100%", overflow: "visible", pointerEvents: "none" });
  const outline = doc.createElementNS(SVG, "g");
  outline.setAttribute("data-testid", "perform-mapping-outline");
  outline.setAttribute("fill", "none");
  outline.setAttribute("stroke", "var(--signal)");
  outline.setAttribute("stroke-width", "1.5");
  const insertLine = doc.createElementNS(SVG, "polyline");
  insertLine.setAttribute("data-testid", "perform-mapping-insert-line");
  insertLine.setAttribute("fill", "none");
  insertLine.setAttribute("stroke", "var(--text)");
  insertLine.setAttribute("stroke-dasharray", "6 4");
  svg.append(outline, insertLine);

  // §T1534b: the picture while Alt is held — a press inserts the line through it.
  const surface = doc.createElement("div");
  surface.dataset["testid"] = "perform-mapping-surface";
  Object.assign(surface.style, { position: "absolute", inset: "0", cursor: "crosshair", pointerEvents: "none" });

  const note = doc.createElement("div");
  note.setAttribute("role", "status");
  note.dataset["testid"] = "perform-mapping-note";
  Object.assign(note.style, {
    position: "absolute",
    left: "12px",
    top: "12px",
    maxWidth: "min(60ch, calc(100% - 24px))",
    padding: "6px 10px",
    background: "var(--bg-panel)",
    color: "var(--text)",
    border: "1px solid var(--line)",
    borderRadius: "4px",
    pointerEvents: "none",
  });

  const handleLayer = doc.createElement("div");
  const menu = doc.createElement("div");
  menu.setAttribute("role", "menu");
  menu.dataset["testid"] = "perform-mapping-menu";
  Object.assign(menu.style, {
    position: "absolute",
    display: "none",
    flexDirection: "column",
    background: "var(--bg-panel)",
    border: "1px solid var(--line)",
    borderRadius: "4px",
    padding: "4px",
    pointerEvents: "auto",
  });
  root.append(svg, surface, handleLayer, note, menu);
  doc.body.appendChild(root);

  let view: MappingOverlayView = { note: "" };
  let alt = false;
  let shift = false;
  let hover: { gu: number; gv: number } | null = null;
  let drag: DragState | null = null;
  const buttons = new Map<string, HTMLButtonElement>();

  const size = (): readonly [number, number] => [child.innerWidth, child.innerHeight];
  const pictureOf = (edit: MappingOverlayEdit): WindowPicture => windowPicture(edit.picture, size(), edit.lens);
  const at = (picture: WindowPicture, point: Point): string | null => {
    const shown = picture.toWindow(point);
    return shown === null ? null : `${String(shown[0])},${String(shown[1])}`;
  };
  /** A sampled line as polylines, broken where a sample has no place on the window. */
  const runs = (samples: ReadonlyArray<string | null>): string[][] => {
    const out: string[][] = [[]];
    for (const sample of samples) {
      if (sample !== null) (out[out.length - 1] as string[]).push(sample);
      else if ((out[out.length - 1] as string[]).length > 0) out.push([]);
    }
    return out.filter((run) => run.length > 0);
  };

  const closeMenu = (): void => {
    menu.style.display = "none";
    menu.replaceChildren();
  };

  const openMenu = (edit: MappingOverlayEdit, grid: WarpGrid, key: string, x: number, y: number): void => {
    const place = parsePointKey(key);
    if (place === null) return;
    menu.replaceChildren();
    const item = (axis: GridAxis, index: number, count: number): HTMLButtonElement => {
      const button = doc.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.dataset["testid"] = `perform-mapping-delete-${axis}`;
      const fewest = count <= GRID_WARP_MIN;
      button.textContent = `Delete ${axis} ${String(index + 1)}${fewest ? ` — ${String(GRID_WARP_MIN)} is the fewest` : ""}`;
      button.disabled = fewest;
      Object.assign(button.style, { background: "transparent", color: "var(--text)", border: "0", padding: "4px 8px", textAlign: "left", cursor: "pointer", font: "inherit" });
      button.addEventListener("click", () => {
        closeMenu();
        lines.remove(edit.nodeId, axis, index);
      });
      return button;
    };
    menu.append(item("column", place.column, grid.columns), item("row", place.row, grid.rows));
    Object.assign(menu.style, { display: "flex", left: `${String(x)}px`, top: `${String(y)}px` });
  };

  const placeHandles = (edit: MappingOverlayEdit | undefined): void => {
    const keep = new Set<string>();
    if (edit !== undefined) {
      const picture = pictureOf(edit);
      for (const handle of edit.handles) {
        keep.add(handle.key);
        let button = buttons.get(handle.key);
        if (button === undefined) {
          button = createHandle(handle.key);
          buttons.set(handle.key, button);
          handleLayer.appendChild(button);
        }
        // No place (past a Corner Pin's horizon): the view refuses that before it gets here.
        const [x, y] = picture.toWindow(handle.value) ?? [Number.NaN, Number.NaN];
        const locked = handle.refusal !== null;
        button.style.display = Number.isNaN(x) ? "none" : "";
        button.style.left = `${String(x)}px`;
        button.style.top = `${String(y)}px`;
        button.style.borderStyle = locked ? "dashed" : "solid";
        button.style.borderColor = locked ? "var(--text-dim)" : "var(--signal)";
        button.style.cursor = locked ? "not-allowed" : "grab";
        if (locked) button.dataset["locked"] = "true";
        else delete button.dataset["locked"];
        const label = locked ? `${handle.label} handle — ${handle.refusal ?? ""}` : `${handle.label} handle`;
        button.setAttribute("aria-label", label);
        button.title = locked
          ? (handle.refusal ?? "")
          : edit.grid === undefined
            ? `Drag ${handle.label}`
            : `Drag ${handle.label}; right-click to delete its row or column, Option-click the picture to add one`;
      }
    }
    for (const [key, button] of buttons) {
      if (keep.has(key) || drag?.key === key) continue;
      button.remove();
      buttons.delete(key);
    }
  };

  /** The live handle: its gesture is the tile's `GizmoHandleControl`, in window pixels. */
  function createHandle(key: string): HTMLButtonElement {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset["testid"] = `perform-mapping-handle-${key}`;
    Object.assign(button.style, {
      position: "absolute",
      width: `${String(HANDLE_SIZE)}px`,
      height: `${String(HANDLE_SIZE)}px`,
      padding: "0",
      borderWidth: "2px",
      borderRadius: "50%",
      background: "color-mix(in srgb, var(--bg-sunken) 40%, transparent)",
      boxShadow: "0 0 0 1px color-mix(in srgb, var(--bg-sunken) 70%, transparent)",
      transform: "translate(-50%, -50%)",
      pointerEvents: "auto",
      touchAction: "none",
    });
    const current = (): PictureGizmoHandle | undefined => view.edit?.handles.find((handle) => handle.key === key);
    button.addEventListener("pointerdown", (event) => {
      const edit = view.edit;
      const handle = current();
      if (event.button !== 0 || edit === undefined || handle === undefined) return;
      closeMenu();
      const picture = pictureOf(edit);
      const shown = picture.toWindow(handle.value);
      // Refused before the pointer is captured: a locked handle writes nothing (§T935(b)).
      if (shown === null || store.begin(edit.nodeId, handle) !== null) return;
      const [x, y] = shown;
      drag = { pointerId: event.pointerId, key, grabX: event.clientX - x, grabY: event.clientY - y, picture };
      button.setPointerCapture?.(event.pointerId);
      event.preventDefault();
      event.stopPropagation();
    });
    button.addEventListener("pointermove", (event) => {
      const edit = view.edit;
      if (drag === null || drag.pointerId !== event.pointerId || drag.key !== key || edit === undefined) return;
      const picture = drag.picture.fromWindow([event.clientX - drag.grabX, event.clientY - drag.grabY]);
      // Past a Corner Pin's horizon there is no surface to put the point on: the move is skipped.
      if (picture !== null) store.drag(edit.nodeId, key, [picture[0], picture[1]]);
    });
    const release = (event: PointerEvent): void => {
      const edit = view.edit;
      if (drag === null || drag.pointerId !== event.pointerId || drag.key !== key) return;
      drag = null;
      if (edit !== undefined) store.end(edit.nodeId, key);
      placeHandles(view.edit);
    };
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("contextmenu", (event) => {
      const edit = view.edit;
      event.preventDefault();
      if (edit?.grid === undefined) return;
      openMenu(edit, edit.grid, key, event.clientX, event.clientY);
    });
    return button;
  }

  const drawOutline = (edit: MappingOverlayEdit | undefined): void => {
    outline.replaceChildren();
    if (edit === undefined) return;
    const picture = pictureOf(edit);
    if (edit.grid === undefined) {
      // A Corner Pin: the pinned picture's edge is the pin quad, and a homography downstream
      // (§T1538b) keeps its edges straight — so the mapped corners are the exact outline.
      const corners = edit.handles.map((handle) => at(picture, handle.value));
      if (corners.some((corner) => corner === null)) return;
      const quad = doc.createElementNS(SVG, "polygon");
      quad.setAttribute("points", corners.join(" "));
      outline.appendChild(quad);
      return;
    }
    const { grid } = edit;
    const line = (axis: GridAxis, index: number): void => {
      const along = axis === "column" ? grid.rows : grid.columns;
      const steps = (along - 1) * STEPS_PER_CELL;
      const points: Array<string | null> = [];
      for (let step = 0; step <= steps; step += 1) {
        const g = step / STEPS_PER_CELL;
        points.push(at(picture, axis === "column" ? gridWarpPoint(grid, index, g) : gridWarpPoint(grid, g, index)));
      }
      for (const run of runs(points)) {
        const polyline = doc.createElementNS(SVG, "polyline");
        polyline.setAttribute("points", run.join(" "));
        outline.appendChild(polyline);
      }
    };
    for (let column = 0; column < grid.columns; column += 1) line("column", column);
    for (let row = 0; row < grid.rows; row += 1) line("row", row);
  };

  /** §T1534b: the line Alt+click would insert, drawn along the warped surface. */
  const drawInsertLine = (): void => {
    const edit = view.edit;
    const grid = edit?.grid;
    const axis: GridAxis = shift ? "row" : "column";
    const full = grid !== undefined && (axis === "column" ? grid.columns : grid.rows) >= GRID_WARP_MAX;
    const live = alt && edit !== undefined && grid !== undefined;
    surface.style.pointerEvents = live ? "auto" : "none";
    surface.style.cursor = full ? "not-allowed" : "crosshair";
    surface.title = !live ? "" : full ? `A Grid Warp has at most ${String(GRID_WARP_MAX)} ${axis}s` : `Click to insert a ${axis} here`;
    if (!live || full || hover === null || edit === undefined || grid === undefined) {
      insertLine.setAttribute("points", "");
      return;
    }
    const picture = pictureOf(edit);
    const along = axis === "column" ? grid.rows : grid.columns;
    const points: Array<string | null> = [];
    for (let step = 0; step <= (along - 1) * STEPS_PER_CELL; step += 1) {
      const g = step / STEPS_PER_CELL;
      points.push(at(picture, axis === "column" ? gridWarpPoint(grid, hover.gu, g) : gridWarpPoint(grid, g, hover.gv)));
    }
    // One polyline: a hint under the pointer, so only the run with a place is drawn.
    insertLine.setAttribute("points", (runs(points)[0] ?? []).join(" "));
  };

  const locate = (event: PointerEvent): { gu: number; gv: number } | null => {
    const edit = view.edit;
    if (edit?.grid === undefined) return null;
    const picture = pictureOf(edit).fromWindow([event.clientX, event.clientY]);
    return picture === null ? null : gridWarpInverse(edit.grid, picture);
  };
  surface.addEventListener("pointermove", (event) => {
    hover = locate(event);
    drawInsertLine();
  });
  surface.addEventListener("pointerleave", () => {
    hover = null;
    drawInsertLine();
  });
  surface.addEventListener("pointerdown", (event) => {
    const edit = view.edit;
    const grid = edit?.grid;
    if (event.button !== 0 || edit === undefined || grid === undefined) return;
    event.preventDefault();
    event.stopPropagation();
    const axis: GridAxis = event.shiftKey ? "row" : "column";
    const place = locate(event);
    if (place === null || (axis === "column" ? grid.columns : grid.rows) >= GRID_WARP_MAX) return;
    lines.insert(edit.nodeId, axis, axis === "column" ? place.gu / (grid.columns - 1) : place.gv / (grid.rows - 1));
  });

  const render = (): void => {
    note.textContent = view.note;
    note.style.display = view.note === "" ? "none" : "block";
    drawOutline(view.edit);
    placeHandles(view.edit);
    drawInsertLine();
  };

  const onModifiers = (event: KeyboardEvent | PointerEvent): void => {
    if (event.altKey === alt && event.shiftKey === shift) return;
    alt = event.altKey;
    shift = event.shiftKey;
    drawInsertLine();
  };
  const onBlur = (): void => {
    alt = false;
    shift = false;
    hover = null;
    drawInsertLine();
  };
  const onPress = (event: PointerEvent): void => {
    if (menu.contains(event.target as Node | null)) return;
    closeMenu();
  };
  child.addEventListener("keydown", onModifiers);
  child.addEventListener("keyup", onModifiers);
  child.addEventListener("pointermove", onModifiers);
  child.addEventListener("blur", onBlur);
  child.addEventListener("resize", render);
  doc.addEventListener("pointerdown", onPress, true);

  return {
    element: root,
    update(next) {
      view = next;
      render();
    },
    dispose() {
      child.removeEventListener("keydown", onModifiers);
      child.removeEventListener("keyup", onModifiers);
      child.removeEventListener("pointermove", onModifiers);
      child.removeEventListener("blur", onBlur);
      child.removeEventListener("resize", render);
      doc.removeEventListener("pointerdown", onPress, true);
      // A gesture cut short by leaving the mode still closes its undo group.
      if (drag !== null && view.edit !== undefined) store.end(view.edit.nodeId, drag.key);
      drag = null;
      root.remove();
    },
  };
}
