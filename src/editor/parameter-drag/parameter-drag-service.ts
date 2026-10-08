import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { ParameterDragPayload, ParameterDragService } from "@ui/controls/parameter-drag-context.ts";

/**
 * VN63 — what a parameter-name drag carries and what a drop on another parameter writes,
 * for `ParameterDragContext` (the controls in `src/ui` cannot reach the graph or the bus).
 *
 * The drop is the EXISTING paste path, `parameter.paste { as: "reference" }`, handed the
 * reference as `text` (the door a reference typed or pasted from outside comes through),
 * so one command and one undo step write `op('<source>').par.<key>` with every check that
 * path already makes (types, arity, a node reading itself). It deliberately does not run
 * `parameter.copyReference` first: that would overwrite the user's parameter clipboard as
 * a side effect of a drag.
 */
export function createParameterDragService(options: {
  readonly bus: LoomBus;
  readonly invocation: InvocationContext;
  /** A paste the bus refused, by its diagnostics (the problems panel). */
  readonly onRefused?: (diagnostics: readonly RuntimeDiagnostic[]) => void;
}): ParameterDragService {
  const referenceText = (source: ParameterDragPayload): string | null => {
    // Read when a drag starts or lands, never per frame: the document as it stands now.
    const label = options.bus.store.getGraph().nodes[source.nodeId]?.label;
    return label === undefined ? null : `op('${label}').par.${source.key}`;
  };
  return {
    referenceText,
    dropOnParameter: (target, source) => {
      const text = referenceText(source);
      if (text === null) return;
      void options.bus
        .execute("parameter.paste", { nodeId: target.nodeId, parameterKey: target.key, text, as: "reference" }, options.invocation)
        .then((result) => {
          if (result.output.status !== "applied") options.onRefused?.(result.diagnostics);
        });
    },
  };
}
