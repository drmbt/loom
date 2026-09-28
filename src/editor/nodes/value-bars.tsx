import { useLayoutEffect, useRef, useState } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import type { ValueChannelMeta } from "@domain/types/node-definition.ts";
import {
  barGeometry,
  barWindow,
  channelScale,
  formatValue,
  isChannelOn,
  observeChannels,
} from "./value-plot-mode.ts";
import type { ObservedRange } from "./value-plot-mode.ts";
import styles from "./value-plot.module.css";

/**
 * A value node's channels as BARS — what each one is right now, against a scale.
 *
 * The curve answers "where has this been", and for a great many value nodes that is the
 * wrong question asked expensively. A gate that flicks between 0 and 1 is a vertical
 * smear; a Lag settling at 0.98 of its range and one settling at 0.98 of a range four
 * times larger draw the identical picture, because the curve auto-fits (§V296's sticky
 * range is about stopping it BREATHING, not about making two nodes comparable).
 *
 * ## Every channel gets one, and that is the point
 *
 * The curve caps at `MAX_PLOTTED_CHANNELS` because four legible lines is what two
 * centimetres of node holds. A bar is a row, not a line, so the cap does not apply and
 * `audioIn`'s twenty-one channels each get their own scale instead of sharing one
 * window's extremes with twenty others. T1297 already established that the readout lists
 * them all and scrolls; this gives each row a picture.
 *
 * ## Declared, or observed and SAID to be observed
 *
 * `valueChannelMeta` is the honest scale where a node declares one. Where it does not,
 * the bar is drawn against the extremes seen since the plot opened and is marked — a
 * different track, and the range in the title — because "60% of -1..1" and "60% of
 * whatever this has done so far" are different claims and must not draw alike. An
 * observed channel that has produced one sample has no range at all yet, and shows its
 * number with no track rather than a half-filled one (§V91: a picture nobody computed is
 * not a neutral default).
 */

export interface ValueBarsProps {
  readonly nodeId: NodeId;
  /** Every published channel, in publication order — not the plotted prefix. */
  readonly channels: readonly string[];
  readonly latest: Readonly<Record<string, number>> | null;
  readonly meta?: Readonly<Record<string, ValueChannelMeta>> | undefined;
}

/**
 * Beyond this many rows the list scrolls in its own fixed box instead of growing.
 *
 * The same call T1297 made and for the same reason (§V90-§V92): a node whose height is a
 * function of its channel count shoves a dense network around, and `audioIn` would be a
 * tower. Four is what `--space-48` holds at `--fs-micro`, which is the height the curve
 * occupies — so a value node is the same size whichever picture it draws, and toggling
 * the mode does not move the node under the cursor that toggled it.
 */
export const BAR_ROWS_BEFORE_SCROLL = 4;

interface BarLayout {
  readonly scrollTop: number;
  readonly viewport: number;
  /** Row top to row top; 0 = not measured yet, and every row is mounted. */
  readonly stride: number;
  readonly gap: number;
}

const UNMEASURED: BarLayout = { scrollTop: 0, viewport: 0, stride: 0, gap: 0 };

export function ValueBars({ nodeId, channels, latest, meta }: ValueBarsProps) {
  /*
   * Running extremes, held across ticks. A ref rather than state on purpose: widening a
   * range is not a reason to render — the reading that widened it already is — and
   * setState here would be a render loop through the history subscription that caused it.
   */
  const observed = useRef<Map<string, ObservedRange>>(new Map());
  observeChannels(observed.current, latest);

  const scroll = channels.length > BAR_ROWS_BEFORE_SCROLL;
  const list = useRef<HTMLDListElement>(null);
  const [layout, setLayout] = useState<BarLayout>(UNMEASURED);

  /*
   * The row pitch, measured once the first rows exist. Two rows' offsetTop difference
   * rather than one row's height, because it includes the list's gap without parsing a
   * token; the gap itself is what is left of the pitch after the row. Re-measured only
   * while unknown, so this is not a per-tick layout read.
   */
  useLayoutEffect(() => {
    const element = list.current;
    if (!scroll || element === null || layout.stride > 0) return;
    const mounted = element.querySelectorAll<HTMLElement>("[data-bar-row]");
    const first = mounted[0];
    const second = mounted[1];
    if (first === undefined || second === undefined) return;
    const stride = second.offsetTop - first.offsetTop;
    if (stride > 0) {
      setLayout({
        scrollTop: element.scrollTop,
        viewport: element.clientHeight,
        stride,
        gap: Math.max(0, stride - first.offsetHeight),
      });
    }
  }, [scroll, layout.stride, channels]);

  const rows = scroll
    ? barWindow(channels.length, layout.scrollTop, layout.viewport, layout.stride)
    : { start: 0, end: channels.length };
  // Each spacer is followed or preceded by one flex gap of its own, so it stands for its
  // rows' pitch minus that gap: the list's scroll height is then exactly what it was with
  // every row mounted.
  const before = Math.max(0, rows.start * layout.stride - layout.gap);
  const after = Math.max(0, (channels.length - rows.end) * layout.stride - layout.gap);

  return (
    <dl
      ref={list}
      /* T1297's rule exactly: `nowheel` only when the list really scrolls, or every value
         node becomes a dead zone for canvas zoom to solve a problem the wide ones have. */
      className={scroll ? `${styles.bars} ${styles.barsScroll} nowheel` : styles.bars}
      aria-label={`Channels of ${nodeId}`}
      data-testid={`value-bars-${nodeId}`}
      onScroll={
        scroll
          ? (event) => {
              const element = event.currentTarget;
              const next = barWindow(channels.length, element.scrollTop, element.clientHeight, layout.stride);
              // Only a change of WHICH rows are mounted is worth a render; a scroll inside
              // one row's pitch is the browser's to paint.
              if (next.start !== rows.start || next.end !== rows.end) {
                setLayout({ ...layout, scrollTop: element.scrollTop, viewport: element.clientHeight });
              }
            }
          : undefined
      }
    >
      {/* Spacers keep the scroll height every row would have had, so the scrollbar and
          the scroll position mean the same thing they did with all rows mounted. */}
      {before > 0 ? <div aria-hidden="true" style={{ blockSize: `${before}px`, flexShrink: 0 }} /> : null}
      {channels.slice(rows.start, rows.end).map((channel) => (
        <ChannelBar
          key={channel}
          nodeId={nodeId}
          channel={channel}
          value={latest?.[channel] ?? null}
          // A named entry first, then the node's blanket declaration — see
          // `valueChannelMeta`: a Trigger declares `*` because it cannot know its names.
          meta={meta?.[channel] ?? meta?.["*"]}
          observed={observed.current.get(channel)}
        />
      ))}
      {after > 0 ? <div aria-hidden="true" style={{ blockSize: `${after}px`, flexShrink: 0 }} /> : null}
    </dl>
  );
}

