import { nextRegionAfter, regionRate, sampleTrack, sourceTimeAt } from "@domain/regions/evaluate.ts";
import type { ClipTrack, Region } from "@domain/regions/model.ts";
import { TICKS_PER_SECOND } from "@domain/time/ticks.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { MediaPlayhead, MediaTransportValues } from "@domain/media/transport.ts";
import { playheadTicks } from "@nodes/definitions/automation.ts";
import type { MediaSource, MediaSourceFrame } from "@runtime/backend/index.ts";
import { applyMediaPlayhead, seekAndPresent, type PresentableMedia } from "./media-playback.ts";
import { createVideoMediaSource, type MediaElement } from "./media-sources.ts";

/**
 * VN101 — PLAYING A CLIP TRACK: A POOL OF MEDIA ELEMENTS DRIVEN FROM `sourceTimeAt`.
 *
 * The node (`clip-track.ts`) is Movie File In's graph side; this is what the app registers
 * behind its `mediaSourceIdFor(nodeId)`. One MediaSource, whose frames come from whichever
 * region is under the playhead, and a TRANSPARENT frame in a gap or after a once-and-clear
 * pass.
 *
 * ## The pool
 *
 * One element per region near the playhead: the active one, and the NEXT one, opened and
 * parked paused on its first source frame once the playhead is within `prerollTicks` of its
 * cut, so the cut shows a decoded frame instead of a decoder start-up. Anything else is
 * released (paused and emptied, so its decoder goes now). Two regions on one file are two
 * elements, as the movie door's loop partner is.
 *
 * ## Driving the element: the movie path, not a fork
 *
 * The position is `sourceTimeAt` (pure, §V436); getting an element there is
 * `applyMediaPlayhead`, the one routine the movie and audio doors share (§T493): an element
 * that is playing on is left alone inside the drift tolerance, a discontinuity (a cut, a
 * loop lap, a bounce turn, a scrub) is an exact seek, and reverse — which no browser plays —
 * pauses and steps `currentTime` per frame. The instantaneous direction is read from the
 * region's own function one frame ahead, so a bounce's way back is reverse and a held
 * once-clip is a pause, without a second copy of the play-mode rules.
 *
 * ## A take is frame-exact
 *
 * `prepare(frame)` opens the active region's element if it must, pauses it on the frame's
 * source time and waits for the decoded frame (`seekAndPresent`), before the step renders
 * (VNB19's seam, `MediaWiring.prepareFrame`). The step then finds no drift and seeks nothing.
 */

/** How far ahead of a cut the next region's element is opened and parked: two seconds. */
export const PREROLL_TICKS = 2 * TICKS_PER_SECOND;

/** What the player needs from the environment. Structural, so a test needs no DOM. */
export interface ClipTrackDoor {
  /** Open the media at `url`: an element with metadata, muted. Throws to report failure. */
  open(url: string): Promise<MediaElement & PresentableMedia>;
  /** The frame a gap shows: transparent. */
  blank(): Omit<MediaSourceFrame, "frameId">;
  /** Free an element that left the pool. */
  release(element: MediaElement & PresentableMedia): void;
  /** The frames an element produces. Defaults to `createVideoMediaSource`. */
  frames?(element: MediaElement & PresentableMedia): { readonly source: MediaSource; dispose(): void };
  /** A region's media could not be opened. Called once per failure. */
  report?(region: Region, message: string): void;
}

interface Slot {
  readonly region: Region;
  element: (MediaElement & PresentableMedia) | null;
  frames: { readonly source: MediaSource; dispose(): void } | null;
  opening: Promise<void> | null;
  failed: boolean;
  /** The last position this slot was driven to, for the continuity test. */
  last: { position: number; direction: number } | null;
}

export interface ClipTrackPlayer {
  /** Register this under `mediaSourceIdFor(nodeId)`. */
  readonly source: MediaSource;
  /** Once per rendered frame, after the value graph (the movie door's order). */
  sync(frame: FrameEvaluationInput, track: ClipTrack | null, tempoBpm: number): void;
  /** Before a take's step: the active region sought to and showing the frame's picture. */
  prepare(frame: FrameEvaluationInput, track: ClipTrack | null, tempoBpm: number): Promise<void>;
  /** The app's transport stopped: pause every element. */
  pause(): void;
  /** Which region is showing, for tests and the inspector. Null in a gap. */
  showing(): string | null;
  dispose(): void;
}

const TRANSPORT_BASE: Omit<MediaTransportValues, "speed"> = {
  playMode: "timeline", play: true, cue: false, cuePoint: 0, trimStart: 0, trimEnd: 0, extend: "hold",
};

function ticksPerFrame(frame: FrameEvaluationInput): number {
  const fps = frame.fps !== undefined && frame.fps > 0 ? frame.fps * (frame.subframes ?? 1) : 0;
  if (fps > 0) return TICKS_PER_SECOND / fps;
  return Math.max(1, Math.round((frame.deltaSeconds > 0 ? frame.deltaSeconds : 1 / 60) * TICKS_PER_SECOND));
}

