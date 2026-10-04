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
 * §T1548b — how a movie loops in REALTIME FREE RUN: `"native"` for the whole file (in
 * point 0, out point the duration), on its one element with `loop = true`; `"handOver"` for
 * a trimmed window, which takes the second element. Null wherever a lap stays an exact
 * seek: under the lock (§V436), off realtime (§V662), any other extend, a held cue, or
 * before the duration is known.
 */
export function movieLoopOf(
  transport: MediaTransportValues,
  head: MediaPlayhead,
  duration: number,
  mode: FrameEvaluationInput["mode"],
): "native" | "handOver" | null {
  if (mode !== "realtime" || transport.playMode !== "freeRun" || transport.extend !== "loop" || transport.cue) return null;
  if (!(duration > 0) || head.end - head.start <= PRIMED_PRECISION_SECONDS) return null;
  return head.start <= PRIMED_PRECISION_SECONDS && head.end >= duration - PRIMED_PRECISION_SECONDS ? "native" : "handOver";
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
 * - The WHOLE FILE loops natively: `loop = true` on its one element, no partner, nothing
 *   written at the lap. The wrap shows as `currentTime` running backwards; `position()`
 *   adds one window on that frame, so the runner takes it as a lap and the playhead does
 *   not read it as a scrub.
 * - A TRIMMED window HANDS OVER: a second element on the same file waits paused on the in
 *   point; at the lap it plays, the finished one pauses and is put back on the in point.
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
  const refreshLevel = () => {
    const silent = !audible || renderMuted || mode !== "realtime" || !wantedPlaying;
    if (door !== null) {
      const muted = !door.running();
      for (const [media, entry] of routes) {
        if (media.muted !== muted) media.muted = muted;
        const gain = media === audioElement && !silent ? level : 0;
        if (entry.level !== gain) {
          entry.level = gain;
          entry.route.gain.value = gain;
        }
      }
    } else if (audioElement.muted !== silent) {
      audioElement.muted = silent;
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
  const pause = () => {
    wantedPlaying = false;
    pending = null;
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
      const loop = movieLoopOf(stepped.transport, stepped.head, durationOf(audioElement), currentMode);
      const native = loop === "native" && canLoop(audioElement);
      // §T1548b — THE HAND-OVER. The finished element is paused and silenced, never sought
      // while it plays; the partner starts from the in point it was waiting on.
      const waiting = idle;
      const handOver = stepped.lap && !native && currentMode === "realtime"
        && waiting !== null && primed(waiting, stepped.head.start);
      if (handOver) {
        const finished = audioElement;
        audioElement = waiting;
        idle = finished;
        pending = null;
        if (!routed) finished.muted = true;
        finished.pause();
        carried = stepped.head.position - stepped.head.start;
        show(audioElement);
      } else if (!stepped.continuous && !(native && stepped.lap)) {
        // Any other discontinuity seeks the element exactly onto the playhead: nothing carried.
        carried = 0;
      }
      // §T1548b: the whole file loops on the element itself; everything else wraps by the
      // transport (a seek or a hand-over), and an element left looping would fight it.
      if (canLoop(audioElement) && audioElement.loop !== native) audioElement.loop = native;
      if (idle !== null && idle.loop === true) idle.loop = false;
      nativeLooping = native;
      loopWindow = stepped.head.end - stepped.head.start;
      if (!routed && audioElement.volume !== level) audioElement.volume = level;
      audible = enabled && level > 0 && stepped.head.visible;
      mode = currentMode;
      if (isMediaPlayheadHeld(stepped.transport, stepped.head, audioElement.duration)) pause();
      refreshLevel();
      // A hand-over, and a native wrap, write nothing on the element that plays.
      if (handOver || (native && stepped.lap)) applyMediaPlayhead(controlled, stepped.transport, stepped.head, true, 0);
      else applyMediaPlayhead(controlled, stepped.transport, stepped.head, stepped.continuous, stepped.correction);
      // The one waiting is kept on the in point: after a hand-over, and when a trim moves it.
      if (idle !== null && idle.seeking !== true
        && Math.abs(idle.currentTime - stepped.head.start) > PRIMED_PRECISION_SECONDS) {
        idle.currentTime = stepped.head.start;
      }
      lastSeen = audioElement.currentTime;
    },
    position() {
      if (waitingForContext()) return null;
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
    pause,
    setRenderMuted(muted) { renderMuted = muted; refreshLevel(); },
    dispose() {
      if (disposed) return;
      pause();
      if (idle !== null && !idle.paused) idle.pause();
      for (const { route } of routes.values()) route.release();
      routes.clear();
      disposed = true;
    },
  };
}
