import { useCallback, useState } from "react";

import type { ProjectSettings } from "@domain/types/graph.ts";
import { projectFps } from "@domain/types/graph.ts";
import { frameRangeLimit } from "@domain/transport/range-limit.ts";
import { NumberField } from "@ui/controls/number-field.tsx";
import { ResolutionControl } from "@ui/controls/resolution-control.tsx";
import { BooleanField } from "@ui/controls/boolean-field.tsx";
import { TextField } from "@ui/controls/text-field.tsx";
import { resolveStartTimecode } from "@runtime/export/index.ts";
import type { EditPhase, NumericSpec } from "@ui/controls/types.ts";
import { Button } from "@ui/primitives/button.tsx";
import { ShareFill } from "@ui/primitives/share-fill.tsx";
import {
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogRoot,
  DialogTitle,
} from "@ui/primitives/dialog.tsx";
import type { RenderRangeSession } from "./use-render-range.ts";
import styles from "./render-video-dialog.module.css";

const FPS_SPEC: NumericSpec = { min: 1, max: 240, step: 1, precision: 0 };
/** An output frame range; the out point's `max` is one day of OUTPUT frames, the range cap at the rate this range counts in (VN71). */
const rangeSpec = (max: number, min = 0): NumericSpec => ({ min, max, step: 1, precision: 0 });

export interface RenderVideoDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly settings: ProjectSettings;
  readonly session: RenderRangeSession;
  readonly onRender: () => void;
}

/**
 * Video-render job surface. These are take-local overrides, initialized from the project;
 * changing export fps or range must not retime or edit the composition itself.
 */
