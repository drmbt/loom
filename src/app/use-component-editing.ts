import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LoomBus } from "@domain/commands/bus.ts";
import type { ComponentPath, GraphComponentDefinition } from "@domain/types/components.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { revisionWatchFor } from "./revision-watch.ts";
import { openComponentSession } from "@domain/components/session.ts";
import type { ComponentSession } from "@domain/components/session.ts";
import type { Breadcrumb, ResolvedComponentPath } from "@domain/components/navigation.ts";
import { resolveComponentNavigation } from "@editor/component/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { registerForwardedResetFeedback } from "./runtime-commands.ts";
import type { InstanceParameters } from "@editor/inspector/instance-parameters.ts";
import { flattenedNodeId } from "@compiler/flatten.ts";
import {
  createComponentNavigationStore,
  navigationHolderFor,
  registerComponentNavigationCommands,
} from "./component-navigation.ts";

/**
 * Editing inside a component (T423, T130, §V82).
 *
 * ## What actually changes when you dive in
 *
 * ONE thing: which graph the canvas and the inspector edit. The compile, the frame loop,
 * the viewer and the transport keep running against the ROOT document, because that is
 * what the project renders — walking into a component to fix a blur must not blank the
 * output, and TouchDesigner's network editor behaves the same way for the same reason.
 *
 * ## Why a second store, and why that is not a second mutation path
 *
 * A component's internals are a `GraphDocument` that is NOT in the project document
 * (§V79) — it lives in the catalogue, once, shared by every linked instance. The thing
 * that edits a `GraphDocument` correctly already exists, so `openComponentSession` opens
 * one of those over the definition and writes every committed change back to the
 * catalogue. Add-node, connect, undo, redo, the audit log and §V32's atomicity all work
 * inside a component with no second implementation (§V29 is about there being one KIND of
 * mutation path, and this is that kind, pointed at the other document).
 *
 * The session bus also carries `host`, which is what makes `component.publishParameter`,
 * `component.exposePort` and the rest legal: they are things you do while INSIDE a
 * component, and on the root bus they refuse by name.
 *
 * ## What does NOT work inside a component yet, stated rather than hidden
 *
 * Preview tiles and per-node error badges. Both are keyed on DOCUMENT node ids, and
 * `flattenComponents` prefixes an internal node's id with its instance chain (`c1/blurA`)
 * — so the flat plan does hold the internal node, under a name the canvas never asks for.
 * The honest consequence is that `compiledOutputs` is empty inside a component rather
 * than a root plan whose ids could collide with internal ones; a preview that showed the
 * WRONG node's picture would be far worse than no preview (§V8, B41's shape).
 */

export interface ComponentEditing {
  /** Instance-node chain from the root, innermost last. Empty is the root document. */
  path: ComponentPath;
  breadcrumbs: readonly Breadcrumb[];
  /** The graph the canvas edits: the root document, or a component's internals. */
  graph: GraphDocument;
  /** The bus the canvas and inspector mutate through — session bus when inside. */
  bus: LoomBus;
  /** A runtime whose `bus` is the one above, for the panes that read it from context. */
  runtime: AppRuntime;
  /** The component being edited, or null at the root. */
  definition: GraphComponentDefinition | null;
  insideComponent: boolean;
  /** The active instance's effective child parameters and their published owners. */
  instanceParameters: InstanceParameters | undefined;
  /**
   * What the editor had to say, for the Problems list (§T1543b): the path that stopped
   * resolving and put the user back out (a stale instance, an uninstalled component,
   * §V82), and the session reopened over an outside write (§T1540b). Both are EVENTS —
   * the path has already been truncated, the session already reopened — so they are held
   * until the Problems list's Clear (T465) or the next project (T792), like every other
   * accumulating source.
   */
  diagnostics: readonly RuntimeDiagnostic[];
  /** T465: empty the held notes; nothing here is still true once it has been said. */
  clearDiagnostics: () => void;
  navigate: (path: ComponentPath) => void;
  exit: () => void;
}

const NO_NOTES: readonly RuntimeDiagnostic[] = [];

