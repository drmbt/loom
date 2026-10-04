import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { MediaPlayhead, MediaTransportValues } from "@domain/media/transport.ts";
import { applyMediaPlayhead, durationOf, isMediaPlayheadHeld, type MediaSteppedTransport, type PlayableMedia } from "./media-playback.ts";

/**
 * §T1548b: one element's way to the speakers through the app's `AudioContext` —
 * element → its own gain → destination (`appMovieAudioOutput`). The gain is the element's
 * volume AND its mute: Chrome ignores `element.volume` on a routed element.
 */
export interface MovieAudioRoute {
  readonly gain: { value: number };
  /** Off the speakers: the element is being dropped. Routing it again reconnects. */
  release(): void;
}

/** §T1548b: where routed movie sound goes. Structural, so a test needs no Web Audio. */
export interface MovieAudioOutput {
  /** The element's route, made on first ask; null when it cannot be routed (it then plays through its own output). */
  route(element: PlayableMedia): MovieAudioRoute | null;
  /** True while the context runs. Before the page's first gesture it is suspended. */
  running(): boolean;
}

export interface MovieAudioPlayback {
  sync(stepped: MediaSteppedTransport, mode: FrameEvaluationInput["mode"]): void;
  /**
   * §T1548b: what to hand `MediaTransportRunner.step` as the element's seconds — the
   * playing element's `currentTime`, plus the remainder carried over a hand-over, plus one
   * window on the frame a native loop wrapped (below). NULL while routed sound waits for
   * its context to run: the element is held muted then, and the playhead runs on the frame
   * clock rather than following it (the gesture rule, below).
   */
  position(): number | null;
  /**
   * §T1548b: a second element on the same file. It waits paused on the in point, silent;
   * a free-run Loop lap (`MediaSteppedTransport.lap`) hands picture and sound to it instead
   * of seeking the one that was playing, and the two alternate. `show` is told which
   * element now plays, so the picture source follows. False (and nothing kept) for the
   * playing element itself, a second partner, an element without native mute and volume,
   * or one that cannot be routed when the first one is.
   */
  attachPartner(partner: PlayableMedia, show: (playing: PlayableMedia) => void): boolean;
  /**
   * §T1560b: drop the element that is NOT playing — paused, off the speakers, forgotten —
   * and hand it back so its opener can free its decoder. Null when there is none. A silent
   * whole-file Loop asks for this: it loops natively on one element.
   */
  releasePartner(): PlayableMedia | null;
  /** §T1560b: the PLAYING element's length (0 while unknown) — after a hand-over, the partner's. */
  duration(): number;
  pause(): void;
  setRenderMuted(muted: boolean): void;
  dispose(): void;
}

type AudibleMedia = PlayableMedia & {
  muted: boolean;
  volume: number;
  loop?: boolean;
  readonly seeking?: boolean;
  readonly readyState?: number;
};

function hasNativeAudio(element: PlayableMedia): element is AudibleMedia {
  return "muted" in element && typeof element.muted === "boolean"
    && "volume" in element && typeof element.volume === "number";
}

/** Whether the element can loop itself: a real media element can, an older test double cannot. */
function canLoop(element: AudibleMedia): boolean {
  return "loop" in element && typeof element.loop === "boolean";
}

// Native media clocks round positions to microseconds (media-playback.ts says the same).
const PRIMED_PRECISION_SECONDS = 1e-6;
/** HAVE_CURRENT_DATA: the frame at the element's position is decoded. */
const HAVE_CURRENT_DATA = 2;
/**
 * §T1560b: how close to the end of the FILE a whole-file hand-over arms its timer. An
 * element stops at the end of its file, so waiting for the next frame there is silence.
 * Re-armed every frame from the element's own clock, so it only has to exceed a frame.
 */
