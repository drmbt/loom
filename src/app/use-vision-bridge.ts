import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { parameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import type { LiveParameterReads } from "@domain/parameters/index.ts";
import type { FlatGraph, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { absTimeSecondsOf } from "@domain/types/frame.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import {
  createInferenceSources,
  inferenceSourceIdFor,
  type InferenceEntry,
} from "@runtime/execution/inference-sources.ts";
import {
  PERSON_MASK_INPUT_KEY,
  PERSON_MASK_INPUT_SIDE,
  PERSON_MASK_RESULT_KEY,
} from "@nodes/definitions/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { DeviceClient } from "@devices/device-client.ts";
import { DEVICE_HELPER_COMMAND, DEVICE_HELPER_NAME, DEVICE_HELPER_START } from "@devices/helper.ts";
import { createNativeVisionSources, type NativeVisionTarget } from "./native-vision-sources.ts";
import { z } from "zod";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import { nodeIdsInput } from "@domain/commands/input-schema.ts";
import { FFGL_EVENT_COMMAND, FFGL_INPUT_KEY, FFGL_RESULT_KEY, FFGL_TYPE_NAME } from "@nodes/definitions/ffgl.ts";
import { createNativeFfglSources, type FfglTarget } from "./native-ffgl-sources.ts";

declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** VN85: raise an FFGL event parameter (Recall, Keyframe, PaletteFlip …) on these nodes for their next frame. */
    "runtime.ffglEvent": { input: { nodeIds: readonly string[]; event: number }; output: { raised: number } };
  }
}

/**
 * T1029 — the Person Mask node's CPU half: Apple Vision over the device bridge,
 * riding the SAME seam every model node rides (`createInferenceSources`). The fill
 * policies, staleness ages, per-node rate limit, identity fallback and the coverage
 * channel all come from the seam unchanged; the only thing this hook owns is the
 * RUNNER — a bridge round trip where the model nodes have a worker message.
 *
 * ## No-fire and degrade, by mechanism per path (§V840's discipline, §T715's rule)
 *
 *  - headless renders, takes on other machines, every gate: no React tree, no hook,
 *    nothing is ever asked;
 *  - live session, no helper: the runner rejects with the client's own sentence, the
 *    seam serves the identity fallback (zero mask — nobody), and the diagnostic below
 *    says what to do (§T948's copy rule);
 *  - helper attached, non-mac / no toolchain / worker died: the DOOR's refusal arrives
 *    as the run's failure, surfaced per node through the seam's failure channel — the
 *    same surface a failed model download uses (B156).
 *
 * ## §V856, answered from birth rather than after three reports
 *
 * The mask's neutral output is also its correct output — zero everywhere is both "no
 * helper" and "nobody in frame". So every entry supplies `coverage` (fraction of mask
 * above half), published on the node's `<name>:coverage` channel by the seam: "ran and
 * found nothing" reads coverage 0 WITH a result age, "did not run" reads no age and a
 * failure sentence. Four states, three distinguishable surfaces.
 */

const SIDE = PERSON_MASK_INPUT_SIDE;

/** Planner texels (vec4f floats) → the wire's RGBA8, base64. Length follows the input. */
export function texelsToRgbaBase64(texels: Float32Array): string {
  const bytes = new Uint8Array(texels.length);
  for (let at = 0; at < bytes.length; at += 1) {
    const value = texels[at] ?? 0;
    bytes[at] = Math.max(0, Math.min(255, Math.round(value * 255)));
  }
  let ascii = "";
  const CHUNK = 0x8000;
  for (let at = 0; at < bytes.length; at += CHUNK) {
    ascii += String.fromCharCode(...bytes.subarray(at, at + CHUNK));
  }
  return btoa(ascii);
}

/**
 * The helper's mask (u8, its own aspect-preserving size) → the node's r32float plane
 * at the output resolution, nearest-neighbour. The mask came from the LETTERBOXED
 * square the preprocess produced, so the letterbox is undone here: only the centred
 * band of the mask corresponds to the picture, exactly the inverse of the preprocess's
 * placement. GPU cannot do this walk — the external texture is output-sized by
 * contract — so it runs here, bounded by the node's rate limit.
 */
