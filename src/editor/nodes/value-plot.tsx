import { useCallback, useMemo, useRef } from "react";
import type { ReactNode, RefObject } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { useStoreSelector } from "@ui/hooks/use-store-selector.ts";
import { useVisibleSubscribe } from "@ui/hooks/use-visible-subscribe.ts";
import { stickyRange } from "./plot-range.ts";
import type { PlotRange } from "./plot-range.ts";
import type { ValueHistory, ValueHistorySource } from "./value-history.ts";
import { FUNCTION_PLOT_SAMPLES, sampleValueFunction } from "./value-function.ts";
import { sampleValueChainPlot } from "./value-plot-chain.ts";
import { formatValue, legibleScaleOf, resolveValuePlotMode } from "./value-plot-mode.ts";
import { ValueBars } from "./value-bars.tsx";
import type { ValuePlotMode } from "@domain/types/graph.ts";
import type { ValuePlotChain } from "./value-plot-chain.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { ValueFunctionPlot } from "./value-function.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import styles from "./value-plot.module.css";

/**
 * A value node's channel, drawn in its body (T344, §V275).
 *
 * TD draws a CHOP's channel in the node, and that is why a TD network reads at a glance:
 * you see the SIGNAL, not just the wire. Ours rendered an empty box, so the half of the
 * graph that MOVES was the half nobody could see — an LFO, a Lag, a Mouse and an Analyze
 * looked identical and all looked inert.
 *
 * This is CONTENT, not chrome. §V90-§V92 push decoration out of a dense pane, and a plot
 * of what the node produces is the same kind of thing a texture preview is: the node's
 * output, in the node. A ROW of buttons here would still not earn its place — and there
 * is not one. There is ONE button, it appears on hover and focus, and what it switches
 * between are two renderings of the same content rather than two pieces of chrome. The
 * original claim was about a toolbar; it survives.
 *
 * ## Every channel, overlaid — the decision, stated
 *
 * Mouse publishes x, y and buttons. This plots ALL of them on one shared scale rather
 * than picking the first, because "x is moving and y is not" is exactly the thing you
 * open a plot to see, and choosing one channel hides it. That is also what TD does. The
 * count is capped (`MAX_PLOTTED_CHANNELS`) so a wide bag cannot turn two centimetres of
 * node into a smear.
 *
 * ## The READOUT is not capped — and why it scrolls (T1297)
 *
 * `audioIn` publishes twenty-one channels. The cap used to be applied to the BAG rather
 * than to the curves, and one layer down (`app/value-history.ts`) it was applied before
 * the ring was written at all — so `latest` held four names and the other seventeen,
 * every `*Count`, `centroid` and the whole tempo claim, could not be reached from the UI
 * by any route. Four curves, twenty-one readings: the curves are the thing two
 * centimetres cannot carry, and a `<dt>/<dd>` pair is not.
 *
 * Twenty-one readings do not fit either, and the choice of what to do about that is
 * between three: grow the node, show the rest somewhere else, or scroll in place. This
 * SCROLLS IN PLACE, at a fixed height. Growing the node makes its size a function of its
 * bag — an `audioIn` becomes a ~300px tower that shoves its neighbours around a dense
 * network (§V90-§V92) — and "only when selected" makes the node's height JUMP on a click,
 * which moves the layout under the cursor that caused it. A fixed window keeps every node
 * the same size whatever it publishes, and keeps every channel reachable where the user is
 * already looking, which is the whole of the complaint. The numbers sit in a reserved box
 * for the reason `timeline-readout.module.css`'s `.value` states: a field that grows a
 * character when a value crosses a power of ten slides everything to its right, and in a
 * wrapping list it also re-wraps the rows.
 *
 * ## Scale
 *
 * Auto-ranged over the visible window, not pinned to 0..1: Slope and Math produce
 * arbitrary numbers and a fixed range would flatten them into the axis. A constant signal
 * has no range at all, so it is drawn as a centred flat line rather than amplified noise.
 *
 * The range is STICKY (T352, §V296, `plot-range.ts`). Auto-ranging per frame made a stable
 * sine BREATHE: the sliding window's min and max wobble in the last decimal, the scale
 * followed, and the wave expanded and contracted while the signal did not. The range now
 * holds exactly still until the signal leaves it.
 *
 * ## The FUNCTION, where there is one (T459)
 *
 * A pure `valueChannel` node is a function of the frame, so the plot evaluates it across
 * one whole cycle and draws the real waveform instead of the sampled tail. That fixes two
 * complaints at once: a fast LFO no longer ALIASES into a polygon (the resolution stops
 * depending on the frame rate), and the shape is legible at a glance because a whole
 * cycle is on screen rather than whatever the last two seconds happened to contain.
 *
 * A playhead marks the current phase. It is what keeps this a live instrument rather than
 * a diagram, and it is the only part that moves — the curve deliberately holds still.
 *
 * Stateful nodes keep the history plot, and for them that is the truthful picture: a Lag's
 * output is a function of everything that came before, so where it has been IS what it is.
 *
 * ## No history is not zero
 *
 * A node that has not been sampled yet renders the empty state, never a flat line at
 * zero — a line at zero is a claim that the node produced zero, which is a different and
 * wrong statement about a node that has produced nothing.
 *
 * ## What a tick costs (T1239)
 *
 * The history ring notifies at 10 Hz. A plot in a hidden graph pane — a tab behind the
 * viewer, a window on another screen — used to re-render on every one of those ticks for
 * nobody; the subscription is now gated on the plot's own visibility, and a plot that
 * comes back re-reads the ring at once (§V86). Since T1691b "visible" is also: on screen,
 * not under a fullscreen Viewer, and large enough to read (a canvas fitted to 220 nodes
 * draws a bar 0.2 px tall, and its ten writes a second cost a raster of the whole canvas).
 * A VISIBLE plot still re-renders per tick,
 * because its picture moved; what it no longer does per tick is re-evaluate the function
 * plot's whole cycle (that is a property of the node's parameters, sampled once per
 * parameter change; only the phase follows the clock) or format the x coordinates of a
 * history window (they depend on the window's length, not its contents).
 */

