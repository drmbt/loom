import { MARIGOLD_BUNDLE_ID, MARIGOLD_INPUT_SIDES, MARIGOLD_MODEL_ID } from "../domain/media/photo-depth-recipe.ts";

export interface NativePreparationCapability {
  readonly available: boolean;
  readonly reason?: string;
  readonly cached?: boolean;
  readonly bundleId?: string;
  readonly bytes?: number;
  readonly inputSides?: readonly (typeof MARIGOLD_INPUT_SIDES)[number][];
  readonly backend?: "mlx";
}

export interface NativePreparationRequest {
  readonly modelId: typeof MARIGOLD_MODEL_ID;
  readonly inputSide: (typeof MARIGOLD_INPUT_SIDES)[number];
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly rgba: ArrayBuffer;
}

export interface NativePreparationProgress {
  readonly phase?: string;
  readonly message: string;
  readonly fraction?: number;
}

export interface NativePreparationResult {
  readonly values: ArrayBuffer;
  readonly width: number;
  readonly height: number;
  readonly semantics: "relative-log";
}

interface DesktopPreparationBridge {
  probe(): Promise<unknown>;
  start(request: NativePreparationRequest): Promise<unknown>;
  status(id: string): Promise<unknown>;
  cancel(id: string): Promise<void>;
  close(id: string): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bridge(): DesktopPreparationBridge | undefined {
  const desktop = typeof window === "undefined" ? undefined : (window as Window & { loomDesktop?: unknown }).loomDesktop;
  if (desktop === undefined) return undefined;
  if (!record(desktop) || !record(desktop.preparation) ||
    ["probe", "start", "status", "cancel", "close"].some(key => typeof (desktop.preparation as Record<string, unknown>)[key] !== "function")) {
    throw new Error("The desktop native preparation bridge is incomplete or invalid. Restart an updated Loom desktop app.");
  }
  return desktop.preparation as unknown as DesktopPreparationBridge;
}

/** Bridge presence is a shell capability, never inferred from a user agent. */
export function hasNativePreparation(): boolean {
  return bridge() !== undefined;
}

/** Probing never starts a download or model process. */
export async function probeNativePreparation(): Promise<NativePreparationCapability> {
  const native = bridge();
  if (native === undefined) return { available: false, reason: "Marigold native preparation requires the Loom desktop app." };
  const value = await native.probe();
  if (!record(value) || typeof value.available !== "boolean") throw new Error("Invalid native preparation capability response.");
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length === 0))
    throw new Error("Invalid native preparation capability reason.");
  if (!value.available && value.reason === undefined) throw new Error("Unavailable native preparation must report its reason.");
  if (value.available || value.bundleId !== undefined) {
    if (value.bundleId !== MARIGOLD_BUNDLE_ID || value.backend !== "mlx" || typeof value.cached !== "boolean" ||
      typeof value.bytes !== "number" || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      !Array.isArray(value.inputSides) || value.inputSides.length === 0 ||
      value.inputSides.some(side => !MARIGOLD_INPUT_SIDES.includes(side)) ||
      new Set(value.inputSides).size !== value.inputSides.length)
      throw new Error("Invalid native preparation bundle, runtime or supported sizes.");
  }
  return value as unknown as NativePreparationCapability;
}

function validateRequest(request: NativePreparationRequest): void {
  const keys = ["modelId", "inputSide", "seed", "width", "height", "rgba"];
  if (!record(request) || Object.keys(request).length !== keys.length || keys.some(key => !Object.hasOwn(request, key)) ||
    request.modelId !== MARIGOLD_MODEL_ID || !MARIGOLD_INPUT_SIDES.includes(request.inputSide) ||
    !Number.isInteger(request.seed) || request.seed < 0 || request.seed > 0xffffffff ||
    ![request.width, request.height].every(size => Number.isInteger(size) && size >= 16 && size <= 1536 && size % 16 === 0) ||
    Math.max(request.width, request.height) !== request.inputSide || !(request.rgba instanceof ArrayBuffer) ||
    request.rgba.byteLength !== request.width * request.height * 4) throw new Error("Invalid native preparation request.");
}

