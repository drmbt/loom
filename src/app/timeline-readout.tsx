import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameClockVerdict } from "@runtime/telemetry/frame-clock.ts";
import { Tooltip } from "@ui/primitives/tooltip.tsx";
import { frameClockIndicator } from "./frame-clock-indicator.ts";
import styles from "./timeline-readout.module.css";

/** Frame and time from the rendered input, beside the timeline's range (§V169).
 * These samples update only this component at <= 10 Hz (§V16). */

/** §V16: <= 10 Hz. A readout that updates per frame is per-frame data in the tree. */
export const READOUT_INTERVAL_MS = 100;

export interface TimelineReadoutProps {
  /** Reads the last rendered frame. A REF read, never a subscription (§V16). */
  readonly latestFrame: () => FrameInputs | null;
  /** Runs `transport.seek`. Absent = the field is read-only, because nothing can seek. */
  readonly onSeek?: ((frameIndex: number) => void) | undefined;
  /** The scrubber's existing editable out point, paired with the current frame. */
  readonly endPoint?: ReactNode;
  readonly intervalMs?: number;
}

const EM_DASH = "—";

interface Sample {
  readonly frameIndex: number;
  readonly timeSeconds: number;
}

export function TimelineReadout({ latestFrame, onSeek, endPoint, intervalMs = READOUT_INTERVAL_MS }: TimelineReadoutProps) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [draft, setDraft] = useState<string | null>(null);

  useEffect(() => {
    const tick = () => {
      const frame = latestFrame();
      if (frame === null) return;
      setSample({
        frameIndex: frame.frame.frameIndex,
        timeSeconds: frame.frame.timeSeconds,
      });
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, latestFrame]);

  const commit = useCallback(() => {
    const text = draft;
    setDraft(null);
    if (text === null || onSeek === undefined) return;
    const parsed = Number.parseInt(text.trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    onSeek(parsed);
  }, [draft, onSeek]);

  const shown = draft ?? (sample === null ? "" : String(sample.frameIndex));

  return (
    <div className={styles.readout} role="group" aria-label="Timeline readout">
      <div className={styles.frameRange} role="group" aria-label="Frame position" data-editable={onSeek !== undefined} data-grouped={endPoint !== undefined}>
        <div className={styles.field}>
          {/* §V170 (as amended, VN71) on the surface, in one line: a seek JUMPS and feedback
              carries on, so nobody reads the frame as a replay from the start. */}
          <Tooltip label="Type a frame to seek — feedback carries on from where it is">
            <input
              className={styles.input}
              aria-label="Frame"
              inputMode="numeric"
              value={shown}
              placeholder={EM_DASH}
              readOnly={onSeek === undefined}
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                  event.currentTarget.blur();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  setDraft(null);
                  event.currentTarget.blur();
                }
              }}
            />
          </Tooltip>
        </div>
        {endPoint === undefined ? null : <><span className={styles.separator} aria-hidden="true">/</span>{endPoint}</>}
      </div>

      <div className={styles.field}>
        <span className={styles.value} aria-label="Elapsed time">
          {sample === null ? EM_DASH : `${sample.timeSeconds.toFixed(2)}s`}
        </span>
      </div>
    </div>
  );
}

/** Throughput and clock health belong with GPU/CPU timing, separate from position. */
export function TimelineMetrics({ latestFrame, frameClock, intervalMs = READOUT_INTERVAL_MS }: {
  readonly latestFrame: () => FrameInputs | null;
  readonly frameClock: () => FrameClockVerdict;
  readonly intervalMs?: number;
}) {
  const [sample, setSample] = useState<{ clock: FrameClockVerdict; hasFrame: boolean } | null>(null);
  const clock = sample?.clock ?? null;
  useEffect(() => {
    const tick = () => setSample({ clock: frameClock(), hasFrame: latestFrame() !== null });
    tick();
    const timer = setInterval(tick, intervalMs);
    return () => clearInterval(timer);
  }, [frameClock, intervalMs, latestFrame]);
  const indicator = frameClockIndicator(clock ?? { kind: "paused", realtime: false });
  const fps = !sample?.hasFrame || clock === null || clock.kind === "paused" ? null : clock.observedFps;
  return (
    <div className={styles.field}>
      <Tooltip label={indicator.description}>
        <span className={styles.clock} data-kind={clock?.kind ?? "paused"} data-state={indicator.state}
          data-testid="frame-clock-notice" role="status" aria-label={indicator.word}>
          <span className={styles.dot} aria-hidden="true" />
        </span>
      </Tooltip>
      <span className={styles.label}>fps</span>
      <span className={styles.fps} aria-label="Frames per second">{fps === null ? EM_DASH : fps.toFixed(1)}</span>
    </div>
  );
}
