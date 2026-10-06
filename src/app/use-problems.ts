import { useCallback, useRef } from "react";
import { humanizeDiagnostics } from "@domain/graph/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { clearProblemSources, readProblemSources, type ProblemSource } from "./problem-sources.ts";

export interface Problems {
  /** Every source's diagnostics in registration order, quoted node ids shown as labels (T599). */
  readonly problems: RuntimeDiagnostic[];
  /** The Problems pane's Clear (T465): empties the sources that carry `clear`. */
  readonly clearProblems: () => void;
}

interface Cached {
  readonly graph: GraphDocument;
  readonly reads: readonly (readonly RuntimeDiagnostic[])[];
  readonly problems: RuntimeDiagnostic[];
}

/**
 * T1555b: the app's Problems list, read from its registry of sources (`problem-sources.ts`).
 *
 * The list keeps its identity while no source changes. The agent surface and the pane both
 * take it as a value, and the old `useMemo` gave that guarantee through a dependency array
 * that was a third hand-kept list of the same sources. Here each source's own array is the
 * dependency, compared by identity, so the registration is the only list.
 */
export function useProblems(sources: readonly ProblemSource[], graph: GraphDocument): Problems {
  const reads = sources.map((source) => source.read());
  const cache = useRef<Cached | null>(null);
  const previous = cache.current;
  let problems: RuntimeDiagnostic[];
  if (
    previous !== null &&
    previous.graph === graph &&
    previous.reads.length === reads.length &&
    previous.reads.every((read, index) => read === reads[index])
  ) {
    problems = previous.problems;
  } else {
    // T599: the message boundary. A quoted node id becomes the node's display label, so the
    // pane says `blur1` like every other surface does, not the minted id.
    problems = [...humanizeDiagnostics(readProblemSources(sources), graph)];
    cache.current = { graph, reads, problems };
  }

  // Clear reads the sources of the latest render, never the ones captured by a stale closure.
  const latest = useRef(sources);
  latest.current = sources;
  const clearProblems = useCallback(() => clearProblemSources(latest.current), []);
  return { problems, clearProblems };
}
