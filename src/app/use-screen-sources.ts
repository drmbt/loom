import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { mediaSourceIdFor, SCREEN_IN_TYPE } from "@nodes/definitions/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { createVideoMediaSource, type VideoMediaSource } from "./media-sources.ts";
import { browserScreenCaptureEnvironment, type OpenedScreenCapture, type ScreenCaptureEnvironment } from "./screen-capture.ts";

export interface ScreenCaptureStatus {
  readonly phase: "idle" | "choosing" | "sharing" | "ended" | "error";
  readonly label?: string;
  readonly message?: string;
}

export interface ScreenCaptureWiring {
  readonly statuses: Readonly<Record<NodeId, ScreenCaptureStatus>>;
  start(nodeId: NodeId): Promise<void>;
  stop(nodeId: NodeId): void;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

interface Session {
  readonly capture: OpenedScreenCapture;
  readonly media: VideoMediaSource;
  unregister?: () => void;
  removeEnded: () => void;
}

function dispose(session: Session) {
  session.removeEnded();
  session.unregister?.();
  session.media.dispose();
  session.capture.stop();
}

function errorMessage(error: unknown): string {
  if ((error instanceof Error || error instanceof DOMException) && error.name === "NotAllowedError") {
    return "Screen sharing was cancelled or permission was denied. Click Share to choose again.";
  }
  return error instanceof Error || error instanceof DOMException ? error.message : String(error);
}

/** Explicit, session-owned capture. Graph restoration never opens a browser picker. */
export function useScreenSources(
  runtime: AppRuntime,
  backend: LoomBackend | null,
  graph: GraphDocument,
  environment?: ScreenCaptureEnvironment,
): ScreenCaptureWiring {
  const latest = useRef({ runtime, backend, graph, environment });
  latest.current = { runtime, backend, graph, environment };
  const identity = runtime.documentIdentity;
  const owner = useMemo(() => ({
    identity,
    live: true,
    sessions: new Map<NodeId, Session>(),
    pending: new Map<NodeId, AbortController>(),
  }), [identity]);
  const [state, setState] = useState<{ identity: string; statuses: Record<NodeId, ScreenCaptureStatus> }>({ identity, statuses: {} });
  const statuses = useMemo(() => state.identity === identity ? state.statuses : {}, [state, identity]);
  const eligible = useCallback((id: NodeId) => {
    const node = latest.current.graph.nodes[id];
    return owner.live && latest.current.runtime.documentIdentity === owner.identity
      && node?.type === SCREEN_IN_TYPE && !isSilencedSource(node);
  }, [owner]);
  const report = useCallback((id: NodeId, status: ScreenCaptureStatus | null) => {
    if (!owner.live || latest.current.runtime.documentIdentity !== owner.identity) return;
    setState(previous => {
      const next = { ...(previous.identity === owner.identity ? previous.statuses : {}) };
      if (status === null) delete next[id];
      else next[id] = status;
      return { identity: owner.identity, statuses: next };
    });
  }, [owner]);
  const retire = useCallback((id: NodeId) => {
    owner.pending.get(id)?.abort();
    owner.pending.delete(id);
    const session = owner.sessions.get(id);
    owner.sessions.delete(id);
    if (session) dispose(session);
  }, [owner]);
  const stop = useCallback((id: NodeId) => {
    retire(id);
    report(id, { phase: "idle" });
  }, [retire, report]);

  useEffect(() => {
    owner.live = true;
    const release = () => {
      for (const id of new Set([...owner.sessions.keys(), ...owner.pending.keys()])) {
        const wasSharing = owner.sessions.has(id);
        retire(id);
        report(id, { phase: wasSharing ? "ended" : "idle" });
      }
    };
    window.addEventListener("pagehide", release);
    return () => {
      owner.live = false;
      window.removeEventListener("pagehide", release);
      release();
    };
  }, [owner, retire, report]);

  useEffect(() => {
    for (const id of new Set([...owner.sessions.keys(), ...owner.pending.keys(), ...Object.keys(statuses)])) {
      if (!eligible(id)) {
        retire(id);
        report(id, null);
      }
    }
  }, [graph, owner, eligible, retire, report, statuses]);

  // Device recovery changes registrations, not capture ownership or browser permission.
  useEffect(() => {
    for (const [id, session] of owner.sessions) {
      session.unregister?.();
      delete session.unregister;
      if (backend) {
        try {
          session.unregister = backend.registerMediaSource(mediaSourceIdFor(id), session.media.source);
        } catch (error) {
          retire(id);
          report(id, { phase: "error", message: errorMessage(error) });
        }
      }
    }
    return () => {
      for (const session of owner.sessions.values()) {
        session.unregister?.();
        delete session.unregister;
      }
    };
  }, [backend, owner, retire, report]);

  const start = useCallback(async (id: NodeId) => {
    if (!eligible(id)) {
      report(id, { phase: "error", message: "Select an active Screen In node before sharing." });
      return;
    }
    owner.pending.get(id)?.abort();
    const token = new AbortController();
    owner.pending.set(id, token);
    const retainedLabel = owner.sessions.get(id)?.capture.label;
    report(id, { phase: "choosing", ...(retainedLabel === undefined ? {} : { label: retainedLabel }) });
    let opened: OpenedScreenCapture | undefined;
    let session: Session | undefined;
    try {
      // No await before open(): keep getDisplayMedia on the user's click stack.
      opened = await (latest.current.environment ?? browserScreenCaptureEnvironment()).open(token.signal);
      if (owner.pending.get(id) !== token || !eligible(id)) {
        opened.stop();
        return;
      }
      owner.pending.delete(id);
      session = { capture: opened, media: createVideoMediaSource(opened.element), removeEnded() {} };
      const previous = owner.sessions.get(id);
      owner.sessions.delete(id);
      if (previous) dispose(previous);
      owner.sessions.set(id, session);
      const target = latest.current.backend;
      if (target) session.unregister = target.registerMediaSource(mediaSourceIdFor(id), session.media.source);
      const currentSession = session;
      report(id, { phase: "sharing", label: opened.label });
      // Store the session first: ended may fire immediately when attaching this listener.
      session.removeEnded = opened.onEnded(() => {
        if (owner.sessions.get(id) !== currentSession) return;
        // Ending the old surface must not cancel a newer picker already in progress.
        owner.sessions.delete(id);
        dispose(currentSession);
        report(id, { phase: owner.pending.has(id) ? "choosing" : "ended" });
      });
    } catch (error) {
      if (session && owner.sessions.get(id) === session) {
        owner.sessions.delete(id);
        dispose(session);
      } else opened?.stop();
      if (owner.pending.get(id) !== token && !session) return;
      owner.pending.delete(id);
      const retained = owner.sessions.get(id);
      report(id, { phase: retained ? "sharing" : "error", ...(retained ? { label: retained.capture.label } : {}), message: errorMessage(error) });
    }
  }, [owner, eligible, report]);

  const diagnostics = useMemo<readonly RuntimeDiagnostic[]>(() => Object.entries(statuses)
    .filter(([, status]) => status.message !== undefined)
    .map(([nodeId, status]) => ({ nodeId, severity: "warning", code: "media.screenCapture", message: status.message! })), [statuses]);
  return { statuses, start, stop, diagnostics };
}
