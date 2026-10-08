import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { absTimeSecondsOf } from "@domain/types/frame.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { ffglControls, ffglParameterWrites, parseFfglManifest, type FfglControl, type FfglControlValue } from "@nodes/definitions/ffgl-manifest.ts";
import { ffglSourceIdFor } from "@nodes/definitions/ffgl.ts";
import { createNativeFfglSource, desktopFfglBridge, manifestFromDescription, type DesktopFfglBridge, type FfglFrameRequest } from "@devices/native-ffgl.ts";

/**
 * VN85: every `ffgl` node's native plugin instance, owned and scheduled — the native-vision-
 * sources.ts shape (person mask's native path), for a plugin instead of a model.
 *
 * Per frame: the node's resolved parameters become FFGL writes (ffgl-manifest.ts, the one
 * mapping), the frame's abs time becomes the plugin's clock (the host keeps it monotonic and
 * steps one interval across a seek), and an event pulse (runtime.ffglEvent) is raised for one
 * frame. Realtime frames run without waiting (the result is a frame or more late); any other
 * mode settles each frame before it is read, so an offline take is exact.
 *
 * Manifests: a node whose `plugin` names a plugin its stored table does not describe is probed
 * once and `onManifest` is called with the table to store (the hook writes it through the bus as
 * a system actor). Until then the plugin runs on its own defaults.
 */
export interface FfglTarget {
  readonly nodeId: string;
  readonly plugin: string;
  /** The node's stored manifest text ("" when none). */
  readonly manifest: string;
  readonly size: readonly [number, number];
  /** The node's input copy, when its input is wired. */
  readonly inputResourceId?: string;
  /** The node's parameters at a frame, display-space values (ResolvedParameter.value). */
  read(frame: FrameEvaluationInput | undefined): { readonly bpm: number; value(key: string): FfglControlValue | undefined };
}

type Source = ReturnType<typeof createNativeFfglSource>;
interface Entry {
  target: FfglTarget;
  controls: readonly FfglControl[];
  source?: Source;
  unregister?: () => void;
  initialized: boolean;
  error?: string;
  pending?: Promise<void>;
  frame?: number;
  pulses: Set<number>;
  probing?: boolean;
}

export function ffglFrameRequest(frame: FrameEvaluationInput, bpm: number, writes: FfglFrameRequest["parameters"], pulses: readonly number[]): FfglFrameRequest {
  const time = absTimeSecondsOf(frame);
  const beats = (time * bpm) / 60;
  return {
    time, bpm, barPhase: beats / 4 - Math.floor(beats / 4),
    interval: frame.deltaSeconds > 0 && frame.deltaSeconds <= 1 ? frame.deltaSeconds : 1 / 60,
    // A non-realtime take starts its own clock (the host's reset rule); live play never resets.
    ...(frame.mode !== "realtime" && frame.frameIndex === 0 ? { reset: true } : {}),
    parameters: writes, pulses,
  };
}

function controlsOf(manifest: string): FfglControl[] {
  if (!manifest) return [];
  try { return ffglControls(parseFfglManifest(JSON.parse(manifest))); } catch { return []; }
}

