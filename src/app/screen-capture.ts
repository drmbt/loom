import { awaitMediaReady, type MediaElement } from "./media-sources.ts";

export interface OpenedScreenCapture {
  readonly element: MediaElement;
  readonly label: string;
  stop(): void;
  onEnded(callback: () => void): () => void;
}

export interface ScreenCaptureEnvironment {
  open(signal?: AbortSignal): Promise<OpenedScreenCapture>;
}

/** Observe late settlements too: native pickers and play() cannot themselves be cancelled. */
function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal, discard?: (value: T) => void): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(value => {
      signal.removeEventListener("abort", abort);
      if (signal.aborted) {
        discard?.(value);
        reject(signal.reason);
      } else resolve(value);
    }, error => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

/** Browser adapter: the caller owns source registration and the capture's lifetime. */
export function browserScreenCaptureEnvironment(): ScreenCaptureEnvironment {
  return {
    async open(signal) {
      signal?.throwIfAborted();
      const media = navigator.mediaDevices;
      if (typeof media?.getDisplayMedia !== "function") {
        throw new Error("Screen capture requires Chrome's screen-sharing API in a secure context (HTTPS or localhost).");
      }
      // Chrome supports this standard option, but this project's lib.dom omits it.
      const options: DisplayMediaStreamOptions & { surfaceSwitching: "include" } = {
        video: { frameRate: 30, displaySurface: "browser" },
        audio: false,
        surfaceSwitching: "include",
      };
      // Invoke before the first await: the browser picker requires transient user activation.
      const stream = await awaitWithAbort(media.getDisplayMedia(options), signal,
        lateStream => { for (const track of lateStream.getTracks()) track.stop(); });
      const tracks = stream.getTracks();
      const videoTracks = stream.getVideoTracks();
      const subscriptions = new Set<() => void>();
      let video: HTMLVideoElement | undefined;
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        signal?.removeEventListener("abort", stop);
        for (const unsubscribe of subscriptions) unsubscribe();
        if (video !== undefined) {
          video.pause();
          video.srcObject = null;
        }
        for (const track of tracks) track.stop();
      };
      signal?.addEventListener("abort", stop, { once: true });
      try {
        signal?.throwIfAborted();
        const firstTrack = videoTracks[0];
        if (firstTrack === undefined) throw new Error("Screen capture returned no video track.");
        if (videoTracks.some(track => track.readyState === "ended")) {
          throw new Error("Screen capture ended before the video was ready.");
        }
        video = document.createElement("video");
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        await awaitMediaReady(video, undefined, undefined, undefined, signal);
        signal?.throwIfAborted();
        await awaitWithAbort(video.play(), signal);
        signal?.throwIfAborted();
        if (videoTracks.some(track => track.readyState === "ended")) {
          throw new Error("Screen capture ended before the video was ready.");
        }
        return {
          element: video,
          label: firstTrack.label,
          stop,
          onEnded(callback) {
            let subscribed = true;
            const unsubscribe = () => {
              if (!subscribed) return;
              subscribed = false;
              for (const track of videoTracks) track.removeEventListener("ended", ended);
              subscriptions.delete(unsubscribe);
            };
            const ended = () => {
              if (!subscribed) return;
              unsubscribe();
              callback();
            };
            if (stopped) return unsubscribe;
            for (const track of videoTracks) track.addEventListener("ended", ended);
            subscriptions.add(unsubscribe);
            // Sharing can end between open() resolving and the owner attaching its listener.
            if (videoTracks.some(track => track.readyState === "ended")) ended();
            return unsubscribe;
          },
        };
      } catch (error) {
        stop();
        throw error;
      }
    },
  };
}