function ChannelBar({
  nodeId,
  channel,
  value,
  meta,
  observed,
}: {
  readonly nodeId: NodeId;
  readonly channel: string;
  readonly value: number | null;
  readonly meta: ValueChannelMeta | undefined;
  readonly observed: ObservedRange | undefined;
}) {
  const scale = channelScale(meta, observed);
  return (
    <div
      className={styles.barRow}
      data-bar-row=""
      // §T1393b: right-click here opens the channel menu (copy reference / name / value).
      data-channel-name={channel}
      {...(value === null ? {} : { "data-channel-value": String(value) })}
      data-testid={`value-bar-${nodeId}-${channel}`}
    >
      <dt className={styles.channel}>{channel}</dt>
      {value === null || scale === null ? (
        // No reading, or nothing to draw it against. The number's own box still holds the
        // row's width steady so a channel arriving does not re-wrap the ones beside it.
        <div className={styles.barTrack} data-state="unscaled" />
      ) : scale.kind === "boolean" ? (
        <div
          className={styles.pill}
          data-state={isChannelOn(value) ? "on" : "off"}
          data-testid={`value-pill-${nodeId}-${channel}`}
          title={`${channel}: ${isChannelOn(value) ? "on" : "off"}`}
        />
      ) : (
        <Track
          nodeId={nodeId}
          channel={channel}
          value={value}
          low={scale.low}
          high={scale.high}
          declared={scale.declared}
        />
      )}
      <dd className={styles.number}>{value === null ? "—" : formatValue(value)}</dd>
    </div>
  );
}

function Track({
  nodeId,
  channel,
  value,
  low,
  high,
  declared,
}: {
  readonly nodeId: NodeId;
  readonly channel: string;
  readonly value: number;
  readonly low: number;
  readonly high: number;
  readonly declared: boolean;
}) {
  const geometry = barGeometry(value, low, high);
  if (geometry === null) {
    // A range of zero width — an observed channel that has only ever produced one value.
    return (
      <div
        className={styles.barTrack}
        data-state="unscaled"
        data-testid={`value-track-${nodeId}-${channel}`}
        title={`${channel}: no range observed yet`}
      />
    );
  }
  const bipolar = geometry.anchor > 0 && geometry.anchor < 1;
  return (
    <div
      className={styles.barTrack}
      data-state={declared ? "declared" : "observed"}
      data-clipped={geometry.clipped ? "true" : undefined}
      data-testid={`value-track-${nodeId}-${channel}`}
      title={`${channel}: ${formatValue(value)} of ${formatValue(low)}…${formatValue(high)}${
        declared ? "" : " (observed)"
      }`}
    >
      <div
        className={styles.barFill}
        style={{
          insetInlineStart: `${(geometry.start * 100).toFixed(2)}%`,
          inlineSize: `${((geometry.end - geometry.start) * 100).toFixed(2)}%`,
        }}
      />
      {bipolar ? (
        // Only where zero is INSIDE the track. On a 0..1 channel the mark would sit on
        // the left edge and read as part of the frame rather than as a value.
        <div className={styles.barZero} style={{ insetInlineStart: `${(geometry.anchor * 100).toFixed(2)}%` }} />
      ) : null}
    </div>
  );
}

