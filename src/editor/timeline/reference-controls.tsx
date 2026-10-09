import type { NodeId } from "@domain/types/ids.ts";
import type { ReferenceMedia } from "./use-reference-media.ts";
import styles from "./timeline-pane.module.css";

/**
 * VN64 — the reference media's toolbar group: which node it is (a picker that adopts any
 * movie or audio node), "media…" to pick a file, and "length" to set the project range
 * from the media. Drop a file on the pane to do the same as "media…".
 */
export function ReferenceControls({ media }: { media: ReferenceMedia }) {
  const { reference, candidates, peaks } = media;
  const status = peaks.kind === "loading" ? "decoding…" : peaks.kind === "failed" ? "no waveform" : null;
  return (
    <span className={styles.option} data-timeline-reference="">
      <select
        aria-label="reference media"
        value={reference?.nodeId ?? ""}
        title={reference === null ? "Drop a video or audio file here, or choose a node" : `${reference.name} is the reference`}
        onChange={(event) => {
          if (event.target.value !== "") media.adopt(event.target.value as NodeId);
        }}
      >
        <option value="">no reference</option>
        {candidates.map((candidate) => (
          <option key={candidate.nodeId} value={candidate.nodeId}>{candidate.name}</option>
        ))}
      </select>
      {status !== null && <span className={styles.notice} title={peaks.kind === "failed" ? peaks.message : undefined}>{status}</span>}
      <button type="button" className={styles.toggle} onClick={media.pickFile} title="Choose a video or audio file as the reference">
        media…
      </button>
      <button
        type="button"
        className={styles.toggle}
        disabled={peaks.kind !== "ready"}
        onClick={media.setLengthFromMedia}
        title="Set the project's length from the reference media"
      >
        length
      </button>
    </span>
  );
}
