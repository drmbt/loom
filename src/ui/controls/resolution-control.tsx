import { useState } from "react";
import { Button } from "../primitives/button.tsx";
import { NumberField } from "./number-field.tsx";
import { SwapDimensions } from "./swap-dimensions.tsx";
import type { EditPhase } from "./types.ts";
import styles from "./resolution-control.module.css";

type Resolution = { width: number; height: number };
const PRESETS = [
  { label: "720p", width: 1280, height: 720 },
  { label: "1080p", width: 1920, height: 1080 },
  { label: "1440p", width: 2560, height: 1440 },
  { label: "4K UHD", width: 3840, height: 2160 },
] as const;
const ASPECTS = [[16, 9], [4, 3], [1, 1], [21, 9]] as const;

/** Shared project/export dimensions. Orientation and aspect are derived from pixels. */
export function ResolutionControl({ value, max, labelPrefix = "", disabled = false, onChange }: {
  readonly value: Resolution;
  readonly max: number;
  readonly labelPrefix?: string;
  readonly disabled?: boolean;
  readonly onChange: (value: Resolution, label: string) => void;
}) {
  const [live, setLive] = useState<Partial<Resolution>>({});
  const commit = (next: Resolution, label: string) => {
    setLive({});
    onChange(next, label);
  };
  const dimension = (key: keyof Resolution) => (next: number, phase: EditPhase) => {
    if (phase === "live") setLive(previous => ({ ...previous, [key]: next }));
    else commit({ ...value, [key]: next }, `Set output ${key}`);
  };
  const portrait = value.width < value.height;
  const longEdge = Math.max(value.width, value.height);
  const shortEdge = Math.min(value.width, value.height);
  return <div className={styles.root}>
    <div className={styles.dimensions}>
      {(["width", "height"] as const).map(key => <NumberField
        key={key}
        label={`${labelPrefix}${key}`}
        value={live[key] ?? value[key]}
        spec={{ min: 1, max, step: 1, precision: 0 }}
        showPrecisionSelector={false}
        unit="px"
        disabled={disabled}
        onChange={dimension(key)}
      />)}
      <SwapDimensions width={value.width} height={value.height} disabled={disabled}
        onSwap={next => commit(next, "Swap output orientation")} />
    </div>
    <div className={styles.buttons} aria-label="Resolution presets">
      {PRESETS.map(preset => {
        const next = portrait ? { width: preset.height, height: preset.width } : { width: preset.width, height: preset.height };
        return <Button key={preset.label} variant="outline" disabled={disabled || preset.width > max}
          aria-pressed={value.width === next.width && value.height === next.height}
          onClick={() => commit(next, `Set output resolution to ${preset.label}`)}>{preset.label}</Button>;
      })}
    </div>
    <div className={styles.buttons} aria-label="Aspect ratio">
      {ASPECTS.map(([wide, high]) => {
        const short = wide === high ? longEdge : Math.min(longEdge, Math.max(1, Math.round(longEdge * high / wide / 2) * 2));
        const next = portrait ? { width: short, height: longEdge } : { width: longEdge, height: short };
        const label = `${wide}:${high}`;
        return <Button key={label} variant="outline" disabled={disabled}
          aria-pressed={Math.abs(shortEdge - short) < 1}
          title={`Set ${label} aspect ratio; preserve the long edge`}
          onClick={() => commit(next, `Set output aspect ratio to ${label}`)}>{label}</Button>;
      })}
    </div>
  </div>;
}