const END_HORIZON_SECONDS = 0.25;
/**
 * §T1560b: how many ms before the end of the file the partner is started. Measured in headed
 * Chromium through the product's routing (docs/media-fit-and-audio-2026-10-03.md): at 0 and
 * 1.5 ms every lap ran 1–4 ms long with two or three 1–4 ms near-silent runs at the join (a
 * timer fires late and `play()` takes a few ms to sound); at 3 ms laps were -5.4..+1.9 ms of
 * the file and the runs no worse than a trimmed hand-over's.
 */
export const END_LEAD_MS = 3;

/** §T1560b: the window is the whole file — in point 0, out point the duration. */
function wholeFile(head: MediaPlayhead, duration: number): boolean {
  return head.start <= PRIMED_PRECISION_SECONDS && head.end >= duration - PRIMED_PRECISION_SECONDS;
}

/**
 * §T1548b — how a movie loops in REALTIME FREE RUN: `"native"` on its one element with
 * `loop = true`, or `"handOver"` to a second element. A trimmed window always hands over.
 * §T1560b (owner, 2026-10-04): the WHOLE FILE (in point 0, out point the duration) hands
 * over too while the movie's `audio` is on — Chrome's native loop costs ~20 ms and a 16 ms
 * silence per wrap, which is heard — and loops natively, on one decoder, while it is off.
 * Null wherever a lap stays an exact seek: under the lock (§V436), off realtime (§V662),
 * any other extend, a held cue, or before the duration is known.
 */
export function movieLoopOf(
  transport: MediaTransportValues,
  head: MediaPlayhead,
  duration: number,
  mode: FrameEvaluationInput["mode"],
  audio: boolean,
): "native" | "handOver" | null {
  if (mode !== "realtime" || transport.playMode !== "freeRun" || transport.extend !== "loop" || transport.cue) return null;
  if (!(duration > 0) || head.end - head.start <= PRIMED_PRECISION_SECONDS) return null;
  return wholeFile(head, duration) && !audio ? "native" : "handOver";
}

/**
 * One playhead for both picture and sound, with no separate audio element.
 *
 * §T1548b — THE SOUND GOES THROUGH THE APP'S `AudioContext` (owner, 2026-10-04). With an
 * `output`, every element is routed (element → gain → destination) and its volume and mute
 * are its gain: the playing element's gain is the Volume when it should sound, 0 otherwise,
 * and a waiting partner's is 0. Without one (no Web Audio) the element's own `muted` and
 * `volume` do it, as before.
 *
 * THE GESTURE RULE. Before the page's first gesture the context is suspended, and an
 * unmuted routed element then nearly stops its clock (measured in Chrome: 0.002 s of media
 * in 1 s). So while the context is not running every routed element is held MUTED, and
 * `position()` is null: the free-run playhead runs on the frame clock instead of adopting
 * the element (§V1027 is suspended, never stalled). Once the context runs, the elements
 * are unmuted (the gain decides what is heard) and the next frame adopts the element.
 *
 * LOOPING IN REALTIME FREE RUN WITHOUT A SEEK. With the element as the clock (§V1027) a lap
 * that seeks pays the decoder's seek latency every lap, in picture and sound.
 * - A SILENT WHOLE FILE loops natively: `loop = true` on its one element, no partner,
 *   nothing written at the lap. The wrap shows as `currentTime` running backwards;
 *   `position()` adds one window on that frame, so the runner takes it as a lap and the
 *   playhead does not read it as a scrub. A whole file with `audio` on also loops so while
 *   its partner is not primed yet (§T1560b), so turning Audio on never costs a seek.
 * - A TRIMMED window, and a whole file with `audio` on (§T1560b), HAND OVER: a second
 *   element on the same file waits paused on the in point; at the lap it plays, the
 *   finished one pauses and is put back on the in point.
 * - §T1560b: an element STOPS at the end of its file, where a trimmed one plays on past
 *   its out point, so a whole-file lap taken on the next frame is that much silence (up to
 *   20 ms, measured). Within `END_HORIZON_SECONDS` of the end each frame arms a timer off
 *   the element's own clock that starts the partner at the end of the file; the first frame
 *   after the finished element has stopped there completes the hand-over with nothing
 *   carried, because the partner's own time is then the position.
 *   Routed through a running context this measured 0.500 s laps for a 0.5 s window with no
 *   audio gap (T1548b); through the elements' own outputs `play()` waited ~0.2 s for audio
 *   output to start, as a seek does.
 * The hand-over happens on a frame, so the finished element has run up to one frame past
 * the out point. That remainder is CARRIED: `position()` reads the new element plus it, so
 * the next lap ends that much early and N laps last N windows to within one frame instead
 * of drifting a frame per lap. Under the lock, off realtime and with no primed partner a
 * lap is still the exact seek it was.
 */
