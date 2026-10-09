/**
 * VN100 — THE PART OF LTC-LAB'S PROJECT SHAPE THE IMPORTER READS.
 *
 * Copied, trimmed, from ltc-lab `src/types.ts` (read-only source, ../ltc-lab). Times are
 * SECONDS into the track's audio file; keyframe values are normalized 0..1 and a lane's
 * `min`/`max` map them to the OSC range, the same model Loom's automation lanes use.
 * Fields the importer only reports on are typed loosely (`unknown`), because their shape
 * is ltc-lab's to change.
 */

export interface LtcBezierHandle {
  /** seconds offset from the keyframe time (out ≥ 0, in ≤ 0) */
  readonly dt: number;
  /** normalized value offset */
  readonly dv: number;
}

export interface LtcKeyframe {
  readonly id?: string;
  readonly time: number;
  readonly value: number;
  readonly out?: LtcBezierHandle;
  readonly in?: LtcBezierHandle;
}

export interface LtcEnvelopeADSR {
  readonly attackMs: number;
  readonly decayMs: number;
  readonly sustain: number;
  readonly releaseMs: number;
}

export interface LtcTriggerOpts {
  readonly quantize?: { readonly division: 4 | 8 | 16; readonly toleranceMs: number } | null;
  readonly refractoryMs?: number;
  readonly velocity?: "detected" | "fixed" | "accent";
  readonly retrigger?: "layer" | "restart";
}

export type LtcCurve = "linear" | "exp" | "smooth";

export type LtcFigureShape = "sine" | "triangle" | "saw-up" | "saw-down" | "square" | "pulse" | "ease" | "random" | "drawn";

export interface LtcFigureSource {
  readonly kind: "figure";
  readonly shape: LtcFigureShape;
  readonly beats: number;
  readonly phase: number;
  readonly low: number;
  readonly high: number;
  readonly width?: number;
  readonly swing?: number;
  readonly points?: readonly (readonly [number, number])[];
  readonly range?: { readonly start: number; readonly end: number } | null;
  readonly seed?: number;
}

export type LtcLaneSource =
  | { readonly kind: "manual" }
  | {
      readonly kind: "onsets";
      readonly onsetKind?: string;
      readonly adsr: LtcEnvelopeADSR;
      readonly hits?: readonly (readonly [number, number])[];
      readonly curve?: LtcCurve;
      readonly triggers?: LtcTriggerOpts;
    }
  | {
      readonly kind: "level";
      readonly level?: string;
      readonly samples?: { readonly rate: number; readonly values: readonly number[] };
    }
  | LtcFigureSource;

export interface LtcLane {
  readonly id: string;
  readonly address: string;
  readonly min: number;
  readonly max: number;
  readonly color?: string;
  readonly enabled?: boolean;
  readonly keyframes: readonly LtcKeyframe[];
  readonly midi?: { readonly channel: number; readonly cc: number } | null;
  readonly source?: LtcLaneSource | null;
  readonly range?: { readonly start: number; readonly end: number } | null;
}

export interface LtcCueAction {
  readonly kind: string;
  readonly enabled?: boolean;
  readonly label?: string;
}

export interface LtcMarker {
  readonly id: string;
  readonly time: number;
  readonly text: string;
  readonly color?: string;
  readonly notes?: string;
  readonly segmentId?: string;
  readonly actions?: readonly LtcCueAction[];
}

export interface LtcGrid {
  readonly bpm: number;
  /** seconds into the file where bar 1 beat 1 falls */
  readonly anchor: number;
  readonly beatsPerBar: number;
  readonly locked?: boolean;
}

export interface LtcSong {
  readonly id: string;
  readonly title: string;
  readonly offset: number;
  readonly grid?: LtcGrid | null;
}

export interface LtcTrack {
  readonly id: string;
  readonly fileName: string;
  readonly videoPath?: string | null;
  readonly title: string;
  /** "HH:MM:SS:FF" non-drop at the project fps */
  readonly startTC: string;
  readonly durationSec: number | null;
  readonly notes?: string;
  readonly lanes: readonly LtcLane[];
  readonly markers: readonly LtcMarker[];
  readonly loop?: { readonly start: number; readonly end: number; readonly enabled: boolean } | null;
  readonly autoColumn?: { readonly enabled: boolean; readonly pattern: string | null };
  readonly autoBpm?: { readonly enabled: boolean; readonly bpm: number | null };
  readonly detectedBpm?: number | null;
  readonly grid?: LtcGrid | null;
  readonly segments?: readonly { readonly id: string; readonly label: string; readonly start: number; readonly end: number }[];
  readonly songs?: readonly LtcSong[];
}

export interface LtcProject {
  readonly fps: number;
  readonly tracks: readonly LtcTrack[];
}

export interface LtcTour {
  readonly name?: string;
  readonly audioDir?: string;
  readonly artist?: string;
}