export function createNativeFfglSources(options: {
  bridge?: () => DesktopFfglBridge | undefined;
  /** Stores a probed manifest on the node. Absent: the plugin still runs, on its defaults. */
  onManifest?: (nodeId: string, manifest: string) => void;
} = {}) {
  const bridgeOf = options.bridge ?? desktopFfglBridge;
  let backend: LoomBackend | null = null;
  let latest: FrameEvaluationInput | undefined;
  const entries = new Map<string, Entry>();
  const retire = (entry: Entry) => { entry.unregister?.(); void entry.source?.close(); };
  const dispose = () => { for (const entry of entries.values()) retire(entry); entries.clear(); };

  const request = (entry: Entry, frame: FrameEvaluationInput): FfglFrameRequest => {
    const values = entry.target.read(frame);
    const pulses = [...entry.pulses];
    entry.pulses.clear();
    return ffglFrameRequest(frame, values.bpm, ffglParameterWrites(entry.controls, key => values.value(key)), pulses);
  };
  const run = (entry: Entry, frame: FrameEvaluationInput) => {
    if (entry.error) return Promise.reject(new Error(entry.error));
    if (!entry.source) return Promise.reject(new Error("Native FFGL source is unavailable"));
    const pending = entry.source.run(request(entry, frame)).then(() => { entry.frame = frame.frameIndex; })
      .catch(error => { entry.error = String(error); throw error; })
      .finally(() => { if (entry.pending === pending) delete entry.pending; });
    entry.pending = pending;
    return pending;
  };
  const probe = (entry: Entry, bridge: DesktopFfglBridge) => {
    if (!options.onManifest || entry.probing) return;
    entry.probing = true;
    void bridge.describe(entry.target.plugin).then(description => {
      const manifest = manifestFromDescription(description);
      if (manifest !== entry.target.manifest) options.onManifest?.(entry.target.nodeId, manifest);
    }, error => { entry.error = `Cannot load FFGL plugin ${entry.target.plugin}: ${String(error)}`; });
  };

  return {
    track(next: readonly FfglTarget[], attached: LoomBackend | null) {
      if (attached !== backend) { dispose(); backend = attached; }
      const wanted = new Map(next.map(target => [target.nodeId, target]));
      for (const [id, entry] of entries) {
        const target = wanted.get(id);
        const same = target && target.plugin === entry.target.plugin && target.size[0] === entry.target.size[0] &&
          target.size[1] === entry.target.size[1] && target.inputResourceId === entry.target.inputResourceId;
        if (same) { entry.target = target; entry.controls = controlsOf(target.manifest); continue; }
        retire(entry); entries.delete(id);
      }
      for (const target of next) {
        if (entries.has(target.nodeId)) continue;
        const entry: Entry = { target, controls: controlsOf(target.manifest), initialized: false, pulses: new Set() };
        entries.set(target.nodeId, entry);
        const bridge = bridgeOf();
        if (!backend || !bridge) { entry.error = "The FFGL node runs in the Apple Silicon desktop app; no other host is substituted."; continue; }
        if (!target.plugin) { entry.error = "Set Plugin to an FFGL bundle name from the plugin folders."; continue; }
        try {
          const source = createNativeFfglSource(backend, bridge, { plugin: target.plugin, size: target.size,
            ...(target.inputResourceId === undefined ? {} : { inputResourceId: target.inputResourceId }) });
          entry.source = source;
          // Transparent until the first result, in the declared rgba8 format: initial state only.
          let empty: Uint8Array | undefined = new Uint8Array(target.size[0] * target.size[1] * 4);
          entry.unregister = backend.registerMediaSource(ffglSourceIdFor(target.nodeId), {
            currentFrame: () => {
              const frame = source.source.currentFrame();
              if (frame) { empty = undefined; return frame; }
              return empty ? { frameId: 0, bytes: empty } : undefined;
            },
          });
          void source.ready.then(() => {
            entry.initialized = true;
            const description = source.description;
            if (description && manifestFromDescription(description) !== target.manifest) probe(entry, bridge);
          }, error => { entry.error = String(error); });
        } catch (error) { entry.error = String(error); }
      }
    },
    /** `runtime.ffglEvent`: raise the event parameter at this FFGL index on these nodes for their next frame. */
    fire(nodeIds: readonly string[], event: number): number {
      let raised = 0;
      for (const id of nodeIds) {
        const entry = entries.get(id);
        const control = entry?.controls.find(c => c.kind === "pulse" && c.index === event);
        if (!entry || control?.kind !== "pulse") continue;
        entry.pulses.add(control.index); raised++;
      }
      return raised;
    },
    observe(frame: FrameEvaluationInput) {
      latest = frame;
      if (frame.mode !== "realtime") return;
      queueMicrotask(() => {
        for (const entry of entries.values()) {
          if (entry.error || entry.pending || !entry.initialized || !entry.source?.available) continue;
          void run(entry, frame).catch(() => undefined);
        }
      });
    },
    async settle(frameIndex: number) {
      if (!entries.size) return;
      if (!latest || latest.frameIndex !== frameIndex) throw new Error("Native FFGL settle requires the rendered frame input");
      const frame = latest;
      const settled = await Promise.allSettled([...entries.values()].filter(entry => !entry.error).map(async entry => {
        await entry.source?.ready;
        if (entry.pending) await entry.pending.catch(() => undefined);
        if (entry.frame !== frameIndex) await run(entry, frame);
      }));
      const failed = settled.find(result => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
    diagnostics(): RuntimeDiagnostic[] {
      return [...entries.values()].filter(entry => entry.error || !entry.initialized).map(entry => ({
        severity: "warning", code: entry.error ? "ffgl.native.refused" : "ffgl.native.starting",
        message: entry.error ?? `Loading FFGL plugin ${entry.target.plugin}; no result yet.`, nodeId: entry.target.nodeId,
      }));
    },
    dispose,
    async drain() {
      const closing = [...entries.values()].map(entry => entry.source?.close());
      dispose();
      await Promise.all(closing);
    },
  };
}
