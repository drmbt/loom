import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SINK_TARGET_PORT } from "@compiler/index.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { createParameterReadOptions, resolveParameters } from "@domain/parameters/index.ts";
import type { ChannelResolver, ParameterMorphs, ResolvedParameters } from "@domain/parameters/resolve.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { createParameterEditor } from "@editor/inspector/parameter-editor.ts";
import type { ParameterEditor } from "@editor/inspector/parameter-editor.ts";
import type { WindowMappingView, WindowSectionSurface } from "@editor/inspector/window-section.tsx";
import { createVec3GizmoStore } from "@editor/viewer/index.ts";
import type { GridLineActions } from "@editor/viewer/index.ts";
import { WINDOW_OUT_TYPE } from "@nodes/definitions/window-out.ts";
import type { LoomBackend } from "@runtime/backend/backend-types.ts";
import type { PassDescriptor, ResourceDescriptor } from "@runtime/backend/plan.ts";
import type { DisplaySinkStore } from "./display-sinks.ts";
import { registerPerformCommands } from "./perform-commands.ts";
import type { PerformWindows } from "./perform-commands.ts";
import { createScreenSource, performWindowName, physicalSize, placementFeatures, resolveScreen } from "./perform-screens.ts";
import type { ScreenSource } from "./perform-screens.ts";
import { browserPerformOpener, openPerformWindow } from "./perform-window.ts";
import type { PerformWindowHandle } from "./perform-window.ts";
import { MAPPING_OVERLAY_TOKENS, createMappingOverlay, mappingOverlayView } from "./perform-mapping-overlay.ts";
import type { MappingOverlay, MappingOverlayView } from "./perform-mapping-overlay.ts";
import { mappingAbsentNote, mappingTargetsOf, windowPicture } from "./perform-mapping.ts";
import type { MappingTarget, Size, WindowFit } from "./perform-mapping.ts";

/**
 * The perform windows of this session (§T1391b): which Window Outs have one open, the
 * commands that open and close them, and the inspector's surface.
 *
 * Session state only. Nothing about an OS window is saved; what IS saved is the Window Out's
 * parameters, so reopening a project and pressing the key puts the same picture on the same
 * screen at the same size.
 *
 * The open set is what makes a Window Out render at all (`sinkRole: "display"`): it is
 * written to `displaySinks`, the compile adds those sinks, and the new plan's `$target` is
 * handed to the window — so a window opens black for the one frame the recompile takes.
 */

/**
 * The slice of a compiled plan this needs: where each node's `$target` lives and, for the
 * edit-mapping mode (§T1536b), its size and the size of the texture the Window Out samples
 * (its pass's input binding) — the two aspects its Fit is computed from. A plan without the
 * pass or the sizes (one that has not compiled the window yet) draws no handles.
 */
export interface PerformPlan {
  readonly outputs: ReadonlyArray<{
    readonly nodeId: string;
    readonly portId: string;
    readonly resourceId: string;
    readonly size?: readonly [number, number];
  }>;
  readonly passes?: ReadonlyArray<PassDescriptor>;
  readonly resources?: ReadonlyArray<ResourceDescriptor>;
}

export interface PerformWindowsOptions {
  readonly bus: LoomBus;
  readonly backend: LoomBackend | null | undefined;
  readonly plan: PerformPlan | null | undefined;
  readonly displaySinks: DisplaySinkStore;
  /** `window.open`, injectable for a test; the real one is `browserPerformOpener(window)`. */
  readonly openWindow?: (name: string, features: string) => Window | null;
  /** The screen list, injectable for a test; the real one reads the browser. */
  readonly screenSource?: ScreenSource;
  /**
   * T1525b: what Screen, Fullscreen and Hide cursor are resolved with when they are read —
   * the catalogue, the compile's channel resolver, the preset morphs in flight
   * (`FlattenedGraph.morphs`) and the frame the loop last rendered, since opening a window
   * is a moment and an expression on Fullscreen is read at it. REQUIRED, like the media
   * transport's (§T1524b): an optional getter nothing supplies is how a reader ends up
   * resolving without it. No frame yet: the zero frame.
   */
  readonly registry: NodeRegistryView;
  readonly channels: () => ChannelResolver | undefined;
  readonly morphs: () => ParameterMorphs | undefined;
  readonly frame: () => FrameEvaluationInput | undefined;
  /**
   * §T1536b: who a mapping-handle drag on a perform window is — the local human, exactly as
   * a drag on the node's preview tile (the same parameter editor, so one undo group per drag).
   */
  readonly invocation: InvocationContext;
}