export interface ValuePlotProps {
  readonly nodeId: NodeId;
  readonly history: ValueHistorySource;
  /**
   * What this node IS, so the plot can draw its curve rather than its tail (T459).
   *
   * The sampling happens HERE rather than in the caller because the playhead has to
   * advance: the phase comes from the newest sample's frame time, which arrives on this
   * component's own history subscription. A caller computing the curve once per graph
   * render would draw a playhead frozen wherever it happened to be.
   *
   * Absent, or not a pure periodic source, and the plot falls back to history.
   */
  readonly source?: ValuePlotSource | null;
  /**
   * This node is OFF (T576) — why, or null when it is running.
   *
   * §V504: a muted node is NOT COOKED. The value graph skips it before inputs,
   * parameters, state or diagnostics (T541), so it publishes no bag and nothing here has
   * anything to draw. The FUNCTION plot did not notice, because T459 evaluates a pure
   * source's curve independently of the value graph — the curve is a property of the
   * node, and a property survives being switched off. So a muted LFO kept drawing a live
   * waveform with a moving playhead, in the node body, which is the one place in this app
   * that means LIVE OUTPUT (§V91: a display that keeps reading when its source is off is
   * a display that lies). A stateful node's history plot had the matching defect from the
   * other side: the ring stops being pushed and the last window just freezes there.
   *
   * One question — "what does a value node show while it is off" — and now one answer for
   * both halves (§V109). The curve as a DIAGRAM of the node is still a good idea; the node
   * body, beside a running graph, is not where it belongs.
   */
  readonly silence?: ValueSilence | null;
  /**
   * The mode this node is STORED as, or undefined to follow the default for its kind.
   *
   * Read from the document by the caller rather than from a store here, because it IS
   * document state (`GraphNode.ui.valuePlotMode`) and this component has no route to the
   * graph — §V29 keeps store internals out of the editor, and the one mutation path runs
   * back out through `onSetMode`.
   */
  readonly mode?: ValuePlotMode | undefined;
  /**
   * Ask for a different picture. Null means "back to the default for this kind of node".
   *
   * Absent, and no button is drawn at all — which is what a read-only surface (a test
   * mounting the plot directly, a future printed view) gets, rather than a control that
   * silently does nothing when pressed.
   */
  readonly onSetMode?: ((mode: ValuePlotMode | null) => void) | undefined;
}

