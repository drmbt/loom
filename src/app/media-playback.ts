import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { ChannelResolver, ParameterMorphs } from "@domain/parameters/resolve.ts";
import { createParameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import {
  createMediaClock,
  mediaPlayhead,
  mediaPlayheadAt,
  mediaTransportFrom,
  type MediaClock,
  type MediaPlayhead,
  type MediaTransportValues,
} from "@domain/media/transport.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * DRIVING A REAL `<video>` / `<audio>` FROM A DERIVED PLAYHEAD (T493).
 *
 * `mediaPlayhead` says where the media should be. This is the half that makes a browser
 * element agree with it — and it is written ONCE, for both doors, because the movie hook
 * and the audio hook driving elements by two different rules is exactly the drift T493
 * was told to design out. The video element and the audio element differ in nothing this
 * module touches, so it takes the structural `PlayableMedia` and neither hook owns a copy
 * of the seek policy.
 *
 * ## Why it is not "just set currentTime every frame"
 *
 * Writing `currentTime` sixty times a second re-seeks the decoder sixty times a second and
 * the picture stutters and the sound clicks. So the element PLAYS — at `playbackRate` —
 * and a seek is kept for the deliberate discontinuities the transport runner marks. A
 * seek would restart audio buffering and can recreate the very lag it tries to correct.
 *
 * ## Who is the clock while it plays (§V1027, T1542b)
 *
 * In realtime FREE RUN the element is. Its sound runs on the audio hardware's clock and
 * the frame loop is only a sampler of it, so the runner re-bases the playhead on
 * `currentTime` every continuous frame and the element is left at exactly `speed`: a
 * stall, a throttled rAF or a hidden tab is paid in dropped frames, never in samples
 * (§T740's rule, which had reached the timeline and stopped short of this module — §B236).
 * Under the TIMELINE LOCK the frame is the master by contract (§V436), so there the
 * element still converges on the playhead — calmly (§T1549b): nothing inside one frame of
 * drift, whole 1% rate steps written only when the step changes, one seek past 0.25 s.
 *
 * A loop, scrub, cue, trim edit or speed change is a new target rather than clock drift —
 * except a positive speed change in free run, which is a `playbackRate` write: the
 * position integrates on from where it is (B187).
 * Standalone callers without continuity information retain the tolerance-based policy.
 *
 * ## Reverse is a scrub, and says so
 *
 * No browser plays a negative `playbackRate` — Chrome and Safari throw, Firefox ignores.
 * So a negative speed PAUSES the element and steps `currentTime` per frame, which is what
 * reverse playback actually is. Stated here rather than left as a mystery stutter.
 */

/** The members of `HTMLMediaElement` this module touches. Structural, so a test needs no DOM. */
export interface PlayableMedia {
  currentTime: number;
  playbackRate: number;
  readonly duration: number;
  readonly paused: boolean;
  play(): Promise<void> | void;
  pause(): void;
}

/**
 * How far the element may drift before it is corrected.
 *
 * Roughly four frames at 25fps. Tighter and an ordinary decode hiccup triggers a seek,
 * which causes the stutter it was meant to prevent; looser and a scrub feels lagged.
 */
export const SEEK_TOLERANCE_SECONDS = 0.15;

/** Browsers clamp playback rate; outside this range they throw or silently ignore. */
const MIN_RATE = 0.0625;
const MAX_RATE = 16;
// Native media clocks round positions to microseconds; fractional-frame targets cannot
// be represented exactly. Comparing them bit-for-bit restarts a held seek every frame.
const POSITION_PRECISION_SECONDS = 1e-6;

/*
 * §T1549b, option (a) — THE TIMELINE LOCK'S CORRECTION, CALMED. The frame stays master
 * (§V436), so the element still converges on the playhead, but a listener hears every
 * `playbackRate` write as a resample and every seek as a jump. So: no correction inside one
 * delivered frame of drift, the rate moves in whole 1% steps and is written only when the
 * step changes, and past a quarter second the element is sought ONCE rather than chased.
 */
/** Whole-percent rate steps, at most this many either way: ±5%. */
const MAX_RATE_STEPS = 5;
// Four-second convergence time constant, bounded above so audio never races to catch up.
const DRIFT_RATE_GAIN = 0.25;
/** Past this the lock seeks once instead of bending the rate for many seconds. */
export const LOCK_RESYNC_SECONDS = 0.25;
/**
 * B242: media seconds (at speed 1) a locked element must PLAY past where it was last put —
 * a seek, a cue, a lap, the first frame — before a resync can be armed. Chrome's audio
 * output starts ~0.2 s after every `play()` and every seek, and longer on a loaded machine,
 * with `seeking` false, `readyState` 4 and `paused` false the whole time: no element state
 * says it has not started. `currentTime` creeps a video frame past the seek point first,
 * then freezes. Half a second of media is far past that creep, and a frozen element never
 * reaches it, however long the freeze.
 */
const LOCK_SETTLE_SECONDS = 0.5;
/** The least time between two rate-step writes: a hard ceiling of four a second. */
const LOCK_STEP_DWELL_SECONDS = 0.25;

/**
 * The next whole-percent rate step for a locked element `drift` seconds behind (positive)
 * or ahead (negative) of its playhead. A correction STARTS only outside one delivered frame
 * and, once running, carries on until the drift is inside half a frame or has crossed over;
 * the size only moves by a whole step. Without both margins the frame grid's own jitter
 * (a 45 Hz display on a 60 fps timeline lands either side of the real time by half a frame)
 * would flip the step on and off every frame.
 */
function nextLockStep(step: number, drift: number, frameSeconds: number): number {
  const size = Math.abs(drift);
  const direction = Math.sign(drift);
  const settled = step === 0
    ? size <= frameSeconds
    : size <= frameSeconds / 2 || direction !== Math.sign(step);
  if (settled) return 0;
  const raw = size * DRIFT_RATE_GAIN * 100;
  if (step !== 0 && Math.abs(raw - Math.abs(step)) < 1) return step;
  return direction * Math.min(MAX_RATE_STEPS, Math.max(1, Math.round(raw)));
}

/** Whether the shared transport requires a held decoder, including blocked autoplay. */
export function isMediaPlayheadHeld(transport: MediaTransportValues, head: MediaPlayhead, duration = 0): boolean {
  const speed = Number.isFinite(transport.speed) ? transport.speed : 1;
  return head.cued || head.done || (Number.isFinite(duration) && duration > 0 && head.start === head.end)
    || speed <= 0 || !head.visible || (transport.playMode === "freeRun" && !transport.play);
}

/**
 * Put the element where the playhead says, without restarting continuous audio.
 * `continuous: true` never seeks: the element plays at `speed × (1 + correction)`, where
 * `correction` is the runner's (`MediaSteppedTransport.correction`) — 0 in free run, where
 * the element is the clock (§V1027), and a whole-percent step under the timeline lock
 * (§T1549b). False seeks exactly. An omitted argument is the standalone drift policy, for
 * callers that do not own a transport history.
 *
 * Returns whether it seeked, so a caller can assert the "only corrects on drift" property
 * rather than trust it.
 */
export function applyMediaPlayhead(
  element: PlayableMedia,
  transport: MediaTransportValues,
  head: MediaPlayhead,
  continuous?: boolean,
  correction?: number,
): boolean {
  const speed = Number.isFinite(transport.speed) ? transport.speed : 1;
  // HELD: a cue, a stopped free-run transport, a zero or reverse speed, or a `black`
  // extend that has taken us outside the window. In every one of those the element must
  // not be running on its own clock, because the position no longer advances with it.
  const held = isMediaPlayheadHeld(transport, head, element.duration);

  if (held) {
    if (!element.paused) element.pause();
    // Reverse and cue both need the exact frame, so the tolerance does not apply: this is
    // a scrub, and a scrub that lands "close enough" is the wrong frame.
    if (Math.abs(element.currentTime - head.position) > POSITION_PRECISION_SECONDS) {
      element.currentTime = head.position;
      return true;
    }
    return false;
  }

  const drift = head.position - element.currentTime;
  // Seeking restarts the audio decoder's buffering. Correcting ordinary startup lag
  // with a seek can therefore recreate that lag forever. During a continuous run the
  // runner has already decided the rate — it holds the history a calm correction needs
  // (§T1549b) — and this only writes it when it changed; discontinuities still seek exactly.
  // REQUIRED with `continuous: true`, for `morphs`' reason: a door that dropped it would
  // leave a locked element uncorrected until it drifted far enough to seek, and say nothing.
  if (continuous === true && correction === undefined) {
    throw new Error("applyMediaPlayhead: a continuous frame needs the runner's `correction` (MediaSteppedTransport.correction).");
  }
  const bend = continuous === true && Number.isFinite(correction)
    ? Math.max(-MAX_RATE_STEPS / 100, Math.min(MAX_RATE_STEPS / 100, correction as number)) : 0;
  const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, speed * (1 + bend)));
  if (element.playbackRate !== rate) element.playbackRate = rate;
  if (element.paused) void element.play();

  if (continuous === false ? Math.abs(drift) > POSITION_PRECISION_SECONDS
    : continuous !== true && Math.abs(drift) > SEEK_TOLERANCE_SECONDS) {
    element.currentTime = head.position;
    return true;
  }
  return false;
}

