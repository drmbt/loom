import { useRef, type PointerEvent } from "react";
import { DEFAULT_IMAGE_FRAMING, imagePlacement, type ImageFraming } from "@domain/media/image-framing.ts";
import { Button } from "@ui/primitives/button.tsx";
import styles from "./photo-mapping-host.module.css";

interface ImageSize { readonly width: number; readonly height: number }
export interface PhotoPreviewCropProps {
  readonly source: ImageSize;
  readonly target: ImageSize;
  readonly url: string;
  readonly fit: "fit" | "fill" | "stretch";
  readonly value: ImageFraming;
  readonly onChange: (value: ImageFraming) => void;
  readonly disabled?: boolean;
}

const bounded = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));

/** A controlled crop guide; changing its framing never edits pixels or runs models. */
export function PhotoPreviewCrop({ source, target, url, fit, value, onChange, disabled = false }: PhotoPreviewCropProps) {
  const placement = imagePlacement(source, target, fit, value);
  const controls = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; value: ImageFraming;
    width: number; height: number; travelX: number; travelY: number } | null>(null);
  const update = (next: ImageFraming) => {
    if (!disabled && (next.x !== value.x || next.y !== value.y || next.zoom !== value.zoom)) onChange(next);
  };
  const move = (event: PointerEvent<HTMLDivElement>) => {
    const drag = gesture.current;
    if (disabled || drag === null || drag.id !== event.pointerId) return;
    const x = drag.travelX === 0 ? drag.value.x : bounded(drag.value.x + (event.clientX - drag.x) / drag.width * source.width / drag.travelX, 0, 1);
    const y = drag.travelY === 0 ? drag.value.y : bounded(drag.value.y + (event.clientY - drag.y) / drag.height * source.height / drag.travelY, 0, 1);
    update({ ...drag.value, x, y });
  };
  return <div ref={controls} className={styles.cropControls} role="group" aria-label="Preview crop controls"
    tabIndex={disabled ? -1 : 0} aria-disabled={disabled}
    onKeyDown={event => {
      if (disabled || event.target !== event.currentTarget) return;
      const step = event.shiftKey ? 0.1 : 0.01;
      const arrows: Record<string, readonly [number, number]> = {
        ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step],
      };
      const movement = arrows[event.key];
      if (movement !== undefined) {
        event.preventDefault(); update({ ...value, x: bounded(value.x + movement[0], 0, 1), y: bounded(value.y + movement[1], 0, 1) });
      } else if (["+", "=", "-"].includes(event.key)) {
        event.preventDefault(); update({ ...value, zoom: bounded(value.zoom + (event.key === "-" ? -0.05 : 0.05), 1, 8) });
      }
    }}>
    <div className={`${styles.framingGuide} ${styles.cropViewport}`} role="img" aria-label="Preview framing guide"
      style={{ aspectRatio: `${source.width} / ${source.height}`, maxWidth: `${140 * source.width / source.height}px` }}
      onPointerDown={event => {
        if (disabled || event.button !== 0) return;
        controls.current?.focus();
        const rect = event.currentTarget.getBoundingClientRect();
        const travelX = Math.max(0, source.width - placement.source.width);
        const travelY = Math.max(0, source.height - placement.source.height);
        if (rect.width <= 0 || rect.height <= 0 || (travelX === 0 && travelY === 0)) return;
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
        gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY,
          value: { ...value }, width: rect.width, height: rect.height, travelX, travelY };
      }}
      onPointerMove={move}
      onPointerUp={event => {
        if (gesture.current?.id !== event.pointerId) return;
        move(event); gesture.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { gesture.current = null; }} onLostPointerCapture={() => { gesture.current = null; }}>
      <img src={url} alt="Full preview photograph" draggable={false} />
      <svg className={styles.cropGuide} viewBox={`0 0 ${source.width} ${source.height}`} preserveAspectRatio="none" aria-hidden="true">
        <rect x={placement.source.x} y={placement.source.y} width={placement.source.width} height={placement.source.height} vectorEffect="non-scaling-stroke" />
      </svg>
    </div>
    <label>Zoom <input aria-label="Preview crop zoom" type="range" min={1} max={8} step={0.05} value={value.zoom}
      disabled={disabled} onChange={event => update({ ...value, zoom: Number(event.target.value) })} /><output>{value.zoom.toFixed(2)}×</output></label>
    <label>Horizontal <input aria-label="Preview crop horizontal position" type="range" min={0} max={1} step={0.01} value={value.x}
      disabled={disabled} onChange={event => update({ ...value, x: Number(event.target.value) })} /></label>
    <label>Vertical <input aria-label="Preview crop vertical position" type="range" min={0} max={1} step={0.01} value={value.y}
      disabled={disabled} onChange={event => update({ ...value, y: Number(event.target.value) })} /></label>
    <Button variant="outline" disabled={disabled} onClick={() => update({ ...DEFAULT_IMAGE_FRAMING })}>Reset preview crop</Button>
    <p className={styles.hint}>Drag the outlined crop, or focus these controls and use arrow keys. Shift moves faster; + and − zoom.</p>
  </div>;
}
