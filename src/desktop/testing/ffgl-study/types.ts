/**
 * VN91: the FFGL parity and cost harness — the contract every path into Loom implements.
 *
 * One harness renders the SAME input image, parameter set, time and BPM through each way of
 * bringing an FFGL effect into Loom, and compares them:
 *   (a) "resolume" — the plugin in Resolume Arena, captured over Syphon (the oracle, opt-in);
 *   (b) "native"   — Loom's native FFGL host (VN85, this lane);
 *   (c) "wasm"     — the browser WASM/WebGL2 host (VN84);
 *   (d) "port"     — a clean port to a Loom component (VN86);
 *   (e) "glsl"     — the GLSL/ISF code node (VN87).
 * A backend provides ONLY what is below; the harness owns the inputs, the schedules, the
 * comparisons, the cost statistics and the report, so every path is measured the same way.
 *
 * Images are RGBA8, TOP ROW FIRST, unpremultiplied as stored: what a picture looks like, not
 * how any one API lays it out. A backend whose surfaces are bottom-first (GL, Syphon) flips
 * on its way in and out.
 */
import type { FfglManifest } from "../../../nodes/definitions/ffgl-manifest.ts";

export type StudyBackendId = "resolume" | "native" | "wasm" | "port" | "glsl";

export interface StudyImage {
  readonly width: number;
  readonly height: number;
  /** RGBA8, top row first, width*height*4 bytes. */
  readonly rgba: Uint8Array;
}

/** A parameter value, addressed by the plugin's own parameter NAME (every backend can map a name). */
export type StudyValue = number | boolean | string;

/** One rendered frame of a run. */
export interface StudyStep {
  /** Host time in seconds — the plugin's clock where the backend can set it. */
  readonly time: number;
  readonly bpm: number;
  readonly barPhase: number;
  /** Writes before this frame, by FFGL parameter name. Unnamed parameters keep their value. */
  readonly params?: Readonly<Record<string, StudyValue>>;
  /** Event parameters raised for this frame only. */
  readonly pulses?: readonly string[];
  /** Replaces the run's input from this frame on (an animated input for a feedback effect). */
  readonly input?: StudyImage;
}

export interface StudyRun {
  readonly input: StudyImage;
  readonly steps: readonly StudyStep[];
  /** Which frames come back: every step, or the last only. */
  readonly capture: "each" | "last";
}

export interface StudyFrameCost {
  /** Host-side wall time for the frame, in ms (the harness's own measurement scope). */
  readonly cpuMs: number;
  /** GPU time where the backend can measure it (GL_TIME_ELAPSED, timestamp queries). */
  readonly gpuMs?: number;
  /** Each GPU copy or API crossing the frame took, in order, named. */
  readonly hops: readonly string[];
}

export interface StudyRegion { readonly x: number; readonly y: number; readonly width: number; readonly height: number }

export interface StudyResult {
  /** Full-size frames. With `coverage`, only those regions hold captured pixels (the rest is zero). */
  readonly frames: readonly StudyImage[];
  readonly costs: readonly StudyFrameCost[];
  /** Set by a backend that can capture only parts of a frame (Resolume's native-pixel crops). */
  readonly coverage?: readonly StudyRegion[];
  /**
   * What the plugin was actually given, where that differs from the run's input (Arena
   * re-encodes a still image on import). Over `coverage` only. The harness re-runs the other
   * backends on THIS input, so a comparison measures the plugin, not the import.
   */
  readonly inputSeen?: StudyImage;
}

/** A parameter as a host PRESENTS it (Resolume collapses an HSBA quad into one colour, truncates names). */
export interface StudyControl {
  readonly label: string;
  readonly kind: "float" | "integer" | "toggle" | "pulse" | "menu" | "color" | "text" | "other";
  readonly min?: number;
  readonly max?: number;
  /** Number of menu options. */
  readonly options?: number;
}

export interface StudyCapabilities {
  /** "host": the plugin reads the step's time. "wallclock": its own clock (not reproducible). */
  readonly clock: "host" | "wallclock" | "none";
  /** Same run twice gives the same bytes. */
  readonly deterministic: boolean;
  readonly gpuTiming: boolean;
  /** The plugin sees the input bytes unchanged (no scaling, colour management or compression). */
  readonly exactInput: boolean;
}

export interface LoadedStudyEffect {
  /** The plugin's raw FFGL table, where this backend can read it (Resolume cannot). */
  readonly manifest?: FfglManifest;
  /** The controls this backend presents, for parameter-map parity across every host. */
  readonly controls: readonly StudyControl[];
  /** Load and instantiate, measured by the backend around its own load path. */
  readonly loadMs: number;
  readonly capabilities: StudyCapabilities;
  render(run: StudyRun): Promise<StudyResult>;
  dispose(): Promise<void>;
}

export interface FfglStudyBackend {
  readonly id: StudyBackendId;
  readonly label: string;
  /** Whether this machine can run the backend now, and if not, why. Never throws. */
  available(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Loads the named plugin (bundle name, e.g. "VignettePlus") at a fixed frame size. */
  load(plugin: string, size: { readonly width: number; readonly height: number }): Promise<LoadedStudyEffect>;
  dispose(): Promise<void>;
}
