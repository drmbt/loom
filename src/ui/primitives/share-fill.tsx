import type { ComponentProps } from "react";
import { cx } from "../cx.ts";
import styles from "./share-fill.module.css";

/**
 * T1653b — A SHARE OF A FIXED BOX: the one way a value is drawn as "this much of a track".
 *
 * A slider's fill, a value bar, a number field's fill and a preset's fade bar are the same
 * thing, and each used to be a box whose WIDTH (or start and width) was the value.
 *
 * ## What that cost, measured in Chromium's own trace
 *
 * A box that changes is a changed paint chunk, and a changed chunk forces the FULL
 * compositor update (`PaintArtifactCompositor::Update`: a walk of every layer and chunk of
 * the page) where an unchanged one takes the repaint path. On a 200-node document that is
 * 4.5 ms against 1.4 ms for every value a slider is dragged through, 11 ms on a 200-node
 * project, and the same 11 ms on 17 to 47% of that project's IDLE frames from its value
 * bars alone. Probed one variable at a time, the full update is forced by:
 *
 *  - ANY change of the box's geometry: its width, `transform: scaleX`, `clip-path`,
 *    positioned or static, painted or with no background at all;
 *  - a change of the rect Chromium knows to be OPAQUE, even on a box that does not move
 *    (a square opaque background clipped by padding still forced it; so did
 *    `background-size` on an opaque image).
 *
 * ## The rule
 *
 * The box is its track's size, always. The share is written as PADDING, and the
 * background is clipped to the content box (`share-fill.module.css`): the drawn part ends
 * where the old box's edge was, at the same snapped pixel, in the same solid colour. The
 * box carries a radius too small to move a pixel, so it is never a plainly opaque square.
 *
 * NOT byte-identical to the box it replaces, and nothing here claims so. Compared with
 * the build before on a 1600×1000 page, same-build-twice differing by 0 pixels: the AREA
 * of a fill is identical; its EDGE pixels differ — 1 to 2 pixels at 100% zoom (at most
 * 10/255 a channel), 10 to 84 pixels along the edges of three fills at 35% and 15% zoom
 * (at most 27/255), up to 275 pixels (at most 45/255) when a fill is full. A gradient or a
 * mask in place of the colour dithers or resamples the whole area, which is why neither
 * is used. A value bar's ends inside its track are square where they were round (2 px on
 * a 4 px bar): no way was found to keep them round without a geometry change.
 *
 * ## The gates, against the cause
 *
 * `src/tests/e2e/canvas-paint.spec.ts` counts the full compositor updates of a run of
 * writes to each control in a real browser's trace, and fails naming the control when
 * Chromium's rule moves. `src/tests/guardrails/share-geometry.test.ts` fails when a
 * component under `src/ui` or `src/editor` drives a share by a percentage width, a scale
 * or a clip path outside this file.
 */
export interface ShareFillProps extends Omit<ComponentProps<"span">, "children"> {
  /** Where the drawn part begins, 0..1 of the box. Default 0. */
  readonly start?: number;
  /** Where the drawn part ends, 0..1 of the box. */
  readonly end: number;
  /**
   * The least the drawn part may be, as a CSS length (`"2px"`): a fill that carries a
   * mark at its end keeps room for the mark when the value is at the bottom of its range.
   */
  readonly minimum?: string;
}

const percent = (share: number): string => `${String(Math.min(1, Math.max(0, share)) * 100)}%`;

export function ShareFill({ start = 0, end, minimum, className, style, ...rest }: ShareFillProps) {
  const undrawn = percent(1 - end);
  return (
    <span
      aria-hidden="true"
      {...rest}
      className={cx(styles.share, className)}
      style={{
        ...style,
        paddingInlineStart: percent(start),
        paddingInlineEnd: minimum === undefined ? undrawn : `min(${undrawn}, calc(100% - ${minimum}))`,
      }}
    />
  );
}
