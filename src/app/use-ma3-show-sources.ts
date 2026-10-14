import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CompiledGraph } from "@compiler/index.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { createMa3Playback, parseMa3Show, type Ma3Playback } from "@domain/lighting/ma3-show.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { FlatGraph } from "@domain/types/graph.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { ma3ShowSourceIdFor } from "@nodes/definitions/ma3-show-in.ts";

/**
 * VN131 — the page half of `ma3ShowIn`: load the show file, then write every universe's
 * DMX for the frame being rendered.
 *
 * `sync` rides the frame loop's `advanceChannels` seam beside `media.sync`, so the show reads
 * the same timeline time as every timeline-locked movie and the song. The playback replays
 * from the top on every call (`createMa3Playback`), so a scrub or a loop needs nothing extra.
 * Headless sessions (`mcp/serve.ts`, the Dawn harness) have no page and register no source.
 */
interface Request {
  readonly nodeId: string;
  readonly file: string;
}

interface ShowSource {
  readonly signature: string;
  readonly abort: AbortController;
  playback?: Ma3Playback;
  frame: { frameId: number; bytes?: Uint8Array };
  release?: () => void;
  diagnostic?: RuntimeDiagnostic;
  pending?: Promise<void>;
}

function requestsFor(graph: FlatGraph, compiled: CompiledGraph | null): readonly Request[] {
  if (compiled === null) return [];
  const compiledNodes = new Set(compiled.outputs.map(output => output.nodeId));
  const requests: Request[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId]!;
    if (node.type !== "ma3ShowIn" || isSilencedSource(node) || !compiledNodes.has(nodeId)) continue;
    const file = storedStaticValue(node.parameters["file"]);
    requests.push({ nodeId, file: typeof file === "string" ? file : "" });
  }
  return requests;
}

export interface Ma3ShowSources {
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** Write this frame's DMX into every loaded show's texture. */
  sync(frame: FrameEvaluationInput): void;
  readonly settle: () => Promise<void>;
}

export function useMa3ShowSources(backend: LoomBackend | null | undefined, graph: FlatGraph, compiled: CompiledGraph | null): Ma3ShowSources {
  const signature = useMemo(() => JSON.stringify(requestsFor(graph, compiled)), [graph, compiled]);
  const requests = useMemo(() => JSON.parse(signature) as Request[], [signature]);
  const sources = useRef(new Map<string, ShowSource>());
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const publish = useCallback(() => {
    setDiagnostics([...sources.current.values()].flatMap(source => source.diagnostic ? [source.diagnostic] : []));
  }, []);

  useEffect(() => {
    const owned = sources.current;
    return () => {
      for (const source of owned.values()) { source.abort.abort(); source.release?.(); }
      owned.clear();
    };
  }, [backend]);

  useEffect(() => {
    const wanted = new Map(requests.map(request => [request.nodeId, JSON.stringify(request)]));
    for (const [nodeId, source] of sources.current) {
      if (backend && wanted.get(nodeId) === source.signature) continue;
      source.abort.abort();
      source.release?.();
      sources.current.delete(nodeId);
    }
    if (!backend) { publish(); return; }
    for (const request of requests) {
      if (sources.current.has(request.nodeId)) continue;
      const source: ShowSource = { signature: wanted.get(request.nodeId)!, abort: new AbortController(), frame: { frameId: 0 } };
      sources.current.set(request.nodeId, source);
      const diagnostic = (severity: RuntimeDiagnostic["severity"], code: string, message: string): RuntimeDiagnostic => ({ severity, code, message, nodeId: request.nodeId });
      if (request.file === "") {
        source.diagnostic = diagnostic("warning", "ma3Show.missing", "Choose a .ma3show.json show file.");
        continue;
      }
      source.diagnostic = diagnostic("info", "ma3Show.loading", "Loading the show file.");
      const current = (): boolean => !source.abort.signal.aborted && sources.current.get(request.nodeId) === source;
      source.pending = (async () => {
        try {
          const response = await fetch(request.file, { signal: source.abort.signal });
          if (!response.ok) throw new Error(`Could not read ${request.file}: HTTP ${response.status}.`);
          const text = await response.text();
          if (!current()) return;
          source.playback = createMa3Playback(parseMa3Show(text));
          source.release = backend.registerMediaSource(ma3ShowSourceIdFor(request.nodeId), { currentFrame: () => source.frame });
          delete source.diagnostic;
          publish();
        } catch (error) {
          if (!current()) return;
          source.diagnostic = diagnostic("error", "ma3Show.unreadable", error instanceof Error ? error.message : String(error));
          publish();
        }
      })();
    }
    publish();
  }, [backend, requests, publish]);

  const sync = useCallback((frame: FrameEvaluationInput) => {
    for (const [nodeId, source] of sources.current) {
      if (source.playback === undefined) continue;
      const node = graphRef.current.nodes[nodeId];
      const offset = Number(storedStaticValue(node?.parameters["offset"]) ?? 0);
      const blackout = storedStaticValue(node?.parameters["blackout"]) === true;
      const dmx = source.playback.evaluate(frame.timeSeconds + (Number.isFinite(offset) ? offset : 0));
      if (blackout) dmx.fill(0);
      source.frame = { frameId: source.frame.frameId + 1, bytes: new Uint8Array(dmx.buffer, dmx.byteOffset, dmx.byteLength) };
    }
  }, []);

  const settle = useCallback(async () => {
    await Promise.all([...sources.current.values()].map(source => source.pending));
    for (const source of sources.current.values()) {
      if (source.diagnostic !== undefined && source.diagnostic.severity === "error") throw new Error(source.diagnostic.message);
    }
  }, []);

  return { diagnostics, sync, settle };
}
