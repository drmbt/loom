import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { applyMediaPlayhead, isMediaPlayheadHeld, type MediaSteppedTransport, type PlayableMedia } from "./media-playback.ts";

export interface MovieAudioPlayback {
  sync(stepped: MediaSteppedTransport, mode: FrameEvaluationInput["mode"]): void;
  pause(): void;
  setRenderMuted(muted: boolean): void;
  dispose(): void;
}

/** One decoder and playhead for both picture and sound; no separate audio element. */
export function createMovieAudioPlayback(
  element: PlayableMedia,
  activation: Pick<EventTarget, "addEventListener" | "removeEventListener">,
  report: (message: string | null) => void,
): MovieAudioPlayback {
  if (!("muted" in element) || typeof element.muted !== "boolean"
    || !("volume" in element) || typeof element.volume !== "number") {
    throw new Error("Movie playback requires an element with native audio mute and volume controls.");
  }
  const audioElement = element as PlayableMedia & { muted: boolean; volume: number };
  let disposed = false;
  let pending: object | null = null;
  let blocked = false;
  let listening = false;
  let wantedPlaying = !element.paused;
  let audible = false;
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
  const refreshMute = () => {
    const muted = !audible || renderMuted || mode !== "realtime" || !wantedPlaying;
    if (audioElement.muted === muted) return;
    audioElement.muted = muted;
    // Explicitly disabling sound removes the reason an audible autoplay was blocked.
    if (muted) clearBlock();
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
    refreshMute();
    if (pending !== null || blocked) return;
    const token = {};
    pending = token;
    try {
      const result = element.play();
      if (result === undefined) {
        pending = null;
        clearBlock();
      } else {
        void result.then(() => {
          if (disposed || pending !== token) {
            if (!wantedPlaying || disposed) element.pause();
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
    refreshMute();
    if (!element.paused) element.pause();
  };
  const controlled: PlayableMedia = {
    get currentTime() { return element.currentTime; },
    set currentTime(value) { element.currentTime = value; },
    get playbackRate() { return element.playbackRate; },
    set playbackRate(value) { element.playbackRate = value; },
    get duration() { return element.duration; },
    get paused() { return element.paused; },
    play,
    pause,
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
      const level = Math.max(0, Math.min(1, volume));
      if (audioElement.volume !== level) audioElement.volume = level;
      audible = enabled && level > 0 && stepped.head.visible;
      mode = currentMode;
      if (isMediaPlayheadHeld(stepped.transport, stepped.head, element.duration)) pause();
      refreshMute();
      applyMediaPlayhead(controlled, stepped.transport, stepped.head, stepped.continuous);
    },
    pause,
    setRenderMuted(muted) { renderMuted = muted; refreshMute(); },
    dispose() {
      if (disposed) return;
      pause();
      disposed = true;
    },
  };
}