function progressFor(value: unknown): NativePreparationProgress {
  if (!record(value) || typeof value.message !== "string" || value.message.length > 8192 ||
    (value.phase !== undefined && (typeof value.phase !== "string" || value.phase.length > 40)) ||
    (value.fraction !== undefined && (typeof value.fraction !== "number" || !Number.isFinite(value.fraction) || value.fraction < 0 || value.fraction > 1)))
    throw new Error("Invalid native preparation progress response.");
  return { message: value.message, ...(value.phase === undefined ? {} : { phase: value.phase as string }),
    ...(value.fraction === undefined ? {} : { fraction: value.fraction as number }) };
}

function resultFor(value: unknown, request: NativePreparationRequest): NativePreparationResult {
  if (!record(value) || value.width !== request.width || value.height !== request.height ||
    value.semantics !== "relative-log" || !(value.values instanceof ArrayBuffer) ||
    value.values.byteLength !== request.width * request.height * 4)
    throw new Error("Invalid native preparation float32 result.");
  for (const sample of new Float32Array(value.values)) {
    if (!Number.isFinite(sample)) throw new Error("Native preparation returned nonfinite float32 depth.");
  }
  return { width: request.width, height: request.height, semantics: "relative-log", values: value.values };
}

function untilAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    operation.then(value => { signal.removeEventListener("abort", abort); resolve(value); },
      error => { signal.removeEventListener("abort", abort); reject(error); });
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Own one retained IPC job through retirement; abort never publishes a late result. */
export async function runNativePreparation(request: NativePreparationRequest,
  onProgress: (progress: NativePreparationProgress) => void, signal: AbortSignal): Promise<NativePreparationResult> {
  signal.throwIfAborted();
  validateRequest(request);
  const native = bridge();
  if (native === undefined) throw new Error("Marigold native preparation requires the Loom desktop app.");
  let id: string | undefined;
  let result: NativePreparationResult | undefined;
  const errors: unknown[] = [];
  const retirementErrors: unknown[] = [];
  try {
    const started = await native.start(request);
    if (typeof started !== "string" || started.length === 0) throw new Error("Native preparation returned no owned job identifier.");
    id = started;
    signal.throwIfAborted();
    while (true) {
      const state = await untilAbort(native.status(id), signal);
      signal.throwIfAborted();
      if (!record(state)) throw new Error("Invalid native preparation status response.");
      if (state.kind === "complete") { result = resultFor(state.result, request); break; }
      if (state.kind === "failed") {
        if (typeof state.reason !== "string" || state.reason.length === 0) throw new Error("Native preparation failed without a diagnostic.");
        throw new Error(state.reason);
      }
      if (state.kind === "cancelled") throw new DOMException("Native preparation was cancelled.", "AbortError");
      if (state.kind !== "running") throw new Error("Unknown native preparation job state.");
      onProgress(progressFor(state.progress));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await untilAbort(new Promise<void>(resolve => { timer = setTimeout(resolve, 250); }), signal);
      } finally { clearTimeout(timer); }
    }
  } catch (error) { errors.push(error); }
  finally {
    if (id !== undefined) {
      if (result === undefined) {
        try { await native.cancel(id); } catch (error) { errors.push(error); retirementErrors.push(error); }
      }
      try { await native.close(id); } catch (error) { errors.push(error); retirementErrors.push(error); }
    }
  }
  if (retirementErrors.length > 0) {
    const diagnostic = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 1024);
    const reasons = retirementErrors.map(diagnostic).join("; ");
    const original = errors.length > retirementErrors.length ? ` Original failure: ${diagnostic(errors[0])}` : "";
    throw new AggregateError(errors, `Native preparation could not retire safely: ${reasons}.${original}`.slice(0, 4096));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Native preparation and retirement failed.");
  signal.throwIfAborted();
  if (result === undefined) throw new Error("Native preparation completed without depth.");
  return result;
}
