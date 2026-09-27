import { useEffect, useMemo, useRef, useState } from "react";
import { SINK_TARGET_PORT } from "@compiler/index.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { WindowSectionSurface } from "@editor/inspector/window-section.tsx";
import { WINDOW_OUT_TYPE } from "@nodes/definitions/window-out.ts";
import type { LoomBackend } from "@runtime/backend/backend-types.ts";
import type { DisplaySinkStore } from "./display-sinks.ts";
import { registerPerformCommands } from "./perform-commands.ts";
import type { PerformWindows } from "./perform-commands.ts";
import { createScreenSource, performWindowName, physicalSize, placementFeatures, resolveScreen } from "./perform-screens.ts";
import type { ScreenSource } from "./perform-screens.ts";
import { browserPerformOpener, openPerformWindow } from "./perform-window.ts";
import type { PerformWindowHandle } from "./perform-window.ts";

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

/** The slice of a compiled plan this needs: where each node's `$target` lives. */
export interface PerformPlan {
  readonly outputs: ReadonlyArray<{ readonly nodeId: string; readonly portId: string; readonly resourceId: string }>;
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
}

export interface PerformWindowsResult {
  readonly surface: WindowSectionSurface;
  /** The open windows, for their keymap targets (so the perform key works inside them). */
  readonly windows: readonly Window[];
}

const stringParameter = (node: GraphNode, key: string, fallback: string): string => {
  const value = node.parameters[key];
  return typeof value === "string" ? value : fallback;
};
const booleanParameter = (node: GraphNode, key: string, fallback: boolean): boolean => {
  const value = node.parameters[key];
  return typeof value === "boolean" ? value : fallback;
};

const NO_SCREENS: ScreenSource = {
  screens: () => [],
  editor: () => undefined,
  permission: () => "unsupported",
  request: () => Promise.resolve(),
  subscribe: () => () => {},
};

export function usePerformWindows({ bus, backend, plan, displaySinks, openWindow, screenSource }: PerformWindowsOptions): PerformWindowsResult {
  const screens = useMemo(
    () => screenSource ?? (typeof window === "undefined" ? NO_SCREENS : createScreenSource(window)),
    [screenSource],
  );
  const openRef = useRef(openWindow);
  openRef.current = openWindow;
  const handles = useRef(new Map<string, PerformWindowHandle>());
  const [open, setOpen] = useState<readonly Window[]>([]);
  const listeners = useRef(new Set<() => void>());
  const planRef = useRef(plan);
  planRef.current = plan;
  const backendRef = useRef(backend);
  backendRef.current = backend;

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
        for (const nodeId of nodeIds) {
          const node = graph().nodes[nodeId];
          if (node === undefined || handles.current.has(nodeId)) continue;
          const fullscreen = booleanParameter(node, "fullscreen", true);
          const target = resolveScreen(screens.screens(), stringParameter(node, "screen", ""), screens.editor());
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
              hideCursor: booleanParameter(node, "hideCursor", true),
              onClosed: (id) => {
                if (!handles.current.delete(id)) return;
                changed.current();
              },
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
          handles.current.delete(nodeId);
          handle.close();
        }
        changed.current();
      },
    };
  }, [bus, screens]);

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
  }, [plan]);

  // The document moved: a deleted Window Out closes its window; Hide cursor applies live.
  useEffect(
    () =>
      bus.store.subscribe(() => {
        const nodes = bus.store.getGraph().nodes;
        const gone: string[] = [];
        for (const [nodeId, handle] of handles.current) {
          const node = nodes[nodeId];
          if (node === undefined || node.type !== WINDOW_OUT_TYPE) gone.push(nodeId);
          else handle.setHideCursor(booleanParameter(node, "hideCursor", true));
        }
        if (gone.length > 0) windows.close(gone);
      }),
    [bus, windows],
  );

  // A new device (or none) cannot present into the old surfaces: close, and unmount closes.
  useEffect(() => () => windows.close([...handles.current.keys()]), [backend, windows]);

  const surface = useMemo<WindowSectionSurface>(
    () => ({
      screens: () => screens.screens(),
      permission: () => screens.permission(),
      requestScreenAccess: () => screens.request(),
      isOpen: (nodeId) => handles.current.has(nodeId),
      describe(nodeId) {
        const node = bus.store.getGraph().nodes[nodeId];
        if (node === undefined) return "";
        const resolved = resolveScreen(screens.screens(), stringParameter(node, "screen", ""), screens.editor());
        const where = resolved.screen === undefined ? "this screen" : resolved.screen.label;
        const size = resolved.screen === undefined ? "" : ` (${physicalSize(resolved.screen).join("×")} physical)`;
        const state = handles.current.has(nodeId) ? `Open on ${where}` : `Closed — opens on ${where}${size}`;
        return resolved.warning === undefined ? state : `${state}. ${resolved.warning}`;
      },
      subscribe(listener) {
        listeners.current.add(listener);
        const off = screens.subscribe(listener);
        return () => {
          listeners.current.delete(listener);
          off();
        };
      },
    }),
    [bus, screens],
  );

  return { surface, windows: open };
}