export function maskToFloats(
  mask: Uint8Array,
  maskWidth: number,
  maskHeight: number,
  outWidth: number,
  outHeight: number,
): Float32Array {
  const out = new Float32Array(outWidth * outHeight);
  // The preprocess letterboxes the picture into the square preserving aspect; Vision
  // then keeps that aspect. Recover the band of the mask the picture actually occupies.
  const aspect = outWidth / outHeight;
  let bandW = maskWidth;
  let bandH = maskHeight;
  const maskAspect = maskWidth / maskHeight;
  if (aspect > maskAspect) {
    bandH = Math.max(1, Math.round(maskWidth / aspect));
  } else if (aspect < maskAspect) {
    bandW = Math.max(1, Math.round(maskHeight * aspect));
  }
  const offX = (maskWidth - bandW) >> 1;
  const offY = (maskHeight - bandH) >> 1;
  for (let y = 0; y < outHeight; y += 1) {
    const sy = offY + Math.min(bandH - 1, Math.floor((y / outHeight) * bandH));
    const row = sy * maskWidth;
    const outRow = y * outWidth;
    for (let x = 0; x < outWidth; x += 1) {
      const sx = offX + Math.min(bandW - 1, Math.floor((x / outWidth) * bandW));
      out[outRow + x] = (mask[row + sx] ?? 0) / 255;
    }
  }
  return out;
}

/** §V856's scalar: the fraction of the mask that is confidently person. */
export function maskCoverage(bytes: Uint8Array): number {
  const floats = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (floats.length === 0) return 0;
  let lit = 0;
  for (const value of floats) if (value > 0.5) lit += 1;
  return lit / floats.length;
}

interface VisionTarget {
  readonly nodeId: string;
  readonly size: readonly [number, number];
  readonly minIntervalSeconds: number;
  readonly channel?: string;
}

/** What a Person Mask's own parameters are read with (T1525b) — see `useVisionBridge`'s options. */
interface VisionParameterReads extends LiveParameterReads {
  readonly registry: NodeRegistryView;
}

/**
 * T1525b — the node's Min interval at `frame`, through the one read path (§V61).
 *
 * It was read off the stored slot, so an expression on it did nothing and a bank fading it
 * reached the helper at its destination on the frame of the recall. No frame: what the
 * document says, an expression at the zero frame — `observe` re-reads it at every frame.
 */
function minIntervalAt(
  node: GraphNode,
  graph: FlatGraph,
  reads: VisionParameterReads,
  frame: FrameEvaluationInput | undefined,
): number {
  const { registry } = reads;
  const options = parameterReadOptions({ graph, registry, frame, channels: reads.channels(), flattening: reads.flattening() });
  const rate = resolveParameters(node, registry.get(node.type), options).get("rateLimit")?.value;
  return typeof rate === "number" ? Math.max(0, rate) : 0.1;
}

/** One tracked target as the inference seam takes it. */
function visionEntry(target: VisionTarget): InferenceEntry {
  return {
    nodeId: target.nodeId as NodeId,
    inputResourceId: scratchResourceId(target.nodeId, PERSON_MASK_INPUT_KEY),
    sourceId: inferenceSourceIdFor(target.nodeId),
    // r32float zeros at the output size: the empty mask, "nobody" — which composes
    // to a no-op for a masking consumer rather than to a hole (§T715).
    fallback: new Uint8Array(target.size[0] * target.size[1] * 4),
    minIntervalSeconds: target.minIntervalSeconds,
    ...(target.channel === undefined ? {} : { channel: target.channel }),
    coverage: maskCoverage,
  };
}