export interface PerformWindowsResult {
  readonly surface: WindowSectionSurface;
  /** The open windows, for their keymap targets (so the perform key works inside them). */
  readonly windows: readonly Window[];
  /**
   * T1530b: the frame observer — Hide cursor on each OPEN window, resolved at the frame just
   * rendered, so a fade or a time-varying expression on it is followed while the window is
   * up. Stable, touches no React state (§V16): a style write on the window, only when the
   * answer changed. Nothing open, nothing done.
   */
  readonly observe: (frame: FrameEvaluationInput) => void;
}

// T1525b: off the RESOLVED parameters, never the stored slot — an expression on Fullscreen
// is an object in the slot, and reading the slot was a typeof check that fell to the default.
const stringParameter = (parameters: ResolvedParameters, key: string, fallback: string): string => {
  const value = parameters.get(key)?.value;
  return typeof value === "string" ? value : fallback;
};
const booleanParameter = (parameters: ResolvedParameters, key: string, fallback: boolean): boolean => {
  const value = parameters.get(key)?.value;
  return typeof value === "boolean" ? value : fallback;
};

const FITS: readonly WindowFit[] = ["fit", "fill", "stretch"];

/** One window in edit-mapping mode: its layer and the parameter editor its drags write through. */
interface MappingSession {
  /** A refused line insert/delete, shown until the next successful one. */
  message: string | null;
  readonly overlay: MappingOverlay;
  readonly editor: ParameterEditor;
}

const WAITING_NOTE = "Waiting for this window's first frame.";

const NO_SCREENS: ScreenSource = {
  screens: () => [],
  editor: () => undefined,
  permission: () => "unsupported",
  request: () => Promise.resolve(),
  subscribe: () => () => {},
};

