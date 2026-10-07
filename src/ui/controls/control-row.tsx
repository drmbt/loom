import { useContext, useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { cx } from "../cx.ts";
import { DRAG_THRESHOLD_PX, dragModifierFrom } from "./drag-math.ts";
import type { LabelDragHandlers } from "./label-drag.ts";
import { ParameterDragContext, carriesParameter, nodeIdOf, readParameterDrag, writeParameterDrag } from "./parameter-drag-context.ts";
import { ParameterSources } from "./parameter-sources.tsx";
import type { ParameterSourceView } from "./parameter-sources.tsx";
import styles from "./controls.module.css";

/**
 * Label / control / hint layout shared by every parameter row (T37, T38).
 *
 * `variant` is the compact-versus-complete axis doc §8.1 asks for: a node-embedded
 * control keeps only the label and the control, while the inspector adds the range
 * hint, the description and the compile-time badge. Same components, same behaviour,
 * different density — never a second implementation.
 */
export type ControlVariant = "inspector" | "node";

export interface ControlRowProps {
  label: string;
  /** Range/unit hint. Inspector only. */
  hint?: string | null;
  description?: string | undefined;
  /** §V5: marks a parameter whose change forces a targeted recompile. */
  compileTime?: boolean;
  /**
   * §V146 — the reason this parameter cannot affect the output right now, or null.
   *
   * The row DIMS; it does not disable. The reason joins the description on the label's
   * hover and focus, which is where every other explanation in this kit lives (§V90) —
   * no badge, no icon, no inline sentence under the control.
   */
  inactive?: string | null;
  /** The effective value comes from a driver, not the document (doc §8.2 seam). */
  driven?: boolean;
  /**
   * §V830 — the short name of the MODE deciding this parameter (`expr`, `bind`, `chan`,
   * `map`), or null when the stored constant decides it.
   *
   * A positive statement, and the row-level half of the same mark the field carries: a
   * driven parameter must be identifiable without expanding the mode panel to find out
   * which of the four things is moving it. It outranks `driven`'s generic `drv`, which
   * only ever meant "a driver, somewhere".
   */
  drivenBadge?: string | null;
  /**
   * T1336b — the nodes a binding on this row READS, named under the control.
   *
   * `drivenBadge` says a mode decides this value; this says WHICH NODE it reads, which is
   * the half the owner could not find. It rides under the field rather than in the label
   * line because the label column is `minmax(64px, 40%)` with `overflow: hidden` — a name
   * and a type badge put there would be ellipsised away at exactly the widths the panel is
   * usually docked at, which is a fix that is invisible where it is needed (§V1016).
   *
   * Empty or absent on every row whose bindings name nothing, which is nearly all of them.
   */
  sources?: readonly ParameterSourceView[];
  variant?: ControlVariant;
  /** Renders the label above the control — for multiline text and wide controls. */
  stacked?: boolean;
  /** Id of the control the label names, when it is a real form control. */
  controlId?: string | undefined;
  descriptionId?: string | undefined;
  /**
   * T204: clicking the parameter NAME expands the mode panel, TD's affordance. Passing
   * this turns the label text into a toggle button; omitting it leaves the plain
   * `<label htmlFor>` every other row has always had, so the node-embedded variant and
   * the Common section are untouched.
   */
  onToggleModes?: (() => void) | undefined;
  /**
   * T1026 — what dragging the NAME does, in the same hover text the description uses (§V90).
   *
   * Separate from `labelDrag` on purpose: the sentence is written even when the gesture is
   * NOT offered, because "this name cannot drag its channels, and here is which mode owns
   * each of them" is the honest refusal §V830 asks for, and an inert label that says
   * nothing is the failure it names.
   */
  labelHint?: string | null;
  /**
   * T1026 — the label as a drag surface for a compound (§V113, §V114).
   *
   * Present = the name adjusts every eligible channel at once; the click that toggles the
   * mode panel still works, because a press that never travels `DRAG_THRESHOLD_PX` is a
   * click exactly as it is in `NumberField`. Absent = the label is what it always was.
   */
  labelDrag?: LabelDragHandlers | undefined;
  /**
   * VN63 — the parameter this row edits. With a `ParameterDragContext` provider above, it
   * makes the name a reference-drag source and the row a drop target for one.
   */
  parameterKey?: string | undefined;
  expanded?: boolean;
  /** Rendered full width beneath the row when `expanded` — the mode panel. */
  expansion?: ReactNode;
  children: ReactNode;
}

/** `<label>` when the name names a control, a plain box when the name is a button. */
function LabelBox({
  as,
  htmlFor,
  className,
  children,
}: {
  as: "label" | "div";
  htmlFor?: string;
  className: string | undefined;
  children: ReactNode;
}) {
  if (as === "label") {
    return (
      <label className={className} {...(htmlFor === undefined ? {} : { htmlFor })}>
        {children}
      </label>
    );
  }
  return <div className={className}>{children}</div>;
}

/**
 * VN63 — how long a still press on the NAME waits before it becomes the value ladder, and
 * how far it may wobble meanwhile. TouchDesigner's split (Vincent, 2026-10-07): a name that
 * is dragged AT ONCE carries a reference (`parameter-drag-context.ts`); a name pressed and
 * HELD, then dragged, is the ladder. 300 ms is long enough that a deliberate grab-and-go
 * never arms it and short enough that holding to scrub does not feel like waiting; 3 px
 * lets a shaky hand still count as holding.
 */
export const LADDER_HOLD_MS = 300;
export const HOLD_TOLERANCE_PX = 3;

interface LabelDragState {
  pointerId: number;
  startX: number;
  startY: number;
  /** The hold elapsed: from here the press is the ladder (T1026) and owns the pointer. */
  armed: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  moved: boolean;
  lastDelta: number;
}

/**
 * VN63 reverses T1026's timing, citing TouchDesigner's docs (the ladder is a hold there, and
 * a drag of the name is the reference): the ladder now runs only after `LADDER_HOLD_MS` of a
 * still press. Until it arms, the pointer is NOT captured, so a press that moves at once is
 * free to become the browser's own drag and carry a reference; once armed, the label shows
 * it (`data-ladder-armed`, a resize cursor) and takes the pointer, and the rest is T1026's
 * gesture unchanged.
 *
 * The pointer/keyboard plumbing for a label drag (T1026). Deliberately shaped like
 * `NumberField`'s: absolute travel from the press (accumulating per-move deltas would make
 * the result depend on event granularity, so dragging out and back would not return to the
 * start), a `DRAG_THRESHOLD_PX` dead zone so a click stays a click, and pointer capture so
 * the gesture survives leaving the 60px-wide label.
 *
 * §V20: the press is the control's. Nothing above may read it as a pan, a node drag or a
 * selection — hence `stopPropagation` and the `nodrag` class the label already carries.
 */
function useLabelDragGesture(labelDrag: LabelDragHandlers | undefined) {
  const dragRef = useRef<LabelDragState | null>(null);
  /** Set by a drag that actually moved, so the click it is followed by does not toggle. */
  const suppressClickRef = useRef(false);
  /** True while an arrow key is held, so key-up knows there is an undo group to close. */
  const nudgingRef = useRef(false);
  // A hold still pending when the row goes away must not arm a ladder on a detached label.
  useEffect(() => () => {
    const timer = dragRef.current?.timer;
    if (timer !== undefined && timer !== null) clearTimeout(timer);
  }, []);

  const consumeClick = (): boolean => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  /** True while a hold has armed the ladder: a native drag that starts now is refused. */
  const isArmed = (): boolean => dragRef.current?.armed === true;

  if (labelDrag === undefined) return { props: {}, consumeClick, isArmed };

  const end = (event: ReactPointerEvent<HTMLElement>): void => {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (drag.timer !== null) clearTimeout(drag.timer);
    const target = event.currentTarget;
    target.removeAttribute("data-ladder-armed");
    if (
      typeof target.hasPointerCapture === "function" &&
      target.hasPointerCapture(event.pointerId) &&
      typeof target.releasePointerCapture === "function"
    ) {
      target.releasePointerCapture(event.pointerId);
    }
    if (!drag.moved) return;
    // One commit closes the gesture, and with it the undo group (§V15).
    suppressClickRef.current = true;
    labelDrag.onDrag(drag.lastDelta, dragModifierFrom(event), "commit");
  };

  const props = {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>): void => {
      event.stopPropagation();
      if (event.button !== 0) return;
      const target = event.currentTarget;
      const pointerId = event.pointerId;
      const drag: LabelDragState = { pointerId, startX: event.clientX, startY: event.clientY, armed: false, timer: null, moved: false, lastDelta: 0 };
      drag.timer = setTimeout(() => {
        if (dragRef.current !== drag) return;
        drag.timer = null;
        drag.armed = true;
        target.setAttribute("data-ladder-armed", "");
        if (typeof target.setPointerCapture === "function") target.setPointerCapture(pointerId);
      }, LADDER_HOLD_MS);
      dragRef.current = drag;
    },
    onPointerMove: (event: ReactPointerEvent<HTMLElement>): void => {
      const drag = dragRef.current;
      if (drag === null || drag.pointerId !== event.pointerId) return;
      event.stopPropagation();
      if (!drag.armed) {
        // Moving before the hold: not the ladder. The browser's drag (a reference) may take it.
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) > HOLD_TOLERANCE_PX) {
          if (drag.timer !== null) clearTimeout(drag.timer);
          dragRef.current = null;
        }
        return;
      }
      const deltaX = event.clientX - drag.startX;
      if (!drag.moved) {
        if (Math.abs(deltaX) < DRAG_THRESHOLD_PX) return;
        drag.moved = true;
        // The snapshot has to be taken before the first value is emitted, or the second
        // move would read a value the first one wrote and the drag would accelerate.
        labelDrag.onDrag(0, dragModifierFrom(event), "start");
      }
      drag.lastDelta = deltaX;
      labelDrag.onDrag(deltaX, dragModifierFrom(event), "live");
    },
    onPointerUp: end,
    onPointerCancel: end,
    onKeyDown: (event: KeyboardEvent<HTMLElement>): void => {
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      event.preventDefault();
      // Only the keys this handles are withheld; mod+z must still reach the graph keymap.
      event.stopPropagation();
      nudgingRef.current = true;
      labelDrag.onNudge(event.key === "ArrowUp" ? 1 : -1, dragModifierFrom(event), "live");
    },
    onKeyUp: (event: KeyboardEvent<HTMLElement>): void => {
      if (!nudgingRef.current) return;
      if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
      nudgingRef.current = false;
      labelDrag.onNudge(event.key === "ArrowUp" ? 1 : -1, dragModifierFrom(event), "commit");
    },
  };

  return { props, consumeClick, isArmed };
}