/** Why a value node is off. The word the body prints, and the reason it is off. */
export type ValueSilence = "muted" | "bypassed";

export interface ValuePlotSource {
  readonly definition: NodeDefinition;
  /** Effective values for plotting — see `plotValues`. */
  readonly values: Readonly<Record<string, ParameterValue>>;
  /** §V45: reaches sample-and-hold shapes, so the plot matches what renders. */
  readonly randomSeed: number;
  /**
   * T735: this node's cycle INHERITED from upstream, when it has one of its own to draw.
   *
   * Resolved by the caller, which is where the graph is, and null for the overwhelming
   * majority of nodes. A Math node has no frequency of its own, so before this it fell to
   * the history plot — a two-second window over a sixteen-to-ninety-second cycle, whose
   * sticky range refit about two hundred times a minute while the signal did nothing.
   */
  readonly chain?: ValuePlotChain | null;
  /** The registry the chain is evaluated against. Required when `chain` is set. */
  readonly registry?: NodeRegistryView | null;
}

/** Viewbox units. The plot scales to its box; these only set the sampling resolution. */
const WIDTH = 100;
const HEIGHT = 32;

/** Distinct strokes, in order. Tokens only (§V17) — the CSS maps these to variables. */
const CHANNEL_CLASS = [styles.seriesA, styles.seriesB, styles.seriesC, styles.seriesD] as const;

/**
 * The x half of every path command for a window of `length` samples — `M0.00 `,
 * `L0.84 `, … — formatted once per length rather than once per sample per tick.
 */
const X_COMMANDS = new Map<number, readonly string[]>();

function xCommands(length: number): readonly string[] {
  let commands = X_COMMANDS.get(length);
  if (commands === undefined) {
    const step = length === 1 ? 0 : WIDTH / (length - 1);
    commands = Array.from(
      { length },
      (_, index) => `${index === 0 ? "M" : " L"}${(index * step).toFixed(2)} `,
    );
    X_COMMANDS.set(length, commands);
  }
  return commands;
}

/** A degenerate range would divide by zero; a constant signal draws down the middle. */
function project(series: readonly number[], low: number, span: number): string {
  if (series.length === 0) return "";
  const xs = xCommands(series.length);
  let path = "";
  for (let index = 0; index < series.length; index += 1) {
    const value = series[index] as number;
    const unit = span === 0 ? 0.5 : (value - low) / span;
    // SVG y grows downward; the signal should not be drawn upside down.
    const y = HEIGHT - unit * HEIGHT;
    path += `${xs[index] as string}${y.toFixed(2)}`;
  }
  return path;
}

/** Where in its cycle a periodic function is at `timeSeconds`; null before the first frame. */
function phaseAt(timeSeconds: number | null, periodSeconds: number): number | null {
  if (timeSeconds === null) return null;
  const cycles = timeSeconds / periodSeconds;
  const phase = cycles - Math.floor(cycles);
  return Number.isFinite(phase) ? phase : null;
}

