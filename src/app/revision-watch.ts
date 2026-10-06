import type { GraphStoreView } from "@domain/graph/store.ts";
import type { GraphDocument, ProjectSettings } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { classifyRevision } from "./classify-revision.ts";

/**
 * T1652b — ONE READING OF EVERY REVISION, for everything that used to subscribe to the
 * store at the composition root.
 *
 * The root subscribed to the document three times (the compile, the requirement
 * diagnostics, the component editor) and each subscription re-rendered `App` on every
 * revision, a moved slider included. This is the one subscription they share. It reads
 * each revision once (`classifyRevision`) and tells two kinds of listener apart:
 *
 *  - STRUCTURE listeners hear every revision that is not values-only. `structure()` is
 *    the document as of the last such revision: the same nodes, wires, modes, names and
 *    strings as the store's, and VALUES THAT MAY BE OLDER. The root renders from it.
 *  - VALUES listeners hear the values-only ones, with the nodes written. A surface that
 *    SHOWS a value listens here and reads the store (`useLiveGraph`).
 *
 * ## The lane goes first, and its doubt is everyone's
 *
 * The compile's values lane (`use-graph-compile.ts`) is asked before any values listener.
 * When it cannot follow the revision without a structural compile it says why, and the
 * revision is then a STRUCTURAL one for every listener: the root renders, compiles in
 * full and reports whatever changed. So a values listener never hears of a revision the
 * plan could not follow. Each such refusal is counted with its reason (`stats`), because
 * a write that should have been cheap and was not must be findable.
 *
 * ## What a values-only revision is
 *
 * `classifyRevision`, and nothing here adds to it except the SETTINGS: a settings edit
 * bumps the revision with no node changed (§V177), which is structure by that function's
 * own rule; the settings object is compared too so a settings write that happened to ride
 * with a value cannot be taken for one.
 */

export interface ValuesRevision {
  /** The document before the revision. */
  readonly previous: GraphDocument;
  /** The store's document: the revision itself. */
  readonly graph: GraphDocument;
  /** The nodes a value moved on, sorted by id. */
  readonly written: readonly NodeId[];
}

/** The compile's answer to a values-only revision: null when it followed, else why not. */
export type ValuesLane = (revision: ValuesRevision) => string | null;

/**
 * Counts SINCE THE DOCUMENT WAS OPENED, and that reset is deliberate: a watch belongs to one
 * store, a store to one runtime, and opening a document builds a new runtime
 * (`AppRuntime.documentIdentity`). So the Performance panel's line is read after a drag,
 * not during it, and never carries another document's writes.
 */
export interface RevisionStats {
  /** Values-only revisions that reached the values listeners. */
  readonly values: number;
  /** Values-only revisions the lane could not follow, sent down the structural road. */
  readonly escalated: number;
  /** Why the last one was (`null` when none has been). */
  readonly lastEscalation: string | null;
}

export interface RevisionWatch {
  /** The document as of the last revision that was not values-only. Stable until `subscribeStructure` notifies. */
  structure(): GraphDocument;
  subscribeStructure(listener: () => void): () => void;
  subscribeValues(listener: (revision: ValuesRevision) => void): () => void;
  /** The compile's lane. One per store, the last one set is asked; the return takes this one away. */
  setLane(lane: ValuesLane): () => void;
  stats(): RevisionStats;
  subscribeStats(listener: () => void): () => void;
}

const watches = new WeakMap<GraphStoreView, RevisionWatch>();

/** The watch of one store. The same object for every caller, so a revision is classified once. */
export function revisionWatchFor(store: GraphStoreView, registry: NodeRegistryView): RevisionWatch {
  const known = watches.get(store);
  if (known !== undefined) return known;

  const structureListeners = new Set<() => void>();
  const valuesListeners = new Set<(revision: ValuesRevision) => void>();
  const statsListeners = new Set<() => void>();
  let lane: ValuesLane | null = null;
  let stop: (() => void) | null = null;
  /** The last document read off the store, and the structure as of the last non-values revision. */
  let seen: GraphDocument = store.getGraph();
  let settings: ProjectSettings = store.getSettings();
  let held: GraphDocument = seen;
  let stats: RevisionStats = { values: 0, escalated: 0, lastEscalation: null };

  const note = (next: RevisionStats): void => {
    stats = next;
    for (const listener of [...statsListeners]) listener();
  };
  const structural = (): void => {
    held = seen;
    for (const listener of [...structureListeners]) listener();
  };

  const read = (): void => {
    const next = store.getGraph();
    const nextSettings = store.getSettings();
    if (next === seen && nextSettings === settings) return;
    const previous = seen;
    const sameSettings = nextSettings === settings;
    seen = next;
    settings = nextSettings;
    const kind = sameSettings ? classifyRevision(previous, next, registry) : null;
    if (kind === null || kind.kind !== "values") {
      structural();
      return;
    }
    const revision: ValuesRevision = { previous, graph: next, written: kind.written };
    const refusal = lane === null ? null : lane(revision);
    if (refusal !== null) {
      note({ ...stats, escalated: stats.escalated + 1, lastEscalation: refusal });
      structural();
      return;
    }
    note({ ...stats, values: stats.values + 1 });
    for (const listener of [...valuesListeners]) listener(revision);
  };

  const listening = (): boolean => structureListeners.size + valuesListeners.size > 0 || lane !== null;
  const attach = (): void => {
    if (stop !== null) return;
    // Nothing was listening: whatever happened meanwhile is not a revision anyone can be told about.
    seen = store.getGraph();
    settings = store.getSettings();
    held = seen;
    stop = store.subscribe(read);
  };
  const detach = (): void => {
    if (listening() || stop === null) return;
    stop();
    stop = null;
  };

  const watch: RevisionWatch = {
    structure() {
      if (stop === null) {
        seen = store.getGraph();
        settings = store.getSettings();
        held = seen;
      }
      return held;
    },
    subscribeStructure(listener) {
      attach();
      structureListeners.add(listener);
      return () => {
        structureListeners.delete(listener);
        detach();
      };
    },
    subscribeValues(listener) {
      attach();
      valuesListeners.add(listener);
      return () => {
        valuesListeners.delete(listener);
        detach();
      };
    },
    setLane(next) {
      lane = next;
      attach();
      return () => {
        // Only the one who set it takes it away: a later mount's lane is not this one's to clear.
        if (lane !== next) return;
        lane = null;
        detach();
      };
    },
    stats: () => stats,
    subscribeStats(listener) {
      statsListeners.add(listener);
      return () => statsListeners.delete(listener);
    },
  };
  watches.set(store, watch);
  return watch;
}