export function createMovieAudioPlayback(
  element: PlayableMedia,
  activation: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  report: (message: string | null) => void,
  /** §T1548b: the app's `AudioContext` door (`appMovieAudioOutput`), or null for the element's own output. */
  output: MovieAudioOutput | null,
): MovieAudioPlayback {
  if (!hasNativeAudio(element)) {
    throw new Error("Movie playback requires an element with native audio mute and volume controls.");
  }
  // The element that plays now, and the one waiting on the in point (§T1548b).
  let audioElement: AudibleMedia = element;
  let idle: AudibleMedia | null = null;
  let show: (playing: PlayableMedia) => void = () => undefined;
  let carried = 0;
  /** §T1548b: each routed element's route and the gain last written to it. */
  const routes = new Map<AudibleMedia, { route: MovieAudioRoute; level: number }>();
  const first = output?.route(element) ?? null;
  if (first !== null) routes.set(element, { route: first, level: 0 });
  /** The door the elements are routed through: null when the first could not be (or there is none). */
  const door = first === null ? null : output;
  const routed = door !== null;
  /** §T1548b: whether the current element looped natively at the last sync, the window, and where it was. */
  let nativeLooping = false;
  let loopWindow = 0;
  let lastSeen: number | null = null;
  /**
   * §T1560b: a release swapped to a partner started for a lap the runner has not taken yet;
   * the next frame must read that lap as the native wrap it now is (see `releasePartner`).
   */
  let wrapPending = false;
  /** §T1560b: the partner the end-of-file timer started ahead of the frame, and the window it laps. */
  let early: AudibleMedia | null = null;
  let endTimer: ReturnType<typeof setTimeout> | null = null;
  let loopStart = 0;
  let loopEnd = 0;
  let disposed = false;
  let pending: object | null = null;
  let blocked = false;
  let listening = false;
  let wantedPlaying = !element.paused;
  let audible = false;
  let level = 0;
  let silentBefore = true;
  let renderMuted = false;
  let mode: FrameEvaluationInput["mode"] = "realtime";

  const detach = () => {
    if (!listening) return;
    listening = false;
    activation.removeEventListener("pointerdown", retry);
    activation.removeEventListener("keydown", retry);
  };
  const clearBlock = () => {
    detach();
    if (!blocked) return;
    blocked = false;
    report(null);
  };
  /** Routed sound waits for the context; until it runs, the elements stay muted. */
  const waitingForContext = () => door !== null && !door.running();
  /** Whether `media` should be heard now: the playing element, or a partner started for the lap. */
  const sounding = (media: AudibleMedia) => media === audioElement || media === early;
  const refreshLevel = () => {
    const silent = !audible || renderMuted || mode !== "realtime" || !wantedPlaying;
    if (door !== null) {
      const muted = !door.running();
      for (const [media, entry] of routes) {
        if (media.muted !== muted) media.muted = muted;
        const gain = sounding(media) && !silent ? level : 0;
        if (entry.level !== gain) {
          entry.level = gain;
          entry.route.gain.value = gain;
        }
      }
    } else {
      if (audioElement.muted !== silent) audioElement.muted = silent;
      if (early !== null && early.muted !== silent) early.muted = silent;
    }
    if (silent === silentBefore) return;
    silentBefore = silent;
    // Explicitly disabling sound removes the reason an audible autoplay was blocked.
    if (silent) clearBlock();
  };
  const failed = (token: object, error: unknown) => {
    if (disposed || pending !== token) return;
    pending = null;
    blocked = true;
    const denied = error !== null && typeof error === "object" && "name" in error && error.name === "NotAllowedError";
    const detail = error !== null && typeof error === "object" && "message" in error && typeof error.message === "string"
      ? error.message : String(error);
    const message = denied
      ? "Movie playback was blocked by browser autoplay. Click or press a key in the page to enable playback and audio."
      : `Movie playback failed: ${detail}. Click or press a key to retry.`;
    report(message);
    if (!listening) {
      listening = true;
      activation.addEventListener("pointerdown", retry);
      activation.addEventListener("keydown", retry);
    }
  };
  const play = () => {
    if (disposed) throw new Error("Movie playback is closed.");
    wantedPlaying = true;
    refreshLevel();
    if (pending !== null || blocked) return;
    const token = {};
    pending = token;
    // The element this request is for: a hand-over may make the other one current before
    // the browser answers, and a late answer must pause the one it started (§T1548b).
    const target = audioElement;
    try {
      const result = target.play();
      if (result === undefined) {
        pending = null;
        clearBlock();
      } else {
        void result.then(() => {
          if (disposed || pending !== token) {
            if (!wantedPlaying || disposed || target !== audioElement) target.pause();
            return;
          }
          pending = null;
          clearBlock();
        }, error => failed(token, error));
      }
    } catch (error) {
      failed(token, error);
    }
  };
  function retry() {
    if (disposed || !wantedPlaying || !blocked) return;
    clearBlock();
    // Stay on the activation event's stack; an awaited retry loses browser permission.
    play();
  }
  const cancelEndTimer = () => {
    if (endTimer === null) return;
    clearTimeout(endTimer);
    endTimer = null;
  };
  /** §T1560b: a partner started for a lap the frame did not take goes back to waiting, silent. */
  const stopEarly = () => {
    const started = early;
    if (started === null) return;
    early = null;
    if (!started.paused) started.pause();
    if (!routed) started.muted = true;
  };
  const pause = () => {
    wantedPlaying = false;
    pending = null;
    cancelEndTimer();
    stopEarly();
    clearBlock();
    refreshLevel();
    if (!audioElement.paused) audioElement.pause();
  };
  const controlled: PlayableMedia = {
    get currentTime() { return audioElement.currentTime; },
    set currentTime(value) { audioElement.currentTime = value; },
    get playbackRate() { return audioElement.playbackRate; },
    set playbackRate(value) { audioElement.playbackRate = value; },
    get duration() { return audioElement.duration; },
    get paused() { return audioElement.paused; },
    play,
    pause,
  };
  /** Paused on `start` with the frame there decoded: ready to take a lap. */
  const primed = (partner: AudibleMedia, start: number): boolean =>
    partner.paused && partner.seeking !== true
    && (partner.readyState ?? HAVE_CURRENT_DATA) >= HAVE_CURRENT_DATA
    && Math.abs(partner.currentTime - start) <= PRIMED_PRECISION_SECONDS;
  /**
   * §T1560b — the end of the file, on the element's own clock rather than the next frame's:
   * start the primed partner there. Fired early (timers are coarse) it re-arms for what is
   * left; a frame that arrives first cancels it and arms afresh.
   */
  const endOfFile = () => {
    endTimer = null;
    const partner = idle;
    if (disposed || early !== null || partner === null || !wantedPlaying || !primed(partner, loopStart)) return;
    const rate = audioElement.playbackRate > 0 ? audioElement.playbackRate : 1;
    const left = ((loopEnd - audioElement.currentTime) / rate) * 1000 - END_LEAD_MS;
    if (left > 1) {
      endTimer = setTimeout(endOfFile, left);
      return;
    }
    if (partner.playbackRate !== audioElement.playbackRate) partner.playbackRate = audioElement.playbackRate;
    early = partner;
    refreshLevel();
    try {
      const result = partner.play();
      // A refusal leaves it paused on the in point: primed, so the frame hands over as before.
      if (result !== undefined) void result.catch(() => undefined);
    } catch {
      // As above.
    }
  };
  audioElement.muted = true;
  return {
    sync(stepped, currentMode) {
      if (disposed) throw new Error("Movie playback is closed.");
      const enabled = stepped.read("audio");
      const volume = stepped.read("volume");
      if (typeof enabled !== "boolean" || typeof volume !== "number" || !Number.isFinite(volume)) {
        throw new Error("Movie audio and volume must resolve to a boolean and a finite number.");
      }
      level = Math.max(0, Math.min(1, volume));
      cancelEndTimer();
      const duration = durationOf(audioElement);
      const loop = movieLoopOf(stepped.transport, stepped.head, duration, currentMode, enabled);
      const whole = loop !== null && wholeFile(stepped.head, duration);
      const waiting = idle;
      // Ready to take the lap: waiting on the in point, or already started there by the end-of-file timer.
      const ready = waiting !== null && (waiting === early || primed(waiting, stepped.head.start));
      // §T1560b: a lap the element took by looping itself is not handed over as well.
      const nativeWrap = stepped.lap && nativeLooping && lastSeen !== null
        && audioElement.currentTime < lastSeen - loopWindow / 2;
      const native = canLoop(audioElement)
        && (loop === "native" || (loop === "handOver" && whole && (!ready || nativeWrap)));
      // §T1548b — THE HAND-OVER. The finished element is paused and silenced, never sought
      // while it plays; the partner starts from the in point it was waiting on.
      const handOver = stepped.lap && !native && currentMode === "realtime" && waiting !== null && ready;
      if (handOver) {
        const finished = audioElement;
        audioElement = waiting;
        idle = finished;
        pending = null;
        if (!routed) finished.muted = true;
        finished.pause();
        // §T1560b: a partner the timer started is AT the position already; nothing to carry.
        carried = waiting === early ? 0 : stepped.head.position - stepped.head.start;
        early = null;
        show(audioElement);
      } else if (!stepped.continuous && !(native && stepped.lap)) {
        // Any other discontinuity seeks the element exactly onto the playhead: nothing carried.
        carried = 0;
      }
      // A partner started for a lap this frame did not take (a cue, a hold, a trim edit); a
      // continuous frame is the finished element still playing out its last milliseconds.
      if (!handOver && !(early !== null && stepped.continuous)) stopEarly();
      // §T1548b: the whole file loops on the element itself; everything else wraps by the
      // transport (a seek or a hand-over), and an element left looping would fight it.
      if (canLoop(audioElement) && audioElement.loop !== native) audioElement.loop = native;
      if (idle !== null && idle.loop === true) idle.loop = false;
      nativeLooping = native;
      loopWindow = stepped.head.end - stepped.head.start;
      loopStart = stepped.head.start;
      loopEnd = stepped.head.end;
      if (!routed && audioElement.volume !== level) audioElement.volume = level;
      audible = enabled && level > 0 && stepped.head.visible;
      mode = currentMode;
      if (isMediaPlayheadHeld(stepped.transport, stepped.head, audioElement.duration)) pause();
      refreshLevel();
      // A hand-over, and a native wrap, write nothing on the element that plays.
      if (handOver || (native && stepped.lap)) applyMediaPlayhead(controlled, stepped.transport, stepped.head, true, 0);
      else applyMediaPlayhead(controlled, stepped.transport, stepped.head, stepped.continuous, stepped.correction);
      // The one waiting is kept on the in point: after a hand-over, and when a trim moves it.
      // B245: not a partner the end-of-file timer started — it PLAYS from the in point while
      // the finished one plays out its last milliseconds (a continuous frame), and putting it
      // back there was a seek on a playing element.
      if (idle !== null && idle !== early && idle.seeking !== true
        && Math.abs(idle.currentTime - stepped.head.start) > PRIMED_PRECISION_SECONDS) {
        idle.currentTime = stepped.head.start;
      }
      // After a swap the runner still follows the finished lap: leave `lastSeen` at its end,
      // so the next `position()` reads the partner's early time as a wrap, not a scrub.
      lastSeen = wrapPending ? loopEnd : audioElement.currentTime;
      wrapPending = false;
      // §T1560b: near the end of the file, start the partner there rather than a frame late.
      if (whole && !native && wantedPlaying && !waitingForContext() && idle !== null && primed(idle, loopStart)) {
        const rate = audioElement.playbackRate > 0 ? audioElement.playbackRate : 1;
        const left = (loopEnd - audioElement.currentTime) / rate;
        if (left <= END_HORIZON_SECONDS) endTimer = setTimeout(endOfFile, Math.max(0, left * 1000 - END_LEAD_MS));
      }
    },
    position() {
      if (waitingForContext()) return null;
      // §T1560b: the partner started at the end of the file is the next lap, from the in point —
      // once the finished element has played to that end. Until then it is still followed, so
      // a frame between the partner's `play()` and its first sound cuts nothing off the file.
      if (early !== null && (audioElement.paused || audioElement.currentTime >= loopEnd - PRIMED_PRECISION_SECONDS)) {
        return loopEnd + early.currentTime - loopStart;
      }
      const now = audioElement.currentTime;
      // A native loop wrapped since the last frame: the element ran back by about a window.
      const wrapped = nativeLooping && lastSeen !== null && now < lastSeen - loopWindow / 2 ? loopWindow : 0;
      return now + carried + wrapped;
    },
    attachPartner(partner, onShow) {
      if (disposed) throw new Error("Movie playback is closed.");
      if (partner === element || idle !== null || !hasNativeAudio(partner)) return false;
      if (door !== null) {
        const route = door.route(partner);
        if (route === null) return false;
        route.gain.value = 0;
        routes.set(partner, { route, level: 0 });
      }
      partner.muted = true;
      if (canLoop(partner)) partner.loop = false;
      if (!partner.paused) partner.pause();
      idle = partner;
      show = onShow;
      refreshLevel();
      return true;
    },
    releasePartner() {
      if (disposed) throw new Error("Movie playback is closed.");
      const dropped = idle;
      if (dropped === null) return null;
      cancelEndTimer();
      /*
       * §T1560b — released in the frame between the end-of-file timer and the hand-over: the
       * partner already plays from the in point and the finished element is at (or a few
       * milliseconds from) the end of the file. Re-looping the finished one would restart it
       * from 0 — an implicit seek on a playing element. So the PARTNER stays, as the element
       * that plays (and now loops itself), and the finished one is released instead.
       */
      if (early !== null && early === dropped) {
        const finished = audioElement;
        const lapped = finished.paused || finished.currentTime >= loopEnd - PRIMED_PRECISION_SECONDS;
        audioElement = early;
        early = null;
        idle = null;
        pending = null;
        carried = 0;
        wrapPending = !lapped;
        if (!finished.paused) finished.pause();
        if (!routed) finished.muted = true;
        routes.get(finished)?.route.release();
        routes.delete(finished);
        show(audioElement);
        return finished;
      }
      stopEarly();
      idle = null;
      if (!dropped.paused) dropped.pause();
      routes.get(dropped)?.route.release();
      routes.delete(dropped);
      return dropped;
    },
    duration: () => durationOf(audioElement),
    pause,
    setRenderMuted(muted) { renderMuted = muted; refreshLevel(); },
    dispose() {
      if (disposed) return;
      pause();
      cancelEndTimer();
      if (idle !== null && !idle.paused) idle.pause();
      for (const { route } of routes.values()) route.release();
      routes.clear();
      disposed = true;
    },
  };
}
