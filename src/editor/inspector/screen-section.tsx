import type { NodeId } from "@domain/types/ids.ts";
import type { ScreenCaptureWiring } from "@/app/use-screen-sources.ts";
import { ControlRow } from "@ui/controls/control-row.tsx";
import { Button } from "@ui/primitives/button.tsx";
import styles from "./inspector.module.css";

/** Capture belongs to the live session; opening the inspector never opens a picker. */
export function ScreenSection({ nodeId, capture }: { nodeId: NodeId; capture: ScreenCaptureWiring }) {
  const status = capture.statuses[nodeId];
  const phase = status?.phase ?? "idle";
  const sharing = phase === "sharing";
  const choosing = phase === "choosing";
  const text = {
    idle: "Not sharing",
    choosing: status?.label === undefined
      ? "Choose a tab, window or screen in your browser"
      : `Sharing ${status.label} · choose another source in your browser`,
    sharing: status?.label === undefined ? "Sharing" : `Sharing ${status.label}`,
    ended: "Sharing ended",
    error: "Screen sharing failed",
  }[phase];
  const action = {
    idle: "Share tab/window",
    choosing: "Choosing…",
    sharing: "Share another",
    ended: "Share again",
    error: "Retry sharing",
  }[phase];

  return (
    <section className={styles.section} aria-label="Screen In">
      <div className={styles.sectionHeader}>
        <span>Screen In</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>
      <div className={styles.statusLine} role="status" data-screen-status={phase}>
        {text}
      </div>
      {status?.message === undefined ? null : (
        <span className={styles.statusHint} role={phase === "error" ? "alert" : "status"}>
          {status.message}
        </span>
      )}
      <ControlRow label="Source">
        {/* Keep start on the click stack: the browser picker requires user activation. */}
        <Button variant="outline" disabled={choosing} onClick={() => void capture.start(nodeId)}>
          {action}
        </Button>
      </ControlRow>
      {sharing || choosing ? (
        <ControlRow label="Sharing">
          <Button variant="outline" onClick={() => capture.stop(nodeId)}>Stop sharing</Button>
        </ControlRow>
      ) : null}
    </section>
  );
}
