import type { GraphComponentDefinition } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ParameterSchema, StoredParameter } from "../types/parameters.ts";
import { resolveStoredSchema, type ResolvedParameters } from "../parameters/resolve.ts";
import { effectiveInternalOverrides } from "./flatten.ts";
import { internalChannelMasks, projectInternalChannelMasks } from "./internal-channel-masks.ts";
import { internalResolutions, projectInternalResolutions } from "./internal-resolutions.ts";
import { publishedPage, publishedSchema, type PublishedPage } from "./published-page.ts";

/**
 * T1553b — WHAT ONE INSTANCE DOES TO ITS DEFINITION, decided once for both of its readers.
 *
 * Flattening (`compiler/flatten.ts`, every compile) and `component.detach` (once, into real
 * nodes) both turn an instance plus its definition into the internal network the instance
 * stands for. They used to assemble that network each from its own parts — flattening
 * re-implemented the resolution overrides `projectInternalResolutions` already applied for
 * detach — and B238, B239, B240 and T1545b were each one part detach dropped that
 * flattening applied. This is the one projection both call:
 *
 *  - `page` — the instance's published page (`publishedPage`, §V80, T1017);
 *  - `overrides` — what lands on each internal parameter, keyed `<nodeId>/<key>`: the page's
 *    fan-out, then the instance's own `componentOverrides` (`effectiveInternalOverrides`);
 *  - `graph` — the definition graph with the instance's internal channel masks and
 *    resolution overrides written onto its nodes; a nested path merges into the nested
 *    instance's own overrides, outer winning, so the nested level applies it in turn;
 *  - `missing` — the mask and resolution paths that name nothing, for the caller to say.
 *
 * The VALUES are not written into `graph`, and that is not an omission: both callers rename
 * colliding labels first (B41) and only then write the values, because a page value may be
 * an expression naming a node at the INSTANCE's level, which the rename must not move.
 *
 * `readPage` reads the page in stored space (§V56, T307) — `STORED_READ`, the document
 * itself (§V529). Flattening passes its own reader only to collect the compiler's
 * diagnostics from the same resolution (`publishedPage.deferred` is identity-keyed).
 *
 * Everything an instance does BESIDE its definition — its own Processing Channels (a
 * boundary pass in flattening, `carryInstanceChannelMask` in detach), `parent.<key>` reads
 * (resolved against the scope where each caller lands) — stays with the caller.
 * `component-instance-projection.test.ts` holds the two callers to one answer.
 */
export interface AppliedInstance {
  readonly page: PublishedPage;
  readonly overrides: Readonly<Record<string, StoredParameter>>;
  readonly graph: GraphDocument;
  readonly missing: { readonly channelMasks: readonly string[]; readonly resolutions: readonly string[] };
}

export function applyInstance(input: {
  readonly definition: GraphComponentDefinition;
  /** The instance as its own level resolved it (flattening has already applied an outer fan-out). */
  readonly instance: GraphNode;
  readonly readPage?: (instance: GraphNode, schema: ParameterSchema) => ResolvedParameters;
}): AppliedInstance {
  const { definition, instance } = input;
  const read = input.readPage ?? ((node: GraphNode, schema: ParameterSchema) => resolveStoredSchema(node, schema));
  const page = publishedPage(read(instance, publishedSchema(definition)), definition);
  const masked = projectInternalChannelMasks(definition.graph, internalChannelMasks(instance));
  const sized = projectInternalResolutions(masked.graph, internalResolutions(instance));
  return {
    page,
    overrides: effectiveInternalOverrides(definition, instance, page.stored),
    graph: sized.graph,
    missing: { channelMasks: masked.missing, resolutions: sized.missing },
  };
}