/**
 * One node's live transport: its own free-run accumulator, and the last playhead it
 * produced. Kept per node id, because two Movie File In nodes on one file are two
 * independent transports — the same reason `mediaSourceIdFor` keys on the node.
 */
export interface MediaSteppedTransport {
  readonly transport: MediaTransportValues;
  readonly head: MediaPlayhead;
  /** The element is left playing, never sought; false marks a cue, scrub, lap or edit. */
  readonly continuous: boolean;
  /**
   * §T1549b: the fraction the element's rate is bent off `speed` this frame — a whole
   * percent, at most ±5%, under the timeline lock; 0 everywhere else. Hand it to
   * `applyMediaPlayhead` with `continuous`.
   */
  readonly correction: number;
  /**
   * Everything else the node resolved this frame — `volume`, and whatever a door adds
   * next. Handed back rather than re-resolved by the caller so the audio hook's volume
   * and its playhead cannot come from two different reads of the same frame (§B8's shape).
   */
  readonly read: (key: string) => ParameterValue | undefined;
}

export interface MediaTransportRunner {
  /**
   * Resolve the node's parameters for this frame and return where its media is.
   *
   * `elementSeconds` is the element's own `currentTime`, read by the door this frame. In
   * realtime free run a continuous frame takes the playhead from it (§V1027). REQUIRED,
   * for `morphs`' reason: a door that forgot it would keep a playhead nothing corrects,
   * and say nothing. `null` is the answer where there is no element to follow.
   */
  step(frame: FrameEvaluationInput, duration: number, elementSeconds: number | null): MediaSteppedTransport | null;
  /** A cue PULSE (free-run only): land on the cue point and carry on from there. */
  cue(): void;
  reset(): void;
}