export function useVisionBridge(options: {
  /** Document owner identity; replacing the project retires native model history. */
  scope?: object;
  /** The OSC hook's shared device client — one attachment per tab (T950's rule). */
  deviceClient: () => DeviceClient | null;
  backend?: () => LoomBackend | null;
  /** T1067 — the live document, so the coverage channel exists from the FIRST compile:
   *  the seam's entries fill only after a compile allocates the node, and the first
   *  structural compile therefore resolved `mask1:coverage` as unknown and pinned a
   *  diagnostic nothing later cleared. The channel belongs to the NODE, not the seam. */
  graph?: () => FlatGraph;
  /**
   * T1525b: what the node's own parameters (Min interval) are resolved with — the catalogue
   * and the live read world (§T1551b: the compile's channel resolver and the runtime's
   * flattening). Getters, read per frame. REQUIRED, like the media
   * transport's (§T1524b): an optional getter nothing supplies is how a reader ends up
   * resolving without it.
   */
  registry: NodeRegistryView;
  channels: LiveParameterReads["channels"];
  flattening: LiveParameterReads["flattening"];
  /**
   * VN85: the bus the FFGL node's event pulses fire through (`runtime.ffglEvent`) and its probed
   * plugin table is stored through. Optional: without it an FFGL node still runs, on its
   * plugin's defaults, and says so.
   */
  bus?: LoomBus;
  invocation?: InvocationContext;
}): {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  observe(frame: FrameEvaluationInput): void;
  track(graph: FlatGraph, compiled: CompiledGraph | null): void;
  settle(frameIndex: number): Promise<void>;
  prepareForRender(): Promise<void>;
  /** T1067 — `mask1:coverage` et al. Present whenever the NODE is tracked, whether or
   *  not a helper is: E52 shipped erroring on every unpaired machine because this hook
   *  tracked entries but never joined the channel chain, so a document that SPENDS a
   *  coverage (the whole §V856 design) broke instead of dimming. Zero means "nobody" in
   *  both the found-nobody and cannot-run cases; `ready` and the door's own refusal
   *  carry the distinction. A typo (`depth1:coverage`) still fails by name — the seam's
   *  own entry-level refusal, untouched. */
  readonly resolver: ChannelResolver;
} {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [nativeDiagnostics, setNativeDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const nativeDiagnosticsRef = useRef<readonly RuntimeDiagnostic[]>([]);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- Model history belongs to the document owner, not the persistent React mount.
  const native = useMemo(() => createNativeVisionSources(), [options.scope]);
  /* VN85: the native FFGL host's nodes ride this hook's track/observe/settle/diagnostics, the
     same loop the native Vision path uses. The manifest write and the event command need the bus. */
  const busRef = useRef(options.bus);
  busRef.current = options.bus;
  const invocationRef = useRef(options.invocation);
  invocationRef.current = options.invocation;
  // Plugin instances belong to the document owner (`scope`), like native model history.
  const ffgl = useMemo(() => createNativeFfglSources({
    onManifest: (nodeId, manifest) => {
      const bus = busRef.current, invocation = invocationRef.current;
      if (!bus || !invocation) return;
      void bus.execute("graph.applyPatch", { baseRevision: bus.store.getRevision(), label: "Load FFGL plugin",
        operations: [{ op: "setParameters", nodeId, parameters: { manifest } }] }, invocation);
    },
  }), [options.scope]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const bus = options.bus;
    if (bus === undefined || bus.hasCommand(FFGL_EVENT_COMMAND)) return;
    bus.registerCommand({
      name: FFGL_EVENT_COMMAND,
      inSession: "instance",
      // The event is the plugin's parameter INDEX: an instance command's strings may only be node addresses (§T1695b).
      inputSchema: z.object({ nodeIds: nodeIdsInput, event: z.number().int().nonnegative() }).strict(),
      description: "Raise an FFGL plugin's event parameter (an FFGL node's pulse) on the named nodes for their next frame.",
      handler: (input, context) => ({
        status: context.dryRun ? "validated" : "applied",
        output: { raised: context.dryRun ? 0 : ffgl.fire(input.nodeIds, input.event) },
        diagnostics: [],
      }),
      rejectionOutput: () => ({ raised: 0 }),
    });
  }, [options.bus, ffgl]);
  const refreshNative = useCallback(() => {
    const next = [...native.diagnostics(), ...ffgl.diagnostics()];
    const prior = nativeDiagnosticsRef.current;
    // Compare before dispatch: even a React eager bailout allocates an update
    // and updater closure at frame rate, including when no native model exists.
    if (prior.length === next.length && prior.every((value, index) =>
      value.code === next[index]?.code && value.nodeId === next[index]?.nodeId &&
      value.severity === next[index]?.severity && value.message === next[index]?.message)) return;
    nativeDiagnosticsRef.current = next;
    setNativeDiagnostics(next);
  }, [native, ffgl]);
  useEffect(() => {
    const retire = () => { native.dispose(); ffgl.dispose(); };
    window.addEventListener("loom-native-input-retire", retire);
    return () => { window.removeEventListener("loom-native-input-retire", retire); native.dispose(); ffgl.dispose(); };
  }, [native, ffgl]);
  const targetsRef = useRef<readonly VisionTarget[]>([]);
  const nativeTargetsRef = useRef<readonly NativeVisionTarget[]>([]);
  /* T1067 — through a REF, deliberately: the seam below memoises on its inputs, and a
     caller handing a fresh accessor per render would REBUILD the seam mid-session —
     dropping every tracked entry, which is exactly "the node exists and publishes no
     channel" wearing a React costume. One seam per mount; the accessor stays live. */
  const clientRef = useRef(options.deviceClient);
  clientRef.current = options.deviceClient;
  const client = useCallback(() => clientRef.current(), []);
  const backendRef = useRef(options.backend);
  backendRef.current = options.backend;
  /* T1254 — the graph accessor through the same ref, for the same reason: the composition
     root hands a fresh arrow per render, and with `graph` in the resolver's dependency
     array every `App` render minted a new `resolver`, which re-keyed `externalChannels`,
     then the compile hook's channel resolver, then its `CompileRequest` and per-frame
     compiler — one full compile per RENDER on a knob drag (measured: 1935 renders, 1935
     new resolvers, E24 scenario C). The resolver's identity now moves with `sources` only. */
  const graphRef = useRef(options.graph);
  graphRef.current = options.graph;
  /* T1525b — through a ref for the same reason; `trackedGraphRef` is the document `track`
     was last handed, the one each frame re-reads Min interval on. */
  const readsRef = useRef<VisionParameterReads>(options);
  readsRef.current = options;
  const trackedGraphRef = useRef<FlatGraph | null>(null);
  const ffglSizedRef = useRef<ReadonlyMap<string, readonly [number, number]>>(new Map());
  const unregisterRef = useRef(new Map<string, () => void>());
  const registeredOnRef = useRef<LoomBackend | null>(null);

  const sources = useMemo(
    () =>
      createInferenceSources({
        readBuffer: (resourceId) => {
          const live = backendRef.current?.() ?? null;
          if (live === null) return Promise.reject(new Error("No backend is attached; nothing to read."));
          return live.readBuffer(resourceId);
        },
        run: async (nodeId, input) => {
          const live = client();
          if (live === null) {
            throw new Error(
              `no device bridge is attached — ${DEVICE_HELPER_START}`,
            );
          }
          const outcome = await live.vision({
            width: SIDE,
            height: SIDE,
            rgbaBase64: texelsToRgbaBase64(new Float32Array(input)),
          });
          if (!outcome.ok) throw new Error(outcome.reason);
          const target = targetsRef.current.find((entry) => entry.nodeId === nodeId);
          const [outWidth, outHeight] = target?.size ?? [1, 1];
          const raw = atob(outcome.maskBase64);
          const mask = new Uint8Array(raw.length);
          for (let at = 0; at < raw.length; at += 1) mask[at] = raw.charCodeAt(at);
          const floats = maskToFloats(mask, outcome.maskWidth, outcome.maskHeight, outWidth, outHeight);
          return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
        },
      }),
    [client],
  );

  /* VN85: every compiled FFGL node, with its result size, its input copy (when wired) and a
     per-frame read of its parameters through the one read path (resolveParameters). */
  const ffglTargets = useCallback((graph: FlatGraph, sized: ReadonlyMap<string, readonly [number, number]>): FfglTarget[] => {
    const found: FfglTarget[] = [];
    for (const nodeId of Object.keys(graph.nodes).sort()) {
      const node = graph.nodes[nodeId];
      if (node === undefined || node.type !== FFGL_TYPE_NAME) continue;
      const size = sized.get(scratchResourceId(nodeId, FFGL_RESULT_KEY));
      if (size === undefined) continue;
      const input = scratchResourceId(nodeId, FFGL_INPUT_KEY);
      const stored = node.parameters as Readonly<Record<string, unknown>>;
      found.push({
        nodeId, size, plugin: typeof stored["plugin"] === "string" ? stored["plugin"] : "",
        manifest: typeof stored["manifest"] === "string" ? stored["manifest"] : "",
        ...(sized.has(input) ? { inputResourceId: input } : {}),
        read: (frame) => {
          const reads = readsRef.current;
          const resolved = resolveParameters(node, reads.registry.get(node.type),
            parameterReadOptions({ graph, registry: reads.registry, frame, channels: reads.channels(), flattening: reads.flattening() }));
          const bpm = resolved.get("bpm")?.value;
          return { bpm: typeof bpm === "number" && bpm > 0 ? bpm : 120,
            value: (key) => resolved.get(key)?.value as never };
        },
      });
    }
    return found;
  }, []);

  const track = useCallback(
    (graph: FlatGraph, compiled: CompiledGraph | null) => {
      const sized = new Map<string, readonly [number, number]>();
      const nativeResults = new Set<string>();
      for (const resource of compiled?.resources ?? []) {
        const entry = resource as { id?: string; size?: readonly [number, number] };
        if (entry.id !== undefined && entry.size !== undefined) sized.set(entry.id, entry.size);
        if (resource.kind === "externalTexture" && resource.format === "rgba16float") nativeResults.add(resource.id);
      }
      const targets: VisionTarget[] = [];
      const nativeTargets: NativeVisionTarget[] = [];
      const next: RuntimeDiagnostic[] = [];
      for (const nodeId of Object.keys(graph.nodes).sort()) {
        const node = graph.nodes[nodeId];
        if (node === undefined || node.type !== "personMask") continue;
        const resultId = scratchResourceId(nodeId, PERSON_MASK_RESULT_KEY);
        // §V585: unwired = unallocated = untracked; nothing is asked of the helper.
        if (!sized.has(resultId)) continue;
        const target = {
          nodeId,
          size: sized.get(resultId) ?? [1, 1],
          minIntervalSeconds: minIntervalAt(node, graph, readsRef.current, undefined),
          ...(node.label === undefined ? {} : { channel: node.label }),
        };
        // The compiler resolved static/bound transport and declared its format.
        // Do not reinterpret a stored parameter slot independently of that plan.
        if (nativeResults.has(resultId)) { nativeTargets.push(target); continue; }
        targets.push(target);
        if (client() === null) {
          next.push({
            /* T1067 — WARNING, not info: a wired node that cannot run produces a black
               mask indistinguishable from "found nobody" (§V856's trap, in the feature
               built to avoid it). Info never reaches the node's badge, so the owner met
               a silently black node; a warning lights the node itself, which is where
               they were looking (§T948). */
            severity: "warning",
            code: "vision.helper.absent",
            message:
              `Person Mask is NOT RUNNING — it needs ${DEVICE_HELPER_NAME} (\`${DEVICE_HELPER_COMMAND}\`) paired in the Connections section, on macOS. That helper spawns the Apple Vision worker because a page cannot; it is not an agent connection. Until then it publishes an empty mask (nobody) and coverage reads 0.`,
            nodeId,
          });
        } else {
          const failed = sources.lastFailure(nodeId as NodeId);
          if (failed !== undefined) {
            next.push({ severity: "warning", code: "vision.refused", message: failed, nodeId });
          }
        }
      }
      targetsRef.current = targets;
      trackedGraphRef.current = graph;
      setDiagnostics((prior) =>
        prior.length === next.length &&
        prior.every((entry, at) => entry.code === next[at]?.code && entry.nodeId === next[at]?.nodeId && entry.message === next[at]?.message)
          ? prior
          : next,
      );

      // T1044's discipline, inherited verbatim from the model seam: a rebuilt device
      // holds no registrations, so the map is dropped on identity change.
      const attached = backendRef.current?.() ?? null;
      if (attached !== registeredOnRef.current) {
        for (const off of unregisterRef.current.values()) off();
        unregisterRef.current.clear();
        registeredOnRef.current = attached;
      }
      const wanted = new Set(targets.map((target) => inferenceSourceIdFor(target.nodeId)));
      for (const [sourceId, off] of [...unregisterRef.current.entries()]) {
        if (wanted.has(sourceId)) continue;
        off();
        unregisterRef.current.delete(sourceId);
      }
      if (attached !== null) {
        for (const target of targets) {
          const sourceId = inferenceSourceIdFor(target.nodeId);
          if (unregisterRef.current.has(sourceId)) continue;
          unregisterRef.current.set(
            sourceId,
            attached.registerMediaSource(sourceId, {
              currentFrame: () => sources.currentFrame(target.nodeId as NodeId),
            }),
          );
        }
      }

      sources.track(targets.map(visionEntry));
      native.track(nativeTargets, attached);
      nativeTargetsRef.current = nativeTargets;
      ffglSizedRef.current = sized;
      ffgl.track(ffglTargets(graph, sized), attached);
      refreshNative();
    },
    [client, sources, native, ffgl, ffglTargets, refreshNative],
  );

  /**
   * T1525b — Min interval AT THIS FRAME, for both paths. The set is the compile's; the gap
   * is a parameter read, and a parameter read happens at a frame. Re-tracked only when a
   * gap actually moved, so a still document does nothing here but resolve.
   */
  const refreshIntervals = useCallback(
    (frame: FrameEvaluationInput) => {
      const graph = trackedGraphRef.current;
      if (graph === null || (targetsRef.current.length === 0 && nativeTargetsRef.current.length === 0)) return;
      let changed = false;
      const at = <T extends VisionTarget>(target: T): T => {
        const node = graph.nodes[target.nodeId];
        const gap = node === undefined ? target.minIntervalSeconds : minIntervalAt(node, graph, readsRef.current, frame);
        if (gap === target.minIntervalSeconds) return target;
        changed = true;
        return { ...target, minIntervalSeconds: gap };
      };
      const targets = targetsRef.current.map(at);
      const nativeTargets = nativeTargetsRef.current.map(at);
      if (!changed) return;
      targetsRef.current = targets;
      sources.track(targets.map(visionEntry));
      nativeTargetsRef.current = nativeTargets;
      native.track(nativeTargets, backendRef.current?.() ?? null);
    },
    [sources, native],
  );

  const observe = useCallback(
    (frame: FrameEvaluationInput) => {
      refreshIntervals(frame);
      native.observe(frame); ffgl.observe(frame); refreshNative();
      if (targetsRef.current.length === 0) return;
      // Between frames, exactly as analyze and the model seam do (§V184).
      queueMicrotask(() => sources.sample(frame.frameIndex, absTimeSecondsOf(frame)));
    },
    [sources, native, ffgl, refreshNative, refreshIntervals],
  );

  const settle = useCallback(
    async (frameIndex: number) => {
      await native.settle(frameIndex); await ffgl.settle(frameIndex); refreshNative();
      if (targetsRef.current.length === 0) return;
      await sources.settle(frameIndex);
    },
    [sources, native, ffgl, refreshNative],
  );
  const prepareForRender = useCallback(async () => {
    await native.drain();
    native.track(nativeTargetsRef.current, backendRef.current?.() ?? null);
    // A render take opens fresh plugin instances: a feedback plugin's state starts clean.
    await ffgl.drain();
    const graph = trackedGraphRef.current;
    if (graph) ffgl.track(ffglTargets(graph, ffglSizedRef.current), backendRef.current?.() ?? null);
    // The take's explicit reset (VN71): its first frame starts every plugin clock afresh.
    ffgl.restart();
    refreshNative();
  }, [native, ffgl, ffglTargets, refreshNative]);

  const resolver = useCallback<ChannelResolver>(
    (channel, context) => {
      const nativeValue = native.resolver(channel, context);
      if (nativeValue !== undefined) return nativeValue;
      const value = sources.resolver(channel, context);
      if (value !== undefined) return value;
      /* The node-level answer (a6's condition, verbatim: the channel must exist
         whenever the NODE exists, not whenever a runner does). Zero for both
         "found nobody" and "cannot run"; `ready` and the node's own warning carry
         the distinction. Only personMask labels answer — `depth1:coverage` still
         falls through and fails by name, which is §V150's load-bearing refusal. */
      const split = channel.lastIndexOf(":");
      if (split <= 0 || channel.slice(split + 1) !== "coverage") return undefined;
      const name = channel.slice(0, split);
      const graph = graphRef.current?.();
      if (graph === undefined) return undefined;
      for (const node of Object.values(graph.nodes)) {
        if (node.type === "personMask" && (node.label ?? node.id) === name) return 0;
      }
      return undefined;
    },
    [sources, native],
  );

  return useMemo(
    () => ({ diagnostics: [...diagnostics, ...nativeDiagnostics], observe, track, settle, prepareForRender, resolver }),
    [diagnostics, nativeDiagnostics, observe, track, settle, prepareForRender, resolver],
  );
}
