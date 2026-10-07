import type { FrameRange } from "@domain/types/graph.ts";
import { timelineReadout } from "./timeline-model.ts";
import styles from "./timeline-pane.module.css";

/**
 * VN62 — THE READOUT: timecode, frame, elapsed from the in point, remaining to the out
 * point. Drop-frame timecode at 29.97 / 59.94 (`;` before the frames). Pure display of the
 * frame the pane last sampled; the pane samples at 10 Hz (§V16), never per render frame.
 */
export interface TimelineStatusProps {
  readonly frame: number | null;
  readonly fps: number;
  readonly range: FrameRange;
}

export function TimelineStatus({ frame, fps, range }: TimelineStatusProps) {
  const readout = frame === null ? null : timelineReadout(frame, fps, range);
  return (
    <div className={styles.readout} aria-label="playhead">
      <span className={styles.timecode} data-readout="timecode">{readout?.timecode ?? "--:--:--:--"}</span>
      <span title="frame" data-readout="frame">f {readout?.frame ?? "-"}</span>
      <span title="elapsed since the in point" data-readout="elapsed">+{readout?.elapsed ?? "-"}</span>
      <span title="remaining to the out point" data-readout="remaining">−{readout?.remaining ?? "-"}</span>
    </div>
  );
}
