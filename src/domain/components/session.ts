import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { ComponentId } from "../types/ids.ts";
import type { IdFactory } from "../graph/ids.ts";
import type { GraphStore } from "../graph/store.ts";
import { createGraphStore } from "../graph/store.ts";
import type { LoomBus } from "../commands/bus.ts";
import { createDomainBus } from "../commands/index.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { pruneComponentDefinition } from "./definition.ts";
import { registerComponentCommands } from "./commands.ts";
import type { ComponentRegistry } from "./registry.ts";

/**
 * Editing the inside of a component (T130).
 *
 * A component's internal network is a `GraphDocument`, and the thing that edits a
 * `GraphDocument` correctly already exists: a `GraphStore` behind a command bus. So
 * entering a component opens one of those over the definition's internal graph, and every
 * command the editor already has — add node, connect, set parameters, undo, redo, the
 * audit log — works inside a component with no second implementation and no second set of
 * invariants to keep in step (§V29, §V32, §V34).
 *
 * That is also what makes §V80 real rather than aspirational: turning a published knob
 * inside a component is `graph.applyPatch` with N `setParameters` operations, which the
 * store already guarantees is atomic and one undo group.
 *
 * Every committed change is written back into the catalogue, so a fix reaches every
 * linked instance immediately (§V79). Nesting needs nothing extra: a component inside a
 * component is entered by opening a session on it in turn.
 *
 * ## A write from OUTSIDE the session (§T1540b)
 *
 * The catalogue has other writers: a Store or Delete on a look instance writes its page
 * bank into this definition from the root bus, `preset.moveIntoComponent` adds a bank, an
 * import replaces the definition. The session's store still holds the graph it last
 * wrote, so its next commit — even an unrelated rename, even an undo — would register
 * that stale graph and silently drop the outside write.
 *
 * The session therefore tracks the graph it last synced with the catalogue. When the
 * catalogue's graph moves away from it, the session is STALE: it says so once through
 * `onStale` (`component.session.stale`), and from then on it refuses to write back — the
 * same refusal, by name. It does not merge in place: a `GraphStore` cannot adopt a graph
 * (no `replaceGraph`, and an `addNode` patch cannot reproduce the outside write's ids),
 * and its undo history holds entity states from before the write, so undoing across it
 * would drop the write too. The holder reopens a session over the new definition instead
 * (`use-component-editing.ts`) — the rebase. Nothing is lost there: every valid session
 * edit has already been committed by the time anything else can write, so the session
 * holds nothing the new definition lacks; what restarts is its undo history.
 */

export interface ComponentSession {
  componentId: ComponentId;
  version: number;
  bus: LoomBus;
  store: GraphStore;
  /** Stops syncing. The definition keeps whatever was last committed. */
  dispose: () => void;
}

export interface ComponentSessionOptions {
  components: ComponentRegistry;
  /** The COMPONENT-AWARE node registry, so nested components resolve inside. */
  nodes: NodeRegistryView;
  componentId: ComponentId;
  version: number;
  ids?: IdFactory;
  /**
   * Called when an edit leaves the definition in a state the catalogue refuses — in
   * practice only recursion, since dangling exposures are pruned. The edit stays in the
   * session; the definition keeps its last valid graph, and the user is told (§V83).
   */
  onInvalid?: (diagnostics: readonly RuntimeDiagnostic[]) => void;
  /**
   * §T1540b: the definition was changed by something other than this session. Called once,
   * on the outside write; every later commit of this session is refused. The holder should
   * reopen a session over the current definition.
   */
  onStale?: (diagnostic: RuntimeDiagnostic) => void;
}

export const COMPONENT_SESSION_STALE_CODE = "component.session.stale";

export function openComponentSession(options: ComponentSessionOptions): ComponentSession {
  const definition = options.components.get(options.componentId, options.version);
  if (definition === undefined) {
    throw new Error(
      `Cannot edit component "${options.componentId}" version ${options.version}: it is not installed.`,
    );
  }

  const store = createGraphStore({
    initialGraph: definition.graph,
    ...(options.ids === undefined ? {} : { ids: options.ids }),
  });
  const { bus } = createDomainBus({ store, registry: options.nodes });
  registerComponentCommands(bus, {
    components: options.components,
    host: { componentId: options.componentId, version: options.version },
  });

  // The definition graph this session and the catalogue last agreed on. Identity is the
  // test: every writer registers a new graph object, and nothing else replaces it.
  let synced = definition.graph;
  let stale = false;
  const outsideWrite = `Component "${definition.name}" was changed outside this editor (a preset stored on an instance, a move, an import)`;
  const markStale = (): void => {
    if (stale) return;
    stale = true;
    options.onStale?.({
      severity: "warning",
      code: COMPONENT_SESSION_STALE_CODE,
      message: `${outsideWrite}.`,
      suggestion: "Reopen the component to edit the current definition; its undo history starts again there.",
    });
  };

  const unsubscribeCatalogue = options.components.subscribe(() => {
    const current = options.components.get(options.componentId, options.version);
    if (current !== undefined && current.graph !== synced) markStale();
  });

  const unsubscribe = store.view.subscribe((state, previous) => {
    if (state.graph === previous.graph) return;
    const current = options.components.get(options.componentId, options.version);
    if (current === undefined) return;
    // The backstop: never register a graph built on a definition that has moved on.
    if (stale || current.graph !== synced) {
      markStale();
      options.onInvalid?.([
        {
          severity: "error",
          code: COMPONENT_SESSION_STALE_CODE,
          message: `${outsideWrite}, so this edit was not written over it.`,
          suggestion: "Reopen the component and make the edit again on the current definition.",
        },
      ]);
      return;
    }
    const next = pruneComponentDefinition({ ...current, graph: state.graph }, options.nodes, options.components);
    const problems = options.components.validate(next);
    if (problems.some((diagnostic) => diagnostic.severity === "error")) {
      options.onInvalid?.(problems);
      return;
    }
    // Before `register`, whose notification re-enters the catalogue listener above.
    const before = synced;
    synced = state.graph;
    try {
      options.components.register(next);
    } catch (error) {
      synced = before;
      throw error;
    }
  });

  return {
    componentId: options.componentId,
    version: options.version,
    bus,
    store,
    dispose: () => {
      unsubscribe();
      unsubscribeCatalogue();
    },
  };
}
