/**
 * VN106 — A video file's duration from its metadata: a detached, muted `<video>` that loads nothing else. */
export function videoDurationSeconds(file: File): Promise<number> {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    const done = (): void => {
      video.removeAttribute("src");
      video.load();
      URL.revokeObjectURL(url);
    };
    video.preload = "metadata";
    video.muted = true;
    video.onloadedmetadata = () => {
      const duration = video.duration;
      done();
      if (Number.isFinite(duration) && duration > 0) resolve(duration);
      else reject(new Error("it reports no duration"));
    };
    video.onerror = () => {
      done();
      reject(new Error("the browser cannot decode it"));
    };
    video.src = url;
  });
}