/**
 * VN63 — the NAME as the source of a reference drag, and the ROW as a drop target for one.
 * Both need the parameter's key (stamped on the row) and its node (the closest
 * `[data-node-id]`, which the inspector already sets), plus the service a provider gives;
 * without all three the name is not draggable and the row ignores drags.
 */
function useParameterDrag(parameterKey: string | undefined, isArmed: () => boolean) {
  const service = useContext(ParameterDragContext);
  const [dropping, setDropping] = useState(false);
  if (service === null || parameterKey === undefined) return { source: {}, target: {}, dropping: false };
  const source = {
    draggable: true,
    onDragStart: (event: DragEvent<HTMLElement>): void => {
      event.stopPropagation();
      const nodeId = nodeIdOf(event.currentTarget);
      const text = nodeId === null ? null : service.referenceText({ nodeId, key: parameterKey });
      // A hold that armed the ladder owns the press: no reference drag starts under it.
      if (isArmed() || nodeId === null || text === null) {
        event.preventDefault();
        return;
      }
      writeParameterDrag(event.dataTransfer, { nodeId, key: parameterKey }, text);
    },
  };
  const target = {
    "data-parameter-key": parameterKey,
    onDragOver: (event: DragEvent<HTMLElement>): void => {
      if (!carriesParameter(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "link";
      if (!dropping) setDropping(true);
    },
    onDragLeave: (): void => setDropping(false),
    onDrop: (event: DragEvent<HTMLElement>): void => {
      setDropping(false);
      const dragged = readParameterDrag(event.dataTransfer);
      const nodeId = nodeIdOf(event.currentTarget);
      if (dragged === null || nodeId === null) return;
      event.preventDefault();
      event.stopPropagation();
      // A parameter dropped on itself would read itself: ignored, not refused.
      if (dragged.nodeId === nodeId && dragged.key === parameterKey) return;
      service.dropOnParameter({ nodeId, key: parameterKey }, dragged);
    },
  };
  return { source, target, dropping };
}

export function ControlRow({
  label,
  hint,
  description,
  compileTime = false,
  inactive = null,
  driven = false,
  drivenBadge = null,
  sources,
  variant = "inspector",
  stacked = false,
  controlId,
  descriptionId,
  onToggleModes,
  labelHint = null,
  labelDrag,
  parameterKey,
  expanded = false,
  expansion,
  children,
}: ControlRowProps) {
  const { props: dragProps, consumeClick, isArmed } = useLabelDragGesture(labelDrag);
  const reference = useParameterDrag(parameterKey, isArmed);
  const compact = variant === "node";
  // Node-embedded controls stay bare: the inspector is where the full set lives.
  const hasDescription = !compact && description !== undefined && description !== "";
  // One string on the label carries both (§V90): a parameter that is inactive AND
  // documented must not sprout a second hover target.
  const help = [description, inactive, labelHint].filter(
    (part) => part !== undefined && part !== null && part !== "",
  );
  const hasHelp = !compact && help.length > 0;
  const describedProps = {
    ...(hasHelp ? { title: help.join(" — ") } : {}),
    ...(hasDescription && descriptionId !== undefined ? { id: descriptionId } : {}),
  };
  return (
    <div
      className={cx(
        styles.row,
        compact && styles.rowCompact,
        stacked && styles.rowStacked,
        expanded && styles.rowExpanded,
        inactive !== null && styles.rowInactive,
      )}
      data-inactive={inactive === null ? undefined : true}
      data-drop-target={reference.dropping ? "" : undefined}
      {...reference.target}
    >
      {/*
        A row that can disclose modes is NOT a `<label>`: the name is a button, and a
        `<label>` claims its descendant's accessible name, which left the disclosure
        anonymous to a screen reader (and to the tests standing in for one).
      */}
      <LabelBox
        as={onToggleModes === undefined ? "label" : "div"}
        className={styles.label}
        {...(controlId === undefined || onToggleModes !== undefined ? {} : { htmlFor: controlId })}
      >
        {/*
          The description lives on the LABEL — hover or focus it and you get the text.
          An earlier version put a `?` handle after the control, which wrapped onto its own
          line because the row is a two-column grid, and it added an indicator for
          something the label already implies. Fewer elements, same information.

          When the row can show modes the name becomes the disclosure (T204, TD parity).
          It is still the same text carrying the same description on hover and focus — the
          affordance is added to the label, not put beside it (§V90).
        */}
        {onToggleModes === undefined ? (
          <span
            className={cx(
              styles.labelText,
              hasHelp && styles.labelDescribed,
              labelDrag !== undefined && styles.labelDraggable,
              labelDrag !== undefined && "nodrag",
            )}
            {...describedProps}
            {...dragProps}
            {...reference.source}
          >
            {label}
          </span>
        ) : (
          <button
            type="button"
            className={cx(
              styles.labelText,
              styles.labelToggle,
              hasHelp && styles.labelDescribed,
              labelDrag !== undefined && styles.labelDraggable,
              "nodrag",
            )}
            aria-expanded={expanded}
            {...describedProps}
            onPointerDown={(event) => event.stopPropagation()}
            {...dragProps}
            {...reference.source}
            onClick={() => {
              // A drag that moved is not a click, so it must not also toggle the panel.
              if (consumeClick()) return;
              onToggleModes();
            }}
          >
            {label}
          </button>
        )}
        {!compact && compileTime ? (
          <span className={styles.compileBadge} title="Changing this recompiles the node">
            rc
          </span>
        ) : null}
        {drivenBadge !== null ? (
          <span
            className={styles.drivenBadge}
            title={`${drivenBadge} — this value is decided by its mode, not by editing the field. It updates with the render.`}
          >
            {drivenBadge}
          </span>
        ) : driven ? (
          <span className={styles.drivenBadge} title="Driven — the shown value comes from a driver">
            drv
          </span>
        ) : null}
        {!compact && hint ? <span className={styles.hint}>{hint}</span> : null}
      </LabelBox>
      <div className={styles.control}>
        {children}
        {/*
          T1336b — under the field, in the control's own column, so the mark lines up with
          the value it explains and wraps instead of truncating. The node variant never
          gets the prop: an embedded row is the compact one (doc §8.1).
        */}
        {compact || sources === undefined ? null : (
          <ParameterSources label={label} sources={sources} />
        )}
      </div>
      {expanded && expansion !== undefined ? (
        <div className={styles.expansion}>{expansion}</div>
      ) : null}
    </div>
  );
}