export function usePerformWindows({ bus, backend, plan, displaySinks, openWindow, screenSource, invocation, ...reads }: PerformWindowsOptions): PerformWindowsResult {
  const screens = useMemo(
    () => screenSource ?? (typeof window === "undefined" ? NO_SCREENS : createScreenSource(window)),
    [screenSource],
  );
  // T1525b: through a ref, so a fresh getter per render does not rebuild the commands' holder.
  const readsRef = useRef(reads);
  readsRef.current = reads;
  /**
   * A Window Out's parameters as the one read path resolves them, now (§V61). `graph` is the
   * document the caller already read the node from — the same authored one (see above).
   */
  const parametersOf = useCallback(
    (node: GraphNode, graph: GraphDocument, at?: FrameEvaluationInput): ResolvedParameters => {
      const { registry, channels, morphs, frame } = readsRef.current;
      const options = createParameterReadOptions({
        graph,
        registry,
        frame: at ?? frame(),
        channels: channels(),
        morphs: morphs(),
      });
      return resolveParameters(node, registry.get(node.type), options);
    },
    [],
  );
  const openRef = useRef(openWindow);
  openRef.current = openWindow;
  const handles = useRef(new Map<string, PerformWindowHandle>());
  /*
   * T1530b: the authored document as last read on an open or a document change — what the
   * frame observer resolves Hide cursor against, so the per-frame path reads no document
   * (frame-path-flattening's ledger: this file's reads are NOT per frame).
   */
  const authoredRef = useRef<GraphDocument | null>(null);
  const [open, setOpen] = useState<readonly Window[]>([]);
  const listeners = useRef(new Set<() => void>());
  const planRef = useRef(plan);
  planRef.current = plan;
  const backendRef = useRef(backend);
  backendRef.current = backend;
  const invocationRef = useRef(invocation);
  invocationRef.current = invocation;
  /** §T1536b: the windows in edit-mapping mode. Session state, like the open set. */
  const mapping = useRef(new Map<string, MappingSession>());

  // Re-pointed every render so it always writes the CURRENT (per-document) sink store.
  const changed = useRef<() => void>(() => {});
  changed.current = () => {
    displaySinks.set([...handles.current.keys()].sort());
    setOpen([...handles.current.values()].map((handle) => handle.window));
    for (const listener of listeners.current) listener();
  };
  // A new document's store must learn what is open (the document change closes them all
  // below, so this is normally the empty set).
  useEffect(() => {
    displaySinks.set([...handles.current.keys()].sort());
  }, [displaySinks]);

  const outputFor = (nodeId: string): string | undefined =>
    planRef.current?.outputs.find((output) => output.nodeId === nodeId && output.portId === SINK_TARGET_PORT)?.resourceId;

  /**
   * §T1536b — EDIT MAPPING on an open window: the handles of a Corner Pin / Grid Warp
   * upstream, drawn over the window's picture where the window shows them
   * (`perform-mapping.ts` decides which node and the exact map, or refuses by name). Every
   * drag writes through a parameter editor on the bus with the local human's invocation —
   * the tile's own write path (`Vec3GizmoStore`), one undo group per drag. Re-drawn on a
   * document change (a drag lands there first), a new plan (sizes) and a window resize.
   */
  const choices = useRef(new Map<string, string>());
  /** Hide cursor as resolved — except while the window is in edit-mapping mode (§T1536b). */
  const hideCursorOf = useCallback(
    (nodeId: string, node: GraphNode, graph: GraphDocument, at?: FrameEvaluationInput): boolean =>
      !mapping.current.has(nodeId) && booleanParameter(parametersOf(node, graph, at), "hideCursor", true),
    [parametersOf],
  );
  const mappingOps = useMemo(() => {
    const notify = (): void => {
      for (const listener of listeners.current) listener();
    };
    /** The Fit facts the plan and the Window Out's parameters give, or null before the plan has them. */
    const pictureFacts = (windowId: string, graph: GraphDocument) => {
      const current = planRef.current;
      const targetSize = current?.outputs.find((output) => output.nodeId === windowId && output.portId === SINK_TARGET_PORT)?.size;
      let binding: string | undefined;
      for (const pass of current?.passes ?? []) {
        if (pass.kind !== "effect" || pass.nodeId !== windowId) continue;
        binding = pass.textures?.[0]?.resourceId;
        break;
      }
      const resource = binding === undefined ? undefined : current?.resources?.find((entry) => entry.id === binding);
      const inputSize = resource !== undefined && "size" in resource ? resource.size : undefined;
      const node = graph.nodes[windowId];
      if (targetSize === undefined || inputSize === undefined || node === undefined) return null;
      const fit = stringParameter(parametersOf(node, graph), "fit", "fit");
      return { fit: FITS.find((mode) => mode === fit) ?? "fit", inputSize: inputSize as Size, targetSize: targetSize as Size };
    };
    // The AUTHORED document: a Window Out and the mapping nodes it edits are nodes the user
    // placed at the root (as the windows' own reads below). Read on a toggle, a document
    // change, a new plan or a resize — never per frame.
    const authored = (): GraphDocument => bus.store.getGraph();
    const targetsOf = (windowId: string, graph: GraphDocument): readonly MappingTarget[] =>
      mappingTargetsOf(graph, readsRef.current.registry, windowId);
    const chosenOf = (windowId: string, targets: readonly MappingTarget[]): MappingTarget | undefined =>
      targets.find((target) => target.nodeId === choices.current.get(windowId)) ?? targets[0];
    const viewOf = (windowId: string, session: MappingSession): MappingOverlayView => {
      const graph = authored();
      return mappingOverlayView({
        graph,
        registry: readsRef.current.registry,
        target: chosenOf(windowId, targetsOf(windowId, graph)),
        absent: mappingAbsentNote(),
        where: "this window",
        // §T1538b: the Corner Pins crossed, from their values RESOLVED as the window shows them.
        valuesOf: (nodeId) => {
          const node = graph.nodes[nodeId];
          return node === undefined ? undefined : parametersOf(node, graph).values;
        },
        frame: (lens) => {
          const facts = pictureFacts(windowId, graph);
          return facts === null ? WAITING_NOTE : { size: facts.inputSize, place: (size) => windowPicture(facts, size, lens) };
        },
        message: session.message,
      });
    };
    const refresh = (windowId: string): void => {
      const session = mapping.current.get(windowId);
      if (session !== undefined) session.overlay.update(viewOf(windowId, session));
    };
    const end = (windowId: string): void => {
      const session = mapping.current.get(windowId);
      if (session === undefined) return;
      mapping.current.delete(windowId);
      session.overlay.dispose();
      session.editor.dispose();
    };
    /** The editor's token values, for a document that does not carry its stylesheet. */
    const tokens = (): Record<string, string> => {
      if (typeof window === "undefined") return {};
      const style = window.getComputedStyle(window.document.documentElement);
      return Object.fromEntries(MAPPING_OVERLAY_TOKENS.map((name) => [name, style.getPropertyValue(name).trim()]));
    };
    const set = (windowId: string, on: boolean): void => {
      const handle = handles.current.get(windowId);
      if (!on || handle === undefined) end(windowId);
      else if (!mapping.current.has(windowId)) {
        const editor = createParameterEditor({ bus, context: invocationRef.current });
        const report = (result: { status: string; diagnostics?: ReadonlyArray<{ message: string }> | undefined }): void => {
          const session = mapping.current.get(windowId);
          if (session === undefined) return;
          session.message = result.status === "applied" ? null : (result.diagnostics?.[0]?.message ?? "The edit was refused.");
          refresh(windowId);
        };
        // §T1534b's line insert/delete, on the bus as the tile's (`graph-pane.tsx`).
        const lines: GridLineActions = {
          insert: (nodeId, axis, at) => void bus.execute("gridWarp.insertLine", { nodeId, axis, at }, invocationRef.current).then(report),
          remove: (nodeId, axis, index) => void bus.execute("gridWarp.deleteLine", { nodeId, axis, index }, invocationRef.current).then(report),
        };
        const overlay = createMappingOverlay({ window: handle.window, store: createVec3GizmoStore({ editor }), lines, tokens: tokens() });
        mapping.current.set(windowId, { message: null, overlay, editor });
        refresh(windowId);
      }
      // The operator points at the projector while mapping: Hide cursor yields to the mode.
      const node = handle === undefined ? undefined : authored().nodes[windowId];
      if (handle !== undefined && node !== undefined) handle.setHideCursor(hideCursorOf(windowId, node, authored()));
      notify();
    };
    return {
      set,
      end,
      refresh,
      refreshAll: () => {
        for (const windowId of mapping.current.keys()) refresh(windowId);
      },
      notify,
      choose(windowId: string, nodeId: string) {
        choices.current.set(windowId, nodeId);
        refresh(windowId);
        notify();
      },
      view(windowId: string): WindowMappingView {
        const targets = targetsOf(windowId, authored());
        return {
          editing: mapping.current.has(windowId),
          targets: targets.map((target) => ({ nodeId: target.nodeId, label: `${target.title} "${target.name}"`, refusal: target.refusal })),
          chosen: chosenOf(windowId, targets)?.nodeId,
        };
      },
      /** `M` toggles, Escape leaves (and is left to the keymap when the mode is off). */
      key(windowId: string, key: "toggle" | "leave"): boolean {
        const on = mapping.current.has(windowId);
        if (key === "leave" && !on) return false;
        set(windowId, key === "toggle" ? !on : false);
        return true;
      },
    };
  }, [bus, parametersOf, hideCursorOf]);

  const windows = useMemo<PerformWindows>(() => {
    const graph = (): GraphDocument => bus.store.getGraph();
    const windowNodes = (): string[] =>
      Object.values(graph().nodes)
        .filter((node) => node.type === WINDOW_OUT_TYPE)
        .map((node) => node.id)
        .sort();
    return {
      windowNodes,
      isOpen: (nodeId) => handles.current.has(nodeId),
      openIds: () => [...handles.current.keys()].sort(),
      available: () => backendRef.current !== undefined && backendRef.current !== null && typeof window !== "undefined",
      open(nodeIds) {
        const active = backendRef.current;
        if (active === undefined || active === null || typeof window === "undefined") return [...nodeIds];
        const blocked: string[] = [];
        authoredRef.current = graph();
        for (const nodeId of nodeIds) {
          const node = graph().nodes[nodeId];
          if (node === undefined || handles.current.has(nodeId)) continue;
          const parameters = parametersOf(node, graph());
          const fullscreen = booleanParameter(parameters, "fullscreen", true);
          const target = resolveScreen(screens.screens(), stringParameter(parameters, "screen", ""), screens.editor());
          const handle = openPerformWindow(
            {
              open: openRef.current ?? browserPerformOpener(window),
              present: (canvas, options) => active.present(canvas, options),
              parent: window,
            },
            {
              nodeId,
              name: performWindowName(nodeId),
              title: `Loom — ${node.label ?? nodeId}`,
              features: placementFeatures(target.screen, { fullscreen: fullscreen && screens.permission() === "granted" }),
              outputId: outputFor(nodeId),
              fullscreen,
              hideCursor: booleanParameter(parameters, "hideCursor", true),
              onClosed: (id) => {
                mappingOps.end(id);
                if (!handles.current.delete(id)) return;
                changed.current();
              },
              onMappingKey: mappingOps.key,
            },
          );
          if (handle === null) blocked.push(nodeId);
          else handles.current.set(nodeId, handle);
        }
        changed.current();
        return blocked;
      },
      close(nodeIds) {
        for (const nodeId of nodeIds) {
          const handle = handles.current.get(nodeId);
          if (handle === undefined) continue;
          mappingOps.end(nodeId);
          handles.current.delete(nodeId);
          handle.close();
        }
        changed.current();
      },
    };
  }, [bus, screens, parametersOf, mappingOps]);

  // §B48: registered at mount, whatever the backend; the holder is ours while mounted.
  useEffect(() => {
    const holder = registerPerformCommands(bus);
    holder.current = windows;
    return () => {
      if (holder.current === windows) holder.current = null;
    };
  }, [bus, windows]);

  // A new plan: every open window follows its node's `$target` (the first compile after an
  // open is the one that gives it one).
  useEffect(() => {
    for (const [nodeId, handle] of handles.current) handle.setOutput(outputFor(nodeId));
    mappingOps.refreshAll();
  }, [plan, mappingOps]);

  // The document moved: a deleted Window Out closes its window; Hide cursor applies live.
  useEffect(
    () =>
      bus.store.subscribe(() => {
        const authored = bus.store.getGraph();
        authoredRef.current = authored;
        const nodes = authored.nodes;
        const gone: string[] = [];
        for (const [nodeId, handle] of handles.current) {
          const node = nodes[nodeId];
          if (node === undefined || node.type !== WINDOW_OUT_TYPE) gone.push(nodeId);
          else handle.setHideCursor(hideCursorOf(nodeId, node, authored));
        }
        if (gone.length > 0) windows.close(gone);
        // §T1536b: a dragged handle lands in the document first; the window follows it.
        mappingOps.refreshAll();
        if (handles.current.size > 0) mappingOps.notify();
      }),
    [bus, windows, mappingOps, hideCursorOf],
  );

  /*
   * §V202, T303 — the show follows the VISIBLE surface. The newest open perform window
   * whose document is visible drives the realtime loop, so hiding or backgrounding the
   * editor no longer freezes it; with none visible the loop returns to the editor's frames.
   * Re-chosen on open/close and whenever any of those documents changes visibility.
   */
  useEffect(() => {
    if (backend === undefined || backend === null || backend.setFrameSource === undefined) return;
    const choose = (): void => {
      const visible = [...handles.current.values()]
        .reverse()
        .find((handle) => !handle.closed && handle.window.document.visibilityState === "visible");
      backend.setFrameSource?.(visible === undefined ? null : visible.window);
    };
    choose();
    const documents = [...handles.current.values()].map((handle) => handle.window.document);
    for (const doc of documents) doc.addEventListener("visibilitychange", choose);
    return () => {
      for (const doc of documents) doc.removeEventListener("visibilitychange", choose);
      backend.setFrameSource?.(null);
    };
  }, [backend, open]);

  // A new device (or none) cannot present into the old surfaces: close, and unmount closes.
  useEffect(() => () => windows.close([...handles.current.keys()]), [backend, windows]);

  const surface = useMemo<WindowSectionSurface>(
    () => ({
      screens: () => screens.screens(),
      permission: () => screens.permission(),
      requestScreenAccess: () => screens.request(),
      isOpen: (nodeId) => handles.current.has(nodeId),
      describe(nodeId) {
        const authored = bus.store.getGraph();
        const node = authored.nodes[nodeId];
        if (node === undefined) return "";
        const resolved = resolveScreen(screens.screens(), stringParameter(parametersOf(node, authored), "screen", ""), screens.editor());
        const where = resolved.screen === undefined ? "this screen" : resolved.screen.label;
        const size = resolved.screen === undefined ? "" : ` (${physicalSize(resolved.screen).join("×")} physical)`;
        const state = handles.current.has(nodeId) ? `Open on ${where}` : `Closed — opens on ${where}${size}`;
        return resolved.warning === undefined ? state : `${state}. ${resolved.warning}`;
      },
      mapping: (nodeId) => mappingOps.view(nodeId),
      setEditingMapping: (nodeId, on) => mappingOps.set(nodeId, on),
      chooseMapping: (nodeId, mappingNodeId) => mappingOps.choose(nodeId, mappingNodeId),
      subscribe(listener) {
        listeners.current.add(listener);
        const off = screens.subscribe(listener);
        return () => {
          listeners.current.delete(listener);
          off();
        };
      },
    }),
    [bus, screens, parametersOf, mappingOps],
  );

  const observe = useCallback(
    (frame: FrameEvaluationInput) => {
      const authored = authoredRef.current;
      if (handles.current.size === 0 || authored === null) return;
      for (const [nodeId, handle] of handles.current) {
        const node = authored.nodes[nodeId];
        if (node === undefined || node.type !== WINDOW_OUT_TYPE) continue;
        handle.setHideCursor(hideCursorOf(nodeId, node, authored, frame));
      }
    },
    [hideCursorOf],
  );

  return { surface, windows: open, observe };
}