export interface MediaTransportContext {
  readonly graph: () => GraphDocument;
  readonly registry: NodeRegistryView;
  /** The value graph's resolver, so a DRIVEN speed or trim reaches here like any other. */
  readonly channels: () => ChannelResolver | undefined;
  /**
   * T1524b: the preset morphs in flight over `graph()` (`FlattenedGraph.morphs`), so a
   * speed, a trim or a volume a bank is fading reaches the element at the value the
   * picture is at that frame, not at its destination. Read per step, like `channels`, and
   * REQUIRED like it: an optional getter nothing supplies is how a door ends up resolving
   * without it (§V272). `undefined` — and `cue()`, which has no frame — reads what the
   * document stores.
   */
  readonly morphs: () => ParameterMorphs | undefined;
}

/**
 * A node's transport, resolved through the ONE parameter read path (§V61, §V107).
 *
 * Every transport parameter therefore takes every mode: an expression on `speed`, a
 * `cuePoint` bound to a sibling, a `trimStart` driven by an audio channel. Nothing here
 * knows about modes — that is the whole reason it calls `resolveParameters` rather than
 * reading `node.parameters` directly, which is what a bespoke transport widget would have
 * had to do.
 */
export function createMediaTransportRunner(
  nodeId: NodeId,
  context: MediaTransportContext,
): MediaTransportRunner {
  const clock: MediaClock = createMediaClock();
  let lastDuration = 0;
  let previous: { transport: MediaTransportValues; head: MediaPlayhead; time: number; mode: FrameEvaluationInput["mode"] } | null = null;
  let cuePending = false;
  // §T1549b — the timeline lock's correction state: the whole-percent rate step in force,
  // when it was last changed (seconds of delivered frames), whether a resync seek is armed,
  // and (B242) the position the element was last put at, which it must play past to arm.
  let lockStep = 0;
  let lockStepAt = -Infinity;
  let resyncArmed = false;
  let settleFrom = 0;
  let runSeconds = 0;

  const readAll = (
    frame?: FrameEvaluationInput,
  ): ((key: string) => ParameterValue | undefined) | null => {
    const node = context.graph().nodes[nodeId];
    if (node === undefined) return null;
    const definition = context.registry.get(node.type);
    if (definition === undefined) return null;
    const channels = context.channels();
    /**
     * ⚑ T1155 — §V837's ONE FACTORY, and this call site is why it exists.
     *
     * These options used to be `{ frame, channels }` spelled out here, with NO `nodes`
     * reader — and `op('sun1').chan.high` is read INSIDE that reader, never off
     * `channels`. So every expression on a transport parameter failed with "this context
     * has no channel resolver", fell back to §V108's retained static, and froze there:
     * the docblock above has promised "a `cuePoint` bound to a sibling, a `trimStart`
     * driven by an audio channel" since T493 and NOT ONE OF THEM HAS EVER WORKED.
     *
     * §B8's shape, and §V837 already names it as having recurred four times (§T593, the
     * inspector §T1000, the OSC pump §T1001, §B46). This was the fifth, and it was found
     * by E56, whose whole picture is a driven `cuePoint`: the file loaded, the element
     * reached readyState 4, and `currentTime` sat at the retained 3.42 forever.
     */
    const resolved = resolveParameters(node, definition, createParameterReadOptions({
      graph: context.graph(),
      registry: context.registry,
      ...(frame === undefined ? {} : { frame }),
      ...(channels === undefined ? {} : { channels }),
      morphs: context.morphs(),
    }));
    return (key) => resolved.get(key)?.value;
  };

  return {
    step(frame, duration, elementSeconds) {
      const read = readAll(frame);
      if (read === null) return null;
      const transport = mediaTransportFrom(read);
      lastDuration = duration;
      const last = previous;
      const pending = cuePending;
      const follows = (candidate: MediaPlayhead): boolean =>
        frame.mode === "realtime" && last !== null && last.mode === frame.mode && !pending
        && !isMediaPlayheadHeld(transport, candidate, duration) && !isMediaPlayheadHeld(last.transport, last.head, duration)
        && transport.playMode === last.transport.playMode
        // B187: in free run a speed change is a rate write and the position integrates on
        // from where it is — both speeds are positive here, because a held transport (0 or
        // reverse) never follows. Under the lock a new speed re-prices the whole timeline
        // (§V436: position = timeline × speed), which is a new target and seeks.
        && (transport.speed === last.transport.speed || transport.playMode === "freeRun")
        && transport.trimStart === last.transport.trimStart && transport.trimEnd === last.transport.trimEnd
        && transport.extend === last.transport.extend
        && candidate.laps === last.head.laps && candidate.position >= last.head.position
        && (transport.playMode === "freeRun"
          || Math.abs(frame.timeSeconds - last.time - frame.deltaSeconds) < 1e-6);
      // B187: the clock hands back the media offset (`∫ speed dt` in free run, `timeline ×
      // speed` under the lock), so it enters through `mediaPlayheadAt`, never multiplied twice.
      let head = mediaPlayheadAt(transport, clock.advance(transport, frame.deltaSeconds, frame.timeSeconds), duration);
      let continuous = follows(head);
      /*
       * §V1027, T1542b — THE ELEMENT IS THE CLOCK. The accumulator above is only a
       * prediction of where a playing element got to; the element knows. So on a frame
       * that would have left it playing, take its position, and judge continuity again
       * from there: an element that ran past the out point while no frame was delivered
       * is a lap, and a lap is still a seek.
       *
       * Realtime free run only. Under the lock the position is `f(frame)` (§V436), which
       * the `playMode` check keeps out; in a take the frame is the master (§V662), and
       * `follows` is false on every frame that is not realtime.
       */
      if (continuous && transport.playMode === "freeRun" && elementSeconds !== null && Number.isFinite(elementSeconds)) {
        head = mediaPlayheadAt(transport, clock.adopt(head, elementSeconds), duration);
        continuous = follows(head);
      }
      /*
       * §T1549b, option (a) — UNDER THE LOCK THE FRAME STAYS MASTER, CALMLY. The playhead is
       * `f(frame)` and is not touched here; only how the element is brought to it is. Inside
       * one delivered frame of drift nothing is written; beyond it the rate moves in whole
       * 1% steps no more often than `LOCK_STEP_DWELL_SECONDS`; past `LOCK_RESYNC_SECONDS`
       * the element is sought ONCE — and only while a resync is ARMED.
       *
       * B242: a resync is armed only once the element has played `LOCK_SETTLE_SECONDS`
       * past where it was last put AND is back inside half of `LOCK_RESYNC_SECONDS`.
       * Every seek, cue, lap and first frame disarms it. The lag a decoder builds while it
       * starts is alignment, which the rate closes, not drift (§T493: a seek restarts that
       * start-up and recreates the lag). T1549b re-armed as soon as the element read past the seek
       * point, and Chrome's element does that within a frame, before it freezes for its
       * audio start: every start-up longer than 0.25 s became one more seek, 14 and 16 in
       * the 3 s still-pixels proof. A real drift (a stall, a jump) on a playing element
       * still gets its one seek.
       */
      runSeconds += Number.isFinite(frame.deltaSeconds) ? Math.max(0, frame.deltaSeconds) : 0;
      const locked = continuous && transport.playMode !== "freeRun"
        && elementSeconds !== null && Number.isFinite(elementSeconds);
      if (locked) {
        const drift = head.position - elementSeconds;
        if (resyncArmed && Math.abs(drift) > LOCK_RESYNC_SECONDS) {
          continuous = false;
          resyncArmed = false;
          settleFrom = head.position;
          lockStep = 0;
        } else {
          // Back inside HALF the threshold: armed right at it, the frame grid's jitter
          // (±1 frame of `currentTime` granularity) crosses it the next frame and seeks.
          if (!resyncArmed && Math.abs(drift) <= LOCK_RESYNC_SECONDS / 2
            && elementSeconds - settleFrom >= LOCK_SETTLE_SECONDS * transport.speed) {
            resyncArmed = true;
          }
          const proposed = nextLockStep(lockStep, drift, frame.deltaSeconds);
          if (proposed !== lockStep && runSeconds - lockStepAt >= LOCK_STEP_DWELL_SECONDS) {
            lockStep = proposed;
            lockStepAt = runSeconds;
          }
        }
      } else {
        // Any other frame writes the element at exactly `speed` (a seek, free run, a take),
        // and disarms the resync: the element starts again from `head.position`.
        lockStep = 0;
        resyncArmed = false;
        settleFrom = head.position;
      }
      previous = { transport, head, time: frame.timeSeconds, mode: frame.mode };
      cuePending = false;
      return { transport, head, continuous, correction: locked ? lockStep / 100 : 0, read };
    },
    cue() {
      const read = readAll();
      if (read === null) return;
      const transport = mediaTransportFrom(read);
      // Through the playhead's own arithmetic, so a cue lands on the frame the playhead
      // function would report for that point rather than on a second opinion about it.
      const head = mediaPlayhead(transport, 0, lastDuration);
      const point = Math.max(head.start, Math.min(head.end > head.start ? head.end : Infinity, transport.cuePoint));
      clock.cueTo(head, point);
      cuePending = true;
    },
    reset() {
      clock.reset();
      previous = null;
      cuePending = false;
      lockStep = 0;
      lockStepAt = -Infinity;
      resyncArmed = false;
      settleFrom = 0;
    },
  };
}

/**
 * The element as something a transport can drive, or null.
 *
 * A STRUCTURAL check rather than an `instanceof`, for the same reason `MediaElement` is
 * structural: a test hands in a plain object, the browser hands in a `<video>`. It also
 * gives the honest answer for the two cases that have no playhead — a webcam stream and a
 * test double that never claimed to be seekable — which then simply are not driven,
 * instead of throwing on a missing `play`.
 */
export function playableMedia(element: unknown): PlayableMedia | null {
  if (element === null || typeof element !== "object") return null;
  const candidate = element as Partial<PlayableMedia>;
  if (typeof candidate.currentTime !== "number") return null;
  if (typeof candidate.play !== "function" || typeof candidate.pause !== "function") return null;
  return candidate as PlayableMedia;
}

/** A media element's length in seconds, or 0 while the browser does not know it yet. */
export function durationOf(element: { readonly duration?: number }): number {
  const duration = element.duration;
  return typeof duration === "number" && Number.isFinite(duration) && duration > 0 ? duration : 0;
}