export function RenderVideoDialog({
  open,
  onOpenChange,
  settings,
  session,
  onRender,
}: RenderVideoDialogProps) {
  const [live, setLive] = useState<Readonly<Record<string, number>>>({});
  const shown = useCallback((key: string, stored: number) => live[key] ?? stored, [live]);
  const commitOnly = useCallback(
    (key: string, apply: (value: number) => void) =>
      (value: number, phase: EditPhase): void => {
        if (phase !== "commit") {
          setLive((previous) => ({ ...previous, [key]: value }));
          return;
        }
        setLive((previous) => {
          const { [key]: _dropped, ...rest } = previous;
          return rest;
        });
        apply(value);
      },
    [],
  );

  const range = session.renderSettings.range;
  const fps = session.renderSettings.outputFps;
  const totalFrames = session.frames;
  const duration = totalFrames / fps;
  const support = session.encoderSupport;
  // VN104: blank means "the default" (00:00:00:00 plus the in point; VN72's reference start
  // once it exists), and the note under the field says which label the file will carry.
  const typedStart = session.renderSettings.startTimecode ?? "";
  const startTimecode = resolveStartTimecode(typedStart, range.start, fps);
  const startValid = !("error" in startTimecode);
  const audioReady = !session.includeAudio || session.audioRequirement.kind === "none" ||
    (session.audioRequirement.kind === "required" && session.audioSupport?.supported === true);
  const soundtrackSummary = !session.includeAudio || session.audioRequirement.kind === "none"
    ? "video only"
    : session.audioRequirement.kind === "required"
      ? "video + stereo AAC"
      : "soundtrack unavailable";
  const progressPercent = session.progress.stage === "preroll"
    ? session.progress.totalPreRollFrames === 0
      ? 0
      : Math.round((100 * session.progress.completedPreRollFrames) / session.progress.totalPreRollFrames)
    : session.progress.stage === "audio"
    ? session.progress.totalAudioFrames === 0
      ? 0
      : Math.round((100 * session.progress.completedAudioFrames) / session.progress.totalAudioFrames)
    : session.progress.stage === "frames"
      ? session.progress.totalFrames === 0
        ? 0
        : Math.round((100 * session.progress.completedFrames) / session.progress.totalFrames)
      : session.progress.stage === "video"
        ? 100
        : null;
  const progressText = session.progress.stage === "preroll"
    ? `Preparing timeline · ${String(session.progress.completedPreRollFrames)} / ${String(session.progress.totalPreRollFrames)} frames (${String(progressPercent)}%)`
    : session.progress.stage === "frames"
    ? `${String(session.progress.completedFrames)} / ${String(session.progress.totalFrames)} frames (${String(progressPercent)}%)`
    : session.progress.stage === "video"
      ? `Finishing video encoding · ${String(session.progress.totalFrames)} frames collected`
      : session.progress.stage === "audio"
        ? `Encoding audio · ${String(session.progress.completedAudioFrames)} / ${String(session.progress.totalAudioFrames)} samples (${String(progressPercent)}%)`
        : session.progress.stage === "finalizing"
          ? "Finalizing movie…"
          : "Saving movie…";
  const canRender = !session.rendering && session.frames > 0 && session.outputReady &&
    support?.supported === true && audioReady && startValid;
  const performanceText = session.progress.stage === "frames" && session.recentFramesPerSecond !== null
    ? `Elapsed ${(session.elapsedMilliseconds / 1000).toFixed(1)} s · recent ${session.recentFramesPerSecond.toFixed(1)} frames/s`
    : `Elapsed ${(session.elapsedMilliseconds / 1000).toFixed(1)} s`;

  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next && session.rendering) return;
        onOpenChange(next);
      }}
    >
      <DialogContent data-testid="render-video-dialog" aria-describedby="render-video-description">
        <DialogTitle>Render video</DialogTitle>
        <DialogDescription id="render-video-description">
          Exact-frame H.264 MOV · timecode · slower than real time
        </DialogDescription>

        <div className={styles.body}>
          <section className={styles.group} aria-label="Video output">
            <div className={styles.row}>
              <span className={styles.label}>resolution</span>
              <ResolutionControl value={session.renderSettings.resolution} max={settings.limits.maxResolution}
                labelPrefix="render " disabled={session.rendering}
                onChange={(next) => session.setRenderSettings({ resolution: next })} />
            </div>
            <div className={styles.row}>
              <span className={styles.label}>frame rate</span>
              <div className={styles.scalar}>
                <NumberField
                  disabled={session.rendering}
                  label="render fps"
                  value={shown("fps", fps)}
                  spec={FPS_SPEC}
                  onChange={commitOnly("fps", (next) => session.setRenderSettings({ outputFps: next }))}
                />
              </div>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>output frames</span>
              <div className={styles.pair}>
                <NumberField
                  disabled={session.rendering}
                  label="render range in"
                  value={shown("start", range.start)}
                  spec={rangeSpec(range.end - 1)}
                  onChange={commitOnly("start", (next) =>
                    session.setRenderSettings({ range: { start: next, end: range.end } }))}
                />
                <NumberField
                  disabled={session.rendering}
                  label="render range out"
                  value={shown("end", range.end)}
                  spec={rangeSpec(frameRangeLimit(fps), range.start + 1)}
                  onChange={commitOnly("end", (next) =>
                    session.setRenderSettings({ range: { start: range.start, end: next } }))}
                />
              </div>
            </div>
            <div className={styles.row}>
              <span className={styles.label}>start timecode</span>
              <div className={styles.scalar}>
                <TextField
                  label="Start timecode"
                  describedBy="render-start-timecode-note"
                  disabled={session.rendering}
                  value={typedStart}
                  onChange={(next) => session.setRenderSettings({ startTimecode: next.trim() === "" ? undefined : next.trim() })}
                />
              </div>
            </div>
            <p className={styles.note} id="render-start-timecode-note" role={startValid ? undefined : "alert"}>
              {"error" in startTimecode
                ? `Start timecode: ${startTimecode.error}`
                : `File starts at ${startTimecode.label}${typedStart === "" ? " (00:00:00:00 + in point)" : ""}${startTimecode.dropFrame ? " · drop-frame" : ""}`}
            </p>
            {/*
              VN71 — a take starts AT its in point from cleared temporal state, so a feedback
              trail or a simulation begins there. This many project frames are played first and
              not recorded, when the user wants the take to open on a built-up state. 0 by
              default: nothing pre-rolls unless asked.
            */}
            <div className={styles.row}>
              <span className={styles.label}>pre-roll frames</span>
              <NumberField
                disabled={session.rendering}
                label="render pre-roll frames"
                value={shown("preRoll", session.renderSettings.preRollFrames ?? 0)}
                spec={rangeSpec(frameRangeLimit(projectFps(settings)))}
                onChange={commitOnly("preRoll", (next) => session.setRenderSettings({ preRollFrames: next }))}
              />
            </div>
          </section>

          <section className={styles.group} aria-label="Soundtrack">
          <div className={styles.row}>
            <span className={styles.label}>include audio</span>
            <BooleanField label="Include audio" value={session.includeAudio}
              disabled={session.rendering || session.audioRequirement.kind === "none"}
              onChange={next => session.setIncludeAudio(next)} />
          </div>
          <p className={styles.note}>
            Soundtrack: one locked Audio File In · stereo AAC · 48 kHz
          </p>
          </section>

          <section className={styles.status} aria-label="Encoder status">
          <div className={styles.summary}>
            {totalFrames} frames · {duration.toFixed(2)} s · {soundtrackSummary}
          </div>
          <div className={styles.support}>
            {session.audioRequirement.kind === "none"
              ? "Audio: no soundtrack source"
              : !session.includeAudio
                ? "Audio excluded · video only"
              : session.audioRequirement.kind === "invalid"
                ? `Audio unavailable: ${session.audioRequirement.reason}`
                : session.audioSupport === null
                  ? "Checking stereo AAC soundtrack support…"
                  : session.audioSupport.supported
                    ? `AAC ready (${session.audioSupport.codec} · stereo · 48 kHz)`
                    : `AAC unavailable: ${session.audioSupport.reason ?? "unsupported configuration"}`}
          </div>

          <div className={styles.support} data-supported={support?.supported ?? false}>
            {support === null
              ? "Checking H.264 support…"
              : support.supported
                ? `H.264 ready (${support.codec})`
                : `H.264 unavailable: ${support.reason ?? "unsupported configuration"}`}
            {support?.supported === true && !session.outputReady ? " · applying render resolution…" : ""}
          </div>

          </section>

          {session.rendering ? (
            <div className={styles.progressBlock}>
              <div
                className={styles.progressTrack}
                role="progressbar"
                aria-label="Video render progress"
                aria-valuemin={0}
                {...(progressPercent === null ? {} : {
                  "aria-valuemax": 100,
                  "aria-valuenow": progressPercent,
                })}
              >
                <ShareFill className={styles.progressFill} end={(progressPercent ?? 100) / 100} />
              </div>
              <span className={styles.progressText}>
                {progressText}
              </span>
              <span className={styles.progressText}>
                {performanceText}
              </span>
              <span className={styles.progressText}>
                Temporary storage · {(session.spooledBytes / (1024 * 1024)).toFixed(1)} MB
              </span>
            </div>
          ) : null}

        </div>

        <DialogFooter>
          {session.rendering ? (
            <Button variant="danger" size="md" disabled={session.cancelling || !session.cancelAvailable} onClick={session.cancel}>
              {session.cancelling ? "Cancelling…" : session.cancelAvailable ? "Cancel render" : "Saving…"}
            </Button>
          ) : (
            <>
              <Button variant="outline" size="md" onClick={() => onOpenChange(false)}>Close</Button>
              <Button size="md" disabled={!canRender} onClick={onRender}>Render video</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </DialogRoot>
  );
}
