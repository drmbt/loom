import { useCallback, useSyncExternalStore } from "react";
import type { TelemetrySource } from "@runtime/telemetry/index.ts";
import { formatMs } from "./format-metrics.ts";

/** Live header timing from the telemetry hub, at its <= 10 Hz tick (§V16).
 * GPU uses the measured frame span; CPU uses the measured pass-encode sum.
 * Missing measurements stay absent, and neither value substitutes for the other (§V86).
 */
export function FrameMsReadout({ telemetry, metric = "gpu" }: { telemetry: TelemetrySource; metric?: "gpu" | "cpu" }) {
  const read = useCallback(() => {
    const snapshot = telemetry.snapshot();
    if (metric === "gpu") return snapshot.frame.gpuMs;
    if (!snapshot.cpuTimingAvailable || snapshot.categories.length === 0) return null;
    let total = 0;
    for (const row of snapshot.categories) {
      if (row.cpu.availability !== "measured" || row.cpu.ms === null) return null;
      total += row.cpu.ms;
    }
    return total;
  }, [metric, telemetry]);
  const ms = useSyncExternalStore(
    useCallback((listener: () => void) => telemetry.subscribe(listener), [telemetry]),
    read,
    read,
  );
  return <>{formatMs(ms)}</>;
}