/** The window's range across EVERY channel, so overlaid series stay comparable. */
function rangeOf(history: ValueHistory): PlotRange {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const series of history.series) {
    for (const value of series) {
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return { low: 0, high: 0 };
  return { low, high };
}

export function ValuePlot({
  nodeId,
  history,
  source = null,
  silence = null,
  mode,
  onSetMode,
}: ValuePlotProps) {
  const root = useRef<HTMLDivElement>(null);
  // Held across renders, per node, because the whole point is that it does NOT follow
  // every window. Declared above the empty-state return so the hook order is fixed.
  const heldRange = useRef<PlotRange | null>(null);

  /*
   * The CURVE is a property of the node's parameters and is sampled when those change —
   * i.e. when the caller hands over a new `source` — not on every tick of the clock. The
   * clock only moves the playhead, and that is the one input this component's own
   * subscription supplies (see `source` above). T735's inherited cycle first, then the
   * node's own declared one; both cannot apply at once, `resolveValuePlotChain` enforces
   * that at the source, so this is a preference in name only.
   */
  const curve = useMemo(
    () =>
      source === null
        ? null
        : (source.chain != null && source.registry != null
            ? sampleValueChainPlot(source.chain, source.registry, {
                samples: FUNCTION_PLOT_SAMPLES,
                randomSeed: source.randomSeed,
                timeSeconds: null,
              })
            : null) ??
          sampleValueFunction(source.definition, source.values, {
            timeSeconds: null,
            randomSeed: source.randomSeed,
          }),
    [source],
  );

  /*
   * WHICH PICTURE — decided here because `curve` is the purity test, already computed,
   * and already the thing the graph-pane comment refuses to duplicate. A second predicate
   * for "is this node pure" would be a second thing to keep in step with T459.
   *
   * Above the silence branch on purpose: a muted node draws neither picture, so the mode
   * is irrelevant to it, but the BUTTON is not — the hook order has to be fixed whichever
   * branch returns, and `resolvedMode` is a plain call with no hook in it.
   */
  const isPurePeriodic = curve !== null;
  const resolvedMode = resolveValuePlotMode(mode, isPurePeriodic);
  /*
   * T1691b: the ring's tick reaches this plot only while its picture can be seen AND read:
   * on screen, not under a fullscreen Viewer, and drawn at a size the picture is legible
   * at (`legibleScaleOf`). Below `resolvedMode` because which picture it is decides that
   * size. It reads the ring again the moment it can be read, so nothing is ever stale.
   */
  const subscribe = useVisibleSubscribe(
    root,
    useCallback((listener: () => void) => history.subscribe(nodeId, listener), [history, nodeId]),
    legibleScaleOf(resolvedMode),
  );
  const snapshot = useCallback(() => history.get(nodeId), [history, nodeId]);
  const value = useStoreSelector(subscribe, snapshot, identity);
  const control =
    onSetMode === undefined ? null : (
      <PlotModeButton
        nodeId={nodeId}
        mode={resolvedMode}
        /*
         * Toggling BACK to the default clears the field rather than writing the default
         * into it. Two documents that draw identically should be the same bytes — an
         * example regenerated after someone toggled a node twice would otherwise carry a
         * `valuePlotMode` that changes nothing, and `sync.test.ts` compares bytes.
         */
        onSelect={(next) =>
          onSetMode(next === resolveValuePlotMode(undefined, isPurePeriodic) ? null : next)
        }
      />
    );

  // T576: OFF, before either picture. Ahead of the function plot because that one does
  // not need the value graph to draw and would otherwise keep running; ahead of the
  // history plot because the ring holds the window this node had when it was switched off
  // and a frozen tail reads as a live-but-still signal. Named, never blank (§V91) — the
  // same shape a preview's OFF state uses rather than an empty box.
  if (silence !== null) {
    return (
      <div ref={root} className={styles.plot} data-testid={`value-plot-${nodeId}`}>
        {control}
        <span className={styles.empty}>{silence}</span>
      </div>
    );
  }

  if (resolvedMode === "bar") {
    /*
     * `channels` as well as `latest`, and the two are NOT the same question.
     *
     * `latest` is null before the first sample; an empty BAG is a node that ran and
     * published nothing — a Select with nothing selected, a Switch with no live input —
     * and it arrives as `{}` with no channels. Bar mode used to check only the first, so
     * that node rendered an empty list: no rows, no message, just a gap where a picture
     * goes. The trail branch below has always tested both (`series.length === 0`), and
     * §V91 is one rule for one question, so the answer has to be the same on both sides.
     */
    if (value.latest === null || value.channels.length === 0) {
      return (
        <div ref={root} className={styles.plot} data-testid={`value-plot-${nodeId}`}>
          {control}
          <span className={styles.empty}>no signal yet</span>
        </div>
      );
    }
    return (
      <div ref={root} className={styles.plot} data-testid={`value-plot-${nodeId}`}>
        {control}
        <ValueBars
          nodeId={nodeId}
          channels={value.channels}
          latest={value.latest}
          meta={source?.definition.valueChannelMeta}
        />
      </div>
    );
  }

  if (curve !== null) {
    // A chain's phase is on the ABSOLUTE clock; a node's own is phase zero until the
    // graph has run — what `sampleValueFunction` does with a null time, restated.
    const timeSeconds =
      source?.chain != null && source.registry != null ? value.timeSeconds : (value.timeSeconds ?? 0);
    return (
      <FunctionPlot
        rootRef={root}
        nodeId={nodeId}
        fn={curve}
        phase={phaseAt(timeSeconds, curve.periodSeconds)}
        latest={value.latest}
        control={control}
      />
    );
  }

  if (value.latest === null || value.series.length === 0) {
    // Named state, not a zeroed plot (§V91): this node has produced nothing yet, which is
    // a different fact from producing zero.
    return (
      <div ref={root} className={styles.plot} data-testid={`value-plot-${nodeId}`}>
        {control}
        <span className={styles.empty}>no signal yet</span>
      </div>
    );
  }

  const range = stickyRange(heldRange.current, rangeOf(value));
  heldRange.current = range;
  const low = range.low;
  const span = range.high - range.low;

  return (
    <div ref={root} className={styles.plot} data-testid={`value-plot-${nodeId}`}>
      {control}
      <svg
        className={styles.canvas}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {value.series.map((series, index) => (
          <path
            key={value.plotted[index] ?? index}
            className={CHANNEL_CLASS[index % CHANNEL_CLASS.length]}
            d={project(series, low, span)}
            fill="none"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <dl
        /*
         * T1297: `nowheel` ONLY when the list actually overflows. React Flow reads it as
         * `target.closest('.nowheel')` on the wheel event, so carrying it unconditionally
         * would make a three-channel node a dead zone for canvas zoom — a cost paid by
         * every node to solve a problem only `audioIn` has.
         */
        className={
          value.channels.length > value.plotted.length
            ? `${styles.values} ${styles.valuesScroll} nowheel`
            : styles.values
        }
        aria-label={`Channels of ${nodeId}`}
      >
        {value.channels.map((channel, index) => (
          <div
            key={channel}
            className={styles.reading}
            // §T1393b: the channel menu's target — see value-bars.tsx.
            data-channel-name={channel}
            data-channel-value={String(value.latest?.[channel] ?? "")}
          >
            {/* Only a PLOTTED channel gets its stroke's colour: tinting the 19th name
                with seriesC would claim a line that is not on the canvas. */}
            <dt className={index < value.plotted.length ? cxChannel(index) : styles.channel}>
              {channel}
            </dt>
            <dd className={styles.number}>{formatValue(value.latest?.[channel] ?? 0)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * One cycle of a pure node's curve, with the playhead on it (T459).
 *
 * Its own component so the hook order stays fixed and the sticky range is held PER MODE —
 * a node that switched between function and history would otherwise carry a range fitted
 * to the other picture.
 *
 * ## Ranging: the same rule as history, deliberately
 *
 * The function's range is exact and known, so ranging it is easier than ranging a sliding
 * window and it would be tempting to just use min/max directly. It uses `stickyRange`
 * anyway, for the reason T352 exists: two plots in one graph must agree about what full
 * height MEANS, or a user comparing an LFO against the Lag it feeds reads two different
 * scales as if they were one. Consistency beats the easier rule. It costs nothing here —
 * the samples only change when a parameter does, so the range holds perfectly still and
 * §V296's breathing cannot recur.
 */
function FunctionPlot({
  rootRef,
  nodeId,
  fn,
  phase,
  latest,
  control,
}: {
  readonly control: ReactNode;
  readonly rootRef: RefObject<HTMLDivElement | null>;
  readonly nodeId: NodeId;
  /** The cycle; its own `phase` is null and unused — the live one is the prop. */
  readonly fn: ValueFunctionPlot;
  readonly phase: number | null;
  readonly latest: Readonly<Record<string, number>> | null;
}) {
  const heldRange = useRef<PlotRange | null>(null);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const sample of fn.series) {
    if (sample < low) low = sample;
    if (sample > high) high = sample;
  }
  const measured: PlotRange =
    Number.isFinite(low) && Number.isFinite(high) ? { low, high } : { low: 0, high: 0 };
  const range = stickyRange(heldRange.current, measured);
  heldRange.current = range;
  const span = range.high - range.low;
  // The curve holds still between parameter changes; only the playhead moves per tick.
  const curvePath = useMemo(() => project(fn.series, range.low, span), [fn, range.low, span]);

  const playX = phase === null ? 0 : phase * WIDTH;
  const index =
    phase === null ? 0 : Math.min(fn.series.length - 1, Math.round(phase * fn.series.length));
  const current = fn.series[index] ?? 0;
  const unit = span === 0 ? 0.5 : (current - range.low) / span;
  const playY = HEIGHT - unit * HEIGHT;
  /*
   * The CURVE is drawn before the graph has ever run, and the NUMBER is not.
   *
   * They are different claims. "This node makes a sine at 2 Hz" is true of a pure
   * function whether or not a frame has been rendered — it is what the node IS — so
   * drawing it immediately is honest and is the whole point of showing the shape at a
   * glance. "This node's value is 0.500" is a claim about something it PRODUCED, and
   * before the first sample it has produced nothing. §V91's rule survives intact by
   * applying it to the half it was actually about.
   */
  const reading = latest === null ? null : latest["value"] ?? current;

  return (
    <div ref={rootRef} className={styles.plot} data-testid={`value-plot-${nodeId}`}>
      {control}
      <svg
        className={styles.canvas}
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path
          className={CHANNEL_CLASS[0]}
          d={curvePath}
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        {phase === null ? null : (
          <line
          className={styles.playhead}
          data-testid={`value-playhead-${nodeId}`}
          x1={playX.toFixed(2)}
          y1={0}
          x2={playX.toFixed(2)}
          y2={HEIGHT}
          vectorEffect="non-scaling-stroke"
          />
        )}
        {phase === null ? null : (
          <circle className={styles.playdot} cx={playX.toFixed(2)} cy={playY.toFixed(2)} r={1.6} />
        )}
      </svg>
      <dl className={styles.values} aria-label={`Channels of ${nodeId}`}>
        <div className={styles.reading} data-channel-name="value" {...(reading === null ? {} : { "data-channel-value": String(reading) })}>
          <dt className={cxChannel(0)}>value</dt>
          <dd className={styles.number}>{reading === null ? "—" : formatValue(reading)}</dd>
        </div>
      </dl>
    </div>
  );
}

/**
 * The ONE control in the node body — bar, or curve.
 *
 * ## Why it is here and not in the header
 *
 * T892 took the camera button OUT of the node header and `preview-inspect-chrome.test.ts`
 * pins the header at exactly P, B, M, with the count asserted: a conditional fourth
 * member made the title's width depend on a fact about the node, and the owner's report
 * was a name truncated to `ha…`. That argument is about the header's budget and it still
 * holds, so this does not go there. It belongs to the plot anyway — it changes what the
 * plot draws, not what the node IS, which is what the three flags do.
 *
 * ## Hidden until asked for
 *
 * Opacity, revealed on hover and on `:focus-visible`, never unmounted. Unmounting would
 * make it unreachable by keyboard and invisible to a test that does not know to simulate
 * a pointer, and §V90's complaint is about INK in a dense pane rather than about DOM — a
 * button nobody can see costs nothing on screen, which is the whole of what was being
 * protected. The plot it sits on is `position: relative` already.
 */
function PlotModeButton({
  nodeId,
  mode,
  onSelect,
}: {
  readonly nodeId: NodeId;
  readonly mode: ValuePlotMode;
  readonly onSelect: (mode: ValuePlotMode) => void;
}) {
  const next: ValuePlotMode = mode === "bar" ? "trail" : "bar";
  const label = next === "bar" ? "Show current value as a bar" : "Show the signal over time";
  return (
    <button
      type="button"
      className={styles.modeButton}
      data-testid={`value-plot-mode-${nodeId}`}
      data-mode={mode}
      aria-label={label}
      title={label}
      onClick={(event) => {
        // The canvas treats a click on a node as a selection gesture and a double click
        // as a dive; neither is what pressing a control inside the body means.
        event.stopPropagation();
        onSelect(next);
      }}
    >
      {next === "bar" ? "\u25ae" : "\u223f"}
    </button>
  );
}

const identity = (value: ValueHistory): ValueHistory => value;

/** The swatch beside a reading uses the same stroke class as its line. */
function cxChannel(index: number): string {
  return `${styles.channel} ${CHANNEL_CLASS[index % CHANNEL_CLASS.length] ?? ""}`.trim();
}