export function createClipTrackPlayer(door: ClipTrackDoor): ClipTrackPlayer {
  const slots = new Map<string, Slot>();
  let shown: Slot | null = null;
  let disposed = false;
  // The composite frame id: advances whenever the frame it hands out changes, from any slot.
  let frameId = 0;
  let lastKey: unknown = null;
  let lastInner = -1;

  const frames = door.frames ?? ((element) => createVideoMediaSource(element));

  const ensure = (region: Region): Slot => {
    let slot = slots.get(region.id);
    if (slot !== undefined && slot.region.media !== region.media) {
      drop(slot);
      slot = undefined;
    }
    if (slot === undefined) {
      slot = { region, element: null, frames: null, opening: null, failed: false, last: null };
      slots.set(region.id, slot);
    } else if (slot.region !== region) {
      // Same id and file, edited in/out or mode: keep the element, take the new numbers.
      slot = { ...slot, region };
      slots.set(region.id, slot);
    }
    const opened = slot;
    if (opened.element === null && opened.opening === null && !opened.failed && region.media !== "") {
      opened.opening = door.open(region.media).then((element) => {
        if (disposed || slots.get(region.id)?.opening !== opened.opening) {
          door.release(element);
          return;
        }
        const live = slots.get(region.id) as Slot;
        live.element = element;
        live.frames = frames(element);
        live.opening = null;
      }, (error: unknown) => {
        const live = slots.get(region.id);
        if (live !== undefined) {
          live.failed = true;
          live.opening = null;
        }
        door.report?.(region, error instanceof Error ? error.message : String(error));
      });
    }
    return slots.get(region.id) as Slot;
  };

  const drop = (slot: Slot) => {
    slots.delete(slot.region.id);
    slot.frames?.dispose();
    if (slot.element !== null) door.release(slot.element);
    if (shown === slot) shown = null;
  };

  /** Keep only the regions named; release the rest. */
  const keep = (ids: ReadonlySet<string>) => {
    for (const slot of [...slots.values()]) {
      if (!ids.has(slot.region.id)) drop(slot);
    }
  };

  /** Park the next region's element on its first frame, paused. */
  const preroll = (track: ClipTrack, ticks: number, tempoBpm: number, wanted: Set<string>) => {
    const next = nextRegionAfter(track, ticks);
    if (next === null || next.timelineStart - ticks > PREROLL_TICKS) return;
    wanted.add(next.id);
    const slot = ensure(next);
    const first = sourceTimeAt(next, next.timelineStart, tempoBpm);
    if (slot.element === null || first === null) return;
    if (!slot.element.paused) slot.element.pause();
    const seconds = first / TICKS_PER_SECOND;
    if (slot.element.seeking !== true && Math.abs(slot.element.currentTime - seconds) > 1e-6) slot.element.currentTime = seconds;
  };

  const source: MediaSource = {
    currentFrame(): MediaSourceFrame | undefined {
      if (disposed) return undefined;
      const inner = shown?.frames?.source.currentFrame();
      if (shown === null || inner === undefined) {
        // A gap, or a region whose first frame has not decoded yet: transparent, never the
        // previous region's last frame (a cut that lagged would otherwise show stale media).
        if (lastKey !== "blank") {
          lastKey = "blank";
          frameId += 1;
        }
        return { frameId, ...door.blank() };
      }
      if (lastKey !== shown || lastInner !== inner.frameId) {
        lastKey = shown;
        lastInner = inner.frameId;
        frameId += 1;
      }
      return { ...inner, frameId };
    },
  };

  return {
    source,
    sync(frame, track, tempoBpm) {
      if (disposed) return;
      if (track === null) {
        keep(new Set());
        shown = null;
        return;
      }
      const ticks = playheadTicks(frame);
      const sample = sampleTrack(track, ticks, tempoBpm);
      const wanted = new Set<string>();
      if (sample !== null) wanted.add(sample.region.id);
      preroll(track, ticks, tempoBpm, wanted);
      keep(wanted);
      if (sample === null) {
        shown = null;
        return;
      }
      const slot = ensure(sample.region);
      if (slot.element === null) {
        shown = null;
        return;
      }
      const position = sample.sourceTicks / TICKS_PER_SECOND;
      const ahead = sourceTimeAt(sample.region, ticks + ticksPerFrame(frame), tempoBpm);
      const step = ahead === null ? 0 : ahead - sample.sourceTicks;
      const rate = regionRate(sample.region, tempoBpm);
      const direction = step > 0 ? 1 : step < 0 ? -1 : 0;
      const speed = direction * rate;
      // Continuous: the same region, playing the same way, landing where playing on puts it.
      // Anything else (a cut, a lap, a bounce turn, a scrub, a take's frame) is an exact seek.
      const expected = slot.last === null ? null : slot.last.position + slot.last.direction * rate * frame.deltaSeconds;
      const continuous = frame.mode === "realtime" && shown === slot && slot.last !== null
        && slot.last.direction === direction && direction > 0 && expected !== null
        && Math.abs(position - expected) < 0.25;
      const head: MediaPlayhead = {
        position,
        start: sample.region.sourceIn / TICKS_PER_SECOND,
        end: sample.region.sourceOut / TICKS_PER_SECOND,
        visible: true, done: false, cued: false, laps: 0,
      };
      applyMediaPlayhead(slot.element, { ...TRANSPORT_BASE, speed }, head, continuous ? undefined : false);
      slot.last = { position, direction };
      shown = slot;
    },
    async prepare(frame, track, tempoBpm) {
      if (disposed || track === null) return;
      const ticks = playheadTicks(frame);
      const sample = sampleTrack(track, ticks, tempoBpm);
      if (sample === null) return;
      const slot = ensure(sample.region);
      if (slot.opening !== null) await slot.opening;
      const live = slots.get(sample.region.id);
      if (live?.element === null || live?.element === undefined) return;
      await seekAndPresent(live.element, sample.sourceTicks / TICKS_PER_SECOND);
    },
    pause() {
      for (const slot of slots.values()) {
        if (slot.element !== null && !slot.element.paused) slot.element.pause();
      }
    },
    showing() {
      return shown?.region.id ?? null;
    },
    dispose() {
      if (disposed) return;
      for (const slot of [...slots.values()]) drop(slot);
      disposed = true;
    },
  };
}