export function useComponentEditing(runtime: AppRuntime): ComponentEditing {
  const store = useMemo(() => createComponentNavigationStore(), []);
  const path = useSyncExternalStore(store.subscribe, store.getPath, store.getPath);

  /*
   * T1652b: both documents this hook holds are read for their STRUCTURE — where a path
   * leads, which graph the canvas edits — so both are notified for structure only
   * (`revision-watch.ts`): a moved slider is not a reason to render `App` from here. The
   * snapshot stays the store's own document, so a render for anything else reads what the
   * store holds. The panes that show values take theirs through `LiveGraph` (`app.tsx`).
   */
  const rootWatch = useMemo(() => revisionWatchFor(runtime.bus.store, runtime.registry), [runtime.bus.store, runtime.registry]);
  const rootGraph = useSyncExternalStore<GraphDocument>(
    rootWatch.subscribeStructure,
    runtime.bus.store.getGraph,
    runtime.bus.store.getGraph,
  );

  // Re-authoring a component is not a document edit, so the graph store never fires for
  // it and the resolved path would keep the definition it saw when the user entered.
  const [catalogueRevision, bumpCatalogue] = useState(0);
  useEffect(
    () => runtime.components.subscribe(() => bumpCatalogue((count) => count + 1)),
    [runtime.components],
  );

  const componentsView = useMemo(() => runtime.components.view(), [runtime.components]);

  const resolved: ResolvedComponentPath = useMemo(
    () => {
      void catalogueRevision;
      return resolveComponentNavigation({
        root: rootGraph,
        path,
        components: componentsView,
        nodes: runtime.registry,
      });
    },
    [catalogueRevision, componentsView, path, rootGraph, runtime.registry],
  );

  /**
   * The commands need `resolve()` synchronously, from a handler that runs outside React.
   * A ref rather than a closure over `resolved`: the bus registration happens once, and a
   * handler holding the first render's walk would dive relative to wherever the user was
   * when the app booted.
   */
  const resolvedRef = useRef(resolved);
  resolvedRef.current = resolved;

  const holder = useMemo(() => navigationHolderFor(runtime.bus), [runtime.bus]);
  useEffect(() => {
    registerComponentNavigationCommands(runtime.bus);
    holder.current = {
      getPath: store.getPath,
      setPath: store.setPath,
      subscribe: store.subscribe,
      resolve: () => resolvedRef.current,
      components: componentsView,
    };
    return () => {
      holder.current = null;
    };
  }, [componentsView, holder, runtime.bus, store]);

  /**
   * A path that stopped resolving — the instance was deleted, the component uninstalled —
   * truncates rather than throwing, and the editor follows it back to somewhere real.
   *
   * IT RE-RESOLVES AGAINST THE LIVE STORES rather than trusting `resolved`, and that is
   * the whole point of the effect. `resolved` is a memo over THREE independent sources —
   * the navigation store, the graph store and a catalogue counter that arrives as ordinary
   * React state — so a render can legitimately hold a path from one of them beside a
   * snapshot from another. Observed live: entering a component saved seconds earlier
   * ejected the user back to the root on the next click, from a one-render disagreement
   * and not from anything being wrong. Ejecting someone out of the network they are
   * editing is not a recoverable mistake, so the decision is made from what is true NOW,
   * and a path that is merely momentarily unresolvable stays put.
   */
  /*
   * §T1543b — and the reason it put them back out is HELD. The walk's own diagnostics
   * cannot carry it: the path is truncated in this same effect, so the next render
   * resolves cleanly and the reason is gone before anyone could read it.
   */
  const [ejected, setEjected] = useState<readonly RuntimeDiagnostic[]>(NO_NOTES);
  useEffect(() => {
    if (path.length === 0) return;
    const live = resolveComponentNavigation({
      root: runtime.bus.store.getGraph(),
      path,
      components: componentsView,
      nodes: runtime.registry,
    });
    if (live.resolvedPath.length === path.length) return;
    store.setPath(live.resolvedPath);
    if (live.diagnostics.length === 0) return;
    setEjected((current) => [
      ...current,
      ...live.diagnostics.filter((note) => !current.some((held) => held.code === note.code && held.message === note.message)),
    ]);
  }, [componentsView, path, resolved, runtime.bus, runtime.registry, store]);

  const innermost = resolved.frames[resolved.frames.length - 1];
  const componentId = innermost?.componentId ?? null;
  const version = innermost?.version ?? null;

  /**
   * §T1540b — THE REBASE. A session whose definition was written from outside (a Store on
   * a look instance, a move, an import) goes stale and refuses to write back
   * (`session.ts`). Bumping `reopened` reopens every session over the definition as it is
   * NOW, so the next edit builds on the outside write instead of being refused; `rebased`
   * is the note that says the undo history inside restarted.
   */
  const [reopened, setReopened] = useState(0);
  const [rebased, setRebased] = useState<RuntimeDiagnostic | null>(null);
  const onStale = useCallback((diagnostic: RuntimeDiagnostic) => {
    setRebased({
      ...diagnostic,
      severity: "info",
      suggestion: "The editor reopened it over the current definition, so nothing was lost; undo inside it starts again here.",
    });
    setReopened((count) => count + 1);
  }, []);
  useEffect(() => setRebased(null), [componentId, version]);
  // T792: both notes are about the OUTGOING project, so they empty at the boundary. Declared
  // AFTER the path walk on purpose: a new project truncates the old path in the same commit
  // (it never existed there), and that is not news — this empties it before it is seen.
  useEffect(() => {
    setRebased(null);
    setEjected(NO_NOTES);
  }, [runtime]);
  const clearDiagnostics = useCallback(() => {
    setRebased(null);
    setEjected(NO_NOTES);
  }, []);
  const diagnostics = useMemo(
    () => (rebased === null ? ejected : [...ejected, rebased]),
    [ejected, rebased],
  );

  // T1545b: the project document, READ-ONLY, for the sessions below — so an in-session
  // detach can name the root paths it leaves dangling. They never write it.
  const readRoot = useCallback(() => runtime.bus.store.getGraph(), [runtime.bus]);

  const [session, setSession] = useState<ComponentSession | null>(null);
  useEffect(() => {
    if (componentId === null || version === null) {
      setSession(null);
      return;
    }
    // Keyed on the component and version ALONE (and on `reopened`, the outside-write
    // rebase above). Re-keying on the definition object would reopen the session on every
    // edit the session itself makes, throwing away the undo history the user is standing
    // in the middle of.
    void reopened;
    const opened = openComponentSession({
      components: runtime.components,
      nodes: runtime.registry,
      componentId,
      version,
      onStale,
      root: readRoot,
    });
    // VNB6: a Reset pulse fired in here clears the viewed instance's history in the
    // document's plan — the session bus has no renderer of its own to ask.
    registerForwardedResetFeedback(opened.bus, runtime.bus, store.getPath);
    setSession(opened);
    return () => {
      opened.dispose();
      setSession(null);
    };
  }, [componentId, onStale, readRoot, reopened, runtime.bus, runtime.components, runtime.registry, store, version]);

  const live = session !== null && session.componentId === componentId && session.version === version;
  const editBus = live && session !== null ? session.bus : runtime.bus;

  // Private published values belong to the instance one level out. Keep that author's
  // ordinary command session alive so a child edit has the same undo history as its owner.
  const ancestorIdentity = JSON.stringify(resolved.frames.slice(0, -1).map(frame => [frame.componentId, frame.version]));
  const [ancestorSessions, setAncestorSessions] = useState<ReadonlyMap<string, ComponentSession>>(new Map());
  useEffect(() => {
    const opened = new Map<string, ComponentSession>();
    for (const frame of resolvedRef.current.frames.slice(0, -1)) {
      const key = JSON.stringify([frame.componentId, frame.version]);
      if (opened.has(key)) continue;
      opened.set(key, openComponentSession({ components: runtime.components, nodes: runtime.registry,
        componentId: frame.componentId, version: frame.version, onStale, root: readRoot }));
    }
    setAncestorSessions(current => current.size === 0 && opened.size === 0 ? current : opened);
    return () => { for (const owner of opened.values()) owner.dispose(); };
    // `reopened`: an outside write to an ancestor's definition rebases its session too (§T1540b).
  }, [ancestorIdentity, onStale, readRoot, reopened, runtime.components, runtime.registry]);

  const editWatch = useMemo(() => revisionWatchFor(editBus.store, runtime.registry), [editBus.store, runtime.registry]);
  const graph = useSyncExternalStore<GraphDocument>(
    editWatch.subscribeStructure,
    editBus.store.getGraph,
    editBus.store.getGraph,
  );

  const scopedRuntime = useMemo<AppRuntime>(
    () => (editBus === runtime.bus ? runtime : { ...runtime, bus: editBus }),
    [editBus, runtime],
  );

  const navigate = useCallback((next: ComponentPath) => store.setPath(next), [store]);
  const exit = useCallback(() => store.setPath(path.slice(0, -1)), [path, store]);

  const instanceParameters = useMemo<InstanceParameters | undefined>(() => {
    if (path.length === 0) return undefined;
    const prefix = path.join("/");
    return {
      bus: runtime.bus,
      channelTarget(nodeId) {
        return { bus: runtime.bus, nodeId: path[0]!, internalNodeId: [...path.slice(1), nodeId].join("/") };
      },
      read(nodeId) {
        const flattened = runtime.flattened.current();
        const flatId = flattenedNodeId(prefix, nodeId);
        const node = flattened.graph.nodes[flatId] ?? flattened.instanceNodes.get(flatId);
        return node === undefined ? undefined : { graph: flattened.graph, node };
      },
      target(nodeId, key) {
        const origins = runtime.flattened.current().publishedOrigins.get(flattenedNodeId(prefix, nodeId));
        const publishedKey = Object.keys(origins ?? {}).filter(candidate => key === candidate || key.startsWith(`${candidate}.`))
          .sort((a, b) => b.length - a.length)[0];
        const origin = publishedKey === undefined ? undefined : origins?.[publishedKey];
        if (origin !== undefined && publishedKey !== undefined) {
          return { bus: runtime.bus, nodeId: origin.nodeId, key: `${origin.key}${key.slice(publishedKey.length)}` };
        }
        // The compiler's root-origin map deliberately omits PRIVATE nested pages.
        // Follow the same published target chain until its nearest stored owner.
        const frames = resolveComponentNavigation({ root: runtime.bus.store.getGraph(), path,
          components: componentsView, nodes: runtime.registry }).frames;
        let targetId = nodeId;
        let targetKey = key;
        let ownerDepth: number | undefined;
        for (let index = frames.length - 1; index >= 0; index -= 1) {
          const frame = frames[index]!;
          const published = frame.definition.parameters.findLast(parameter => parameter.targets.some(target =>
            target.nodeId === targetId && (targetKey === target.key || targetKey.startsWith(`${target.key}.`))));
          if (published === undefined) break;
          const matched = published.targets.find(target => target.nodeId === targetId &&
            (targetKey === target.key || targetKey.startsWith(`${target.key}.`)))!;
          targetKey = `${published.key}${targetKey.slice(matched.key.length)}`;
          targetId = frame.instanceNodeId;
          ownerDepth = index - 1;
        }
        if (ownerDepth === undefined) return undefined;
        if (ownerDepth < 0) return { bus: runtime.bus, nodeId: targetId, key: targetKey };
        const owner = frames[ownerDepth]!;
        const ownerSession = ancestorSessions.get(JSON.stringify([owner.componentId, owner.version]));
        if (ownerSession === undefined) throw new Error("The published parameter's authoring session is not ready.");
        return { bus: ownerSession.bus, nodeId: targetId, key: targetKey };
      },
    };
  }, [ancestorSessions, componentsView, path, runtime]);

  return {
    path,
    breadcrumbs: resolved.breadcrumbs,
    graph,
    bus: editBus,
    runtime: scopedRuntime,
    definition: live ? (innermost?.definition ?? null) : null,
    insideComponent: componentId !== null,
    instanceParameters,
    diagnostics,
    clearDiagnostics,
    navigate,
    exit,
  };
}
